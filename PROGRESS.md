# PROGRESS.md — meatspace facet + announcement-content rendering

One line per cluster of work, in the order done.

- [x] RED tests: `tests/meatspace_test.ts` (14 tests) for `parseDeclared` and the `meatspace` facet (pickup => true, delivery-only => false, compute/sms => false, dine_in => true, `cvm:service:meatspace` tag => true).
- [x] Collector: `collector/lib.ts` gains `Declared` types + `parseDeclared` (defensive JSON.parse, never throws) + `isMeatspace` (no `ship.*` required AND physical handover declared) + `declared`/`meatspace` on `Classified` and `Service`.
- [x] Fixture: `fixtures/demo-catalog.json` regenerated offline so the deterministic-replay test matches the new `classify` output.
- [x] Dashboard: `site/app.js` renders pickup wait, per-method prices, settlement rail (with the "declaration, not an audited fact" caveat) + a "Meatspace" filter chip/count; `site/style.css` styles.
- [x] Full suite green (74 passed) + headless Chrome DOM render verified (pickup venue shows meatspace badge + facts; sms/delivery-only do not).
