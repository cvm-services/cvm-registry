import { currentIdentity } from "./identity.js";
import { loadOrders, saveOrder, signIn } from "./identity.js";

const state = {
  screen: 1, venue: null, method: "pickup", item: null, qty: 1,
  options: { sauce: "House", extras: ["Bacon"], size: "Single" },
  basket: [], order: null, invoice: null, catalog: null, inputRegister: null,
};
// Order recovery (customer surface): the order id is the customer's ONLY handle
// on a live payment — losing it on refresh stranded a paid order with no way to
// see it. Persist the id (never card material, never a secret) and resume the
// status screen on load; the id alone is enough because GET /orders/:id is the
// customer's own poll and the invoice is re-fetched from the service.
const ORDER_KEY = "cvm-order-id-v1";
function rememberOrder(o) { try { if (o?.id) localStorage.setItem(ORDER_KEY, o.id); } catch {} }
function forgetOrder() { try { localStorage.removeItem(ORDER_KEY); } catch {} }
async function resumeOrder() {
  let id = null;
  try { id = localStorage.getItem(ORDER_KEY); } catch {}
  if (!id) return false;
  try {
    const r = await fetch(`/api/orders/${encodeURIComponent(id)}`);
    if (!r.ok) { if (r.status === 404) forgetOrder(); return false; }
    state.order = await r.json();
    try {
      const p = await fetch(`/api/orders/${encodeURIComponent(id)}/invoice`);
      if (p.ok) state.invoice = await p.json();
    } catch {}
    state.screen = 5;
    return true;
  } catch { return false; }
}
 const ORDER_INPUT_REGISTER_URL = "../../vocab/service-inputs.json";
