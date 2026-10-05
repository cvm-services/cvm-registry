/**
 * collect.ts — build the registry cache from CEP-6 announcements.
 *
 *   deno run --allow-net --allow-read --allow-write \
 *     collector/collect.ts --out site/catalog.json
 *
 * Design rules this file obeys (contextvm-services ADR-0001 / D6):
 *   - the dashboard is a CACHE, not a proxy: this writes a static file and the
 *     page never talks to a relay at all
 *   - only single-letter tag filters are ever sent (D2)
 *   - the allow-list is applied HERE, so an unknown npub never reaches the page
 *     (D12a, fail closed)
 *   - re-runs are idempotent apart from generated_at: same input -> same entries
 *
 * Offline mode (tests / CI, no network):
 *   deno run --allow-read --allow-write collector/collect.ts --input fixtures/events.ndjson
 */
import {
  applyAllowList,
  assertSingleLetterFilters,
  classify,
  dedupe,
  KINDS,
  type NostrEvent,
  parseCurators,
  type Vocab,
} from "./lib.ts";
import {
  attachReviews,
  classifyReview,
  dedupeReviews,
  REVIEW_KIND,
  type Review,
} from "./reviews.ts";

import {
  attachZaps,
  classifyZap,
  tallyZapsByTarget,
  ZAP_RECEIPT_KIND,
  type Zap,
} from "./zaps.ts";

import {
  applyAttestations,
  ATTESTATION_KIND,
  classifyAttestation,
  indexAttestations,
  type Attestation,
} from "./attestations.ts";

import {
  attachPaymentViews,
  DECLARED_LABEL,
  DOCTRINE,
  RECEIVED_LABEL,
  tallyObservedSats,
} from "./paid.ts";

interface Args {
  relays: string[];
  out: string;
  allowlist: string;
  vocab: string;
  policy: string;
  input: string | null;
  timeoutMs: number;
  limit: number;
  now: number | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    relays: ["wss://relay.damus.io", "wss://relay2.orangesync.tech"],
    out: "site/catalog.json",
    allowlist: "curators.json",
    vocab: "vocab/service-inputs.json",
    policy: "policy.json",
    input: null,
    timeoutMs: 20_000,
    limit: 2000,
    now: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--relays": a.relays = v.split(",").map((s) => s.trim()).filter(Boolean); i++; break;
      case "--out": a.out = v; i++; break;
      case "--allowlist": a.allowlist = v; i++; break;
      case "--vocab": a.vocab = v; i++; break;
      case "--policy": a.policy = v; i++; break;
      case "--input": a.input = v; i++; break;
      case "--timeout-ms": a.timeoutMs = Number(v); i++; break;
      case "--limit": a.limit = Number(v); i++; break;
      case "--now": a.now = Number(v); i++; break;
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  return a;
}

export interface RelayStatus {
  relay: string;
  ok: boolean;
  events: number;
  error: string | null;
}

/** One NIP-01 REQ per relay, harvest until EOSE or the deadline. */
export function fetchRelay(
  relay: string,
  kinds: number[],
  limit: number,
  timeoutMs: number,
): Promise<{ events: NostrEvent[]; status: RelayStatus }> {
  const status: RelayStatus = { relay, ok: false, events: 0, error: null };
  const events: NostrEvent[] = [];
  const filter = { kinds, limit };
  assertSingleLetterFilters(filter); // never send a multi-letter tag filter
  return new Promise((resolve) => {
    let done = false;
    let ws: WebSocket;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already closed */ }
      status.events = events.length;
      resolve({ events, status });
    };
    const timer = setTimeout(() => { status.error = `timeout after ${timeoutMs}ms`; finish(); }, timeoutMs);
    try {
      ws = new WebSocket(relay);
    } catch (err) {
      status.error = String((err as Error).message ?? err);
      finish();
      return;
    }
    ws.onopen = () => ws.send(JSON.stringify(["REQ", "registry", filter]));
    ws.onmessage = (e) => {
      let msg: unknown;
      try { msg = JSON.parse(e.data as string); } catch { return; }
      if (!Array.isArray(msg)) return;
      if (msg[0] === "EVENT" && msg[2]) events.push(msg[2] as NostrEvent);
      else if (msg[0] === "EOSE") { status.ok = true; finish(); }
      else if (msg[0] === "CLOSED" || msg[0] === "NOTICE") {
        status.error = `${msg[0]}: ${String(msg[1])}`;
        finish();
      }
    };
    ws.onerror = () => { if (!status.error) status.error = "websocket error"; };
    ws.onclose = () => { if (!status.error && !done) status.error = "closed before EOSE"; finish(); };
  });
}

