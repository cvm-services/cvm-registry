/**
 * Tests for review ingest (R2, kind 30316).
 *
 * The load-bearing ones: the rating must be read from a SINGLE-LETTER tag when
 * one is present (a multi-letter-only rating is flagged, because relays do not
 * index it and a filtering client never saw it), and `(pubkey, d)` — not
 * `(pubkey)` — must be the dedupe identity, or one author's second venue would
 * erase their first.
 */

import {
  attachReviews,
  classifyReview,
  dedupeReviews,
  isReview,
  parseAnnouncementCoordinate,
  parseRating,
  REVIEW_KIND,
} from "../collector/reviews.ts";
import { groupServices } from "../collector/lib.ts";
import type { Classified } from "../collector/lib.ts";

const PROVIDER = "ae317038b9c8c2fb681b163e9903d179785292b95d964dcb89bd053ba83e84bd";
const REVIEWER = "4e5970390303ed7c17be1d5f2656b6a7edf8ca9c2e97796bed97956ba578a50d";
const REVIEWER_B = "87c3a21fd09fe893a22f10b404d4953ce95d1c9e2fded64c37d3acaab65b82d9";

function ev(over: Record<string, unknown> = {}) {
  return {
    id: "95ffbfe506e79bacbef91a295b540f449b1cdfddd428380bbfbf901cd2dc848a",
    kind: REVIEW_KIND,
    pubkey: REVIEWER,
    created_at: 1791223666,
    content: "Best Kase in Kreuzberg.",
    sig: "0".repeat(128),
    tags: [
      ["d", "doppelt-kaese-berlin"],
      ["a", `11317:${PROVIDER}:doppelt-kaese-berlin`],
      ["p", PROVIDER],
      ["r", "https://www.doppelt-kaese-berlin.de/speisekarte/doppeltkase"],
      ["t", "cvm:review"],
      ["t", "cvm:rating:4"],
      ["L", "cvm.rating"],
      ["l", "4", "cvm.rating"],
      ["rating", "4", "5"],
      ["g", "u336x0"],
    ],
    ...over,
  };
}

function eq(a: unknown, b: unknown, what: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
  }
}
function ok(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}

Deno.test("reviews: a well-formed review is parsed and bound to its service", () => {
  const r = classifyReview(ev())!;
  ok(r, "classify returned null");
  eq(r.rating, 4, "rating");
  eq(r.rating_source, "t", "rating source must be the single-letter #t");
  eq(r.venue_slug, "doppelt-kaese-berlin", "slug");
  eq(r.provider_pubkey, PROVIDER, "provider");
  eq(r.venue_url, "https://www.doppelt-kaese-berlin.de/speisekarte/doppeltkase", "url");
  eq(r.geohashes, ["u336x0"], "geohashes");
  eq(r.warnings, [], "a clean review must carry no warnings");
  ok(r.npub.startsWith("npub1"), "npub encoding");
});

Deno.test("reviews: non-reviews are not classified as reviews", () => {
  eq(classifyReview(ev({ kind: 11317 })), null, "announcement kind");
  eq(classifyReview(ev({ tags: [["d", "x"]] })), null, "missing cvm:review class tag");
  eq(isReview(ev()), true, "isReview on the real thing");
  eq(isReview(ev({ kind: 11317 })), false, "isReview on an announcement");
});

Deno.test("reviews: rating comes from #t, and a payload-only rating is flagged", () => {
  // #t wins even when the payload disagrees.
  const mixed = ev({
    tags: [
      ["d", "x"],
      ["a", `11317:${PROVIDER}:x`],
      ["t", "cvm:review"],
      ["t", "cvm:rating:2"],
      ["rating", "5", "5"],
    ],
  });
  const r1 = classifyReview(mixed)!;
  eq(r1.rating, 2, "the single-letter tag is authoritative");
  eq(r1.rating_source, "t", "source");

  // Only the multi-letter tag carries it: usable, but explicitly flagged.
  const payloadOnly = ev({
    tags: [["d", "x"], ["a", `11317:${PROVIDER}:x`], ["t", "cvm:review"], ["rating", "3", "5"]],
  });
  const r2 = classifyReview(payloadOnly)!;
  eq(r2.rating, 3, "payload fallback still yields a rating");
  eq(r2.rating_source, "payload", "source is the payload");
  ok(
    r2.warnings.some((w) => w.startsWith("rating-not-filterable")),
    `payload-only rating must be flagged, got ${JSON.stringify(r2.warnings)}`,
  );

  // NIP-32 label form.
  const labelOnly = ev({
    tags: [["d", "x"], ["a", `11317:${PROVIDER}:x`], ["t", "cvm:review"], ["L", "cvm.rating"], ["l", "1", "cvm.rating"]],
  });
  const r3 = classifyReview(labelOnly)!;
  eq(r3.rating, 1, "label rating");
  eq(r3.rating_source, "l", "label source");
});