const app = document.querySelector("#app");
const sats = (n) => `${Math.round(n * 1000).toLocaleString("en-US").replaceAll(",", " ")} sats`;
const fiat = (n) => `${n.toFixed(2)} €`;
// The order service sends integer SATS (state.order.total), never EUR: those
// values must not pass through sats()/fiat(), which scale EUR by 1000.
const satsNative = (n) => `${Math.round(n).toLocaleString("en-US").replaceAll(",", " ")} sats`;
const eurOfSats = (n) => `${(n / 1000).toFixed(2)} €`;
// ADR-0008: the status timeline may only claim money arrived once the rail has
// verified it, so every row is derived from the order's `state` — never from the
// customer's own "I've paid" claim, and never from a field the service omits.
const PAID_STATES = ["paid", "placing", "placed", "ready"];
const PLACING_STATES = ["placing", "placed", "ready"];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
function price(item) { return Number(item?.prices_by_order_method?.[state.method] ?? 0); }
function navigate(screen) { state.screen = screen; render(); window.scrollTo(0, 0); }
function details(text) { return `<details><summary>Details</summary><p>${esc(text)}</p></details>`; }
function header(title, subtitle = "") { return `<header class="top"><button class="back" data-back aria-label="Back">‹</button><div><h1>${title}</h1>${subtitle ? `<p class="sub">${subtitle}</p>` : ""}</div></header>`; }
function venueList() {
  const venues = state.catalog?.venues || [];
  return `<section class="screen"><div class="top home"><div><h1>Order food,<br>pay in sats</h1><p class="sub">Curated venues near you</p></div><span class="wallet">⚡ 45 210 sats</span></div><label class="search"><span>⌕</span><input placeholder="Search venues or dishes" data-search></label><div class="venues">${venues.map(v => { const ms = methodsOf(v); const from = Math.min(...v.items.filter(i=>i.available !== false).map(i=>priceOf(i, ms[0] || "pickup"))); return `<button class="venue" data-venue="${esc(v.venue_slug)}"><div class="row"><h2>${esc(v.name)}</h2><b>›</b></div><p class="meta">${esc(v.address || "Berlin")} · ${esc(v.category || "Food")}</p><div class="tags">${ms.map(m=>`<span>${esc(methodLabel(m).toLowerCase())}</span>`).join("")}<span>${v.item_count || v.items.length} items</span></div><p class="from">From <strong>${sats(from)}</strong> <em>${fiat(from)}</em></p></button>` }).join("")}</div><p class="trust">✓ <b>No account, no card.</b> You pay sats; a facilitator orders for you.</p></section>`;
}
function priceOf(i, method) { return Number(i?.prices_by_order_method?.[method] ?? 0); }
function methodsOf(v) {
  // The methods a venue actually priced. A venue publishes its own set: chandi
  // prices dine_in only, pizza-e-pasta pickup only, three-buddies all four.
  // Hardcoding pickup/delivery meant choosing chandi showed NO selectable
  // method, so the order could never be placed from this screen.
  const seen = [];
  for (const i of (v?.items || [])) for (const m of Object.keys(i.prices_by_order_method || {})) if (!seen.includes(m)) seen.push(m);
  return seen;
}
function methodLabel(m) { return ({pickup:"Pickup", delivery:"Delivery", dine_in:"Dine in", room_service:"Room service"})[m] || m; }
function setVenue(v) {
  state.venue = v;
  // Preselect a method the venue actually priced, or the price lookup below
  // renders every item at 0 sats.
  const ms = methodsOf(v);
  if (!ms.includes(state.method)) state.method = ms[0] || "pickup";
}
function menu() { const v=state.venue; const items=v.items || []; return `${header(esc(v.name), "Catalog snapshot · prices served by venue")}<section class="screen menu-screen"><div class="seg">${methodsOf(v).map(m=>`<button class="${state.method===m?'on':''}" data-method="${esc(m)}">${esc(methodLabel(m))}</button>`).join("")}</div><div class="menu">${items.map(i=>`<button class="item ${i.available===false?'dead':''}" ${i.available===false?'disabled':''} data-item="${esc(i.sku)}"><span><strong>${esc(i.name)}</strong><small>${esc((i.allergens||[]).join(" · "))}</small><b>${sats(priceOf(i,state.method))} <em>${fiat(priceOf(i,state.method))}</em></b></span>${i.available===false?'<i class="soldout">sold out</i>':'<b class="arrow">›</b>'}</button>`).join("")}</div>${state.basket.length?`<div class="basket-bar"><span>${state.basket.reduce((n,x)=>n+x.qty,0)} items<br><strong>${sats(total())}</strong></span><button data-basket>View basket</button></div>`:''}</section>`; }
function itemSheet(){const i=state.item,p=price(i); return `${header(esc(i.name), `${sats(p)} · ${fiat(p)}`)}<section class="sheet"><p class="description">${esc((i.allergens||[]).join(" · "))}</p><fieldset><legend>Sauce <small>required · pick 1</small></legend>${["House","BBQ","Garlic","None"].map(x=>`<button class="pill ${state.options.sauce===x?'on':''}" data-sauce="${x}">${x}</button>`).join("")}</fieldset><fieldset><legend>Extras <small>up to 3</small></legend>${[["Bacon",.15],["Jalapeños",.09],["Extra cheese",.12]].map(([x,n])=>`<button class="pill ${state.options.extras.includes(x)?'on':''}" data-extra="${x}">+ ${x}<small>${sats(n)}</small></button>`).join("")}<button class="pill dead" disabled>+ Avocado<small>sold out</small></button></fieldset><fieldset><legend>Size <small>required · pick 1</small></legend>${["Single","Double"].map(x=>`<button class="pill ${state.options.size===x?'on':''}" data-size="${x}">${x}</button>`).join("")}</fieldset><div class="quantity"><button data-qty="-1">−</button><strong>${state.qty}</strong><button data-qty="1">+</button></div><button class="primary" data-add>Add to basket — ${sats(itemTotal())}<small>${fiat(itemTotal())} · options included</small></button></section>`; }
function itemTotal(){return price(state.item)*state.qty + state.options.extras.reduce((n,x)=>n+({Bacon:.15,Jalapeños:.09,"Extra cheese":.12}[x]||0),0)*state.qty;}
function total(){return state.basket.reduce((n,x)=>n+x.amount*x.qty,0);}
// Integer sats for the grand total, from whichever source is authoritative: the
// service's priced order once it exists, else the client's own basket + 8% fee
// (in EUR, converted at the display rate).
function grandSats(){return Number.isFinite(state.order?.total) ? state.order.total : Math.round(total() * 1.08 * 1000);}
function inputFields(){
  const fields = state.inputRegister?.fields || {};
  return Object.entries(fields).filter(([name]) => name.startsWith("contact.") || name.startsWith("order."))
    .filter(([name]) => ["contact.phone","contact.name","order.notes"].includes(name))
    .map(([name, spec]) => `<label>${esc(name)}${spec.note ? ` <small>${esc(spec.note)}</small>` : ""}<input data-input="${esc(name)}" type="${spec.type === "number" ? "number" : name.endsWith("phone") ? "tel" : "text"}" ${name === "contact.phone" ? "required" : ""} placeholder="${name === "contact.phone" ? "Your mobile number" : "Optional"}"></label>`).join("");
}
function basket(){const sub=total(),fee=sub*.08,grand=sub+fee;return `${header("Basket",state.venue.name)}<section class="screen"><div class="lines">${state.basket.map(x=>`<div class="line"><div><strong>${x.qty} × ${esc(x.name)}</strong><small>${esc(x.options)}</small></div><b>${sats(x.amount*x.qty)}<em>${fiat(x.amount*x.qty)}</em></b></div>`).join("")}</div><div class="seg"><button class="on">${esc(methodLabel(state.method))} · venue</button></div><div class="fields">${inputFields()}</div><div class="totals"><p>Subtotal <b>${fiat(sub)}</b></p><p>Facilitator fee · 8% <b>${fiat(fee)}</b></p><hr><p class="grand">Total <b>${sats(grand)} <em>${fiat(grand)}</em></b></p></div>${details("The facilitator fee covers placing and confirming your order. Inputs are rendered from the service-inputs register. No client-side key or wallet custody is used.")}<button class="primary accent" data-pay>Pay ${sats(grand)}<small>Cashu or Lightning · fee included</small></button></section>`;}
function pay(){return `${header("Pay securely",state.venue.name)}<section class="screen pay"><div class="steps"><b>Basket</b><b class="on">Payment</b><b>Status</b></div><h2>${satsNative(grandSats())}</h2><p class="sub">${eurOfSats(grandSats())} · expires in <strong data-expiry>15:00</strong></p><img class="qr" src="${esc(state.invoice?.qr || "")}" alt="Lightning invoice QR"><code class="invoice">${esc(state.invoice?.bolt11 || "Invoice unavailable")}</code><p class="paynote">Scan the real Lightning invoice or pay with Cashu. The invoice expires automatically.</p><button class="primary" data-paid>I've paid — check status</button>${details("Payment is handled by the order service. This client never holds keys or constructs a payment token.")}</section>`;}
function status(){const o=state.order||{};const vr=o.venue_reference;
// ADR-0014: the venue's OWN order number, once a facilitator records it. It is
// shown alongside our sats reference — never instead of it — and the venue
// verification line is only claimed when the number actually exists, because the
// storefront's tracker is account-scoped and cannot be checked by number alone.
return `${header(`Order #${esc(o.id||"pending")}` , state.venue?.name || "")}<section class="screen status"><div class="timeline">${[["Paid",PAID_STATES.includes(o.state),"Payment received"],["Facilitator placing your order",PLACING_STATES.includes(o.state),"usually under 3 min"],["Order placed at venue",["placed","ready"].includes(o.state),vr?`venue order #${esc(vr)}`:"awaiting venue confirmation"],["Ready for pickup",o.state==="ready","venue confirmation"]].map(([x,done,n])=>`<div class="tl"><span class="dot ${done?'done':''}">${done?'✓':'·'}</span><div><b>${x}</b><small>${n}</small></div></div>`).join("")}</div>${vr?`<div class="venue-ref"><span>Venue order number</span><b>#${esc(vr)}</b><p>Quote this at ${esc(state.venue?.name||"the venue")}. The venue's own tracker is account-scoped, so this is your reference to check with them — not a number the venue's public website looks up.</p></div>`:""}<div class="order-card"><b>${state.basket.map(x=>`${x.qty}× ${esc(x.name)}`).join(", ")}</b><p>${o.state||"awaiting_payment"} · ${esc(methodLabel(state.method))}</p></div><p class="next">The facilitator confirms each step here. If the venue cannot take the order, you are refunded in full.</p><button class="secondary" data-refresh>Refresh status</button>
${identitySummary()?`<button class="primary" data-save-order>${state.saved?(state.saved.error?"Save failed — retry":"Saved to relays ✓"):"Save this order to my Nostr account"}</button>
<button class="secondary" data-my-orders>My orders</button>`:`<button class="secondary" data-signin>Save my orders (sign in)</button>`}
${state.saved?.error?`<p class="error">${esc(state.saved.error)}</p>`:""}</section>`;}
function signInScreen(){
  const has07 = Boolean(globalThis.nostr?.signEvent);
  return `<section class="screen"><div class="top"><div><h1>Save my orders</h1><p class="sub">Sign in with Nostr so your orders follow you</p></div></div>
  <div class="order-card"><b>Why sign in?</b><p>Your orders are stored on relays as your own records, so a new phone or a cleared browser can get them back. The public receipt proves the order; the details stay encrypted to your key.</p></div>
  ${has07?`<button class="primary" data-signin-nip07>Use this device's Nostr extension</button>`:""}
  <label class="field"><span>Or paste a bunker:// URL (works on a phone)</span><input data-bunker placeholder="bunker://…" autocapitalize="off" spellcheck="false"></label>
  <button class="primary" data-signin-bunker>Connect bunker</button>
  <p class="next">Signing in is optional. You can always pay without an account.</p>
  <button class="secondary" data-back>Back</button></section>`;
}
function myOrdersScreen(){
  const m = state.myOrders || {};
  const id = currentIdentity();
  if(m.loading) return `<section class="screen"><p class="loading">Looking for your orders on relays…</p></section>`;
  const rows = (m.orders||[]).map(o=>`<div class="order-card"><b>${esc(o.venue_slug||"order")}</b><p>#${esc(o.order_id||"")} · ${esc(o.state||"")}${Number.isFinite(o.total)?` · ${o.total} sats`:""}</p>${o.detail?.items?.length?`<p>${o.detail.items.map(i=>`${i.qty}× ${esc(i.name)}`).join(", ")}</p>`:""}${o.venue_reference?`<p class="venue-ref-inline">Venue order #${esc(o.venue_reference)}</p>`:""}</div>`).join("");
  return `<section class="screen"><div class="top"><div><h1>My orders</h1><p class="sub">${id?`Signed in as ${esc(id.pubkey.slice(0,8))}…`:"Not signed in"}</p></div></div>
  ${m.error?`<p class="error">Could not read relays: ${esc(m.error)}</p>`:""}
  ${rows||`<p class="next">No orders found for this key yet.</p>`}
  <button class="secondary" data-refresh-orders>Refresh</button>
  <button class="secondary" data-back>Back</button></section>`;
}
function render(){ if(!state.catalog){app.innerHTML='<p class="loading">Loading venues…</p>';return} app.innerHTML=state.screen===1?venueList():state.screen===2?menu():state.screen===3?itemSheet():state.screen===4?basket():state.screen===5?pay():state.screen===7?signInScreen():state.screen===8?myOrdersScreen():status(); bind(); }
function bind(){app.querySelector("[data-back]")?.addEventListener("click",()=>navigate(Math.max(1,state.screen-1)));app.querySelectorAll("[data-venue]").forEach(b=>b.onclick=()=>{state.venue=state.catalog.venues.find(v=>v.venue_slug===b.dataset.venue);setVenue(state.venue);navigate(2)});app.querySelectorAll("[data-method]").forEach(b=>b.onclick=()=>{state.method=b.dataset.method;render()});app.querySelectorAll("[data-item]").forEach(b=>b.onclick=()=>{state.item=state.venue.items.find(i=>i.sku===b.dataset.item);state.qty=1;navigate(3)});app.querySelectorAll("[data-sauce]").forEach(b=>b.onclick=()=>{state.options.sauce=b.dataset.sauce;render()});app.querySelectorAll("[data-size]").forEach(b=>b.onclick=()=>{state.options.size=b.dataset.size;render()});app.querySelectorAll("[data-extra]").forEach(b=>b.onclick=()=>{const x=b.dataset.extra;state.options.extras=state.options.extras.includes(x)?state.options.extras.filter(y=>y!==x):[...state.options.extras,x];render()});app.querySelectorAll("[data-qty]").forEach(b=>b.onclick=()=>{state.qty=Math.max(1,state.qty+Number(b.dataset.qty));render()});app.querySelector("[data-add]")?.addEventListener("click",()=>{state.basket.push({name:state.item.name,qty:state.qty,amount:itemTotal()/state.qty,options:`${state.options.sauce} · ${state.options.extras.map(x=>`+${x.toLowerCase()}`).join(" · ")} · ${state.options.size}`});navigate(2)});app.querySelector("[data-basket]")?.addEventListener("click",()=>navigate(4));app.querySelector("[data-pay]")?.addEventListener("click",createOrder);app.querySelector("[data-paid]")?.addEventListener("click",()=>{navigate(6);beginPolling()});app.querySelector("[data-refresh]")?.addEventListener("click",pollStatus);
app.querySelector("[data-signin]")?.addEventListener("click",()=>{state.screen=7;render()});
app.querySelector("[data-signin-nip07]")?.addEventListener("click",async()=>{if(await doSignIn()){state.screen=6;state.saved=null;render()}});
app.querySelector("[data-signin-bunker]")?.addEventListener("click",async()=>{const u=app.querySelector("[data-bunker]")?.value?.trim();if(!u){app.insertAdjacentHTML("beforeend",'<p class="error">Paste a bunker:// URL first.</p>');return}if(await doSignIn(u)){state.screen=6;state.saved=null;render()}});
app.querySelector("[data-save-order]")?.addEventListener("click",doSaveOrder);
app.querySelector("[data-my-orders]")?.addEventListener("click",()=>{state.screen=8;doShowMyOrders()});
app.querySelector("[data-refresh-orders]")?.addEventListener("click",doShowMyOrders);}
async function createOrder(){const inputs={};for(const field of app.querySelectorAll("[data-input]")){if(field.required&&!field.value.trim()){field.focus();return}if(field.value.trim())inputs[field.dataset.input]=field.type==="number"?Number(field.value):field.value.trim()}const payload={venue_slug:state.venue.venue_slug,items:state.basket,fulfilment:state.method,inputs};try{const r=await fetch("/api/orders",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});if(!r.ok)throw Error("order service unavailable");state.order=await r.json();rememberOrder(state.order);const p=await fetch(`/api/orders/${encodeURIComponent(state.order.id)}/invoice`);if(!p.ok)throw Error("invoice unavailable");state.invoice=await p.json();if(!state.invoice.bolt11||!state.invoice.qr)throw Error("invalid invoice response");navigate(5)}catch(e){app.insertAdjacentHTML("beforeend",`<p class="error">${esc(e.message)}. No payment was created; try again.</p>`)} }
let pollTimer;
async function pollStatus(){if(!state.order?.id)return;try{const r=await fetch(`/api/orders/${encodeURIComponent(state.order.id)}`);if(r.ok)state.order=await r.json()}catch{}render()}
function beginPolling(){clearInterval(pollTimer);pollTimer=setInterval(()=>{if(state.screen===6)pollStatus();else clearInterval(pollTimer)},5000)}

