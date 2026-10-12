# akkudirekt.de webshop mockups (pre-build)

Companion to `docs/analysis/akkudirekt-webshop-gap-analysis.md`.
Same house style as `../facilitated-orders/` (restaurant set): sats-first,
one primary action per screen, details behind one disclosure.

Render: `bash shot.sh` → `png/` (9 PNGs, DOM-guarded, size-guarded).

- `customer.html` — 6 phone screens: fit-finder → results → product/fit
  compare → basket (+Pfand) → pay → status (shipping states, deposit refund,
  price-drift warning).
- `facilitator.html` — 3 desktop screens: queue (aging SLA, drift/refund
  rows) → order detail with the shop's own checkout side-by-side → settlements.

What is REAL here: nothing is wired to a backend. These are design artifacts.
What they ASSUME exists: a webshop venue adapter + chunked/facet-filtered
catalogue (gap G1) and the margin-band fee model (G4). Not built.
