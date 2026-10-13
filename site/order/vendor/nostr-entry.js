/**
 * Vendored Nostr entry point for the customer PWA (ADR-0017).
 *
 * This file exists so the browser bundle is REPRODUCIBLE from the repo: the
 * committed output `nostr.mjs` is built from this exact import list by
 * `scripts/vendor-nostr.sh`, so nobody has to guess which parts of nostr-tools
 * are in the 200 KB blob or where it came from.
 *
 * Only what the customer surface needs:
 *   - pure:   keys + event signing/verification (no relay)
 *   - pool:   relay connections
 *   - nip44:  the encrypted order-detail payload (v2, the only one we use)
 *   - nip46:  BunkerSigner / parseBunkerInput — signing on a phone, where a
 *             NIP-07 extension cannot run
 */
export { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
export { SimplePool } from "nostr-tools/pool";
export * as nip44 from "nostr-tools/nip44";
export { BunkerSigner, parseBunkerInput } from "nostr-tools/nip46";
