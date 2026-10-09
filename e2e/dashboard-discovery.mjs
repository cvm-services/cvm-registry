// Dashboard-side discovery evidence: the live registry -> a venue's own page.
//
// Scope, chosen by the operator 2026-10-06: DISCOVERY ONLY. The third-party
// checkout is deliberately never touched — no cart, no address, no payment.
// The run ends the moment the browser lands on the venue's own host, and the
// assertions stop there too, so the video cannot imply a completed order.
//
// Run (headed Chrome under xvfb — the venue hosts wall the headless shell):
//   xvfb-run -a --server-args="-screen 0 1440x1000x24" \
//     env NODE_PATH=/home/c03rad0r/.local/lib/node_modules \
//     node e2e/dashboard-discovery.mjs
//
// Env: DASHBOARD_URL (default https://cvm.orangesync.tech/), VIDEO_DIR, VENUE
//      (slug to click), REQUIRE_MEATSPACE_CHIP=0 to tolerate its absence.

import { mkdirSync, writeFileSync } from "node:fs";
import { launchChromium } from "./browser.mjs";

const BASE = process.env.DASHBOARD_URL ?? "https://cvm.orangesync.tech/";
const OUT = process.env.VIDEO_DIR ?? ".scratch/e2e";
const VENUE = process.env.VENUE ?? "doppelt-kaese-berlin";
const REQUIRE_CHIP = process.env.REQUIRE_MEATSPACE_CHIP !== "0";
mkdirSync(OUT, { recursive: true });

const facts = { base: BASE, venue: VENUE, steps: [] };
const step = (name, data = {}) => {
  facts.steps.push({ name, ...data });
  console.log(`[step] ${name} ${JSON.stringify(data)}`);
};

// Headed, because the venue hosts challenge the headless shell. e2e/browser.mjs
// picks the browser; run it under xvfb when there is no display.
const launched = await launchChromium({ headless: false, args: ["--window-size=1440,1000"] });
const browser = launched.browser;
step("browser", { how: launched.how, version: browser.version() });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  recordVideo: { dir: OUT, size: { width: 1440, height: 1000 } },
});
const page = await context.newPage();

try {
  // 1. the cache-backed dashboard. It never opens a relay connection.
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);
  const head = await page.evaluate(() =>
    document.body.innerText.replace(/\s+/g, " ").slice(0, 220)
  );
  const names = await page.evaluate(() => {
    const t = document.body.innerText;
    return {
      doppelt: t.includes("Doppelt K\u00e4se Laubacher Stra\u00dfe"),
      pizza: t.includes("Pizza e Pasta"),
      lambda: t.includes("cvm-lambda"),
      nosms: t.includes("nosms"),
    };
  });
  step("dashboard-loaded", { title: await page.title(), head, names });
  if (!names.doppelt || !names.pizza) {
    throw new Error(`the venue cards did not render: ${JSON.stringify(names)}`);
  }

  // 2. the class facets the page builds from the data itself. "meatspace" is
  //    the capability tag: goods change hands in person, no address needed.
  const chip = page.locator("button.chip", { hasText: /^meatspace$/ });
  const chipCount = await chip.count();
  if (REQUIRE_CHIP && chipCount === 0) {
    throw new Error("no 'meatspace' chip on the dashboard — the facet is not deployed");
  }
  if (chipCount > 0) {
    const before = await page.locator(".card, li, article").count();
    await chip.first().click();
    await page.waitForTimeout(1200);
    const afterText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
    const stillThere = afterText.includes("Doppelt K\u00e4se Laubacher Stra\u00dfe");
    const digitalGone = !afterText.includes("cvm-lambda") && !afterText.includes("nosms");
    step("meatspace-filter", { before, stillThere, digitalGone });
    if (!stillThere) throw new Error("filtering on meatspace dropped the pickup venue");
    if (!digitalGone) throw new Error("filtering on meatspace kept a digital service (the facet is wrong)");
  }

  // 3. click through to the venue's OWN ordering page. Discovery ends here.
  const link = page
    .locator('a[target="_blank"][href*="doppelt-kaese-berlin.de"]')
    .filter({ hasNotText: /^$/ })
    .first();
  const href = await link.getAttribute("href");
  step("deep-link-found", { href });
  const [external] = await Promise.all([
    context.waitForEvent("page", { timeout: 30000 }),
    link.click(),
  ]);
  await external.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => {});
  await external.waitForTimeout(6000); // challenges clear on their own schedule
  const landed = {
    url: external.url(),
    host: new URL(external.url()).host,
    title: await external.title(),
    text: await external.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 180)),
  };
  if (landed.title.includes("Just a moment")) {
    throw new Error("Cloudflare challenge instead of the venue page — run headed with channel=chrome");
  }
  if (!landed.host.endsWith("doppelt-kaese-berlin.de")) {
    throw new Error(`landed off the venue's host: ${landed.url}`);
  }
  step("landed-on-venue", landed);
  await external.waitForTimeout(2500); // let the viewer read the venue page
  facts.verdict = "PASS — discovery to the venue's own page; no checkout interaction";
} catch (err) {
  facts.verdict = `FAIL — ${err.message}`;
  process.exitCode = 1;
} finally {
  const video = page.video();
  await context.close(); // flushes the video file
  await browser.close();
  facts.video = video ? await video.path() : null;
  writeFileSync(`${OUT}/dashboard-discovery.json`, JSON.stringify(facts, null, 2));
  console.log(JSON.stringify(facts, null, 2));
}
