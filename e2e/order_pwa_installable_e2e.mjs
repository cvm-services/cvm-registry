// Real-browser test for the installable order client (site/order).
//
// The Deno suite (tests/order_pwa_installable_test.ts) proves the invariants by
// reading the shipped bytes and by evaluating sw.js against a CacheStorage
// double. It cannot prove that a real Chrome registers the worker, controls
// /order/, caches the shell, or keeps working with the network switched off.
// That is what this file does: real Chrome, real service worker, real offline.
//
// What it proves:
//   A. the ordering client still renders (the app module runs) with the new
//      manifest link and registration script in the document;
//   B. Chrome registers the worker and its scope is exactly /order/;
//   C. the worker controls /order/ after a reload;
//   D. the shell is really in CacheStorage — including responses the origin
//      marks `Cache-Control: no-store`, which is what the production vhost
//      sends — and no cache key contains /api/;
//   E. with the network OFF, /order/ is still served, by the worker, and the
//      app module still executes;
//   F. with the network OFF, an /api/ fetch FAILS: the worker never serves an
//      order or invoice from cache;
//   G. /console/ is NOT controlled by the order worker (scope is not "/");
//   H. the manifest is served as application/manifest+json, is valid JSON, and
//      pins start_url and scope to /order/.
//
// Hermetic: a built-in server serves the repo tree (site/, vocab/) and a stub
// /api/, so nothing outside 127.0.0.1 is touched. The stub /api/ is never asked
// to succeed — F asserts it is not reached through cache.
//
// Run:
//   node e2e/order_pwa_installable_e2e.mjs
// Env: E2E_CHROMIUM (executable path; default: the installed Chrome channel),
//      E2E_CHANNEL (playwright browser channel, default "chrome"),
//      E2E_BASE_URL (use an already-running server instead of the built-in one),
//      E2E_EVIDENCE (default docs/e2e/order-pwa-installable-e2e.json)

import { chromium } from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const SITE = join(ROOT, "site");
const EVIDENCE = process.env.E2E_EVIDENCE ?? join(ROOT, "docs", "e2e", "order-pwa-installable-e2e.json");

