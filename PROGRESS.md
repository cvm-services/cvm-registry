# PROGRESS — feat/pwa-installable (order client PWA)

Goal: make `site/order/` genuinely installable (Chrome/Android install prompt +
iOS Add-to-Home-Screen) without changing any behaviour the customer relies on.
Deliverable: pushed branch + open PR to `main`. NOT merged by me.

Worktree: /home/c03rad0r/worktrees/pwa-installable (off origin/main a7a2647)
Test command (repo declares no deno.json/package.json — see .ngit/act/workflows/ci.yml):
  deno test --allow-read --allow-net --allow-env tests/

Baseline (before any change): 148 passed | 0 failed.

## Plan / milestones
- [x] M0 reconnaissance: read order client, deploy script, vhost, existing tests.
- [ ] M1 RED tests committed first (tests/order_pwa_installable_test.ts).
- [ ] M2 manifest.webmanifest + real raster PNG icons (+ apple-touch-icon).
- [ ] M3 sw.js (network-first, /api/** never cached) + index.html wiring.
- [ ] M4 deploy-pwa.sh + Caddy vhost content-type for .webmanifest.
- [ ] M5 REPORT.md + PR.

## Facts found (do not re-derive)
- test cmd: `deno test --allow-read --allow-net --allow-env tests/` (no deno task).
- order client fetches `../menu.json` (= /menu.json) and
  `../../vocab/service-inputs.json` — BOTH OUTSIDE /order/, so outside any SW
  scope anchored at /order/. Offline can therefore only cover the app shell.
- Caddy vhost sends `header Cache-Control "no-store"` for the whole origin
  (incl. the console) — leave it alone; Cache API ignores it.
- deploy-pwa.sh line 25 `cp "$REPO"/site/order/* "$BUNDLE/order/"` already globs
  everything non-dot in site/order/, so new assets ship — but nothing verifies them.
