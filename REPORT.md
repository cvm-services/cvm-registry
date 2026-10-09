# REPORT.md — access-request intake

Implemented signed NIP-78 access-request intake for cvm-registry.

- `collector/access_requests.ts` parses kind-30078 `d=cvm:access-request`, requires a valid hex pubkey and 128-character signature, and rejects unsigned/wrong-d events.
- Requests dedupe by `(npub, d)`, newest event wins, oldest `first_seen` remains, and every result is `status: requested`.
- `collector/collect.ts` harvests kind 30078 on the existing relay set and emits a capped `requests` list separate from entries/services; requests never pass the allow-list into public services.
- Added `fixtures/access-requests.ndjson` with a signed request update and an unsigned rejection case.
- Added `tests/access_requests_test.ts` covering parse, rejection, dedupe, and first-seen preservation.
- Added static `/console/` curator view. It shows age, class, evidence, requester npub, copy allow-list line, and dismiss; it has no approve action.

Verification: `deno test --allow-read --allow-net=127.0.0.1` — 126 passed, 0 failed.
Collector fixture run completed and emitted one requested request with zero public entries.
