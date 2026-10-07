/**
 * render-spec test suite — the data-level half of the phase-0 spike.
 *
 * Proves, against the REAL capture in `site/fixtures/doppelt.catalog.json`
 * (no network; every value in that file came off the live venue CVM server):
 *
 *   1. `buildServiceSpec` is a PURE function of served data (byte-identical on
 *      repeat, and it reads nothing but its arguments).
 *   2. a 76-item venue's spec fits the renderer's 16 KiB cap.
 *   3. the spec carries one MenuItem and one PriceRow per served item, and every
 *      price in it IS a served price — and a walker that checks this detects a
 *      hand-injected price (the oracle the renderer uses, at the data level).
 *   4. the spec contains no URL at all: the ordering link is announced data, and
 *      the renderer refuses URLs in a spec.
 *   5. an action only exists when its tool/URL really does: strip the `order`
 *      cap and the OrderAction disappears; strip the links and the HandoffAction
 *      disappears.
 *   6. the `order` payload identifies items the way the tool requires (sku, or
 *      the venue `id` where a sku is not unique) and reproduces the venue's own
 *      served basket total.
 *
 * Run: deno test --allow-read
 */
import { buildServiceSpec, orderPayload, publishedOrderUrl, servedBasket, servedMethods } from "../site/render/spec.js";
import { ACTIONS, COMPONENTS, SPEC_MAX_BYTES, SPEC_VERSION, declaresTool } from "../site/render/catalog.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + msg);
}
function assertEquals<T>(actual: T, expected: T, msg = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`ASSERT (${msg}): got ${a}, want ${b}`);
}

const FIXTURE_URL = new URL("../site/fixtures/doppelt.catalog.json", import.meta.url);
const fixture: any = JSON.parse(await Deno.readTextFile(FIXTURE_URL));
const entry = fixture.entry;
const menu = fixture.menu;
const ITEM_COUNT = menu.items.length;

const SPEC_SOURCE = new URL("../site/render/spec.js", import.meta.url);
const CATALOG_SOURCE = new URL("../site/render/catalog.js", import.meta.url);
const RENDERER_SOURCE = new URL("../site/render/renderer.js", import.meta.url);

/** The oracle the renderer implements, expressed over a spec: every money prop
 * must equal the value the served data carries for it. Returns the violations. */
function priceViolations(spec: any): string[] {
  const bySku = new Map<string, any>(menu.items.map((i: any) => [String(i.sku), i]));
  const problems: string[] = [];
  for (const [id, el] of Object.entries<any>(spec.elements)) {
    if (el.component === "PriceRow") {
      // find the parent MenuItem by scanning for it as a child
      const parent = Object.entries<any>(spec.elements).find(([, p]) => (p.children || []).includes(id));
      if (!parent) { problems.push(`${id}: PriceRow has no parent`); continue; }
      const item = bySku.get(String(parent[1].props.sku));
      if (!item) { problems.push(`${id}: parent names no served item`); continue; }
      const served = item.prices_by_order_method[el.props.method];
      if (served !== el.props.amount) problems.push(`${id}: ${el.props.amount} != served ${served}`);
    }
    if (el.component === "Basket") {
      const served = servedBasket(menu, entry.declared.fulfilment.methods[0], []);
      if (el.props.lines !== served.lines.length) problems.push(`${id}: basket lines mismatch`);
    }
  }
  return problems;
}

Deno.test("the fixture is a real capture, not invented data", () => {
  const p = fixture._provenance;
  assert(p && p.menu && p.catalog && p.tools, "provenance block is present");
  assertEquals(p.menu.step.includes("tools/call `menu`"), true, "menu provenance names the real step");
  assertEquals(menu.venue_slug, "doppelt-kaese-berlin", "venue slug");
  assertEquals(ITEM_COUNT, 76, "76 served items");
  assertEquals(menu.item_count, ITEM_COUNT, "item_count agrees with items[]");
  assertEquals(new Set(menu.items.map((i: any) => i.sku)).size, ITEM_COUNT, "every item has its own sku");
  for (const it of menu.items) {
    assert(typeof it.name === "string" && it.name.length > 0, "item has a name");
    assert(typeof it.prices_by_order_method === "object", "item carries served prices");
  }
  assertEquals(fixture.tools.map((t: any) => t.name).sort(), ["menu", "order"], "the served tools/list");
});

