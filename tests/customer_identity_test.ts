import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { __setPool, currentIdentity, loadOrders, saveOrder, signIn, signOut } from "../site/order/identity.js";
import { makeLocalSigner, RECEIPT_KIND, DETAIL_KIND } from "../site/order/order_records.js";

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k) : null),
    setItem: (k: string, v: unknown) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}

/** A pool that keeps published events and replays them on subscribe. */
function fakePool() {
  const store: any[] = [];
  return {
    store,
    async publish(_url: string, ev: any) {
      // Addressable semantics: a newer event for the same (kind,pubkey,d) wins.
      const d = (ev.tags ?? []).find((t: string[]) => t[0] === "d")?.[1];
      const i = store.findIndex((x) => x.kind === ev.kind && x.pubkey === ev.pubkey &&
        (x.tags ?? []).find((t: string[]) => t[0] === "d")?.[1] === d);
      if (i >= 0) store[i] = ev;
      else store.push(ev);
      return "ok";
    },
    subscribeMany(_urls: string[], filter: any, handlers: any) {
      setTimeout(() => {
        for (const ev of store) {
          if (filter.kinds && !filter.kinds.includes(ev.kind)) continue;
          if (filter.authors && !filter.authors.includes(ev.pubkey)) continue;
          if (filter["#d"] && !(ev.tags ?? []).some((t: string[]) => t[0] === "d" && filter["#d"].includes(t[1]))) continue;
          if (filter["#t"] && !(ev.tags ?? []).some((t: string[]) => t[0] === "t" && filter["#t"].includes(t[1]))) continue;
          handlers.onevent(ev);
        }
        handlers.oneose?.();
      }, 0);
      return { close() {} };
    },
  };
}

const ORDER = {
  id: "b6c61954-935d-4dcb-b8a5-5463e402da31",
  venue_slug: "three-buddies-berlin",
  state: "paid",
  subtotal: 1500,
  fee: 120,
  total: 1620,
  items: [{ sku: "1052466", name: "Capri Sun Kirsche 0,2l", qty: 1, line_total_sats: 1500 }],
  inputs: { "contact.phone": "+491700000000" },
};

Deno.test("nip07 sign-in records the identity; sign-out clears it", async () => {
  const storage = fakeStorage();
  const win = {
    nostr: {
      async getPublicKey() {
        return "b".repeat(64);
      },
      async signEvent(t: any) {
        return { ...t, pubkey: "b".repeat(64), id: "f".repeat(64), sig: "0".repeat(128) };
      },
      nip44: {
        async encrypt() {
          return "cipher";
        },
        async decrypt() {
          return "{}";
        },
      },
    },
  };
  const signer = await signIn({ storage, win });
  assertEquals(signer.pubkey, "b".repeat(64));
  assertEquals(signer.method, "nip07");
  assertEquals(currentIdentity(storage)!.pubkey, "b".repeat(64));
  assertEquals(currentIdentity(storage)!.canEncryptDetail, true);

  signOut(storage);
  assertEquals(currentIdentity(storage), null);
});

Deno.test("a NIP-07 provider WITHOUT nip44 still signs in, and says so", async () => {
  const storage = fakeStorage();
  const win = {
    nostr: {
      async getPublicKey() {
        return "c".repeat(64);
      },
      async signEvent(t: any) {
        return { ...t, pubkey: "c".repeat(64), id: "f".repeat(64), sig: "0".repeat(128) };
      },
    },
  };
  const signer = await signIn({ storage, win });
  assertEquals(currentIdentity(storage)!.canEncryptDetail, false);
  await saveOrder(signer, ORDER); // must not throw just because detail cannot be encrypted
});

Deno.test("sign-in refuses a malformed pubkey from the provider", async () => {
  const win = { nostr: { async getPublicKey() { return "short"; }, async signEvent() {} } };
  let threw = false;
  try {
    await signIn({ storage: fakeStorage(), win });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("saveOrder publishes a public receipt AND an encrypted detail", async () => {
  const pool = fakePool();
  __setPool(pool);
  const signer = makeLocalSigner(new Uint8Array(32).fill(7));

  const out = await saveOrder(signer, ORDER);

  assertEquals(out.detail_saved, true);
  assertEquals(out.relays_ok, out.relays_total);
  const kinds = pool.store.map((e) => e.kind).sort();
  assertEquals(kinds.includes(RECEIPT_KIND), true);
  assertEquals(kinds.includes(DETAIL_KIND), true);
  // The encrypted event must not carry the item name in clear.
  const detail = pool.store.find((e) => e.kind === DETAIL_KIND);
  assertEquals(JSON.stringify(detail).toLowerCase().includes("capri"), false);
});

Deno.test("a NEW DEVICE recovers the order list from relays alone (no local state)", async () => {
  const pool = fakePool();
  __setPool(pool);
  const signer = makeLocalSigner(new Uint8Array(32).fill(7));
  await saveOrder(signer, ORDER);

  // Simulate the new device: nothing local, just the pubkey.
  const orders = await loadOrders(signer.pubkey, { decrypt: false });
  assertEquals(orders.length, 1);
  assertEquals(orders[0].order_id, ORDER.id);
  assertEquals(orders[0].state, "paid");
  assertEquals(orders[0].total, 1620);
});

Deno.test("with decrypt, the recovered order carries its items back", async () => {
  const pool = fakePool();
  __setPool(pool);
  const signer = makeLocalSigner(new Uint8Array(32).fill(7));
  await saveOrder(signer, ORDER);

  const orders = await loadOrders(signer.pubkey, { decrypt: true, signer });
  assertEquals(orders[0].detail.items[0].name, "Capri Sun Kirsche 0,2l");
});

Deno.test("another customer's orders are never returned", async () => {
  const pool = fakePool();
  __setPool(pool);
  const mine = makeLocalSigner(new Uint8Array(32).fill(7));
  const theirs = makeLocalSigner(new Uint8Array(32).fill(9));
  await saveOrder(mine, ORDER);

  const leaked = await loadOrders(theirs.pubkey, { decrypt: true, signer: theirs });
  assertEquals(leaked, []);
});
