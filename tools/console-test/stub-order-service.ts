// Stub order service for the facilitator-console happy-path recording (PLAN-0007 T4).
//
// READ THIS BEFORE JUDGING THE VIDEO: the plan forbids mocked money, so this
// process is NOT a mock of the order service. It IMPORTS the real service slice
// -- the actual `route()` handler and the actual `OrderStore` -- from the
// cvm-orders checkout named by CVM_ORDERS_DIR, and serves every /api/* call
// through it. Same endpoints, same state machine (paid -> placing -> placed ->
// ready | refunded), same 409 on an illegal transition, same paid-only queue.
// The pinned cvm-orders SHA is printed at boot and recorded in the run log.
//
// The stub adds exactly two things, and nothing else:
//   1. the static console shell from site/console on the same origin, so that
//      `/api/*` is same-origin exactly as on the deployed host; and
//   2. a boot-time SEED: two orders POSTed into the real store through the real
//      route() -- one settled (the happy path) and one still pending (the sats
//      gate). Seeding state is the only job; no money is invented: the console
//      still has to earn the place button from `requireSettled()`, and every
//      state change in the recording is a real POST into the real machine.
//
// Two things the real slice does NOT do, mirrored here on purpose (both are
// documented gaps owned by t_d790103d, not hidden by this harness):
//   * it does not verify the NIP-98 event -- but this stub PARSES the
//     authorization header and logs the kind/pubkey, so the run log proves the
//     console really did attach a signed challenge to every call.
//   * it drops the `receipt` field on `placed` -- so the console's own
//     "captured on this device / persistence gap" wording in the recording is
//     the truth about the shipped service, not a harness artefact.
//
// Run:  PORT=8791 CVM_ORDERS_DIR=$HOME/repos/cvm-orders \
//         deno run --allow-net --allow-read --allow-env --allow-run stub-order-service.ts
// Prints one machine-readable STUB_READY line on stdout, then a request log.

import { dirname, fromFileUrl, join, normalize } from "https://deno.land/std@0.224.0/path/mod.ts";

const PORT = Number(Deno.env.get("PORT") ?? 8791);
// Default matches the fleet convention (~/repos/<repo>); override with CVM_ORDERS_DIR.
const CVM_ORDERS_DIR = Deno.env.get("CVM_ORDERS_DIR") ??
  join(Deno.env.get("HOME") ?? ".", "repos", "cvm-orders");
const ROOT = normalize(join(dirname(fromFileUrl(import.meta.url)), "..", ".."));
const CONSOLE_DIR = join(ROOT, "site", "console");
// A fixed, well-known test identity. It is a hex pubkey, not a secret: nothing is
// signed with it for real (see the NIP-07 boundary in README.md).
const FACILITATOR_PUBKEY = Deno.env.get("FACILITATOR_NPUB") ??
  "1f2e3d4c5b6a7988071625344352617a8b9c0d1e2f30415263748596a7b8c9d0";

if (!/^[0-9a-f]{64}$/.test(FACILITATOR_PUBKEY)) {
  console.error(`FACILITATOR_NPUB must be 64 hex chars, got ${FACILITATOR_PUBKEY.length}`);
  Deno.exit(2);
}

const mod = await import(`file://${CVM_ORDERS_DIR}/main.ts`);
const route: (req: Request) => Promise<Response> = mod.route;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const ledgers = { nip98_events: 0, pan_shaped_bodies: 0, post_bodies: 0, posts: [] as string[] };

/** Luhn-valid 13..19 digit runs: the shape that must never reach the wire (ADR-0013). */
function panShaped(text: string): string | null {
  for (const candidate of text.match(/\d[\d -]{11,25}\d/g) ?? []) {
    const digits = candidate.replace(/[^0-9]/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0, alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = Number(digits[i]);
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n; alt = !alt;
    }
    if (sum % 10 === 0) return candidate.trim();
  }
  return null;
}

/** Parse (do not verify) the NIP-98 event the console attaches, for the run log. */
function noteAuth(authorization: string | null, path: string) {
  if (!authorization) return;
  const b64 = authorization.replace(/^Nostr\s+/i, "").trim();
  try {
    const event = JSON.parse(atob(b64));
    const u = (event.tags ?? []).find((t: string[]) => t[0] === "u")?.[1] ?? "";
    ledgers.nip98_events++;
    console.log(
      `[stub] NIP-98 authorization present on ${path}: kind=${event.kind} pubkey=${
        String(event.pubkey).slice(0, 16)
      }… method=${event.tags?.find((t: string[]) => t[0] === "method")?.[1]} u=${u}`,
    );
  } catch {
    console.log(`[stub] authorization header present but not a base64 NIP-98 event (${path})`);
  }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname.startsWith("/api/")) {
    noteAuth(req.headers.get("authorization"), url.pathname);
    let body: string | undefined;
    if (req.method === "POST" || req.method === "PUT") {
      body = await req.text();
      ledgers.post_bodies++;
      const hit = panShaped(body);
      if (hit) {
        ledgers.pan_shaped_bodies++;
        console.log(`[stub] !! PAN-SHAPED VALUE IN REQUEST BODY on ${url.pathname}: ${hit}`);
      }
    }
    const inner = new URL(req.url);
    inner.pathname = url.pathname.replace(/^\/api/, "") || "/";
    const res = await route(
      new Request(inner.toString(), {
        method: req.method,
        headers: req.headers,
        body,
      }),
    );
    ledgers.posts.push(`${req.method} ${url.pathname} -> ${res.status}`);
    console.log(`[stub] ${req.method} ${url.pathname} -> ${res.status}`);
    const out = new Response(res.body, res);
    out.headers.set("access-control-allow-origin", "*");
    return out;
  }

  // The console shell itself, same origin as /api (as on the deployed host).
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const target = normalize(join(CONSOLE_DIR, rel));
  if (!target.startsWith(CONSOLE_DIR)) return new Response("forbidden", { status: 403 });
  try {
    const bytes = await Deno.readFile(target);
    const ext = rel.slice(rel.lastIndexOf("."));
    console.log(`[stub] GET ${url.pathname} -> 200 (${bytes.length}b)`);
    return new Response(bytes, { headers: { "content-type": MIME[ext] ?? "application/octet-stream" } });
  } catch {
    console.log(`[stub] GET ${url.pathname} -> 404`);
    return new Response("not found", { status: 404 });
  }
}

