// Relay I/O for customer order records (ADR-0017).
//
// Deliberately thin and injectable: the pool is passed in, so the whole module
// is testable without a network and the PWA can share one connection.
import { RECEIPT_KIND, DETAIL_KIND, RECORD_TAG, readReceipt } from "./order_records.js";

/** Ours first, then an independent second home: either being down is survivable. */
export const RELAYS = ["wss://relay2.orangesync.tech", "wss://relay.primal.net"];

/**
 * Publish both records to every relay.
 *
 * `SimplePool.publish(relays, event)` takes an ARRAY of relays and returns an
 * ARRAY OF PROMISES (one per relay), not a promise — awaiting it directly is a
 * no-op that silently publishes nothing. That mistake shipped once; the test
 * below pins the shape.
 */
export async function publishOrderRecords(pool, relays, { receipt, detail }) {
  const settle = async (event) => {
    const results = await Promise.allSettled(pool.publish(relays, event));
    return results.filter((r) => r.status === "fulfilled").length;
  };
  const receiptOk = await settle(receipt);
  const detailOk = await settle(detail);
  // A relay counts as reached when BOTH records landed on it.
  return {
    relays_ok: Math.min(receiptOk, detailOk),
    relays_total: relays.length,
    receipt_id: receipt.id,
    detail_id: detail.id,
  };
}

/**
 * Every receipt this pubkey ever published. Addressable events mean the relay
 * returns the LATEST version of each `(kind, pubkey, d)` triple, so this is the
 * customer's current order list — no client-side dedupe needed, though we
 * dedupe anyway in case a relay is sloppy.
 */
export async function fetchReceipts(pool, relays, pubkey, { timeoutMs = 8000 } = {}) {
  const byOrder = new Map();
  const filter = { kinds: [RECEIPT_KIND], authors: [pubkey], "#t": [RECORD_TAG] };

  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      const sub = pool.subscribeMany(relays, filter, {
        onevent(ev) {
          const r = readReceipt(ev);
          if (!r) return;
          const prev = byOrder.get(r.order_id);
          if (!prev || (ev.created_at ?? 0) > (prev.created_at ?? 0)) byOrder.set(r.order_id, r);
        },
        oneose() {
          clearTimeout(timer);
          finish();
        },
      });
      // SubscribeMany handles cleanup; keep a handle for the timeout path.
      if (sub?.close) setTimeout(() => sub.close(), timeoutMs + 500);
    } catch {
      clearTimeout(timer);
      finish();
    }
  });

  return [...byOrder.values()].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
}

/** The newest encrypted detail for one order, or null. */
export async function fetchDetail(pool, relays, pubkey, orderId, { timeoutMs = 8000 } = {}) {
  const d = `${RECORD_TAG}:${orderId}`;
  /** @type {any} */
  let newest = null;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      pool.subscribeMany(relays, { kinds: [DETAIL_KIND], authors: [pubkey], "#d": [d] }, {
        onevent(ev) {
          if (!newest || (ev.created_at ?? 0) > (newest.created_at ?? 0)) newest = ev;
        },
        oneose() {
          clearTimeout(timer);
          finish();
        },
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
  return newest;
}
