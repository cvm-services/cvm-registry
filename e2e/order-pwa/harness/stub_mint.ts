/**
 * stub_mint.ts — a tiny NUT-04 (mint quote) HTTP server on Deno, backed by
 * nothing. It exists so the happy-path E2E can settle an invoice on demand
 * instead of paying real sats.
 *
 * It remembers quotes in memory, and its test-only routes (/__test/*) are how
 * the spec forces a settlement or an expiry. Everything outside /v1/* and
 * /__test/* is 404.
 *
 * Run by e2e/order-pwa/harness/stack.mjs, not by hand.
 */
import { encodeBolt11 } from "./bolt11.ts";

type State = "UNPAID" | "PAID";

interface Quote {
  quote: string;
  request: string;
  amount: number;
  unit: "sat";
  state: State;
  expiry: number;
  /**
   * How many times GET /v1/mint/quote/bolt11/<id> was asked for this quote.
   * The spec reads this to prove a second status poll really asked the rail
   * again (and still did not re-transition the order).
   */
  checks: number;
}

const quotes = new Map<string, Quote>();
const port = Number(Deno.env.get("STUB_MINT_PORT") ?? "0");
const hostname = Deno.env.get("STUB_MINT_HOST") ?? "127.0.0.1";
const QUOTE_TTL_SECONDS = Number(Deno.env.get("STUB_MINT_TTL_SECONDS") ?? "900");

const now = (): number => Math.floor(Date.now() / 1000);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const randomHex = (bytes: number): string => {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("");
};

function createQuote(amount: number): Quote {
  const quote: Quote = {
    quote: crypto.randomUUID(),
    request: encodeBolt11({
      sats: amount,
      paymentHash: randomHex(32),
      description: "cvm-orders stub mint — NOT PAYABLE, do not send sats",
      expirySeconds: QUOTE_TTL_SECONDS,
      createdAt: now(),
      // 65 bytes of noise. Cassette's bolt11 decoder only needs a well-formed
      // 104-word signature blob; it never verifies a signature.
      signature: crypto.getRandomValues(new Uint8Array(65)),
    }),
    amount,
    unit: "sat",
    state: "UNPAID",
    expiry: now() + QUOTE_TTL_SECONDS,
    checks: 0,
  };
  quotes.set(quote.quote, quote);
  return quote;
}

/** CashuRail only reads `request`, and the service refuses a non-string. */
function quoteBody(quote: Quote) {
  return {
    quote: quote.quote,
    request: quote.request,
    state: quote.state,
    expiry: quote.expiry,
    amount: quote.amount,
    unit: quote.unit,
  };
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // --- the bits of NUT-04 a wallet (or our rail) touches --------------------
  if (req.method === "GET" && path === "/v1/info") {
    return json({
      version: "stub-mint/0.1.0",
      nuts: {
        4: {
          methods: [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: 100_000_000 }],
        },
        5: { methods: [{ method: "bolt11", unit: "sat", min_amount: 1 }] },
      },
    });
  }
  if (req.method === "GET" && (path === "/v1/keys" || path === "/v1/keysets")) {
    // Shape only. This mint never issues ecash.
    return json({ keysets: [{ id: "00stub", unit: "sat", keys: {} }] });
  }

  if (req.method === "POST" && path === "/v1/mint/quote/bolt11") {
    const body = (await req.json().catch(() => ({}))) as { amount?: unknown; unit?: unknown };
    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      return json({ detail: "amount must be a positive integer of sats" }, 400);
    }
    if (body.unit !== undefined && body.unit !== "sat") {
      return json({ detail: `unsupported unit ${String(body.unit)}` }, 400);
    }
    return json(quoteBody(createQuote(amount)), 201);
  }

  const quotePath = /^\/v1\/mint\/quote\/bolt11\/([0-9a-fA-F-]{36})$/.exec(path);
  if (req.method === "GET" && quotePath) {
    const quote = quotes.get(quotePath[1]);
    if (!quote) return json({ detail: "quote not found" }, 404);
    quote.checks += 1;
    return json(quoteBody(quote));
  }

  // --- test-only control surface -------------------------------------------
  if (req.method === "GET" && path === "/__test/health") {
    return json({ ok: true, quotes: quotes.size });
  }
  if (req.method === "GET" && path === "/__test/quotes") {
    return json(Array.from(quotes.values()).map((q) => ({ ...q, request: q.request })));
  }
  const settle = /^\/__test\/settle\/([0-9a-fA-F-]{36})$/.exec(path);
  if (req.method === "POST" && settle) {
    const quote = quotes.get(settle[1]);
    if (!quote) return json({ detail: "quote not found" }, 404);
    quote.state = "PAID";
    return json({ quote: quote.quote, state: quote.state });
  }
  const expire = /^\/__test\/expire\/([0-9a-fA-F-]{36})$/.exec(path);
  if (req.method === "POST" && expire) {
    const quote = quotes.get(expire[1]);
    if (!quote) return json({ detail: "quote not found" }, 404);
    quote.expiry = now() - 1;
    return json({ quote: quote.quote, state: quote.state, expiry: quote.expiry });
  }

  return json({ detail: `not found: ${req.method} ${path}` }, 404);
}

Deno.serve(
  {
    hostname,
    port,
    onListen: ({ hostname: bound, port: boundPort }) => {
      // stack.mjs waits for this line before starting the service.
      console.log(`STUB_MINT_READY http://${bound}:${boundPort}`);
    },
  },
  handler,
);
