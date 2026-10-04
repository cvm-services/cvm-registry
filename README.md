# cvm-registry

**Collector / aggregator for [ContextVM](https://www.contextvm.org/) services.**
Crawls CEP-6 announcements, dedupes, caches, and serves the discovery dashboard.

Status: **planned.** No code yet. Spec first, then implement against it.

## Scope

| In scope | Out of scope |
|---|---|
| Subscribe to kinds `11316`–`11320` across relays; dedupe by `(kind, pubkey, d)` | Publishing services (that is `cvm-service-kit`) |
| Cache the catalog locally and serve a **static dashboard (nsite)** from cache | Per-service live CVM calls in the dashboard view |
| Filter by class (`#t`) and location (`#g`) using **single-letter tags only** | Deciding who is *trusted* — registries are kind-30000 lists, one curator each, pinned by content hash |
| Report which relays actually index which tags | Ranking / search relevance (explicitly out of spike scope) |

## Two hard rules

1. **The dashboard is a cache, not a proxy.** It renders from the local store; killing
   the relay connection must keep the list rendering, with a "stale" banner — a
   dashboard that goes blank when the relay drops is a bug.
2. **Never fetch per-service CVM data to paint the list.** Announcements are the
   list. Live CVM calls are for interaction only.

## Read first

- [`docs/spec/cep-draft-0002-client.md`](https://github.com/cvm-services/contextvm-services/blob/main/docs/spec/cep-draft-0002-client.md) — the customer/buyer-facing spec: what a client MUST discover, verify, refuse and pay.
- [`docs/adr/0001-discovery-and-trust.md`](https://github.com/cvm-services/contextvm-services/blob/main/docs/adr/0001-discovery-and-trust.md) — tagging contract and pinned registries.
- [`docs/SPIKE-PLAN.md`](https://github.com/cvm-services/contextvm-services/blob/main/docs/SPIKE-PLAN.md) — Spike A acceptance criteria live here.

## Acceptance that actually proves it (from the spike plan)

- `nak req -k 11316 -t cvm:service:<class> <relay>` returns exactly the matching service.
- A `#g` filter at one precision returns the near service and **not** the far one.
- No multi-letter tag is used as a filter anywhere.
- Dashboard renders from cache with the relay unreachable, and says so.
- Recorded: which relays index which tags.

## Curator allow-list (`curators.json`)

The dashboard renders **only** announcements whose signing npub is in
`curators.json`. It is a plain committed file — there is no admin UI and no
runtime trust fetch — so **a fork changes the list, not the code**, and the
deployment's curation history is its own git history.

- Unknown npub → **not rendered** (fail closed). An empty list renders nothing.
- Registry #1 is curated by us: `npub1ftjlarsn0k4g5wmxnjcae48u2nl20vfu2lf3rjdqrht89h9z0fhsah7hqu`
  (see the `derived_from` field for how it was derived; re-derive, do not trust
  this line blindly).
- Dashboard #1 is hosted **publicly** behind a subdomain of `orangesync.tech`
  (target `cvm.orangesync.tech`) — per ADR-0001 D6/D12a.

Rules that do not bend: the dashboard is a **cache, not a proxy** (never make a
per-service CVM call to paint the list), and a stale cache must **disable**, not
silently show old state as live.

## Input-requirement filters (privacy)

The dashboard MUST be able to filter services by **what they ask of the user**,
from the register in `contextvm-services/docs/spec/service-inputs.md`
(machine copy `vocab/service-inputs.json`, which this repo reads):

- `t=cvm:req:<field>` required, `t=cvm:opt:<field>` optional,
  `t=cvm:req:none` sentinel (needs no user-supplied data).
- User-facing control is the **tier shorthand** — "no personal data" = tiers
  `none` + `financial` — not a wall of field names.
- **The relay `#t` filter is a prefilter only — but a good one.** Filter server-side
  on `cvm:tier:*` (the max tier the provider declares), so "no personal data" is one
  `REQ`: `#t:[cvm:tier:none,cvm:tier:financial]`. Several values for one tag letter
  are OR, never AND, so the **field-level** AND is computed **locally on the cache**
  (consistent with "cache, not proxy"). Reporting a server-side count as the
  field-level result is wrong.
- **Recompute the tier** from the declared fields; when it disagrees with the
  published `cvm:tier:*` tag, use the recomputed value and surface the mismatch.
- **Absent is not `none`**: no `cvm:req:*` tag at all → group as **unclassified**.
- **Unknown field names fail loud**: render as an unknown requirement, never count
  the service as `cvm:req:none`. A filter that silently drops what it does not
  understand is worse than no filter.
- The declaration is the provider's word on a public tag. Show it as a
  declaration; do not badge it as audited.

## Mirror, CI and releases on Nostr (ngit)

This repository is mirrored to **ngit** — git hosting and CI on Nostr. The mirror
carries the default branch, every `pr/<slug>` branch and every tag, so the whole
repository is reachable without GitHub.

Clone it over Nostr (the `nostr://` remote speaks the ngit protocol):

```bash
git clone nostr://npub1nng5mxkdh2mu593twukfr7j3fk5wxfy0v8ujf0e5g8nwwtzlphhqksqpew/relay.ngit.dev/cvm-registry
git clone https://relay.ngit.dev/npub1nng5mxkdh2mu593twukfr7j3fk5wxfy0v8ujf0e5g8nwwtzlphhqksqpew/cvm-registry.git
git clone https://gitnostr.com/npub1nng5mxkdh2mu593twukfr7j3fk5wxfy0v8ujf0e5g8nwwtzlphhqksqpew/cvm-registry.git
```

- **Browse / open PRs:** https://gitworkshop.dev/npub1nng5mxkdh2mu593twukfr7j3fk5wxfy0v8ujf0e5g8nwwtzlphhqksqpew/relay.ngit.dev/cvm-registry
- **CI:** every push is built by [ngit-CI](https://ci.orangesync.tech) — the
  workflows run from the **ngit side**, so the mirror above is the build of record.
- **Announcement (source of truth for the URLs above):** kind `30617`,
  `d=cvm-registry`, by `9cd14d9acdbab7ca162b772c91fa514da8e3248f61f924bf3441e6e72c5f0dee`, relays: `wss://relay.ngit.dev wss://gitnostr.com`

### Build artifacts (Nostr, not GitHub releases)

Artifacts are published as NIP-94 **kind `1063`** events, not attached to GitHub
releases. Each event carries one `url` tag per Blossom mirror and an `x` tag with
the file's **sha256** — download from any mirror and verify the hash.

No kind-`1063` artifact is announced for this repo yet, so here is the exact query:

```bash
nak req -k 1063 -t "A=30617:9cd14d9acdbab7ca162b772c91fa514da8e3248f61f924bf3441e6e72c5f0dee:cvm-registry" wss://relay.ngit.dev   # url + x tags
```

When one appears, download from any `url` and prove the `x` sha256 before use:

```bash
echo "<x-tag-sha256>  artifact" | sha256sum -c -
```

---
*Generated by `ngit-readme-section.sh` from the live kind-`30617` announcement
`2546a5146f688e3029336a39823dd6bf91d23d23ddd6e8dc4061c999a3a3d522` (created 1791154672). Doc not be hand-edited: re-run the generator.*
