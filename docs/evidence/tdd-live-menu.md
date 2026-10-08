# TDD evidence — the live menu capture, and the two defects it exposed

Both defects were found by testing the **real** capture (`site/menu.json`, captured
over `wss://relay.primal.net` from both venue CVMs) rather than the 76-item
fixture. Neither is visible to the fixture suite: one is a size threshold the
fixture sits under, the other needs a menu with a duplicated `sku`.

## Defect 1 — a 112-item venue was silently invisible

The spec size cap is enforced **wholesale**: an over-cap spec paints *nothing*.
The cap had been set from a 76-item venue.

RED — `tests/menu_capture_test.ts` against the real capture:

```
pizza-e-pasta-ruedesheimerplatz: the real capture renders within the spec cap => ./tests/menu_capture_test.ts:50:8
error: Error: ASSERT: pizza-e-pasta-ruedesheimerplatz: spec is 22622 bytes for 112 items,
       over the 16384-byte cap — the view would refuse to paint anything
FAILED | 2 passed | 1 failed (95ms)
```

Confirmed independently in a real browser against a local static server
(`e2e/live_deploy_check.mjs`):

```
[step] venue-view {"slug":"doppelt-kaese-berlin","rendered":76,"expected":76,"ok":true,"refusals":0}
[FAIL] pizza-e-pasta-ruedesheimerplatz: the service view opened but painted no menu items
[step] verdict {"verdict":"FAIL — 1 check(s) failed"}
```

GREEN — cap raised to 32 KiB on the measured numbers (doppelt 15 856 B / 76 items,
pizza 22 622 B / 112 items), with the measurement written into the constant:

```
ok | 115 passed | 0 failed
[step] venue-view {"slug":"pizza-e-pasta-ruedesheimerplatz","rendered":112,"expected":112,
                   "bytes":22852,"cap":32768,"ok":true,"refusals":0}
[step] verdict {"verdict":"PASS — 2 venue(s) rendered from the live capture"}
```

## Defect 2 — an ambiguous `sku` resolved to the wrong product

Pizza collides on skus 36 / 110 / 44 (the venue's own `order` tool already refuses
those and asks for the item `id`). The renderer's lookup was a `sku -> item` map
whose last write won, so a PriceRow could be verified against a *different*
product than the one it was named after. This one is worse than defect 1: it was
not fail-closed, it painted a **wrong price**.

RED — the same suite, after the cap was fixed:

```
error: Error: ASSERT: pizza-e-pasta-ruedesheimerplatz: 1 price(s) not reproducible:
       m36: stated 3.6, served 2.7
FAILED | 2 passed | 1 failed (42ms)
```

3.60 EUR is a real drink; 2.70 EUR is a different real drink. Same sku, different
product, and the spec named one while the price belonged to the other.

GREEN — one resolution rule, shared by the spec builder, the renderer and every
test oracle (`catalog.js` `menuItemIndex`): `id` first, then a sku **only** when
the capture carries it exactly once; an ambiguous sku resolves to nothing and the
element is refused rather than guessed. `orderPayload` now sends the venue `id`
where the sku is ambiguous, matching the tool's documented contract.

## What was NOT proven

- The capture is a point-in-time snapshot (2026-10-07). It is regenerated with
  `tools/capture_menu.py`, not hand-edited; each venue block carries its own
  `_capture` provenance (server pubkey, relay, method, checks).
- Only `primal` was used. `relay2` cannot carry these menus at all — its strfry
  `maxEventSize` (65536) is below both menu events (66045 / 76965 B).
- `pickup` prices only for pizza; doppelt serves pickup / delivery / dine_in /
  room_service. The other methods are untested because the venue does not serve
  them to a pickup basket.

## Reproduce

```bash
python3 tools/capture_menu.py                      # both venues, over a real relay
deno test --allow-read --allow-net --allow-env tests/
node e2e/catalog_render_e2e.mjs                    # fixture, hermetic
E2E_BASE_URL=<origin> node e2e/live_deploy_check.mjs   # the deployment
```
