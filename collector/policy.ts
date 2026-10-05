/**
 * policy.ts — the freshness state machine behind "stale disables".
 *
 * ADR-0001 D6: "Stale must disable, never silently show old state as live."
 * The registry's reading of that rule is explicit and tested:
 *
 *   fresh    age <= fresh_ttl   entries may be presented as current
 *   stale    fresh_ttl < age <= max_age
 *                               entries are shown ONLY as a labelled cached
 *                               snapshot; every live claim is disabled
 *   expired  age > max_age      catalog DISABLED, nothing rendered
 *   invalid  no/unparseable/future generated_at
 *                               catalog DISABLED (fail closed)
 *
 * The collector publishes generated_at and copies policy.json in verbatim, so
 * the client needs no separate configuration and cannot drift from the builder.
 */

export interface FreshnessPolicy {
  fresh_ttl_seconds: number;
  max_age_seconds: number;
  clock_skew_seconds?: number;
}

export type CacheState = "fresh" | "stale" | "expired" | "invalid";

export interface StateVerdict {
  state: CacheState;
  age_seconds: number | null;
  reason: string;
}

export interface RenderDecision {
  renderEntries: boolean;
  disabled: boolean;
  banner: string | null;
  /** true ONLY in the fresh state: the page may claim the data is current */
  live_claims: boolean;
}

export const DEFAULT_POLICY: FreshnessPolicy = {
  fresh_ttl_seconds: 900,
  max_age_seconds: 21600,
  clock_skew_seconds: 120,
};

export function cacheState(
  generatedAt: number | null | undefined,
  nowSeconds: number,
  policy: FreshnessPolicy = DEFAULT_POLICY,
): StateVerdict {
  const skew = policy.clock_skew_seconds ?? DEFAULT_POLICY.clock_skew_seconds!;
  if (
    generatedAt === null || generatedAt === undefined ||
    !Number.isFinite(generatedAt) || generatedAt <= 0
  ) {
    return { state: "invalid", age_seconds: null, reason: "generated_at is missing or unparseable" };
  }
  if (generatedAt > nowSeconds + skew) {
    return {
      state: "invalid",
      age_seconds: null,
      reason: `generated_at is future-dated by ${Math.round(generatedAt - nowSeconds)}s (clock skew limit ${skew}s)`,
    };
  }
  const age = Math.max(0, Math.round(nowSeconds - generatedAt));
  if (age <= policy.fresh_ttl_seconds) {
    return { state: "fresh", age_seconds: age, reason: `cache is ${age}s old (ttl ${policy.fresh_ttl_seconds}s)` };
  }
  if (age <= policy.max_age_seconds) {
    return { state: "stale", age_seconds: age, reason: `cache is ${age}s old, older than the ${policy.fresh_ttl_seconds}s freshness ttl` };
  }
  return { state: "expired", age_seconds: age, reason: `cache is ${age}s old, past the ${policy.max_age_seconds}s hard limit` };
}

export function humanAge(seconds: number | null): string {
  if (seconds === null) return "unknown";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m ? `${h}h${m}m` : `${h}h`;
}

export function renderDecision(v: StateVerdict): RenderDecision {
  switch (v.state) {
    case "fresh":
      return { renderEntries: true, disabled: false, banner: null, live_claims: true };
    case "stale":
      return {
        renderEntries: true,
        disabled: false,
        banner:
          `STALE CACHE — ${v.reason}. Showing a cached snapshot only; nothing here is live. ` +
          `Entries are disabled for any live use.`,
        live_claims: false,
      };
    case "expired":
      return {
        renderEntries: false,
        disabled: true,
        banner: `CACHE EXPIRED — ${v.reason}. The catalog is disabled until the collector runs again.`,
        live_claims: false,
      };
    case "invalid":
      return {
        renderEntries: false,
        disabled: true,
        banner: `CACHE UNAVAILABLE — ${v.reason}. The catalog is disabled (fail closed).`,
        live_claims: false,
      };
  }
}
