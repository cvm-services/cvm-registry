# PROGRESS — t_4726349b (PLAN-0007 T4: facilitator-console happy-path video)

branch `pr/console-happy-path-video` in `~/worktrees/t_4726349b`, pushed to
origin (cvm-services/cvm-registry).

| # | step | status |
|---|------|--------|
| 1 | worktree + branch from `origin/pr/facilitator-console` | done |
| 2 | real cvm-orders slice is importable from the worktree (`file://$CVM_ORDERS_DIR/main.ts`) | done |
| 3 | `tools/console-test/stub-order-service.ts` — service surface over the REAL `route()`/`OrderStore` | done |
| 4 | `tools/console-test/console_happy_path.mjs` — one take, 1280x720, `recordVideo` on, 8 acts | done |
| 5 | run loop: 13 takes, each failure fixed at its cause (see below) | done |
| 6 | **defect found + fixed**: console refused its own ISO timestamp (commit `1d53cac`) + regression test | done |
| 7 | green take → `evidence/t_4726349b/{mp4,webm,facts.json}` (commit `ef9d49c`) | done |
| 8 | `tools/console-test/run-console-test.sh` — provenance + run + prove the video | done |
| 9 | re-take so the end card names the committed harness, push (`749c92c`) | done |
| 10 | close the card: handoff summary + report the 2 remaining findings | done |

All 10 steps done; working tree clean; pushed at `749c92c`.

Note: this file is task-scoped on purpose. The repo already has a tracked rolling
`PROGRESS.md`/`REPORT.md` at the worktree root (owned by the t_324abc50 branch), and this
task's notes were moved here rather than clobbering it.

## Useful facts for whoever resumes

- Run it with `tools/console-test/run-console-test.sh` (or `node
  tools/console-test/console_happy_path.mjs`). Env: `CVM_ORDERS_DIR`
  (default `~/repos/cvm-orders`), `OUT_DIR` (default `evidence/t_4726349b`),
  `PORT` (default 8791; the ledger stub takes PORT+1).
- The harness exits non-zero on any assertion, and writes a diagnosable
  `facts.json` (with `error`) plus a `.FAILED.webm` on a failed take, so a
  failed take can never overwrite a good recording.
- `console_errors` is `[]` on the green take; only favicon noise is ignored.
- Failures fixed on the way (all real, none papered over): a stray
  `document.documentElement.appendChild(style)` left over from an earlier
  `addInitScript` version threw before the console booted (run 8); the act-4
  refusal banner is not cleared by a later successful save, so waiting for "any
  `.error`" returned instantly on stale text — the wait now keys on the shell
  returning, and the stale banner is recorded as a finding instead of asserted
  as failure (runs 9-11); the act-5 caption itself contained the literal phrase
  the assertion searched for in the page text (run 12).
