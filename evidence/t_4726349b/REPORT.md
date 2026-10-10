# REPORT — t_4726349b · PLAN-0007 T4 happy-path video evidence

Status: **done.** One test, one coherent 1280x720 recording, driven against the real
`cvm-orders` slice over real HTTP. Branch `pr/console-happy-path-video` (base
`origin/pr/facilitator-console`), pushed. Head at completion: `749c92c`.

## What was asked

PLAN-0007 makes a Playwright happy-path video mandatory for T4 ("neither card reaches
review without it"); t_324abc50 shipped `site/console/` but ran out of budget before the
recording existed. Card rules honoured: no mocked money, a single test rather than an
assertion checklist, `video:on` at 1280x720, probe the video so a stub cannot pass as a
recording, closing frame naming repo + commit SHA, artifact attached to the card.

## The recording

- `evidence/t_4726349b/console-happy-path.mp4` — **the deliverable**, 1280x720, 23.84 s,
  8 labelled acts. Attached to the card (attachment 82).
- `evidence/t_4726349b/console-happy-path.webm` — the take as Playwright wrote it.
- `evidence/t_4726349b/console-happy-path.facts.json` — per-act observations, the
  service's own request ledger, the stub's log, console errors, provenance. Attached to
  the card (attachment 83).
- `evidence/t_4726349b/README.md` — the bundle's own documentation.

The 8 acts: sign-in (NIP-98 challenge) → paid-basket queue with the 5-min SLA, with the
*pending* order visibly blocked by the sats gate → placing + venue hand-off → **card-custody
refusal of a PAN typed into the payment reference** → receipt capture (`#4471`, ready
`18:25`) and `placing → placed` → `placed → ready` → settlements view → closing frame.

## No mocked money

`tools/console-test/stub-order-service.ts` imports the **real** `route()` handler and
`OrderStore` from the cvm-orders checkout at `$CVM_ORDERS_DIR` (default
`~/repos/cvm-orders`) and serves every `/api/*` call through that code over real HTTP on
loopback. Every state change on screen is a POST into that machine, re-read afterwards
with `GET /api/orders/:id`; the facts file carries the service's request ledger (14 calls
on the green take). The stub exists to seed a settled + a pending order, not to fake the
flow.

Three things are stubbed because they cannot exist on a headless host, and each is
declared in the harness header at the point of the stub:

1. `window.nostr` — no NIP-07 extension in headless Chrome. The stub signer returns the
   facilitator pubkey the service itself issued and a real kind-27235 event with the
   `u`/`method`/`payload` tags the console builds. It is **not** claimed to be a security
   boundary (the real service does not verify the signature yet — separate gap); the stub
   order service parses and logs the event, so the run log proves the console really
   signed and attached a challenge to every call.
2. `window.open` — the venue checkout is a third-party page; letting it open a real second
   page would split the recording, and Playwright records one video per page.
3. the seeded `settled_at` is 90 s in the past so the SLA countdown is stable; the clock
   itself is real (`Date.now()`).

## Why the video is load-bearing, not decorative

- `tools/console-test/run-console-test.sh` runs the take and then **proves** the artifact:
  `ffprobe` must report 1280x720 and a duration > 5 s, or the runner exits non-zero. A
  green test with a 0-byte or stub video is not evidence.
- The harness asserts on the *visible* text at each step (`#4471` on the queue, `18:25`,
  the "persistence gap" wording) rather than only on internal state.
- Every state transition is re-read from the service, and the ledger must show the
  `placed` transition accepted with HTTP 200.
- Card custody is verified at three levels on the refusal act: the field is refused, **0**
  transition requests are sent, and **0** PAN-shaped values appear on the wire (`panWires:
  0` computed from the service's own request bodies).
- Console errors are fatal, with only favicon noise ignored — `console_errors: []` on the
  green take.

## A real defect the run found, and fixed (commit `1d53cac`)

`recordPlaced()` builds the receipt with `captured_at: new Date().toISOString()` and then
guards it with `assertNoCardData()`. `looksLikePan()` strips every non-digit, leaving an
ISO timestamp as a 17-digit run — inside its 13..19 window — so ~1 in 10 timestamps
passes Luhn. The guard therefore refused the console's **own** receipt and `placed` failed
at random: the money path was broken about one attempt in ten. Measured 360/3600
consecutive seconds (10.0%); the failing take hit it at `2026-10-10T06:35:12Z`.

Fixed by exempting the ISO-8601 shape before the PAN check, with a regression test that
*searches for* a timestamp which genuinely trips `looksLikePan()` and then asserts the
guard lets it through while a real PAN is still refused. Full suite: 149 passed, 0 failed.

Without running the flow this defect stays invisible — it is a ~1-in-10 random failure.

## Findings reported, not patched over (on the card, not in code)

1. **Stale refusal banner.** The act-4 card-custody refusal banner is not cleared by a
   later successful save, so the operator sees a refusal next to a successful save. The
   harness records this as a finding instead of asserting on the banner (which would have
   been a false failure).
2. **`settlementsView()` loses the receipt after the order leaves `paid`.** It joins
   `state.receipts` against `state.queue`, which is paid-only, so the venue renders "—"
   and the fee/fiat totals render 0.00 € even though the receipt was captured. Visible on
   camera in act 7 and recorded in `facts.json.findings`.
3. **`looksLikePan()` strips the whole value**, so a PAN embedded in a longer
   digit-bearing string evades it: `"ref 1234 4242424242424242"` and
   `"pi_3Qk9Zx2eZvKYlo2C 4242424242424242"` are both accepted, while a bare PAN is
   refused. Not introduced by this task and not fixed here (it is a design question about
   what the guard is for), but it is measured and on the record.

## Deviation from the card body, stated plainly

The card suggested artifacts under `artifacts/console/`. Nothing in this repo is tracked
under `artifacts/` (0 files); the repo's evidence convention is `evidence/<task-id>/`
(`evidence/e2e-discovery/`, `evidence/t_99fb9b0e/`), so the evidence lives at
`evidence/t_4726349b/` with the `.mp4` + `facts.json` shape the other bundles use.
`OUT_DIR` is overridable if the reviewer wants the old path.

## Reproducing

```
tools/console-test/run-console-test.sh
```

Env: `CVM_ORDERS_DIR` (default `~/repos/cvm-orders`), `OUT_DIR` (default
`evidence/t_4726349b`), `PORT` (default 8791; the credential-log stub takes PORT+1).

## Verification performed, with the evidence

| claim | evidence |
|---|---|
| single coherent recording, 1280x720 | `ffprobe` → 1280x720, 23.84 s; runner enforces both |
| real order service, not a mock | ledger of 14 real HTTP calls in `facts.json`; orders re-read after each transition |
| card custody holds | `panWires: 0`, `transition_requests_sent: 0` on the refusal act |
| no page errors | `console_errors: []` |
| console suite green | `deno test` → 149 passed, 0 failed |
| pushed | `git ls-remote origin pr/console-happy-path-video` → `749c92c` |

## Remaining work (not this card)

The three findings above want their own cards; the harness is in-repo and re-runnable, so
each one can be re-shot as evidence once fixed. Nothing about this deliverable is blocked
on them.