Deno.test("the catalog keeps the spec surface to what the brief defines", () => {
  assertEquals(Object.keys(COMPONENTS).sort(), [
    "Basket", "BasketLine", "Facts", "HandoffAction", "MenuItem", "MenuList",
    "MethodPicker", "OrderAction", "PriceRow", "ServiceHeader", "StateBanner", "TrustBadge",
  ], "the 12 components");
  assertEquals(Object.keys(ACTIONS).sort(), ["menu.refresh", "order.build", "order.handoff"], "the 3 actions");
  assertEquals(ACTIONS["menu.refresh"].tool, "menu", "menu.refresh maps to the menu tool");
  assertEquals(ACTIONS["order.build"].tool, "order", "order.build maps to the order tool");
  assertEquals(ACTIONS["order.handoff"].tool, null, "order.handoff is a client action with no tool");
  assertEquals(ACTIONS["order.handoff"].kind, "client", "order.handoff is client-side");
  assertEquals(SPEC_VERSION, 1, "spec version 1");
  assertEquals(SPEC_MAX_BYTES, 16384, "16 KiB cap");
});

Deno.test("buildServiceSpec is a pure function of served data", () => {
  const a = JSON.stringify(buildServiceSpec(entry, menu));
  const b = JSON.stringify(buildServiceSpec(JSON.parse(JSON.stringify(entry)), JSON.parse(JSON.stringify(menu))));
  assertEquals(a, b, "repeat call is byte-identical");
  const source = Deno.readTextFileSync(SPEC_SOURCE);
  for (const forbidden of ["document.", "window.", "fetch(", "Date.now", "Math.random", "innerHTML"]) {
    assertEquals(source.includes(forbidden), false, `spec.js must not use ${forbidden}`);
  }
});

Deno.test("the doppelt spec fits the renderer's size cap", () => {
  const spec: any = buildServiceSpec(entry, menu);
  const bytes = new TextEncoder().encode(JSON.stringify(spec)).length;
  assert(bytes <= SPEC_MAX_BYTES, `${bytes} bytes must be within the ${SPEC_MAX_BYTES}-byte cap`);
  assert(bytes > 0, "spec is not empty");
});

Deno.test("one MenuItem and one PriceRow per served item, and the count matches the fixture", () => {
  const spec: any = buildServiceSpec(entry, menu);
  const items = Object.values<any>(spec.elements).filter((e) => e.component === "MenuItem");
  const prices = Object.values<any>(spec.elements).filter((e) => e.component === "PriceRow");
  assertEquals(items.length, ITEM_COUNT, "MenuItems == fixture item count");
  assertEquals(prices.length, ITEM_COUNT, "PriceRows == fixture item count");
  const menuElement: any = spec.elements.menu;
  assertEquals(menuElement.children.length, ITEM_COUNT, "MenuList children == fixture item count");
  // every MenuItem names a served sku, and its price child is the selected method
  const servedSkus = new Set(menu.items.map((i: any) => String(i.sku)));
  const methods = servedMethods(entry, menu);
  for (const el of items) {
    assert(servedSkus.has(String(el.props.sku)), `${el.props.sku} is a served sku`);
    assertEquals(el.children.length, 1, "exactly one price child");
    assertEquals(spec.elements[el.children[0]].props.method, methods[0], "price is for the selected method");
  }
});

Deno.test("every price in the spec IS a served price — and an injected one is detected", () => {
  const spec: any = buildServiceSpec(entry, menu);
  assertEquals(priceViolations(spec), [], "the built spec carries only served prices");

  // the venue serves 8.9 for 331227/pickup; a spec that states something else is
  // exactly what the renderer's moneyCheck refuses.
  const injected = JSON.parse(JSON.stringify(spec));
  const firstPrice = Object.keys(injected.elements).find((k) => injected.elements[k].component === "PriceRow")!;
  injected.elements[firstPrice].props.amount = 999;
  const problems = priceViolations(injected);
  assert(problems.length === 1, `the injected price is detected, got ${JSON.stringify(problems)}`);
  assert(problems[0].includes("999"), "the violation names the injected value");

  // and the served basket total is the venue's own: the demo selection is the
  // one the live capture recorded (2 x 331227 + 1 x 331233 = 22.3, pickup).
  const basket = servedBasket(menu, "pickup", [{ sku: "331227", qty: 2 }, { sku: "331233", qty: 1 }]);
  assertEquals(basket.total, fixture.order_response.total, "recomputed total == the venue's served total");
  assertEquals(basket.lines[0].amount, fixture.order_response.lines[0].unit_price, "line price is the served one");
});

