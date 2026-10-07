/**
 * spec.js — build a flat render spec from SERVED data.
 *
 * Shape (json-render compatible, ADR-0005):
 *   { version: 1, root: "<id>",
 *     elements: { "<id>": { component, props, children: ["<id>", ...] } } }
 *
 * `buildServiceSpec(entry, menuData, opts?)` is a PURE function of served data:
 *   - same inputs -> byte-identical output (no clock, no random, no DOM, no globals)
 *   - it SELECTS and FORMATS prices out of `prices_by_order_method`; it never
 *     states one. A number in this spec is a copy of a served number, and the
 *     renderer re-checks it against the served data before painting it.
 *
 * It does not invent tools either: `OrderAction` appears only when the
 * announcement declares the `order` cap, `HandoffAction` only when the
 * announcement publishes an ordering URL. The renderer gates both again,
 * independently (defence in depth).
 *
 * Size discipline: `children: []` and `props: {}` are omitted, ids are short
 * (`m<sku>` / `p<n>` / `b<n>`), and the served currency is not restated on
 * every PriceRow — the renderer falls back to the served menu currency. The
 * whole spec for a 76-item venue has to fit the renderer's 16 KiB cap, and it
 * does (see tests/render_spec_test.ts, which asserts it).
 */

import { SPEC_VERSION, declaresTool } from "./catalog.js";

/** Display amount: the served number, verbatim, plus its served currency. */
export function formatAmount(amount, currency) {
  return `${amount} ${currency || ""}`.trim();
}

function isOrderingUrl(u) {
  return typeof u === "string" && /^https?:\/\/[^\s]+$/i.test(u);
}

/** The venue's published ordering URL, from the announcement. Never from a spec. */
export function publishedOrderUrl(entry) {
  return ((entry && entry.links) || []).find(isOrderingUrl) || null;
}

/** The methods a venue serves: its declared fulfilment, intersected with prices. */
export function servedMethods(entry, menuData) {
  const declared = (((entry || {}).declared || {}).fulfilment || {}).methods || [];
  const priced = new Set();
  for (const it of ((menuData || {}).items) || []) {
    for (const m of Object.keys(it.prices_by_order_method || {})) priced.add(m);
  }
  const out = declared.filter((m) => priced.has(m));
  return out.length ? out : [...priced].sort();
}

