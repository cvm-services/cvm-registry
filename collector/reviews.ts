/**
 * reviews.ts — ingest for review events (kind 30316).
 *
 * Kept out of lib.ts on purpose: lib.ts is the service-announcement catalogue
 * (CEP-6 kinds 11316–11320), and a review is a different animal that merely
 * points at one. See docs/adr/0002 in contextvm-services for why reviews are
 * addressable and why the rating must be reachable through a single-letter tag.
 *
 * Two rules from the spec are enforced here rather than trusted:
 *   - the rating is read from `#t` / `l` first, and the human `rating` tag is
 *     only a last-resort fallback, flagged as such when used;
 *   - a review is bound to a service through its `a` coordinate. A review that
 *     cannot be bound to a known entry is not dropped silently — it is reported
 *     as orphaned so the count is visible.
 */

import { type NostrEvent, hexToNpub, tagValues } from "./lib.ts";

export const REVIEW_KIND = 30316;
export const REVIEW_CLASS = "cvm:review";
export const RATING_PREFIX = "cvm:rating:";
export const RATING_NS = "cvm.rating";
export const RATING_MIN = 1;
export const RATING_MAX = 5;

/** Where the rating was read from. `payload` means only the multi-letter tag
 *  carried it — filterable clients will not have seen this. */
export type RatingSource = "t" | "l" | "payload" | "none";

export interface Review {
  event_id: string;
  pubkey: string;
  npub: string;
  created_at: number;
  content: string;
  venue_slug: string;
  provider_pubkey: string;
  venue_url: string | null;
  rating: number | null;
  rating_source: RatingSource;
  geohashes: string[];
  announcement_event_id: string | null;
  warnings: string[];
}

