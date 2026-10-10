// Facilitator console for facilitated sats orders — PLAN-0007 T4.
//
// Order payload contract this console reads (produced by the paid leg, T2):
//   payload.basket    = { venue_slug, venue_name, items:[{name,qty,options,unit_fiat,unit_sats}],
//                         total_fiat, total_sats, fee_sats }
//   payload.customer  = { phone?, npub? }
//   payload.venue     = { rail?, checkout_url? }
//   payload.settlement= { status:"settled"|"pending"|"failed", method:"bolt11"|"cashu",
//                         payment_hash?, amount_sats?, settled_at? }
//   receipt (written by this console on `placed`) = { venue_reference, ready_at, paid_with,
//                         payment_reference, captured_at }
//
// INVARIANTS enforced here (not by convention):
//   * ADR-0008/0013 — sats final BEFORE any fiat spend. Every path that can spend fiat
//     (placing / placed) calls requireSettled() first and refuses otherwise.
//   * ADR-0013 — card data stays on the facilitator's device. This console renders no
//     card field, hands off to the venue/PSP payment page, and stores only a reference
//     plus the outcome. assertNoCardData() is called before every POST, before anything
//     is written to device storage, and before anything is put on the Nostr bus.
//   * ADR-0012 — a terminal fiat failure escalates to the operator over Nostr DM, or it
//     is shown as NOT SENT with the exact text (never silently dropped).

const API = "/api"; // same origin as the customer PWA; the host proxies this to cvm-orders
const RELAY = "wss://relay2.orangesync.tech";
const SLA_MS = 5 * 60 * 1000; // place within 5 min of the sats settling
const RECEIPT_KEY = "cvm-console-receipts-v1"; // device-only record, never card material
const LEGAL = { paid: ["placing", "refunded"], placing: ["placed", "refunded"], placed: ["ready"], ready: [], refunded: [] };
const CARD_KEY = /^(pan|card[_ -]?number|card[_ -]?no|cvv|cvc|cvn|csc|security[_ -]?code|expiry|exp[_ -]?date|expiration|cardholder|card[_ -]?holder|ccnum|creditcard)$/i;
const DEAD_STATUSES = new Set(["refunded"]);

const app = document.querySelector("#app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sats = (n) => `${Math.round(Number(n) || 0).toLocaleString("en-US").replaceAll(",", " ")} sats`;
const fiat = (n) => `${(Number(n) || 0).toFixed(2)} €`;
const nowSec = () => Math.floor(Date.now() / 1000);

export class CardDataRefused extends Error {
  constructor(where) {
    super(`refusing card data at ${where}: this console never handles PAN/CVV (ADR-0013)`);
    this.name = "CardDataRefused";
  }
}

/** Luhn-valid 13..19 digit strings are treated as a PAN, anywhere. */
export function looksLikePan(value) {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

function walk(value, where, path) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (looksLikePan(value)) throw new CardDataRefused(`${where}:${path} (PAN-shaped value)`);
    if (/^\d{3,4}$/.test(value) && /cvv|cvc|cvn|csc|code/i.test(path)) throw new CardDataRefused(`${where}:${path} (CVV-shaped value)`);
    return;
  }
  if (typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (CARD_KEY.test(k)) throw new CardDataRefused(`${where}:${path}${path ? "." : ""}${k}`);
    walk(v, where, `${path}${path ? "." : ""}${k}`);
  }
}

/** ADR-0013 guard: no card material reaches the server, the log, the DM or device storage. */
export function assertNoCardData(value, where = "payload") {
  walk(value, where, "");
  return value;
}

/** ADR-0008/0013 gate. Fail-closed: an unproven sats payment is not a paid order. */
export function requireSettled(order) {
  const s = order?.payload?.settlement;
  if (!s) return { ok: false, reason: "the order carries no settlement record (sats not proven)" };
  if (s.status !== "settled") return { ok: false, reason: `sats payment is "${s.status}", not settled` };
  if (!s.payment_hash && !s.payment_id) return { ok: false, reason: "settled sats payment has no payment id/hash to verify against" };
  if (!(Number(s.amount_sats) > 0)) return { ok: false, reason: "settled sats payment has no amount" };
  return { ok: true, proof: { method: s.method ?? "bolt11", payment_hash: s.payment_hash ?? s.payment_id, amount_sats: Number(s.amount_sats), settled_at: s.settled_at ?? null } };
}

