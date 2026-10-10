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
