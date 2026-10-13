# Vendored dependency — nostr-tools

**Package:** `nostr-tools` **2.23.3** (MIT)
**Entry:** `site/vendor/nostr-entry.js`
**Output:** `site/vendor/nostr.mjs` (committed; ~171 KB, self-contained ESM)
**Regenerate:** `bash scripts/vendor-nostr.sh`

## Why vendored

The customer PWA has **no build step and no CDN at runtime** (ADR-0017). The
order surface must keep working when a third-party CDN is unreachable, and the
bytes that ship must be the bytes in the repo.

The exact import list is in `nostr-entry.js` — deliberately four specifiers so
nobody has to guess what is inside the blob:

- `nostr-tools/pure` — keys, event signing/verification
- `nostr-tools/pool` — relay connections
- `nostr-tools/nip44` — the encrypted order-detail payload
- `nostr-tools/nip46` — `BunkerSigner` / `parseBunkerInput`, for signing on a
  phone where a NIP-07 extension cannot run

Upstream also ships a prebuilt `lib/nostr.bundle.js`, but it does **not** include
NIP-46 — checked, not assumed.

## b3sum / sha256

```
e36264d372e8149c2ce56a26468bfea88b82d7f49162f0b6a193c3b7b918e45  site/vendor/nostr.mjs
```

`vendor-nostr.sh` pins the version and refuses to build against a different one,
so a silent major bump cannot change the wire format behind our back.

## Licence

MIT; upstream licence headers are preserved in the bundle
(`--legal-comments=inline`).
