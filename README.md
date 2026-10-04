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
- **The relay `#t` filter is a prefilter only.** Several values for one tag letter
  in a `REQ` are OR, never AND, so the AND is computed **locally on the cache**
  (consistent with "cache, not proxy"). Reporting a match count without the local
  AND is wrong.
- **Absent is not `none`**: no `cvm:req:*` tag at all → group as **unclassified**.
- **Unknown field names fail loud**: render as an unknown requirement, never count
  the service as `cvm:req:none`. A filter that silently drops what it does not
  understand is worse than no filter.
- The declaration is the provider's word on a public tag. Show it as a
  declaration; do not badge it as audited.
