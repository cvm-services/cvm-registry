/**
 * attestations.ts — venue vouches for a reviewer (kind 30317, R4a).
 *
 * THE ONE RULE THAT MATTERS: an attestation only counts when its AUTHOR is the
 * pubkey that published the announcement for that venue. Anyone can publish a
 * kind-30317 event naming any reviewer, so the signature is worthless unless it
 * comes from the venue's own identity. Attestations from any other author are
 * counted and reported as `rejected_wrong_author` — never silently dropped, and
 * never shown.
 *
 * WHAT THE BADGE MEANS, AND WHAT IT DOES NOT
 * ------------------------------------------
 * "venue-confirmed" = the venue said this. It does NOT mean the reviewer was
 * physically present, that money changed hands, or that the review is honest. A
 * venue can vouch for its own staff, or sell confirmations. The stronger claim —
 * proving membership in a "customers who visited" set without revealing which
 * member — is the LSAG ring tier (R4b) and is NOT implemented. Do not relabel
 * this badge to look like it is.
 */

import { type NostrEvent, tagValues } from "./lib.ts";

export const ATTESTATION_KIND = 30317;
export const ATTESTATION_CLASS = "cvm:attestation";
export const ATTESTATION_TYPE_VENUE_SIGNED = "cvm:attestation:venue-signed";

/** Rendered verbatim next to the badge. Keep the limit visible to the reader. */
export const VENUE_SIGNED_LIMIT =
  "the venue vouched for this reviewer; it is not proof the reviewer was present";

const HEX64 = /^[0-9a-f]{64}$/;

export interface Attestation {
  event_id: string;
  /** The signer. Only ever trusted when it equals the announcement's pubkey. */
  author_pubkey: string;
  venue_slug: string | null;
  reviewer_pubkey: string | null;
  /** The announcement this claims to be about, if the `a` tag was readable. */
  announcement_author: string | null;
  review_event_id: string | null;
  claim: string;
  created_at: number;
  warnings: string[];
}

export interface ReviewAttestation {
  status: "venue-signed";
  attestation_id: string;
  attestation_author: string;
  claim: string;
  created_at: number;
  /** The honest limit of the claim, carried with the data so the UI cannot lose it. */
  limit: string;
}

/** `d` is "<venue_slug>:<reviewer_pubkey>" — see ADR-0003. */
export function parseD(d: string): { venue_slug: string; reviewer_pubkey: string } | null {
  const i = d.lastIndexOf(":");
  if (i <= 0) return null;
  const venue_slug = d.slice(0, i);
  const reviewer_pubkey = d.slice(i + 1);
  if (!HEX64.test(reviewer_pubkey)) return null;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(venue_slug)) return null;
  return { venue_slug, reviewer_pubkey };
}

export function classifyAttestation(e: NostrEvent): Attestation | null {
  if (e.kind !== ATTESTATION_KIND) return null;
  if (!tagValues(e.tags, "t").includes(ATTESTATION_CLASS)) return null;

  const warnings: string[] = [];
  const dRaw = tagValues(e.tags, "d")[0];
  const parsed = dRaw ? parseD(dRaw) : null;
  if (dRaw === undefined) warnings.push("missing-d");
  else if (!parsed) warnings.push(`malformed-d:${dRaw}`);

  const pTag = tagValues(e.tags, "p")[0] ?? null;
  if (pTag === null) warnings.push("missing-p");
  else if (!HEX64.test(pTag)) warnings.push(`malformed-p:${pTag}`);

  // The d tag and the p tag both name the reviewer. If they disagree the event is
  // self-contradictory and we say so rather than picking a winner.
  if (parsed && pTag && parsed.reviewer_pubkey !== pTag) {
    warnings.push("d-p-mismatch");
  }

  const aRaw = tagValues(e.tags, "a")[0] ?? null;
  let announcementAuthor: string | null = null;
  if (aRaw === null) {
    warnings.push("missing-a");
  } else {
    const parts = aRaw.split(":");
    if (parts.length !== 3 || !HEX64.test(parts[1])) warnings.push(`malformed-a:${aRaw}`);
    else {
      announcementAuthor = parts[1];
      if (parsed && parts[2] !== parsed.venue_slug) warnings.push("a-d-slug-mismatch");
    }
  }

  const reviewEventId = tagValues(e.tags, "e")[0] ?? null;
  if (reviewEventId !== null && !HEX64.test(reviewEventId)) warnings.push("malformed-e");

  return {
    event_id: e.id,
    author_pubkey: e.pubkey,
    venue_slug: parsed?.venue_slug ?? null,
    reviewer_pubkey: parsed?.reviewer_pubkey ?? pTag,
    announcement_author: announcementAuthor,
    review_event_id: reviewEventId,
    claim: typeof e.content === "string" ? e.content.trim() : "",
    created_at: e.created_at,
    warnings,
  };
}

