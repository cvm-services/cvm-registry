// playwright.config.mjs — the runner for the customer order PWA's browser tests.
//
// Why Playwright's own runner (@playwright/test) and not `deno task`:
// the existing e2e/*.mjs scripts in this repo import the `playwright` LIBRARY
// and hand-roll their own pass/fail, so from a clean clone they die with
// `ERR_MODULE_NOT_FOUND: Cannot find package 'playwright'` — there is no
// declared dependency and no runner. The order-PWA journey needs three things a
// library-only script cannot give us: a declared dependency that `npm ci`
// installs, a real assertion library with auto-waiting (the client re-renders
// the whole document on every step, so hand-rolled timing is where flake comes
// from), and first-class VIDEO recording at a fixed viewport — the evidence this
// card has to produce. Deno owns the services under test (cvm-orders, the stub
// mint); Node owns the browser.
//
// Video is ON for every test, 1280x720, and lands in test-results/<test>/video.webm.
// Nothing here skips the hermetic run: `npm run test:e2e` is the money path.

import { defineConfig } from "@playwright/test";

/** The deployed origin the live spec (E2E_LIVE=1) drives. */
export const LIVE_BASE = process.env.E2E_LIVE_BASE ?? "https://cvm-pwa.orangesync.tech";

export default defineConfig({
  testDir: "e2e/order-pwa",
  // The happy path is one ordered journey over one shared stack: parallel
  // workers would each boot their own services and tell us nothing extra.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "test-results/order-pwa",
  use: {
    viewport: { width: 1280, height: 720 },
    video: { mode: "on", size: { width: 1280, height: 720 } },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    // The order client is same-origin to the stack under test; the service
    // worker it registers is part of what ships at /order/, so let it run.
    serviceWorkers: "allow",
  },
  projects: [
    {
      name: "hermetic",
      testMatch: /order-happy-path\.spec\.mjs/,
    },
    {
      name: "live",
      testMatch: /live-order\.spec\.mjs/,
      use: { baseURL: LIVE_BASE },
    },
  ],
});
