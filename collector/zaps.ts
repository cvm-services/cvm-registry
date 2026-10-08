/**
 * zaps.ts — zap receipts (kind 9735) as a LABEL on a review, never a score.
 *
 * The design intent, stated so the next reader does not "improve" it:
 *
 *   - A zap is a SPEND SIGNAL. It proves someone paid sats in the direction of a
 *     review. It does not prove the review is true, and it is trivially
 *     purchasable — the same failure mode as paying for a Google review, just
 *     with a public audit trail.
 *   - Therefore zaps are rendered BESIDE a review and never folded into a single
 *     number. There is no `score` field here on purpose. Sorting stays
 *     newest-first; a heavily-zapped review must not jump the queue. (R3 is
 *     additive: if you find yourself adding a sort key here, re-read ADR-0002.)
 *
 * Amounts: NIP-57 puts the sats in two places — an `amount` tag on the receipt
 * (millisats, some clients) and the `amount` tag inside the JSON-encoded zap
 * REQUEST carried by `description`. We read both, prefer the explicit receipt
 * tag, and when neither is present we record the zap with sats=null rather than
 * guessing from the bolt11 string: a wrong number is worse than a missing one.
 */

import { type NostrEvent, tagValues } from "./lib.ts";

export const ZAP_RECEIPT_KIND = 9735;

export type AmountSource = "receipt-amount" | "request-amount" | "none";

export interface Zap {
  receipt_id: string;
  created_at: number;
  /** The review (or other event) this receipt paid toward. */
  target_event_id: string | null;
  /** Who received. */
  receiver_pubkey: string | null;
  /** Who paid, when the sender tag survived (NIP-57 `P`). */
  sender_pubkey: string | null;
  sats: number | null;
  millisats: number | null;
  amount_source: AmountSource;
  comment: string | null;
  warnings: string[];
}

/** The zap request lives in the `description` tag as a JSON string. */
export function parseZapRequest(e: NostrEvent): {
  amount_msats: number | null;
  sender_pubkey: string | null;
  content: string | null;
} {
  const raw = tagValues(e.tags, "description")[0];
  if (!raw) return { amount_msats: null, sender_pubkey: null, content: null };
  try {
    const req = JSON.parse(raw) as { pubkey?: string; content?: string; tags?: string[][] };
    const amount = tagValues(req.tags ?? [], "amount")[0];
    return {
      amount_msats: amount !== undefined && /^\d+$/.test(amount) ? Number(amount) : null,
      sender_pubkey: typeof req.pubkey === "string" ? req.pubkey : null,
      content: typeof req.content === "string" ? req.content : null,
    };
  } catch {
    return { amount_msats: null, sender_pubkey: null, content: null };
  }
}

function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n > 0 ? n : null;
}

/** A receipt is only a zap receipt if it actually points at something. */
export function isZapReceipt(e: NostrEvent): boolean {
  return e.kind === ZAP_RECEIPT_KIND && tagValues(e.tags, "e").length > 0;
}

export function classifyZap(e: NostrEvent): Zap | null {
  if (!isZapReceipt(e)) return null;
  const warnings: string[] = [];

  const receiptAmount = positiveInt(tagValues(e.tags, "amount")[0]);
  const req = parseZapRequest(e);
  let millisats = receiptAmount;
  let source: AmountSource = receiptAmount !== null ? "receipt-amount" : "none";
  if (millisats === null && req.amount_msats !== null) {
    millisats = req.amount_msats;
    source = "request-amount";
  }
  if (millisats === null) {
    warnings.push("amount-unknown:no-amount-tag-and-no-decoded-bolt11");
  }

  const sender = tagValues(e.tags, "P")[0] ?? req.sender_pubkey ?? null;
  if (sender === null) warnings.push("sender-unknown");

  const target = tagValues(e.tags, "e")[0] ?? null;
  const receiver = tagValues(e.tags, "p")[0] ?? null;

  return {
    receipt_id: e.id,
    created_at: e.created_at,
    target_event_id: target,
    receiver_pubkey: receiver,
    sender_pubkey: sender,
    sats: millisats === null ? null : Math.floor(millisats / 1000),
    millisats,
    amount_source: source,
    comment: req.content && req.content.trim().length ? req.content.trim() : null,
    warnings,
  };
}

