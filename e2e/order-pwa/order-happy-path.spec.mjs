// e2e/order-pwa/order-happy-path.spec.mjs
//
// The customer's money path, driven in a real browser against the REAL stack:
//
//   static site (/order/ + /menu.json + /vocab/)  node, the deploy-pwa.sh path map
//   cvm-orders (the real service)                 `deno run` main.ts, on loopback
//   Cashu mint (the NUT-04 surface the rail uses) harness/stub_mint.ts, real HTTP
//
// No production code knows this test exists: there is no fake-rail toggle and no
// test branch in the client. The only substitution is the MINT — a small deno
// server answering `POST /v1/mint/quote/bolt11` and
// `GET /v1/mint/quote/bolt11/{quote}` exactly as src/rail.ts (CashuRail) reads
// them, so the real rail, the real invoice endpoint and the real QR encoder run.
//
// Steps asserted, in the order a customer performs them (card t_889735b3):
//   1 venue list renders from menu.json        (not stuck on "Loading venues…")
//   2 venue -> menu, re-priced per fulfilment  (pickup AND delivery)
//   3 item -> options sheet, quantity, add     (the CTA re-prices as options change)
//   4 basket -> Subtotal + 8% fee + grand total in sats, declared inputs
//   5 Pay -> POST /api/orders -> awaiting_payment, NEVER paid (ADR-0008)
//   6 pay screen -> a real bolt11 (decoded by an independent BOLT11 decoder) + QR
//   7 settle -> Paid -> Facilitator placing -> Order placed -> Ready for pickup
//   8 the status poll is idempotent: a settled order is not re-transitioned
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { decode as decodeBolt11 } from "light-bolt11-decoder";
import { startStack } from "./harness/stack.mjs";
import { evidenceDir, saveVideo } from "./harness/video.mjs";
import { ITEM_SKU, MONEY, PHONE, SATS, VENUE_NAME, VENUE_SLUG, section } from "./harness/journey.mjs";

let stack;

test.beforeAll(async () => {
  stack = await startStack();
  // Which cvm-orders commit the money came from. The spec asserts exact sats, so
  // the commit belongs in the log next to the number it produced.
  console.log(`[e2e] cvm-orders ${stack.ordersCommit} (${stack.ordersSource})`);
  console.log(`[e2e] site ${stack.site} · orders ${stack.orders} · mint ${stack.mint}`);
});

test.afterAll(async () => {
  await stack?.stop();
});

test.afterEach(async ({ page }, testInfo) => {
  // The recording is the PR evidence: someone who will not run deno can still
  // watch the order go through. Only a green run is worth keeping.
  if (testInfo.status !== "passed") return;
  const name = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await saveVideo(page, join(evidenceDir(), `${name}.webm`));
});

