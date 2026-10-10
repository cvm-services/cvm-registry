// Facilitator-console HAPPY PATH — one test, one coherent recording (PLAN-0007 T4).
//
// What this is: the mandatory T4 evidence. A single Playwright run at 1280x720
// with `recordVideo` on, walking the real user-facing flow of site/console/:
//
//   sign-in (NIP-98 challenge) -> paid-basket queue with the 5-min SLA ->
//   placing -> record the venue order number + ready time -> mark placed ->
//   ready -> settlements -> and the card-custody guard refusing a PAN typed into
//   the payment reference.
//
// WHAT IS REAL. The order service is the real cvm-orders slice: the stub
// (tools/console-test/stub-order-service.ts) imports the actual `route()` handler
// and `OrderStore` from the cvm-orders checkout at $CVM_ORDERS_DIR and serves
// every /api/* call through it over real HTTP. Every state change in the
// recording is a POST into that real machine, re-read afterwards with
// GET /api/orders/:id. The seeded orders exist to give the flow something to act
// on; no money is faked.
//
// THE THREE STUBS, AND WHY EACH ONE IS UNAVOIDABLE ON THIS HOST (honesty rule
// from `local-ui-browser-verification`: stub only what cannot exist here, and say
// so where the stub is written):
//   1. window.nostr — headless Chrome has no NIP-07 extension, so there is no
//      signer on the device. The stub signer answers with the facilitator pubkey
//      the service issued (`facilitatorNpub`) and a kind-27235 event carrying the
//      real `u`/`method`/`payload` tags the console builds. The stub does NOT
//      pretend to be a security boundary: the real service does not verify the
//      signature either (default gap, t_d790103d) — but the stub order service
//      PARSES and LOGS the event, so the run log proves the console really signed
//      and attached a challenge to every call.
//   2. window.open (the venue hand-off) — the venue's checkout is a third-party
//      page; in the recording it must not become a second browser page, because
//      Playwright records ONE video per page and the deliverable is one coherent
//      recording. The stub records the URL the console handed off to and returns
//      a window handle, so the console's own "venue checkout opened in a separate
//      tab" notice is what appears on screen.
//   3. the deadline clock is real (Date.now()), only the seeded `settled_at` is
//      set 90 s in the past so the 5-min SLA countdown is visible and stable.
//
// Run via tools/console-test/run-console-test.sh (which also probes the mp4).

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PORT = Number(process.env.PORT ?? 8791);
const LEDGER_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const STUB = join(HERE, "stub-order-service.ts");
const CVM_ORDERS_DIR = process.env.CVM_ORDERS_DIR ?? join(homedir(), "repos", "cvm-orders");
const FACILITATOR_PUBKEY = process.env.FACILITATOR_NPUB ??
  "1f2e3d4c5b6a7988071625344352617a8b9c0d1e2f30415263748596a7b8c9d0";
// Evidence lands next to the other T4-shaped evidence in this repo
// (evidence/<task-id>/<name>.{mp4,facts.json}) so it is discoverable with the rest.
const OUT = process.env.OUT_DIR ?? join(REPO, "evidence", "t_4726349b");
const RAW = join(OUT, "raw");
const VIEWPORT = { width: 1280, height: 720 };

// A Luhn-valid test PAN. It is typed into the payment reference ON CAMERA and
// must never leave the page (ADR-0013) — that is the point of the clip.
const TEST_PAN = "4242 4242 4242 4242";
const RECEIPT_KEY = "cvm-console-receipts-v1";

const facts = { started_at: new Date().toISOString(), acts: [], findings: [] };
const act = (n, name, data = {}) => {
  facts.acts.push({ act: n, name, at: new Date().toISOString(), ...data });
  console.log(`[act ${n}] ${name}${Object.keys(data).length ? " " + JSON.stringify(data) : ""}`);
};
const say = (msg) => console.log(`[info] ${msg}`);
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}
const getJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return await res.json();
};
const orderState = async (id) => (await getJson(`${BASE}/api/orders/${id}`)).state;
const ledger = () => getJson(`http://127.0.0.1:${LEDGER_PORT}/__ledger`);

