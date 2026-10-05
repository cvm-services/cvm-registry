/**
 * Tests for collector/lib.ts — the hard rules of the registry.
 * Run: deno test --allow-read
 *
 * No third-party imports, so this passes with no network.
 */
import {
  applyAllowList,
  assertSingleLetterFilters,
  classify,
  dedupe,
  hexToNpub,
  matchesFieldAnd,
  matchesTierShorthand,
  npubToHex,
  parseCaps,
  parseLinks,
  parseCurators,
  tierPrefilter,
  type NostrEvent,
  type Vocab,
} from "../collector/lib.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + msg);
}
function assertEquals<T>(actual: T, expected: T, msg = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`ASSERT (${msg}): got ${a}, want ${b}`);
}
function assertThrows(fn: () => unknown, msg: string) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error("ASSERT (expected throw): " + msg);
}

/** Minimal slice of vocab/service-inputs.json used by the fixtures. */
const VOCAB: Vocab = {
  tiers: { none: "", financial: "", contact: "", fulfilment: "", legal: "", sensitive: "" },
  tier_tag: { ranks: { none: 0, financial: 1, contact: 2, fulfilment: 3, legal: 4, sensitive: 5 } },
  fields: {
    "payment.amount": { tier: "financial" },
    "payment.method": { tier: "financial" },
    "contact.name": { tier: "contact" },
    "contact.phone": { tier: "contact" },
    "ship.address": { tier: "fulfilment" },
    "ship.address.city": { tier: "fulfilment" },
    "order.items": { tier: "fulfilment" },
    "session.meter": { tier: "fulfilment" },
    "identity.dob": { tier: "sensitive" },
    "legal.terms": { tier: "legal" },
  },
};

const CURATOR_NPUB = "npub1ftjlarsn0k4g5wmxnjcae48u2nl20vfu2lf3rjdqrht89h9z0fhsah7hqu";

function ev(over: Partial<NostrEvent> & { tags: string[][] }): NostrEvent {
  return {
    id: over.id ?? "f".repeat(64),
    pubkey: over.pubkey ?? "a".repeat(64),
    created_at: over.created_at ?? 1_700_000_000,
    kind: over.kind ?? 11316,
    content: over.content ?? "",
    sig: over.sig ?? "0".repeat(128),
    tags: over.tags,
  };
}

// ---------------------------------------------------------------- bech32 ----

Deno.test("npub <-> hex: the curator npub round-trips", () => {
  const hex = npubToHex(CURATOR_NPUB);
  assertEquals(hex.length, 64, "hex length");
  assert(/^[0-9a-f]{64}$/.test(hex), "hex charset");
  assertEquals(hexToNpub(hex), CURATOR_NPUB, "round trip");
});

