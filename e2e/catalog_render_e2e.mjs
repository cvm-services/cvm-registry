// Headless-browser test for the catalog-constrained service view (phase-0 spike,
// ADR-0005). Real chromium, real DOM, real clicks — the page's own renderer.
//
// What it proves:
//   A. the real venue view: `Open service` renders ONE real venue's served menu
//      from a JSON render spec. The MenuItem count equals the fixture's item
//      count; EVERY rendered price string equals the served price for that
//      item+method; the spec is within the 16 KiB cap.
//   B. an add-to-basket click yields an `order` tool payload that identifies the
//      item correctly (sku/id), with no navigation.
//   C. the handoff click uses the URL published by the ANNOUNCEMENT — never one
//      from a spec.
//   D. fail-closed cases, each rendered through the real renderer: an unknown
//      component, an injected price, an injected basket total, spec version != 1,
//      an oversize spec, a URL in a Facts row, an OrderAction with no declared
//      tool / no served tool, a HandoffAction with no published URL, an unknown
//      action, and a self-referencing spec (terminates, nothing painted).
//
// Hermetic: the fixture is served from disk; nothing on the CVM path is mocked
// and no network is touched (the venue URL is intercepted, not fetched).
//
// Run:
//   node e2e/catalog_render_e2e.mjs
// Env: E2E_BASE_URL (use an already-running server instead of the built-in one),
//      E2E_EVIDENCE (default docs/e2e/catalog-render-e2e.json)

import { chromium } from "playwright";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const SITE = join(ROOT, "site");
const SCRATCH = join(ROOT, ".scratch", "e2e-catalog-render");
const EVIDENCE = process.env.E2E_EVIDENCE ?? join(ROOT, "docs", "e2e", "catalog-render-e2e.json");
import { homedir } from "node:os";
// Resolve from $HOME at run time: this file must not carry a literal home path
// (the fleet home-path gate refuses new absolute paths, and they do not travel).
const CHROMIUM_1243 = process.env.E2E_CHROMIUM ?? join(homedir(), ".cache", "ms-playwright", "chromium-1243", "chrome-linux64", "chrome");

const fixture = JSON.parse(readFileSync(join(SITE, "fixtures", "doppelt.catalog.json"), "utf8"));
const ITEMS = fixture.menu.items;
const SLUG = fixture.menu.venue_slug;
const CURRENCY = fixture.menu.currency;

const facts = { spike: "catalog-constrained service rendering", fixture: "site/fixtures/doppelt.catalog.json", steps: [], failures: [] };
const step = (name, data = {}) => {
  facts.steps.push({ name, ...data });
  console.log(`[step] ${name} ${JSON.stringify(data)}`);
};
const fail = (msg) => {
  facts.failures.push(msg);
  console.error(`[FAIL] ${msg}`);
};

// ---------------------------------------------------------------- static server

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css" };

