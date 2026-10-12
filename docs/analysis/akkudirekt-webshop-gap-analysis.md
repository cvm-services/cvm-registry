# Gap analysis — ContextVM facilitated ordering applied to e-commerce webshops (akkudirekt.de)

> **STATUS: CONSULTANT ANALYSIS — NOT A DECISION RECORD.** Not an ADR, no
> operator decision, no authorisation to build. Mockups attached are
> pre-build artifacts per the plan gate.

Date: 2026-10-12 · Author: manager (Felix session) · Lens: venue-adapter
integration · Depends on: ADR-0007 (venue adapter interface), ADR-0008
(payment-rail arbiter), ADR-0013 (fiat leg), `docs/plans/PLAN-0005-orderable-venues.md`,
`docs/plans/PLAN-0007-facilitated-orders.md`

## 0. Answer first

**Yes — the same ContextVM system applies to webshops, and MORE of it
reuses than you suspected.** The customer mockup must change (batteries are
a spec-matched, not a craving-matched, product), but the facilitator
integration is *structurally identical* to the restaurant case — the
facilitator plays the same "human places the order in the shop's own
checkout" role. What changes is not the pattern but the **order-placement
surface**: restaurants have phone/web-form; webshops have a *proper
checkout* with account, address, payment — which actually makes the
facilitator's job *easier* (fully self-service ordering), while making
**fulfilment** the new hard part (shipping, not pickup).

**Five findings that carry it:**

1. **The CVM core (announcement → catalogue → basket → sats payment →
   facilitator state machine) is domain-blind.** Nothing in
   `restaurant-cvm`'s `anchor.ts`/`e2e_client.ts`/`menu` tool protocol
   knows "food". Catalogue = items with SKUs and prices; the PWA renders
   whatever `menu.json` carries. A webshop catalogue is *more* structured
   (facets, compat data), not less. [COMPUTED: reuse fraction — see §4]

2. **The webshop is a better "venue" than the restaurants.** akkudirekt
   has: stable SKUs (`Produktnummer`), live price display, faceted search
   (Hersteller/Spannung/Kapazität/Kälteprüfstrom/dimensions), 24 products
   per page, category trees by Ah. The restaurant scrape produced prices
   *from a PDF menu*; a webshop catalogue can be captured with the same
   capture tool — richer and *more* deterministic (server-rendered product
   pages). **But it is big**: 24/page × many categories ≈ thousands of
   SKUs (exact count TODO), vs 100 items for Three Buddies. The
   `~110 KB` menu-event size problem we solved for relay2 would recur at
   a 10–50× worse scale → catalogue events must be **chunked** or the
   venue CVM must serve **query-filtered subsets** (facets as tools).

3. **The facilitator pattern survives with ONE change: they place the
   order via the webshop's own checkout instead of phone.** This is
   STRICTLY EASIER for placement (no phone queue, no language barrier,
   no "the website is down"). The new hard parts are (a) **shipping
   address + account** — the facilitator uses their own re-shipping
   arrangement or the customer's address; (b) **stock & delivery
   windows** — a battery is not a pizza: lead time is days, not minutes;
   (c) **returns/deposit** — Batteriepfand (+7,50 €/battery on some
   products) and 14-day EU withdrawal rights are line items and
   workflows the restaurant flow never had.

4. **The customer mockup changes shape: fit-finding, not browse-and-crave.**
   Restaurants: venue list → menu → basket. Webshop: **vehicle-fit or
   spec search → filtered results → compare → basket**. The mockup below
   keeps every redesign rule from the restaurant set (one primary action,
   sats-first, details-behind-one-disclosure) but the home screen is a
   **fit finder** (KBA-Nr./model or capacity/specs) and the item screen
   carries a **compat verdict** ("Fits your VW Golf VII") — the
   trust-bearing element that replaces "restaurant is open".

5. **Two gaps get WORSE, not better, for webshops — and mockups cannot
   paper over them.** (a) **Merchant of record + VAT**: a facilitator
   buying as a consumer (their card, their account) makes the *shop* the
   merchant of record selling to the facilitator, and the facilitator an
   unlicensed *reseller* to you — the restaurant flow had the same
   issue but lower stakes (a €13.50 meal); for a €91 battery + Pfand +
   shipping + VAT margin, this is a real business-model question, not an
   implementation detail. (b) **Price volatility**: restaurant prices are
   sticky; webshop prices move (sales, stock) between customer payment
   and facilitator purchase → the facilitator fee model must become a
   **margin band** ("up to X% or capped €Y"), with the difference settled
   as refund or top-up invoice. The state machine needs two new states:
   `price_changed` and `refund_owed` — the mockup shows both.