/** The card-custody hand-off. There is no card field in this document, by design. */
export function custodyPlan(order) {
  const url = order?.payload?.venue?.checkout_url;
  const rail = order?.payload?.venue?.rail ?? "unknown";
  if (url) return { mode: "venue-checkout", rail, url, note: "the venue's own checkout — card data is entered there, on this device, never sent to us" };
  return { mode: "psp-hosted-fields", rail, url: null, note: "no venue checkout URL declared: pay at the venue's terminal, or hand off to the PSP's hosted card fields once the 2fiat card CVM (ADR-0013) is wired. Card data never enters this console." };
}

const state = { screen: "signin", challenge: null, auth: null, queue: [], selected: null, order: null, error: null, notice: null, dm: null, receipts: loadReceipts() };

function loadReceipts() {
  try { return JSON.parse(localStorage.getItem(RECEIPT_KEY) ?? "{}"); } catch { return {}; }
}
function saveReceipt(orderId, receipt) {
  assertNoCardData(receipt, "device-receipt");
  state.receipts[orderId] = receipt;
  try { localStorage.setItem(RECEIPT_KEY, JSON.stringify(state.receipts)); } catch { /* device storage is best-effort */ }
}
const receiptOf = (o) => state.receipts[o.id] ?? o.payload?.receipt ?? null;

function b64(json) { return btoa(unescape(encodeURIComponent(json))); }
async function sha256hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** NIP-98: sign the challenge this server issued, then carry the event on every call. */
export async function signIn() {
  state.error = null;
  const res = await fetch(`${API}/auth/challenge`);
  if (!res.ok) throw new Error(`auth challenge unavailable (HTTP ${res.status})`);
  const challenge = await res.json();
  const signer = globalThis.nostr;
  if (!signer?.signEvent) throw new Error("no Nostr signer on this device: install a NIP-07 extension (or use the NIP-46 nosigner) to sign the challenge");
  const payload = await sha256hex(String(challenge.nonce));
  const event = await signer.signEvent({
    kind: 27235,
    created_at: nowSec(),
    tags: [["u", `${location.origin}${API}/auth/challenge`], ["method", "GET"], ["payload", payload]],
    content: "",
  });
  if (!event?.pubkey || !challenge.facilitatorNpub) throw new Error("signer returned no pubkey");
  if (event.pubkey !== challenge.facilitatorNpub) throw new Error(`this key (${event.pubkey.slice(0, 12)}…) is not the facilitator key the order service accepts`);
  if (nowSec() - Number(event.created_at) > Number(challenge.expiresIn ?? 300)) throw new Error("challenge expired before it was signed");
  state.challenge = challenge;
  // Signature verification is the *server's* job and is still a gap in cvm-orders
  // (GET /auth/challenge delegates it to the console boundary). This client checks key
  // identity and freshness only; it never treats sign-in as a security boundary.
  state.auth = { pubkey: event.pubkey, npub: challenge.facilitatorNpub, event };
  state.notice = "signed in; signed challenge attached to every call (server-side NIP-98 verification is still a cvm-orders gap)";
  await refresh();
  state.screen = "queue";
  render();
}

