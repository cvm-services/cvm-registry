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
