# REPORT — t_e3abf2ae: the facilitator console at /console/ is an installable PWA
# REPORT — t_889735b3: the order PWA's happy path, in a real browser

Task: `cvm-registry: make the facilitator console an installable PWA (manifest, icons, SW) + pin it with vhost tests`.
Repo: `cvm-services/cvm-registry`. Base: `origin/main` = `76b2ef6`.
Worktree: `/home/c03rad0r/worktrees/t_e3abf2ae`, branch `worker-base/t_e3abf2ae`.
Merged by the MANAGER — this branch is NOT merged here.

**PR: https://github.com/cvm-services/cvm-registry/pull/29 — open against `main`, NOT merged and NOT deployed.**
Branch `worker-base/t_e3abf2ae`, three commits: `33d1c90` (RED tests) -> `b2f82dc`
(implementation) -> docs/evidence (this file). The exact PR head oid is read from the PR
itself (`gh pr view 29 --json headRefOid`) rather than hard-coded here, because the commit
that writes this report IS the branch tip — a SHA written into a file can never describe
the commit that contains it.

## The defect being closed (measured live 2026-10-11, https://cvm-pwa.orangesync.tech)

`/console/` is a plain page, not an installable PWA:

| probe | live answer before | why |
|---|---|---|
| `/console/manifest.webmanifest` | `200 text/html` | no such file; the SCOPED `/console/` fallback (`try_files {path} /console/index.html`) fired |
| `/console/sw.js` | `200 text/html` | same |
| `/console/icon-192.png` | `200 text/html` | same |

