/**
 * renderer.js — the vanilla renderer for a catalog-constrained render spec.
 *
 * It is small on purpose. What it will not do is the point of the spike:
 *
 *   - unknown component  -> the element renders nothing (fail closed)
 *   - unknown action     -> the action is refused, never dispatched
 *   - spec.version != 1  -> the whole spec is refused
 *   - spec > 16 KiB      -> the whole spec is refused
 *   - a `money` prop the served data does not back -> the element is refused,
 *     and the refusal is recorded. Money is never painted from the spec.
 *   - any URL in the spec -> the element is refused; the ordering URL comes from
 *     the trusted context (the announcement), never from the spec
 *   - DOM is built with createElement/textContent/setAttribute only. There is no
 *     innerHTML, no eval, no script, no fetch, and no payment UI anywhere.
 *
 * `createRenderer()` returns an instance that records every dispatched action.
 * A click therefore yields an inspectable payload with no navigation — which is
 * exactly what the headless test asserts against.
 */

import {
  ACTIONS,
  SPEC_VERSION,
  SPEC_MAX_BYTES,
  isKnownAction,
  isKnownComponent,
  validateProps,
} from "./catalog.js";

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const encoder = new TextEncoder();

export function byteLength(s) {
  return encoder.encode(s).length;
}

/** Trusted, served context. NOTHING here may come from the spec. */
function normalizeCtx(raw = {}) {
  const menu = raw.menu || { items: [] };
  const items = Array.isArray(menu.items) ? menu.items : [];
  const bySku = new Map();
  for (const it of items) {
    if (it && it.sku) bySku.set(String(it.sku), it);
    if (it && it.id) bySku.set(String(it.id), it);
  }
  const tools = Array.isArray(raw.tools) ? raw.tools.slice() : [];
  const declaresOrder = raw.declaresOrder === true;
  const orderUrl = typeof raw.orderUrl === "string" && /^https?:\/\/[^\s]+$/i.test(raw.orderUrl) ? raw.orderUrl : null;
  const basket = raw.basket && Array.isArray(raw.basket.lines) ? raw.basket : { lines: [], total: 0 };
  return {
    venueSlug: String(raw.venueSlug || menu.venue_slug || ""),
    menu,
    currency: menu.currency || "EUR",
    bySku,
    // the method the venue actually serves *and* prices — validated against served data
    methods: Array.isArray(raw.methods) ? raw.methods : [],
    method: raw.method ?? null,
    tools,
    declaresOrder,
    // An OrderAction must sit on a tool that BOTH the announcement declares and
    // the served tools/list confirms. Either one missing -> no button.
    orderTool: declaresOrder && tools.includes("order"),
    orderUrl,
    selection: Array.isArray(raw.selection) ? raw.selection : [],
    basket,
    onSelectMethod: typeof raw.onSelectMethod === "function" ? raw.onSelectMethod : null,
    onAddToBasket: typeof raw.onAddToBasket === "function" ? raw.onAddToBasket : null,
    onHandoff: typeof raw.onHandoff === "function" ? raw.onHandoff : null,
    orderPayload: typeof raw.orderPayload === "function" ? raw.orderPayload : null,
  };
}