function priceFor(item, method) {
  const p = (item.prices_by_order_method || {})[method];
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

/**
 * The served basket for a local selection: unit prices are read straight out of
 * `prices_by_order_method[method]`, and the total is the sum of those served
 * numbers. Nothing here can produce a price the venue did not serve.
 *
 * `servedOrder` (a real `order` tool response) wins when supplied: then the
 * basket IS the venue's own basket, verbatim.
 */
export function servedBasket(menuData, method, selection, servedOrder) {
  if (servedOrder && Array.isArray(servedOrder.lines)) {
    return {
      method: servedOrder.fulfilment || method,
      lines: servedOrder.lines.map((l) => ({ sku: l.sku, id: l.id, name: l.name, qty: l.qty, amount: l.unit_price })),
      total: servedOrder.total,
    };
  }
  const bySku = new Map(((menuData || {}).items || []).map((i) => [i.sku, i]));
  const lines = [];
  for (const sel of selection || []) {
    const it = bySku.get(sel.sku);
    if (!it) continue;
    const amount = priceFor(it, method);
    if (amount === null) continue;
    lines.push({ sku: it.sku, id: it.id, name: it.name, qty: sel.qty, amount });
  }
  return { method, lines, total: Math.round(lines.reduce((s, l) => s + l.amount * l.qty, 0) * 100) / 100 };
}

/**
 * @param {object} entry    a catalog entry (the announcement the dashboard has)
 * @param {object} menuData the served `menu` payload for that venue
 *        ({ venue_slug, name, currency, item_count, items: [...] })
 * @param {object} [opts]   { method?, selection?, order? } — local view state
 * @returns {{version:number, root:string, elements:object}}
 */
export function buildServiceSpec(entry, menuData, opts = {}) {
  const e = entry || {};
  const menu = menuData || {};
  const items = Array.isArray(menu.items) ? menu.items : [];
  const methods = servedMethods(e, menu);
  const method = methods.includes(opts.method) ? opts.method : (methods[0] ?? null);
  const currency = menu.currency || "EUR";

  const elements = {};
  // Reserve the fixed sibling ids so a generated id can never collide with one.
  const used = new Set(["badge", "facts", "method", "banner", "menu", "basket", "order", "handoff"]);
  const alloc = (base) => {
    let id = base, n = 1;
    while (used.has(id)) id = base + "_" + ++n;
    used.add(id);
    return id;
  };
  /** Emit an element, omitting empty children/props (keeps a 76-item spec small). */
  const put = (id, component, props, children) => {
    const el = { component };
    if (props && Object.keys(props).length) el.props = props;
    if (children && children.length) el.children = children;
    elements[id] = el;
    return id;
  };

  const rootChildren = [];
  const hdrChildren = [];

  const elements_hdr = alloc("hdr");
  const classes = (e.classes || []).join("/") || "(no class tag)";

  rootChildren.push(put("badge", "TrustBadge", { label: "announcement: " + classes, tone: "tier" }));
  hdrChildren.push("badge");

  const rows = [
    ["kind", String(e.kind ?? "—")],
    ["class", classes],
    ["service id", String(e.d ?? "—")],
    ["announced", e.created_at ? new Date(e.created_at * 1000).toISOString().slice(0, 10) : "—"],
  ];
  if ((e.geohashes || []).length) rows.push(["geohash", (e.geohashes || []).join(", ")]);
  rootChildren.push(put("facts", "Facts", { rows }));
  hdrChildren.push("facts");

  rootChildren.push(put("method", "MethodPicker", { methods, selected: method ?? "" }));
  hdrChildren.push("method");

  rootChildren.push(put("banner", "StateBanner", {
    tone: "stale",
    text: "Cached served menu. No payment here — checkout is on the venue's page.",
  }));
  hdrChildren.push("banner");

  // ---- the menu: one MenuItem per served item, one PriceRow for the chosen method
  const menuChildren = [];
  for (const it of items) {
    const price = method ? priceFor(it, method) : null;
    const props = { name: String(it.name ?? ""), sku: String(it.sku ?? "") };
    if (it.id) props.id = String(it.id);
    if (it.available === false) props.available = false; // served flag; absent = not asserted
    // PriceRow ids are index-keyed and short: its parent MenuItem already names
    // the served item, so repeating the sku in the child id only costs bytes.
    const children = price === null ? [] : [alloc("p" + menuChildren.length)];
    menuChildren.push(put(alloc("m" + String(it.sku)), "MenuItem", props, children));
    if (price !== null) {
      // amount is a SERVED number, copied — never computed, never stated.
      put(children[0], "PriceRow", { method, amount: price });
    }
  }
  rootChildren.push(put("menu", "MenuList", null, menuChildren));
  hdrChildren.push("menu");

  // ---- the basket (view state, priced only from served values)
  const basket = servedBasket(menu, method, opts.selection, opts.order);
  const basketChildren = [];
  for (const l of basket.lines) {
    const props = { name: String(l.name ?? ""), qty: l.qty, amount: l.amount };
    if (l.sku) props.sku = String(l.sku);
    if (l.id) props.id = String(l.id);
    basketChildren.push(put(alloc("b" + String(l.sku || l.id)), "BasketLine", props));
  }
  rootChildren.push(put("basket", "Basket", { lines: basket.lines.length, total: basket.total }, basketChildren));
  hdrChildren.push("basket");

  // ---- actions: each one only exists behind a real tool / a real published URL
  if (declaresTool(e, "order")) {
    rootChildren.push(put("order", "OrderAction", {
      label: "Build basket (order tool)",
      enabled: basket.lines.length > 0,
    }));
    hdrChildren.push("order");
  }
  if (publishedOrderUrl(e)) {
    // label only — the URL is NOT in the spec, and never will be
    rootChildren.push(put("handoff", "HandoffAction", { label: "Order on the venue's page" }));
    hdrChildren.push("handoff");
  }

  put(elements_hdr, "ServiceHeader", { title: String(e.name ?? e.d ?? "(unnamed)"), subtitle: String(e.about ?? "") }, rootChildren);
  return { version: SPEC_VERSION, root: elements_hdr, elements };
}

/**
 * The exact `order` tool input for a basket. This is the payload the renderer
 * hands to the `order.build` handler; nothing else is ever sent.
 * Lines are identified by `sku`, or by the venue's `id` when the sku is not
 * unique (the tool refuses an ambiguous sku).
 */
export function orderPayload(entry, menuData, method, selection) {
  const basket = servedBasket(menuData, method, selection);
  const items = basket.lines.map((l) => (l.sku ? { sku: l.sku, qty: l.qty } : { id: l.id, qty: l.qty }));
  return {
    venue_slug: String((menuData || {}).venue_slug || (entry || {}).d || ""),
    items,
    fulfilment: method,
    when: "asap",
  };
}

/** The `menu` tool input for a refresh. */
export function menuPayload(entry, menuData) {
  return { venue_slug: String((menuData || {}).venue_slug || (entry || {}).d || "") };
}

export default buildServiceSpec;
