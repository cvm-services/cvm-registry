/**
 * Tests for collector/paid.ts — the DECLARED vs RECEIVED view (Part 2).
 *
 * The load-bearing test is `the provenance split is NOT the blended tally`:
 * a zap receipt's `amount` tag is the LNURL server's record and a zap-REQUEST
 * amount is the client's claim. `tallyZapsByTarget` (R3, collector/zaps.ts)
 * sums both, which is right for "how many sats are behind this review" and
 * wrong for "what was actually paid". This file pins that difference so a
 * later refactor cannot quietly reuse the blended tally for the payment view.
 *
 * Run: deno test --allow-read   (no network, no relays)
 */

import { classify } from "../collector/lib.ts";
import {
  attachPaymentViews,
  DECLARED_LABEL,
  DOCTRINE,
  paymentView,
  RECEIVED_LABEL,
  tallyObservedSats,
} from "../collector/paid.ts";
import { classifyZap, tallyZapsByTarget, ZAP_RECEIPT_KIND, type Zap } from "../collector/zaps.ts";
import type { Vocab } from "../collector/lib.ts";

const VOCAB: Vocab = { tiers: {}, fields: {} };

const VENUE_ID = "11".repeat(32);
const REVIEW_ID = "22".repeat(32);
const PAYER = "87".repeat(32);
const SERVER = "cc".repeat(32);

function eq(a: unknown, b: unknown, what: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
  }
}
function ok(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}

/** A kind-9735 receipt whose `amount` tag carries the number (receipt-amount). */
function receiptWithTagAmount(id: string, target: string, msats: number): Zap {
  const z = classifyZap({
    id, kind: ZAP_RECEIPT_KIND, pubkey: SERVER, created_at: 1_791_000_000,
    content: "", sig: "0".repeat(128),
    tags: [["p", "dd".repeat(32)], ["e", target], ["P", PAYER], ["amount", String(msats)]],
  });
  ok(z, "receipt not classified");
  return z!;
}

/** A kind-9735 receipt with NO amount tag; the number is only in the zap request. */
function receiptWithRequestAmount(id: string, target: string, msats: number): Zap {
  const request = JSON.stringify({ kind: 9734, pubkey: PAYER, content: "nice", tags: [["amount", String(msats)]] });
  const z = classifyZap({
    id, kind: ZAP_RECEIPT_KIND, pubkey: SERVER, created_at: 1_791_000_100,
    content: "", sig: "0".repeat(128),
    tags: [["p", "dd".repeat(32)], ["e", target], ["description", request]],
  });
  ok(z, "receipt not classified");
  return z!;
}

/** A receipt with neither an amount tag nor a readable zap request. */
function receiptWithoutAmount(id: string, target: string): Zap {
  const z = classifyZap({
    id, kind: ZAP_RECEIPT_KIND, pubkey: SERVER, created_at: 1_791_000_200,
    content: "", sig: "0".repeat(128),
    tags: [["p", "dd".repeat(32)], ["e", target], ["bolt11", "lnbc1..."]],
  });
  ok(z, "receipt not classified");
  return z!;
}

Deno.test("paid: the provenance split is NOT the blended tally (the whole point)", () => {
  const strong = receiptWithTagAmount("a".repeat(64), VENUE_ID, 21_000);   // 21 sats, server's word
  const claim = receiptWithRequestAmount("b".repeat(64), VENUE_ID, 5_000); // 5 sats, client's claim
  const splits = tallyObservedSats([strong, claim]);
  const s = splits.get(VENUE_ID)!;
  const blended = tallyZapsByTarget([strong, claim]).get(VENUE_ID)!;

  eq(s.sats_from_receipt_tag, 21, "only the receipt-tag sats are strong evidence");
  eq(s.sats_from_zap_request, 5, "the zap-request sats are kept apart");
  eq(s.count, 2, "both receipts had a readable amount");
  eq(s.receipt_ids.length, 2, "both receipts are listed");
  eq(s.request_amount_receipt_ids, ["b".repeat(64)], "the weak receipt is named, not hidden");

  // The R3 tally folds the client's claim into the same number as the server's
  // record. That is exactly the overstatement this view exists to prevent: the
  // two buckets must stay separable, and the blended number must not be
  // accepted as "sats received".
  eq(blended.sats_known, 26, "the blended tally really does sum both");
  ok(s.sats_from_receipt_tag !== blended.sats_known,
    "the strong-evidence figure must differ from the blended figure when a claim is present");
  eq(s.sats_from_receipt_tag + s.sats_from_zap_request, blended.sats_known,
    "the split accounts for the same total without merging the provenance");
});

