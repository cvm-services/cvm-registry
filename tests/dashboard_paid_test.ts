/**
 * dashboard_paid_test.ts — runs the REAL site/app.js against a small DOM stub
 * and asserts what it renders (part of the paid-CVM discovery card).
 *
 * Why this file exists: "declared and received are visually distinct and
 * labelled" and "the filter is amount-based and demonstrably excludes
 * amount: 0" are claims about the PAGE, not about the collector. A unit test on
 * collector/paid.ts cannot show that the dashboard keeps the two apart. So the
 * shipped source of site/app.js is loaded verbatim (not copied, not re-typed)
 * into a hand-rolled DOM stub and driven through render().
 *
 * It is STRUCTURAL evidence, not a browser render: no layout, no CSS engine.
 * The colours assigned to `.declared` / `.received` live in site/style.css and
 * are checked textually at the end (`declared` and `received` must not share a
 * style rule), which is the strongest offline statement about distinctness —
 * the real distinction is carried by different element classes and headers,
 * and those ARE asserted structurally.
 *
 * Run: deno test --allow-read   (local only, no network)
 */

import { hasDeclaredPrice } from "../collector/lib.ts";

// ----------------------------------------------------------------- DOM stub --

class StubText {
  nodeType = 3;
  constructor(public textContent: string) {}
}

class StubEl {
  nodeType = 1;
  children: Array<StubEl | StubText> = [];
  className = "";
  title = "";
  type = "";
  value = "";
  placeholder = "";
  href = "";
  rel = "";
  target = "";
  dataset: Record<string, string> = {};
  onclick: (() => void) | null = null;
  oninput: (() => void) | null = null;
  #text = "";

  constructor(public tagName: string) {}

  get textContent(): string {
    if (this.children.length === 0) return this.#text;
    return this.children.map((c) => c.textContent).join("");
  }

  set textContent(v: string) {
    // Real DOM: assigning replaces every child with a single text node.
    this.children = [];
    this.#text = v;
  }

  append(...nodes: Array<StubEl | StubText | string>) {
    for (const n of nodes) this.children.push(typeof n === "string" ? new StubText(n) : n);
  }

  /** every descendant element whose class list contains `cls` */
  findAll(cls: string): StubEl[] {
    const out: StubEl[] = [];
    for (const c of this.children) {
      if (!(c instanceof StubEl)) continue;
      if (c.className.split(/\s+/).includes(cls)) out.push(c);
      out.push(...c.findAll(cls));
    }
    return out;
  }

  /** every descendant element with this tag name */
  findAllTag(tag: string): StubEl[] {
    const out: StubEl[] = [];
    for (const c of this.children) {
      if (!(c instanceof StubEl)) continue;
      if (c.tagName === tag) out.push(c);
      out.push(...c.findAllTag(tag));
    }
    return out;
  }
}

function makeDocument() {
  const root = new StubEl("div");
  return {
    root,
    document: {
      querySelector: (sel: string) => (sel === "#app" ? root : null),
      createElement: (tag: string) => new StubEl(tag),
      createTextNode: (t: string) => new StubText(t),
      addEventListener: () => {},
    },
  };
}

/** Load the SHIPPED app.js source and expose the internals this test drives. */
function loadApp() {
  const src = Deno.readTextFileSync("site/app.js");
  const { root, document } = makeDocument();
  const location = { host: "cvm.test", href: "http://cvm.test/" };
  const noop = () => 0;
  // deno-lint-ignore no-new-func
  const factory = new Function(
    "document",
    "location",
    "setInterval",
    "clearInterval",
    src +
      "\n;return { render, UI, setCatalog: (c) => { CATALOG = c; }, hasDeclaredPrice, pricedCaps };" +
      "\n//# sourceURL=site/app.js",
  );
  const api = factory(document, location, noop, noop);
  return { api, root };
}

// ------------------------------------------------------------- test fixtures --

const VENUE_ID = "11".repeat(32);
const FREE_ID = "22".repeat(32);
const CURATOR = "npub1ftjlarsn0k4g5wmxnjcae48u2nl20vfu2lf3rjdqrht89h9z0fhsah7hqu";