async function main() {
  const args = parseArgs(Deno.args);
  const generatedAt = args.now ?? Math.floor(Date.now() / 1000);

  const allowRaw = JSON.parse(await Deno.readTextFile(args.allowlist));
  const allow = parseCurators(allowRaw);
  const vocab: Vocab = JSON.parse(await Deno.readTextFile(args.vocab));
  const policy = JSON.parse(await Deno.readTextFile(args.policy));

  let events: NostrEvent[] = [];
  const relayStatus: RelayStatus[] = [];

  if (args.input) {
    const text = await Deno.readTextFile(args.input);
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); } catch { /* skip bad line */ }
    }
    relayStatus.push({ relay: `file:${args.input}`, ok: true, events: events.length, error: null });
  } else {
    const results = await Promise.all(
      args.relays.map((r) => fetchRelay(r, [...KINDS, REVIEW_KIND, ZAP_RECEIPT_KIND, ATTESTATION_KIND], args.limit, args.timeoutMs)),
    );
    for (const r of results) {
      events = events.concat(r.events);
      relayStatus.push(r.status);
    }
  }

  const raw = events.length;

  // Services, reviews and zap receipts arrive in one REQ but are three different
  // things: a review is not a catalogue entry, and a receipt is not a review.
  const serviceEvents = events.filter((e) =>
    e.kind !== REVIEW_KIND && e.kind !== ZAP_RECEIPT_KIND && e.kind !== ATTESTATION_KIND
  );
  const reviewEvents = events.filter((e) => e.kind === REVIEW_KIND);
  const zapEvents = events.filter((e) => e.kind === ZAP_RECEIPT_KIND);
  const attestationEvents = events.filter((e) => e.kind === ATTESTATION_KIND);

  const deduped = dedupe(serviceEvents);
  const { kept, dropped } = applyAllowList(deduped, allow.hex);
  const entries = kept.map((e) => classify(e, vocab)).sort((a, b) =>
    a.kind - b.kind || a.pubkey.localeCompare(b.pubkey) || a.d.localeCompare(b.d)
  );

  // Reviews are allow-listed on the REVIEWER's pubkey: the same fail-closed
  // list, applied to a different role. An unlisted reviewer's review is never
  // shown, and never silently either — the count is reported.
  const allowSet = new Set<string>(allow.hex as unknown as Iterable<string>);
  const reviewsParsed = reviewEvents
    .map((e) => classifyReview(e))
    .filter((r): r is Review => r !== null);
  const reviewsDeduped = dedupeReviews(reviewsParsed);
  const reviewsAllowed = reviewsDeduped.filter((r) => allowSet.has(r.pubkey));
  const reviewsDropped = reviewsDeduped.length - reviewsAllowed.length;

  // Zaps are attached AFTER allow-listing and never influence the order: a zap
  // is a spend signal, not a score (ADR-0002 §R3).
  const zapsParsed = zapEvents
    .map((e) => classifyZap(e))
    .filter((z): z is Zap => z !== null);
  const zapsByTarget = tallyZapsByTarget(zapsParsed);
  const withZaps = attachZaps(reviewsAllowed, zapsByTarget);

  // R4a: a vouched review gets a badge ONLY when the attestation's author is the
  // pubkey that announced that venue. Anyone can publish a kind-30317 event, so
  // without this check the badge would be decorative. Rejections are counted.
  const attestationsParsed = attestationEvents
    .map((e) => classifyAttestation(e))
    .filter((a): a is Attestation => a !== null);
  const attestationIndex = indexAttestations(attestationsParsed);
  const providerBySlug = new Map<string, string>(
    (entries as unknown as Array<{ d: string; pubkey: string }>).map((e) => [e.d, e.pubkey]),
  );
  const withAttestations = applyAttestations(
    withZaps.reviews,
    providerBySlug,
    attestationIndex,
  );

  const bindings = attachReviews(
    entries as unknown as Array<Record<string, unknown>>,
    withAttestations.reviews,
  );
  const entriesWithReviews = bindings.entries;

  const tally: Record<string, number> = {};
  for (const e of entries) for (const c of e.classes) tally[c] = (tally[c] ?? 0) + 1;

  const ratingHistogram: Record<string, number> = {};
  for (const r of reviewsAllowed) {
    const k = r.rating === null ? "unrated" : String(r.rating);
    ratingHistogram[k] = (ratingHistogram[k] ?? 0) + 1;
  }

  const zapAmountUnknown = zapsParsed.filter((z) => z.sats === null).length;

  // Part 2: the declared-vs-received view. Receipts are tallied by TARGET event
  // id, keeping the amount provenance apart (a receipt `amount` tag is the
  // LNURL server's word; a zap-request amount is the client's claim). This is a
  // different aggregation from the review-side tally above on purpose: see the
  // header of collector/paid.ts for why blending the two overstates payment.
  const observedByTarget = tallyObservedSats(zapsParsed);
  const paid = attachPaymentViews(
    entries as unknown as Array<{ event_id: string; caps?: { tool: string; amount: number; unit: string }[] }>,
    observedByTarget,
  );
  let paidReceiptSats = 0;
  let paidRequestSats = 0;
  let paidAmountUnknown = 0;
  for (const v of paid.views) {
    if (!v.received) continue;
    paidReceiptSats += v.received.sats_from_receipt_tag;
    paidRequestSats += v.received.sats_from_zap_request;
    paidAmountUnknown += v.received.count_amount_unknown;
  }

  const catalog = {
    generated_at: generatedAt,
    generated_at_iso: new Date(generatedAt * 1000).toISOString(),
    collector: {
      version: 3,
      kinds: [...KINDS, REVIEW_KIND, ZAP_RECEIPT_KIND, ATTESTATION_KIND],
      review_kind: REVIEW_KIND,
      relays: args.input ? [] : args.relays,
      relay_status: relayStatus,
      offline_input: args.input,
    },
    allowlist: {
      source: args.allowlist,
      dashboard_host: allowRaw?.dashboard_host ?? null,
      curators: allow.curators,
      pubkey_count: allow.hex.length,
      errors: allow.errors,
      policy: allowRaw?.policy ?? null,
    },
    policy,
    counts: {
      raw_events: raw,
      after_dedupe: deduped.length,
      kept: kept.length,
      dropped_not_allowlisted: dropped.length,
    },
    reviews: {
      raw_events: reviewEvents.length,
      parsed: reviewsParsed.length,
      after_dedupe: reviewsDeduped.length,
      shown: reviewsAllowed.length,
      dropped_not_allowlisted: reviewsDropped,
      attached: bindings.attached,
      orphaned_no_catalogue_entry: bindings.orphaned.length,
      rating_histogram: ratingHistogram,
      // No score. Zaps (R3) are a spend signal shown beside a review, never
      // folded into a single authoritative number, and this collector does not
      // rank by them: order stays newest-first.
      scoring: "none:reviews-are-listed-newest-first",
      attestations: {
        parsed: attestationsParsed.length,
        indexed: attestationIndex.size,
        confirmed_reviews: withAttestations.confirmed,
        rejected_wrong_author: withAttestations.rejected_wrong_author,
        rejected_unknown_venue: withAttestations.rejected_unknown_venue,
        badge: "venue-confirmed",
        label: "the venue vouched for this reviewer; not proof the reviewer was present",
      },
      zaps: {
        receipts: zapsParsed.length,
        reviews_with_zaps: withZaps.reviews_with_zaps,
        sats_total_known: withZaps.sats_total,
        receipts_amount_unknown: zapAmountUnknown,
        label: "zaps are a spend signal, not a score",
      },
    },
    // Part 1 + Part 2 of paid-CVM discovery. Two labelled sides, never one
    // "paid" verdict: `declared_*` is what the announcement advertises,
    // `received_*` is what receipts show moving. The dashboard renders both
    // columns and knows nothing about a blended total because none exists.
    paid: {
      declared_label: DECLARED_LABEL,
      received_label: RECEIVED_LABEL,
      doctrine: DOCTRINE,
      filter: "declared_price_amount_gt_zero",
      counts: {
        entries_with_declared_price: paid.entries_with_declared_price,
        entries_with_receipts: paid.entries_with_receipts,
        entries_with_receipt_amount: paid.entries_with_receipt_amount,
        receipts_matched_to_entries: paid.receipts_matched,
        receipts_unmatched: paid.receipts_unmatched,
        sats_from_receipt_tag: paidReceiptSats,
        sats_from_zap_request: paidRequestSats,
        receipts_amount_unknown: paidAmountUnknown,
      },
      // keyed by the entry's event id; absence means "nothing to show"
      entries: paid.views,
    },
    class_tally: tally,
    // Every entry here is from an allow-listed curator. Nothing was fetched per service.
    entries: entriesWithReviews,
  };

  await Deno.mkdir(args.out.replace(/\/[^/]+$/, ""), { recursive: true }).catch(() => {});
  await Deno.writeTextFile(args.out, JSON.stringify(catalog, null, 2) + "\n");

  const errs = relayStatus.filter((s) => !s.ok).map((s) => s.relay);
  console.log(
    `catalog: raw=${raw} deduped=${deduped.length} kept=${kept.length} ` +
      `dropped=${dropped.length} relays_failed=${errs.length ? errs.join(" ") : "none"} ` +
      `| attest ${attestationsParsed.length}/${attestationIndex.size}=${withAttestations.confirmed}` +
      ` | reviews raw=${reviewEvents.length} shown=${reviewsAllowed.length} ` +
      `attached=${bindings.attached} orphaned=${bindings.orphaned.length} ` +
      `dropped=${reviewsDropped}` +
      ` | paid declared=${paid.entries_with_declared_price} ` +
      `receipts=${paid.receipts_matched}/${paid.receipts_matched + paid.receipts_unmatched} ` +
      `sats(receipt-tag)=${paidReceiptSats} sats(zap-request)=${paidRequestSats} -> ${args.out}`,
  );
  if (allow.errors.length) console.error("allow-list errors: " + allow.errors.join("; "));
}

if (import.meta.main) await main();