function servedPrice(ctx, item, method) {
  const p = ((item || {}).prices_by_order_method || {})[method];
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

export function createRenderer(opts = {}) {
  const handlers = Object.assign(Object.create(null), opts.handlers || {});
  const refusals = [];
  const captures = [];
  let ctxCurrent = null;

  function refuse(id, component, why) {
    refusals.push({ id, component, why });
  }

  /**
   * Dispatch one named action. Unknown actions are refused (fail closed) and are
   * never handed to a handler. A tool-backed action is refused unless the served
   * tool list carries that tool.
   */
  function dispatch(name, payload, ctx = ctxCurrent) {
    const def = ACTIONS[name];
    if (!isKnownAction(name)) {
      refuse(null, "action:" + name, "unknown action (fail closed)");
      return false;
    }
    if (def.kind === "cvm-tool" && !(ctx && ctx.tools.includes(def.tool))) {
      refuse(null, "action:" + name, `the served tool list does not carry \`${def.tool}\`.`);
      return false;
    }
    const record = { action: name, tool: def.tool, payload: payload ?? null };
    captures.push(record);
    const h = handlers[name];
    if (typeof h === "function") h(record.payload, ctx);
    return true;
  }

  /**
   * Validate a money prop against served data. `ctx` supplies the served values.
   * Returns null when OK, or a reason string when the spec stated a price the
   * venue did not serve.
   */
  function moneyCheck(el, props, parent, ctx) {
    switch (el.component) {
      case "PriceRow": {
        if (!parent || parent.component !== "MenuItem") {
          return "PriceRow must sit inside a MenuItem (no served item to source a price from)";
        }
        const key = parent.props.sku || parent.props.id;
        const item = key ? ctx.bySku.get(String(key)) : null;
        if (!item) return "PriceRow parent names no served item";
        const served = servedPrice(ctx, item, props.method);
        if (served === null) return `no served price for ${key}/${props.method}`;
        if (served !== props.amount) return `stated price ${props.amount} for ${key}/${props.method} but the venue serves ${served}`;
        if (props.currency !== undefined && props.currency !== ctx.currency) {
          return `stated currency ${props.currency} but the venue serves ${ctx.currency}`;
        }
        return null;
      }
      case "BasketLine": {
        const key = String(props.sku || props.id || "");
        const line = ctx.basket.lines.find((l) => String(l.sku || l.id) === key);
        if (!line) return "BasketLine names no served basket line";
        if (line.name !== props.name) return `BasketLine name ${props.name} != served ${line.name}`;
        if (line.qty !== props.qty) return `BasketLine qty ${props.qty} != served ${line.qty}`;
        const item = ctx.bySku.get(key);
        const served = item ? servedPrice(ctx, item, ctx.basket.method) : null;
        if (served !== null && served !== props.amount) return `BasketLine amount ${props.amount} != served ${served}`;
        if (line.amount !== props.amount) return `BasketLine amount ${props.amount} != served ${line.amount}`;
        return null;
      }
      case "Basket": {
        if (props.lines !== ctx.basket.lines.length) return `Basket lines ${props.lines} != served ${ctx.basket.lines.length}`;
        const derivable = ctx.basket.lines.reduce((s, l) => s + (typeof l.amount === "number" ? l.amount * l.qty : 0), 0);
        const printed = Math.round(derivable * 100) / 100;
        if (props.total !== printed) return `Basket total ${props.total} is not reproducible from served prices (${printed})`;
        if (ctx.basket.lines.length && typeof ctx.basket.total === "number" && Math.round(ctx.basket.total * 100) / 100 !== printed) {
          return "the served basket total disagrees with its own served line prices";
        }
        return null;
      }
      default:
        return null;
    }
  }

  /** Extra, non-money gates. Same contract: null = OK, string = refuse. */
  function gate(el, props, ctx) {
    switch (el.component) {
      case "MenuItem": {
        const key = String(props.sku || props.id || "");
        const item = key ? ctx.bySku.get(key) : null;
        if (!item) return "MenuItem names no served item";
        const servedAvail = item.available !== false;
        if (props.available !== undefined && props.available !== servedAvail) {
          return `availability ${props.available} disagrees with served ${servedAvail}`;
        }
        return null;
      }
      case "MethodPicker": {
        for (const m of props.methods) if (!ctx.methods.includes(m)) return `method ${m} is not served`;
        if (!props.methods.includes(props.selected)) return `selected method ${props.selected} is not offered`;
        return null;
      }
      case "OrderAction":
        // A button with no tool behind it is a failure. Two independent gates.
        if (!ctx.declaresOrder) return "the announcement declares no `order` tool";
        if (!ctx.tools.includes("order")) return "the served tool list does not carry `order`";
        return null;
      case "HandoffAction":
        // The URL is never taken from the spec; it must exist in the trustworthy
        // context (the announcement's published `r` link).
        if (!ctx.orderUrl) return "no published ordering URL to hand off to";
        return null;
      default:
        return null;
    }
  }

  function textEl(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  /** Build a component's own content (its children are appended by the caller). */
  function contentFor(el, props, ctx) {
    const box = document.createElement("div");
    switch (el.component) {
      case "ServiceHeader": {
        box.append(textEl("h3", "spec-title", props.title));
        if (props.subtitle) box.append(textEl("p", "spec-sub", props.subtitle));
        return box;
      }
      case "TrustBadge": {
        box.append(textEl("span", "badge spec-badge " + props.tone, props.label));
        return box;
      }
      case "Facts": {
        const ul = textEl("ul", "facts");
        for (const [k, v] of props.rows) {
          const li = document.createElement("li");
          li.append(textEl("span", "k", k));
          li.append(document.createTextNode(" " + v));
          ul.append(li);
        }
        box.append(ul);
        return box;
      }
      case "MethodPicker": {
        const group = textEl("div", "control-group");
        group.append(textEl("span", "label", "Order method:"));
        for (const m of props.methods) {
          const b = textEl("button", "chip" + (m === props.selected ? " on" : ""), m);
          b.type = "button";
          b.dataset.method = m;
          b.disabled = !ctx.onSelectMethod;
          b.onclick = () => { if (ctx.onSelectMethod) ctx.onSelectMethod(m); };
          group.append(b);
        }
        box.append(group);
        return box;
      }
      case "MenuItem": {
        const row = textEl("div", "menu-item");
        row.append(textEl("span", "mi-name", props.name));
        if (props.available === false) row.append(textEl("span", "badge warn mi-avail", "unavailable"));
        const add = textEl("button", "chip add", "add to basket");
        add.type = "button";
        add.dataset.sku = props.sku || props.id || "";
        add.disabled = props.available === false;
        add.onclick = () => {
          const sel = ctx.selection.map((s) => ({ sku: s.sku, qty: s.qty }));
          const key = props.sku || props.id;
          const hit = sel.find((s) => s.sku === key);
          if (hit) hit.qty += 1; else if (key) sel.push({ sku: key, qty: 1 });
          const payload = ctx.orderPayload ? ctx.orderPayload(sel) : null;
          dispatch("order.build", payload, ctx);
          // The host gets the resulting selection, so it re-renders the basket
          // without double-counting the click it just handled.
          if (ctx.onAddToBasket) ctx.onAddToBasket(sel);
        };
        row.append(add);
        return row;
      }
      case "PriceRow": {
        // amount is a SERVED number, already cross-checked in moneyCheck().
        box.append(textEl("span", "price", `${props.amount} ${props.currency ?? ctx.currency}`.trim()));
        return box;
      }
      case "Basket": {
        box.append(textEl("h4", null, `Basket (${props.lines}) — total ${props.total} ${ctx.currency}`));
        const note = textEl("p", "fineprint", "Basket only. No payment step exists here: checkout and settlement happen on the venue's own page.");
        box.append(note);
        return box;
      }
      case "BasketLine": {
        const row = textEl("div", "basket-line");
        row.append(textEl("span", "bl-name", `${props.qty} × ${props.name}`));
        row.append(textEl("span", "bl-price", `${props.amount} ${ctx.currency}`.trim()));
        box.append(row);
        return box;
      }
      case "OrderAction": {
        const b = textEl("button", "chip action order", props.label);
        b.type = "button";
        b.disabled = props.enabled === false;
        b.onclick = () => {
          const payload = ctx.orderPayload ? ctx.orderPayload(ctx.selection) : null;
          dispatch("order.build", payload, ctx);
        };
        box.append(b);
        return box;
      }
      case "HandoffAction": {
        const b = textEl("button", "chip action handoff", props.label);
        b.type = "button";
        b.onclick = () => {
          dispatch("order.handoff", null, ctx);
          if (ctx.onHandoff) ctx.onHandoff(ctx.orderUrl);
        };
        box.append(b);
        return box;
      }
      case "StateBanner": {
        box.append(textEl("p", "banner spec-banner " + props.tone, props.text));
        return box;
      }
      default:
        return box;
    }
  }

  /**
   * Walk the spec and build DOM. Returns null for anything refused.
   * `state.visited` is the cycle guard: a spec that points at itself terminates.
   */
  function buildElement(id, spec, ctx, state, parent) {
    if (!ID_RE.test(id)) { refuse(id, "(bad id)", "element id is not a safe identifier"); return null; }
    if (state.visited.has(id)) { refuse(id, "(cycle)", "cycle or repeat reference"); return null; }
    state.visited.add(id);
    const el = spec.elements[id];
    if (!el || typeof el !== "object") { refuse(id, "(missing)", "element is missing from spec.elements"); return null; }
    const component = el.component;
    if (!isKnownComponent(component)) {
      refuse(id, String(component), "unknown component (fail closed)");
      return null;
    }
    const props = el.props || {};
    const shape = validateProps(component, props);
    if (!shape.ok) { refuse(id, component, shape.errors.join("; ")); return null; }
    const bad = moneyCheck(el, props, parent, ctx);
    if (bad) { refuse(id, component, bad); return null; }
    const g = gate(el, props, ctx);
    if (g) { refuse(id, component, g); return null; }

    const node = document.createElement("div");
    node.className = "spec-el c-" + component;
    node.dataset.elId = id;
    node.dataset.component = component;
    node.append(contentFor(el, props, ctx));
    const kids = Array.isArray(el.children) ? el.children : [];
    if (kids.length) {
      const slot = textEl("div", "spec-children");
      for (const kid of kids) {
        if (typeof kid !== "string") { refuse(id, component, "child reference is not a string id"); continue; }
        const kidNode = buildElement(kid, spec, ctx, state, { component, props });
        if (kidNode) slot.append(kidNode);
      }
      node.append(slot);
    }
    state.visited.delete(id); // a shared child may be referenced from two parents
    return node;
  }

  /**
   * Render a spec into `host`. Returns a verdict:
   *   { ok, bytes, refusedWholesale|null, refusals, captured }
   */
  function render(spec, host, rawCtx = {}) {
    refusals.length = 0;
    captures.length = 0;
    const ctx = normalizeCtx(rawCtx);
    ctxCurrent = ctx;
    host.textContent = "";
    const fail = (reason) => {
      refuse(null, "(spec)", reason);
      return { ok: false, bytes: bytesOf, refusedWholesale: reason, refusals: refusals.slice(), captured: captures.slice() };
    };
    let bytesOf = 0;
    if (!spec || typeof spec !== "object") return fail("spec is not an object");
    if (spec.version !== SPEC_VERSION) return fail(`spec.version ${JSON.stringify(spec.version)} is not ${SPEC_VERSION}`);
    if (!spec.elements || typeof spec.elements !== "object") return fail("spec.elements is missing");
    if (typeof spec.root !== "string") return fail("spec.root is missing");
    let serialized;
    try { serialized = JSON.stringify(spec); } catch { return fail("spec is not serializable"); }
    bytesOf = byteLength(serialized);
    if (bytesOf > SPEC_MAX_BYTES) return fail(`spec is ${bytesOf} bytes, over the ${SPEC_MAX_BYTES}-byte cap`);
    const node = buildElement(spec.root, spec, ctx, { visited: new Set() }, null);
    if (!node) return { ok: false, bytes: bytesOf, refusedWholesale: null, refusals: refusals.slice(), captured: captures.slice() };
    host.append(node);
    return { ok: true, bytes: bytesOf, refusedWholesale: null, refusals: refusals.slice(), captured: captures.slice() };
  }

  return {
    render,
    dispatch,
    handlers,
    refusals: () => refusals.slice(),
    captured: () => captures.slice(),
    last: (name) => [...captures].reverse().find((c) => !name || c.action === name) || null,
    /** Test seam: capture an `order.build` payload without any navigation. */
    captureOrderBuild: () => (captures.find((c) => c.action === "order.build") || {}).payload ?? null,
    SPEC_MAX_BYTES,
  };
}

export default createRenderer;
