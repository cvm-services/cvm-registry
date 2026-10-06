# REPORT.md — meatspace capability facet + announcement-content rendering

## What this PR does

Adds a `meatspace` capability facet and announcement-content rendering to the
cvm-registry collector + static dashboard, with tests. No merge — PR only.

## Changes

### A. Collector content parsing (`collector/lib.ts`)
- New `Declared` types: `DeclaredFulfilment`, `DeclaredMenu`, `DeclaredSettlement`
  (and `FulfilmentMethodInfo`, `PriceBreakdown`), all nullable.
- `parseDeclared(content)` parses the event `content` (a JSON string) defensively:
  `JSON.parse` is wrapped in try/catch, so malformed/absent/non-object content
  yields an all-null `Declared` and **never throws**.
- `Classified` now carries `declared: Declared` and `meatspace: boolean`.

### B. Derived `meatspace` facet
- `isMeatspace(required, classes, declared)` — true iff:
  1. NO required field starts with `ship.` (a delivery-only venue that REQUIRES
     a shipping address is not meatspace), AND
  2. a physical handover is declared — `content.fulfilment.methods` includes
     `pickup` or `dine_in`, OR the `cvm:service:meatspace` class tag is present.
- **Why clause (2):** it exists precisely to keep digital services out. A digital
  service that requires nothing (tier `none`, class `compute`) or only
  `payment.amount` (class `sms`) trivially satisfies clause (1) — it has no
  `ship.*` requirement at all — so without an affirmative handover declaration it
  would be mislabelled "meatspace". Only an explicit pickup/dine_in method, or the
  explicit `cvm:service:meatspace` tag, counts as a physical handover. (Justified
  inline in a code comment.)
- Emitted on each entry (`classify`) and on each grouped `Service`
  (`groupServices`: `meatspace = any facet`, `declared` merged per-field from the
  lowest kind that declares it).

### C. Dashboard (`site/app.js`, `site/style.css`)
- `declaredFacts(e)` renders — only when present — the pickup wait
  (`pickup ~10 min`), per-fulfilment-method prices (pickup vs delivery vs
  dine_in), and the settlement rail; the "this is the provider's own declaration,
  not an audited fact" caveat is rendered inline wherever these facts appear.
- A "Meatspace" filter chip/count sits alongside the existing filters, wired into
  `UI.meatspace` and `passesFilters`; a `meatspace` badge marks qualifying cards.
- Vanilla JS, no new dependencies; matches the existing style.

### Tests (`tests/meatspace_test.ts`)
14 new unit tests (fixtures, no network):
- `parseDeclared`: absent/empty/malformed/non-object content => all-null, never throws.
- `parseDeclared`: valid venue content carries fulfilment/menu/settlement facts.
- `meatspace`: pickup venue => true; delivery-only (required `ship.address`) =>
  false; digital `compute` (tier none) => false; `sms` (only `payment.amount`) =>
  false; `cvm:service:meatspace` tag => true; `dine_in` => true.
- `meatspace` merges to the grouped service (any facet => true; sms stays false).
- `isMeatspace`: both clauses required (vacuous clause (1) alone is false).

## Fixture note
`fixtures/demo-catalog.json` was regenerated offline
(`collector/collect.ts --input fixtures/real-events.ndjson
--allowlist fixtures/curators.demo.json --no-link-check --now 1791167000`) so the
existing deterministic-replay test in `catalog_test.ts` matches the new
`classify` output (entries now carry `declared` and `meatspace`).

## Test result
`deno test --allow-read --allow-net=127.0.0.1` → **74 passed, 0 failed**.

## Verified, not verified
- **Verified:** full Deno suite green; `deno check` clean on all collector
  modules; headless-Chrome `--dump-dom` render of a synthetic catalog confirms the
  pickup venue shows the meatspace badge, `pickup ~10 min`, per-method prices and
  the settlement rail, while the delivery-only and `sms` services do not.
- **Not verified:** the live relay state — the `cvm:service:meatspace` class tag
  is a parallel change in `contextvm-services` and may not be live yet (treated as
  an additive signal, not a dependency). No live relay was contacted for this
  work (fixtures are offline captures).