function authHeaders() {
  if (!state.auth) throw new Error("not signed in");
  return { authorization: `Nostr ${b64(JSON.stringify(state.auth.event))}`, "content-type": "application/json" };
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} failed (HTTP ${res.status})${body?.error ? `: ${body.error}` : ""}`);
  return body;
}

const transition = (id, to, extra = {}) => api(`/orders/${encodeURIComponent(id)}/transition`, { method: "POST", body: JSON.stringify(assertNoCardData({ state: to, ...extra }, `transition:${to}`)) });

// Orders this console has acted on. The service's queue is paid-only, so an order we
// just moved to `placing`/`placed` leaves it: we re-read those by id instead of losing
// sight of them (that is how "mark ready" stays reachable).
const touched = new Set();
const allOrders = () => [...state.queue, ...(state.tracked ?? [])];
const orderById = (id) => allOrders().find((o) => o.id === id) ?? null;

async function refresh() {
  const body = await api("/orders/queue");
  state.queue = Array.isArray(body?.orders) ? body.orders : [];
  const tracked = [];
  for (const id of touched) {
    const known = state.queue.find((o) => o.id === id) ?? (state.tracked ?? []).find((o) => o.id === id);
    try { tracked.push(await api(`/orders/${encodeURIComponent(id)}`)); } catch { if (known) tracked.push(known); }
  }
  state.tracked = tracked;
  const all = allOrders();
  if (!state.selected || !all.some((o) => o.id === state.selected)) state.selected = all[0]?.id ?? null;
  state.order = orderById(state.selected) ?? state.order;
}

function basketOf(order) {
  const b = order?.payload?.basket;
  if (b) return b;
  const items = Array.isArray(order?.payload?.items) ? order.payload.items : [];
  return { venue_slug: order?.payload?.venue_slug ?? "unknown", venue_name: order?.payload?.venue_slug ?? "unknown venue", items, total_fiat: 0, total_sats: 0, fee_sats: 0 };
}

function sla(order) {
  const at = order?.payload?.settlement?.settled_at ?? order?.updatedAt;
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return { text: "SLA unknown", cls: "sla-warn" };
  const left = SLA_MS - (Date.now() - t);
  if (left <= 0) return { text: `over SLA by ${Math.floor(-left / 1000)}s`, cls: "sla-bad" };
  return { text: `place now · ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`, cls: left < 60000 ? "sla-bad" : "sla-warn" };
}

const shell = (klass, nav, body) => `<div class="shell ${klass}">${nav}${body}</div>`;
const navFor = (active) => `<nav><div class="brand">Facilitator console<small>facilitated sats orders · CVM</small></div>
  <button class="navitem ${active === "queue" ? "on" : ""}" data-goto="queue">Queue <span class="bdg">${state.queue.length}</span></button>
  <button class="navitem ${active === "settlements" ? "on" : ""}" data-goto="settlements">Settlements</button>
  <div class="navfoot">Sats settled before fiat, always (ADR-0008/0013)<br>Card data stays on this device<br>Signed in as <b>${state.auth ? `${esc(state.auth.pubkey.slice(0, 12))}…` : "—"}</b></div></nav>`;

const lineItems = (b) => (b.items ?? []).map((i) => `${i.qty ?? 1} × ${esc(i.name ?? i.sku)}${i.options ? ` — ${esc(i.options)}` : ""}`).join("<br>");

function signinView() {
  return `<div class="signin"><h1>Facilitator console</h1>
    <p>Sign in with the facilitator npub. The order service issues a challenge (GET /api/auth/challenge);
    your signer signs it as a NIP-98 event, and the signed challenge is attached to every call as
    <code>authorization: Nostr …</code>. No password, no session cookie.</p>
    <button class="btn gold" data-signin ${state.auth ? "disabled" : ""}>Sign in with Nostr</button></div>`;
}

function queueView() {
  const rows = allOrders().map((o) => {
    const b = basketOf(o), s = sla(o);
    return `<button class="qrow ${o.id === state.selected ? "sel" : ""}" data-order="${esc(o.id)}">
      <div class="r1"><span class="oid">#${esc(o.id.slice(0, 8))} · ${esc(b.venue_name)}</span><span class="tag warn" style="margin-left:auto">${esc(s.text)}</span></div>
      <div class="r2"><span>${(b.items ?? []).map((i) => `${i.qty ?? 1}× ${esc(i.name ?? i.sku)}`).join(" · ") || "no basket"}</span>
      <span class="sat">${sats(b.total_sats)}</span><span class="fiat">${fiat(b.total_fiat)}</span>
      <span>fee ${sats(b.fee_sats)}</span><span>${esc(o.payload?.customer?.phone ?? "no phone")}</span></div></button>`;
  }).join("");
  const o = orderById(state.selected);
  const gate = o ? requireSettled(o) : { ok: false, reason: "no order selected" };
  const receipt = o ? receiptOf(o) : null;
  const detail = !o ? `<aside class="pane"><div class="grow empty">No paid order in the queue.</div></aside>` : `<aside class="pane">
    <div class="phead"><h1 style="font-size:16px">#${esc(o.id.slice(0, 8))} — ${esc(basketOf(o).venue_name)}</h1>
      <div class="sub">state ${esc(o.state)} · customer ${esc(o.payload?.customer?.phone ?? "—")}</div></div>
    <div class="grow">
      <div class="dsec"><h3>Order</h3><div class="lines2">${lineItems(basketOf(o))}</div></div>
      <div class="dsec"><h3>Money</h3>
        <div class="kv"><span>Venue total (fiat)</span><b>${fiat(basketOf(o).total_fiat)}</b></div>
        <div class="kv"><span>Customer paid</span><b class="sat">${sats(basketOf(o).total_sats)}</b></div>
        <div class="kv"><span>Fee kept</span><b style="color:var(--ok)">${sats(basketOf(o).fee_sats)}</b></div>
        <div class="kv"><span>Sats proof</span><b>${gate.ok ? esc(String(gate.proof.payment_hash).slice(0, 16)) + "…" : '<span class="tag bad">not proven</span>'}</b></div></div>
      <div class="dsec"><h3>Sats gate (ADR-0008/0013)</h3>
        <div class="kv"><span>Fiat spend allowed</span><b>${gate.ok ? '<span class="tag ok">yes — sats settled</span>' : `<span class="tag bad">blocked</span>`}</b></div>
        ${gate.ok ? "" : `<div class="cknote dark">${esc(gate.reason)}. The card step is unreachable until this is settled — that is the point.</div>`}</div>
      <div class="dsec"><h3>Venue hand-off</h3>
        <div class="kv"><span>Checkout</span><b class="tag blue">${esc(custodyPlan(o).mode)}</b></div>
        <div class="kv"><span>Rail</span><b>${esc(custodyPlan(o).rail)}</b></div>
        <div class="cknote dark">${esc(custodyPlan(o).note)}</div></div>
      ${receipt ? `<div class="dsec"><h3>Receipt (this device)</h3><div class="lines2">#${esc(receipt.venue_reference ?? "—")} · ready ${esc(receipt.ready_at ?? "—")}<br><span class="o">paid with ${esc(receipt.paid_with ?? "—")} · ref ${esc(receipt.payment_reference ?? "—")} · ${esc(receipt.captured_at ?? "")}</span></div></div>` : ""}
    </div>
    <div class="actions">
      <button class="btn gold" data-place="${esc(o.id)}" ${gate.ok ? "" : "disabled"}>Place order at venue →</button>
      <button class="btn line blue" data-handoff="${esc(o.id)}">Open venue checkout ↗</button>
      ${o.state === "placed" ? `<button class="btn line" data-ready="${esc(o.id)}">Mark ready — venue handed it over</button>` : ""}
      <button class="btn ghost" data-refund="${esc(o.id)}">Can't place? Refund the customer in full</button>
    </div></aside>`;
  return shell("s1", navFor("queue"), `<section class="pane"><div class="phead"><h1>Queue</h1>
    <div class="sub">Paid baskets waiting to be placed · SLA: place within 5 min of the sats settling</div></div>
    <div class="grow">${rows || '<div class="empty">Nothing paid and unplaced right now.</div>'}${banner()}</div></section>${detail}`);
}

function placingView() {
  const o = state.order;
  if (!o) return shell("s1", navFor("queue"), `<section class="pane"><div class="grow empty">No order open.</div></section><aside class="pane"></aside>`);
  const b = basketOf(o), plan = custodyPlan(o);
  return shell("s2", navFor("queue"), `<section class="pane">
    <div class="phead"><h1>Placing #${esc(o.id.slice(0, 8))}</h1><div class="sub">Finish the venue's checkout on your device, then record what the venue told you</div></div>
    <div class="grow">
      <div class="dsec"><h3>Basket to enter at the venue</h3><div class="ckbox" style="background:var(--card);border-color:var(--line);color:var(--ink)">${lineItems(b)}
        <div class="cksum" style="border-color:var(--line)"><span>Venue total</span><b>${fiat(b.total_fiat)}</b></div></div></div>
      <div class="dsec"><h3>After the checkout, record</h3>
        <div class="kv"><span>Venue order number</span><input class="ck dark" data-receipt="venue_reference" placeholder="#4471"></div>
        <div class="kv"><span>Ready time told</span><input class="ck dark" data-receipt="ready_at" placeholder="18:25"></div>
        <div class="kv"><span>Paid with</span><input class="ck dark" data-receipt="paid_with" placeholder="card at venue terminal / 2fiat card"></div>
        <div class="kv"><span>Payment reference</span><input class="ck dark" data-receipt="payment_reference" placeholder="pi_… or txn id — never a card number"></div>
        <div class="cknote dark">Only a reference and the outcome are recorded. A card number or CVV typed here is refused by
        the custody guard, not stored (ADR-0013).</div></div>
      <button class="btn gold" data-placed="${esc(o.id)}">Record confirmation → mark placed</button>
      <p class="pulse" style="margin-top:10px"><i></i> venue checkout is a separate tab: card data stays on this device</p>
      ${banner()}
    </div></section>
    <section class="checkout"><div class="phead"><h1 style="font-size:15px">${esc(plan.rail)} — ${esc(b.venue_name)}</h1>
      <div class="sub">the venue's own payment page · hand-off, not a card form we control</div></div>
      <div class="grow">
        <div class="ckbox">${lineItems(b)}<div class="cksum"><span>Total</span><b>${fiat(b.total_fiat)}</b></div></div>
        <p class="cknote"><b>Card custody (ADR-0013).</b> ${esc(plan.note)}</p>
        <p class="cknote">This pane deliberately contains no card field. If a PSP with hosted card fields is wired later,
        those fields are an iframe owned by that PSP; this console still only ever receives the payment result.</p>
        ${plan.url ? `<button class="btn gold" style="width:100%" data-handoff="${esc(o.id)}">Open the venue checkout ↗</button>` : `<button class="btn line" style="width:100%" disabled>No venue checkout URL declared</button>`}
        <p class="cknote">Sats are already settled for this order, so the fiat spend is covered (${sats(b.total_sats)} in, ${fiat(b.total_fiat)} out, fee ${sats(b.fee_sats)}).</p>
      </div></section>`);
}

function settlementsView() {
  const rows = Object.entries(state.receipts).map(([id, r]) => {
    const o = state.queue.find((x) => x.id === id);
    const b = o ? basketOf(o) : { total_fiat: 0, total_sats: 0, fee_sats: 0, venue_name: "—" };
    return `<div class="scard"><div class="r1"><span class="oid">#${esc(id.slice(0, 8))} · ${esc(b.venue_name)}</span>
      <span class="tag ok" style="margin-left:auto">${esc(r.persisted ?? "captured on device")}</span></div>
      <div class="r2"><span>fee ${sats(b.fee_sats)} kept</span><span>${fiat(b.total_fiat)} fiat spent</span>
      <span>${esc(r.captured_at ?? "")} · #${esc(r.venue_reference ?? "—")}</span></div></div>`;
  }).join("");
  const refunds = state.queue.filter((o) => o.state !== "refunded" && !receiptOf(o)).length;
  const fees = state.queue.reduce((n, o) => n + Number(basketOf(o).fee_sats || 0), 0);
  const spent = Object.keys(state.receipts).reduce((n, id) => n + Number(basketOf(state.queue.find((x) => x.id === id) ?? {}).total_fiat || 0), 0);
  return shell("s1", navFor("settlements"), `<section class="pane"><div class="phead"><h1>Settlements</h1>
    <div class="sub">Fees kept, fiat spent, refunds owed — recorded on this device</div></div><div class="grow">
    <div class="sumgrid"><div class="sumbox"><div class="v">${sats(fees)}</div><div class="l">fees in open queue</div></div>
      <div class="sumbox"><div class="v">${fiat(spent)}</div><div class="l">fiat recorded as spent</div></div>
      <div class="sumbox"><div class="v">${refunds}</div><div class="l">orders still unplaced</div></div></div>
    ${rows || '<div class="empty">No placement recorded on this device yet.</div>'}
    <div class="cknote dark">Receipts live in this device's storage and are posted to the order service with the
    <code>placed</code> transition. cvm-orders does not persist the receipt field yet, so the durable copy is
    device-side until that lands.</div>${banner()}</div></section><aside class="pane"></aside>`);
}

