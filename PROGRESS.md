# Task t_38f95d16
- Existing registry is a static cached catalog; added isolated customer route → implemented six-screen PWA in site/order/ with register-driven order form.
- Payment must be service-backed → invoice is fetched from /api/orders/:id/invoice and invalid/missing invoice fails closed.
- Status needs live progression → status endpoint polled every 5s after customer confirms payment.
- Verified Deno full suite 123/123 → tests/order_pwa_test.ts plus site/order/app.js pass checks.
- Mandatory live Playwright video remains → no Playwright config/live order endpoint exists in this repository; documented in REPORT.md.