test("order PWA happy path: venue -> basket -> invoice -> settled", async ({ page }) => {
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  // ---------------------------------------------------------------- step 1
  await page.goto(`${stack.site}/order/`);

  // "Not stuck on Loading venues…": the client replaces the app with the venue
  // list only after /menu.json resolves.
  await expect(page.locator("p.loading")).toHaveCount(0);
  await expect(page.locator("h1")).toContainText("Order food");
  await expect(page.locator("button.venue")).toHaveCount(2);
  await expect(page.getByText(VENUE_NAME)).toBeVisible();

  // ---------------------------------------------------------------- step 2
  await page.locator(`[data-venue="${VENUE_SLUG}"]`).click();
  await expect(page.locator("button.item")).toHaveCount(76);
  const cheeseburger = page.locator(`[data-item="${ITEM_SKU}"]`);
  // `span b` is the price; `b.arrow` is the row's chevron.
  await expect(cheeseburger.locator("span b")).toContainText(SATS(MONEY.unitPickup));
  await page.locator('[data-method="delivery"]').click();
  await expect(cheeseburger.locator("span b")).toContainText(SATS(MONEY.unitDelivery));
  await page.locator('[data-method="pickup"]').click();
  await expect(cheeseburger.locator("span b")).toContainText(SATS(MONEY.unitPickup));

  // ---------------------------------------------------------------- step 3
  await cheeseburger.click();
  await expect(page.locator('button[data-sauce="House"]')).toHaveClass(/\bon\b/);
  await expect(page.locator('button[data-size="Single"]')).toHaveClass(/\bon\b/);
  await page.locator('[data-sauce="Garlic"]').click();
  await expect(page.locator('button[data-sauce="Garlic"]')).toHaveClass(/\bon\b/);
  await page.locator('[data-sauce="House"]').click();

  const addButton = page.locator("[data-add]");
  await expect(addButton).toContainText(SATS(MONEY.line)); // Bacon is on by default
  await page.locator('[data-extra="Extra cheese"]').click();
  await expect(addButton).toContainText(SATS(MONEY.line + MONEY.cheeseSats));
  await page.locator('[data-extra="Extra cheese"]').click();
  await expect(addButton).toContainText(SATS(MONEY.line));

  await page.locator('[data-qty="1"]').click();
  await expect(page.locator(".quantity strong")).toHaveText("2");
  await expect(addButton).toContainText(SATS(MONEY.line * 2));
  await page.locator('[data-qty="-1"]').click();
  await expect(page.locator(".quantity strong")).toHaveText("1");
  await addButton.click();

  // The basket bar: the count and the running total sit next to the button.
  await expect(page.locator(".basket-bar span")).toContainText("1 items");
  await expect(page.locator(".basket-bar span")).toContainText(SATS(MONEY.line));

  // ---------------------------------------------------------------- step 4
  await page.locator("[data-basket]").click();
  await expect(page.locator(".totals")).toContainText("Subtotal");
  await expect(page.locator(".totals")).toContainText("Facilitator fee · 8%");
  await expect(page.locator(".totals .grand b")).toContainText(SATS(MONEY.total));
  // The declared inputs come from the /vocab register, not from the client.
  const phone = page.locator('[data-input="contact.phone"]');
  await expect(phone).toBeVisible();
  await phone.fill(PHONE);

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
  // NOT born paid: only a rail verdict may reach `paid` (ADR-0008).
  const created = await stack.readOrder(order.id);
  expect(created.status).toBe(200);
  expect(created.body.state).toBe("awaiting_payment");
  expect(created.body.total).toBe(MONEY.total);

  // ---------------------------------------------------------------- step 6
  await expect(page.locator("p.error")).toHaveCount(0);
  const invoice = await stack.readInvoice(order.id);
  expect(invoice.status).toBe(200);
  expect(invoice.body.total).toBe(MONEY.total);

  await expect(page.locator("code.invoice")).toHaveText(invoice.body.bolt11);
  expect(
    invoice.body.bolt11.startsWith("lnbc"),
    `bolt11 must be a real BOLT11 string, got ${invoice.body.bolt11}`,
  ).toBe(true);

  // Independent proof the invoice is well formed: decoded by a BOLT11 decoder
  // this harness did not write.
  const decoded = decodeBolt11(invoice.body.bolt11);
  expect(section(decoded, "amount")).toBe(String(MONEY.total * 1000)); // mSAT
  expect(section(decoded, "payment_hash")).toMatch(/^[0-9a-f]{64}$/);
  expect(section(decoded, "signature")).toMatch(/^[0-9a-f]{130}$/);

  const qr = page.locator("img.qr");
  await expect(qr).toBeVisible();
  const qrSrc = await qr.getAttribute("src");
  expect(qrSrc.startsWith("data:image/svg+xml;base64,")).toBe(true);
  expect(qrSrc.length).toBeGreaterThan(1000);

  // The pay screen quotes the SERVER's total, in sats. (`state.order.total` is
  // integer sats, not EUR: it must not be passed through the EUR formatter.)
  await expect(page.locator(".pay h2")).toHaveText(SATS(MONEY.total));

  // ---------------------------------------------------------------- step 7
  // One order, one quote, priced at the order total — created by the real rail.
  const quotes = await stack.mintQuotes();
  expect(quotes).toHaveLength(1);
  expect(quotes[0].amount).toBe(MONEY.total);
  expect(quotes[0].state).toBe("UNPAID");

  await page.locator("[data-paid]").click();
  await expect(page.locator(".status")).toBeVisible();
  await expect(page.locator("header.top h1")).toContainText(`Order #${order.id}`);
  // Nothing has settled yet. ADR-0008 forbids the client claiming payment before
  // the rail has verified it, so NOT ONE row is done here — not even "Paid".
  await expect(page.locator(".tl").nth(0).locator(".dot")).not.toHaveClass(/\bdone\b/);
  await expect(page.locator(".tl").nth(1).locator(".dot")).not.toHaveClass(/\bdone\b/);
  await expect(page.locator(".tl").nth(3).locator(".dot")).not.toHaveClass(/\bdone\b/);

  await stack.settle(quotes[0].quote);
  await page.locator("[data-refresh]").click();
  const settled = await stack.waitForState(order.id, "paid");
  expect(settled.body.state).toBe("paid");
  const settledUpdatedAt = settled.body.updatedAt;

  // The customer sees the payment land — and only that: `paid` is not yet
  // "the facilitator is placing your order".
  await expect(page.locator(".tl").nth(0).locator(".dot")).toHaveClass(/\bdone\b/);
  await expect(page.locator(".tl").nth(1).locator(".dot")).not.toHaveClass(/\bdone\b/);
  await expect(page.locator(".order-card")).toContainText("paid · pickup");

  // ---------------------------------------------------------------- step 8
  // Idempotency: a settled order is never re-transitioned, and the rail is not
  // even asked again. `checks` counts the mint's own quote-state reads, so an
  // unchanged count is proof no second settlement ran.
  const checksBefore = (await stack.mintQuotes())[0].checks;
  const second = await stack.readOrder(order.id);
  const third = await stack.readOrder(order.id);
  expect(second.body.state).toBe("paid");
  expect(third.body.state).toBe("paid");
  expect(second.body.updatedAt).toBe(settledUpdatedAt);
  expect(third.body.updatedAt).toBe(settledUpdatedAt);
  const checksAfter = (await stack.mintQuotes())[0].checks;
  expect(checksAfter).toBe(checksBefore);

  // The facilitator drives the rest of the lifecycle (the console's own signed
  // surface); the customer's screen must follow it.
  for (const state of ["placing", "placed", "ready"]) {
    const moved = await stack.transition(order.id, state);
    expect(moved.status, `transition to ${state} failed: ${JSON.stringify(moved.body)}`).toBe(200);
    expect(moved.body.state).toBe(state);
  }
  await page.locator("[data-refresh]").click();

  await expect(page.locator(".tl").nth(1).locator(".dot")).toHaveClass(/\bdone\b/);
  await expect(page.locator(".tl").nth(2).locator(".dot")).toHaveClass(/\bdone\b/);
  await expect(page.locator(".tl").nth(3).locator(".dot")).toHaveClass(/\bdone\b/);
  await expect(page.locator(".order-card")).toContainText("ready · pickup");

  const final = await stack.readOrder(order.id);
  expect(final.body.state).toBe("ready");

  expect(consoleErrors, `browser console errors: ${consoleErrors.join(" | ")}`).toEqual([]);
});