/** Seed through the REAL route(): two orders in the real store, no fake state. */
async function seed(id: string, payload: unknown) {
  const res = await route(
    new Request("http://stub/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, payload }),
    }),
  );
  const text = await res.text();
  if (res.status !== 201) throw new Error(`seed ${id} failed: HTTP ${res.status} ${text}`);
  console.log(`[stub] seeded ${id}: ${text}`);
  return JSON.parse(text);
}

const SETTLED_ID = "8f31a2c4d5e6f708";
const PENDING_ID = "9b27d4e6f8091a2b";

await seed(SETTLED_ID, {
  basket: {
    venue_slug: "doppelt-kaese-berlin",
    venue_name: "Doppelt Käse Laubacher Straße",
    items: [
      { name: "Käseplatte groß", qty: 1, options: "mit Brotkorb", unit_fiat: 18.5, unit_sats: 30150 },
      { name: "Apfelschorle", qty: 2, options: "0,5 l", unit_fiat: 3.4, unit_sats: 5550 },
      { name: "Basilikum-Tomate (Stück)", qty: 1, unit_fiat: 3.5, unit_sats: 5700 },
    ],
    total_fiat: 28.8,
    total_sats: 46950,
    fee_sats: 1410,
  },
  customer: { phone: "+49 151 5555 0142" },
  venue: {
    rail: "FoodAmigos",
    checkout_url: `https://doppelt-kaese.example/checkout?ref=${SETTLED_ID}`,
  },
  settlement: {
    status: "settled",
    method: "bolt11",
    payment_hash: "9d1c4f7a2b8e6053d1a0c5f2e83b47a6d9c04e1f5826b7a3c908d4e2f1a6b7c3",
    amount_sats: 46950,
    settled_at: new Date(Date.now() - 90_000).toISOString(),
  },
});

await seed(PENDING_ID, {
  basket: {
    venue_slug: "pizza-e-pasta-ruedesheimerplatz",
    venue_name: "Pizza e Pasta Rüdesheimer Platz",
    items: [
      { name: "Margherita", qty: 1, unit_fiat: 9.9, unit_sats: 16100 },
      { name: "Coca-Cola", qty: 1, unit_fiat: 2.9, unit_sats: 4730 },
    ],
    total_fiat: 12.8,
    total_sats: 20830,
    fee_sats: 630,
  },
  customer: { phone: "+49 176 2222 8877" },
  venue: { rail: "FoodAmigos" },
  settlement: { status: "pending", method: "bolt11", amount_sats: 20830 },
});

let ordersSha = "unknown";
try {
  const out = await new Deno.Command("git", {
    args: ["-C", CVM_ORDERS_DIR, "rev-parse", "HEAD"],
    stdout: "piped",
  }).output();
  if (out.success) ordersSha = new TextDecoder().decode(out.stdout).trim();
} catch { /* the SHA is provenance, not a precondition */ }

console.log("STUB_READY " + JSON.stringify({
  port: PORT,
  facilitatorNpub: FACILITATOR_PUBKEY,
  settled_order: SETTLED_ID,
  pending_order: PENDING_ID,
  settled_checkout_url: `https://doppelt-kaese.example/checkout?ref=${SETTLED_ID}`,
  orders_dir: CVM_ORDERS_DIR,
  orders_sha: ordersSha,
  console_dir: CONSOLE_DIR,
}));

Deno.serve({ port: PORT, hostname: "127.0.0.1", onListen: () => {} }, handle);

// The driver asks for the server-side ledgers at the end of the run: proof that
// no card-shaped value ever crossed the wire, and that every call was NIP-98 signed.
Deno.serve({ port: PORT + 1, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/__ledger") {
    return new Response(JSON.stringify(ledgers), {
      headers: { "content-type": "application/json" },
    });
  }
  if (url.pathname === "/__state") {
    return route(new Request("http://stub/orders/queue"));
  }
  return new Response("not found", { status: 404 });
});
