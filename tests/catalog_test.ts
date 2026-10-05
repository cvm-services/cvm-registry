/**
 * Integration test over the fixture capture — the demo catalog built from real
 * relay events, plus the render oracle's decisions at four cache ages.
 *
 * Run: deno test --allow-read
 */
import { cacheState, renderDecision } from "../collector/policy.ts";
import type { Classified } from "../collector/lib.ts";

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

Deno.test("the demo catalog is stable: re-running the replay yields the same bytes", async () => {
  // generated_at is pinned with --now, so the whole file must be reproducible
  const first = Deno.readTextFileSync("fixtures/demo-catalog.json");
  const rerun = await new Deno.Command(Deno.execPath(), {
    args: [
      "run", "--allow-read", "--allow-write", "collector/collect.ts",
      "--input", "fixtures/real-events.ndjson",
      "--allowlist", "fixtures/curators.demo.json",
      "--out", "/tmp/cvm-demo-catalog-rerun.json",
      "--now", String(NOW),
    ],
    stdout: "null", stderr: "null",
  }).output();
  assertEquals(rerun.code, 0, "collector exit code");
  const second = Deno.readTextFileSync("/tmp/cvm-demo-catalog-rerun.json");
  assertEquals(second === first, true, "idempotent output");
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
