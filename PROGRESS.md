# PROGRESS — t_cdc4442b: cvm-pwa Caddy vhost, the unscoped catch-all

Task: `https://cvm-pwa.orangesync.tech/api` renders "Loading venues…" forever because the
vhost's UNSCOPED `handle { try_files {path} /order/index.html }` answers 200 + text/html for
every path no earlier handler matched (bare `/api` does not match `handle_path /api/*`).
Deliverable: pushed branch + PR to `main` in cvm-services/cvm-registry. **NOT merged by me.**

Worktree: /home/c03rad0r/worktrees/t_cdc4442b (off origin/main 53cf1a9, branch worker-base/t_cdc4442b)
Test command (no deno.json / package.json in this repo — see .ngit/act/workflows/ci.yml):
  deno test --allow-read --allow-net --allow-env tests/
Baseline before any change: 161 passed | 0 failed.

## Milestones
- [x] M0 recon: vhost, deploy-pwa.sh, rewrite-caddy-vhost.py, existing tests, CI.
- [x] M1 RED: 4 new assertions in tests/pwa_vhost_test.ts — FAILS on the shipped vhost
      (6 passed | 4 failed). Output: /home/c03rad0r/scratch/RED-pwa_vhost.txt
- [ ] M2 fix deploy/caddy-vhost-cvm-pwa.caddy (scoped fallbacks + exact `/api` + root alias).
- [ ] M3 green suite.
- [ ] M4 local Caddy 2.6.2 behavioural before/after matrix (real curl, not text assertions).
- [ ] M5 REPORT.md + PR to main.

## Facts found (do not re-derive)
- CI: `deno check collector/ tests/` then `deno test --allow-read --allow-net --allow-env tests/`.
  No `deno task` indirection exists.
- The deploy BUNDLE is NOT the repo `site/`: deploy-pwa.sh copies only site/order/*,
  site/console/*, site/menu.json, vocab/service-inputs.json (+ site/fixtures). The docroot has
  NO root /index.html, /style.css, /app.js — which is exactly why those paths answered the
  order document.
- app.js fetches `../menu.json` and `../../vocab/service-inputs.json`, i.e. paths OUTSIDE
  /order/. So the catch-all must SURVIVE as a fallback-free file_server; deleting it (instead
  of scoping it) 404s the app's own data and hangs the page the same way.
- Caddy `handle /api` (no `/*`) is an EXACT match — that is the whole defect: `/api` never
  matched `handle_path /api/*`. There is no caddy(1) in this repo's CI; local caddy 2.6.2 was
  extracted from the Debian package for the behavioural check.
- REPORT.md is overwritten per task (previous tasks did the same) — history is in git.