function banner() {
  const parts = [];
  if (state.error) parts.push(`<p class="error">${esc(state.error)}</p>`);
  if (state.notice) parts.push(`<p class="notice">${esc(state.notice)}</p>`);
  if (state.dm) parts.push(`<div class="dsec"><h3>Operator escalation (ADR-0012) — ${state.dm.sent ? "sent over Nostr DM" : `NOT SENT: ${esc(state.dm.reason)}`}</h3>
    <pre class="dm" data-dm>${esc(state.dm.text)}</pre></div>`);
  return parts.join("");
}

function render() {
  app.innerHTML = state.screen === "signin" ? signinView()
    : state.screen === "placing" ? placingView()
      : state.screen === "settlements" ? settlementsView()
        : queueView();
}

async function guard(fn) {
  try { await fn(); } catch (e) { state.error = e instanceof Error ? e.message : String(e); if (e?.name === "CardDataRefused") state.notice = "that value looks like card data — refused and discarded"; }
  render();
}

async function openHandoff(order) {
  const plan = custodyPlan(order);
  if (!plan.url) { state.notice = `${plan.note}`; return; }
  const w = globalThis.open(plan.url, "_blank", "noopener,noreferrer");
  state.notice = w ? `venue checkout opened in a separate tab (${plan.rail})` : `popup blocked — open ${plan.url} yourself`;
}

