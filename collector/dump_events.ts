/**
 * dump_events.ts — capture raw CEP-6 events as NDJSON.
 *
 *   deno run --allow-net --allow-write collector/dump_events.ts \
 *     --relays wss://relay.damus.io --out fixtures/real-events.ndjson
 *
 * Why: it makes a collection reproducible offline. `collect.ts --input <file>`
 * replays exactly what a relay served, so a classification change can be tested
 * against real announcements without depending on the relay being up (or on the
 * announcement still existing). The dump is raw and unmodified — no rewriting.
 */
import { fetchRelay } from "./collect.ts";
import { KINDS, type NostrEvent } from "./lib.ts";

function arg(name: string, dflt: string): string {
  const i = Deno.args.indexOf(name);
  return i >= 0 && Deno.args[i + 1] ? Deno.args[i + 1] : dflt;
}

const relays = arg("--relays", "wss://relay.damus.io").split(",").map((s) => s.trim()).filter(Boolean);
const out = arg("--out", "fixtures/real-events.ndjson");
const timeoutMs = Number(arg("--timeout-ms", "45000"));

const seen = new Set<string>();
const lines: string[] = [];
for (const relay of relays) {
  const { events, status } = await fetchRelay(relay, KINDS, 2000, timeoutMs);
  console.error(`# ${relay} ok=${status.ok} events=${status.events}${status.error ? " error=" + status.error : ""}`);
  for (const e of events) {
    if (!e?.id || seen.has(e.id)) continue;
    seen.add(e.id);
    lines.push(JSON.stringify(e));
  }
}

await Deno.mkdir(out.replace(/\/[^/]+$/, ""), { recursive: true }).catch(() => {});
await Deno.writeTextFile(out, lines.join("\n") + (lines.length ? "\n" : ""));
console.error(`# wrote ${lines.length} unique events -> ${out}`);
