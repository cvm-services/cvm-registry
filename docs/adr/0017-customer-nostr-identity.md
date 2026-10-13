# ADR-0017 — Customer identity: Nostr login on the order surface

**Status:** Accepted (2026-10-13)
**Supersedes:** the `localStorage`-only recovery from the same day (kept as the
offline fallback, not as the durable layer).

## Context

The customer PWA stored only the order id in `localStorage`. That survives a
refresh and nothing else: not a second device, not cleared site data, not a lost
phone. The id is the customer's only handle on a live payment, and it is not an
identity — two customers sharing a device would collide, and a customer cannot
prove to anyone that an order is theirs.

## Decision

The customer may sign in with a Nostr key. Nothing about this is required to
pay: an anonymous order still works exactly as before.

**Two signing methods, one interface.** Signing goes through a signer object
(`{pubkey, signEvent, nip44Encrypt, nip44Decrypt}`), so nothing downstream knows
which is in use:

- **NIP-07** (`window.nostr`) where an extension exists — desktop.
- **NIP-46** via a pasted `bunker://` URL — the only practical path on a phone,
  where no extension can run. Chosen over self-hosting a bunker: no new service,
  no new secret to keep, and a hosted bunker is a legitimate signer.

**Two records per order, both addressable (30000-39999)** so a re-publish
REPLACES rather than duplicates, and so no replaceable kind (0, 3, 10000-19999)
can silently overwrite unrelated content:

- **30318 `receipt` — PUBLIC.** Empty `content`; tags carry only what the
  customer already displays (venue, state, subtotal/fee/total, and the venue's
  own order number from ADR-0014). It makes the order provable and recoverable.
  It must never carry items or contact detail; a test fails the build if the
  words do.
- **30319 `detail` — NIP-44 ENCRYPTED** to the customer's own pubkey. Items,
  contact inputs, per-line prices. The relay stores ciphertext; only the key
  holder reads it.

The `d` tag is `cvm-order:<order-id>`, so each order keeps exactly one address
and a later state change is an update, not a new record.

**The key never reaches our code.** NIP-07 and NIP-46 both sign and encrypt
remotely; the PWA holds no private key material and stores no `nsec`. A test
asserts an identity record can never carry one.

**Relays** are `wss://relay2.orangesync.tech` (ours) plus `wss://relay.primal.net`
as an independent second home. A record that lands on both survives either one
being down.

## Consequences

- Recovery becomes: sign in → query 30318 for your pubkey → order list; the
  detail is decrypted per order. Works on a new device with nothing local.
- Loss of readability is explicit: a customer who loses the key cannot decrypt
  their own detail records. That is the cost of self-custody, not a bug.
- The public receipt is world-readable by design. That is the price of
  verifiability, and it is why it carries no items or contact detail.

## Alternatives rejected

- **Public JSON list of orders (unencrypted).** Would expose every customer's
  items, phone number and spend to anyone reading the relay.
- **Server-side order history.** Puts our service in the position of holding a
  customer's purchase history; relays let the customer hold their own.
- **Self-hosted NIP-46 bunker now.** A real build (key custody, pairing,
  availability) for no gain over a hosted signer; revisit only if the fleet
  needs to sign on phones without a third party.

## Evidence

`tests/order_records_test.ts` (8 tests): kind ranges, self-signed by the
customer's key, receipt leak check, ciphertext check + round-trip, foreign-key
refusal, malformed-event tolerance, identity never holding a private key.
