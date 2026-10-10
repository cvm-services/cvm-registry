// e2e/order-pwa/order-happy-path.spec.mjs
//
// The customer's money path, driven in a real browser against the REAL stack:
//
//   static site (/order/ + /menu.json + /vocab/)  -> node, path map from deploy/deploy-pwa.sh
//   cvm-orders (real service, in-memory store)    -> `deno run` main.ts, loopback
//   Cashu mint (the NUT-04/07 surface the rail uses) -> harness/stub_mint.ts, real HTTP
//
// Nothing in production code knows this test exists: there is no fake-rail
// toggle, no test branch in the client. The only substitute is the MINT — a
// tiny deno server that answers `POST /v1/mint/quote/bolt11` and
// `GET /v1/mint/quote/bolt11/{quote}` exactly as `src/rail.ts` (CashuRail) reads
// them, so the real rail, the real invoice path and the real QR encoder run.
//
// Steps asserted, in the order a customer performs them (card t_889735b3):
//   1 venue list renders from menu.json (not stuck on "Loading venues…")
//   2 venue -> menu with per-item pickup AND delivery prices
//   3 item -> options sheet (sauce/extras/size), quantity, "Add to basket"
//   4 basket -> totals incl. the 8% facilitator fee, grand total in sats
//   5 Pay -> POST /api/orders -> order is `awaiting_payment`, never `paid`
//   6 pay screen -> a real bolt11 (decoded with an independent BOLT11 decoder) + QR image
//   7 settlement -> Paid -> "Facilitator placing your order" -> Ready for pickup
//   8 the settlement poll is idempotent: a second poll does NOT re-transition

import { test, expect } from "@playwright/test";
import { decode as decodeBolt11 } from "light-bolt11-decoder";
import { startStack } from "./harness/stack.mjs";
import { saveVideo } from "./harness/video.mjs";

const VENUE_SLUG = "doppelt-kaese-berlin";
const VENUE_NAME = "Doppelt Käse Laubacher Straße";
/** Cheeseburger. 8.90 EUR pickup / 9.50 EUR delivery in the pinned site/menu.json. */
const ITEM_SKU = "331227";

/**
 * Every number below is derived, not copied: the client displays EUR at
 * 1 EUR = 1000 sats (`sats = n => Math.round(n * 1000)`) and prices the Bacon
 * option at +0.15 EUR; the service (`src/catalog.ts`) uses the same
 * sats_per_eur and its own `option_surcharges_sats` table, and takes
 * floor(8% of subtotal) as the fee. The spec asserts the two agree.
 */
const MONEY = {
  unitPickup: 8900,
  unitDelivery: 9500,
  baconSats: 150,
  line: 9050, // (8900 + 150) * 1
  subtotal: 9050,
  fee: 724, // floor(9050 * 800 / 10000)
  total: 9774,
};

/** The client's own sats formatter, so assertions read like the screen does. */
const SATS = (n) => `${n.toLocaleString("en-US").replaceAll(",", " ")} sats`;

const section = (decoded, name) => decoded.sections.find((s) => s.name === name)?.value;

let stack;

test.beforeAll(async () => {
  stack = await startStack();
});

test.afterAll(async () => {
  await stack?.stop();
});

test.afterEach(async ({ page }, testInfo) => {
  const target = process.env.E2E_EVIDENCE_DIR
    ? `${process.env.E2E_EVIDENCE_DIR}/${testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.webm`
    : null;
  if (target && testInfo.status === "passed") await saveVideo(page, target);
});

