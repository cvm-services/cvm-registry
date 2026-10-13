import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchDetail, fetchReceipts, publishOrderRecords } from "../site/render/order_relay.js";
import { DETAIL_KIND, RECEIPT_KIND, orderKey } from "../site/render/order_records.js";

const PK = "a".repeat(64);

/** A pool that records calls and replays canned events, with no network. */
function fakePool(events: any[] = [], { failUrls = [] }: { failUrls?: string[] } = {}) {
  const published: Array<{ url: string; id: string; kind: number }> = [];
  const seenFilters: Array<{ urls: string[]; filter: any }> = [];
  return {
    published,
    seenFilters,
    async publish(url: string, ev: any) {
      if (failUrls.includes(url)) throw new Error("relay down");
      published.push({ url, id: ev.id, kind: ev.kind });
      return "ok";
    },
    subscribeMany(urls: string[], filter: any, handlers: any) {
      seenFilters.push({ urls, filter });
      setTimeout(() => {
        for (const ev of events) handlers.onevent(ev);
        handlers.oneose?.();
      }, 0);
      return { close() {} };
    },
  };
}

Deno.test("publishOrderRecords survives one relay being down", async () => {
  const pool = fakePool([], { failUrls: ["wss://relay.primal.net"] });
  const out = await publishOrderRecords(pool, ["wss://relay2.orangesync.tech", "wss://relay.primal.net"], {
    receipt: { id: "r1", kind: RECEIPT_KIND },
    detail: { id: "d1", kind: DETAIL_KIND },
  });
  assertEquals(out.relays_ok, 1);
  assertEquals(out.relays_total, 2);
  assertEquals(pool.published.length, 2, "both records went to the relay that was up");
});

Deno.test("fetchReceipts queries the customer's own records and returns them newest first", async () => {
  const mk = (order: string, at: number) => ({
    kind: RECEIPT_KIND,
    pubkey: PK,
    created_at: at,
    content: "",
    tags: [["d", orderKey(order)], ["t", "cvm-order"], ["state", "paid"], ["total", "1620"]],
  });
  const events = [mk("old", 100), mk("new", 300), mk("mid", 200)];
  const pool = fakePool(events);

  const out = await fetchReceipts(pool, ["wss://relay2.orangesync.tech"], PK);

  assertEquals(out.map((r) => r.order_id), ["new", "mid", "old"]);
  const f = pool.seenFilters[0].filter;
  assertEquals(f.authors, [PK], "must never query another customer's records");
  assertEquals(f.kinds, [RECEIPT_KIND]);
});

Deno.test("a relay re-serving an OLDER version of the same address never wins", async () => {
  const mk = (at: number, state: string, tags: string[][] = []) => ({
    kind: RECEIPT_KIND,
    pubkey: PK,
    created_at: at,
    content: "",
    tags: [["d", orderKey("o1")], ["t", "cvm-order"], ["state", state], ...tags],
  });
  // Out of order on purpose: newest first, then a stale replay.
  const pool = fakePool([mk(300, "placed"), mk(100, "paid")]);
  const out = await fetchReceipts(pool, ["wss://x"], PK);
  assertEquals(out.length, 1, "one address = one record");
  assertEquals(out[0].state, "placed", "the newest version wins regardless of arrival order");
});

Deno.test("fetchReceipts ignores foreign receipts and unaddressable events", async () => {
  const pool = fakePool([
    { kind: 1, pubkey: PK, created_at: 1, content: "", tags: [["d", orderKey("x")]] },
    { kind: RECEIPT_KIND, pubkey: PK, created_at: 1, content: "", tags: [["d", "other:1"]] },
  ]);
  assertEquals(await fetchReceipts(pool, ["wss://x"], PK), []);
});

Deno.test("fetchDetail returns the newest ciphertext for one order", async () => {
  const d = orderKey("o1");
  const pool = fakePool([
    { kind: DETAIL_KIND, pubkey: PK, created_at: 50, content: "old", tags: [["d", d]] },
    { kind: DETAIL_KIND, pubkey: PK, created_at: 90, content: "new", tags: [["d", d]] },
  ]);
  const ev = (await fetchDetail(pool, ["wss://x"], PK, "o1"))!;
  assertEquals(ev.content, "new");
  assertEquals(pool.seenFilters[0].filter["#d"], [d]);
});

Deno.test("a dead relay is a timeout, not a hang or a throw", async () => {
  const dead = { publish: async () => {}, subscribeMany() { return { close() {} }; } } as any;
  const t0 = Date.now();
  const out = await fetchReceipts(dead, ["wss://x"], PK, { timeoutMs: 60 });
  assertEquals(out, []);
  assertEquals(Date.now() - t0 < 3000, true, "must resolve on the timeout, not hang");
});
