# End-to-end evidence — restaurant announcements → dashboard → the venue's own ordering page

Hermetic capture, 2026-10-05. Every step below ran for real; nothing is mocked on
the CVM path. Re-run it with `e2e/venue_deep_link_e2e.py`.

## What is actually exercised

```
venues/<slug>/venue.json
  -> tools/emit-venue-announcement.ts   signed kind 11317, ONE KEY PER VENUE
  -> strfry relay  ws://127.0.0.1:7781  plain relay (no NIP-29 write policy)
  -> collector/collect.ts               allow-list applied, fail-closed
  -> site/catalog.json                  static cache
  -> site/index.html                    real browser, real click
  -> the venue's own ordering page
```

## What is NOT in this flow (labelled, not faked)

- **No ContextVM / MCP server call.** The announcement *declares* an `order`
  tool; this capture ends at the venue's own ordering rail.
- **No ring signature / anonymous-set proof.** The ring gate lives in
  `cvm-services/contextvm-services#pr/s4b-ring-gate` and is not part of this run.
- **No payment.** Nothing is bought, quoted, or settled.

## Provenance (from `venue-discovery-e2e.json`)

| venue | announced `r` | final URL | page title |
|---|---|---|---|
| doppelt-kaese-berlin | https://www.doppelt-kaese-berlin.de/speisekarte/doppeltkase | same (no redirect) | `Speisekarte \| doppelt Käse Berlin` |
| pizza-e-pasta-ruedesheimerplatz | https://pizzaepasta-ruedesheimerplatz.de/pizza-e-pasta/takeaway | same (no redirect) | `Essen bestellen bei Pizza e Pasta in Berlin` |

Relay read-back after publish: exactly 2 events, kind 11317, distinct pubkeys
(one per venue), each carrying `cvm:service:restaurant`, `cvm:tier:fulfilment`,
`g` geohashes and its `r` deep-link.

Collector: `raw=2 deduped=2 kept=2 dropped=0`.
Dashboard: `2 allow-listed announcement(s) from 3 curator(s), 2 shown after filters`.

## Video

[`venue-discovery-e2e.mp4`](https://github.com/cvm-services/cvm-registry/raw/pr/s2b-dashboard-e2e/docs/e2e/venue-discovery-e2e.mp4)

<video src="https://github.com/cvm-services/cvm-registry/raw/pr/s2b-dashboard-e2e/docs/e2e/venue-discovery-e2e.mp4" controls width="100%"></video>

The recording shows: dashboard load → both venue cards → the announcement's
declared tier and input appetite → click the first card's ordering deep-link →
**doppelt Käse's real Speisekarte** → back → click the second → **Pizza e Pasta's
real ordering page**.

## Stills

Dashboard, both venues:

![dashboard with both venue cards](https://github.com/cvm-services/cvm-registry/raw/pr/s2b-dashboard-e2e/docs/e2e/01-dashboard-two-venues.png)

The card, and the real page it opens:

![doppelt-kaese-berlin card](https://github.com/cvm-services/cvm-registry/raw/pr/s2b-dashboard-e2e/docs/e2e/02-card-doppelt-kaese-berlin.png)
![doppelt-kaese-berlin real menu page](https://github.com/cvm-services/cvm-registry/raw/pr/s2b-dashboard-e2e/docs/e2e/02b-venue-page-doppelt-kaese-berlin.png)

![pizza-e-pasta card](https://github.com/cvm-services/cvm-registry/raw/pr/s2b-dashboard-e2e/docs/e2e/03-card-pizza-e-pasta-ruedesheimerplatz.png)
![pizza-e-pasta real ordering page](https://github.com/cvm-services/cvm-registry/raw/pr/s2b-dashboard-e2e/docs/e2e/03b-venue-page-pizza-e-pasta-ruedesheimerplatz.png)

## Reproducing

```bash
# 1. a plain local relay (the fleet's 7780 is a NIP-29 relay and rejects these kinds)
strfry --config=~/.hermes/state/e2e-relay/strfry.conf relay &   # 127.0.0.1:7781

# 2. publish both announcements — one key per venue (kind 11317 is replaceable,
#    so a shared key makes the second announce silently overwrite the first)
deno run --allow-read --allow-net --allow-write tools/emit-venue-announcement.ts \
  --venue venues/doppelt-kaese-berlin/venue.json --kind 11317 \
  --key-file .scratch/doppelt-kaese-berlin.nsec --relays ws://127.0.0.1:7781
deno run --allow-read --allow-net --allow-write tools/emit-venue-announcement.ts \
  --venue venues/pizza-e-pasta-ruedesheimerplatz/venue.json --kind 11317 \
  --key-file .scratch/pizza-e-pasta-ruedesheimerplatz.nsec --relays ws://127.0.0.1:7781

# 3. collect
deno run --allow-net --allow-read --allow-write collector/collect.ts \
  --relays ws://127.0.0.1:7781 --allowlist fixtures/curators.e2e.json \
  --out site/catalog.json --policy policy.json --vocab vocab/service-inputs.json

# 4. serve and capture (headed Chrome under xvfb: the headless shell is
#    Cloudflare-challenged on the pizza venue)
python3 -m http.server 8137 --bind 127.0.0.1 --directory site &
xvfb-run -a python e2e/venue_deep_link_e2e.py --headed
```

`fixtures/curators.e2e.json` is the **e2e-only** allow-list: it adds the two
venue service keys so the collector renders them instead of dropping them
fail-closed. The public deployment keeps `curators.json`.
