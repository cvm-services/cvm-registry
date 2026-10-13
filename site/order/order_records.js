// Order records for the customer surface (ADR-0017).
//
// Two events per order, both in the addressable range (30000-39999) so that a
// re-publish REPLACES the previous record instead of accumulating duplicates or
// silently overwriting unrelated content (the replaceable-kind hazard):
//
//   30318  receipt  PUBLIC.  Empty content; tags carry only facts the customer
//                            already shows on screen (venue, state, total). It
//                            exists so the order is provable and recoverable —
//                            it must never contain contact detail or items.
//   30319  detail   NIP-44 ENCRYPTED to the customer's own key. Items, contact
//                            inputs, per-line prices. Only the customer (holder
//                            of the key) can read it.
//
// Signing goes through a SIGNER abstraction, because the two supported methods
// keep the key in very different places:
//   * NIP-07 / NIP-46 → the key never reaches this code; the extension or the
//     bunker signs and encrypts on request.
//   * `makeLocalSigner(sk)` → tests only (and any future in-page key path).
import { finalizeEvent, getPublicKey, nip44 } from "./vendor/nostr.mjs";

export const RECEIPT_KIND = 30318;
export const DETAIL_KIND = 30319;
export const RECORD_TAG = "cvm-order";

/** localStorage keys. The identity key must never collide with the order id. */
const ORDER_KEY = "cvm-order-id-v1";
const IDENTITY_KEY = "cvm-identity-v1";

export function storeKey() {
  return ORDER_KEY;
}
export function identityKey() {
  return IDENTITY_KEY;
}

/** The `d` tag: one addressable record per order, per customer. */
export function orderKey(orderId) {
  return `${RECORD_TAG}:${orderId}`;
}

/**
 * A signer backed by a key we hold — tests and (potentially) an in-page key.
 * Production paths use window.nostr (NIP-07) or a BunkerSigner (NIP-46) with
 * exactly this shape, so the builders below never know which is in use.
 */
export function makeLocalSigner(sk) {
  const pubkey = getPublicKey(sk);
  return {
    pubkey,
    async signEvent(tmpl) {
      return finalizeEvent(tmpl, sk);
    },
    async nip44Encrypt(peerPubkey, plaintext) {
      const ck = nip44.v2.utils.getConversationKey(sk, peerPubkey);
      return nip44.v2.encrypt(plaintext, ck);
    },
    async nip44Decrypt(peerPubkey, ciphertext) {
      const ck = nip44.v2.utils.getConversationKey(sk, peerPubkey);
      return nip44.v2.decrypt(ciphertext, ck);
    },
  };
}

/**
 * The PUBLIC receipt. Deliberately minimal: no items, no contact detail.
 * `content` is empty, so the record cannot leak by accident.
 */
export async function buildReceiptRecord({ order, signer, createdAt }) {
  const tags = [
    ["d", orderKey(order.id)],
    ["t", RECORD_TAG],
    ["venue", String(order.venue_slug ?? "")],
    ["state", String(order.state ?? "")],
  ];
  if (Number.isFinite(order.total)) tags.push(["total", String(order.total)]);
  if (Number.isFinite(order.subtotal)) tags.push(["subtotal", String(order.subtotal)]);
  if (Number.isFinite(order.fee)) tags.push(["fee", String(order.fee)]);
  if (order.venue_reference) tags.push(["venue_reference", String(order.venue_reference)]);

  return await signer.signEvent({
    kind: RECEIPT_KIND,
    created_at: createdAt,
    tags,
    content: "",
  });
}

/**
 * The ENCRYPTED detail. NIP-44 to the customer's own pubkey, so the relay (and
 * anyone reading it) sees only ciphertext.
 */
export async function buildDetailRecord({ order, signer, createdAt }) {
  const plaintext = JSON.stringify({
    v: 1,
    order_id: order.id,
    venue_slug: order.venue_slug ?? null,
    state: order.state ?? null,
    items: order.items ?? [],
    inputs: order.inputs ?? {},
    subtotal: order.subtotal ?? null,
    fee: order.fee ?? null,
    total: order.total ?? null,
    venue_reference: order.venue_reference ?? null,
  });

  const content = await signer.nip44Encrypt(signer.pubkey, plaintext);

  return await signer.signEvent({
    kind: DETAIL_KIND,
    created_at: createdAt,
    tags: [["d", orderKey(order.id)], ["t", RECORD_TAG]],
    content,
  });
}

/** Parse a public receipt. Anything else — wrong kind, malformed tags — is null. */
export function readReceipt(ev) {
  if (!ev || ev.kind !== RECEIPT_KIND || !Array.isArray(ev.tags)) return null;
  const t = new Map(ev.tags.filter((x) => Array.isArray(x) && x.length >= 2));
  const d = t.get("d");
  if (typeof d !== "string" || !d.startsWith(`${RECORD_TAG}:`)) return null;
  const num = (v) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    order_id: d.slice(RECORD_TAG.length + 1),
    venue_slug: typeof t.get("venue") === "string" ? t.get("venue") : null,
    state: typeof t.get("state") === "string" ? t.get("state") : null,
    total: num(t.get("total")),
    subtotal: num(t.get("subtotal")),
    fee: num(t.get("fee")),
    venue_reference: typeof t.get("venue_reference") === "string" ? t.get("venue_reference") : null,
    created_at: ev.created_at ?? null,
  };
}

/**
 * Decrypt a detail record with the customer's own signer. Returns null when the
 * key does not match — a wrong key must never yield partial or garbage data.
 */
export async function readDetail(ev, signer) {
  if (!ev || ev.kind !== DETAIL_KIND || typeof ev.content !== "string") return null;
  try {
    const text = await signer.nip44Decrypt(signer.pubkey, ev.content);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// ---- local identity: which customer is this device? --------------------------

export function loadIdentity(storage) {
  try {
    const raw = storage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const id = JSON.parse(raw);
    return id && typeof id.pubkey === "string" ? id : null;
  } catch {
    return null;
  }
}

export function saveIdentity(storage, identity) {
  try {
    storage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch { /* private mode: identity simply does not persist */ }
}

export function clearIdentity(storage) {
  try {
    storage.removeItem(IDENTITY_KEY);
  } catch { /* nothing to clear */ }
}
