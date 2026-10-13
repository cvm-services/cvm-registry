// Sign in / my orders UI for the customer surface (ADR-0017).
//
// Kept out of app.js so the payment flow stays readable and testable: this
// module owns the signer, the relay round-trips, and the "my orders" list.
import { SimplePool } from "./vendor/nostr.mjs";
import {
  buildDetailRecord,
  buildReceiptRecord,
  clearIdentity,
  loadIdentity,
  makeLocalSigner,
  readDetail,
  saveIdentity,
} from "./order_records.js";
import { RELAYS, fetchDetail, fetchReceipts, publishOrderRecords } from "./order_relay.js";
import { bunkerSigner, hasNip07, nip07Signer, signerCapabilities } from "./signer.js";

let pool = null;
function getPool() {
  if (!pool) pool = new SimplePool();
  return pool;
}

/**
 * @param {{getItem: (k: string) => string|null, setItem: (k: string, v: unknown) => void, removeItem: (k: string) => void}} [storage]
 */
export function currentIdentity(storage = localStorage) {
  return loadIdentity(storage);
}

/**
 * Connect a signer and remember who this device is.
 * @param {{uri?: string, storage?: any, win?: any}} [opts]
 */
export async function signIn({ uri, storage = localStorage, win = globalThis }) {
  const signer = uri ? await bunkerSigner(uri) : await nip07Signer(win);
  const caps = signerCapabilities(signer);
  // @ts-ignore — signer is structurally a signer; Deno infers the union below
  saveIdentity(storage, {
    pubkey: signer.pubkey,
    method: signer.method,
    bunker: signer.bunker ?? null,
    canEncryptDetail: caps.canEncryptDetail,
  });
  return signer;
}

/** @param {any} [storage] */
export function signOut(storage = localStorage) {
  clearIdentity(storage);
}

/**
 * Publish this order as the customer's own records. Returns a summary; a relay
 * failure is reported, never thrown — the order itself is already paid for and
 * must not appear to fail because a relay was down.
 */
export async function saveOrder(signer, order, { relays = RELAYS, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const createdAt = now();
  const receipt = await buildReceiptRecord({ order, signer, createdAt });
  let detail = null;
  const caps = signerCapabilities(signer);
  if (caps.canEncryptDetail) {
    detail = await buildDetailRecord({ order, signer, createdAt });
  }
  const out = await publishOrderRecords(getPool(), relays, {
    receipt,
    detail: detail ?? receipt, // publish the receipt twice rather than nothing
  });
  return { ...out, detail_saved: Boolean(detail) };
}

/**
 * The customer's orders, rebuilt from relays — this is what makes a new device
 * (or a cleared browser) recover the list. `decrypt` is opt-in because it costs
 * one round-trip per order through the signer.
 */
/**
 * @param {string} pubkey
 * @param {{relays?: string[], decrypt?: boolean, signer?: any}} [opts]
 */
export async function loadOrders(pubkey, { relays = RELAYS, decrypt = false, signer = null } = {}) {
  const receipts = await fetchReceipts(getPool(), relays, pubkey);
  if (!decrypt || !signer) return receipts;

  const out = [];
  for (const r of receipts) {
    let detail = null;
    try {
      const ev = await fetchDetail(getPool(), relays, pubkey, r.order_id);
      if (ev) detail = await readDetail(ev, signer);
    } catch { /* an unreadable detail must not hide the order itself */ }
    out.push({ ...r, detail });
  }
  return out;
}

/** Test seam: inject a pool so the UI can be exercised without a network. */
export function __setPool(p) {
  pool = p;
}
export { makeLocalSigner };
