# PROGRESS — t_e3abf2ae: console PWA (/console/ manifest + icons + SW) + vhost pinning

Task: `cvm-registry: make the facilitator console an installable PWA (manifest, icons, SW) + pin it with vhost tests`
Repo `cvm-services/cvm-registry`, base `origin/main` `76b2ef6`.
Worktree `/home/c03rad0r/worktrees/t_e3abf2ae`, branch `worker-base/t_e3abf2ae`.

Test command (NO `deno.json`/`package.json` in this repo; `.ngit/act/workflows/ci.yml` is the CI):
  deno check collector/ tests/
  deno test --allow-read --allow-net --allow-env tests/
Inner loop (card: box is loaded, run only the touched file):
  deno test --allow-read --allow-net tests/pwa_vhost_test.ts tests/order_pwa_installable_test.ts tests/console_pwa_installable_test.ts
Baseline (unmodified main, those 3 files): 24 passed | 0 failed.

## Milestones
- [x] M0 recon: vhost, site/order PWA set, site/console, deploy-pwa.sh, both existing test files.
- [x] M1 RED: 3 console cases appended to tests/pwa_vhost_test.ts + new
      tests/console_pwa_installable_test.ts (13 tests) + 1 refined test in
      tests/order_pwa_installable_test.ts. Captured BEFORE implementing:
      25 passed | 14 failed against unmodified main -> evidence/t_e3abf2ae/RED-console-pwa.txt
- [x] M2 implement: site/console/{manifest.webmanifest,sw.js,index.html,5 icons} +
      deploy/caddy-vhost-cvm-pwa.caddy matcher.
- [x] M3 GREEN: `deno check collector/ tests/` exit 0; touched files 39 passed | 0 failed;
      full suite `deno test --allow-read --allow-net --allow-env tests/` 181 passed | 0 failed
      (166 on main + 15). Evidence: evidence/t_e3abf2ae/{GREEN-touched,GREEN-final,deno-check}.txt
- [x] M4 live BEFORE probe: evidence/t_e3abf2ae/live-BEFORE-console-manifest.txt — the four
      /console/ PWA artifact paths are still 200 text/html (1102 b = the console document).
- [x] M5 REPORT.md final + PR #29 https://github.com/cvm-services/cvm-registry/pull/29
      head b2f82dc93e609f9d4f191fcf2e27b6dde984524f. NOT merged, NOT deployed: manager merges.

## Facts found (do not re-derive)
- The card's "four console artifacts" = manifest + worker + icons; deploy ships `site/console/*`
  with a glob, so no deploy change is needed for the new files (`cp "$REPO"/site/console/*`).
- prepush hooks here are secret-scan gates only (`core.hooksPath=/home/c03rad0r/.git-hooks`),
  they do not run the test suite. Pushing a RED-tests commit is safe.
