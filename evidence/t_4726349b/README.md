# T4 evidence — facilitator-console happy path

Canonical task: **t_4726349b** (PLAN-0007 **T4**, "happy-path Playwright video evidence").

## What is in here

| file | what it is |
|---|---|
| `console-happy-path.mp4` | **the deliverable** — one Playwright run, 1280x720, `recordVideo` on, whole flow |
| `console-happy-path.webm` | the same take in the player's native format, written by Playwright |
| `console-happy-path.facts.json` | machine-readable record of the run: per-act observations, the service's own ledger of calls, the stub log, console errors, provenance SHAs |

Reproduce with:

```
tools/console-test/run-console-test.sh
```

The harness is `tools/console-test/console_happy_path.mjs`; the order service it drives is
`tools/console-test/stub-order-service.ts`. The runner pins the provenance it records
(console commit, harness commit, branch) and **fails** if the video that landed is not
1280x720 / longer than 5 s — a green test with no video is not evidence.

## The flow on screen (8 acts, ~29 s)

1. **sign-in** — the console signs a NIP-98 challenge (kind 27235) with the device key.
2. **queue** — paid baskets with the 5-min SLA; the *pending* order is visibly blocked
   ("sats payment is \"pending\", not settled"), so the sats gate is shown, not asserted.
3. **placing** — venue hand-off opens the venue's own checkout in a separate tab.
4. **card custody (ADR-0013)** — a PAN typed into the payment reference is refused at the
   field, with **0** transition requests sent and **0** card-shaped values on the wire.
5. **placed** — the venue receipt (`#4471`, ready `18:25`) is captured on the device and
   the service is driven `placing -> placed` over real HTTP.
6. **ready** — the venue handed the order over; `placed -> ready` again against the service.
7. **settlements** — the receipt row as the operator sees it.
8. **closing frame** — deliberate end card: repo, branch, console commit, harness commit,
   real order-service commit, seeded orders, and the card-custody result.

## What is real, and what is stubbed

The **money path is not mocked.** Neither the console's order state machine nor the
cvm-orders service is faked: `tools/console-test/stub-order-service.ts` imports the actual
`route()` and `OrderStore` from the cvm-orders checkout at `$CVM_ORDERS_DIR` (default
`~/repos/cvm-orders`) and serves every `/api/*` call through that real code over real HTTP
on loopback. Every state change in the clip is a POST into that machine, re-read afterwards
with `GET /api/orders/:id`; the facts file carries the service's own request ledger.

Three things are stubbed because they cannot exist on a headless host, and each is declared
at the point of the stub in the harness header:

- `window.nostr` — no NIP-07 extension in headless Chrome. The stub signer returns the
  facilitator pubkey the service itself issued and a real kind-27235 event with the
  `u`/`method`/`payload` tags the console builds. It is **not** claimed to be a security
  boundary: the real service does not verify the signature yet (that gap is a separate
  card). The stub order service parses and logs the event, so the log proves the console
  really signed and attached a challenge to every call.
- `window.open` — the venue's checkout is a third party page; letting it open a real second
  page would split the recording (Playwright records one video per page). The stub records
  the URL handed off and returns a handle.
- the seeded `settled_at` is 90 s in the past so the 5-min SLA countdown is stable. The
  clock itself is real.

## Findings this run produced

Two defects were found by running the flow; both are recorded in `facts.json.findings` and
filed as follow-up cards rather than silently absorbed:

1. **Fixed here (commit `1d53cac`).** The console's card guard refused its **own**
   timestamp. `recordPlaced()` builds the receipt with `captured_at: new Date().toISOString()`
   and then guards it; `looksLikePan()` strips non-digits, leaving a 17-digit run, so ~10%
   of all timestamps pass Luhn and the guard refused the console's own receipt — `placed`
   failed at random, i.e. the money path was broken about one attempt in ten. Fixed with an
   ISO-shape exemption plus a regression test that searches for a genuinely tripping
   timestamp.
2. **Reported, not fixed.** Still open on the card: (a) the act-4 refusal banner is not
   cleared by a later successful save, so the operator sees a stale refusal next to a
   successful save; (b) `settlementsView()` joins `state.receipts` against `state.queue`,
   which is paid-only, so once an order leaves `paid` the receipt row shows the venue as
   "—" and the fee/fiat totals as 0.00 € even though the receipt was captured; (c)
   `looksLikePan()` strips the *whole* value, so a PAN embedded in a longer digit-bearing
   string ("ref 1234 4242424242424242", "pi_3Qk9Zx2eZvKYlo2C 4242424242424242") evades it.

## Provenance

Recorded in `facts.json` and burned into the closing frame:
console commit `1d53cac`, branch `pr/console-happy-path-video`, order service
`cvm-orders@e5a8a5c7d6b6fbe6ba10973fca1873046e80f8c0`.