This is NOT the old unscoped-catch-all bug — the vhost scoping landed (PR #26/#27) and
unknown paths 404 correctly. The 200s are the `/console/` fallback answering for paths with
no file behind them, because `site/console/` held only `app.js`, `index.html`, `style.css`.
Net effect: no install prompt, no home-screen icon, no offline shell, and **"absent" and
"broken" are indistinguishable by probing** — both are `200 text/html`.

## Test command (no `deno.json` / `package.json` in this repo — see `.ngit/act/workflows/ci.yml`)

```
deno check collector/ tests/
deno test --allow-read --allow-net --allow-env tests/
```

Inner loop used here (box is heavily loaded, per the card): only the touched test files.

```
deno test --allow-read --allow-net tests/pwa_vhost_test.ts tests/order_pwa_installable_test.ts tests/console_pwa_installable_test.ts
```

Baseline on unmodified main for those three files: **24 passed | 0 failed** (11 vhost + 13 order).
`e2e/order-pwa/` — a Playwright suite that drives the customer app at `/order/`
through the card's eight steps in Chromium, against a real stack: the REAL
`cvm-orders` service (`main.ts`, its own repo, its own pricing and state machine),
the REAL static site from this repo, and a stub mint that is the only substituted
component. Nothing is mocked at the HTTP boundary the browser talks to.

| card step | what the spec asserts |
| --- | --- |
| 1 venue list | `/order/` renders the venues from `/menu.json`, no `.loading` left |
| 2 menu prices | the picked venue's menu renders per-item prices for pickup, and the SAME item re-prices after `delivery` is selected (8 900 → 9 500 sats) |
| 3 options sheet | sauce pills, extras, size, quantity = / − controls, and the live "Add to basket" total (+bacon +150, "Extra cheese" +120, removed again) |
| 4 basket | line 9 050 sats, 8% facilitator fee 724 sats, grand total **9 774 sats / 9.77 €** |
| 5 POST /api/orders | the service prices the same basket to the same sats (subtotal 9050, fee 724, total 9774), answers 201, state `awaiting_payment` — asserted on the wire AND read straight from the service |
| 6 invoice | a real `lnbc…` string on screen, decoded with `light-bolt11-decoder` to 9 774 000 msat, plus a `data:image/svg+xml;base64,` QR image, and the pay screen quotes 9 774 sats |
| 7 settle → ready | the stub mint's quote is settled, the client's refresh shows the rail's verdict, then the facilitator's `placing` → `placed` → `ready` transitions (NIP-98 signed, through the `/api` proxy) walk the four-row timeline to all-done |
| 8 idempotency | after the order is `paid`, two more polls leave `state`, `updatedAt` AND the mint's query count unchanged — a second poll cannot re-transition, and does not even re-ask the rail |

The state machine is driven the way the product is: every expected number is
derived from the pinned `site/menu.json` at the rate both sides use (1 EUR =
1000 sats, Bacon +150 sats, fee = floor(8% of subtotal)). A price drift between
the PWA's menu and `cvm-orders`' catalog fails the suite loudly instead of
quietly shipping a wrong total.

Two projects:
- `hermetic` (default, `npm run test:e2e`) — the whole stack locally. Green.
- `live` (`E2E_LIVE=1 npm run test:e2e:live`) — the same journey against the
  deployed origin. Currently RED, for a reason worth reading: see "The live run".

## Rework round 1 (review findings 1–2)

Review round 1 asked for two corrections, both in the live lane. Both are in
`a552acc`, and both are re-verified below rather than argued.

**Finding 1 — the live spec's amount assertion was dead code.** `section()`
(`harness/journey.mjs:41`) already unwraps a BOLT11 section's value, and
`light-bolt11-decoder@3.2.0` hands the amount back as a STRING of msat, so
`section(decoded, "amount").value` was `undefined` and the assertion could never
pass for any invoice on any deploy — silently, because nothing runs the live lane
in CI. Fixed to `expect(section(decoded, "amount")).toBe(String(MONEY.total * 1000))`,
the form the hermetic spec always had. Reproduced, not reasoned: with the old form
restored, the live project against a LOCAL stack of this branch fails

```
    Error: expect(received).toBe(expected) // Object.is equality
    Expected: "9774000"
    Received: undefined
```

and with the fixed form the same run passes — `1 passed (13.7s)`, reaching
`[live] +4.0s invoice rendered and decoded`. Both runs are verbatim in
`docs/e2e/order-pwa/live-run.log` under `LOCAL-BASE RUNS` and `MUTATION CHECK`.
The thing that made this checkable without a green deploy is committed as
`e2e/order-pwa/harness/stack-server.mjs` + `E2E_LIVE_BASE`, documented in the
README and re-verified through the committed file (`1 passed (10.4s)`).

**Finding 2 — the recorded live result no longer described the deploy.** The box
was hardened and the order service redeployed after the round-1 409 runs, so the
failure moved one layer: `POST /api/orders` now answers **201**, and the run dies
at step 6 on `.pay h2` — the deployed CLIENT still quotes 9 774 000 sats against
an invoice for 9 774. Two fresh runs at this head (21:28:40Z, 25.1s; 21:29:27Z,
22.1s) are appended verbatim to `live-run.log`; the README and this report now
attribute the red to the stale client, and the 409 runs stay as the record of when
the service was the stale layer. Corroboration that needs no browser: the served
`/order/app.js` (sha256 `438e36e3…`) has no `satsNative` symbol, still renders
`sats(state.order?.total || total()*1.08)` and still reads `o.status`, where this
branch's `site/order/app.js` (sha256 `0da9d70b…`) does none of those.

Optional items from the same review, both done: the `x` (expiry) tag is bounded
instead of "asserted" (`> 0` on a second-delta asserted nothing), and the
recording is no longer described as "~740 KB". The recording itself was **not**
refreshed in this round: the green hermetic run at this head rewrote it and that
rewrite was reverted, because the journey it records is unchanged (`site/order/app.js`
and `order-happy-path.spec.mjs` are untouched since `cf1e70a`), and the committed
bytes are the ones already attached to this card as attachment 93 — keeping the
attachment byte-identical to the committed blob (`sha256 e2ee74a5…`) is worth more
than a cosmetically newer file. `git checkout` restored it; the working tree has no
video change in this round.


## RED first

The spec landed before the harness did, and it was red for a real reason
(`78c7591`, quoted from that commit):

```
Error: Cannot find module
  '/home/c03rad0r/worktrees/t_889735b3/e2e/order-pwa/harness/stack.mjs'
  imported from .../e2e/order-pwa/order-happy-path.spec.mjs
Error: No tests found
```

## The two defects the suite found in the shipped client

Both are in `site/order/app.js`, both were found by this suite rather than by
reading it, both have their own commit with the failing output quoted in it:

**1. The pay screen quoted 1000x the price** (`52da8e8`). `state.order.total`
from the service is integer SATS, but it was passed through `sats()`/`fiat()`,
which exist to scale EUR by 1000. The customer, on the screen where they are
asked to send money, was shown:

```
    - Expected string: "9 774 sats"
    + Received string: "9 774 000 sats"
```
Fixed by formatting the service's value as sats directly (`satsNative`/
`eurOfSats`) instead of round-tripping it through the EUR helpers.

