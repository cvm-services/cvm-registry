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

---

# REPORT — t_99fb9b0e: deploy `/console/` + close the missing `/api` proxy

## What was required, and what is now true on the host

| required | state |
| --- | --- |
| Caddy vhost reverse-proxies `/api/*` to cvm-orders, service bound to localhost, own systemd unit + `FACILITATOR_NPUB` env file | DONE. `cvm-pwa.orangesync.tech` has `handle_path /api/* { reverse_proxy 127.0.0.1:8788 }`; `cvm-orders.service` runs from `/opt/tollgate/cvm-orders` with `EnvironmentFile=/etc/cvm-orders/config.env`, `BIND_ADDR=127.0.0.1`. `ss -ltnp` shows `127.0.0.1:8788` and the journal prints `Listening on http://127.0.0.1:8788/` |
| `/api/*` returns a real JSON error (not `index.html`) when the service is down | DONE, measured with the service stopped: `HTTP 502 application/json` + `{"error":"order service unavailable",...}`; `/console/` and `/order/` stayed 200, so the error route is scoped to `/api/*` |
| vhost comment says the order store is in-memory | DONE, in `deploy/caddy-vhost-cvm-pwa.caddy` (and repeated in the systemd unit): restarting cvm-orders empties the queue BY DESIGN |
| `/console/` deployed and serving the console's own document + `app.js`/`style.css` 200s | DONE. `/console/` = 1102 b and byte-identical to `site/console/index.html` (`cmp -s` passes in the deploy); `app.js` 28538 b, `style.css` 5566 b, both 200 |
| curl matrix before/after + a screenshot of the live sign-in screen | DONE (below) + `console-signin.png` |

## curl matrix (real output)

BEFORE (service neither installed nor proxied; everything was the SPA fallback):

```
/api/auth/challenge      HTTP 200  381b  text/html; charset=utf-8
/api/orders/queue        HTTP 200  381b  text/html; charset=utf-8
/console/                HTTP 200  381b  text/html; charset=utf-8   <- ordering app, no console
/order/                  HTTP 200  381b  text/html; charset=utf-8
/health                  HTTP 200  381b  text/html; charset=utf-8
```

AFTER (service up):

```
/api/auth/challenge      HTTP 200  213b            application/json
/api/orders/queue        HTTP 200   13b            application/json   -> {"orders":[]}
/api/health              HTTP 200   11b            application/json
/console/                HTTP 200  1102b           text/html          == site/console/index.html
/console/app.js          HTTP 200  28538b          text/javascript
/console/style.css       HTTP 200  5566b           text/css
/order/                  HTTP 200  381b            text/html          (unchanged; sha256 verified)
/order/app.js            HTTP 200  11708b          text/javascript
cache-control: no-store
```

DOWN (measured, not simulated — `systemctl stop cvm-orders`, then `start` again):

```
/api/auth/challenge      HTTP 502  192b  application/json
{"error":"order service unavailable","detail":"cvm-orders on 127.0.0.1:8788 did not answer",
 "note":"the order store is in memory: a restart empties the queue, it does not lose committed data"}
/console/                HTTP 200  1102b text/html       <- the error route does not touch static
/order/                  HTTP 200   381b text/html
```

`GET /api/auth/challenge` carries the configured `facilitatorNpub`, i.e. the strip/rewrite, the
upstream and the env file are all in the same path — the console's sign-in check has something real
to compare against.

## How to reproduce / roll back

```sh
FACILITATOR_NPUB=npub1... bash deploy/orders-setup.sh   # code + unit + /etc/cvm-orders/config.env
HOST=debian@testserver2.fips bash deploy/deploy-pwa.sh  # site + vhost (replaces the old block)
```

Roll back the surface only: `cp /etc/caddy/Caddyfile.vhostbak-20261010T054635Z /etc/caddy/Caddyfile
&& caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`; stop the backend with
`systemctl disable --now cvm-orders` (`/api/*` then answers the JSON 502, not the SPA fallback).

## Decisions and assumptions (state them, do not bury them)

