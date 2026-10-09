// live_deploy_check.mjs — does the DEPLOYED dashboard actually render the real menus?
//
// The unit tests and e2e/catalog_render_e2e.mjs prove the renderer against a
// fixture. This script proves the DEPLOYMENT: it drives the live origin, over the
// real network, using the real `site/menu.json` that the deploy shipped, and
// asserts the rendered menu for EVERY venue in that capture.
//
// Why it exists: the failure it catches is invisible to every other test. app.js
// pulls the renderer in with a dynamic import() and fetches menu.json at click
// time — so if `deploy/deploy.sh` forgets `site/render/` or `site/menu.json`,
// nothing breaks, nothing errors, and the service view just opens empty on the
// live site while every suite stays green. (That was the state before this PR:
// render/*.js and menu.json were 404 in production.)
//
// Usage:
//   node e2e/live_deploy_check.mjs                          # https://cvm.orangesync.tech
//   E2E_BASE_URL=http://127.0.0.1:8000 node e2e/live_deploy_check.mjs
// Env: E2E_EVIDENCE (default docs/e2e/live-menu-e2e.json), E2E_CHROMIUM

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChromium } from "./browser.mjs";
// The same resolver the page uses, so this check cannot disagree with the
// renderer about which served item a row names (an ambiguous sku resolves by id).
import { menuItemIndex } from "../site/render/catalog.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const BASE = (process.env.E2E_BASE_URL ?? "https://cvm.orangesync.tech").replace(/\/+$/, "");
const EVIDENCE = process.env.E2E_EVIDENCE ?? join(ROOT, "docs", "e2e", "live-menu-e2e.json");

// The capture this deployment is expected to be serving, read from the repo.
const LOCAL = JSON.parse(readFileSync(join(ROOT, "site", "menu.json"), "utf8"));

const facts = { check: "live deploy — real menus on the deployed dashboard", base: BASE, steps: [], failures: [] };
const step = (name, data = {}) => { facts.steps.push({ name, ...data }); console.log(`[step] ${name} ${JSON.stringify(data)}`); };
const fail = (msg) => { facts.failures.push(msg); console.error(`[FAIL] ${msg}`); };

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  return { status: res.status, bytes: (await res.text()).length, body: res };
};

