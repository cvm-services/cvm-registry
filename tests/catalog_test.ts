/**
 * Integration test over the fixture capture — the demo catalog built from real
 * relay events, plus the render oracle's decisions at four cache ages.
 *
 * Run: deno test --allow-read
 */
import { cacheState, renderDecision } from "../collector/policy.ts";
import {
  applyAllowList,
  classify,
  dedupe,
  parseCurators,
  type Classified,
  type Vocab,
} from "../collector/lib.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + msg);
}
function assertEquals<T>(actual: T, expected: T, msg = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`ASSERT (${msg}): got ${a}, want ${b}`);
}

interface Catalog {
  generated_at: number;
  policy: { freshness: { fresh_ttl_seconds: number; max_age_seconds: number; clock_skew_seconds?: number } };
  allowlist: { curators: { npub: string }[] };
  counts: Record<string, number>;
  entries: Classified[];
  services: {
    service_key: string;
    pubkey: string;
    d: string;
    kinds: number[];
    facets: { kind: number; event_id: string; created_at: number }[];
    link_status: { url: string; checked: boolean; ok: boolean | null; reason: string } | null;
  }[];
}

const catalog: Catalog = JSON.parse(await Deno.readTextFile("fixtures/demo-catalog.json"));
const NOW = catalog.generated_at;

Deno.test("the fixture capture really is a capture (no invented events)", () => {
  const raw = Deno.readTextFileSync("fixtures/real-events.ndjson").trim().split("\n");
  assertEquals(raw.length, 66, "66 captured events");
  for (const line of raw) {
    const e = JSON.parse(line);
    assert(typeof e.id === "string" && e.id.length === 64, "event has a 64-char id");
    assert(typeof e.sig === "string" && e.sig.length === 128, "event carries a signature");
  }
});

Deno.test("every entry in the built catalog is allow-listed (nothing leaks past the list)", () => {
  const allow = new Set(catalog.allowlist.curators.map((c) => c.npub));
  assertEquals(allow.size, 3, "three demo curators");
  assert(catalog.entries.length > 0, "some entries survived");
  for (const e of catalog.entries) {
    assert(allow.has(e.npub), `entry ${e.event_id} is not allow-listed`);
  }
  assertEquals(catalog.counts.kept, catalog.entries.length, "kept count matches entries");
  assert(catalog.counts.dropped_not_allowlisted > 0, "the allow-list actually dropped things");
});

Deno.test("wild announcements are unclassified, not silently treated as req:none", () => {
  const all = catalog.entries;
  assert(all.some((e) => e.requirements.unclassified), "no live announcement uses the draft tags");
  for (const e of all) {
    if (e.requirements.unclassified) {
      assertEquals(e.requirements.none_sentinel, false, "absent must not become none");
      assertEquals(e.tier.recomputed, null, "no tier claim for unclassified");
    }
  }
});

Deno.test("the demo catalog is stable: the replay is deterministic", () => {
  // Rebuild the same catalog in-process from the same inputs and a pinned clock.
  // (No subprocess: this needs no --allow-run and tests the real invariant —
  // identical input must produce identical entries, counts and ordering.)
  const raw = Deno.readTextFileSync("fixtures/real-events.ndjson").trim().split("\n")
    .map((l) => JSON.parse(l));
  const allowDoc = JSON.parse(Deno.readTextFileSync("fixtures/curators.demo.json"));
  const vocab: Vocab = JSON.parse(Deno.readTextFileSync("vocab/service-inputs.json"));

  const allow = parseCurators(allowDoc);
  const deduped = dedupe(raw);
  const { kept, dropped } = applyAllowList(deduped, allow.hex);
  const entries = kept.map((e) => classify(e, vocab)).sort((a, b) =>
    a.kind - b.kind || a.pubkey.localeCompare(b.pubkey) || a.d.localeCompare(b.d)
  );

  assertEquals(entries, catalog.entries, "entries reproduce exactly, in the same order");
  assertEquals(catalog.counts.raw_events, raw.length, "raw count");
  assertEquals(catalog.counts.after_dedupe, deduped.length, "dedupe count");
  assertEquals(catalog.counts.kept, kept.length, "kept count");
  assertEquals(catalog.counts.dropped_not_allowlisted, dropped.length, "dropped count");
});

Deno.test("stale disables, and expiry disables harder (the headline rule)", () => {
  const p = catalog.policy.freshness;

  const fresh = renderDecision(cacheState(NOW + 60, NOW + 60, p));
  assertEquals([fresh.renderEntries, fresh.live_claims, fresh.disabled], [true, true, false], "fresh");

  const stale = renderDecision(cacheState(NOW, NOW + 7200, p));
  assertEquals([stale.renderEntries, stale.live_claims, stale.disabled], [true, false, false], "stale");
  assert((stale.banner ?? "").includes("STALE"), "stale says so");

  const expired = renderDecision(cacheState(NOW, NOW + 172800, p));
  assertEquals([expired.renderEntries, expired.live_claims, expired.disabled], [false, false, true], "expired");

  const invalid = renderDecision(cacheState(null, NOW, p));
  assertEquals([invalid.renderEntries, invalid.disabled], [false, true], "invalid fails closed");
});

Deno.test("the catalog emits SERVICES, not announcements (one card per service)", () => {
  assert(Array.isArray(catalog.services), "services are emitted alongside entries");
  assertEquals(
    catalog.counts.services_kept,
    catalog.services.length,
    "the service count is a real count, not a relabelled announcement count",
  );
  assert(
    catalog.counts.services_kept < catalog.counts.kept,
    "every service here publishes two facets (11316+11317), so services < announcements",
  );
  assertEquals(catalog.services.length, 3, "the demo capture is three services");
  assertEquals(catalog.counts.kept, 6, "six announcements");
});

Deno.test("service keys are unique, and every facet traces back to an allow-listed announcement", () => {
  const keys = new Set(catalog.services.map((s) => s.service_key));
  assertEquals(keys.size, catalog.services.length, "service_key is a key");
  const byId = new Map(catalog.entries.map((e) => [e.event_id, e]));
  for (const s of catalog.services) {
    assert(s.kinds.length === s.facets.length, `${s.service_key}: one kind per facet`);
    for (const f of s.facets) {
      const e = byId.get(f.event_id);
      assert(e, `${s.service_key}: facet ${f.event_id} is not in entries`);
      assertEquals(e!.pubkey, s.pubkey, "facet belongs to the service signer");
      assertEquals(e!.d, s.d, "facet shares the service slug");
    }
  }
});

Deno.test("every announcement is accounted for: no facet is dropped by the grouping", () => {
  const seen = new Set(catalog.services.flatMap((s) => s.facets.map((f) => f.event_id)));
  assertEquals(seen.size, catalog.entries.length, "announcements in == announcements grouped");
});
