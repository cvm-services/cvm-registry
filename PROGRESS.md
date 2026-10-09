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

## Landed since (this run)

- `37eda21` test(e2e): recovered the S5c nosms proof into **this** repo's history —
  the 5 PNGs extracted from `cb1b12f13fa4afe021c481ee6f3fd23df1cf5465`
  (`~/worktrees/t_167558e7`) + a `docs/e2e/s5c-nosms/README.md` naming the source
  commit and sha256 of each still.
- `791f5a4` fix(e2e): the CI e2e job failed on an evidence convenience, and a bot
  challenge was recorded as a verified venue page. Two real defects:
  1. `transcode_mp4` was fatal when ffmpeg was absent -> an evidence convenience
     could fail CI. Now best-effort, never fatal (system ffmpeg, then Playwright's
     bundled ffmpeg-linux, then SKIP).
  2. the click-through recorded a Cloudflare interstitial ("Just a moment...") as a
     verified venue page. Now the page is classified (`challenged: true`) and the
     click-through is gated on `pagesClean` (every venue answered the probe) AND a
     headed browser, or `E2E_VENUE_PAGES=1`. When it is not attempted the leg says
     NOT VERIFIED, prints the per-venue probe, and the SUMMARY repeats it.
- `docs/e2e/README.md` + `docs/e2e/clean-clone-transcript.txt` document the CI wiring,
  the NOT-VERIFIED sub-assertion semantics, and which stills refresh per run.

## Verified by running (not by reading) — this run

- `npm run e2e:hermetic` x2 -> exit 0 (`/tmp/e2e-hermetic.log`, `/tmp/e2e-hermetic2.log`).
- `node --check tools/run-e2e.mjs` + `ast.parse(e2e/venue_deep_link_e2e.py)` -> ok.
- challenge matcher re-checked against 5 titles (CI's title + 2 real venue pages) -> correct.
- **literal clean-clone**: `git clone` (working tree 0 changed, no node_modules, no
  site/catalog.json) -> `npm ci` -> `npm run e2e` -> **4 passed, 0 failed, 0 skipped,
  exit 0** (`docs/e2e/clean-clone-transcript.txt`).
- **ngit CI at `791f5a4a`**: workflow `ci.yml` `conclusion: success`, `job deno
  success`, `job e2e success`, integrity "commit present, workflow hash matches".
  The prior head `34209ac` failed the same job — that is the regression this fixes.
- live origin `https://cvm.orangesync.tech/` -> http 200.

## REMAINING

1. Cold cross-family review of the branch diff, findings answered or fixed.
2. Publish the review verdict + the evidence links on the PR, then merge
   `wt/cvm-e2e-runnable` -> `main`.
3. Out of scope for this card (different repo): dual-publish `pr/s5c-playwright-e2e`
   (cb1b12f, NOSMS repo) to ngit. The card premise is already corrected by the
   `ls-remote` evidence above, and the proof now also lives in this repo (`37eda21`).
