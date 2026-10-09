# t_5317adc6 — blocked, not implemented

The previous completion/review wording was incorrect. The prototype was reverted because it was unsafe and did not meet the task. No deployable console is delivered.

## Findings
- cvm-orders origin/main 809c872 exposes GET /auth/challenge but does not retain or verify challenges, verify signatures, issue sessions, or authorize queue/transitions.
- Its transition endpoint accepts only a state; venue confirmation number and ready time are not persisted. There is no settlements or actual monetary refund endpoint.
- PLAN-0007 explicitly requires T2 for T4 and real paid-leg evidence; this card only lists T1 as a parent.
- Another branch (wt/cvm-access-request, card t_9a7f9d0b) owns site/console/index.html for curator requests. Coordinate route ownership before implementation.

## Retracted work
5587f48 added hard-coded mockup values, a sessionStorage sign-in bypass, a discarded signature and misleading ready text without backend mutations. d7e58ea recorded this using a fake challenge/signer in an ad-hoc script. This was not real authentication, payment, notification, or refund evidence. The required Playwright spec never ran. No full-suite, TDD, cross-family review, MP4, PR upload or Signal delivery was achieved. bdf562d overstated readiness. All three commits were reverted; originals remain in history for audit only. Do not deploy them.

Initial pushes targeted the local reference repo, not GitHub; origin has now been corrected to https://github.com/cvm-services/cvm-registry.git.

## Remaining work
1. Complete/identify upstream authenticated API and paid/refund leg, including persisted confirmation and settlement fields.
2. Resolve curator/facilitator /console/ route collision.
3. Implement real backend-backed UI using approved mockup styling with tests first.
4. Run full tests and specified single Playwright journey with genuine signing/paid-leg evidence; compare screenshots to approved design.
5. Probe MP4, deliver PR/Signal evidence, obtain cross-family review, consolidate.

Only rollback whitespace/diff integrity is checked in this recovery; no application test pass is claimed.