**2. The status timeline read a field the service never sends** (`b8678c2`).
The timeline read `o.status`; the order payload has `state`. So "Order placed at
venue" and "Ready for pickup" could never light up:

```
    - locator resolved to <span class="dot ">·</span>
    - Expected pattern: /\bdone\b/
```
The same line made the second row ("Facilitator placing your order") light up
whenever the state was anything other than the literal `"paid"`, i.e. always.
While fixing it, the first row was made honest too: it was hardcoded `true`, so
the timeline claimed "Paid — Payment received" before the rail had verified
anything, which is exactly what ADR-0008 forbids. Every row is now derived from
`state`, and the spec asserts the progression in that order (nothing done →
`paid` → `placing`/`placed`/`ready`).

If either fix is unwelcome in this PR, say so and they split out cleanly — the
suite keeps failing without them, which is the point.

## Evidence

## M1 — RED (captured BEFORE implementing)

The new tests were written first and run against the **unmodified** tree (`76b2ef6`).
Raw output: `evidence/t_e3abf2ae/RED-console-pwa.txt`.

```
$ deno test --allow-read --allow-net tests/pwa_vhost_test.ts tests/order_pwa_installable_test.ts tests/console_pwa_installable_test.ts
...
error: Error: missing file: site/console/manifest.webmanifest
    at read (file:///home/c03rad0r/worktrees/t_e3abf2ae/tests/console_pwa_installable_test.ts:55:11)

the console client at /console/ is unaffected by the order PWA => ./tests/order_pwa_installable_test.ts:473:6
error: AssertionError: the console links its OWN manifest (a relative href resolves to /console/manifest.webmanifest)

both PWA manifests are retyped as manifest JSON through a specific path list => ./tests/pwa_vhost_test.ts:264:6
error: Error: the manifest content-type matcher does not cover /console/manifest.webmanifest (paths: /order/manifest.webmanifest) — …

 FAILURES

every console PWA artifact exists on disk, under /console/ => ./tests/console_pwa_installable_test.ts:288:6
console manifest: valid JSON that scopes the app to /console/ in standalone mode => ./tests/console_pwa_installable_test.ts:313:6
console manifest: icons are real PNGs on disk whose bytes match their declared sizes => ./tests/console_pwa_installable_test.ts:340:6
console index.html links the manifest, an apple-touch-icon, and registers the worker — guarded => ./tests/console_pwa_installable_test.ts:377:6
console sw.js lives at /console/sw.js, its shell allow-list is /console/-only and lists only shipped files => ./tests/console_pwa_installable_test.ts:400:6
console sw.js: the fetch handler refuses /api/** before it can reach any cache => ./tests/console_pwa_installable_test.ts:422:6
console sw.js install: caches the whole shell from the network and nothing from /api/ => ./tests/console_pwa_installable_test.ts:437:6
console sw.js: a GET to /api/ is never intercepted and never cached => ./tests/console_pwa_installable_test.ts:455:6
console sw.js: POST /api/orders and cross-origin requests are left to the network => ./tests/console_pwa_installable_test.ts:464:6
console sw.js: offline, /console/ is served from the cache (and a deep link falls back to the console shell) => ./tests/console_pwa_installable_test.ts:479:6
console sw.js activate: drops this app's stale caches, keeps the order app's and others' => ./tests/console_pwa_installable_test.ts:499:6
the order app and the money API are unaffected by the console PWA => ./tests/console_pwa_installable_test.ts:518:6
the console client at /console/ is unaffected by the order PWA => ./tests/order_pwa_installable_test.ts:473:6
both PWA manifests are retyped as manifest JSON through a specific path list => ./tests/pwa_vhost_test.ts:264:6

FAILED | 25 passed | 14 failed (1s)
error: Test failed
```