let browser;
try {
  // ------------------------------------------------ 1. the shipped assets exist
  const assets = {};
  for (const p of ["/", "/menu.json", "/render/catalog.js", "/render/spec.js", "/render/renderer.js", "/catalog.json"]) {
    const r = await get(p);
    assets[p] = { status: r.status, bytes: r.bytes };
    if (r.status !== 200) fail(`${p} -> HTTP ${r.status}`);
  }
  step("assets", assets);

  const served = await (await fetch(`${BASE}/menu.json`, { cache: "no-store" })).json();
  const servedBySlug = new Map((served.venues || []).map((v) => [v.venue_slug, v]));
  const localBySlug = new Map((LOCAL.venues || []).map((v) => [v.venue_slug, v]));
  step("served-capture", {
    venues: (served.venues || []).map((v) => ({ slug: v.venue_slug, items: v.item_count })),
    tools: served.tools,
  });
  if (servedBySlug.size === 0) fail("the deployed menu.json carries no venues");

  // The deployed capture must be the one committed here — otherwise the check
  // would rubber-stamp a file nobody can reproduce.
  for (const [slug, local] of localBySlug) {
    const remote = servedBySlug.get(slug);
    if (!remote) { fail(`menu.json on the origin is missing '${slug}'`); continue; }
    if (remote.item_count !== local.item_count) {
      fail(`${slug}: origin serves ${remote.item_count} items, the repo captures ${local.item_count}`);
    }
  }
  if (servedBySlug.size !== localBySlug.size) {
    fail(`origin serves ${servedBySlug.size} venues, the repo captures ${localBySlug.size}`);
  }

  // ------------------------------------------------ 2. the page renders them
  const launched = await launchChromium({ headless: true });
  browser = launched.browser;
  step("browser", { how: launched.how, version: browser.version() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  // The dashboard fetches catalog.json after load, so the cards are NOT in the
  // first DOM paint — counting immediately is a race that a fast localhost hides
  // and a real origin exposes. Wait for the first card, then count.
  let cards = 0;
  try {
    await page.waitForSelector("article.card", { timeout: 25000 });
    cards = await page.locator("article.card").count();
  } catch {
    cards = await page.locator("article.card").count();
  }
  step("dashboard-loaded", { cards });
  if (cards === 0) fail("the deployed dashboard rendered no service cards (stale catalog? see policy max_age)");

  await page.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });

  const perVenue = {};
  for (const [slug, local] of localBySlug) {
    const btn = `button.open-service[data-service="${slug}"]`;
    if ((await page.locator(btn).count()) === 0) { fail(`${slug}: no "Open service" control on the deployed page`); continue; }
    await page.click(btn);
    try {
      await page.waitForSelector(".spec-host .c-MenuItem", { timeout: 20000 });
    } catch {
      fail(`${slug}: the service view opened but painted no menu items`);
      perVenue[slug] = { rendered: 0, expected: local.item_count };
      continue;
    }
    const view = await page.evaluate(async () => {
      // Read the cap the DEPLOYED catalog module declares, so this check cannot
      // drift from the constant the renderer actually enforces.
      let specMaxBytes = null;
      try { specMaxBytes = (await import("./render/catalog.js")).SPEC_MAX_BYTES; } catch { /* reported below */ }
      const rows = [...document.querySelectorAll(".spec-host .c-MenuItem")].map((n) => ({
        sku: n.querySelector("button.add")?.dataset.sku ?? null,
        id: n.querySelector("button.add")?.dataset.id ?? null,
        price: n.querySelector(".price")?.textContent ?? null,
      }));
      const v = window.__cvmSpike?.verdict ?? null;
      return {
        rows, specMaxBytes,
        selectedMethod: document.querySelector(".spec-host .chip.on[data-method]")?.dataset.method ?? null,
        bytes: v?.bytes ?? null, ok: v?.ok ?? null, refusals: v?.refusals ?? [],
        hasOrderAction: !!document.querySelector(".spec-host .c-OrderAction"),
        hasHandoff: !!document.querySelector(".spec-host .c-HandoffAction"),
      };
    });
    perVenue[slug] = {
      rendered: view.rows.length, expected: local.item_count, method: view.selectedMethod,
      bytes: view.bytes, cap: view.specMaxBytes, ok: view.ok, refusals: view.refusals.length,
      hasOrderAction: view.hasOrderAction, hasHandoff: view.hasHandoff,
    };
    step("venue-view", { slug, ...perVenue[slug] });

    if (view.rows.length !== local.item_count) fail(`${slug}: rendered ${view.rows.length} items, the capture carries ${local.item_count}`);
    if (view.ok !== true) fail(`${slug}: the real spec was refused: ${JSON.stringify(view.refusals)}`);
    if (view.refusals.length) fail(`${slug}: ${view.refusals.length} element(s) refused: ${JSON.stringify(view.refusals.slice(0, 2))}`);
    if (!view.specMaxBytes) fail(`${slug}: could not read SPEC_MAX_BYTES from the deployed catalog module`);
    if (view.bytes && view.specMaxBytes && view.bytes > view.specMaxBytes) {
      fail(`${slug}: spec is ${view.bytes} bytes, over the deployed ${view.specMaxBytes}-byte cap`);
    }

    // every rendered price must equal the price the CAPTURE carries for that method
    const method = view.selectedMethod;
    if (!method) fail(`${slug}: no method selected in the MethodPicker`);
    const index = menuItemIndex(local.items);
    const wrong = [];
    for (const r of view.rows) {
      const item = index.resolve(r.id, r.sku);
      if (!item) { wrong.push(`${r.id || r.sku}: names no single served item`); continue; }
      const p = item.prices_by_order_method;
      if (p[method] === undefined) { wrong.push(`${r.id || r.sku}: capture has no ${method} price`); continue; }
      const want = `${p[method]} ${local.currency}`.trim();
      if (r.price !== want) wrong.push(`${r.id || r.sku}/${method}: rendered "${r.price}", capture says "${want}"`);
    }
    perVenue[slug].priceCheck = { method, checked: view.rows.length, mismatches: wrong.length };
    if (wrong.length) fail(`${slug}: rendered prices disagree with the capture (${wrong.length}): ${JSON.stringify(wrong.slice(0, 3))}`);

    if (!view.hasHandoff) fail(`${slug}: the venue publishes an ordering link but no HandoffAction rendered`);
    // close the panel again so the next card is clicked in a known state
    await page.click(btn).catch(() => {});
    await page.waitForTimeout(150);
  }

  facts.per_venue = perVenue;
  if (errors.length) fail(`page errors: ${JSON.stringify(errors.slice(0, 3))}`);
  facts.verdict = facts.failures.length
    ? `FAIL — ${facts.failures.length} check(s) failed`
    : `PASS — ${Object.keys(perVenue).length} venue(s) rendered from the live capture at ${BASE}`;
  step("verdict", { verdict: facts.verdict });
} catch (err) {
  facts.verdict = `FAIL — ${err.message}`;
  fail(String(err));
} finally {
  if (browser) await browser.close().catch(() => {});
  writeFileSync(EVIDENCE, JSON.stringify(facts, null, 2));
  console.log(`[evidence] ${EVIDENCE}`);
  console.log(JSON.stringify({ verdict: facts.verdict, failures: facts.failures }, null, 2));
  if (facts.failures.length) process.exitCode = 1;
}