async function place(orderId) {
  const order = state.queue.find((o) => o.id === orderId) ?? state.order;
  const gate = requireSettled(order); // ADR-0008/0013: no sats, no fiat — checked before anything opens
  if (!gate.ok) throw new Error(`fiat spend blocked: ${gate.reason}`);
  state.order = order;
  touched.add(orderId);
  await transition(orderId, "placing");
  state.notice = `sats proven (${String(gate.proof.payment_hash).slice(0, 16)}…) · ${gate.proof.amount_sats} sats settled; placing allowed`;
  await openHandoff(order);
  state.screen = "placing";
}

async function recordPlaced(orderId) {
  const order = state.queue.find((o) => o.id === orderId) ?? state.order;
  const gate = requireSettled(order);
  if (!gate.ok) throw new Error(`fiat spend blocked: ${gate.reason}`);
  const read = (field) => app.querySelector(`[data-receipt="${field}"]`)?.value?.trim() ?? "";
  const receipt = assertNoCardData({
    venue_reference: read("venue_reference"),
    ready_at: read("ready_at"),
    paid_with: read("paid_with"),
    payment_reference: read("payment_reference"),
    captured_at: new Date().toISOString(),
  }, "receipt");
  if (!receipt.venue_reference) throw new Error("record the venue's order number before marking the order placed — the receipt is the evidence that fiat was spent");
  touched.add(orderId);
  const res = await transition(orderId, "placed", { receipt });
  saveReceipt(orderId, { ...receipt, persisted: res?.receipt ? "persisted server-side" : "captured on device" });
  state.notice = res?.receipt ? "venue receipt recorded and persisted" : "venue receipt captured on this device; the order service dropped the receipt field (persistence gap)";
  state.order = null;
  await refresh();
  state.screen = "queue";
}

