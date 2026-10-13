# PLAN — Nostr login on the customer surface (order persistence + cross-device recoverability)

**Status:** awaiting operator approval (PLAN GATE)
**Date:** 2026-10-13
**Repos:** `cvm-registry` (PWA + console), `contextvm-services` (docs/ADR)
**Author:** manager session, ring-signatures-web-of-trust

## Problem (measured, not assumed)

The customer PWA now survives a *refresh* (order id in `localStorage`, deployed
2026-10-13). It does NOT survive:

- a different device or browser profile,
- cleared site data,
- the private-browsing case,
- a lost phone — the id is the customer's ONLY handle on a live payment.

Worse, `localStorage` is not an identity: two customers on one device would
share the key, and the customer cannot prove to anyone that the order is theirs.

## What exists today (recon 2026-10-13)

- No Nostr code on the customer surface. Zero.
- The console uses NIP-07 (`window.nostr.signEvent`) + relay `wss://relay2.orangesync.tech`.
- The PWA is plain `<script type="module">` — **no bundler**, so a vendored
  ESM `nostr-tools` drops in cleanly.
- `nostr-tools` is vendored in `auditable-voting/web` (version to check).
- The console's error text mentions a "NIP-46 nosigner" but **no such fleet
  service exists** — a self-hosted bunker would be a NEW build.
- Kinds in use: 11316/11317 (announcements), 30078-family not yet used here.

## Scope decisions that need the operator (see chat)

1. **Signing on mobile** — NIP-07 extension is desktop-only. Options:
   (a) NIP-46 by pasting a `bunker://` URL (works today with a hosted bunker;
   no build), (b) build/self-host a fleet bunker (new service), (c) desktop-only
   for now.
2. **Where orders are stored** — (a) NIP-44 encrypted, parameterized replaceable
   (30078-family) — per-order confidentiality; (b) public long-form/append-only
   JSON list — inspectable but reveals order contents, venues and amounts to
   anyone reading the relay; (c) both: public receipt + encrypted detail.
3. **Kinds** — must be in 30000-39999 (addressable) so updates replace rather
   than duplicate; never a replaceable kind (silent-overwrite hazard).
4. **Multi-device conflict policy** — last-write-wins is simplest; the store is
   small. Recommend LWW with an explicit `updated_at` and a merge note.
5. **Split by capability**:
   - **C1 (pure client)**: publish/subscribe the customer's own order records.
   - **C2 (service)**: customer surfaces re-publish by npub; facilitator sees a
     customer's linked npub on the queue item.
   C1 needs no service. C2 needs a cvm-orders change.

## Recommended scope (see chat for the ask)

Phase 1 — login + multi-device recovery, no service changes:
- Vendor `nostr-tools` (ESM) into `site/vendor/`; no bundler needed.
- Add an optional "Save my orders" identity to the customer screen: NIP-07 if
  present, else paste a `bunker://` URL (NIP-46). Never required to pay.
- Persist encrypted order pointers (id, venue, total, state) under the
  customer's npub, and rebuild the UI from them (fall back to the local id).
- Store the order id in `localStorage` as today; the npub is the durable layer.
- Tests: unit (event building, kind/tag shape, dedupe by `d`, decrypt failure
  paths) + a Playwright flow with a stubbed signer.

Phase 2 — service-side (separate, gated on Phase 1 landing):
- cvm-orders accepts an optional customer npub on the order payload.
- Queue items carry it so the facilitator can DM the customer.
- ADR for the record schema and the privacy trade-off chosen.

## Non-goals

- No change to the payment rail (sats leg is proven; do not touch it).
- No custody of customer keys: the signer stays on the customer's device.
- No server-side order history: relays are the customer's own backup.
- Not fixing the hardcoded PWA balance here (separate ticket).

## Urgency / dispatch

- **Urgency: SOON** (operator-directed feature; the workaround — a local id —
  exists but is fragile, and the operator is actively testing the flow).
- **Quota at planning:** proxy gate exit 0; `ours` 5-hour 100% / weekly 40%.
  Weekly headroom is real; 5-hour window is spent. → prefer implementing now
  with the operator present, or DEFER to the next 5-hour reset if it is not
  pressing (operator's call).

## Evidence required to call it done

- `deno test` green in cvm-registry (unit + PWA tests).
- A Playwright run with a stubbed signer showing: sign in → order → the record
  lands on a relay → clear `localStorage` → reload → the order is rebuilt from
  the relay.
- Deployed and verified live (bundle serves the new code).
- Committed + pushed to GitHub **and** ngit, on the default branch.
