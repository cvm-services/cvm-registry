# The order PWA's happy path, in a browser

`e2e/order-pwa/` drives the customer app that ships at `/order/` — the one that
takes an order and asks a human to send sats for it — through a real browser, and
asserts the money at every step.

```
npm ci
npx playwright install chromium
npm run test:e2e          # hermetic: the whole journey, local stack
npm run test:e2e:live     # E2E_LIVE=1: the same journey against the deploy
npm run test:e2e:headed   # watch it
```

Previously this repo's `e2e/*.mjs` scripts imported the `playwright` library with
no declared dependency and hand-rolled their own pass/fail, so from a fresh clone
they died with `ERR_MODULE_NOT_FOUND: Cannot find package 'playwright'`. This
suite has a real runner (`@playwright/test`), a real assertion library with
auto-waiting (the client re-renders the whole document on every step, which is
where hand-rolled timing flakes), video on, and a fixed 1280x720 viewport.

## What the hermetic run proves

One order, priced by both sides of the wire and asserted at every screen:

| step | asserted |
|------|----------|
| 1 venue list | the catalog loads from `/menu.json` |
| 2 menu | Cheeseburger at 8 900 sats pickup, 9 500 delivery |
| 3 item sheet | sauce/size pick-one, extras add 150/90/120 sats, quantity |
| 4 basket | subtotal 9 050 + 8% fee 724 = **9 774 sats**, from the service's own rules |
| 5 Pay | `POST /api/orders` -> 201, state `awaiting_payment`, **never** `paid` (ADR-0008) |
| 6 invoice | a real BOLT11, decoded by an independent decoder to 9 774 000 msat, plus a QR data URI |
| 7 settlement | mint says PAID -> status timeline: Paid, then placing, placed, ready |
| 8 idempotency | a settled order is not re-transitioned and the rail is not re-asked |

## What is real, and the one thing that is not

| component | in the test |
|-----------|-------------|
| the site (`/order/`, `/menu.json`, `/vocab/`) | **this repo's `site/` tree**, served through the same path map `deploy/deploy-pwa.sh` publishes (`harness/site-server.mjs`) |
| the order service | **the real `cvm-services/cvm-orders` `main.ts`**, run by deno |
| the invoice + QR | the service's own rail client and `npm:qrcode` |
| the mint | **stubbed** (`harness/stub_mint.ts`) |

The mint is the only substitution, because nothing else can settle an invoice
without real sats. The stub is a NUT-04 quote server that returns a real,
decodable BOLT11 for the amount it is asked for and can be settled or expired on
demand over `/__test/*`. Stubbing it keeps the interesting code — the rail's
fail-closed verdict, the invoice endpoint, the QR encoder, the client's state
machine — in the path.

Where the service's checkout comes from, in order: `CVM_ORDERS_DIR`, else a
`--depth 1` clone of `cvm-services/cvm-orders@main` into `.cache/cvm-orders`
(gitignored). The run logs the commit it used, because the spec asserts exact
sats and the commit belongs next to the number it produced.

## The live run reports the deployed truth

`npm run test:e2e:live` drives `https://cvm-pwa.orangesync.tech` with the same
journey and the same assertions. It is opt-in (it creates one order on
production, unpaid and self-expiring) and never skipped silently.

**Current result: FAIL at step 6 — and the stale layer is the CLIENT, not the
service.** Two runs at the head of this branch (2026-10-10T21:28:40Z, 25.1s and
21:29:27Z, 22.1s) both get a **201** from `POST /api/orders`, then die on the pay
screen, which asks the customer for a thousand times what the invoice beside it
charges:

```
[live] +4.5s POST /api/orders answered 201
  Error: the pay screen must quote 9 774 sats, the amount the invoice beside it
         charges. "9 774 000 sats" means the deployed CLIENT is stale ...
  Locator:  locator('.pay h2')
  Expected: "9 774 sats"
  Received: "9 774 000 sats"
```

That is `site/order/app.js` before `52da8e8` (the 1000x pay-screen fix in this
PR) still being served — checkable without a browser: the deployed
`/order/app.js` contains no `satsNative` symbol and still renders
`sats(state.order?.total || total()*1.08)`, and its timeline still reads
`o.status` (`b8678c2`). So the fix for this red is a **deploy**
(`deploy/deploy-pwa.sh` publishes `site/`), not a code change.

The two earlier 409 runs are kept in the same log: they are what this spec
recorded when the SERVICE was the stale layer (pre-hardening build, every POST
colliding on the same undefined order id). Same spec, same assertion, two
different layers — which is why its failure messages name the layer.

### Running the live spec against something other than the deploy

`E2E_LIVE_BASE` points the spec anywhere, which is how its post-Pay assertions
are shown to be executable code rather than dead code (see the `LOCAL-BASE RUNS`
and `MUTATION CHECK` sections of `live-run.log`):

```
node e2e/order-pwa/harness/stack-server.mjs   # boots the hermetic stack, prints its site URL
E2E_LIVE=1 E2E_LIVE_BASE=http://127.0.0.1:<port> npx playwright test --project=live
```

Against a local stack of this branch that is `1 passed`; with the pre-review
assertion form restored it fails with `Expected: "9774000" / Received: undefined`
— the round-1 review finding, reproduced on a real invoice.


## Evidence

| file | what it is |
|------|-----------|
| `order-pwa-happy-path-venue-basket-invoice-settled.webm` | the passing hermetic run, 1280x720, 902 341 bytes, committed by the green run |
| `live-run.log` | every live-lane run verbatim: the two 409 runs (stale SERVICE), the two runs after the service was redeployed (stale CLIENT), and the `LOCAL-BASE RUNS` + `MUTATION CHECK` that show the spec's own post-Pay assertions execute |

The `.webm` is rewritten by every green `npm run test:e2e`, so a local run leaves
the working tree dirty by one file. That is deliberate: the video is the artifact
a reviewer watches instead of running deno themselves.

## Pitfalls worth knowing

- Run it through the runner (`npx playwright test`), not by executing the spec
  file: `@playwright/test` decides the projects and the fixtures.
- `page.waitForResponse(...).text()` can block forever on a body Playwright
  cannot pull from the network stack — the live spec hung 5.8 minutes on a 409.
  Read the failure off the page instead; that is what the customer sees anyway.
- The suite needs deno 2.x on `PATH` (the service and the stub mint are deno) and
  network access on first run (the cvm-orders clone, `npm:qrcode`).
- `npx playwright install chromium` is a real prerequisite, not a formality. With
  an empty `~/.cache/ms-playwright` the run dies in 9ms —
  `browserType.launch: Executable doesn't exist at .../chromium_headless_shell-1248/...`
  — which looks like a spec failure in a log and is not one: no browser, no order,
  no evidence. Install first, then read the log.