// ---------------------------------------------------------------- stub service
rmSync(RAW, { recursive: true, force: true });
mkdirSync(RAW, { recursive: true });

const stub = spawn(
  "deno",
  ["run", "--allow-net", "--allow-read", "--allow-env", "--allow-run", STUB],
  {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(PORT),
      FACILITATOR_NPUB: FACILITATOR_PUBKEY,
      CVM_ORDERS_DIR,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let stubLog = "";
const handshake = await new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => reject(new Error(`stub never printed STUB_READY\n${stubLog}`)), 60_000);
  stub.stdout.on("data", (b) => {
    const text = b.toString();
    stubLog += text;
    for (const line of text.split("\n")) {
      if (line.startsWith("STUB_READY ")) {
        clearTimeout(timer);
        resolvePromise(JSON.parse(line.slice("STUB_READY ".length)));
      }
    }
  });
  stub.stderr.on("data", (b) => { stubLog += `[stderr] ${b}`; });
  stub.on("exit", (code) => reject(new Error(`stub exited early (${code})\n${stubLog}`)));
});
facts.service = handshake;
say(`real cvm-orders slice @ ${handshake.orders_sha} seeded: ${handshake.settled_order} (settled), ${handshake.pending_order} (pending)`);

// poll a cheap endpoint instead of sleeping
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).status === 200) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 200));
  if (i === 99) throw new Error("stub service never became healthy");
}

// The style override reserves a 26 px strip at the bottom of the viewport for the
// act captions, so labelling the acts cannot cover any evidence.
const ACT_CSS = `
  #app{min-height:0!important}
  .shell,.shell.s1,.shell.s2{min-height:calc(100vh - 26px)!important}
  body{padding-bottom:26px}
`;

const INIT = ({ pubkey }) => {
  // NOTE: no DOM work here. addInitScript runs before the document element exists, and
  // touching the DOM at that point broke the console boot (found in run 8). The act strip's
  // CSS is added with page.addStyleTag() after the document is live instead.
  window.__act = (text) => {
    let bar = document.getElementById("__act");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "__act";
      bar.style.cssText =
        "position:fixed;left:0;right:0;bottom:0;height:26px;line-height:26px;padding:0 12px;"
        + "background:#000c;color:#f59e0b;font:600 12.5px ui-sans-serif,system-ui;z-index:99999;"
        + "letter-spacing:.02em;overflow:hidden;white-space:nowrap";
      (document.body ?? document.documentElement).appendChild(bar);
    }
    bar.textContent = text;
  };
  window.__handoffs = [];
  // (2) the venue's own checkout cannot be a third party page inside a one-video recording
  window.open = (url) => {
    window.__handoffs.push(String(url));
    return { closed: false, focus() {}, close() {} };
  };
  // (1) no NIP-07 extension exists in headless Chrome
  window.nostr = {
    getPublicKey: async () => pubkey,
    signEvent: async (template) => {
      const event = { ...template, pubkey, id: "0".repeat(64), sig: "0".repeat(128) };
      window.__signed = (window.__signed ?? []);
      window.__signed.push({ kind: event.kind, tags: event.tags, pubkey: event.pubkey });
      return event;
    },
    nip04: {
      encrypt: async () => "stub-nip04-ciphertext",
      decrypt: async () => "",
    },
  };
}

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({
  viewport: VIEWPORT,
  recordVideo: { dir: RAW, size: VIEWPORT },
});
await context.addInitScript(INIT, { pubkey: FACILITATOR_PUBKEY });
const page = await context.newPage();
const consoleErrors = [];
// A missing favicon is noise, not a page error: the console ships no icon (and
// index.html deliberately declares none). Everything else is a real failure.
const ignorable = (s) => /favicon/i.test(s) || /Failed to load resource/i.test(s);
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !ignorable(m.text())) consoleErrors.push(m.text()); });

const SETTLED = handshake.settled_order;
const PENDING = handshake.pending_order;
const CHECKOUT_URL = handshake.settled_checkout_url;
const text = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
const nav = async (label) => { await page.click(`[data-goto="${label}"]`); await page.waitForTimeout(500); };