function entry(over: Record<string, unknown>) {
  return {
    event_id: "00".repeat(32),
    kind: 11316,
    pubkey: "ab".repeat(32),
    npub: CURATOR,
    d: "venue",
    created_at: 1_790_000_000,
    classes: ["restaurant"],
    name: "Test venue",
    about: null,
    website: null,
    links: [],
    geohashes: [],
    caps: [],
    tier: { declared: [], recomputed: "none", mismatch: false },
    requirements: { required: [], optional: [], unknown: [], none_sentinel: true, unclassified: false },
    ...over,
  };
}

const PAID_ENTRY = entry({
  event_id: VENUE_ID,
  d: "paid-venue",
  name: "Paid venue",
  caps: [{ tool: "menu", amount: 0, unit: "sats" }, { tool: "order", amount: 1500, unit: "sats" }],
});
const FREE_ENTRY = entry({
  event_id: FREE_ID,
  d: "free-venue",
  name: "Free venue",
  // The literal real-world row: a cap tag that declares NO price.
  caps: [{ tool: "order", amount: 0, unit: "sats" }],
});

function catalog(entries: unknown[], withPaidBlock: boolean) {
  const base: Record<string, unknown> = {
    generated_at: Math.floor(Date.now() / 1000),
    generated_at_iso: new Date().toISOString(),
    policy: { freshness: { fresh_ttl_seconds: 900, max_age_seconds: 21600, clock_skew_seconds: 120 } },
    allowlist: { curators: [{ npub: CURATOR }] },
    counts: { dropped_not_allowlisted: 0 },
    entries,
  };
  if (withPaidBlock) {
    base.paid = {
      declared_label: "DECLARED-LABEL-TEXT",
      received_label: "RECEIVED-LABEL-TEXT",
      doctrine: "declared caps are advertisements; receipts are payments; the two are never summed",
      counts: {
        entries_with_declared_price: 1,
        entries_with_receipts: 1,
        receipts_matched: 3,
        sats_from_receipt_tag: 21,
        sats_from_zap_request: 5,
        receipts_amount_unknown: 1,
      },
      entries: [
        {
          event_id: VENUE_ID,
          declared: [{ tool: "order", amount: 1500, unit: "sats" }],
          declared_label: "DECLARED-LABEL-TEXT",
          received: {
            count: 2,
            sats_from_receipt_tag: 21,
            sats_from_zap_request: 5,
            count_amount_unknown: 1,
            receipt_ids: ["a", "b", "c"],
            request_amount_receipt_ids: ["b"],
            amount_unknown_receipt_ids: ["c"],
            label: "RECEIVED-LABEL-TEXT",
          },
          received_label: "RECEIVED-LABEL-TEXT",
        },
      ],
    };
  }
  return base;
}

function ok(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}
function eq(a: unknown, b: unknown, what: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
  }
}

// ------------------------------------------------------------------- tests --

Deno.test("dashboard: the declared-price filter is amount-based (a 0-sat cap is NOT paid)", () => {
  const { api, root } = loadApp();
  api.setCatalog(catalog([PAID_ENTRY, FREE_ENTRY], true));

  // The two implementations must agree: the page's filter and collector/lib.ts.
  eq(hasDeclaredPrice(PAID_ENTRY), true, "lib: amount 1500 is a declared price");
  eq(hasDeclaredPrice(FREE_ENTRY), false, "lib: amount 0 is not");
  eq(api.hasDeclaredPrice(PAID_ENTRY), true, "page: agrees on the paid entry");
  eq(api.hasDeclaredPrice(FREE_ENTRY), false, "page: agrees on the free entry — 'has caps' would have said paid");

  api.UI.paidOnly = false;
  api.render();
  eq(root.findAllTag("article").length, 2, "unfiltered: both cards render");

  api.UI.paidOnly = true;
  api.render();
  const cards = root.findAllTag("article");
  eq(cards.length, 1, "filtered: only the entry that declares a price > 0 survives");
  ok(cards[0].textContent.includes("Paid venue"), "and it is the paid one");
  ok(!cards[0].textContent.includes("Free venue"), "the free venue is gone even though it carries a cap tag");

  // The chip that drives the filter is labelled "declared", never "paid".
  api.UI.paidOnly = false;
  api.render();
  const chips = root.findAll("chip").filter((c) => c.tagName === "button");
  const priceChip = chips.find((c) => c.textContent.includes("declares a price > 0 sats"));
  ok(priceChip, "the price chip is in the controls");
  ok(priceChip!.textContent.includes("declared"), "and it says 'declared'");
});