// ---- Nostr identity (ADR-0017): optional, never required to pay ------------
// The signer lives in memory only. A reload reconnects (NIP-46 re-authorises).
let SIGNER = null;
const signerOf = () => SIGNER;
function identitySummary(){
  const id = currentIdentity();
  if(!id) return null;
  if(!SIGNER && id.bunker) return {pubkey:id.pubkey, method:id.method, reconnect:true};
  return {pubkey:id.pubkey, method:id.method, reconnect:false};
}
async function doSignIn(uri){
  try{
    SIGNER = await signIn({uri:uri||undefined});
    // The customer usually pays first and signs in at the receipt, so the order
    // already exists: hand the service the identity now (ADR-0018).
    if(state.order?.id) state.attached = await attachIdentity(state.order.id, SIGNER.pubkey);
    return true;
  }catch(e){
    app.insertAdjacentHTML("beforeend",`<p class="error">${esc(e.message)}. You can still order without signing in.</p>`);
    return false;
  }
}
/**
 * Tell the service who the customer is, so the facilitator can reach them about
 * this order (ADR-0018). Deliberately best-effort: identity is a convenience for
 * the human on the other side, and a failure here must never look like a failure
 * of an order that is already paid for.
 */
async function attachIdentity(orderId, pubkey){
  if(!orderId || !pubkey) return null;
  try{
    const r = await fetch(`/api/orders/${encodeURIComponent(orderId)}/identity`, {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({customer_npub: pubkey}),
    });
    return await r.json();
  }catch(e){ return {error: String(e)}; }
}