// Mirrors deploy/caddy-vhost-cvm-pwa.caddy: the manifest is typed as manifest
// JSON and everything else by extension. `no-store` is deliberate — that is what
// the production vhost sends, and D proves the worker caches anyway.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function startServer() {
  const server = createServer((req, res) => {
    const path = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (path.startsWith("/api/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ stub: true, note: "never cached by the worker" }));
      return;
    }
    let candidates;
    if (path.startsWith("/order/") || path.startsWith("/console/")) {
      // Each app falls back to its OWN document, exactly like the vhost: /order/x
      // must never answer with the console or the dashboard.
      const app = path.startsWith("/order/") ? "order" : "console";
      const sub = path.slice(`/${app}/`.length);
      candidates = [join(SITE, app, sub || "index.html"), join(SITE, app, "index.html")];
    } else {
      // The deploy flattens site/ into the doc root and copies vocab/ beside it,
      // so /menu.json lives at site/menu.json and /vocab/* at the repo root.
      const rel = path.replace(/^\//, "");
      candidates = [join(SITE, rel), join(ROOT, rel)];
    }
    for (const candidate of candidates) {
      const file = normalize(candidate);
      if (!file.startsWith(SITE) && !file.startsWith(ROOT)) continue;
      if (existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
        res.end(readFileSync(file));
        return;
      }
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

const launchOpts = process.env.E2E_CHROMIUM
  ? { executablePath: process.env.E2E_CHROMIUM }
  : { channel: process.env.E2E_CHANNEL ?? "chrome" };

let server = null;
let browser = null;
let chromeVersion = null;
let base = process.env.E2E_BASE_URL ?? "";

try {
  if (!base) {
    server = await startServer();
    base = `http://127.0.0.1:${server.address().port}`;
  }
  console.log(`== base ${base}`);
  browser = await chromium.launch(launchOpts);
  chromeVersion = await browser.version();
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // ---------------------------------------------------------------- A. renders
  await page.goto(`${base}/order/`, { waitUntil: "load" });
  let rendered = true;
  try {
    await page.waitForSelector("[data-venue]", { timeout: 15000 });
  } catch {
    rendered = false;
  }
  const venues = await page.locator("[data-venue]").count();
  check(
    "A. the order client renders its venue list",
    venues > 0,
    `${venues} venues, page errors: ${errors.length}` + (rendered ? "" : `, #app says: ${(await page.locator("#app").innerText()).slice(0, 200)}`),
  );

  // ------------------------------------------------------- B. registered+scope
  let reg = null;
  try {
    reg = await page.evaluate(async () => {
      // Registration is best-effort in the page (it swallows failures so the UI
      // never breaks), so this is where a registration that never activates
      // surfaces — as a timeout, not as a silent pass.
      const ready = navigator.serviceWorker.ready;
      const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error("serviceWorker.ready timed out")), 20000));
      const r = await Promise.race([ready, deadline]);
      const active = r.active ?? r.installing ?? r.waiting;
      return { scope: r.scope, script: active?.scriptURL ?? null, state: active?.state ?? null };
    });
  } catch (e) {
    reg = { error: String(e) };
  }
  check("B. Chrome registers the worker", reg?.script?.endsWith("/order/sw.js") === true, reg?.error ?? `script ${reg?.script} state ${reg?.state}`);
  check("B. the worker's scope is exactly /order/", new URL(reg?.scope ?? "about:blank").pathname === "/order/", reg?.scope ?? "no registration");

  // ------------------------------------------------------------ C. controls it
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("[data-venue]", { timeout: 15000 });
  const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
  check("C. the worker controls /order/ after a reload", controlled);

  // -------------------------------------------------------- D. shell cached
  const cacheState = await page.evaluate(async () => {
    const names = await caches.keys();
    const entries = {};
    for (const name of names) {
      const cache = await caches.open(name);
      entries[name] = (await cache.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
    }
    return { names, entries };
  });
  const allKeys = Object.values(cacheState.entries).flat();
  const shell = cacheState.entries["cvm-order-shell-v1"] ?? [];
  check("D. the shell cache exists", shell.length > 0, `${cacheState.names.join(", ")}`);
  for (const want of ["/order/", "/order/index.html", "/order/app.js", "/order/style.css", "/order/manifest.webmanifest", "/order/icon-192.png", "/order/apple-touch-icon.png"]) {
    check(`D. cached ${want}`, shell.includes(want));
  }
  check(
    "D. nothing under /api/ is cached (origin sends no-store, the worker still must not keep an order)",
    allKeys.filter((k) => k.startsWith("/api")).length === 0,
    `${allKeys.length} keys total: ${allKeys.join(" ")}`,
  );

  // ------------------------------------------------------------- E/F/G offline
  await context.setOffline(true);
  const nav = await page.reload({ waitUntil: "load" });
  const offlineState = await page.evaluate(async () => {
    const html = document.body.innerHTML;
    // The catalog lives at /menu.json and /vocab/service-inputs.json — OUTSIDE
    // this worker's /order/ scope, so it is expected to be unreachable offline.
    // Recorded as an observed fact rather than left as a claim.
    let menu;
    try {
      const r = await fetch("/menu.json");
      menu = `resolved ${r.status}`;
    } catch (e) {
      menu = `rejected: ${String(e).slice(0, 40)}`;
    }
    return {
      online: navigator.onLine,
      hasApp: Boolean(document.querySelector("#app")),
      venues: document.querySelectorAll("[data-venue]").length,
      catalogError: /unavailable/i.test(html),
      menu,
    };
  });
  check("E. offline, /order/ is served by the worker", nav?.fromServiceWorker() === true, `fromServiceWorker=${nav?.fromServiceWorker()}`);
  check(
    "E. offline, the app module still executes",
    offlineState.hasApp && (offlineState.venues > 0 || offlineState.catalogError),
    `navigator.onLine=${offlineState.online} venues=${offlineState.venues} catalog-error-shown=${offlineState.catalogError}`,
  );
  check(
    "E. the catalog is outside this worker's scope, so offline it stays honestly unavailable",
    offlineState.menu.startsWith("rejected"),
    offlineState.menu,
  );

  const apiOffline = await page.evaluate(async () => {
    try {
      const r = await fetch("/api/orders/1", { cache: "no-store" });
      return { resolved: true, status: r.status, body: (await r.text()).slice(0, 60) };
    } catch (e) {
      return { resolved: false, error: String(e).slice(0, 80) };
    }
  });
  check(
    "F. offline, /api/ is NOT served from cache",
    apiOffline.resolved === false,
    apiOffline.resolved ? `resolved ${apiOffline.status} ${apiOffline.body}` : apiOffline.error,
  );
  await context.setOffline(false);

  // ------------------------------------------------------- G. console untouched
  const consolePage = await context.newPage();
  await consolePage.goto(`${base}/console/`, { waitUntil: "load" });
  await consolePage.waitForTimeout(1000);
  const consoleControlled = await consolePage.evaluate(() => Boolean(navigator.serviceWorker.controller));
  check("G. the order worker does NOT control /console/", consoleControlled === false);

  // -------------------------------------------------------- H. the manifest
  const fetched = await fetch(`${base}/order/manifest.webmanifest`);
  const manifestText = await fetched.text();
  let manifest = null;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    /* reported below */
  }
  check(
    "H. the manifest is served as application/manifest+json",
    (fetched.headers.get("content-type") ?? "").includes("application/manifest+json"),
    fetched.headers.get("content-type") ?? "",
  );
  check("H. the manifest is valid JSON", manifest !== null);
  check("H. start_url and scope are /order/", manifest?.start_url === "/order/" && manifest?.scope === "/order/", `start_url=${manifest?.start_url} scope=${manifest?.scope}`);
  check("H. display is standalone", manifest?.display === "standalone");

  check("A. no uncaught page errors", errors.length === 0, errors.join(" | "));
} catch (err) {
  check("harness completed", false, String(err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}

const failed = results.filter((r) => !r.ok).length;
const summary = {
  at: new Date().toISOString(),
  base,
  browser: launchOpts,
  chrome: chromeVersion,
  passed: results.length - failed,
  failed,
  results,
};
try {
  mkdirSync(dirname(EVIDENCE), { recursive: true });
  writeFileSync(EVIDENCE, JSON.stringify(summary, null, 2) + "\n");
  console.log(`== evidence: ${EVIDENCE}`);
} catch (e) {
  console.log(`== evidence not written: ${e}`);
}
console.log(`== ${failed === 0 ? "ALL PASS" : "FAILURES"}: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