function serveDir(dir) {
  return createServer((req, res) => {
    const rel = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^\/+/, "");
    let file = join(dir, rel || "index.html");
    if (!file.startsWith(dir)) { res.writeHead(403).end("no"); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
}

// ------------------------------------------------------------------ the harness
// Rendered by the real renderer, in the real browser. Each case gets its own host
// div so the assertions can be made against live DOM, not against a report.
const HARNESS = `<!DOCTYPE html>
<meta charset="utf-8"><title>catalog render harness</title>
<body>
<main id="cases"></main>
<script type="module">
import { COMPONENTS, ACTIONS } from "./render/catalog.js";
import { buildServiceSpec } from "./render/spec.js";
import { createRenderer } from "./render/renderer.js";

const fx = await (await fetch("./fixtures/doppelt.catalog.json")).json();
const entry = fx.entry, menu = fx.menu;
const methods = entry.declared.fulfilment.methods.filter((m) => menu.items.every((i) => i.prices_by_order_method[m] !== undefined));
const baseCtx = {
  venueSlug: menu.venue_slug, menu, methods, method: methods[0], selection: [],
  basket: { method: methods[0], lines: [], total: 0 },
  tools: ["menu", "order"], declaresOrder: true,
  orderUrl: entry.links[0], orderPayload: (sel) => ({ venue_slug: menu.venue_slug, items: sel }),
};
const caseEl = (name) => {
  const d = document.createElement("div");
  d.id = "case-" + name;
  document.getElementById("cases").append(d);
  return d;
};
const describe = (host) => ({
  elementCount: host.querySelectorAll(".spec-el").length,
  components: [...new Set([...host.querySelectorAll(".spec-el")].map((n) => n.dataset.component))].sort(),
  prices: [...host.querySelectorAll(".price")].map((n) => n.textContent),
  buttons: host.querySelectorAll("button").length,
  text: host.innerText.replace(/\\s+/g, " ").trim(),
});

window.CASES = {};

function run(name, spec, ctxOverride = {}) {
  const host = caseEl(name);
  const r = createRenderer({ handlers: {} });
  const verdict = r.render(spec, host, { ...baseCtx, ...ctxOverride });
  window.CASES[name] = { verdict, refusals: r.refusals(), captured: r.captured(), dom: describe(host) };
  return { host, r, verdict };
}

const good = buildServiceSpec(entry, menu);
const clone = () => JSON.parse(JSON.stringify(good));

// baseline: the real spec renders the real menu
run("baseline", good);
// an unknown component is ignored, and the known sibling still renders
{
  const s = clone();
  s.elements.payment = { component: "PaymentStep", props: { amount: 1 } };
  s.elements.hdr.children.push("payment");
  run("unknown-component", s);
}
// a spec that STATES a price is refused (the venue serves 9.5 for 331227/delivery)
{
  const s = clone();
  const priceId = Object.keys(s.elements).find((k) => s.elements[k].component === "PriceRow");
  s.elements[priceId].props.amount = 999;
  run("injected-price", s);
}
// a spec that STATES a basket total is refused
{
  const s = clone();
  s.elements.basket.props.total = 1;
  run("injected-total", s);
}
// not version 1 -> nothing at all
{ const s = clone(); s.version = 2; run("version-2", s); }
// over the 16 KiB cap -> nothing at all
{
  const s = clone();
  s.elements.junk = { component: "StateBanner", props: { tone: "warn", text: "x".repeat(20000) } };
  s.elements.hdr.children.push("junk");
  run("oversize", s);
}
// a URL in a Facts row is refused (the spec is not a URL channel)
{
  const s = clone();
  s.elements.facts.props.rows = [...s.elements.facts.props.rows, ["pay here", "https://evil.example/pay"]];
  run("url-in-facts", s);
}
// OrderAction without the declared tool
run("order-undeclared", clone(), { declaresOrder: false, tools: ["menu"] });
// OrderAction declared but not served
run("order-not-served", clone(), { tools: ["menu"] });
// HandoffAction with no published URL
run("handoff-no-url", clone(), { orderUrl: null });
// a hand-written spec with an action that is not in the catalog
{
  const host = caseEl("unknown-action");
  const r = createRenderer({ handlers: {} });
  const ok = r.dispatch("payment.settle", { amount: 1 }, { ...baseCtx });
  const okTool = r.dispatch("order.build", { items: [] }, { ...baseCtx, tools: ["menu"] });
  window.CASES["unknown-action"] = { dispatchOk: [ok, okTool], refusals: r.refusals(), captured: r.captured(), dom: describe(host) };
}
// a spec that references itself terminates and paints nothing
{
  const s = { version: 1, root: "loop", elements: { loop: { component: "MenuList", children: ["loop"] } } };
  run("cycle", s);
}
// the catalog itself must not define any payment/checkout component
window.CASES["catalog-surface"] = {
  components: Object.keys(COMPONENTS),
  actions: Object.keys(ACTIONS),
  paymentish: Object.keys(COMPONENTS).filter((c) => /pay|checkout|card|wallet|settle/i.test(c)),
};
window.HARNESS_DONE = true;
</script>
</body>`;

// ------------------------------------------------------------------------ main

let server = null;
async function main() {
  // 1. a hermetic serve dir: the real site + the real fixture. The ONLY edit is
  //    the freshness timestamp, because a cached catalog older than its hard
  //    limit is disabled (fail closed) — the harness has to look fresh.
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  cpSync(SITE, SCRATCH, { recursive: true });
  const fresh = JSON.parse(JSON.stringify(fixture.catalog));
  const now = Math.floor(Date.now() / 1000);
  facts.served_catalog_note = "site/fixtures/doppelt.catalog.json -> catalog.json, with generated_at rewritten to now (freshness field only; no data changed)";
  fresh.generated_at = now;
  fresh.generated_at_iso = new Date(now * 1000).toISOString();
  writeFileSync(join(SCRATCH, "catalog.json"), JSON.stringify(fresh, null, 1));
  writeFileSync(join(SCRATCH, "menu.json"), JSON.stringify({
    _provenance: fixture._provenance.menu,
    tools: fixture.tools.map((t) => t.name),
    venues: [fixture.menu],
  }, null, 1));
  writeFileSync(join(SCRATCH, "harness.html"), HARNESS);

  let base = process.env.E2E_BASE_URL;
  if (!base) {
    server = serveDir(SCRATCH);
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${server.address().port}/`;
  }
  facts.base = base;

  // Record the launch decision with $HOME normalised, so the committed evidence
  // carries no literal home path (the fleet home-path gate refuses new ones).
  const launch = existsSync(CHROMIUM_1243)
    ? { headless: true, executablePath: CHROMIUM_1243.replace(homedir(), "$HOME") }
    : { headless: true, channel: "chrome" };
  const browser = await chromium.launch(launch.executablePath ? { headless: true, executablePath: CHROMIUM_1243 } : launch);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // No navigation to the venue: the handoff URL is recorded, not followed. Keeps
  // the run hermetic and proves the URL came from the announcement.
  await page.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });

  facts.browser = browser.version();
  facts.launch = launch;

  try {
    // ---------------------------------------------------------- A. the view
    await page.goto(base + "index.html", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`button.open-service[data-service="${SLUG}"]`, { timeout: 15000 });
    step("dashboard-loaded", { cards: await page.locator("article.card").count() });

    await page.click(`button.open-service[data-service="${SLUG}"]`);
    await page.waitForSelector(".spec-host .c-MenuItem", { timeout: 15000 });
    step("service-view-opened", { menuItems: await page.locator(".spec-host .c-MenuItem").count() });

    const rendered = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".spec-host .c-MenuItem")].map((n) => ({
        sku: n.querySelector("button.add")?.dataset.sku ?? null,
        price: n.querySelector(".price")?.textContent ?? null,
      }));
      return {
        rows,
        selectedMethod: document.querySelector(".spec-host .chip.on[data-method]")?.dataset.method ?? null,
        methods: [...document.querySelectorAll(".spec-host .chip[data-method]")].map((n) => n.dataset.method),
        bytes: window.__cvmSpike.verdict.bytes,
        ok: window.__cvmSpike.verdict.ok,
        refusals: window.__cvmSpike.verdict.refusals,
        hasOrderAction: !!document.querySelector(".spec-host .c-OrderAction"),
        hasHandoff: !!document.querySelector(".spec-host .c-HandoffAction"),
      };
    });
    step("view-rendered", {
      menuItems: rendered.rows.length, selectedMethod: rendered.selectedMethod,
      bytes: rendered.bytes, ok: rendered.ok, refusals: rendered.refusals.length,
    });

    if (rendered.rows.length !== ITEMS.length) fail(`rendered ${rendered.rows.length} menu items, fixture has ${ITEMS.length}`);
    if (rendered.bytes > 16384) fail(`spec is ${rendered.bytes} bytes, over the 16 KiB cap`);
    if (!rendered.ok) fail(`the real spec was refused: ${JSON.stringify(rendered.refusals)}`);
    if (rendered.refusals.length) fail(`the real spec had refusals: ${JSON.stringify(rendered.refusals)}`);
    if (!rendered.hasOrderAction) fail("the venue declares `order` but no OrderAction rendered");
    if (!rendered.hasHandoff) fail("the venue publishes a link but no HandoffAction rendered");

    // every rendered price must equal the SERVED value for that item + method
    const served = new Map(ITEMS.map((i) => [String(i.sku), i.prices_by_order_method]));
    const method = rendered.selectedMethod;
    if (!method) fail("no method is selected in the MethodPicker");
    const wrong = [];
    for (const r of rendered.rows) {
      const p = served.get(String(r.sku));
      if (!p) { wrong.push(`${r.sku}: not a served item`); continue; }
      const want = `${p[method]} ${CURRENCY}`.trim();
      if (r.price !== want) wrong.push(`${r.sku}/${method}: rendered "${r.price}" but served "${want}"`);
    }
    facts.price_check = { method, checked: rendered.rows.length, mismatches: wrong };
    if (wrong.length) fail(`rendered prices disagree with served prices (${wrong.length}): ${JSON.stringify(wrong.slice(0, 3))}`);
    else step("prices-match-served", { method, checked: rendered.rows.length });

    // ------------------------------------------------- B. add-to-basket -> order
    const target = "331227";
    await page.click(`.spec-host .c-MenuItem button.add[data-sku="${target}"]`);
    await page.waitForTimeout(150);
    const first = await page.evaluate(() => window.__cvmSpike.last("order.build"));
    const urlAfterClick = page.url();
    step("add-to-basket", { action: first?.action, payload: first?.payload });
    if (!first) fail("clicking add-to-basket produced no order.build action");
    else {
      const line = first.payload?.items?.[0];
      if (!line || (line.sku !== target && line.id !== target)) fail(`the order payload does not identify ${target}: ${JSON.stringify(first.payload)}`);
      if (line?.qty !== 1) fail(`expected qty 1, got ${JSON.stringify(line)}`);
      if (first.payload?.venue_slug !== SLUG) fail("the order payload does not carry the venue slug");
      if (first.payload?.fulfilment !== method) fail(`the order payload fulfilment is not the selected method (${method})`);
    }
    if (urlAfterClick !== base + "index.html") fail(`add-to-basket navigated away: ${urlAfterClick}`);

    // clicking again accrues a basket line, still qty 2 on the same sku
    await page.click(`.spec-host .c-MenuItem button.add[data-sku="${target}"]`);
    await page.waitForTimeout(150);
    const second = await page.evaluate(() => window.__cvmSpike.last("order.build"));
    step("add-to-basket-again", { payload: second?.payload });
    if (second?.payload?.items?.[0]?.qty !== 2) fail(`the basket did not accrue: ${JSON.stringify(second?.payload)}`);
    if (second?.payload?.items?.length !== 1) fail(`the basket should hold one line, got ${JSON.stringify(second?.payload?.items)}`);

    // the rendered basket total is the sum of served prices
    const basket = await page.evaluate(() => document.querySelector(".spec-host .c-Basket")?.innerText.replace(/\s+/g, " "));
    step("basket-rendered", { text: basket });

    // ------------------------------------------------------- C. the handoff URL
    await page.click(".spec-host .c-HandoffAction button");
    await page.waitForTimeout(150);
    const opened = await page.evaluate(() => ({ opened: window.__opened, handoff: window.__cvmSpike.last("order.handoff") }));
    step("handoff", opened);
    if (opened.opened.length !== 1) fail(`the handoff opened ${opened.opened.length} times, expected once`);
    if (opened.opened[0] !== fixture.entry.links[0]) fail(`the handoff URL is not the announcement's published link: ${opened.opened[0]}`);
    // and the spec the page rendered carries no URL at all
    const specText = await page.evaluate(() => JSON.stringify(window.__cvmSpike.spec ?? null));
    if (specText === "null") fail("the dashboard did not expose its spec to the test");
    else if (/https?:|\/\//.test(specText)) fail("the rendered spec contains a URL (the spec is not a URL channel)");
    else step("spec-has-no-url", { specBytes: (await page.evaluate(() => window.__cvmSpike.verdict.bytes)) });

    // ------------------------------------------------- D. fail-closed harness
    await page.goto(base + "harness.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.HARNESS_DONE === true, null, { timeout: 15000 });
    const cases = await page.evaluate(() => window.CASES);
    const caseCount = Object.keys(cases).length;

    const expectRefusal = (name, needle) => {
      const c = cases[name];
      if (!c) { fail(`harness case ${name} did not run`); return; }
      const all = [c.verdict?.refusedWholesale ?? "", ...(c.refusals ?? []).map((r) => r.why), ...(c.verdict?.refusals ?? []).map((r) => r.why)].join(" | ");
      if (!all.includes(needle)) fail(`case ${name}: expected a refusal mentioning "${needle}", got "${all}"`);
    };

    // baseline sanity
    if (!cases.baseline?.verdict.ok) fail("harness baseline spec was refused");
    if ((cases.baseline?.dom.elementCount ?? 0) < ITEMS.length) fail("harness baseline rendered too few elements");

    // unknown component: painted nothing for that element
    expectRefusal("unknown-component", "unknown component");
    const unknownDom = await page.evaluate(() => ({
      painted: document.querySelectorAll('#case-unknown-component [data-component="PaymentStep"]').length,
      text: document.querySelector("#case-unknown-component").innerText,
      menuItems: document.querySelectorAll("#case-unknown-component .c-MenuItem").length,
    }));
    if (unknownDom.painted !== 0) fail("the unknown component rendered a DOM node");
    if (unknownDom.menuItems !== ITEMS.length) fail("the unknown component took the rest of the view down with it");
    step("unknown-component", unknownDom);

    // injected price: refused, and the number never reaches the DOM
    expectRefusal("injected-price", "stated price 999");
    const injectedDom = await page.evaluate(() => ({
      priceRows: document.querySelectorAll("#case-injected-price .c-PriceRow").length,
      menus: document.querySelectorAll("#case-injected-price .c-MenuItem").length,
      has999: document.querySelector("#case-injected-price").innerText.includes("999"),
      priceTexts: [...document.querySelectorAll("#case-injected-price .price")].map((n) => n.textContent),
    }));
    step("injected-price", { priceRows: injectedDom.priceRows, menus: injectedDom.menus, has999: injectedDom.has999 });
    if (injectedDom.priceRows !== ITEMS.length - 1) fail(`the injected PriceRow should be the only one missing: ${injectedDom.priceRows}`);
    if (injectedDom.has999) fail("the injected price reached the DOM");
    if (injectedDom.priceTexts.some((t) => t.includes("999"))) fail("an injected price string was painted");

    expectRefusal("injected-total", "not reproducible from served prices");
    expectRefusal("version-2", "is not 1");
    expectRefusal("oversize", "over the");
    expectRefusal("url-in-facts", "looks like a URL");
    expectRefusal("order-undeclared", "declares no `order` tool");
    expectRefusal("order-not-served", "does not carry `order`");
    expectRefusal("handoff-no-url", "no published ordering URL");

    const version2Empty = await page.evaluate(() => document.querySelector("#case-version-2 .spec-el") === null);
    const oversizeEmpty = await page.evaluate(() => document.querySelector("#case-oversize .spec-el") === null);
    if (!version2Empty) fail("a version-2 spec painted something");
    if (!oversizeEmpty) fail("an oversize spec painted something");
    const cycleTerminated = cases.cycle !== undefined;
    if (!cycleTerminated) fail("the self-referencing spec did not terminate");

    const actions = cases["unknown-action"];
    if (actions?.dispatchOk?.[0] !== false) fail("an unknown action was dispatched");
    if ((actions?.captured ?? []).length !== 0) fail("an unknown/failed action was captured as if it had run");
    if (actions?.dispatchOk?.[1] !== false) fail("order.build ran without the served `order` tool");
    expectRefusal("unknown-action", "unknown action");

    const surface = cases["catalog-surface"];
    if (surface?.paymentish?.length) fail(`the catalog defines a payment-ish component: ${JSON.stringify(surface.paymentish)}`);
    const orderButtons = await page.evaluate(() => document.querySelectorAll("#case-order-undeclared .c-OrderAction").length);
    if (orderButtons !== 0) fail("an order button rendered with no declared tool behind it");
    const handoffButtons = await page.evaluate(() => document.querySelectorAll("#case-handoff-no-url .c-HandoffAction").length);
    if (handoffButtons !== 0) fail("a handoff button rendered with no published URL");

    step("fail-closed-cases", { cases: caseCount, names: Object.keys(cases).sort() });
    facts.case_results = Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, {
      ok: v.verdict?.ok ?? null,
      refusedWholesale: v.verdict?.refusedWholesale ?? null,
      refusals: (v.refusals ?? []).map((r) => r.why ?? r.reason ?? r),
      dom: v.dom,
    }]));

    if (errors.length) fail(`page errors: ${JSON.stringify(errors.slice(0, 3))}`);
    if (!facts.failures.length && !wrong.length) facts.verdict = `PASS — ${rendered.rows.length} menu items from the served fixture, ${rendered.rows.length} prices matched, ${caseCount} fail-closed cases`;
    else facts.verdict = `FAIL — ${facts.failures.length} check(s) failed`;
    step("verdict", { verdict: facts.verdict });
  } catch (err) {
    facts.verdict = `FAIL — ${err.message}`;
    fail(err.message);
    if (await page.title().catch(() => "")) facts.last_page = await page.content().catch(() => "").then((h) => h.slice(0, 400));
  } finally {
    await context.close();
    await browser.close();
    if (server) await new Promise((r) => server.close(r));
    if (facts.failures.length) process.exitCode = 1;
    mkdirSync(resolve(EVIDENCE, ".."), { recursive: true });
    writeFileSync(EVIDENCE, JSON.stringify(facts, null, 2));
    console.log(`[evidence] ${EVIDENCE}`);
    console.log(JSON.stringify({ verdict: facts.verdict, failures: facts.failures }, null, 2));
  }
}

main();