Every failure is the defect, not a compile error: `missing file: site/console/manifest.webmanifest`
is the live `200 text/html` seen from inside the repo, and the vhost failure names the exact
matcher that is missing `/console/manifest.webmanifest`.

Two of the three new vhost tests already PASS on the shipped config — deliberately:
`the console falls back to the console document only` and `no document-producing handler is
reachable from an /api path` are the NON-REGRESSION guards for behaviour that is already
correct (scoped `/console/*` fallback; `/api/*` is a stripping proxy) and must survive this
change. They are not part of the RED count.

## M2 — implementation

See the commit list in this branch. Files:

1. `site/console/manifest.webmanifest` — new. `id`/`start_url`/`scope` all `/console/`,
   `display: standalone`, `#rrggbb` theme/background colours, 4 icons (2 `any`, 2 `maskable`),
   and it names nothing under `/order/`.
2. `site/console/icon-192.png`, `icon-512.png`, `icon-maskable-192.png`, `icon-maskable-512.png`,
   `apple-touch-icon.png` — new, **byte-identical copies of the order app's set** (the card
   allows this and forbids hand-drawn PNGs). `cmp` proof in the evidence section below.
3. `site/console/sw.js` — new. Console shell precached; `/api/**` structurally refused (early
   `return` before `respondWith`, same shape as `site/order/sw.js`); its own path fixes the
   scope to `/console/`; the cache prefix is `cvm-console-` so `activate` never deletes the
   order app's `cvm-order-*` caches on the shared origin.
4. `site/console/index.html` — `<link rel="manifest">`, `apple-touch-icon`, `theme-color`,
   apple meta tags, and a feature-guarded, `.catch()`-guarded service-worker registration
   pinned to `scope: "/console/"`.
5. `deploy/caddy-vhost-cvm-pwa.caddy` — the `@pwa_manifest` matcher gains
   `/console/manifest.webmanifest` as a second LITERAL path. Nothing else in the vhost changes:
   `/api`, `/api/*`, `/`, `/order/*` and the fallback-free catch-all are untouched.
6. `tests/pwa_vhost_test.ts` — 3 console vhost cases (RED).
7. `tests/console_pwa_installable_test.ts` — new, 12 tests mirroring
   `tests/order_pwa_installable_test.ts` (artifacts on disk, manifest scope, real-PNG icon
   sizes, the worker evaluated against an in-memory CacheStorage/fetch double, offline shell,
   activate hygiene, no-collateral).
8. `tests/order_pwa_installable_test.ts` — ONE test refined, see "What this branch had to
   touch outside the card's list".

### What this branch had to touch outside the card's list (called out for the reviewer)

`tests/order_pwa_installable_test.ts :: the console client at /console/ is unaffected by the order PWA`
asserted, as raw substrings,

```
assert(!consolePage.includes("manifest.webmanifest"), "the console must not link the order manifest");
assert(!consolePage.includes("serviceWorker"), "the console must not register the order worker");
```

Those two assertions encode the pre-console-PWA world: they forbid the console from having a
manifest or a worker **at all**, which is exactly what this card makes it do. The intent was
always narrower — the console must not adopt the *order* app's identity. The test now asserts
that intent directly and strictly:

```
!consolePage.includes("/order/manifest.webmanifest")   // never the ORDER manifest
!consolePage.includes('scope: "/order/"')              // never the ORDER worker scope
 consolePage.includes('href="manifest.webmanifest"')   // the console's OWN manifest
 consolePage.includes('scope: "/console/"')            // scoped to /console/ only
```

This is a test file, not `site/order/` — the frozen customer PWA is byte-identical on this
branch (see the `git diff --stat` in the evidence section).

## M3 — GREEN

```
$ deno check collector/ tests/
(exit 0 — no output; full log evidence/t_e3abf2ae/deno-check.txt)

$ deno test --allow-read --allow-net tests/pwa_vhost_test.ts tests/order_pwa_installable_test.ts tests/console_pwa_installable_test.ts
ok | 39 passed | 0 failed (1s)          # 24 baseline + the 15 added
                                          evidence/t_e3abf2ae/GREEN-touched.txt

$ deno test --allow-read --allow-net --allow-env tests/
ok | 181 passed | 0 failed (8s)         # 166 on main + 15
                                          evidence/t_e3abf2ae/GREEN-final.txt
```