1. **`FACILITATOR_NPUB` is the operator's own npub** (`npub1c03rad0r…`, the identity that owns his
   ngit repos) — no card or PLAN-0007 names one, and the facilitator in this flow IS the operator.
   Only the public key is on the host (`/etc/cvm-orders/config.env`, 0644); the private half never
   left anything and no key material is in the repo, the card or a comment (ADR-0013). Changing it
   is one line + `systemctl restart cvm-orders`.
2. **The host runs the cvm-orders loopback change from `pr/orders-bind-loopback` (`0da283f`)**,
   because the released `main.ts` binds `0.0.0.0`, which REQUIRED forbids. Merge PR #2 and redeploy
   from main; the deployed commit is recorded here so the drift is visible rather than assumed.
3. **PORT=8788** (nothing else listens there; `8781-8783` are bun, `8787` node, `6798` deno).
4. **The service runs as root**, like the repo's other host units (`cvm-collector.service`), because
   the installed deno lives under `/root/.deno` and the module cache must be writable. Hardening
   (dedicated user + read-only cache) is a follow-up, not a blocker for a demo store with no auth
   beyond the loopback bind — and that missing auth is exactly `t_d790103d`.
5. **The card's "381-byte document" for `/console/` is the ordering app's size, not the console's.**
   The console documents is 1102 b; 381 b is what `/console/` used to serve wrongly (the SPA
   fallback). Both numbers are in the matrix above so nobody re-reads the card as a mismatch.

## Findings this deploy proves, and does NOT fix (reported, not silently patched)

The card's premise was that the missing `/api` proxy is what blocks the customer pay step. It is
*one* of the blockers. Against the live proxy:

* `POST /api/orders` with the customer PWA's exact body (`{venue_slug,items,fulfilment,inputs}` —
  no `id`, no `payload` wrapper) returns **201** with `{"state":"paid","payload":{},"updatedAt":…}`
  — **no `id`**, and the basket is dropped (`main.ts` reads `body.id`/`body.payload`; the PWA sends
  neither). The PWA then calls `/api/orders/undefined/invoice`.
* `GET /api/orders/:id/invoice` — required by the PWA before it can show a bolt11 — is **not
  implemented** in cvm-orders (`404 {"error":"not found"}`).
* Because the malformed create still queues the order, a bad POST leaves an **unaddressable entry in
  the paid queue** (observed once, then cleared by restarting the service, which is the documented
  in-memory behaviour).

None of that is `REQUIRED` here, and fixing it means changing the create contract and adding a real
invoice endpoint — a separate card (`t_5198c7da`, created by this run) rather than an unrequested
rewrite of the API contract inside a deploy task.

## Verification honesty

* The deploy script's RED claim: `tests/pwa_vhost_test.ts` is structurally RED on the pre-change tree
  only because the files it reads did not exist there (the vhost was a heredoc in `deploy-pwa.sh`);
  the semantic assertions (stripped `/api`, JSON error route, per-app fallback, in-memory comment)
  were verified against the LIVE host instead, which is stronger evidence than a failing unit test.
* The sign-in screenshot is a real capture of the deployed URL (`status=200`, title
  `Facilitator console — facilitated sats orders`, visible text quoted in the run log). Vision
  analysis was unavailable (the vision lane returned 503 "all providers exhausted"), so the render
  was verified without a vision model: 2560x1728 PNG, 2322 distinct colours, mean luminance 0.079,
  sd 0.055 (i.e. non-blank, dark-theme content) plus the DOM text from the live page.
* No sign-in was COMPLETED: a NIP-98 signer is not available headless, and server-side verification
  does not exist yet (`t_d790103d`).

## Close-out (t_99fb9b0e)

Task closed. Final live re-check, DOM-text render evidence, honest screenshot provenance (vision lane 503 — no vision verdict claimed), card attachment ids and their sha256s, and the commit list are in
[`evidence/t_99fb9b0e/CLOSEOUT.md`](evidence/t_99fb9b0e/CLOSEOUT.md). Card attachments: 77 `deploy-matrix.txt`, 78 `console-signin.png`, 81 `CLOSEOUT.md`.
Follow-up (not in scope here): `t_5198c7da` — order-create contract + missing `GET /orders/:id/invoice`.
