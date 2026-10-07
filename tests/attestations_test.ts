/**
 * Tests for venue attestations in the collector (R4a, kind 30317).
 *
 * THE TEST THAT MATTERS is "a third party cannot vouch for a venue": anyone can
 * publish a kind-30317 event naming any reviewer, so if the author check were
 * missing, the badge would be decorative. A forged attestation must produce NO
 * badge and must be counted as rejected, not quietly ignored.
 */

import {
  applyAttestations,
  ATTESTATION_KIND,
  classifyAttestation,
  indexAttestations,
  parseD,
  VENUE_SIGNED_LIMIT,
} from "../collector/attestations.ts";

const VENUE = "ae317038b9c8c2fb681b163e9903d179785292b95d964dcb89bd053ba83e84bd";
// A valid-hex pubkey that belongs to nobody. Must never be a real key: an
// earlier revision of this file copied a private key here straight out of a
// leaked dry-run artifact, and it had to be purged from history. Use filler.
const IMPOSTOR = "c".repeat(64);
const REVIEWER = "4e5970390303ed7c17be1d5f2656b6a7edf8ca9c2e97796bed97956ba578a50d";
const OTHER_REVIEWER = "87c3a21fd09fe893a22f10b404d4953ce95d1c9e2fded64c37d3acaab65b82d9";

function att(over: Record<string, unknown> = {}) {
  return {
    id: "a".repeat(64),
    kind: ATTESTATION_KIND,
    pubkey: VENUE,
    created_at: 1791227500,
    content: "This reviewer placed an order at this venue.",
    sig: "0".repeat(128),
    tags: [
      ["d", `doppelt-kaese-berlin:${REVIEWER}`],
      ["a", `11317:${VENUE}:doppelt-kaese-berlin`],
      ["p", REVIEWER],
      ["t", "cvm:attestation"],
      ["t", "cvm:attestation:venue-signed"],
    ],
    ...over,
  };
}

function eq(a: unknown, b: unknown, what: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
  }
}
function ok(c: unknown, what: string) {
  if (!c) throw new Error(what);
}

Deno.test("attestations: a well-formed attestation is parsed", () => {
  const a = classifyAttestation(att())!;
  ok(a, "not classified");
  eq(a.author_pubkey, VENUE, "author");
  eq(a.venue_slug, "doppelt-kaese-berlin", "slug");
  eq(a.reviewer_pubkey, REVIEWER, "reviewer");
  eq(a.announcement_author, VENUE, "announcement author from the a tag");
  eq(a.warnings, [], "clean attestation has no warnings");
});

Deno.test("attestations: only attestations are attestations", () => {
  eq(classifyAttestation(att({ kind: 1 })), null, "wrong kind");
  eq(classifyAttestation(att({ tags: [["d", "x:y"], ["t", "something-else"]] })), null,
    "missing the cvm:attestation class tag");
});

Deno.test("attestations: parseD must be strict", () => {
  eq(parseD(`doppelt-kaese-berlin:${REVIEWER}`), { venue_slug: "doppelt-kaese-berlin", reviewer_pubkey: REVIEWER }, "valid");
  eq(parseD("no-colon"), null, "no separator");
  eq(parseD("slug:nothex"), null, "reviewer not hex");
  eq(parseD("Bad Slug:" + REVIEWER), null, "slug not a kebab slug");
});

Deno.test("attestations: self-contradictory events are flagged, not resolved", () => {
  const a = classifyAttestation(att({ tags: [["d", `doppelt-kaese-berlin:${REVIEWER}`], ["p", OTHER_REVIEWER], ["t", "cvm:attestation"]] }))!;
  ok(a.warnings.includes("d-p-mismatch"), `expected d-p-mismatch, got ${JSON.stringify(a.warnings)}`);
  eq(indexAttestations([a]).size, 0, "a contradictory attestation is not indexed");
});

Deno.test("attestations: malformed pieces are reported", () => {
  const a = classifyAttestation(att({ tags: [["t", "cvm:attestation"]] }))!;
  ok(a.warnings.includes("missing-d"), "missing d");
  ok(a.warnings.includes("missing-p"), "missing p");
  ok(a.warnings.includes("missing-a"), "missing a");
});

Deno.test("attestations: latest wins per (venue, reviewer), ties by larger id", () => {
  const older = classifyAttestation(att({ id: "1".repeat(64), created_at: 100 }))!;
  const newer = classifyAttestation(att({ id: "2".repeat(64), created_at: 200 }))!;
  eq(indexAttestations([older, newer]).get(`doppelt-kaese-berlin:${REVIEWER}`)!.event_id, "2".repeat(64), "newest");

  const tieA = classifyAttestation(att({ id: "3".repeat(64), created_at: 300 }))!;
  const tieB = classifyAttestation(att({ id: "9".repeat(64), created_at: 300 }))!;
  eq(indexAttestations([tieA, tieB]).get(`doppelt-kaese-berlin:${REVIEWER}`)!.event_id, "9".repeat(64), "larger id wins");
});

