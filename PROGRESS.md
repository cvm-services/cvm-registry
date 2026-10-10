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

Card: cvm-registry PR → main. Branch `worker-base/t_889735b3` from `origin/main` (53cf1a9).

## Plan
1. infra: `package.json` (@playwright/test) + `playwright.config.mjs` (video on, 1280x720)
2. spec RED (harness not wired yet) → quote the failure
3. harness: real `cvm-orders` service + static site server (deploy-pwa.sh path map) + stub Cashu mint (deno, NUT-04/07)
4. spec GREEN: 8 happy-path steps, idempotent poll
5. live spec behind `E2E_LIVE=1` → run it, record the honest result
6. evidence: video committed under docs/e2e/order-pwa/ + attached to the card
7. REPORT.md with "what this does NOT prove"

## Log
- 2026-10-10 21:05 read the card; found the real surface (cvm-orders origin/main main.ts: POST /orders,
  GET /orders/:id, GET /orders/:id/invoice; CashuRail = POST /v1/mint/quote/bolt11 + GET /v1/mint/quote/bolt11/{id}).
- 2026-10-10 21:05 confirmed the PWA proxy contract: Caddy `handle_path /api/*` strips the prefix,
  so the PWA's `/api/orders` reaches cvm-orders `/orders`; deploy-pwa.sh fixes the static path map
  (/order/ → site/order/*, /menu.json → site/menu.json, /vocab/* → vocab/*).
- 2026-10-10 21:06 found a likely REAL defect: site/order/app.js `status()` reads `o.status`, but the
  service returns `state`. Live app.js has the same `o.status`. The timeline can therefore never show
  "Ready for pickup". Card step 7 will fail until that is fixed.
