# PROGRESS — t_324abc50 · facilitator console PWA (/console/)

Branch `pr/facilitator-console`, base `origin/main` 43bb15c (customer PWA + its deploy script already merged).
Worktree `/home/c03rad0r/worktrees/t_324abc50`.

- Recon → the customer PWA is `site/order/` in **cvm-registry** and is live at `cvm-pwa.orangesync.tech`
  (`deploy/deploy-pwa.sh`, host `testserver2.fips`, docroot `/opt/tollgate/cvm-pwa`); the card-custody
  decision is already recorded as **ADR-0013** in contextvm-services; the console is T4 of PLAN-0007.
- Implemented → `site/console/{index.html,app.js,style.css}`: NIP-98 sign-in on `/api/auth/challenge`,
  5-min-SLA paid queue from `/api/orders/queue`, placing pane that hands off to the venue checkout,
  receipt capture, state machine via `POST /api/orders/:id/transition`, settlements pane, ADR-0012
  Nostr-DM escalation that states NOT SENT when it cannot send.
- Invariants are code, not prose → `requireSettled()` gates both fiat-spending paths (place + placed)
  and the place button is dead without it (ADR-0008/0013); `assertNoCardData()` (keys + CVV shape +
  Luhn PAN) runs before every POST, before device storage and before the DM; no card field exists in
  the document at all (ADR-0013).
- Tests → `tests/console_pwa_test.ts`, 8 tests (source contracts + real unit tests on the guards).
  Full suite `deno test --allow-read --allow-net=127.0.0.1`: **142 passed | 0 failed**.
- deploy → `deploy/deploy-pwa.sh` also ships `site/console/` and probes `/console/`. NOT executed
  from this workspace (no live deploy attempted).
- Remaining → (1) live deploy of `/console/` + an `/api` → cvm-orders proxy (the host currently serves
  no `/api` at all, so the customer PWA's pay step 404s too); (2) the T4 happy-path video evidence —
  Playwright + chromium 1228 and ffprobe ARE available on this node, the harness just did not fit this
  run's budget; (3) server-side NIP-98 verification and receipt persistence in cvm-orders.

---

# PROGRESS — t_99fb9b0e · deploy /console/ + close the missing /api proxy

Worktree `/home/c03rad0r/worktrees/t_99fb9b0e` on the same branch (`pr/facilitator-console`),
plus `/home/c03rad0r/worktrees/t_99fb9b0e-orders` for the cvm-orders change.

- Recon -> confirmed the live defect first-hand: `/api/auth/challenge`, `/api/orders/queue`,
  `/console/`, `/order/` and `/health` ALL answered `HTTP 200, 381 bytes, text/html` (the ordering
  SPA fallback). `/order/app.js` and `/menu.json` are byte-identical to the repo (sha256 checked),
  so the customer PWA itself was fine and only the surface was broken.
- cvm-orders -> Deno `serve()` binds `0.0.0.0` by default and the store has no auth; added
  `src/serve_options.ts` (loopback default, `BIND_ADDR` override, PORT validation), used by
  `main.ts`. 3 new tests / 6 pass / `serve_options.ts` 100% line coverage. Branch
  `pr/orders-bind-loopback` @ `0da283f`, pushed, PR https://github.com/cvm-services/cvm-orders/pull/2.
- cvm-registry -> the vhost became a repo file (`deploy/caddy-vhost-cvm-pwa.caddy`) installed by
  `deploy/rewrite-caddy-vhost.py`, which REPLACES an older block for the domain (the old
  append-once logic could never ship the proxy). Added `deploy/orders-setup.sh` +
  `deploy/cvm-orders-remote-setup.sh` (own systemd unit + `/etc/cvm-orders/config.env`), and
  `tests/pwa_vhost_test.ts` (6 tests). Commit `026f2d0`, pushed to `origin/pr/facilitator-console`.
- Deployed -> `cvm-orders.service` active on `127.0.0.1:8788` (`ss` + journal "Listening on
  http://127.0.0.1:8788/"), then `deploy-pwa.sh`: vhost replaced (backup
  `/etc/caddy/Caddyfile.vhostbak-20261010T054635Z`), caddy valid + reloaded, `/console/` = 1102b
  console document + `app.js`/`style.css` 200s, `/api/*` = application/json.
- Down-test -> stopping the service gives `HTTP 502 application/json` on `/api/*` and leaves
  `/console/` + `/order/` at 200; starting it restores `HTTP 200 application/json`.
- Evidence -> `console-signin.png` (2560x1728 live sign-in screen, captured from the deployed URL).
- FINDING (not this card's REQUIRED, reported not fixed): `POST /api/orders` returns 201 with no
  `id` (the PWA sends no id and no `payload` wrapper) and `GET /api/orders/:id/invoice` 404s, so the
  customer pay step is still not completable end-to-end -> follow-up card `t_5198c7da`.
- Remaining -> the T4 happy-path video (`t_4726349b`), the orders API contract fix (`t_5198c7da`),
  and merging cvm-orders PR #2 (`pr/orders-bind-loopback`).