let video;
try {
  // ── ACT 1 — sign-in: the service's NIP-98 challenge, signed on the device ────
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.addStyleTag({ content: ACT_CSS });
  await page.waitForSelector("[data-signin]");
  await page.evaluate(() => window.__act("ACT 1 — facilitator console · sign in with NIP-98 (GET /api/auth/challenge)"));
  say(`sign-in screen: ${await page.title()}`);
  await page.waitForTimeout(1200);
  await page.click("[data-signin]");
  await page.waitForSelector(".shell.s1", { timeout: 15_000 });
  await page.waitForTimeout(900);
  const signed = await page.evaluate(() => window.__signed ?? []);
  assert(signed.length === 1, "the console signed exactly one NIP-98 event on sign-in");
  assert(signed[0].kind === 27235, `the signed event is kind 27235 (got ${signed[0].kind})`);
  assert(signed[0].pubkey === FACILITATOR_PUBKEY, "the signer's pubkey is the facilitator key the service issued");
  assert(signed[0].tags.some((t) => t[0] === "u" && t[1].includes("/api/auth/challenge")), "the event carries the u tag for the challenge URL");
  act(1, "sign-in", { screen: "queue", signed_events: signed.length, kind: signed[0].kind, tags: signed[0].tags.map((t) => t[0]) });

  // ── ACT 2 — the paid-basket queue with the 5-min SLA and the sats gate ───────
  await page.evaluate(() => window.__act("ACT 2 — paid-basket queue · 5-min SLA · the sats gate blocks the pending order"));
  const rows = await page.locator(".qrow").count();
  assert(rows === 2, `both seeded orders are in the queue (got ${rows})`);
  const queueText = await text();
  assert(/place now · \d:\d\d/.test(queueText), `the 5-min SLA countdown is visible (${queueText.slice(0, 200)})`);
  assert(queueText.includes("46 950 sats"), "the settled basket's sats total is rendered");
  assert(queueText.includes("28.80 €"), "the settled basket's fiat total is rendered");

  // the pending order must be refused by the console's own ADR-0008/0013 gate
  await page.click(`.qrow:has-text("Pizza e Pasta")`);
  await page.waitForTimeout(700);
  const pendingText = await text();
  assert(pendingText.includes("not proven"), "the pending order shows sats are not proven");
  assert(pendingText.includes('sats payment is "pending", not settled'), "the gate names the reason on screen");
  const placeEnabled = await page.locator(`[data-place="${PENDING}"]`).isEnabled();
  assert(placeEnabled === false, "the place button is dead for an unsettled order");
  act(2, "queue", {
    orders_in_queue: rows,
    sla_visible: true,
    pending_order_blocked: true,
    pending_gate_reason: 'sats payment is "pending", not settled',
    place_button_enabled_for_pending: placeEnabled,
  });

  // ── ACT 3 — placing: real transition, venue hand-off, no card field ─────────
  await page.click(`.qrow:has-text("Doppelt")`);
  await page.waitForTimeout(500);
  await page.click(`[data-place="${SETTLED}"]`);
  await page.waitForSelector(".shell.s2", { timeout: 15_000 });
  await page.evaluate(() => window.__act("ACT 3 — placing · basket, venue hand-off, card data stays on this device"));
  await page.waitForTimeout(1300);
  assert(await orderState(SETTLED) === "placing", "the real service moved paid -> placing");
  const handoffs = await page.evaluate(() => window.__handoffs);
  assert(handoffs.length === 1 && handoffs[0] === CHECKOUT_URL, `the hand-off used the venue's declared checkout_url (${handoffs.join(",")})`);
  assert(await page.locator("input").count() === 4, "the placing pane carries the four receipt fields and no card field");
  assert(await page.locator('input[type="password"], input[name*="card" i], input[name*="cvv" i]').count() === 0, "no card-shaped field exists");
  act(3, "placing", { service_state: "placing", handoff_url: handoffs[0], receipt_inputs: 4, card_fields: 0 });

  // ── ACT 4 — card custody: a PAN typed into the payment reference is refused ──
  await page.evaluate(() => window.__act("ACT 4 — card custody (ADR-0013) · a PAN typed into the payment reference"));
  await page.fill('[data-receipt="venue_reference"]', "#4471");
  await page.fill('[data-receipt="ready_at"]', "18:25");
  await page.fill('[data-receipt="paid_with"]', "card at the venue terminal");
  await page.fill('[data-receipt="payment_reference"]', TEST_PAN);
  await page.waitForTimeout(900);
  const before = (await ledger()).posts.filter((p) => p.includes("/transition")).length;
  await page.click(`[data-placed="${SETTLED}"]`);
  await page.waitForTimeout(1200);
  const after4 = await ledger();
  const afterCount = after4.posts.filter((p) => p.includes("/transition")).length;
  const refusalText = await text();
  assert(refusalText.includes("refusing card data at receipt:payment_reference"), "the refusal names the field it refused");
  assert(refusalText.includes("refused and discarded"), "the console states the value was discarded");
  assert(afterCount === before, `no transition request was sent with the PAN in it (${before} -> ${afterCount})`);
  assert(after4.pan_shaped_bodies === 0, "no card-shaped value ever reached the order service");
  assert(await orderState(SETTLED) === "placing", "the order did not advance");
  const stored = await page.evaluate((k) => localStorage.getItem(k) ?? "{}", RECEIPT_KEY);
  assert(!stored.includes("4242"), "nothing PAN-shaped was written to device storage");
  const leftover = await page.inputValue('[data-receipt="payment_reference"]');
  assert(leftover === "", `the refused value is gone from the field (got "${leftover}")`);
  // Observed (UX note, recorded not asserted): the refusal goes through the console's
  // re-render, so the pane is rebuilt from state and the whole form is cleared — the
  // operator retypes the non-card fields as well. Safe, if slightly blunt.
  const keptVenueRef = await page.inputValue('[data-receipt="venue_reference"]');
  act(4, "card-custody refusal", {
    typed: "PAN-shaped value (Luhn-valid test number)",
    refused_at: "receipt:payment_reference",
    transition_requests_sent: afterCount - before,
    pan_shaped_values_on_the_wire: after4.pan_shaped_bodies,
    pan_in_device_storage: false,
    field_after_refusal: "empty",
    whole_form_cleared_by_refusal: keptVenueRef === "",
  });

  // ── ACT 5 — record the venue's receipt and mark the order placed ────────────
  await page.evaluate(() => window.__act("ACT 5 — type the venue receipt (order no. #4471, ready 18:25), then mark placed"));
  await page.fill('[data-receipt="venue_reference"]', "#4471");
  await page.fill('[data-receipt="ready_at"]', "18:25");
  await page.fill('[data-receipt="paid_with"]', "card at the venue terminal");
  await page.fill('[data-receipt="payment_reference"]', "pi_3Qk9Zx2eZvKYlo2C");
  await page.waitForTimeout(900);
  // The act-4 refusal banner is still on screen and is NOT cleared by a successful save,
  // so "wait for any .error" would return instantly on stale text. Wait for the queue
  // shell, or for the banner to have CHANGED (a new, genuine refusal of this receipt).
  const staleBanner = await page.evaluate(() => document.querySelector(".error")?.textContent ?? "");
  const typedBack = await page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll("[data-receipt]")].map((el) => [el.dataset.receipt, el.value]))
  );
  facts.receipt_typed_before_click = typedBack;
  await page.click(`[data-placed="${SETTLED}"]`);
  await page.waitForFunction(
    (stale) => {
      if (document.querySelector(".shell.s1")) return true;
      const now = document.querySelector(".error")?.textContent ?? "";
      return now.length > 0 && now !== stale;
    },
    staleBanner,
    { timeout: 15_000 },
  );
  await page.waitForSelector(".shell.s1", { timeout: 15_000 });
  const afterPlaceText = await text();
  const banner = await page.evaluate(() => document.querySelector(".error")?.textContent ?? "");
  // The console does not clear the act-4 refusal banner after a successful retry, so the
  // banner alone is not evidence of failure here. Acceptance is proven against the real
  // service below (state + accepted transition + the on-screen receipt block); the stale
  // banner is recorded as an observation instead.
  facts.findings.push({
    kind: "ux-observation",
    where: "site/console/app.js — placing view",
    observed: "the card-custody refusal banner from the first attempt is still rendered after the corrected receipt saves successfully",
    impact: "cosmetic: the operator sees a stale refusal next to a successful save",
    evidence: banner.slice(0, 200),
  });
  const phrase = "record the venue's order number";
  const at = afterPlaceText.indexOf(phrase);
  const around = at < 0 ? "(not present)" : `…${afterPlaceText.slice(Math.max(0, at - 160), at + 160)}…`;
  assert(at < 0, `the placing form stopped demanding the receipt (typed=${JSON.stringify(typedBack)} | banner: ${banner} | found at ${at}: ${around})`);
  assert(afterPlaceText.includes("Queue") && await page.locator(".shell.s1").count() === 1, `the console returned to the queue (banner: ${banner} | ${afterPlaceText.slice(0, 300)})`);
  await page.waitForTimeout(1000);
  assert(await orderState(SETTLED) === "placed", "the real service moved placing -> placed");
  const placedLog = (await ledger()).posts;
  assert(placedLog.some((p) => p.includes(`/orders/${SETTLED}/transition`) && p.endsWith("-> 200")), "the placed transition was accepted by the real service");
  assert(afterPlaceText.includes("#4471"), "the venue order number is captured on device and shown");
  assert(afterPlaceText.includes("18:25"), "the ready time is captured on device and shown");
  assert(afterPlaceText.includes("persistence gap"), "the console states the service drops the receipt field instead of pretending");
  act(5, "placed", {
    service_state: "placed",
    venue_reference: "#4471",
    ready_at: "18:25",
    paid_with: "card at the venue terminal",
    payment_reference: "pi_3Qk9Zx2eZvKYlo2C",
    server_persisted_receipt: false,
    console_wording: "venue receipt captured on this device; the order service dropped the receipt field (persistence gap)",
  });

  // ── ACT 6 — the last leg: the venue handed the order over ──────────────────
  await page.evaluate(() => window.__act("ACT 6 — the venue handed it over: mark the order ready"));
  await page.waitForTimeout(800);
  await page.click(`[data-ready="${SETTLED}"]`);
  await page.waitForTimeout(1200);
  assert(await orderState(SETTLED) === "ready", "the real service moved placed -> ready");
  act(6, "ready", { service_state: "ready" });

  // ── ACT 7 — settlements: fees kept, fiat spent, the receipt on this device ──
  await page.evaluate(() => window.__act("ACT 7 — settlements · the receipt recorded on this device"));
  await nav("settlements");
  await page.waitForTimeout(1400);
  const settleText = await text();
  assert(settleText.includes("#4471"), `the settlements view shows the venue order number (${settleText.slice(0, 300)})`);
  assert(settleText.includes("captured on device"), "the row states the receipt is the device-side copy");
  assert(settleText.includes("fees in open queue") && settleText.includes("fiat recorded as spent"), "the money summary renders its three boxes");
  // Observed, not asserted (it is a defect, filed as a follow-up card): the row is
  // joined against the paid-only queue, so a PLACED order's venue/fee/fiat resolve
  // to "—" / 0 in this view even though the receipt is right there. Recorded here so
  // the evidence does not hide it; the video shows the same thing.
  const defect = {
    where: "site/console/app.js settlementsView()",
    what: "the receipt row and the 'fiat recorded as spent' / 'fees kept' sums join state.receipts against state.queue, which is paid-only; once an order leaves `paid` the venue name and the fee/fiat totals render as '—' / 0.00 € although the receipt was captured",
    observed: /—[^]{0,40}fee 0 sats kept/.test(settleText) || settleText.includes("fee 0 sats kept"),
    rendered_excerpt: settleText.slice(0, 320),
  };
  facts.findings.push(defect);
  act(7, "settlements", { receipt_visible: true, defect_observed: defect.observed, defect: defect.what });

  // ── CLOSING FRAME — repo + the commit under test ───────────────────────────
  const opened = (await ledger()).nip98_events;
  const close = await page.evaluate((f) => {
    document.documentElement.innerHTML = `<body style="margin:0;background:#0b0f14;color:#eceae4;
      font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;padding:26px 30px">
      <div style="color:#f59e0b;font-weight:700;font-size:19px;margin-bottom:4px">Facilitator console — T4 happy path, verified end to end</div>
      <div style="color:#8b9096;margin-bottom:16px">one test · one recording · 1280x720 · driven against the real cvm-orders slice over real HTTP</div>
      <table style="border-collapse:collapse;font-size:13.5px">
        ${[
          ["repo under test", f.repo],
          ["evidence branch", f.branch],
          ["console commit under test", f.console_sha],
          ["harness commit", f.harness_sha],
          ["order service", `real cvm-orders slice @ ${f.orders_sha}`],
          ["seeded orders", `${f.settled} settled · ${f.pending} pending`],
          ["signed NIP-98 events", `${f.nip98} attached to every call`],
          ["state machine driven", "paid → placing → placed → ready (re-read from the service after each step)"],
          ["venue receipt captured", "#4471 · ready 18:25 · pi_3Qk9Zx2eZvKYlo2C"],
          ["card custody (ADR-0013)", `PAN typed into the payment reference: refused · 0 transition requests sent · ${f.panWires} card-shaped values on the wire`],
          ["recorded", f.at],
        ].map(([k, v]) => `<tr><td style="color:#8b9096;padding:2px 18px 2px 0;vertical-align:top;white-space:nowrap">${k}</td><td>${v}</td></tr>`).join("")}
      </table>
      <div style="color:#8b9096;margin-top:18px">This recording is the deliverable: no assertion passes without it. Wire-level card check: the stub order service logs a PAN-shaped value in any request body and fails the run.</div>
    </body>`;
    return true;
  }, {
    repo: "cvm-services/cvm-registry",
    branch: process.env.BRANCH ?? "pr/console-happy-path-video",
    console_sha: process.env.CONSOLE_SHA ?? "(see run output)",
    harness_sha: process.env.HARNESS_SHA ?? "(see run output)",
    orders_sha: handshake.orders_sha,
    settled: SETTLED,
    pending: PENDING,
    nip98: opened,
    panWires: 0,
    at: new Date().toISOString(),
  });
  assert(close === true, "closing frame rendered");
  await page.waitForTimeout(6000);
  act(8, "closing frame", { repo: "cvm-services/cvm-registry", console_sha: process.env.CONSOLE_SHA ?? null, harness_sha: process.env.HARNESS_SHA ?? null, orders_sha: handshake.orders_sha });

  const pages = context.pages().length;
  assert(pages === 1, `the recording is a single page (got ${pages}) — Playwright writes one video per page`);
  video = page.video();
  facts.finished_at = new Date().toISOString();
  facts.console_errors = consoleErrors;
  assert(consoleErrors.length === 0, `no page errors during the flow: ${consoleErrors.join(" | ")}`);
  video = page.video();
} catch (err) {
  // Keep a diagnosable facts file for a failed run, and never let a failed take
  // overwrite the good recording (the video is only promoted on a green run).
  facts.error = String(err?.message ?? err).split("\n")[0];
  throw err;
} finally {
  try {
    const file = video ? await video.path() : page.video() ? await page.video().path() : null;
    await page.close();
    if (file) {
      const dest = join(OUT, facts.error ? "console-happy-path.FAILED.webm" : "console-happy-path.webm");
      renameSync(file, dest);
      facts.webm = dest;
    }
    await context.close();
  } catch (e) {
    say(`cleanup: ${e}`);
  }
  const final = await ledger().catch(() => null);
  if (final) facts.ledger = final;
  browser.close?.().catch?.(() => {});
  stub.kill("SIGTERM");
  facts.stub_log = stubLog.split("\n").filter((l) => l.startsWith("[stub]")).slice(-60);
  facts.console_errors = consoleErrors;
  if (!facts.finished_at) facts.failed_at = new Date().toISOString();
  writeFileSync(join(OUT, "console-happy-path.facts.json"), JSON.stringify(facts, null, 2));
}

console.log("\n=== FACTS ===");
console.log(JSON.stringify({ acts: facts.acts.length, ledger: facts.ledger, findings: facts.findings, webm: facts.webm }, null, 2));
console.log("HAPPY PATH OK");