Deno.test("dashboard: declared and received are separate, differently-labelled blocks", () => {
  const { api, root } = loadApp();
  api.setCatalog(catalog([PAID_ENTRY, FREE_ENTRY], true));
  api.render();

  const cards = root.findAllTag("article");
  eq(cards.length, 2, "two cards before filtering");
  const paidCard = cards.find((c) => c.textContent.includes("Paid venue"));
  ok(paidCard, "the paid card is rendered");

  const declaredBlocks = root.findAll("declared");
  const receivedBlocks = root.findAll("received");
  eq(declaredBlocks.length, 2, "both entries declare something (one of them at 0)");
  eq(receivedBlocks.length, 1, "only the venue with observed receipts gets a received block");

  const declared = paidCard!.findAll("declared")[0];
  const received = receivedBlocks[0];
  ok(declared !== received, "they are different elements, not one merged box");
  ok(declared !== undefined, "the paid card has a declared block");

  const headers = (n: StubEl) => n.findAllTag("h4").map((h) => h.textContent);
  eq(headers(declared), ["DECLARED-LABEL-TEXT"], "declared block carries the collector's declared label");
  eq(headers(received), ["RECEIVED-LABEL-TEXT"], "received block carries the collector's received label");
  ok(headers(declared)[0] !== headers(received)[0], "the two headers are not the same string");

  // The provenance split is two separate rows, each naming its own strength.
  const strong = received.findAll("receipt-amount").map((n) => n.textContent);
  const claim = received.findAll("request-amount").map((n) => n.textContent);
  eq(strong.length, 1, "one strong-evidence row");
  eq(claim.length, 1, "one client's-claim row");
  ok(strong[0].includes("21 sats") && strong[0].includes("strong evidence"), `strong row: ${strong[0]}`);
  ok(claim[0].includes("5 sats") && claim[0].includes("client's claim"), `claim row: ${claim[0]}`);

  // No blended total anywhere: 21 + 5 = 26 must never be printed as one figure.
  const receivedText = received.textContent;
  ok(!/(^|[^\d])26 sats/.test(receivedText), `received block must not sum the two buckets: ${receivedText}`);
  ok(receivedText.includes("21 sats") && receivedText.includes("5 sats"), "both figures are visible, side by side");
  ok(receivedText.includes("never added together"), "and the block says so");
});

Deno.test("dashboard: a 0-sat declaration is shown as not-a-price, never as a price", () => {
  const { api, root } = loadApp();
  api.setCatalog(catalog([FREE_ENTRY], true));
  api.render();

  const card = root.findAllTag("article")[0];
  ok(!card.findAll("received").length, "no receipts, no received block");
  const declared = card.findAll("declared")[0];
  eq(declared.findAll("priced").length, 0, "the 0-sat tool is NOT listed as a price");
  ok(declared.textContent.includes("NOT counted as a price"), "and the card says why, out loud");
  ok(declared.textContent.includes("order (0 sats)"), "the tool is still disclosed, just not priced");
  ok(declared.textContent.includes("not a payment and it is not a settlement"), "the block refuses to imply settlement");
});

Deno.test("dashboard: a legacy catalogue without a paid block still renders, and adds nothing invented", () => {
  const { api, root } = loadApp();
  api.setCatalog(catalog([PAID_ENTRY], false));
  api.render();

  const card = root.findAllTag("article")[0];
  const declared = card.findAll("declared")[0];
  ok(declared, "the declared prices still render from the entry's own caps");
  eq(declared.findAll("priced").map((n) => n.textContent), ["order — 1500 sats declared"], "read from caps, not from a paid block");
  eq(card.findAll("received").length, 0, "and no received block is invented for receipts nobody observed");
});

Deno.test("dashboard: the two blocks are styled distinctly (no shared rule)", () => {
  const css = Deno.readTextFileSync("site/style.css");
  const rule = (sel: string) => {
    const m = css.match(new RegExp(`(^|\\n)\\${sel}\\s*\\{([^}]*)\\}`, "m"));
    ok(m, `no style rule for ${sel}`);
    return m![2];
  };
  const declared = rule(".declared");
  const received = rule(".received");
  ok(declared.includes("border-left"), "declared has its own accent");
  ok(received.includes("border-left"), "received has its own accent");
  const colour = (b: string) => (b.match(/border-left:\s*[^;]*#([0-9a-f]{6})/i) || [])[1];
  ok(colour(declared) && colour(received) && colour(declared) !== colour(received),
    `declared ${colour(declared)} and received ${colour(received)} must not share an accent colour`);
});