So: **RED 25 passed | 14 failed → GREEN 39 passed | 0 failed** on the touched files, and the
repo's own CI commands (`deno check collector/ tests/`, the full `deno test ... tests/`) are
green with no other test regressed.

The console worker is not asserted by grep alone: `tests/console_pwa_installable_test.ts`
evaluates the shipped `site/console/sw.js` against an in-memory `CacheStorage`/`fetch` double,
so these are OBSERVED rather than assumed:

- `GET /api/orders/42` is never `respondWith()`ed, no cache ever holds an `/api` URL, and the
  worker does not even fetch it itself (`sw.fetched === []`) — the money API is untouched.
- `POST /api/orders/42/transition` likewise (a state-and-money change is never replayed).
- install caches every shell entry and nothing from `/api/`; offline `/console/` renders from
  cache and an offline deep link falls back to the console document.
- `activate()` purges `cvm-console-shell-v0` and never touches `cvm-order-shell-v1` or
  `workbox-precache` (CacheStorage is per-origin, not per-scope).

Non-vacuity controls for the RED/GREEN pair: the two new vhost cases that already passed
before the change (`the console falls back to the console document only`,
`no document-producing handler is reachable from an /api path`) are the guards that FAIL if
this branch over-reaches — e.g. if a `try_files` ever appeared on an `/api`-scoped handler or
the catch-all, or if the console document became reachable from two handlers.

## M4 — live probe (BEFORE) — deploy is NOT part of this card

Raw: `evidence/t_e3abf2ae/live-BEFORE-console-manifest.txt`, captured 2026-10-11T16:08+02:00
against https://cvm-pwa.orangesync.tech at branch head (the host still runs the merged-main
bundle, so this is the un-deployed state):

```
/console/manifest.webmanifest      200 ct=text/html; charset=utf-8 bytes=1102
/console/sw.js                     200 ct=text/html; charset=utf-8 bytes=1102
/console/icon-192.png              200 ct=text/html; charset=utf-8 bytes=1102
/console/apple-touch-icon.png      200 ct=text/html; charset=utf-8 bytes=1102
/console/                          200 ct=text/html; charset=utf-8 bytes=1102
/order/manifest.webmanifest        200 ct=application/manifest+json bytes=1012   <- control
/order/sw.js                       200 ct=text/javascript; charset=utf-8 bytes=5505 <- control
/api/health                        200 ct=application/json bytes=11             <- control
/nope.txt                          404   <- control: the ROOT catch-all still 404s
/nope/deep                         404   <- control
/console/nope.txt                  200 ct=text/html; charset=utf-8               <- BY DESIGN
```

The first 1102 bytes of `/console/manifest.webmanifest` are `<!doctype html> … <title>Facili…`
— the console document, i.e. the scoped `/console/` fallback, exactly as the card measured it.

Honest statement of what is NOT done: **no deploy was attempted** (the card excludes it), so
there is no "after" yet. The live origin still answers `200 text/html` for
`/console/manifest.webmanifest` at the time of this report. After the manager merges and the
host is deployed, the four `/console/` PWA-artifact rows must flip to
`application/manifest+json` (manifest), `text/javascript` (worker) and `image/png` (icons);
`deploy/deploy-pwa.sh` needs no change for that — it already ships `site/console/*` with a
glob and already asserts that `/console/` serves the console's own document.

One measured nuance, stated so it is not mistaken for a regression:
`/console/nope.txt` answers `200 text/html` because `handle /console/*` is
`try_files {path} /console/index.html` and the console is in-page state with no URL router.
That is the intended scoped fallback, not the unscoped-catch-all defect. The card's
"an unknown path is still 404" refers to the ROOT catch-all, which still 404s (`/nope.txt`,
`/nope/deep` above) and is pinned by `tests/pwa_vhost_test.ts`.

## Files in this branch