function intOrNull(raw: string | undefined): number | null {
  if (raw === undefined || !/^-?\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/** Precedence: #t (filterable) → NIP-32 label → multi-letter payload → none. */
export function parseRating(
  e: NostrEvent,
): { rating: number | null; source: RatingSource; warnings: string[] } {
  const warnings: string[] = [];
  const candidates: Array<[RatingSource, string | undefined]> = [
    ["t", tagValues(e.tags, "t").find((v) => v.startsWith(RATING_PREFIX))?.slice(RATING_PREFIX.length)],
    ["l", (() => {
      const namespaced = tagValues(e.tags, "L").includes(RATING_NS);
      return namespaced ? tagValues(e.tags, "l")[0] : undefined;
    })()],
    ["payload", tagValues(e.tags, "rating")[0]],
  ];

  for (const [source, raw] of candidates) {
    if (raw === undefined) continue;
    const n = intOrNull(raw);
    if (n === null) {
      warnings.push(`rating-not-an-integer:${source}:${raw}`);
      continue;
    }
    if (n < RATING_MIN || n > RATING_MAX) {
      warnings.push(`rating-out-of-range:${source}:${n}`);
      continue;
    }
    if (source === "payload") {
      warnings.push("rating-not-filterable:only-the-multi-letter-tag-carried-it");
    }
    return { rating: n, source, warnings };
  }
  warnings.push("no-rating");
  return { rating: null, source: "none", warnings };
}

/** `a` coordinate → {provider_pubkey, venue_slug}; null when absent/malformed. */
export function parseAnnouncementCoordinate(
  e: NostrEvent,
): { provider_pubkey: string; venue_slug: string } | null {
  const a = tagValues(e.tags, "a")[0];
  if (!a) return null;
  const parts = a.split(":");
  if (parts.length !== 3) return null;
  const [kind, pubkey, slug] = parts;
  if (!/^\d+$/.test(kind) || !/^[0-9a-f]{64}$/.test(pubkey) || !slug) return null;
  return { provider_pubkey: pubkey, venue_slug: slug };
}

export function isReview(e: NostrEvent): boolean {
  if (e.kind !== REVIEW_KIND) return false;
  return tagValues(e.tags, "t").includes(REVIEW_CLASS);
}

/**
 * Parse one event into a Review, or null when it is not a review at all.
 * A review missing its `a` binding is still returned (with a warning) so the
 * caller can count and report it instead of losing it.
 */
export function classifyReview(e: NostrEvent): Review | null {
  if (!isReview(e)) return null;
  const warnings: string[] = [];
  const { rating, source, warnings: rw } = parseRating(e);
  warnings.push(...rw);

  const coord = parseAnnouncementCoordinate(e);
  if (!coord) warnings.push("missing-or-malformed-a-coordinate");

  const dSlug = tagValues(e.tags, "d")[0] ?? "";
  if (!dSlug) warnings.push("missing-d");
  const slug = coord?.venue_slug ?? dSlug;
  const provider = coord?.provider_pubkey ?? tagValues(e.tags, "p")[0] ?? "";
  if (coord && dSlug && coord.venue_slug !== dSlug) {
    warnings.push("d-disagrees-with-a-coordinate");
  }
  if (!/^[0-9a-f]{64}$/.test(provider)) warnings.push("no-usable-provider-pubkey");

  const url = tagValues(e.tags, "r")[0] ?? null;
  if (url && !/^https?:\/\//.test(url)) warnings.push("non-http-r-tag");

  return {
    event_id: e.id,
    pubkey: e.pubkey,
    npub: hexToNpub(e.pubkey),
    created_at: e.created_at,
    content: typeof e.content === "string" ? e.content : "",
    venue_slug: slug,
    provider_pubkey: provider,
    venue_url: url,
    rating,
    rating_source: source,
    geohashes: [...new Set(tagValues(e.tags, "g"))].sort(),
    announcement_event_id: tagValues(e.tags, "e")[0] ?? null,
    warnings,
  };
}

/** Addressable identity: (pubkey, d) — one review per reviewer per venue. */
export function reviewKey(r: Review): string {
  return `${r.pubkey}:${r.venue_slug}`;
}

/**
 * Relays already collapse addressable events, but a relay may be stale, a client
 * may hand us a dump, and two relays may disagree — so keep the newest
 * created_at per (pubkey, d) ourselves. Ties break on the larger event id so a
 * re-run is byte-stable.
 */
export function dedupeReviews(reviews: Review[]): Review[] {
  const best = new Map<string, Review>();
  for (const r of reviews) {
    const k = reviewKey(r);
    const prev = best.get(k);
    if (
      !prev ||
      r.created_at > prev.created_at ||
      (r.created_at === prev.created_at && r.event_id > prev.event_id)
    ) {
      best.set(k, r);
    }
  }
  return [...best.values()];
}

export interface AttachResult {
  /** entries, each with its reviews newest-first */
  entries: Array<Record<string, unknown>>;
  attached: number;
  orphaned: Review[];
  reviews_total: number;
}

/** Bind reviews to catalogue entries by (provider pubkey, venue slug). */
export function attachReviews(
  entries: Array<Record<string, unknown>>,
  reviews: Review[],
): AttachResult {
  const byKey = new Map<string, Review[]>();
  const index = new Map<string, Record<string, unknown>>();
  for (const e of entries) {
    const k = `${e.pubkey}:${e.d}`;
    index.set(k, e);
    byKey.set(k, []);
  }

  const orphaned: Review[] = [];
  for (const r of reviews) {
    const k = `${r.provider_pubkey}:${r.venue_slug}`;
    const bucket = byKey.get(k);
    if (!bucket) {
      orphaned.push(r);
      continue;
    }
    bucket.push(r);
  }

  let attached = 0;
  const out = entries.map((e) => {
    const k = `${e.pubkey}:${e.d}`;
    const list = (byKey.get(k) ?? []).sort(
      (a, b) => b.created_at - a.created_at || a.event_id.localeCompare(b.event_id),
    );
    attached += list.length;
    return { ...e, reviews: list };
  });

  return { entries: out, attached, orphaned, reviews_total: reviews.length };
}