Deno.test("the spec contains no URL at all", () => {
  const spec: any = buildServiceSpec(entry, menu);
  const text = JSON.stringify(spec);
  assertEquals(/https?:/.test(text), false, "no http(s) URL anywhere in the spec");
  assertEquals(/\/\//.test(text), false, "no protocol-relative URL either");
  // the URL exists — but in the announcement, which is served data, not the spec
  assert(typeof publishedOrderUrl(entry) === "string", "the announcement does publish one");
});

Deno.test("OrderAction needs the declared tool; HandoffAction needs the published URL", () => {
  const withOrder: any = buildServiceSpec(entry, menu);
  assert("order" in withOrder.elements, "the real entry declares `order`, so the action is in the spec");
  assert("handoff" in withOrder.elements, "the real entry publishes a link, so the handoff is in the spec");

  const noCaps: any = buildServiceSpec({ ...entry, caps: [] }, menu);
  assertEquals("order" in noCaps.elements, false, "no declared tool -> no OrderAction in the spec");
  assert(declaresTool({ ...entry, caps: [] }, "order") === false, "declaresTool agrees");

  const noLinks: any = buildServiceSpec({ ...entry, links: [] }, menu);
  assertEquals("handoff" in noLinks.elements, false, "no published URL -> no HandoffAction in the spec");
  assertEquals(declaresTool(entry, "order"), true, "the real entry does declare `order`");

  // a menu tool alone never produces an order button
  const menuOnly: any = buildServiceSpec({ ...entry, caps: [{ tool: "menu", amount: 0, unit: "sats" }] }, menu);
  assertEquals("order" in menuOnly.elements, false, "`menu` is not `order`");
});

Deno.test("the order payload identifies items the way the tool requires", () => {
  const payload = orderPayload(entry, menu, "pickup", [{ sku: "331227", qty: 2 }, { sku: "331233", qty: 1 }]);
  assertEquals(payload.venue_slug, "doppelt-kaese-berlin", "venue slug is carried");
  assertEquals(payload.fulfilment, "pickup", "the selected method is the fulfilment");
  assertEquals(payload.items, [{ sku: "331227", qty: 2 }, { sku: "331233", qty: 1 }], "lines are sku+qty");
  // the real capture used exactly this shape for its own call
  assertEquals(fixture.order_request.items, payload.items, "the same shape the live `order` call used");
  // an unknown sku never becomes a line
  const junk = orderPayload(entry, menu, "pickup", [{ sku: "999999", qty: 1 }]);
  assertEquals(junk.items, [], "an unserved sku produces no line");
});

/** Strip comments so a check on "does the code use X" is about the code, not prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

Deno.test("the renderer's own source keeps the hard rules (static)", () => {
  const renderer = stripComments(Deno.readTextFileSync(RENDERER_SOURCE));
  const catalog = stripComments(Deno.readTextFileSync(CATALOG_SOURCE));
  for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "eval(", "new Function", "document.write", "javascript:"]) {
    assertEquals(renderer.includes(forbidden), false, `renderer.js must not use ${forbidden}`);
  }
  for (const forbidden of ["innerHTML", "createElement", "document.", "window."]) {
    assertEquals(catalog.includes(forbidden), false, `catalog.js must not touch the DOM (${forbidden})`);
  }
  // money is a declared prop kind, so the renderer can never treat it as text
  assert(catalog.includes('"money"'), "the catalog declares a money prop kind");
  assert(renderer.includes("moneyCheck"), "the renderer has a served-price check");
  assert(renderer.includes("SPEC_MAX_BYTES"), "the renderer enforces the size cap");
});
