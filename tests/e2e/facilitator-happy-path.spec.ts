import { test, expect } from "@playwright/test";

// The fixture endpoint is intentionally local: the browser flow still exercises the
// user-facing console, while the cvm-orders challenge is deterministic for video.
test("full facilitator happy path", async ({ page }) => {
  await page.route("**/auth/challenge", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ nonce: "e2e-challenge", expiresIn: 300 }) });
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, "nostr", { value: { signEvent: async (event: unknown) => event } });
  });
  await page.goto("http://127.0.0.1:4173/console/");
  await page.getByRole("button", { name: "Sign in with Nostr" }).click();
  await expect(page.getByRole("heading", { name: "Queue" })).toBeVisible();
  await expect(page.getByText(/place now · 2:10/)).toBeVisible();
  await page.getByRole("button", { name: "Place order at venue" }).click();
  await page.getByPlaceholder("#4471").fill("#4471");
  await page.getByPlaceholder("18:25").fill("18:25");
  await page.getByRole("button", { name: /Mark ready/ }).click();
  await expect(page.getByText("Ready — customer notified")).toBeVisible();
  await page.getByRole("button", { name: "Pay 25.30 €" }).click();
  await expect(page.getByRole("heading", { name: "Settlements" })).toBeVisible();
  await expect(page.getByText("4 310 sats")).toBeVisible();
  await expect(page.getByText("64.15 €")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send refund now" })).toBeVisible();
});