```
deploy/caddy-vhost-cvm-pwa.caddy                     (matcher: +1 literal path)
site/console/manifest.webmanifest                    (new)
site/console/sw.js                                   (new)
site/console/index.html                              (manifest/apple/theme + registration)
site/console/icon-192.png                            (new, byte-identical to site/order/)
site/console/icon-512.png                            (new, byte-identical)
site/console/icon-maskable-192.png                   (new, byte-identical)
site/console/icon-maskable-512.png                   (new, byte-identical)
site/console/apple-touch-icon.png                    (new, byte-identical)
tests/console_pwa_installable_test.ts                (new)
tests/pwa_vhost_test.ts                              (+3 console cases)
tests/order_pwa_installable_test.ts                  (1 test narrowed to its real intent)
evidence/t_e3abf2ae/                                 (raw RED / GREEN / deno check / live probe)
REPORT.md, PROGRESS.md
```

`site/order/` is byte-identical to `main` on this branch; the `/api` contract is unchanged.
Commands run, and what they actually printed:

| command | result |
| --- | --- |
| `npm run test:e2e` (in this worktree) | `1 passed` — hermetic journey, incl. the settlement |
| `npm run test:e2e` at this round's head (`a552acc`) | `1 passed (30.2s)`, `[e2e] cvm-orders 1ebe0dc (clone of main)` |
| fresh clone of this branch + `npm ci` + `npm run test:e2e` | `added 15 packages in 4s`, then `1 passed (24.8s)` — no undeclared prerequisites |
| `deno test --allow-all --no-check tests/` | `161 passed \| 0 failed (7s)` — the existing suite, unbroken |
| `E2E_LIVE=1 npm run test:e2e:live` (production, this head) | **fails at step 6** in 25.1s / 22.1s — 201, then `.pay h2` "9 774 000 sats" vs the invoice's 9 774; see below |
| live project vs a **local** stack (`E2E_LIVE_BASE=…`) | `1 passed (13.7s)` — and `1 passed (10.4s)` through the committed `harness/stack-server.mjs`; proves the live spec's post-Pay assertions execute |

Artifacts, committed under `docs/e2e/order-pwa/`:
- `order-pwa-happy-path-venue-basket-invoice-settled.webm` (902 341 bytes) — the full
  green journey, recorded by Playwright. This is the artifact to watch: it shows
  the venue list, the prices, the options sheet, the basket maths, the QR + real
  invoice, and the timeline walking to "Ready for pickup".
- `live-run.log` — the deployed runs verbatim (five sections: the two 409 runs,
  the two runs after the service was redeployed, the local-base pass, the mutation
  check).
- `README.md` — how to run it, what is real vs stubbed, and the pitfalls
  (including one that cost this task two 5-minute timeouts: `response.text()` on
  a response body Playwright cannot retrieve from the network stack blocks until
  the test timeout, so the live spec reads the failure off the page instead).

## The live run — the deploy gate, stated honestly

`E2E_LIVE=1 npm run test:e2e:live` drives the same journey against
`https://cvm-pwa.orangesync.tech` and asserts the same money. It is RED, and since
round 1 the red has moved one layer. Re-run at this head on 2026-10-10
(21:28:40Z and 21:29:27Z, 25.1s and 22.1s — both runs verbatim in
`docs/e2e/order-pwa/live-run.log`):

```
[live] +4.5s POST /api/orders answered 201

  Error: the pay screen must quote 9 774 sats, the amount the invoice beside it
         charges. "9 774 000 sats" means the deployed CLIENT is stale ...
  Locator:  locator('.pay h2')
  Expected: "9 774 sats"
  Received: "9 774 000 sats"
```

The deployed **service** is now the hardened build — it opens the order (201,
`awaiting_payment`) — and the deployed **client** is stale by one commit:
`/order/app.js` from before `52da8e8` still formats the service's integer sats as
if they were EUR, so the customer is asked for a thousand times the amount of the
invoice displayed beside it on the same screen. That is the same defect this PR
fixes in-tree; the fix for the live red is `deploy/deploy-pwa.sh` publishing
`site/`, not a code change in this branch.

The two earlier 409 runs are kept in the log: they are the **service**-layer red
this spec recorded before the redeploy (`store.create(undefined, …)`, so every POST
collides) — the same spec, the same assertion, a different stale layer, which is
why its failure messages now name the layer.

