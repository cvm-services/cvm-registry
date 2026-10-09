# Task t_38f95d16

Implemented the customer ordering PWA at `site/order/` with six catalog-constrained screens: venue list, menu, item/options, basket, invoice payment, and polled order status. The form is generated from `vocab/service-inputs.json`; only `contact.phone` is required, and the client never stores keys or fabricates invoices. Added static Deno tests for route structure, register-driven inputs, real order/invoice/status endpoints, and sold-out behavior.

Verification: `deno check site/order/app.js`; `deno test --allow-read tests/order_pwa_test.ts` (4 passed); full `deno test --allow-read --allow-net=127.0.0.1` (123 passed).

Remaining operational work: run the mandatory Playwright single-test video against a live order service and attach/probe the resulting artifact; this workspace has no existing Playwright config or live cvm-orders endpoint.