Deno.test("npub decoder fails closed on junk", () => {
  assertThrows(() => npubToHex("npub1notavalidchecksumxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), "bad checksum");
  assertThrows(() => npubToHex("nsec1" + CURATOR_NPUB.slice(6)), "wrong hrp");
  assertThrows(() => npubToHex(""), "empty");
});

// ---------------------------------------------------------------- dedupe ----

Deno.test("dedupe keeps the newest per (kind,pubkey,d) and is deterministic", () => {
  const older = ev({ id: "1".repeat(64), pubkey: "b".repeat(64), created_at: 100, tags: [["d", "berlin-01"]] });
  const newer = ev({ id: "2".repeat(64), pubkey: "b".repeat(64), created_at: 200, tags: [["d", "berlin-01"]] });
  const other = ev({ id: "3".repeat(64), pubkey: "b".repeat(64), created_at: 150, tags: [["d", "berlin-02"]] });
  const out = dedupe([older, newer, other]);
  assertEquals(out.length, 2, "two distinct d slugs");
  assertEquals(out.find((e) => e.tags[0][1] === "berlin-01")!.id, "2".repeat(64), "newest wins");
});

Deno.test("dedupe ties break on the larger event id (byte-stable output)", () => {
  const a = ev({ id: "a".repeat(64), pubkey: "c".repeat(64), created_at: 500, tags: [["d", "x"]] });
  const b = ev({ id: "b".repeat(64), pubkey: "c".repeat(64), created_at: 500, tags: [["d", "x"]] });
  assertEquals(dedupe([b, a])[0].id, "b".repeat(64), "deterministic pick");
  assertEquals(dedupe([a, b])[0].id, "b".repeat(64), "order independent");
});

// ------------------------------------------------------------ allow-list ----

Deno.test("curators.json parses and the npub becomes an allowable hex pubkey", () => {
  const al = parseCurators({ curators: [{ npub: CURATOR_NPUB, role: "curator" }] });
  assertEquals(al.errors, [], "no errors");
  assertEquals(al.hex.length, 1, "one hex entry");
  assertEquals(al.hex[0], npubToHex(CURATOR_NPUB), "hex matches");
});

Deno.test("an undecodable curator npub authorises nothing (fail closed)", () => {
  const al = parseCurators({ curators: [{ npub: "npub1broken" }] });
  assert(al.hex.length === 0, "no hex from a broken npub");
  assert(al.errors.length === 1, "error recorded");
});

Deno.test("allow-list drops unknown npubs; an empty list drops everything", () => {
  const mine = ev({ pubkey: npubToHex(CURATOR_NPUB), tags: [["d", "mine"]] });
  const stranger = ev({ pubkey: "9".repeat(64), tags: [["d", "theirs"]] });
  const r = applyAllowList([mine, stranger], [npubToHex(CURATOR_NPUB)]);
  assertEquals(r.kept.length, 1, "one kept");
  assertEquals(r.dropped.length, 1, "one dropped");
  const empty = applyAllowList([mine, stranger], []);
  assertEquals(empty.kept.length, 0, "empty allow-list renders nothing");
});

// ----------------------------------------------------------- tier + reqs ----

Deno.test("tier recompute: req:none + payment.amount => financial (the spec example)", () => {
  const c = classify(
    ev({ tags: [["t", "cvm:service:restaurant"], ["t", "cvm:req:none"], ["t", "cvm:req:payment.amount"], ["t", "cvm:tier:financial"]] }),
    VOCAB,
  );
  assertEquals(c.tier.recomputed, "financial", "recomputed");
  assertEquals(c.tier.declared, ["financial"], "declared");
  assertEquals(c.tier.mismatch, false, "no mismatch");
  assertEquals(c.requirements.none_sentinel, true, "sentinel seen");
  assertEquals(c.requirements.unclassified, false, "classified");
});

Deno.test("tier recompute takes the MAX rank across declared fields", () => {
  const c = classify(
    ev({ tags: [["t", "cvm:req:ship.address"], ["t", "cvm:req:contact.phone"], ["t", "cvm:tier:fulfilment"]] }),
    VOCAB,
  );
  assertEquals(c.tier.recomputed, "fulfilment", "fulfilment beats contact");
  assertEquals(c.tier.mismatch, false, "matches");
});

Deno.test("a wrong published tier is flagged and the recomputed value wins", () => {
  const c = classify(
    ev({ tags: [["t", "cvm:req:contact.name"], ["t", "cvm:opt:identity.dob"], ["t", "cvm:tier:contact"]] }),
    VOCAB,
  );
  assertEquals(c.tier.recomputed, "sensitive", "identity.dob forces sensitive");
  assertEquals(c.tier.declared, ["contact"], "declared kept for the mismatch display");
  assertEquals(c.tier.mismatch, true, "mismatch surfaced");
});

Deno.test("unknown field names fail loud and are never counted as req:none", () => {
  const c = classify(
    ev({ tags: [["t", "cvm:req:none"], ["t", "cvm:req:made.up"], ["t", "cvm:tier:none"]] }),
    VOCAB,
  );
  assertEquals(c.requirements.unknown, ["made.up"], "unknown surfaced");
  assertEquals(c.requirements.none_sentinel, true, "sentinel still recorded");
  assertEquals(c.tier.recomputed, "sensitive", "unknown is treated conservatively, not as none");
  assertEquals(c.tier.mismatch, true, "declared none disagrees with recomputed sensitive");
});

Deno.test("absent is not none: no req/opt tags => unclassified, tier null", () => {
  const c = classify(ev({ tags: [["t", "cvm:service:ev-charger"], ["g", "u33d"]] }), VOCAB);
  assertEquals(c.requirements.unclassified, true, "unclassified");
  assertEquals(c.requirements.none_sentinel, false, "no sentinel");
  assertEquals(c.tier.recomputed, null, "no tier claim");
  assertEquals(c.tier.mismatch, false, "nothing to contradict");
});

Deno.test("a service that publishes a tier tag but no fields still mismatches", () => {
  const c = classify(ev({ tags: [["t", "cvm:tier:financial"]] }), VOCAB);
  assertEquals(c.tier.recomputed, null, "no fields, no recompute");
  assertEquals(c.tier.mismatch, true, "declared tier with no field list is a contradiction");
});

// ------------------------------------------------------------- filtering ----

Deno.test("filters must be single-letter tags (D2)", () => {
  assertSingleLetterFilters({ kinds: [11316], "#t": ["cvm:service:restaurant"], limit: 10 });
  assertThrows(() => assertSingleLetterFilters({ "#service": ["restaurant"] }), "multi-letter tag filter");
  assertThrows(() => assertSingleLetterFilters({ service: ["restaurant"] }), "non-tag key");
});

Deno.test("tier shorthand prefilters on cvm:tier:* only", () => {
  assertEquals(tierPrefilter("no_personal_data"), ["cvm:tier:none", "cvm:tier:financial"], "no_personal_data");
  assertEquals(tierPrefilter("contact_only"), ["cvm:tier:none", "cvm:tier:financial", "cvm:tier:contact"], "contact_only");
  assertThrows(() => tierPrefilter("everything"), "unknown shorthand");
});

Deno.test("tier shorthand matches the RECOMPUTED tier, and never an unclassified entry", () => {
  const financial = classify(ev({ tags: [["t", "cvm:req:payment.amount"]] }), VOCAB);
  const contact = classify(ev({ tags: [["t", "cvm:req:contact.phone"]] }), VOCAB);
  const unclassified = classify(ev({ tags: [["t", "cvm:service:restaurant"]] }), VOCAB);
  assertEquals(matchesTierShorthand(financial, "no_personal_data"), true, "financial passes");
  assertEquals(matchesTierShorthand(contact, "no_personal_data"), false, "contact fails");
  assertEquals(matchesTierShorthand(contact, "contact_only"), true, "contact passes contact_only");
  assertEquals(matchesTierShorthand(unclassified, "contact_only"), false, "unclassified can never pass");
});

Deno.test("field-level AND is local, and an unknown declared field fails it by default", () => {
  const both = classify(ev({ tags: [["t", "cvm:req:ship.address"], ["t", "cvm:req:contact.phone"]] }), VOCAB);
  assertEquals(matchesFieldAnd(both, ["ship.address", "contact.phone"]), true, "both declared");
  assertEquals(matchesFieldAnd(both, ["ship.address", "payment.amount"]), false, "AND is not OR");
  const unknown = classify(ev({ tags: [["t", "cvm:req:ship.address"], ["t", "cvm:req:made.up"]] }), VOCAB);
  assertEquals(matchesFieldAnd(unknown, ["ship.address"]), false, "unknown fails loud");
  assertEquals(matchesFieldAnd(unknown, ["ship.address"], { allowUnknown: true }), true, "explicit opt-in");
});

// ---------------------------------------------------------------- caps ------

Deno.test("cap tags become per-tool prices", () => {
  const c = classify(
    ev({ tags: [["t", "cvm:service:restaurant"], ["cap", "tool:menu", "0", "sats"], ["cap", "tool:order", "1500", "sats"]] }),
    VOCAB,
  );
  assertEquals(c.caps, [{ tool: "menu", amount: 0, unit: "sats" }, { tool: "order", amount: 1500, unit: "sats" }], "caps");
});

Deno.test("geohash precisions are kept, deduped and sorted", () => {
  const c = classify(ev({ tags: [["g", "u33dc0"], ["g", "u33d"], ["g", "u33d"]] }), VOCAB);
  assertEquals(c.geohashes, ["u33d", "u33dc0"], "several precisions");
});

Deno.test("parseCaps ignores malformed cap tags instead of inventing a price", () => {
  assertEquals(parseCaps([["cap", "menu", "10", "sats"], ["cap", "tool:x", "abc", "sats"], ["cap", "tool:y", "5", "sats"]]),
    [{ tool: "y", amount: 5, unit: "sats" }], "only well-formed caps survive");
});

// ---------------------------------------------------------------- links -----

Deno.test("r tags become outbound links (the venue ordering deep-link)", () => {
  const c = classify(
    ev({ tags: [["t", "cvm:service:restaurant"], ["r", "https://pizzaepasta-ruedesheimerplatz.de/pizza-e-pasta/takeaway"]] }),
    VOCAB,
  );
  assertEquals(c.links, ["https://pizzaepasta-ruedesheimerplatz.de/pizza-e-pasta/takeaway"], "deep-link kept");
});

Deno.test("parseLinks drops non-http schemes and junk instead of rendering them", () => {
  assertEquals(
    parseLinks([
      ["r", "javascript:alert(1)"],
      ["r", "data:text/html,<script>1</script>"],
      ["r", "file:///etc/passwd"],
      ["r", "not a url"],
      ["r", ""],
      ["r", "http://ok.example/x"],
      ["r", "https://ok.example/y"],
      ["x", "https://ignored.example/z"],
    ]),
    ["http://ok.example/x", "https://ok.example/y"],
    "only absolute http(s) survive, deduped + sorted",
  );
});
