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
(branch `worker-base/t_889735b3`).

## Landed (all pushed)

| commit | what |
|--------|------|
| `81459c3` | Playwright declared as a real dependency of the suite (package.json, lockfile, config) |
| `78c7591` | RED — the spec, with no harness wired yet (fails: no such module) |
| `848fc83` | the harness + the spec: real stack, stub mint, video, the two client defects caught |
| `52da8e8` | fix(order): pay screen quoted 1000x sats ("9 774 000 sats") |
| `b8678c2` | fix(order): status timeline read `o.status` (undefined) instead of `o.state`; "Paid" was hardcoded done |

## Current state

- Hermetic suite: **GREEN** (14.6s -> 10.9s after the journey refactor). Real
  cvm-orders `main.ts` at `1ebe0dc`, real static site, stub mint only.
- Live suite (`E2E_LIVE=1`): **FAILS in 3.5s, as expected** — the deployed service
  answers 409 to every `POST /api/orders` (pre-hardening build). Evidence:
  `docs/e2e/order-pwa/live-run.log`.
- Two client defects found by the suite and fixed in `site/order/app.js`; both had
  to be fixed for the journey to be assertable, both are money-facing.

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

## Remaining

1. Final hermetic run for the committed video, then commit the live spec, README,
   journey module and evidence.
2. REPORT.md + card comment (implementation complete, PR/merge left to the manager:
   branch is pushed, no PR opened — the manager merges).
