# REPORT.md — task t_e2a7400c

## Verification correction (2026-10-09)

This task is INCOMPLETE; the earlier done transition was premature.
Fresh `npm ci` passed. An ad-hoc verification script created using Python
`tempfile` under the requested temporary directory passed package/lock,
runner/workflow presence, and non-empty artifact checks; it was removed.
`node --check tools/run-e2e.mjs` and `git diff --check` passed.
These are limited checks, NOT suite-green evidence.

Actual `npm run e2e` passed the catalog browser checks (76 prices, 13 cases),
dashboard discovery, and live deployment (two venues), then failed because
`site/catalog.json` is absent. The runner does not provision that catalog or
the local server required by the fourth script. Two discovered bugs are fixed:
Python Playwright 1.56.1 does not exist on the queried index (pin now 1.56.0,
installation observed successful), and the Python script does not accept
`--headless` (removed). The missing prerequisite remains a failure, not a skip.

The S5c WebM was copied from the existing attachment, NOT freshly recorded;
the four requested PNGs and nosms rerun remain missing. Browser bootstrap,
Python environment isolation, offline skip semantics, and the setup-node action
reference also still need validation before this branch can be considered ready.


Implemented and pushed commit e6f6dc1 on origin/wt/cvm-e2e-runnable.

Changes:
- Added pinned Playwright npm dependency and package-lock.json.
- Added `npm run e2e` entry point with browser bootstrap, hermetic catalog run, live-network reachability gate, explicit loud skips, and Python Playwright install path.
- Added CI e2e job to `.ngit/act/workflows/ci.yml`.
- Recovered S5c proof at `docs/e2e/s5c-nosms/nosms-cvm-happy-path.webm` (1,333,675 bytes).

Verification:
- `npm ci` passed.
- `npm run e2e` reached real catalog, dashboard discovery, and live deploy checks successfully on the host; the Python step exposed the host's externally-managed Python environment before the runner was updated to use `--user --break-system-packages`.
- A full post-update rerun was not completed before handoff; clean-clone and CI evidence remain outstanding.
- Working tree is clean after the push.

Known limitations / remaining:
1. Perform a literal fresh clone, npm ci, npm run e2e transcript.
2. Run ngit CI and record conclusion success.
3. Confirm screenshots against current dashboard and re-shoot if stale.
4. Cold cross-family review and merge are still required.