Deno.test("reviews: out-of-range or non-integer ratings are refused, not clamped", () => {
  const hi = ev({ tags: [["d", "x"], ["a", `11317:${PROVIDER}:x`], ["t", "cvm:review"], ["t", "cvm:rating:7"]] });
  const r = classifyReview(hi)!;
  eq(r.rating, null, "7 must not become a rating");
  ok(r.warnings.includes("rating-out-of-range:t:7"), `flag expected, got ${JSON.stringify(r.warnings)}`);

  const words = parseRating({ tags: [["t", "cvm:rating:great"]], kind: 30316, pubkey: REVIEWER, id: "a", created_at: 1, content: "", sig: "0".repeat(128) });
  eq(words.rating, null, "words are not a rating");
  eq(words.source, "none", "source");

  const missing = classifyReview(ev({ tags: [["d", "x"], ["a", `11317:${PROVIDER}:x`], ["t", "cvm:review"]] }))!;
  eq(missing.rating, null, "no rating at all");
  ok(missing.warnings.includes("no-rating"), "must flag the missing rating");
});

Deno.test("reviews: a missing or malformed 'a' binding is reported, never silent", () => {
  const noA = classifyReview(ev({ tags: [["d", "doppelt-kaese-berlin"], ["p", PROVIDER], ["t", "cvm:review"], ["t", "cvm:rating:4"]] }))!;
  ok(noA.warnings.includes("missing-or-malformed-a-coordinate"), `got ${JSON.stringify(noA.warnings)}`);
  eq(noA.venue_slug, "doppelt-kaese-berlin", "falls back to d");
  eq(noA.provider_pubkey, PROVIDER, "falls back to p");

  const badA = ev({ tags: [["d", "x"], ["a", "not-a-coordinate"], ["t", "cvm:review"], ["t", "cvm:rating:4"]] });
  eq(parseAnnouncementCoordinate(badA), null, "malformed coordinate");

  const disagree = classifyReview(ev({
    tags: [
      ["d", "somewhere-else"],
      ["a", `11317:${PROVIDER}:doppelt-kaese-berlin`],
      ["t", "cvm:review"],
      ["t", "cvm:rating:4"],
    ],
  }))!;
  ok(disagree.warnings.includes("d-disagrees-with-a-coordinate"), `got ${JSON.stringify(disagree.warnings)}`);
  eq(disagree.venue_slug, "doppelt-kaese-berlin", "the a-coordinate wins");
});

Deno.test("reviews: (pubkey, d) is the identity — one author, two venues, no collapse", () => {
  const a = classifyReview(ev({ created_at: 100 }))!;
  const aEdit = classifyReview(ev({ created_at: 200, id: "f".repeat(64) }))!;
  const aOtherVenue = classifyReview(ev({
    created_at: 150,
    id: "a".repeat(64),
    tags: [["d", "pizza-e-pasta-ruedesheimerplatz"], ["a", `11317:${PROVIDER}:pizza-e-pasta-ruedesheimerplatz`], ["t", "cvm:review"], ["t", "cvm:rating:3"]],
  }))!;

  const kept = dedupeReviews([a, aEdit, aOtherVenue]);
  eq(kept.length, 2, "the edit collapses, the other venue survives");
  const doppelt = kept.find((r) => r.venue_slug === "doppelt-kaese-berlin")!;
  eq(doppelt.created_at, 200, "the newest revision of the same coordinate wins");
  ok(kept.some((r) => r.venue_slug === "pizza-e-pasta-ruedesheimerplatz"), "second venue must survive");
});