export interface ZapTally {
  /** DISTINCT receipts behind this target. A receipt served by two relays is ONE zap. */
  count: number;
  /** Receipts seen again with an id already counted for this target. Reported, not hidden. */
  duplicates_dropped: number;
  /** Sum over receipts whose amount we could actually read. */
  sats_known: number;
  /** Receipts with an unreadable amount, counted but not summed. */
  count_amount_unknown: number;
  senders: string[];
  /** Distinct receipt ids, in first-seen order. */
  receipts: string[];
  /** How to read these numbers. Rendered verbatim by the dashboard. */
  label: string;
}

/**
 * Dedupe receipt events by id, BEFORE anything is tallied.
 *
 * The default relay set is two relays and every relay's events are concatenated,
 * so the same kind-9735 receipt arrives twice as a matter of course. Services and
 * reviews are deduped (collect.ts); receipts used to be the one list that was
 * not, which turned one 21-sat zap into "2 zap(s) · 42 sats" on the dashboard —
 * i.e. the zap label lied by a factor of two, which is exactly the kind of
 * authoritative-looking number R3 exists to refuse.
 *
 * A Nostr event id is the hash of the serialised event, so two events with the
 * same id are the same event; keeping the first is deterministic.
 */
export function dedupeZaps(zaps: Zap[]): Zap[] {
  const seen = new Set<string>();
  const out: Zap[] = [];
  for (const z of zaps) {
    if (seen.has(z.receipt_id)) continue;
    seen.add(z.receipt_id);
    out.push(z);
  }
  return out;
}

/**
 * Tally zap receipts per target event id. Missing amounts are counted and
 * reported, never treated as zero and never estimated.
 *
 * The id check here is deliberate redundancy: this function is the line the
 * double-count was measured on, so it refuses to count one receipt twice even if
 * a caller forgets to dedupe first. `count` is always a count of DISTINCT
 * receipts; repeats are surfaced as `duplicates_dropped`.
 */
export function tallyZapsByTarget(zaps: Zap[]): Map<string, ZapTally> {
  const out = new Map<string, ZapTally>();
  for (const z of zaps) {
    if (!z.target_event_id) continue;
    let t = out.get(z.target_event_id);
    if (!t) {
      t = {
        count: 0,
        duplicates_dropped: 0,
        sats_known: 0,
        count_amount_unknown: 0,
        senders: [],
        receipts: [],
        label: "zaps are a spend signal, not a score",
      };
      out.set(z.target_event_id, t);
    }
    if (t.receipts.includes(z.receipt_id)) {
      t.duplicates_dropped += 1;
      continue;
    }
    t.count += 1;
    t.receipts.push(z.receipt_id);
    if (z.sats === null) t.count_amount_unknown += 1;
    else t.sats_known += z.sats;
    if (z.sender_pubkey && !t.senders.includes(z.sender_pubkey)) t.senders.push(z.sender_pubkey);
  }
  return out;
}

/**
 * Attach a zap tally to each review. ORDER IS NOT TOUCHED — the input order is
 * the output order. That is the whole point: a review with 100k sats behind it
 * sits exactly where it sat before.
 */
export function attachZaps<T extends { event_id: string; zaps?: ZapTally | null }>(
  reviews: T[],
  tallies: Map<string, ZapTally>,
): { reviews: Array<T & { zaps: ZapTally | null }>; reviews_with_zaps: number; sats_total: number } {
  let withZaps = 0;
  let sats = 0;
  const out = reviews.map((r) => {
    const t = tallies.get(r.event_id);
    if (t) {
      withZaps += 1;
      sats += t.sats_known;
    }
    return { ...r, zaps: t ?? null };
  });
  return { reviews: out, reviews_with_zaps: withZaps, sats_total: sats };
}
