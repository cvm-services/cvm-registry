# fixtures — real relay events, no fabrication

Everything in this directory is a **capture**, not an invention.

| file | what it is |
| --- | --- |
| `real-events.ndjson` | 66 unmodified CEP-6 events (kinds 11316–11320) as served by `wss://relay.damus.io`, captured 2026-10-05 with `collector/dump_events.ts`. Bodies, tags, signatures untouched. |
| `curators.demo.json` | a **demo** allow-list of three real relay authors present in the capture, used only to exercise the render path. |
| `demo-catalog.json` | the catalog `collector/collect.ts --input fixtures/real-events.ndjson --allowlist fixtures/curators.demo.json --now 1791167000` produces from the two files above. |

## These are not the deployment

The deployed dashboard uses `../curators.json` as its allow-list and a catalog
built from live relays by the host timer. Nothing in `fixtures/` is curation and
nothing here is served by `cvm.orangesync.tech`.

## A finding worth recording

None of the 66 announcements in the wild carried a single `cvm:service:*`,
`cvm:req:*`, `cvm:opt:*` or `cvm:tier:*` tag, and only a few carry `d`. So the
demo catalog renders six entries that are **all `unclassified`** — the dashboard
says so out loud instead of counting them as `cvm:req:none`. The tagging contract
in ADR-0001 is still a draft that the ecosystem does not publish yet; until it
does, "unclassified" is the honest answer and the tier filter matches none of them.

The tier-recompute, unknown-field and mismatch paths are exercised by
`tests/lib_test.ts` against the spec's own example tag sets, because no live
announcement carries those tags yet.