Deno.test("reviews: same created_at is broken deterministically by event id", () => {
  const one = classifyReview(ev({ created_at: 500, id: "1".repeat(64) }))!;
  const two = classifyReview(ev({ created_at: 500, id: "2".repeat(64) }))!;
  eq(dedupeReviews([one, two])[0].event_id, "2".repeat(64), "larger id wins");
  eq(dedupeReviews([two, one])[0].event_id, "2".repeat(64), "order-independent");
});

Deno.test("reviews: binding attaches to the right entry and orphanes the rest", () => {
  const entries = [
    { pubkey: PROVIDER, d: "doppelt-kaese-berlin", npub: "npub1x" },
    { pubkey: "b".repeat(64), d: "pizza-e-pasta-ruedesheimerplatz", npub: "npub1y" },
  ];
  const mine = classifyReview(ev({ created_at: 10 }))!;
  const foreign = classifyReview(ev({
    created_at: 20, id: "c".repeat(64),
    tags: [["d", "unannounced-place"], ["a", `11317:${PROVIDER}:unannounced-place`], ["t", "cvm:review"], ["t", "cvm:rating:5"]],
  }))!;

  const res = attachReviews(entries, [mine, foreign]);
  eq(res.attached, 1, "one review lands");
  eq(res.orphaned.length, 1, "the review of an unannounced venue is reported, not hidden");
  eq(res.orphaned[0].venue_slug, "unannounced-place", "orphan identity");
  eq((res.entries[0] as { reviews: unknown[] }).reviews.length, 1, "attached to the right entry");
  eq((res.entries[1] as { reviews: unknown[] }).reviews.length, 0, "the other entry gets none");
});

Deno.test("reviews: attached reviews are newest-first", () => {
  const old = classifyReview(ev({ created_at: 100, id: "1".repeat(64) }))!;
  const recent = classifyReview(ev({ created_at: 300, id: "3".repeat(64), pubkey: REVIEWER_B }))!;
  const res = attachReviews([{ pubkey: PROVIDER, d: "doppelt-kaese-berlin" }], [old, recent]);
  const list = (res.entries[0] as { reviews: Array<{ created_at: number }> }).reviews;
  eq(list.map((r) => r.created_at), [300, 100], "newest first");
});

/** A minimal Classified facet; only the fields groupServices actually reads. */
function facet(
  kind: number,
  id: string,
  reviews: Array<{ event_id: string; created_at: number }> = [
    { event_id: "c".repeat(64), created_at: 7 },
  ],
) {
  return {
    pubkey: PROVIDER,
    npub: "npub1x",
    d: "doppelt-kaese-berlin",
    kind,
    event_id: id,
    created_at: 7,
    classes: ["restaurant"],
    caps: [],
    links: [],
    geohashes: [],
    name: null,
    about: null,
    website: null,
    tier: { declared: [], recomputed: null, mismatch: false },
    requirements: {
      required: [],
      optional: [],
      unknown: [],
      none_sentinel: false,
      unclassified: true,
    },
    declared: { fulfilment: null, menu: null, settlement: null },
    meatspace: false,
    reviews,
  };
}

Deno.test("reviews: survive service grouping — the page renders services, not entries", () => {
  // (R2 x R6) attachReviews binds by `pubkey:d` and puts the list on EVERY
  // facet of that service. groupServices then REBUILDS the object field by
  // field, so a list it does not copy is invisible on the page while the unit
  // tests above stay green: green suite, "Reviews (0)" in the UI.
  const services = groupServices([
    facet(11316, "a".repeat(64)),
    facet(11317, "b".repeat(64)),
  ] as unknown as Classified[]);
  eq(services.length, 1, "the two facets collapse into one service");
  const got = (services[0] as unknown as { reviews?: Array<{ event_id: string }> }).reviews ?? [];
  eq(got.length, 1, "the service must carry the reviews the card renders");
  eq(got[0].event_id, "c".repeat(64), "and it must be the right review");

  const bare = groupServices([
    facet(11316, "d".repeat(64), []),
  ] as unknown as Classified[]);
  const none = (bare[0] as unknown as { reviews?: unknown[] }).reviews ?? [];
  eq(none.length, 0, "a service with no reviews must not invent any");
});
