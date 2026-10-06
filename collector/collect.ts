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
  checkServiceLinks,
  classify,
  dedupe,
  groupServices,
  KINDS,
  linkCheckTally,
  type LinkCheckPolicy,
  type NostrEvent,
  parseCurators,
  type Vocab,
} from "./lib.ts";

interface Args {
  relays: string[];
  out: string;
  allowlist: string;
  vocab: string;
  policy: string;
  input: string | null;
  /** false disables the cache-time HEAD check on declared URLs (offline runs, tests) */
  linkCheck: boolean;
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
    linkCheck: true,
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
      case "--no-link-check": a.linkCheck = false; break;
      case "--link-check": a.linkCheck = true; break;
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
      args.relays.map((r) => fetchRelay(r, KINDS, args.limit, args.timeoutMs)),
    );
    for (const r of results) {
      events = events.concat(r.events);
      relayStatus.push(r.status);
    }
  }

  const raw = events.length;
  const deduped = dedupe(events);
  const { kept, dropped } = applyAllowList(deduped, allow.hex);
  const entries = kept.map((e) => classify(e, vocab)).sort((a, b) =>
    a.kind - b.kind || a.pubkey.localeCompare(b.pubkey) || a.d.localeCompare(b.d)
  );

  const tally: Record<string, number> = {};
  for (const e of entries) for (const c of e.classes) tally[c] = (tally[c] ?? 0) + 1;

  // CEP-6 kinds 11316-11320 are FACETS of one service, so the announcement list
  // is collapsed on (pubkey, d) before it reaches the page: one card per service,
  // and "announcements" and "services" are counted apart so neither number lies.
  const services = groupServices(entries);

  // Cache-time link check: did each service's DECLARED url answer? One outbound
  // HEAD per service (bounded), recorded as data on the cache. Not a per-service
  // CVM call, not a relay connection — the page itself still makes no requests.
  const lcRaw = (policy as { link_check?: Partial<LinkCheckPolicy> }).link_check ?? {};
  const linkCheck: LinkCheckPolicy = {
    enabled: args.linkCheck && (lcRaw.enabled ?? true),
    timeoutMs: Math.max(250, Number(lcRaw.timeoutMs ?? 5000)),
    maxUrls: Math.max(0, Number(lcRaw.maxUrls ?? 50)),
  };
  await checkServiceLinks(services, linkCheck);
  const linkTally = linkCheckTally(services);

  const catalog = {
    generated_at: generatedAt,
    generated_at_iso: new Date(generatedAt * 1000).toISOString(),
    collector: {
      version: 1,
      kinds: KINDS,
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
      services_kept: services.length,
      dropped_not_allowlisted: dropped.length,
    },
    class_tally: tally,
    link_check: { ...linkCheck, ...linkTally },
    // Every entry here is from an allow-listed curator. Nothing was fetched per
    // service: the only outbound requests are the collector's own HEAD checks on
    // URLs a provider DECLARED, recorded here as data (ADR-0001 D7).
    entries,
    // The same data grouped into services — what the page renders, one card each.
    services,
  };

  await Deno.mkdir(args.out.replace(/\/[^/]+$/, ""), { recursive: true }).catch(() => {});
  await Deno.writeTextFile(args.out, JSON.stringify(catalog, null, 2) + "\n");

  const errs = relayStatus.filter((s) => !s.ok).map((s) => s.relay);
  console.log(
    `catalog: raw=${raw} deduped=${deduped.length} kept=${kept.length} ` +
      `services=${services.length} dropped=${dropped.length} ` +
      `links: checked=${linkTally.checked} unreachable=${linkTally.unreachable} ` +
      `not_checked=${linkTally.not_checked} no_url=${linkTally.no_url} ` +
      `relays_failed=${errs.length ? errs.join(" ") : "none"} -> ${args.out}`,
  );
  if (allow.errors.length) console.error("allow-list errors: " + allow.errors.join("; "));
}

if (import.meta.main) await main();
