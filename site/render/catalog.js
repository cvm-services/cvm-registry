/**
 * catalog.js — the component and action catalog the DASHBOARD defines.
 *
 * ADR-0005 (contextvm-services PR #22): presentation is client-side. A service is
 * rendered through a catalog the client defines; a render spec may reference that
 * catalog and nothing else. Venues never author layout and never author prices.
 *
 * Two hard rules live in this file:
 *
 *   1. A spec may only name components/actions that exist here. Anything unknown
 *      is IGNORED (fail closed) — never rendered, never best-effort guessed.
 *   2. Money-bearing props are declared with the kind `"money"`. The renderer may
 *      not paint them from the spec: every `money` value must be reproduced from
 *      served data (the `menu` payload / the `order` basket) via the oracle. The
 *      spec may *select and format* a price; it may never *state* one.
 *
 * The prop kinds below are the whole type system. There is no schema library and
 * no build step — this is a build-less vanilla ES module, by design.
 */

/** Only this spec version is rendered. Anything else is refused wholesale. */
export const SPEC_VERSION = 1;

/** Ceiling on the serialized spec. A bigger spec is refused (see renderer.js). */
export const SPEC_MAX_BYTES = 16 * 1024;

/** Tones the catalog defines. A spec may pick one; it may not invent one. */
export const TONES = ["ok", "warn", "loud", "tier", "stale", "disabled"];

/**
 * The component catalog.
 *
 * Prop kinds:
 *   text        a display string
 *   text?       optional display string (defaults to "")
 *   bool / bool?  boolean, optional defaults to false
 *   int         non-negative integer
 *   fact-rows   array of [key, value] string pairs
 *   text-list   array of strings
 *   enum:v|w    one of the listed values
 *   money       a number that MUST be reproducible from served data
 *
 * `container: true` means the element is a slot its children render into.
 */
export const COMPONENTS = {
  ServiceHeader: { props: { title: "text", subtitle: "text?" } },
  TrustBadge: { props: { label: "text", tone: "enum:" + TONES.join("|") } },
  Facts: { props: { rows: "fact-rows" } },
  MethodPicker: { props: { methods: "text-list", selected: "text" } },
  MenuList: { props: {}, container: true },
  MenuItem: { props: { name: "text", sku: "text?", id: "text?", available: "bool?" } },
  PriceRow: { props: { method: "text", amount: "money", currency: "text?" } },
  Basket: { props: { lines: "int", total: "money" }, container: true },
  BasketLine: { props: { name: "text", sku: "text?", id: "text?", qty: "int", amount: "money" } },
  OrderAction: { props: { label: "text", enabled: "bool?" } },
  HandoffAction: { props: { label: "text" } },
  StateBanner: { props: { tone: "enum:" + TONES.join("|"), text: "text" } },
};

/**
 * The action catalog. Every action maps to exactly one of:
 *   - a real CVM tool (`menu`, `order`) — the whole interaction model
 *   - a CLIENT action that deep-links to the venue's own published ordering page
 *
 * There is deliberately no payment, checkout or settlement action: the dashboard
 * must never present a payment step it cannot settle. `order` explicitly does not
 * place or settle the order — checkout happens on the venue's own rail.
 */
export const ACTIONS = {
  // tool: menu — inputSchema { venue_slug?: string }, additionalProperties false
  "menu.refresh": { kind: "cvm-tool", tool: "menu", input: "venue_slug" },
  // tool: order — { venue_slug, items:[{sku|id, qty}], fulfilment, when }
  "order.build": { kind: "cvm-tool", tool: "order", input: "basket" },
  // client action: no tool. The URL is NEVER taken from the spec.
  "order.handoff": { kind: "client", tool: null, url: "entry.links" },
};

/** A tool is only "declared" if the entry carries a cap for it (fail closed). */
export function declaredTools(entry) {
  const caps = (entry && entry.caps) || [];
  return caps.map((c) => c && c.tool).filter((t) => typeof t === "string");
}

export function declaresTool(entry, tool) {
  return declaredTools(entry).includes(tool);
}

