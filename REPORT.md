# Task t_38f95d16

Implemented the customer ordering PWA at `site/order/` with six catalog-constrained screens: venue list, menu, item/options, basket, invoice payment, and polled order status. The form is generated from `vocab/service-inputs.json`; only `contact.phone` is required, and the client never stores keys or fabricates invoices. Added static Deno tests for route structure, register-driven inputs, real order/invoice/status endpoints, and sold-out behavior.

Verification: `deno check site/order/app.js`; `deno test --allow-read tests/order_pwa_test.ts` (4 passed); full `deno test --allow-read --allow-net=127.0.0.1` (123 passed).

Remaining operational work: run the mandatory Playwright single-test video against a live order service and attach/probe the resulting artifact; this workspace has no existing Playwright config or live cvm-orders endpoint.

---

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
- **CI evidence at the branch head.** The workflow is triggered at the commit this
  report describes, and that run's conclusion is quoted in full on PR #22 and in
  the kanban handoff — a commit cannot contain the verdict of a run at itself, and
  the previous version of this bullet is exactly what happens when one is written
  anyway. It claimed "every commit after `39e09593` is Markdown-only … the tip
  differs from it only in prose". That was **false**: `git diff --name-only
  39e0959..HEAD` lists 20 non-document paths — `site/order/*`,
  `tests/order_pwa_test.ts`, `tests/pwa_emulator_harness_test.ts`,
  `deploy/deploy-pwa.sh`, `tools/pwa-emulator-test/*` — brought in by the merge
  `5997648`, which pulled `origin/main` (another card's ordering-PWA work) into
  this branch. None of them is an input to the `e2e` job, which is why that job
  still gates what it claims to gate; but the sentence was wrong, it is gone, and
  the claim is now backed by a run at the head itself.
- **Review Q3/Q4 unanswered**: is a skip ever a pass (exit-code accounting), and
  does the CI gate/observational split hide anything a maintainer would want red?
  The reviewer ran out of completion budget. Recorded as the first item in
  PROGRESS.md REMAINING.
- The S5c card's premise (a claimed push that does not exist) is corrected by
  `ls-remote` evidence in PROGRESS.md: the commit IS on `origin`
  (`pr/s5c-playwright-e2e` = `cb1b12f`), the earlier measurement was taken in the
  wrong repo, and the proof now also lives here (`37eda21`).

## Rework round — review round 1 (CHANGES REQUESTED) answered

Review verdict: `changes_requested`, run 266, head `5997648`, full text on PR #22
(`issuecomment-6096273561`). Two blocking findings, both correctable; both are
closed here. Nothing the reviewer marked VERIFIED GOOD was redone.

1. **The tip had no CI evidence, and the sentence standing in for it was false.**
   The false sentence is corrected above and in `PROGRESS.md`; the claim is now
   backed by a workflow run at the head (`ngit ci trigger`, kind-9840 Manual
   Trigger), whose conclusion is quoted on PR #22 and in the kanban handoff. The
   reviewer was right on the measurement: `ngit_ci_evidence.py cvm-registry
   --commit 5997648…` returned exit 2 — 0 kind-9842 events — at the merge commit.
2. **`docs/e2e/02b-venue-page-doppelt-kaese-berlin.png` was a blank frame filed as
   the venue's page.** Commit `34209ac` had overwritten it (368501 → 17602 bytes,
   no re-shoot mentioned in the message); the committed file measured mean 0.996 /
   std 0.041 / 997 colours with **zero** OCR text, against a real page. Restored by
   re-shooting it through this repo:

   ```
   xvfb-run -a python3 tools/capture_venue_page.py doppelt-kaese-berlin --headed
   [capture] title='Speisekarte | doppelt Käse Berlin' final_url=https://www.doppelt-kaese-berlin.de/speisekarte/doppeltkase browser=system chrome (channel=chrome)
   [capture] wrote docs/e2e/02b-venue-page-doppelt-kaese-berlin.png (368501 bytes, sha256 0f99aacd363b81bfa39e9c656103c128913ce229fcf002cdfc774a8732f53553)
   ```

   That output is **byte-identical** to the full-fidelity still at `69a0819` — so
   the doppelt page did not move and the blank was a regression, not a stale
   capture. The provenance (tool, date, sha256, and why `npm run e2e` does not
   rewrite this file on this host) is in `docs/e2e/README.md`, and the README's
   embeds now point at the committed files instead of at a
   `raw/pr/s2b-dashboard-e2e/…` URL, so the document displays what the repo holds.
   `03b` (pizza) is deliberately left as the full-fidelity capture: pizza answers
   `Attention Required` (Cloudflare) to every client on this host.

Verified in this round, by running:

- `npm run e2e` → `4 passed, 0 failed, 0 skipped`, `verdict: PASS`, exit 0, with the
  venue click-through reported NOT verified (`clear/unreachable`) rather than green.
- `python3 -m py_compile` on both Python entry points; `CHALLENGE_RE` matched
  `Just a moment...` and did not match the real page title.
- The re-shoot above, compared byte-for-byte against the historical still.
- ngit CI at the head — conclusion quoted on PR #22 and in the kanban handoff.

## Merge note

The branch is pushed to both remotes. Merging to `main` was not done — the card's
review lane owns that decision, and the second review round (Q3/Q4) is still open.
