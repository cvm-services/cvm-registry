# REPORT — t_324abc50: Facilitator console PWA (`/console/`) + card-custody decision

## What this delivers

`site/console/` — the facilitator's half of the facilitated-order flow (PLAN-0007 **T4**, the 3
approved panes plus sign-in), served on the same origin as the customer PWA so both UIs talk to the
same `/api` → cvm-orders surface (D5/D11, ADR-0006).

| required | implementation |
| --- | --- |
| authenticate | `GET /api/auth/challenge` → NIP-98 event (kind 27235, `u`/`method`/`payload` tags) signed on the device, sent on every call as `authorization: Nostr <b64 event>`; the console refuses a challenge signed by any key other than the advertised `facilitatorNpub`, and refuses an expired one |
| show the order queue | `GET /api/orders/queue`, with a 5-minute SLA countdown per order (from `payload.settlement.settled_at`) and a "no order selected"/"nothing paid" empty state |
| open an order and place it at the venue | per-order detail: basket, money, sats proof, custody plan; `POST /orders/:id/transition {state:"placing"}` then a hand-off that opens the venue's own checkout in a separate tab |
| confirm sats BEFORE fiat spend | `requireSettled()` — settlement status must be `settled` **with** a payment id/hash **and** a positive amount; called before `placing`, before `placed`, and it is what enables the button at all (ADR-0008 / ADR-0013) |
| drive the state machine | `POST /api/orders/:id/transition` for `placing` → `placed` → `ready` and `refunded`; the local map (`paid→placing→placed→ready`, refund only before placement) mirrors the service, and the service stays the source of truth (illegal transitions are the service's 409) |
| capture venue reference/receipt | placing pane records venue order number, ready time, what it was paid with, and the payment reference; a placed order without a venue reference is refused; the receipt is posted with the `placed` transition and also kept in device storage |
| surface failures over Nostr DM | `escalate()` builds the ADR-0012 payload (order id, sats proof, rail, amounts, EUR 30 cap, what failed), encrypts (NIP-04) and publishes kind 4 to `wss://relay2.orangesync.tech`; if there is no signer / no encrypt / no relay it renders **NOT SENT** with the exact text rather than pretending |

## The card-custody decision, as built

The operator's decision (2026-10-09) is already recorded as **ADR-0013** in `contextvm-services`
(*"card data stays on the facilitator's device in the PWA and is never transmitted to our servers …
PAN/CVV must never reach our repos, logs, support DMs, or the Nostr bus"*). The console implements
exactly that and nothing more:

- **No card field exists in the document.** `site/console/index.html` contains no `<input>`, `<form>`,
  `<select>` at all; the placing pane's checkout frame is a hand-off pane, not a payment form. The
  approved mockup's `Card •••• 4242 (facilitator float)` line was deliberately **not** implemented —
  the mockup predates ADR-0013.
- **`assertNoCardData()`** (CARD-key regex, CVV-shaped values, and **Luhn-valid 13-19 digit** values)
  runs before every POST, before anything is written to device storage, and before anything is put
  on the Nostr bus. A card-shaped value typed into the reference field is refused and discarded.
- **Hand-off, not collection**: `custodyPlan()` returns `venue-checkout` when the order declares a
  venue checkout URL, else `psp-hosted-fields` (the 2fiat card CVM path, ADR-0013) — in both cases the
  console stores only the outcome plus a reference/token, and states that in the UI.
- Consequences accepted in ADR-0013 are visible in the UI: no server-initiated card retry (recovery is
  the manual ADR-0012 escalation), and the sats gate is what makes the fiat step admissible at all.

## Tests (real output)

```
deno check site/console/app.js                      → clean
deno test --allow-read tests/console_pwa_test.ts    → ok | 8 passed | 0 failed (18ms)
deno test --allow-read --allow-net=127.0.0.1        → ok | 142 passed | 0 failed (4s)
```

The 8 new tests are **not** prose checks: the console module is imported (with a DOM stub) and the
real guards are exercised — `requireSettled` fail-closed cases, `assertNoCardData` refusing keys,
CVVs and Luhn PANs, `looksLikePan`, `custodyPlan` hand-off modes, the legal state machine, SLA/receipt
key constants — alongside source contracts for the NIP-98 flow, the gate ordering
(`requireSettled` before `openHandoff`), the DM escalation and the fail-closed HTTP handling.

## Deploy

`deploy/deploy-pwa.sh` (host `testserver2.fips`, docroot `/opt/tollgate/cvm-pwa`) now also ships
`site/console/` and probes `https://cvm-pwa.orangesync.tech/console/`. **This deploy was not run
from this workspace** — no live `/console/` exists yet. Note the host currently has **no `/api` proxy**,
so `/api/orders/*` at the PWA origin returns the SPA fallback (`index.html`, HTTP 200) and the customer
PWA's pay step cannot work either; that is a deploy-side gap, not a console defect, but it must be
closed before either UI is usable live.

## Honest remaining work

1. **Live deploy** of `/console/` plus the missing `/api` → cvm-orders reverse proxy on the PWA host.
2. **T4 happy-path video.** PLAN-0007 requires one Playwright happy-path video; it was not produced in
   this run (budget). Tooling is present on this node (`playwright 1.56.0`, `chromium-1228`, `ffprobe`),
   so the harness is a bounded piece of work: a stub order service (the real cvm-orders slice, seeded
   with a settled order and a pending one) + a Playwright script with `video:on` at 1280x720 driving
   sign-in → queue → placing → receipt → settlements, plus a PAN-refusal clip.
3. **cvm-orders**: server-side NIP-98 verification (today the challenge endpoint "delegates signature
   verification to the console boundary", and a static PWA is not a boundary — the console checks key
   identity and freshness only and says so in the UI) and persistence of the receipt field.
4. **Usage attribution**: ~50% of `api_calls` rows carry a NULL `session_id` until `t_372f2de7` lands,
   so nothing this flow does is attributable yet.
5. The 2026-10-09 consult noted the same; no console-side workaround is honest here.

## Files changed

- `site/console/index.html`, `site/console/app.js`, `site/console/style.css` (new)
- `tests/console_pwa_test.ts` (new, 8 tests)
- `deploy/deploy-pwa.sh` (ships + probes `/console/`)
