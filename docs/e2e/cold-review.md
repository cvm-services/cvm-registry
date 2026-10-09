# Cold review round 1 — cvm-registry e2e (branch `wt/cvm-e2e-runnable`)

Reviewer: cross-family lane (`kimi-k3:cloud` requested; the router served
`deepseek-flash`), reached via `scripts/cold_review_runner.py`. It did not write
this code. Prompt + raw output: `/tmp/review-prompt-full.md`,
`/tmp/review-verdict.md` (scratch; the finding is reproduced below).

## What the reviewer found

The reviewer ran out of completion budget mid-answer (2000 reasoning tokens, no
final verdict line — see the run note in `PROGRESS.md`), but the partial answer
landed one real defect, and it was right:

> *"if venueSafe true but challenge occurs mid-run (e.g. curl probe said clear but
> the browser got challenged), then detail won't include 'NOT verified' — so
> `partial` regex on detail won't catch it. ... the summary would say 'PASS — every
> leg ran and passed' without a NOTE, even though the python script printed a
> challenge."*

Mechanism, in the code as it stood: the harness decided the summary's note from
**its own** probe (`venueSafe`), while the leg decided what actually happened while
driving the browser. The leg prints `NOT VERIFIED` / `CHALLENGED` on its stdout —
which the harness deliberately leaves *inherited* (`stdio: "inherit"`, for live CI
logs), so the summary never saw those lines. A venue page can answer `curl`
cleanly and still be challenged in the browser (Cloudflare fingerprints the client,
not the bytes), so the two could disagree, and when they did the summary reported a
clean `PASS` for a page that never loaded. That is precisely the silent-green
failure this suite exists to kill, sitting inside the fix meant to kill it.

## Fix

`tools/run-e2e.mjs`: our probe now decides only whether to *attempt* the
click-through; the leg's own evidence (`docs/e2e/venue-discovery-e2e.json`, which
the leg already writes) decides whether it *happened*. If any venue page is
`challenged` or `skipped` there, the leg's `detail` carries
`, venue click-through NOT verified (the leg itself reports …)`, and the existing
`partial` check turns that into the summary `NOTE`.

## Proof — a differential harness test, not an assertion

Test double for the python leg (`/tmp/fakeleg.sh`) writes a chosen venue outcome to
the evidence file while the harness's curl probe is made to answer `clear` (a shim
on `PATH` fakes only the two real venue hosts). Same command both times:
`PATH=<shim>:$PATH PYTHON=/tmp/fakeleg.sh FAKE_LEG_OUTCOME=<x> E2E_VENUE_PAGES=1 npm run e2e:hermetic`

CASE A — the leg reports the page CHALLENGED, the probe says clear:

```
  PASS hermetic e2e/venue_deep_link_e2e.py — provisioned dashboard, headed, venue click-through NOT verified (the leg itself reports doppelt-kaese-berlin (challenged))
  2 passed, 0 failed, 0 skipped
  NOTE: e2e/venue_deep_link_e2e.py — a named sub-assertion was NOT verified: … (the leg itself reports doppelt-kaese-berlin (challenged))
  NOTE: 1 leg(s) carried an un-verified sub-assertion; the verdict covers only what ran.
  verdict: PASS — every leg ran and passed
```

CASE B — control, the leg reports the page VERIFIED, nothing is noted:

```
  PASS hermetic e2e/venue_deep_link_e2e.py — provisioned dashboard, headed
  2 passed, 0 failed, 0 skipped
  verdict: PASS — every leg ran and passed
```

The only difference between the two runs is the leg's reported outcome, so the
`NOTE` is caused by the read-back and not by anything else in the harness. Whole
run A: `/tmp/readback-A.log`; B: `/tmp/readback-B.log`; the test doubles and the
shim are under `/tmp/e2estub/` and `/tmp/fakeleg.sh` (scratch, not committed).

The fixture rewrite used in an earlier attempt at this proof (announcing a local
challenge page) was reverted, and the evidence files were reset with
`git checkout -- docs/e2e/` before the honest run that produced the committed
evidence — no test-double output is recorded as evidence in this repository.

## Round 1, part 2 — the ffmpeg branch, now tested rather than asserted

Q2 ("is `transcode_mp4` genuinely non-fatal on every failure path?") got an answer
rather than an argument, and reading it for the answer found one real hole: the
`subprocess.run` was unguarded, so a binary that `shutil.which` finds and the OS
still refuses to exec (ENOEXEC on a no-exec mount, ENOMEM, a path that vanishes
between the two calls) raised out of `transcode_mp4` and failed the leg — the same
accident class as a missing binary, and the only one still unguarded. It is wrapped
now and continues to the next candidate.

Proven by `e2e/transcode_mp4_selftest.py` (no browser, no network, no relay):

```
transcode_mp4 must never be fatal (see e2e/venue_deep_link_e2e.py):
  ok   no ffmpeg anywhere (CI: none installed): returned False, mp4 exists=False
  ok   trimmed ffmpeg build exits 8 (the ngit CI failure): returned False, mp4 exists=False
  ok   ffmpeg present but exec fails (exit 127): returned False, mp4 exists=False
  ok   working ffmpeg writes the mp4: returned True, mp4 exists=True
4/4 cases passed
```

Case 2 is the shape of the actual CI failure this branch exists to fix (Playwright's
bundled build is trimmed: `-movflags +faststart` → exit 8).

## Still open from this review round

Q3 (exit-code accounting: is a skip ever a pass?) and Q4 (does the CI gate /
observational split hide anything a maintainer would want red?) were not answered by
the reviewer — it ran out of completion budget. Q6 got no answer either. The
exit-0/exit-3 behaviour is exercised by the runs recorded in
`docs/e2e/clean-clone-transcript.txt` and `PROGRESS.md`, but neither Q3 nor Q4 has
had an adversarial pass. A second review round with a larger completion budget
should start there.