/** Latest attestation wins per (venue, reviewer); ties broken by larger event id. */
export function indexAttestations(list: Attestation[]): Map<string, Attestation> {
  const out = new Map<string, Attestation>();
  for (const a of list) {
    if (!a.venue_slug || !a.reviewer_pubkey) continue;
    if (a.warnings.includes("d-p-mismatch")) continue;
    const key = `${a.venue_slug}:${a.reviewer_pubkey}`;
    const prev = out.get(key);
    if (
      !prev ||
      a.created_at > prev.created_at ||
      (a.created_at === prev.created_at && a.event_id > prev.event_id)
    ) {
      out.set(key, a);
    }
  }
  return out;
}

export interface ApplyResult<T> {
  reviews: T[];
  confirmed: number;
  rejected_wrong_author: number;
  rejected_unknown_venue: number;
  /** Attestation ids that were refused and why — for the count in the catalogue. */
  rejected: Array<{ attestation_id: string; reason: string }>;
}

/**
 * Attach a "venue-signed" confirmation to reviews the venue actually vouched for.
 *
 * Three conditions must all hold, and each failure is counted separately:
 *   1. the attestation's author is the pubkey of the venue's own announcement —
 *      resolved through the REVIEW'S OWN binding (`provider_pubkey`), which the
 *      review carries from its `a` coordinate. A slug→provider map is NOT good
 *      enough: two providers can publish the same `d` slug, and through a slug
 *      map provider B's vouch would badge provider A's venue while A's own vouch
 *      was refused. `entryKeys` only answers "does this venue identity exist in
 *      the catalogue at all";
 *   2. the venue slug matches the entry the review is attached to;
 *   3. the reviewer pubkey matches the review's author.
 *
 * ORDER IS NOT TOUCHED, exactly as with zaps: a confirmed review is not promoted.
 */
export function applyAttestations<
  T extends { pubkey: string; venue_slug: string | null; provider_pubkey: string },
>(
  reviews: T[],
  entryKeys: Set<string>,
  index: Map<string, Attestation>,
): ApplyResult<T & { attestation: ReviewAttestation | null }> {
  const rejected: Array<{ attestation_id: string; reason: string }> = [];
  let confirmed = 0;
  let rejectedAuthor = 0;
  let rejectedVenue = 0;

  const out = reviews.map((r) => {
    if (!r.venue_slug) return { ...r, attestation: null };
    const att = index.get(`${r.venue_slug}:${r.pubkey}`);
    if (!att) return { ...r, attestation: null };

    // `${provider_pubkey}:${d}` — the same identity attachReviews binds on.
    if (!r.provider_pubkey || !entryKeys.has(`${r.provider_pubkey}:${r.venue_slug}`)) {
      rejectedVenue++;
      rejected.push({ attestation_id: att.event_id, reason: "unknown-venue" });
      return { ...r, attestation: null };
    }
    if (att.author_pubkey !== r.provider_pubkey) {
      rejectedAuthor++;
      rejected.push({ attestation_id: att.event_id, reason: "author-is-not-the-venue" });
      return { ...r, attestation: null };
    }

    confirmed++;
    const attestation: ReviewAttestation = {
      status: "venue-signed",
      attestation_id: att.event_id,
      attestation_author: att.author_pubkey,
      claim: att.claim,
      created_at: att.created_at,
      limit: VENUE_SIGNED_LIMIT,
    };
    return { ...r, attestation };
  });

  return {
    reviews: out,
    confirmed,
    rejected_wrong_author: rejectedAuthor,
    rejected_unknown_venue: rejectedVenue,
    rejected,
  };
}
