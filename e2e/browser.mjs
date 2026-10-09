// e2e/browser.mjs — one browser-resolution policy for every e2e script.
//
// Why: the scripts used to launch a HARDCODED Playwright revision
// (~/.cache/ms-playwright/chromium-1243/…) with a `channel: "chrome"` fallback.
// That path exists on exactly one machine, so a clean clone or a CI container
// silently got a different browser — or none. This module resolves, in order:
//
//   1. E2E_CHROMIUM          — an explicit binary, for a pinned setup;
//   2. Playwright's own Chromium — whatever revision the PINNED package ships
//      (`npx playwright install chromium`; `npm ci` does not download it);
//   3. the legacy pinned cache path, if it happens to exist;
//   4. the system Chrome      — `channel: "chrome"`.
//
// The returned `how` string is recorded in the evidence so a run says which
// browser it actually used. This module owns the Playwright import, so callers
// pass launch options — not a browser type — and cannot get the shape wrong.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

export const LEGACY_CHROMIUM = join(homedir(), ".cache", "ms-playwright", "chromium-1243", "chrome-linux64", "chrome");

// Playwright's own Chromium binary path, or null when it is not downloaded.
// `npm ci` installs the package but NOT the browser, so this is genuinely
// nullable; the runner uses it to decide whether to run `playwright install`.
export function playwrightChromiumPath() {
  try {
    const p = chromium.executablePath();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

export async function launchChromium(launchArgs = {}) {
  const errors = [];
  if (process.env.E2E_CHROMIUM) {
    return { browser: await chromium.launch({ ...launchArgs, executablePath: process.env.E2E_CHROMIUM }), how: "E2E_CHROMIUM" };
  }
  if (playwrightChromiumPath()) {
    try {
      return { browser: await chromium.launch(launchArgs), how: "playwright-installed chromium" };
    } catch (err) {
      errors.push(`playwright-installed chromium: ${err?.message?.split("\n")[0]}`);
    }
  } else {
    errors.push("playwright-installed chromium: not downloaded (run `npx playwright install chromium`)");
  }
  if (existsSync(LEGACY_CHROMIUM)) {
    try {
      return { browser: await chromium.launch({ ...launchArgs, executablePath: LEGACY_CHROMIUM }), how: LEGACY_CHROMIUM.replace(homedir(), "$HOME") };
    } catch (err) {
      errors.push(`pinned cache: ${err?.message?.split("\n")[0]}`);
    }
  }
  try {
    return { browser: await chromium.launch({ ...launchArgs, channel: "chrome" }), how: "system chrome (channel)" };
  } catch (err) {
    errors.push(`system chrome: ${err?.message?.split("\n")[0]}`);
  }
  throw new Error(`no usable browser. Tried:\n  - ${errors.join("\n  - ")}\nInstall one: npx playwright install chromium`);
}