test("order PWA happy path: venue -> basket -> invoice -> settled", async ({ page }) => {
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  // ---------------------------------------------------------------- step 1
  await page.goto(`${stack.site}/order/`);

  // "NOT stuck on Loading venues…": the client replaces the whole document body
  // with the venue list only once /menu.json resolved.
  await expect(page.locator("p.loading")).toHaveCount(0);
  await expect(page.locator("h1")).toContainText("Order food");
  await expect(page.locator("button.venue")).toHaveCount(2);
  await expect(page.getByText(VENUE_NAME)).toBeVisible();

  // ---------------------------------------------------------------- step 2
  await page.locator(`[data-venue="${VENUE_SLUG}"]`).click();
  await expect(page.locator("button.item")).toHaveCount(76);
  const cheeseburger = page.locator(`[data-item="${ITEM_SKU}"]`);
  await expect(cheeseburger.locator("b")).toContainText(SATS(MONEY.unitPickup));
  // Delivery is a different price for the same item — the toggle must re-price.
  await page.locator('[data-method="delivery"]').click();
  await expect(cheeseburger.locator("b")).toContainText(SATS(MONEY.unitDelivery));
  await page.locator('[data-method="pickup"]').click();
  await expect(cheeseburger.locator("b")).toContainText(SATS(MONEY.unitPickup));

  // ---------------------------------------------------------------- step 3
  await cheeseburger.click();
  await expect(page.locator('button[data-sauce="House"]')).toHaveClass(/\bon\b/);
  await expect(page.locator('button[data-size="Single"]')).toHaveClass(/\bon\b/);
  await page.locator('[data-sauce="Garlic"]').click();
  await expect(page.locator('button[data-sauce="Garlic"]')).toHaveClass(/\bon\b/);
  await page.locator('[data-sauce="House"]').click();
  // Extras re-price the CTA; the default Bacon is already on.
  const addButton = page.locator("[data-add]");
  await expect(addButton).toContainText(SATS(MONEY.line));
  await page.locator('[data-extra="Extra cheese"]').click();
  await expect(addButton).toContainText(SATS(MONEY.line + 120));
  await page.locator('[data-extra="Extra cheese"]').click();
  await expect(addButton).toContainText(SATS(MONEY.line));
  // Quantity is part of the line the customer confirms.
  await page.locator('[data-qty="1"]').click();
  await expect(page.locator(".quantity strong")).toHaveText("2");
  await expect(addButton).toContainText(SATS(MONEY.line * 2));
  await page.locator('[data-qty="-1"]').click();
  await expect(page.locator(".quantity strong")).toHaveText("1");
  await addButton.click();

  // Back on the menu, with the basket bar.
  await expect(page.locator("[data-basket]")).toContainText("1 items");

  // ---------------------------------------------------------------- step 4
  await page.locator("[data-basket]").click();
  await expect(page.locator(".totals")).toContainText("Subtotal");
  await expect(page.locator(".totals")).toContainText("Facilitator fee · 8%");
  await expect(page.locator(".totals .grand b")).toContainText(SATS(MONEY.total));
  // The declared inputs come from the /vocab register, not from the client.
  await expect(page.locator('[data-input="contact.phone"]')).toBeVisible();
  await page.locator('[data-input="contact.phone"]').fill("+4915112345678");

  // ---------------------------------------------------------------- step 5
  const [orderResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/orders") && r.request().method() === "POST"),
    page.locator("[data-pay]").click(),
  ]);
  expect(orderResponse.status()).toBe(201);
  const order = await orderResponse.json();
  expect(order.state).toBe("awaiting_payment");
  expect(order.subtotal).toBe(MONEY.subtotal);
  expect(order.fee).toBe(MONEY.fee);
  expect(order.total).toBe(MONEY.total);

  // The service — read directly, not through the UI — agrees, and the order was
  // NOT born paid (ADR-0008: only a rail verdict may reach `paid`).
  const created = await (await fetch(`${stack.orders}/orders/${order.id}`)).json();
  expect(created.state).toBe("awaiting_payment");
  expect(created.total).toBe(MONEY.total);

  // ---------------------------------------------------------------- step 6
  await expect(page.locator("p.error")).toHaveCount(0);
  const invoice = await (await fetch(`${stack.orders}/orders/${order.id}/invoice`)).json();
  expect(invoice.total).toBe(MONEY.total);

  const bolt11 = page.locator("code.invoice");
  await expect(bolt11).toHaveText(invoice.bolt11);
  expect(invoice.bolt11.startsWith("lnbc"), `bolt11 must be a real BOLT11 string: ${invoice.bolt11}`).toBe(true);

  // Independent proof the invoice is well formed: decode it with a BOLT11
  // decoder this harness did not write.
  const decoded = decodeBolt11(invoice.bolt11);
  expect(section(decoded, "amount")).toBe(String(MONEY.total * 1000)); // mSAT
  expect(section(decoded, "payment_hash")).toMatch(/^[0-9a-f]{64}$/);
  expect(decoded.expiry).toBeGreaterThan(0);

  const qr = page.locator("img.qr");
  await expect(qr).toBeVisible();
  const qrSrc = await qr.getAttribute("src");
  expect(qrSrc.startsWith("data:image/svg+xml;base64,")).toBe(true);
  expect(qrSrc.length).toBeGreaterThan(1000);

  // The pay screen shows the SERVER's total, in sats.
  await expect(page.locator(".pay h2")).toHaveText(SATS(MONEY.total));

  // ---------------------------------------------------------------- step 7
  const quotes = await stack.mintQuotes();
  expect(quotes).toHaveLength(1);
  expect(quotes[0].amount).toBe(MONEY.total);

  await page.locator("[data-paid]").click();
  await expect(page.locator(".status")).toBeVisible();
  await expect(page.locator(".status header h1")).toContainText(`Order #${order.id}`);
  // The status screen shows "Paid" done; nothing else has happened yet.
  await expect(page.locator(".tl").nth(3).locator(".dot")).not.toHaveClass(/\bdone\b/);

  await stack.settle(quotes[0].quote);
  await page.locator("[data-refresh]").click();

  const afterSettle = await stack.waitForOrderState(order.id, "paid");
  expect(afterSettle.state).toBe("paid");
  const settledUpdatedAt = afterSettle.updatedAt;

  // ---------------------------------------------------------------- step 8
  // Idempotency: the poll asks the mint again and STILL does not re-transition.
  const checksBefore = (await stack.mintQuotes())[0].checks;
  const second = await (await fetch(`${stack.orders}/orders/${order.id}`)).json();
  const third = await (await fetch(`${stack.orders}/orders/${order.id}`)).json();
  expect(second.state).toBe("paid");
  expect(third.state).toBe("paid");
  expect(second.updatedAt).toBe(settledUpdatedAt);
  expect(third.updatedAt).toBe(settledUpdatedAt);
  const checksAfter = (await stack.mintQuotes())[0].checks;
  expect(checksAfter).toBeGreaterThan(checksBefore);

  // The facilitator drives the rest of the lifecycle; the customer's screen
  // follows it. (This is the facilitator's console surface, signed NIP-98.)
  await stack.facilitate(order.id, ["placing", "placed", "ready"]);
  await page.locator("[data-refresh]").click();

  const readyRow = page.locator(".tl").nth(3);
  await expect(readyRow).toContainText("Ready for pickup");
  await expect(readyRow.locator(".dot")).toHaveClass(/\bdone\b/);
  await expect(page.locator(".tl").nth(2).locator(".dot")).toHaveClass(/\bdone\b/);

  const final = await (await fetch(`${stack.orders}/orders/${order.id}`)).json();
  expect(final.state).toBe("ready");

  expect(consoleErrors, `browser console errors: ${consoleErrors.join(" | ")}`).toEqual([]);
});