- `tests/order_pwa_installable_test.ts` had a test that FORBADE the console from having any
  manifest/worker (raw substring checks). It had to be narrowed to the real intent (the console
  must not adopt the ORDER app's identity). site/order/ itself is untouched.
- The vhost `header @pwa_manifest ...` sits BEFORE the handle blocks and only retypes matched
  paths; adding a second literal path cannot re-introduce text/html for unknown paths.
# Task t_889735b3 — Order PWA happy path: real Playwright E2E (local stack + stub mint)
# t_889735b3 — progress map

Task: give the customer order PWA (`/order/`) a real end-to-end Playwright happy
path — venue -> basket -> invoice -> settled — against the real service, with the
mint stubbed, plus a live run against the deploy. Repo: `cvm-services/cvm-registry`
(branch `worker-base/t_889735b3`, PR #25, **not merged** — the manager merges).

## Landed (all pushed)

| commit | what |
|--------|------|
| `81459c3` | Playwright declared as a real dependency of the suite (package.json, lockfile, config) |
| `78c7591` | RED — the spec, with no harness wired yet (fails: no such module) |
| `848fc83` | the harness + the spec: real stack, stub mint, video, the two client defects caught |
| `52da8e8` | fix(order): pay screen quoted 1000x sats ("9 774 000 sats") |
| `b8678c2` | fix(order): status timeline read `o.status` (undefined) instead of `o.state`; "Paid" was hardcoded done |
| `fc38988` | the live spec + its recorded 409, the e2e README, the evidence |
| `cf1e70a` | REPORT.md — what the suite proves, the two defects, the live 409 |
| `2ee68a3` | live-run.log re-verified at head (same 409); the recording re-committed |
| `54c0a73` | clean-clone verification recorded (round 1) |
| `a552acc` | **round 1 rework** — live spec: amount assertion fixed (was dead code), expiry bound, failure messages name the stale layer |
| `f7a8f1b` | docs for the rework: README live section, REPORT round-1 section, `live-run.log` (two fresh deployed runs + local-base pass + mutation check) + `harness/stack-server.mjs` |

## Current state

- Hermetic suite: **GREEN** — `1 passed (30.2s)` at `a552acc`
  (`[e2e] cvm-orders 1ebe0dc (clone of main)`).
- Live suite (`E2E_LIVE=1`, production): **RED at step 6**, and the stale layer
  MOVED since round 1 — the service is now hardened (201), the deployed CLIENT is
  stale (`/order/app.js` without `satsNative`), quoting 9 774 000 sats next to an
  invoice for 9 774. Runs at 21:28:40Z (25.1s) and 21:29:27Z (22.1s) are in
  `docs/e2e/order-pwa/live-run.log`.
- Live spec against a **local stack** (`E2E_LIVE_BASE` + `harness/stack-server.mjs`):
  **GREEN** — `1 passed (13.7s)`, then `1 passed (10.4s)` through the committed
  entry point. This is the evidence that the live spec's post-Pay assertions are
  executable code, which round 1 showed they were not.
- Two client defects found by the suite and fixed in `site/order/app.js`; both had
  to be fixed for the journey to be assertable, both are money-facing.
- PR #25 is open on the branch head, `mergeable: MERGEABLE`, no CI checks
  configured on the repo (rollup empty).
- The green run rewrites its own committed recording
  (`docs/e2e/order-pwa/*.webm`). In this round that rewrite was **reverted** on
  purpose, so the committed blob stays byte-identical to attachment 93
  (`sha256 e2ee74a5ab278a81b329b636f208c1cead047fbc6f01cdc38e80c43a6d13ab52`) —
  the journey is unchanged, so freshness buys nothing and drift costs the
  attachment↔blob identity the reviewer checked.

## Finding log (append-only)

- 2026-10-10 → harness boots in ~8s, whole hermetic journey 11-15s → green
- 2026-10-10 → `.pay h2` read "9 774 000 sats": service sats passed through the EUR
  formatter → fixed (commit 52da8e8)
- 2026-10-10 → status timeline read `o.status` (always undefined) → "Order placed
  at venue" and "Ready for pickup" could never complete; "Paid" hardcoded done
  against ADR-0008 → fixed (commit b8678c2)
- 2026-10-10 → live run: deployed `POST /api/orders` = 409 "order already exists" →
  recorded, not skipped
- 2026-10-10 → `page.waitForResponse().text()` hung 5.8 min on that 409 → spec now
  reads the failure off the page
- 2026-10-10 → promotion run: hermetic re-run at `cf1e70a` green (41.9s) → the
  committed recording was refreshed from that very run (902 341 bytes); live
  spec re-run → same 409, 7.1s, appended to `live-run.log`
- 2026-10-10 → repo is PUBLIC, so the evidence .webm is fetchable without auth:
  https://github.com/cvm-services/cvm-registry/raw/worker-base/t_889735b3/docs/e2e/order-pwa/order-pwa-happy-path-venue-basket-invoice-settled.webm
- 2026-10-10 → clean-clone verification at `2ee68a3` (clone from GitHub, not from
  this worktree): `npm ci` 0 vulnerabilities, `npx playwright test
  --project=hermetic` → `1 passed (28.0s)`. This is the "runnable from a clean
  clone" half of t_e2a7400c, verified independently of the author's tree.
- 2026-10-10 → the video was attached to the card through the SHA-pinned raw URL,
  and the fetched bytes hash-match the committed blob
  (`e2ee74a5ab278a81b329b636f208c1cead047fbc6f01cdc38e80c43a6d13ab52`); the
  branch-pinned raw URL served a stale 740 824-byte copy for minutes, so pin the
  commit when you attach a GitHub artifact.
- 2026-10-10 → **round 1 review: changes requested** (two required, both in the live
  lane) → rework in `a552acc`
- 2026-10-10 → finding 1 confirmed first-hand with a node probe on
  `light-bolt11-decoder@3.2.0`: `section(decoded,"amount")` is the STRING
  `"250000000"` for the BOLT11 vector, so `.value` is `undefined` for every
  invoice ever decoded; `section(decoded,"expiry")` is the number 60 (a delta).
  The old assertion could never pass, on any deploy.
- 2026-10-10 → finding 2 confirmed first-hand without a browser: the deployed
  `/order/app.js` (11 708 bytes, sha256 `438e36e3…`) has **0** occurrences of
  `satsNative`, still one `sats(state.order?.total || total()*1.08)` and four
  `o.status`; this branch's `site/order/app.js` sha256 `0da9d70b…`
- 2026-10-10 → ~/.cache/ms-playwright had been emptied on this host: the first
  live invocation died in 9ms at `browserType.launch` (no browser, no order, no
  evidence). `npx playwright install chromium` fixed it; added to README pitfalls.
- 2026-10-10 → hermetic run at this head rewrote the committed .webm → reverted
  with `git checkout`, identity with attachment 93 kept (see "Current state")
- 2026-10-10 → round-1 rework verified from a clean clone at `f7a8f1b` (clone from
  GitHub): `npm ci` → 0 vulnerabilities; `npx playwright test --project=hermetic`
  → `1 passed (14.8s)`; `node e2e/order-pwa/harness/stack-server.mjs` +
  `E2E_LIVE=1 E2E_LIVE_BASE=… npx playwright test --project=live` → `1 passed (8.4s)`.
  The "runnable from a clean clone" half of t_e2a7400c holds for the reworked spec
  and the new harness file too.
- 2026-10-10 → live project run against the harness's own stack (`E2E_LIVE_BASE`)
  passes; with the pre-review assertion form restored it fails
  `Expected: "9774000" / Received: undefined` → the fix verified, not argued
  (the mutation was reverted; `a552acc` contains the fixed form only)

## Remaining

Implementation: none. Left to the manager, by the card's instruction: re-review
and merge PR #25 (`worker-base/t_889735b3` -> `main`). Expected conflict with
#22 (`wt/cvm-e2e-runnable`) is documented in the PR body as a union resolution.
