# REPORT — t_e2a7400c: cvm-registry e2e, runnable from a clean clone and honest in CI

Branch `wt/cvm-e2e-runnable` (GitHub `cvm-services/cvm-registry`), mirrored to ngit
as `ci/cvm-e2e-runnable`. Worktree
`/home/c03rad0r/repos/cvm-registry/.worktrees/t_e2a7400c`.

## Outcome

`npm ci && npm run e2e` from a literal empty clone: **4 passed, 0 failed, 0
skipped, exit 0**. ngit CI green on the branch. Every claim below is a command
that was run; nothing is synthesised. Nothing is unpushed.

## Commits (this run)

| commit | what |
|---|---|
| `37eda21` | recovered the S5c nosms proof into this repo's history (5 PNGs extracted from `cb1b12f` in `~/worktrees/t_167558e7` + a README naming the source commit and per-file sha256) |
| `791f5a4` | the CI `e2e` job failed on an evidence convenience, and a bot challenge was recorded as a verified venue page |
| `2269b66` | record the clean-clone run, the CI wiring and the NOT-VERIFIED rule |
| `39e0959` | the summary can no longer call a challenged venue page a pass (cold-review finding + the ffmpeg non-fatal hole) |

Base before this run: `34209ac`. Branch head: `39e0959`.

## Deliverables

1. **The suite runs from a clean clone.** `git clone` into an empty dir (0 changed
   paths, no `node_modules`, no `site/catalog.json`) → `npm ci` → `npm run e2e` →
   4 passed, exit 0. Verbatim, committed:
   `docs/e2e/clean-clone-transcript.txt`. It prints the browser fallback it took
   (no Playwright Chromium in this host's cache revision → system Chrome) instead
   of asserting one.
2. **The CI job is green.** ngit CI at `791f5a4a`: workflow `ci.yml`
   `conclusion: success`, jobs `deno` + `e2e` success, integrity "commit present,
   workflow hash matches". The head before the fix (`34209ac`) failed the same job.
   CI is re-triggered at the new head `39e0959`; status quoted in PROGRESS.md.
3. **The bot challenge cannot be filed as a verified page.** The click-through is
   attempted only when every venue answers the probe cleanly AND there is a headed
   browser, or `E2E_VENUE_PAGES=1`. When it is not attempted, the leg's detail, a
   loud banner and the summary all say NOT VERIFIED, and the per-venue probe is
   printed. A page that answers with a challenge is recorded `challenged: true`.
4. **A cold cross-family review ran and its findings were answered**
   (`docs/e2e/cold-review.md`). It found a genuine silent-green inside the fix
   (the harness derived the summary's note from its own probe, not from what the
   leg saw — and the leg's stdout is inherited, so the summary never read it).
   Fixed in `39e0959` and proven differentially: probe-clear + leg-challenged →
   NOTE appears; leg-verified → no NOTE; nothing else differs between the runs.
5. **The ffmpeg convenience is provably non-fatal, not just asserted.**
   `e2e/transcode_mp4_selftest.py`: 4/4 cases, including the exact CI failure shape
   (Playwright's trimmed build rejects `-movflags +faststart`, exit 8). Reading it
   for the answer found one unguarded `subprocess.run`; it is wrapped now.
6. **The evidence is current and honest.** `docs/e2e/README.md` states which stills
   refresh on every run and which two are from the full-fidelity capture, and why
   re-shooting those here would mean filing a Cloudflare challenge as the venue's
   page. No test double's output is committed as evidence (the fixture rewrite from
   a first attempt at the proof was reverted; evidence was reset before the honest
   run).

## Verification log (real output)

- `npm run e2e:hermetic` — exit 0, twice on the pre-read-back code, once on the
  final code. Final: 2 passed, 0 failed, PASS, with the venue-page sub-assertion
  NOT VERIFIED and said out loud.
- `node --check tools/run-e2e.mjs`, `python3 -m ast` on the leg — ok.
- clean-clone transcript — exit 0, 4/4.
- `python3 e2e/transcode_mp4_selftest.py` — 4/4.
- differential read-back test — A: NOTE present; B (control): no NOTE.
- ngit CI `791f5a4a` — success. ngit CI `39e0959` — triggered, see PROGRESS.md.
- `curl -o /dev/null -w '%{http_code}' https://cvm.orangesync.tech/` — 200.

## Honest status / what is NOT proven

- **The click-through to the venues' own pages did NOT run on this host** (one of
  the two venue hosts does not answer cleanly from here). The suite reports that
  as NOT VERIFIED rather than as a pass — this is by design, not a gap papered
  over. On a host where both venues answer cleanly with a headed browser, the
  click-through runs; the last green full run that exercised it was the
  full-fidelity capture whose stills are committed.
- **CI is green at `39e09593`, not at the literal branch tip.** `ngit ci status
  39e09593` → `conclusion: success`, jobs `deno` + `e2e` success. Every commit
  after that one (`254a090` and any later docs commit, including the one that
  wrote this line) touches no code: Markdown only. So the code state CI measured
  IS the branch's code state; the tip differs from it only in prose. Quoted this
  way on purpose — a run at an earlier SHA is evidence about that SHA, and the
  honest phrasing is "green at X, docs-only after X", not "green at HEAD".
- **Review Q3/Q4 unanswered**: is a skip ever a pass (exit-code accounting), and
  does the CI gate/observational split hide anything a maintainer would want red?
  The reviewer ran out of completion budget. Recorded as the first item in
  PROGRESS.md REMAINING.
- The S5c card's premise (a claimed push that does not exist) is corrected by
  `ls-remote` evidence in PROGRESS.md: the commit IS on `origin`
  (`pr/s5c-playwright-e2e` = `cb1b12f`), the earlier measurement was taken in the
  wrong repo, and the proof now also lives here (`37eda21`).

## Merge note

The branch is pushed to both remotes. Merging to `main` was not done — the card's
review lane owns that decision, and the second review round (Q3/Q4) is still open.
