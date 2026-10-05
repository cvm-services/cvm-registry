/**
 * paid.ts — the DECLARED vs RECEIVED view for paid CVMs. Part 2.
 *
 * Two different numbers that this module refuses to blend:
 *
 *   declared — the `["cap","tool:<name>","<n>","sats"]` tag on the announcement.
 *              An ADVERTISEMENT of a call price. It is not a payment, it is not
 *              a settlement, and its presence proves only that someone wrote a
 *              number on a public tag.
 *   received — zap receipts (kind 9735) that point AT the announcement: sats
 *              that actually moved. Even these are split by how the amount was
 *              read, because NIP-57 puts the number in two places:
 *                * the receipt's own `amount` tag (millisats) — the LNURL
 *                  server's word: `receipt-amount`, strong evidence;
 *                * the zap REQUEST inside `description` — the CLIENT's claim:
 *                  `request-amount`, a claim about a payment, not the
 *                  server's record of one;
 *                * neither readable — `none`: counted, reported, never summed.
 *
 * `AmountSource` is carried through from collector/zaps.ts UNTOUCHED. This
 * module reuses `classifyZap` as the only zap parser in the repo; it adds an
 * aggregation, not a second parser.
 *
 * NOTE ON `tallyZapsByTarget` (deliberate non-use): that tally sums
 * `sats_known` over every receipt regardless of `amount_source`, which is the
 * right shape for the R3 review label ("n sats behind this review") and the
 * WRONG shape here — for a payment view it would fold the client's claim into
 * the server's receipt and overstate what was actually paid. The test
 * `paid: the provenance split is NOT the blended tally` pins that difference.
 *
 * There is deliberately NO `paid` boolean, no `is_paid`, no single total, and
 * no sort key anywhere in this file. Declared and received are two labelled
 * columns that sit beside each other; if a future change wants one number,
 * re-read this comment first.
 */

import { type Cap, pricedCaps } from "./lib.ts";
import { type AmountSource, type Zap } from "./zaps.ts";

/** Rendered verbatim by the dashboard. Keep the two labels different. */
export const DECLARED_LABEL = "Declared price per tool — an advertisement, not a settlement";
export const RECEIVED_LABEL =
  "Observed sats received (zap receipts), split by provenance — receipt tag = strong evidence, zap request = the client's claim";

/** The default free-form reader's guide, emitted with every view. */
export const DOCTRINE =
  "declared caps are advertisements; receipts are payments; the two are never summed";

export interface ObservedSats {
  /** receipts that target this announcement and had a readable amount */
  count: number;
  /** summed ONLY over `receipt-amount` receipts */
  sats_from_receipt_tag: number;
  /** summed ONLY over `request-amount` receipts (the client's claim) */
  sats_from_zap_request: number;
  /** receipts that targeted this announcement but had no readable amount */
  count_amount_unknown: number;
  receipt_ids: string[];
  /** the subset of receipt_ids whose amount came from the client's zap request */
  request_amount_receipt_ids: string[];
  /** the subset with no readable amount at all */
  amount_unknown_receipt_ids: string[];
  /** how to read these numbers */
  label: string;
}

/**
 * Tally zap receipts per TARGET event id, keeping the amount provenance apart.
 * Missing amounts are counted and reported, never treated as zero and never
 * estimated (the same rule collector/zaps.ts applies to a single receipt).
 */
export function tallyObservedSats(zaps: Zap[]): Map<string, ObservedSats> {
  const out = new Map<string, ObservedSats>();
  for (const z of zaps) {
    if (!z.target_event_id) continue;
    let t = out.get(z.target_event_id);
    if (!t) {
      t = {
        count: 0,
        sats_from_receipt_tag: 0,
        sats_from_zap_request: 0,
        count_amount_unknown: 0,
        receipt_ids: [],
        request_amount_receipt_ids: [],
        amount_unknown_receipt_ids: [],
        label: RECEIVED_LABEL,
      };
      out.set(z.target_event_id, t);
    }
    t.receipt_ids.push(z.receipt_id);
    const source: AmountSource = z.amount_source;
    if (z.sats === null || source === "none") {
      t.count_amount_unknown += 1;
      t.amount_unknown_receipt_ids.push(z.receipt_id);
      continue;
    }
    t.count += 1;
    if (source === "receipt-amount") t.sats_from_receipt_tag += z.sats;
    else if (source === "request-amount") {
      t.sats_from_zap_request += z.sats;
      t.request_amount_receipt_ids.push(z.receipt_id);
    }
  }
  return out;
}

export interface PaymentView {
  event_id: string;
  /** tools the announcement ADVERTISES a price for (amount > 0 only) */
  declared: Cap[];
  declared_label: string;
  /** sats actually seen moving toward this announcement; null when none seen */
  received: ObservedSats | null;
  received_label: string;
}

/**
 * Pair one entry's declared prices with the sats observed against it, as two
 * separate fields. Returns null when there is neither side to show, so the
 * dashboard renders nothing rather than an empty "paid?" box.
 */
export function paymentView(
  entry: { event_id: string; caps?: Cap[] },
  observed: Map<string, ObservedSats>,
): PaymentView | null {
  const declared = pricedCaps(entry.caps);
  const received = observed.get(entry.event_id) ?? null;
  if (declared.length === 0 && received === null) return null;
  return {
    event_id: entry.event_id,
    declared,
    declared_label: DECLARED_LABEL,
    received,
    received_label: RECEIVED_LABEL,
  };
}

export interface PaidAttachResult {
  /** one view per entry that has something to show, entry order preserved */
  views: PaymentView[];
  /** entries that DECLARE a price on at least one tool */
  entries_with_declared_price: number;
  /** entries with at least one receipt pointing at them (any provenance) */
  entries_with_receipts: number;
  /** entries with receipts whose `amount` tag carried the number */
  entries_with_receipt_amount: number;
  /** receipts that targeted an entry we actually render */
  receipts_matched: number;
  /** receipts that targeted something we do not render (a review, a stranger) */
  receipts_unmatched: number;
}

/**
 * Build the payment views for a catalogue. ORDER IS NOT TOUCHED: the output
 * follows the input order, so nothing here can rank a provider by its numbers.
 */
export function attachPaymentViews(
  entries: Array<{ event_id: string; caps?: Cap[] }>,
  observed: Map<string, ObservedSats>,
): PaidAttachResult {
  const views: PaymentView[] = [];
  const usedTargets = new Set<string>();
  let withDeclared = 0;
  let withReceipts = 0;
  let withReceiptAmount = 0;

  for (const e of entries) {
    const view = paymentView(e, observed);
    if (!view) continue;
    if (view.declared.length > 0) withDeclared += 1;
    if (view.received) {
      withReceipts += 1;
      usedTargets.add(e.event_id);
      if (view.received.sats_from_receipt_tag > 0) withReceiptAmount += 1;
    }
    views.push(view);
  }

  let matched = 0;
  for (const target of usedTargets) matched += observed.get(target)?.receipt_ids.length ?? 0;
  let all = 0;
  for (const t of observed.values()) all += t.receipt_ids.length;

  return {
    views,
    entries_with_declared_price: withDeclared,
    entries_with_receipts: withReceipts,
    entries_with_receipt_amount: withReceiptAmount,
    receipts_matched: matched,
    receipts_unmatched: all - matched,
  };
}