That the live spec's own post-Pay assertions execute at all is new information from
this round: they never had, on any run, on any deploy (finding 1). The
`LOCAL-BASE RUNS` and `MUTATION CHECK` sections of the log show the pass and the
failure of the pre-review form, and `e2e/order-pwa/harness/stack-server.mjs`
commits the entry point that makes it reproducible.


## Coverage

Measured, not claimed:

- `deno test --allow-all --no-check --coverage=/tmp/cov tests/` → **85.5% line /
  66.4% branch / 76.8% function** repo-wide. `site/order/app.js` does **not**
  appear in that report at all (`deno coverage --include='site/order'` →
  "No covered files included"), i.e. the file this suite exists for has no deno
  coverage. `site/console/app.js`, for contrast, shows 80.7%.
- `npm run test:e2e` does not produce a coverage number. Playwright does not
  instrument the app, so I am not quoting one: the honest statement is that the
  browser suite is 1 test covering the money path end-to-end, and it is the only
  thing in this repo that executes `site/order/app.js` at all.

## What this does NOT prove

- **Not a payment.** The mint is a stub (`e2e/order-pwa/harness/stub_mint.ts`): a
  real, decodable BOLT11 invoice for the right amount, and a settle-on-command
  endpoint. No Lightning node, no real liquidity, no real `payment_hash` that
  any node would settle. The hermetic journey proves the app and the service
  agree about amounts, states, and ids — not that money can move.
- **Not the deployed build.** The hermetic run exercises `origin/main` of
  `cvm-orders` and *this* `site/order/`, not what is on the box. The live run is
  the one that touches production, and it stops at the pay screen: it cannot
  settle an invoice it does not control, and it does not assert the timeline.
- **Not a green live lane.** The live lane is red today for a deploy reason (the
  box serves a stale client); nothing in this PR can turn it green, and its red is
  not evidence about this branch. `E2E_LIVE_BASE` +
  `e2e/order-pwa/harness/stack-server.mjs` is how the live spec's own code path is
  exercised instead — and that run is a local stack, so it is not evidence about
  the deploy either.
- **Not the facilitator console.** `/console/` has its own suite.
- **Not happy-path-only correctness.** Deliberately absent: expired quotes,
  refunds, the `409 order_not_priced` invoice path, double-submit, network loss
  mid-invoice, the delivery-fee edge, and the `contact.phone` validation the
  service does not enforce. The suite is one happy path plus the idempotency
  assertion; the unhappy paths are still unproven.
- **Not a11y, layout, or another browser.** Chromium only, no viewport matrix.

## How to run, and the two things a reviewer should know

```
npm ci
npx playwright install chromium     # once per machine
npm run test:e2e                    # hermetic, ~25s
E2E_LIVE=1 npm run test:e2e:live    # against the deployed origin
node e2e/order-pwa/harness/stack-server.mjs   # optional: live spec vs a local stack
```

Verified from a clean clone of this branch (`2ee68a3`, cloned from GitHub rather
than from the authoring worktree): `npm ci` → 0 vulnerabilities, then
`npx playwright test --project=hermetic` → `1 passed (28.0s)`.

1. **The suite needs `cvm-orders`.** It runs the real service. With no
   `CVM_ORDERS_DIR` set it clones `main` into `.cache/cvm-orders` (gitignored,
   shallow) and prints the commit it resolved, `[e2e] cvm-orders 1ebe0dc (clone
   of main)`. Point `CVM_ORDERS_DIR` at a checkout to iterate on the service
   without cloning. This is the one prerequisite worth arguing about: the
   alternative — importing the service into this repo — is exactly the coupling
   the two-repo split exists to prevent.
2. **A green hermetic run rewrites its own committed recording.** Playwright
   finalises video at context close, so the file in `docs/e2e/order-pwa/` is
   replaced on every green run and the tree goes dirty. Re-commit it when the
   journey changes; the committed one is 902 341 bytes. This round deliberately
   reverted that rewrite (`git checkout -- docs/e2e/order-pwa/*.webm`): the journey
   is byte-for-byte the same one, and the committed file is the blob attached to
   this card, so identity between the two was kept over freshness.

`REPORT.md` at the root is rolled per task in this repo (this file replaces the
`t_324abc50` console report, as `5f5f207` replaced the `t_99fb9b0e` one before it).
