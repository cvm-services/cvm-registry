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
- [ ] M3 GREEN: deno check + full suite.
- [ ] M4 live BEFORE probe of /console/manifest.webmanifest.
- [ ] M5 REPORT.md final + PR (do NOT merge; manager merges).

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
