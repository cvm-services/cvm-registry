# `site/render/` — the catalog-constrained renderer (ADR-0005, phase-0 spike)

ADR-0005 (`contextvm-services` PR #22) says: **presentation is client-side**. A
service does not publish a page. It publishes a *render spec* that may only name
components and actions the **client** defines. Venues never author layout, and
they never author prices.

This directory is the phase-0 spike of that decision: a build-less vanilla ES
module that turns served data into a spec, and a renderer that paints a spec
only when it can prove the spec is within the catalog.

## Files

| file | what it is |
|---|---|
| `catalog.js` | the component + action catalog **the dashboard defines**. `SPEC_VERSION`, `SPEC_MAX_BYTES`, `COMPONENTS`, `ACTIONS`, prop kinds (incl. `money`), `declaresTool`. |
| `spec.js` | `buildServiceSpec(entry, menuData)` — a **pure** function of served data. Same inputs → byte-identical output. Selects and formats prices; never states one. |
| `renderer.js` | paints a spec into the DOM, or refuses it. Enforces every hard rule. |

## The two hard rules, and where they are enforced

1. **A spec may only name components/actions that exist in the catalog.**
   Anything unknown is ignored, never best-effort guessed (`catalog.js`,
   re-checked independently in `renderer.js`).
2. **A spec may select and format a price; it may never state one.**
   Money-bearing props are declared with the kind `money`, and the renderer
   reproduces every `money` value out of *served* data (`menu` payload /
   `order` basket) before painting it. A hand-injected price is refused, not
   rendered.

Both rules are gated a second time in the renderer (defence in depth), and both
are asserted twice: structurally in `tests/render_spec_test.ts`, and against a
real DOM in `e2e/catalog_render_e2e.mjs`.

## Refusal is the default

A spec is refused **wholesale** (nothing painted) when it is not version 1, or
when it exceeds the 16 KiB cap. Everything else fails closed **per element**
(the offending element is dropped, the rest of the view still renders) — and
every refusal is recorded, so a silent drop is impossible.

The e2e run exercises 13 such cases, including: unknown component, injected
price, injected basket total, spec version 2, oversize spec, a URL inside a
`Facts` row, an `OrderAction` with no declared tool, an `OrderAction` for a tool
the service does not serve, a `HandoffAction` with no published URL, an unknown
action, and a self-referencing spec (must terminate, paint nothing).

## Run it

```bash
# data-level oracle (no network, no browser) — 10 tests
deno test --allow-read tests/render_spec_test.ts

# whole registry suite
deno test --allow-read --allow-net --allow-env tests/

# real chromium, real DOM, real clicks + the fail-closed matrix
node e2e/catalog_render_e2e.mjs          # writes docs/e2e/catalog-render-e2e.json
```

The e2e harness is hermetic: the fixture is served from disk and the venue URL
is **intercepted, never fetched**. It starts its own static server on an
ephemeral port and its own headless chromium.

## Fixture provenance

`site/fixtures/doppelt.catalog.json` is a **real capture**, not invented data:
the `menu` payload came off the live doppelt-Käse venue CVM (`tools/call menu`,
76 items with served `prices_by_order_method`), and the entry is the real
allow-listed announcement. The test suite asserts the provenance block is
present and names the real step it came from, so a hand-written fixture cannot
silently replace it.
