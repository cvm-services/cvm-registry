# PROGRESS — t_e2a7400c (cvm-registry e2e: runnable from a clean clone + CI)

Crash-recovery map. Newest last. Resume from the REMAINING list at the bottom.

## Landed

- `eb818fa` e2e/browser.mjs — one browser-resolution policy (E2E_CHROMIUM ->
  Playwright's own chromium -> legacy chromium-1243 if present -> system chrome),
  plus `fixtures/e2e-dashboard.catalog.json` (the replayable capture the runner
  provisions `site/catalog.json` from).
- `5aadc49` four real defects fixed in `tools/run-e2e.mjs`, found by RUNNING it:
  1. `createReadStream` imported from node:http (does not export it) -> import died.
  2. loopback server started with `spawnSync` children -> event loop blocked ->
     the child's request to our own server timed out at 30s. Legs now spawn async.
  3. `listen()` not awaited -> first run ERR_CONNECTION_REFUSED. Now waits for
     'listening' and falls back to an ephemeral port when 8099 is busy.
  4. evidence recorded a raw ephemeral port + an absolute home path. Normalised
     (`base` is now the fixed 8099; `catalog` is repo-relative); the deep-link leg
     records which browser it used.
- Package/CI scaffolding was already on this branch from an earlier attempt:
  `package.json` + `package-lock.json` (playwright pinned 1.56.1) and an `e2e`
  job in `.ngit/act/workflows/ci.yml` (`npm ci` + `npm run e2e`).

## Verified by running (not by reading)

- `npm run e2e:hermetic` -> 2 passed, 0 failed, verdict PASS, exit 0.
- `npm run e2e` -> 4 passed, 0 failed, 0 skipped, verdict PASS, exit 0
  (hermetic: catalog_render + venue_deep_link; live: dashboard-discovery under
  xvfb + live_deploy_check against https://cvm.orangesync.tech).

## Finding that contradicts the card's premise

The card says card `t_167558e7` (S5c) claimed a push that does not exist. Measured:

```
cd ~/worktrees/t_167558e7           # the NOSMS repo, not cvm-registry
git ls-remote origin refs/heads/pr/s5c-playwright-e2e
  -> cb1b12f13fa4afe021c481ee6f3fd23df1cf5465  refs/heads/pr/s5c-playwright-e2e
```

The proof commit IS on GitHub origin, and the 5 PNGs + webm ARE tracked at HEAD of
that branch (`docs/e2e/s5c-nosms/`). The earlier "not published" measurement was
taken in cvm-registry, where that commit does not (and should not) exist. ngit is
one commit behind (`cc4cb78`).

## REMAINING

1. Commit the refreshed `docs/e2e/` evidence + README, push the branch.
2. Clean-clone transcript: fresh `git clone` into /tmp, `npm ci`, `npm run e2e`,
   quote the exit 0.
3. s5c: push `pr/s5c-playwright-e2e` (cb1b12f) to ngit so it is dual-published;
   otherwise correct the card with the ls-remote evidence above.
4. CI: get a run at the branch head with `conclusion: success` (live legs must be
   loud-skipped, never silently green) and quote the workflow diff.
5. Cold cross-family review published to the PR, then merge to main.