Deno.test("attestations: A THIRD PARTY CANNOT VOUCH FOR A VENUE", () => {
  const forged = classifyAttestation(att({ pubkey: IMPOSTOR }))!;
  const index = indexAttestations([forged]);
  const reviews = [{ pubkey: REVIEWER, venue_slug: "doppelt-kaese-berlin", provider_pubkey: VENUE }];
  const entryKeys = new Set([`${VENUE}:doppelt-kaese-berlin`]);

  const res = applyAttestations(reviews, entryKeys, index);
  eq(res.reviews[0].attestation, null, "a forged attestation must produce NO badge");
  eq(res.confirmed, 0, "nothing confirmed");
  eq(res.rejected_wrong_author, 1, "and it is counted, not ignored");
  eq(res.rejected[0].reason, "author-is-not-the-venue", "reason");
});

Deno.test("attestations: the venue's own vouch confirms exactly one review", () => {
  const genuine = classifyAttestation(att())!;
  const otherProvider = "2a9d186d80c5d174970d5fd3d99fca268d1b75ff76d09b4707d65656c50c6891";
  const index = indexAttestations([genuine]);
  const reviews = [
    { pubkey: REVIEWER, venue_slug: "doppelt-kaese-berlin", provider_pubkey: VENUE },
    { pubkey: OTHER_REVIEWER, venue_slug: "doppelt-kaese-berlin", provider_pubkey: VENUE }, // not vouched for
    { pubkey: REVIEWER, venue_slug: "pizza-e-pasta-ruedesheimerplatz", provider_pubkey: otherProvider }, // different venue
  ];
  const entryKeys = new Set([
    `${VENUE}:doppelt-kaese-berlin`,
    `${otherProvider}:pizza-e-pasta-ruedesheimerplatz`,
  ]);

  const res = applyAttestations(reviews, entryKeys, index);
  ok(res.reviews[0].attestation, "the vouched review is badged");
  eq(res.reviews[0].attestation!.status, "venue-signed", "status");
  eq(res.reviews[0].attestation!.attestation_id, genuine.event_id, "which attestation");
  eq(res.reviews[0].attestation!.limit, VENUE_SIGNED_LIMIT, "the limit travels with the data");
  eq(res.reviews[1].attestation, null, "an unvouched reviewer is not badged");
  eq(res.reviews[2].attestation, null, "a vouch is venue-specific");
  eq(res.confirmed, 1, "exactly one");
});

Deno.test("attestations: two providers sharing a slug cannot badge each other", () => {
  // The old slug->provider map held ONE provider per slug, so with two providers
  // publishing the same `d` one of the two vouches was resolved against the wrong
  // venue: B's vouch badged A's venue while A's own vouch was refused. The
  // identity now comes from the review's own `provider_pubkey` binding.
  const otherProvider = "2a9d186d80c5d174970d5fd3d99fca268d1b75ff76d09b4707d65656c50c6891";
  const SHARED = "shared-slug";
  const vouchFromA = classifyAttestation(att({
    tags: [
      ["d", `${SHARED}:${REVIEWER}`],
      ["a", `11317:${VENUE}:${SHARED}`],
      ["p", REVIEWER],
      ["t", "cvm:attestation"],
    ],
  }))!;
  const index = indexAttestations([vouchFromA]);
  const entryKeys = new Set([`${VENUE}:${SHARED}`, `${otherProvider}:${SHARED}`]);

  // B's review of B's own venue, which happens to use the same slug.
  const resB = applyAttestations(
    [{ pubkey: REVIEWER, venue_slug: SHARED, provider_pubkey: otherProvider }],
    entryKeys,
    index,
  );
  eq(resB.reviews[0].attestation, null, "A's vouch must NOT badge B's venue");
  eq(resB.confirmed, 0, "nothing confirmed for B");
  eq(resB.rejected_wrong_author, 1, "counted as wrong author");

  // …and A's own review of that slug is still honoured.
  const resA = applyAttestations(
    [{ pubkey: REVIEWER, venue_slug: SHARED, provider_pubkey: VENUE }],
    entryKeys,
    index,
  );
  ok(resA.reviews[0].attestation, "A's own vouch is honoured");
  eq(resA.confirmed, 1, "confirmed for A");
});

Deno.test("attestations: an unknown venue cannot be badged", () => {
  const genuine = classifyAttestation(att())!;
  const res = applyAttestations(
    [{ pubkey: REVIEWER, venue_slug: "doppelt-kaese-berlin", provider_pubkey: VENUE }],
    new Set(),
    indexAttestations([genuine]),
  );
  eq(res.reviews[0].attestation, null, "no catalogue entry => no badge");
  eq(res.rejected_unknown_venue, 1, "counted");
});

Deno.test("attestations: attaching does not reorder reviews", () => {
  const genuine = classifyAttestation(att())!;
  const reviews = [
    { pubkey: OTHER_REVIEWER, venue_slug: "doppelt-kaese-berlin", provider_pubkey: VENUE, created_at: 900 },
    { pubkey: REVIEWER, venue_slug: "doppelt-kaese-berlin", provider_pubkey: VENUE, created_at: 100 },
  ];
  const before = reviews.map((r) => r.created_at);
  const res = applyAttestations(
    reviews,
    new Set([`${VENUE}:doppelt-kaese-berlin`]),
    indexAttestations([genuine]),
  );
  eq(res.reviews.map((r) => r.created_at), before, "order untouched by a confirmation");
  ok(res.reviews[1].attestation, "the older, vouched review stays last and is still badged");
});
