/**
 * Tests for collector/policy.ts — "stale disables" as a state machine.
 * Run: deno test --allow-read
 */
import {
  cacheState,
  DEFAULT_POLICY,
  humanAge,
  renderDecision,
} from "../collector/policy.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + msg);
}
function assertEquals<T>(actual: T, expected: T, msg = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`ASSERT (${msg}): got ${a}, want ${b}`);
}

const NOW = 1_800_000_000;
const P = { fresh_ttl_seconds: 900, max_age_seconds: 21600, clock_skew_seconds: 120 };

Deno.test("fresh while within the freshness ttl", () => {
  assertEquals(cacheState(NOW - 0, NOW, P).state, "fresh", "age 0");
  assertEquals(cacheState(NOW - 900, NOW, P).state, "fresh", "boundary = fresh");
});

Deno.test("stale between the ttl and the hard limit", () => {
  assertEquals(cacheState(NOW - 901, NOW, P).state, "stale", "just past ttl");
  assertEquals(cacheState(NOW - 21600, NOW, P).state, "stale", "boundary = stale");
});

Deno.test("expired past the hard limit", () => {
  assertEquals(cacheState(NOW - 21601, NOW, P).state, "expired", "just past max_age");
});

Deno.test("missing / unparseable / future-dated generated_at is invalid, not fresh", () => {
  assertEquals(cacheState(null, NOW, P).state, "invalid", "null");
  assertEquals(cacheState(undefined, NOW, P).state, "invalid", "undefined");
  assertEquals(cacheState(NaN, NOW, P).state, "invalid", "NaN");
  assertEquals(cacheState(0, NOW, P).state, "invalid", "0");
  assertEquals(cacheState(NOW + 121, NOW, P).state, "invalid", "future beyond skew");
  assertEquals(cacheState(NOW + 60, NOW, P).state, "fresh", "small skew tolerated");
});

Deno.test("decisions: stale keeps entries but kills every live claim", () => {
  const fresh = renderDecision(cacheState(NOW - 10, NOW, P));
  assertEquals(fresh.renderEntries, true, "entries rendered");
  assertEquals(fresh.disabled, false, "not disabled");
  assertEquals(fresh.live_claims, true, "may claim current");
  assertEquals(fresh.banner, null, "no banner when fresh");

  const stale = renderDecision(cacheState(NOW - 1000, NOW, P));
  assertEquals(stale.renderEntries, true, "cached snapshot still shown");
  assertEquals(stale.disabled, false, "the snapshot itself is not deleted");
  assertEquals(stale.live_claims, false, "MUST NOT claim to be live");
  assert(stale.banner !== null && stale.banner.includes("STALE"), "stale banner");
});

Deno.test("decisions: expired and invalid disable rendering entirely", () => {
  for (const v of [cacheState(NOW - 99999, NOW, P), cacheState(null, NOW, P)]) {
    const d = renderDecision(v);
    assertEquals(d.renderEntries, false, `${v.state}: nothing rendered`);
    assertEquals(d.disabled, true, `${v.state}: disabled`);
    assertEquals(d.live_claims, false, `${v.state}: no live claim`);
    assert(d.banner !== null, `${v.state}: banner explains why`);
  }
});

Deno.test("defaults are the published policy.json numbers", () => {
  assertEquals(DEFAULT_POLICY.fresh_ttl_seconds, 900, "fresh ttl");
  assertEquals(DEFAULT_POLICY.max_age_seconds, 21600, "hard limit");
});

Deno.test("humanAge is readable", () => {
  assertEquals(humanAge(45), "45s", "seconds");
  assertEquals(humanAge(600), "10m", "minutes");
  assertEquals(humanAge(3600 + 120), "1h2m", "hours");
  assertEquals(humanAge(null), "unknown", "null");
});