const escalationText = (order, reason) => {
  const gate = requireSettled(order);
  const b = basketOf(order);
  return [
    "CVM facilitated order — terminal fiat failure (ADR-0012, operator is the recipient)",
    JSON.stringify({
      order_id: order.id,
      order_state: order.state,
      rail: custodyPlan(order).rail,
      sats: gate.ok ? gate.proof : { status: order?.payload?.settlement?.status ?? "unknown" },
      basket_total_sats: b.total_sats,
      basket_total_fiat: b.total_fiat,
      fee_sats: b.fee_sats,
      fiat_cap_eur: 30,
      what_failed: reason,
      at: new Date().toISOString(),
    }, null, 1),
  ].join("\n");
};

async function publish(event) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("relay timeout")); }, 8000);
    ws.onopen = () => ws.send(JSON.stringify(["EVENT", event]));
    ws.onmessage = (m) => {
      let msg = null; try { msg = JSON.parse(m.data); } catch {}
      if (Array.isArray(msg) && msg[0] === "OK" && msg[1] === event.id) {
        clearTimeout(timer); ws.close();
        msg[2] === true ? resolve(event.id) : reject(new Error(`relay rejected the DM: ${msg[3] ?? "no reason"}`));
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`relay ${RELAY} unreachable`)); };
  });
}

