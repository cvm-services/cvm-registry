# REPORT — t_e3abf2ae: the facilitator console at /console/ is an installable PWA

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

---

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