Deno.test("paid: an unreadable amount is counted and reported, never summed as zero", () => {
  const unknown = receiptWithoutAmount("c".repeat(64), VENUE_ID);
  const s = tallyObservedSats([unknown]).get(VENUE_ID)!;
  eq(s.count, 0, "no receipt contributed a readable amount");
  eq(s.count_amount_unknown, 1, "but the receipt is reported");
  eq(s.sats_from_receipt_tag, 0, "nothing summed");
  eq(s.sats_from_zap_request, 0, "nothing summed");
  eq(s.amount_unknown_receipt_ids, ["c".repeat(64)], "the receipt is named");
});

Deno.test("paid: receipts are tallied per target, and a target with none is absent", () => {
  const a = receiptWithTagAmount("1".repeat(64), VENUE_ID, 1_000);
  const b = receiptWithTagAmount("2".repeat(64), REVIEW_ID, 9_000);
  const splits = tallyObservedSats([a, b]);
  eq(splits.get(VENUE_ID)!.sats_from_receipt_tag, 1, "venue bucket");
  eq(splits.get(REVIEW_ID)!.sats_from_receipt_tag, 9, "review bucket separate");
  eq(splits.get("33".repeat(32)), undefined, "an untargeted id has no bucket at all");
});

Deno.test("paid: a free tool is NOT a declared price, and nothing is shown for it", () => {
  const free = classify({ id: "4".repeat(64), pubkey: "ab".repeat(32), created_at: 1, kind: 11316, content: "", sig: "0".repeat(128), tags: [["t", "cvm:service:restaurant"], ["cap", "tool:order", "0", "sats"]] }, VOCAB);
  const view = paymentView(free, new Map());
  eq(view, null, "neither a declared price nor a receipt => nothing to render");

  const priced = classify({ id: "5".repeat(64), pubkey: "ab".repeat(32), created_at: 1, kind: 11316, content: "", sig: "0".repeat(128), tags: [["t", "cvm:service:restaurant"], ["cap", "tool:order", "0", "sats"], ["cap", "tool:menu", "1500", "sats"]] }, VOCAB);
  const v2 = paymentView(priced, new Map())!;
  eq(v2.declared, [{ tool: "menu", amount: 1500, unit: "sats" }], "only the amount > 0 tool");
  eq(v2.received, null, "no receipts observed => null, not a zeroed object that looks like data");
});

Deno.test("paid: the two labels are different, and neither one claims settlement", () => {
  ok(String(DECLARED_LABEL) !== String(RECEIVED_LABEL), "declared and received must not share a label");
  ok(/advertisement/.test(DECLARED_LABEL), "the declared label says what it is");
  ok(/claim/.test(RECEIVED_LABEL), "the received label names the weak provenance");
  ok(/never summed/.test(DOCTRINE), "the doctrine refuses a blended total");
});

Deno.test("paid: attach keeps entry order and counts receipts it could not match", () => {
  const entries = [
    { event_id: VENUE_ID, caps: [{ tool: "order", amount: 1500, unit: "sats" }] },
    { event_id: "99".repeat(32), caps: [] },
    { event_id: REVIEW_ID, caps: [{ tool: "menu", amount: 0, unit: "sats" }] },
  ];
  const zaps = [
    receiptWithTagAmount("a".repeat(64), VENUE_ID, 21_000),
    receiptWithRequestAmount("b".repeat(64), VENUE_ID, 5_000),
    receiptWithoutAmount("c".repeat(64), VENUE_ID),
    // A receipt aimed at an entry that declares NO price: the received side
    // exists on its own, and the declared side stays empty.
    receiptWithTagAmount("d".repeat(64), REVIEW_ID, 9_000),
    receiptWithTagAmount("e".repeat(64), "77".repeat(32), 4_000), // targets something we do not render
  ];
  const res = attachPaymentViews(entries, tallyObservedSats(zaps));

  eq(res.views.map((v) => v.event_id), [VENUE_ID, REVIEW_ID], "input order, and only rows with something to show");
  eq(res.views[0].received!.sats_from_receipt_tag, 21, "venue: strong bucket");
  eq(res.views[0].received!.sats_from_zap_request, 5, "venue: claim bucket");
  eq(res.views[0].received!.count_amount_unknown, 1, "venue: unreadable receipt reported");
  eq(res.views[1].declared, [], "a free tool still declares nothing");
  eq(res.views[1].received!.sats_from_receipt_tag, 9, "but its receipts are shown on the received side alone");
  eq(res.entries_with_declared_price, 1, "only the venue declares a price > 0");
  eq(res.entries_with_receipts, 2, "two entries have receipts");
  eq(res.entries_with_receipt_amount, 2, "two entries have receipt-tag evidence");
  eq(res.receipts_matched, 4, "four receipts point at a rendered entry");
  eq(res.receipts_unmatched, 1, "the receipt aimed elsewhere is reported, not silently dropped");
});
