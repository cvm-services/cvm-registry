/**
 * The REAL capture must render: `site/menu.json` -> one spec per venue.
 *
 * The fixture-based suite (`render_spec_test.ts`) proves the rules against one
 * 76-item venue. This suite proves them against the capture the deployment
 * actually serves — every venue in it.
 *
 * Why it exists: the spec size cap is enforced WHOLESALE (a spec over the cap is
 * refused and NOTHING is painted). A cap tuned on a 76-item venue silently made a
 * 112-item venue invisible — the page loads, the button works, and no menu
 * appears. That is a fail-closed behaviour, which is right, but it must not be
 * reachable by an ordinary venue. This test is the guard.
 *
 * Run: deno test --allow-read tests/menu_capture_test.ts
 */
import { buildServiceSpec, servedMethods } from "../site/render/spec.js";
import { SPEC_MAX_BYTES, menuItemIndex } from "../site/render/catalog.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + msg);
}

const capture: any = JSON.parse(
  await Deno.readTextFile(new URL("../site/menu.json", import.meta.url)),
);

Deno.test("the capture is a real one, with provenance per venue", () => {
  assert(Array.isArray(capture.venues) && capture.venues.length > 0, "capture carries venues");
  for (const v of capture.venues) {
    const c = v._capture;
    assert(c && c.server_pubkey && c.captured_at, `${v.venue_slug}: no _capture block`);
    assert(
      typeof c.tool === "string" && c.tool.includes("e2e_client.ts"),
      `${v.venue_slug}: provenance does not name the client that produced it`,
    );
    assert(
      typeof c.method === "string" && c.method.includes("tools/call menu"),
      `${v.venue_slug}: provenance does not name the step`,
    );
    assert(
      String(c.server_pubkey).length === 64,
      `${v.venue_slug}: server_pubkey is not a hex pubkey`,
    );
  }
  assert(capture.tools.includes("menu") && capture.tools.includes("order"), "capture carries the served tools");
});

// One test per venue, so a failure names the venue that broke.
for (const v of capture.venues) {
  Deno.test(`${v.venue_slug}: the real capture renders within the spec cap`, () => {
    assert(v.item_count === v.items.length, `${v.venue_slug}: item_count disagrees with items[]`);
    const entry = { d: v.venue_slug, name: v.name, caps: [{ tool: "order" }], links: ["https://example.invalid/"] };
    const methods = servedMethods(entry, v);
    assert(methods.length > 0, `${v.venue_slug}: no fulfilment method is served`);

    const spec: any = buildServiceSpec(entry, v, { method: methods[0], selection: [] });
    const bytes = JSON.stringify(spec).length;
    assert(
      bytes <= SPEC_MAX_BYTES,
      `${v.venue_slug}: spec is ${bytes} bytes for ${v.item_count} items, ` +
        `over the ${SPEC_MAX_BYTES}-byte cap — the view would refuse to paint anything`,
    );

    const rows = Object.values<any>(spec.elements).filter((e) => e.component === "PriceRow");
    assert(
      rows.length === v.item_count,
      `${v.venue_slug}: ${rows.length} PriceRows for ${v.item_count} items`,
    );

    // every stated price must be a served price for that item and method,
    // resolved the way the renderer does: `id` first, then a unique sku
    const index = menuItemIndex(v.items);
    const menuItems = Object.entries<any>(spec.elements).filter(([, e]) => e.component === "MenuItem");
    const wrong: string[] = [];
    for (const [id, el] of menuItems) {
      const served = index.resolve(el.props.id, el.props.sku);
      if (!served) { wrong.push(`${id}: not a single served item`); continue; }
      for (const childId of el.children ?? []) {
        const row = spec.elements[childId];
        if (row?.component !== "PriceRow") continue;
        const want = served.prices_by_order_method?.[row.props.method];
        if (want === undefined) wrong.push(`${id}/${row.props.method}: capture carries no such price`);
        else if (row.props.amount !== want) wrong.push(`${id}: stated ${row.props.amount}, served ${want}`);
      }
    }
    assert(wrong.length === 0, `${v.venue_slug}: ${wrong.length} price(s) not reproducible: ${wrong.slice(0, 3).join("; ")}`);
  });
}
