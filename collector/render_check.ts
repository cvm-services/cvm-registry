/**
 * render_check.ts — the oracle used as evidence.
 *
 * Loads the built catalog exactly like the page does and prints what the
 * dashboard will show: the freshness verdict, the allow-list count, the visible
 * entries and the rendered/per-disabled decision. Run it against the real
 * catalog and against a hand-made stale one; the output is the proof that
 * "stale disables" is a behaviour, not a comment.
 *
 *   deno run --allow-read collector/render_check.ts --catalog site/catalog.json
 *   deno run --allow-read collector/render_check.ts --catalog site/catalog.json --now 1800000000
 */
import { cacheState, humanAge, renderDecision } from "./policy.ts";
import type { Classified } from "./lib.ts";

interface Catalog {
  generated_at: number | null;
  generated_at_iso?: string;
  policy?: { freshness?: { fresh_ttl_seconds: number; max_age_seconds: number; clock_skew_seconds?: number } };
  allowlist?: { curators?: { npub: string }[]; pubkeys?: string[] };
  counts?: Record<string, number>;
  entries?: Classified[];
}

function arg(name: string, dflt: string | null): string | null {
  const i = Deno.args.indexOf(name);
  return i >= 0 && Deno.args[i + 1] ? Deno.args[i + 1] : dflt;
}

const path = arg("--catalog", "site/catalog.json")!;
const nowArg = arg("--now", null);
const now = nowArg ? Number(nowArg) : Math.floor(Date.now() / 1000);

const catalog: Catalog = JSON.parse(await Deno.readTextFile(path));
const policy = catalog.policy?.freshness ??
  { fresh_ttl_seconds: 900, max_age_seconds: 21600, clock_skew_seconds: 120 };

const verdict = cacheState(catalog.generated_at, now, policy);
const decision = renderDecision(verdict);
const allow = new Set((catalog.allowlist?.curators ?? []).map((c) => c.npub));
const entries = catalog.entries ?? [];

// the same re-check the page performs
const allowed = entries.filter((e) => allow.has(e.npub));
const notAllowListed = allowed.filter((e) => !allow.has(e.npub));

console.log(`catalog            ${path}`);
console.log(`generated_at       ${catalog.generated_at} (${catalog.generated_at_iso ?? "?"})`);
console.log(`now                ${now}`);
console.log(`cache state        ${verdict.state} — ${verdict.reason}`);
console.log(`live claims        ${decision.live_claims}`);
console.log(`render entries     ${decision.renderEntries}`);
console.log(`disabled           ${decision.disabled}`);
console.log(`banner             ${decision.banner ?? "(none)"}`);
console.log(`curators           ${allow.size}`);
console.log(`entries in cache   ${entries.length}`);
console.log(`after allow-check  ${allowed.length}`);
console.log(`dropped client-side ${notAllowListed.length}`);

if (!decision.renderEntries) {
  console.log("");
  console.log("RENDERED: (nothing — catalog disabled)");
  Deno.exit(0);
}

console.log("");
console.log(`RENDERED: ${allowed.length} entr${allowed.length === 1 ? "y" : "ies"}` +
  (decision.live_claims ? " as LIVE" : " as a CACHED SNAPSHOT (not live)"));
for (const e of allowed) {
  const t = e.tier.recomputed ?? "unclassified";
  const req = e.requirements.unclassified
    ? "unclassified"
    : `req=[${e.requirements.required.join(",")}] opt=[${e.requirements.optional.join(",")}]` +
      (e.requirements.unknown.length ? ` UNKNOWN=[${e.requirements.unknown.join(",")}]` : "");
  console.log(`  - kind ${e.kind} ${e.name ?? e.d ?? "(unnamed)"} | tier ${t}` +
    `${e.tier.mismatch ? " (MISMATCH)" : ""} | ${req} | age ${humanAge(now - e.created_at)}`);
}