async function doSaveOrder(){
  if(!state.order?.id){return}
  if(!SIGNER){
    // A stored bunker URL means we can reconnect without the customer pasting
    // it again; anything else needs the sign-in form.
    const id = currentIdentity();
    if(id?.bunker){ if(!await doSignIn(id.bunker)) return; }
    else { state.screen = 7; return render(); }
  }
  try{
    const out = await saveOrder(SIGNER, {...state.order, inputs: contactInputs(), items: state.order.items ?? state.basket});
    // Attach the identity to the order as well, so the facilitator sees who to
    // contact even if the customer never opens the My-orders list again.
    if(state.order?.id) state.attached = await attachIdentity(state.order.id, SIGNER.pubkey);
    state.saved = out;
    render();
  }catch(e){
    state.saved = {error: e.message};
    render();
  }
}
async function doShowMyOrders(){
  const id = currentIdentity();
  if(!id){ state.screen = 7; return render(); }
  if(!SIGNER && id.bunker){ if(!await doSignIn(id.bunker)) return; }
  state.myOrders = {loading:true};
  render();
  try{
    state.myOrders = {orders: await loadOrders(id.pubkey, {decrypt: Boolean(signerOf()), signer: signerOf()})};
  }catch(e){
    state.myOrders = {error: e.message};
  }
  render();
}
function contactInputs(){
  const inputs = {};
  for(const f of app.querySelectorAll("[data-input]")){ if(f.value?.trim()) inputs[f.dataset.input] = f.type==="number"?Number(f.value):f.value.trim(); }
  return inputs;
}
Promise.all([fetch("../menu.json").then(r=>r.json()),fetch(ORDER_INPUT_REGISTER_URL).then(r=>r.json())]).then(async([catalog,register])=>{state.catalog=catalog;state.inputRegister=register;
// Resume a live order before painting the venue list, so a refresh lands the
// customer back on their order instead of losing it.
if(await resumeOrder()){beginPolling()}render()}).catch(()=>{app.innerHTML='<p class="error">Catalog or input register unavailable. Try again later.</p>'});