/** ADR-0012: escalate to the operator over a Nostr DM — or report NOT SENT with the exact text. */
export async function escalate(order, reason) {
  const text = assertNoCardData(escalationText(order, reason), "escalation-dm");
  const signer = globalThis.nostr;
  if (!signer?.signEvent) { state.dm = { sent: false, reason: "no NIP-07 signer on this device", text }; return state.dm; }
  if (!signer.nip04?.encrypt) { state.dm = { sent: false, reason: "this signer exposes no NIP-04 encrypt", text }; return state.dm; }
  try {
    const recipient = state.auth?.pubkey ?? order?.payload?.customer?.npub;
    if (!recipient) throw new Error("no operator pubkey to DM");
    const ciphertext = await signer.nip04.encrypt(recipient, text);
    const event = await signer.signEvent({ kind: 4, created_at: nowSec(), tags: [["p", recipient]], content: ciphertext });
    await publish(event);
    state.dm = { sent: true, text, event_id: event.id };
  } catch (e) {
    state.dm = { sent: false, reason: e instanceof Error ? e.message : String(e), text };
  }
  return state.dm;
}

/** The last leg of the machine: the venue handed the order over. */
async function markReady(orderId) {
  await transition(orderId, "ready");
  state.notice = "marked ready — the customer's status view shows the order as ready";
  await refresh();
}

async function refund(orderId) {
  const order = orderById(orderId) ?? state.order;
  touched.add(orderId);
  await transition(orderId, "refunded");
  state.notice = "refund recorded (melt to origin is the paid leg's job)";
  await escalate(order, "facilitator could not place the order — sats refunded in full");
  await refresh();
  state.screen = "queue";
}

app.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-signin],[data-goto],[data-order],[data-place],[data-placed],[data-handoff],[data-refund],[data-ready]");
  if (!el) return;
  if (el.dataset.signin !== undefined) return void guard(signIn);
  if (el.dataset.goto) { state.screen = el.dataset.goto; state.error = null; return render(); }
  if (el.dataset.order) { state.selected = el.dataset.order; state.order = state.queue.find((o) => o.id === el.dataset.order) ?? null; state.error = null; return render(); }
  if (el.dataset.place) return void guard(() => place(el.dataset.place));
  if (el.dataset.placed) return void guard(() => recordPlaced(el.dataset.placed));
  if (el.dataset.handoff) { const o = state.queue.find((x) => x.id === el.dataset.handoff) ?? state.order; return void guard(() => openHandoff(o)); }
  if (el.dataset.refund) return void guard(() => refund(el.dataset.refund));
  if (el.dataset.ready) return void guard(() => markReady(el.dataset.ready));
});

if (globalThis.document && globalThis.document.querySelector && !globalThis.__CONSOLE_NO_AUTOSTART__) render();
export { state, render, signIn as authenticate, requireSettled as satsGate };
export const SCREENS = ["signin", "queue", "placing", "settlements"];
export const TRANSITIONS = ["paid", "placing", "placed", "ready", "refunded"];
export { LEGAL as ORDER_MACHINE, RELAY, RECEIPT_KEY, SLA_MS };
export { transition as postTransition, refresh as loadQueue };
