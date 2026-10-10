// e2e/order-pwa/live-order.spec.mjs
//
// The SAME journey against the DEPLOYED site (E2E_LIVE=1), asserting the same
// money. Opt-in, because it creates an order on production, but never silently
// skipped: when it runs it reports the deployed truth, and the failure message
// says which layer is stale.
//
// It stops at the pay screen. The production mint cannot be settled from here, so
// there is no honest way to drive a deployment through "paid" and beyond — that
// is what the hermetic run's stub mint is for.
import { test, expect } from "@playwright/test";
import { decode as decodeBolt11 } from "light-bolt11-decoder";
import { ITEM_SKU, MONEY, PHONE, SATS, VENUE_SLUG, section } from "./harness/journey.mjs";

const LIVE = process.env.E2E_LIVE === "1";
const BASE = process.env.E2E_LIVE_BASE ?? "https://cvm-pwa.orangesync.tech";

/**
 * Step timing. A live journey is minutes of network away from the hermetic one,
 * and when it stalls the log has to say WHICH step stalled.
 */
function stamp(mark, startedAt) {
  console.log(`[live] +${((Date.now() - startedAt) / 1000).toFixed(1)}s ${mark}`);
}

// A failing live run keeps its recording and trace in test-results/ (Playwright's
// own output, gitignored); the committed evidence for the deployed run is
// docs/e2e/order-pwa/live-run.log.

test("live: a real order reaches a real invoice on the deployed site", async ({ page }) => {
  test.skip(!LIVE, "set E2E_LIVE=1 to drive the deployed site (creates one unpaid, self-expiring order)");
  const t0 = Date.now();

  // ---------------------------------------------------------------- step 1-2
  await page.goto(`${BASE}/order/`);
  await expect(page.locator("h1")).toContainText("Order food");
  stamp("venue list", t0);
  await page.locator(`[data-venue="${VENUE_SLUG}"]`).click();
  await expect(page.locator(`[data-item="${ITEM_SKU}"] span b`)).toContainText(SATS(MONEY.unitPickup));
  stamp("menu priced", t0);

  // ---------------------------------------------------------------- step 3
  await page.locator(`[data-item="${ITEM_SKU}"]`).click();
  await expect(page.locator("[data-add]")).toContainText(SATS(MONEY.line));
  await page.locator("[data-add]").click();
  await expect(page.locator(".basket-bar span")).toContainText(SATS(MONEY.line));
  stamp("item in basket", t0);

  // ---------------------------------------------------------------- step 4
  await page.locator("[data-basket]").click();
  const totals = page.locator(".totals");
  await expect(totals).toContainText("9.05 €");
  await expect(totals).toContainText("0.72 €");
  await expect(totals.locator("p.grand b")).toContainText(SATS(MONEY.total));
  await page.locator('[data-input="contact.phone"]').fill(PHONE);
  stamp("basket totals", t0);

  // ---------------------------------------------------------------- step 5
  stamp("clicking Pay (POST /api/orders follows)", t0);
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/orders") && r.request().method() === "POST",
      { timeout: 60_000 },
    ),
    page.locator("[data-pay]").click(),
  ]);
  stamp(`POST /api/orders answered ${response.status()}`, t0);
  // Never call response.text() here: a body Playwright cannot retrieve from the
  // network stack blocks forever (the first run of this spec hung 5.8 minutes on
  // it). Read the failure the way the CUSTOMER reads it — off the page.
  const status = response.status();
  const seenByCustomer =
    status === 201
      ? ""
      : await page
          .locator("p.error")
          .textContent({ timeout: 10_000 })
          .catch(() => "(the client showed no error)");
  expect(
    status,
    `POST /api/orders answered ${status}; the customer was shown: ${JSON.stringify(seenByCustomer)}\n` +
      'A 409 {"error":"order already exists"} means the deployed service is the ' +
      "pre-hardening build: every POST takes the same (undefined) order id, so the " +
      "deployed money path cannot open an order at all.",
  ).toBe(201);
  await expect(page.locator("p.error")).toHaveCount(0);

  // ---------------------------------------------------------------- step 6
  await expect(page.locator(".pay h2")).toHaveText(SATS(MONEY.total));
  const qr = page.locator("img.qr");
  await expect(qr).toBeVisible();
  expect((await qr.getAttribute("src")).startsWith("data:image/svg+xml;base64,")).toBe(true);

  // The invoice the customer is asked to pay, taken off the screen and decoded by
  // an independent BOLT11 decoder rather than trusting the service's own word:
  // 9 774 sats, in msat. (Nothing here calls the service again — a deploy whose
  // order service is stale still has to render an honest invoice to fail on.)
  const bolt11 = (await page.locator("code.invoice").textContent())?.trim() ?? "";
  expect(bolt11.startsWith("lnbc")).toBe(true);
  const decoded = decodeBolt11(bolt11);
  expect(section(decoded, "amount").value).toBe(String(MONEY.total * 1000));
  expect(Number(section(decoded, "expiry"))).toBeGreaterThan(0);
  expect(decoded.paymentRequest).toBe(bolt11);

  stamp("invoice rendered and decoded", t0);
});