export function isKnownComponent(name) {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(COMPONENTS, name);
}

export function isKnownAction(name) {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(ACTIONS, name);
}

export function isMoneyProp(component, prop) {
  const def = COMPONENTS[component];
  return !!(def && def.props[prop] === "money");
}

/**
 * Anything that looks like a URL is refused wherever a text prop carries it.
 * The spec is not a URL channel: the ordering link comes from the announcement
 * (served data), and the renderer never takes a URL from the spec.
 */
export function looksLikeUrl(v) {
  return typeof v === "string" && /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(v);
}

function checkOne(component, prop, kind, value) {
  const opt = kind.endsWith("?");
  const base = opt ? kind.slice(0, -1) : kind;
  if (value === undefined || value === null) return opt ? { ok: true } : { ok: false, why: `${component}.${prop} is required` };
  switch (base) {
    case "text":
      if (typeof value !== "string") return { ok: false, why: `${component}.${prop} must be a string` };
      if (looksLikeUrl(value)) return { ok: false, why: `${component}.${prop} looks like a URL; the spec is not a URL channel` };
      return { ok: true };
    case "bool":
      return typeof value === "boolean" ? { ok: true } : { ok: false, why: `${component}.${prop} must be a boolean` };
    case "int":
      return Number.isInteger(value) && value >= 0 ? { ok: true } : { ok: false, why: `${component}.${prop} must be a non-negative integer` };
    case "money":
      // Shape only. The served-value check is the oracle's job (renderer.js).
      return typeof value === "number" && Number.isFinite(value) ? { ok: true } : { ok: false, why: `${component}.${prop} must be a finite number` };
    case "text-list":
      return Array.isArray(value) && value.every((s) => typeof s === "string" && !looksLikeUrl(s))
        ? { ok: true }
        : { ok: false, why: `${component}.${prop} must be an array of strings` };
    case "fact-rows": {
      if (!Array.isArray(value)) return { ok: false, why: `${component}.${prop} must be [[key, value], ...] string pairs` };
      for (const r of value) {
        if (!Array.isArray(r) || r.length !== 2 || typeof r[0] !== "string" || typeof r[1] !== "string") {
          return { ok: false, why: `${component}.${prop} rows must be [key, value] string pairs` };
        }
        if (looksLikeUrl(r[1]) || looksLikeUrl(r[0])) {
          return { ok: false, why: `${component}.${prop} value looks like a URL; the spec is not a URL channel` };
        }
      }
      return { ok: true };
    }
    default:
      if (base.startsWith("enum:")) {
        const allowed = base.slice(5).split("|");
        return allowed.includes(value) ? { ok: true } : { ok: false, why: `${component}.${prop} must be one of ${allowed.join("/")}` };
      }
      return { ok: false, why: `${component}.${prop} has unknown prop kind ${kind}` };
  }
}

/**
 * Validate one element's props against the catalog. Purely shape/type: money is
 * OK'd on shape here and re-checked against served data by the renderer.
 * Returns { ok, unknownProps:[], errors:[] }.
 */
export function validateProps(component, props) {
  const def = COMPONENTS[component];
  if (!def) return { ok: false, unknownProps: [], errors: [`unknown component ${component}`] };
  const p = props || {};
  const unknownProps = Object.keys(p).filter((k) => !Object.prototype.hasOwnProperty.call(def.props, k));
  const errors = [];
  for (const [prop, kind] of Object.entries(def.props)) {
    const r = checkOne(component, prop, kind, p[prop]);
    if (!r.ok) errors.push(r.why);
  }
  // An unknown prop is an unknown instruction: refuse the whole element.
  for (const k of unknownProps) errors.push(`${component} has unknown prop ${k}`);
  return { ok: errors.length === 0, unknownProps, errors };
}

/** The prop kinds a component declares — used by the spec builder and the tests. */
export function componentProps(component) {
  return COMPONENTS[component] ? Object.keys(COMPONENTS[component].props) : null;
}

export const CATALOG = { SPEC_VERSION, SPEC_MAX_BYTES, TONES, COMPONENTS, ACTIONS };
export default CATALOG;