## 1. The system under review (what we have)

The Steglitz chain, live today:

```
venue CVM (per-venue npub, restaurant-cvm)
  kind 11316 announcement → relay2 (strfry, 256 KB events)
  tools: menu → wrapped catalogue event; order → signed order reply
customer PWA (cvm-pwa.orangesync.tech/order/)
  menu.json ← live-captured from venue CVMs (cvm-registry capture tool)
  basket → POST /api/orders (cvm-orders)
cvm-orders (server-side pricing from committed venues.json, ADR-0008)
  awaiting_payment → (LN invoice) → paid → … → facilitator transitions
facilitator console (cvm-pwa.orangesync.tech/console/)
  NIP-98 challenge → queue → place order at venue by phone/web
  → transitions: placing → placed → ready/picked_up, refunds_owed
```

Evidence: la-mama `a22d5f6ddae7` 18.50 € and three-buddies `38f4466251fc`
13.50 € baskets round-tripped green over relay2 (PROGRESS.md, evidence/*.json).

## 2. What akkudirekt.de actually is (recon, 2026-10-12)

| property | finding | how observed |
|---|---|---|
| Platform | Shopware 6 (JS-rendered SPA shell; `shopware` strings in HTML) | curl + rendered DOM |
| Catalogue | Faceted: Hersteller, Serie, Spannung, Kapazität (Ah), Kälteprüfstrom, L×B×H, Bodenleiste, Schaltung, Start-Stopp, Bauart | rendered category page filter rail |
| SKU | `Produktnummer` per product (e.g. `EB558`) | product card |
| Pricing | Regulärer Preis + **zzgl. 7,50 € Batteriepfand** (deposit) on applicable products | product card |
| Navigation | KBA-Nr. / Modell / OE-Nummer fit-finders on home | home DOM |
| Pagination | 24 products/page, deep categories (Autobatterien-nach-Kapazitaet/bis-60Ah …) | category page |
| Checkout | Standard Shopware: account, cart, checkout, PayPal/card etc. (nav links `/checkout/cart`, `/account/order`) | nav DOM |
| Payment methods | Not enumerated in this pass — TODO(unverified); footer links exist (`Zahlungsarten`) | footer |

Scale: **24 products per category page, multi-level category tree**. The
catalogue is order-of-magnitudes larger than a restaurant menu. Exact SKU
count: **TODO(unverified)** — not needed for the architecture decision.

## 3. Component-by-component gap table

Reuse levels: **REUSE** (works as-is) · **ADAPT** (same pattern, new
content) · **NEW** (no precedent in the restaurant system).

| # | Component | Restaurant (today) | Webshop case | Level |
|---|---|---|---|---|
| C1 | Venue identity (npub + kind 11316/11317 announcements) | per-venue npub minted, announced on relay2 | identical — "akkudirekt" is just another venue | **REUSE** |
| C2 | Catalogue capture (`capture_menu.py` → menu.json) | scrapes venue CVM `menu` tool over relay | same tool; needs facet-aware capture + **chunking** (see F2) | **ADAPT** |
| C3 | Catalogue event size | ~110 KB Three Buddies menu (needed relay2 256 KB) | **MB-scale** if full catalogue in one event → must chunk or serve filtered subsets | **NEW work** |
| C3 | Catalogue capture (cvm-registry capture tool) | restaurant `menu` tool result → menu.json | same capture, but facet tree + stock states; chunked events | **ADAPT** |
| C4 | `option_group_ids` / item options | sauce/size/extras per item | Pfand flag, terminal type, accessories (cables) — flat, simpler | **REUSE** |
| C5 | Customer PWA render | venue list → menu → item | **fit-finder home** + spec-compare rows | **ADAPT** (new mockup, below) |
| C6 | Basket → server pricing (cvm-orders, ADR-0008) | server recomputes from committed venues.json | identical; venues.json gains webshop venue with Pfand line rules | **REUSE** |
| C7 | Payment rail (LN invoice, expiry, sweep) | awaiting_payment → paid | identical | **REUSE** |
| C8 | Facilitator placement | phone call / venue web form | **webshop's own checkout** — self-service, easier; but account/address/stock | **ADAPT** |
| C9 | Fulfilment states | placing → placed → ready → picked_up | + shipping: dispatched → delivered; lead time days | **ADAPT** |
| C10 | Refunds | refunds_owed exists (restaurant case) | **first-class**: price drift, stock-out after payment, withdrawal right | **ADPUTE→ NEW emphasis** |
| C11 | Merchant of record / VAT | low stakes (one meal) | high stakes — see F5(a) | **NEW decision needed** |
| C12 | Price volatility | static menu prices | **margin-band fee model** + `price_changed` state | **NEW** |
| C13 | `service-inputs` register (ADR-0011) | name/phone/notes | + shipping address, delivery preference | **ADAPT** |
| C14 | Trust chip | "no client key custody" | + "deposit (Pfand) included/excluded" honesty line | **REUSE** |

## 4. Reuse arithmetic (why this is cheap)

The restaurant chain has these code artifacts (sizes = `wc -l`):

- `restaurant-cvm/anchor.ts` + `e2e_client.ts` + server: venue CVM core — **domain-blind**
- `cvm-registry` capture → `menu.json`: **schema-agnostic** (venues[].items[])
- `cvm-orders` server-side pricing + invoice + sweep: **venue-blind** (catalog
  lookup by slug)
- PWA `/order/` app.js + `/console/`: **renders whatever menu.json gives**
- Facilitator console queue: state machine, NIP-98 auth — **domain-blind**

What is genuinely NEW for a webshop venue:

1. **Catalogue chunking / facet filtering** in the venue CVM `menu` tool —
   the one real engineering task (C3). Design options in §6.
2. **Fit-finder UI** in the PWA (C5) — new mockup delivered herewith.
3. **Margin-band fee model + price_changed/refund flows** in cvm-orders
   state machine (C10/C12) — small, well-bounded.
4. **Shipping fields** in service-inputs (C13) — trivial.

Everything else is content, not code.

## 5. The five gaps that remain open (ranked by risk × effort)

| gap | risk | effort | note |
|---|---|---|---|
| G1 Catalogue at webshop scale (chunking/facets) | medium (perf/correctness) | **medium** — the real work | options §6 |
| G2 Shipping + address + account (facilitator side) | medium | low | facilitator uses own account + re-ship or customer address |
| G3 Merchant of record / VAT margin | **high** (legal/business) | low code, decision needed | blockable on operator |
| G3 Pfand/withdrawal handling | medium | low | line item + refund flow |
| G4 Price drift between pay & purchase | medium | medium | margin band + price_changed state |
| G5 Stock-outs after payment | medium | low | refund flow reuses refunds_owed |

Only G3 needs the operator (business-model call: facilitator-as-reseller
vs facilitator-as-agent with disclosed pass-through). The rest are
engineering follow-ons in the same repos.

## 6. G1 design options (catalogue at scale)

- **Option A — chunked catalogue events**: menu tool emits N ≤256 KB
  wrapped events, client reassembles. Simple, but client fetch cost grows
  linearly with catalogue; facets still need a client-side index.
- **Option B — facet-filtered menu tool**: menu tool takes a filter
  (category/facet subset, e.g. `?capacity=60Ah`), venue CVM replies with
  the matching slice. **Recommended** — matches how shoppers actually use
  the shop (they arrive via a fit question), keeps events small, reuses
  the existing tool protocol verbatim (adds an optional query param).
- **Option C — full catalogue + client-side facets**: one big capture,
  facet filtering in the PWA. No backend work, but the MB-scale event
  problem returns (and relay2 is the only relay that would carry it).

**Recommendation: B**, with A as the transport fallback for "browse all
in category X" screens. C rejected: recreates the size problem at 10×.

## 7. Mockup set (delivered, see `png/`)

`docs/ui-mockups/akkudirekt/` — same house style as the restaurant set
(`../facilitated-orders/`), sats-first, one primary action per screen:

- `customer.html` — 6 phone screens: fit-finder home → filtered results
  → product compare → basket (+Pfand line) → pay (sats invoice) → status
  (shipped/delivered, refund state if price drifts)
- `facilitator.html` — 3 desktop screens: queue → order view with the
  **webshop checkout side-by-side** (basket-to-enter, live price check
  before commit) → settlement/refunds

Deliberately reused: trust chip, sats-first pricing, state chips, one
primary action, "details behind one disclosure". Deliberately changed:
fit-finder replaces venue list; compare rows replace item options;
shipping states replace pickup states; Pfand + refund rows surface.

## 8. Open items

- [ ] akkudirekt SKU count + full facet list (capture script run) — TODO(unverified)
- [ ] akkudirekt payment methods + whether guest checkout exists — TODO(unverified)
- [ ] Pfand rules by product class (which products carry +7,50 €) — TODO(unverified)
- [ ] G3 decision (merchant of record model) — operator call
- [ ] relay2 event-size ceiling for chunked catalogues — measure