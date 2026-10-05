/**
 * lib.ts — pure, dependency-free logic for the cvm-registry collector.
 *
 * Everything here is deliberately side-effect free so it can be unit-tested
 * without a relay, a browser or a clock. The rules it implements come from
 * contextvm-services: docs/adr/0001-discovery-and-trust.md (D2/D3/D6/D12a/D14)
 * and docs/spec/service-inputs.md (the tier tag + input register).
 *
 * No npm, no Deno third-party imports: Deno stdlib / language only.
 */

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface VocabField {
  tier: string;
  type?: string;
  values?: string[];
  note?: string;
}

export interface Vocab {
  version?: number;
  tiers: Record<string, string>;
  tier_tag?: { ranks: Record<string, number> };
  fields: Record<string, VocabField>;
}

/** CEP-6 discovery kinds. */
export const KINDS: number[] = [11316, 11317, 11318, 11319, 11320];

/** Ladder used only as an upper bound for filtering (never a juridical claim). */
export const TIER_RANKS: Record<string, number> = {
  none: 0,
  financial: 1,
  contact: 2,
  fulfilment: 3,
  legal: 4,
  sensitive: 5,
};

export const CLASS_PREFIX = "cvm:service:";
export const REQ_PREFIX = "cvm:req:";
export const OPT_PREFIX = "cvm:opt:";
export const TIER_PREFIX = "cvm:tier:";

/** Tier shorthand a user control may offer (vocab.filter_shorthand). */
export const TIER_SHORTHAND: Record<string, string[]> = {
  "no_personal_data": ["none", "financial"],
  "contact_only": ["none", "financial", "contact"],
};

/** Non-tag keys NIP-01 allows in a REQ filter. Everything else must be a single-letter tag. */
export const FILTER_KEYS = new Set([
  "ids",
  "authors",
  "kinds",
  "since",
  "until",
  "limit",
  "search",
]);

// --------------------------------------------------------------------------
// bech32 (BIP-173) — enough for npub <-> hex. Needed because the allow-list is
// npubs (what a human checks) and events carry hex pubkeys.
// --------------------------------------------------------------------------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(
  data: number[],
  from: number,
  to: number,
  pad: boolean,
): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error("bech32: value out of range");
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new Error("bech32: invalid padding");
  }
  return out;
}

export function bech32Decode(str: string): { hrp: string; data: number[] } {
  const lower = str.toLowerCase();
  if (lower !== str && str !== str.toUpperCase()) {
    throw new Error("bech32: mixed case");
  }
  if (lower.length < 8 || lower.length > 1023) throw new Error("bech32: bad length");
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) throw new Error("bech32: no separator");
  const hrp = lower.slice(0, pos);
  const data: number[] = [];
  for (const c of lower.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v === -1) throw new Error(`bech32: bad character '${c}'`);
    data.push(v);
  }
  if (bech32Polymod(hrpExpand(hrp).concat(data)) !== 1) {
    throw new Error("bech32: bad checksum");
  }
  return { hrp, data: data.slice(0, -6) };
}

function bech32Encode(hrp: string, data5: number[]): string {
  const values = hrpExpand(hrp).concat(data5).concat([0, 0, 0, 0, 0, 0]);
  const mod = bech32Polymod(values) ^ 1;
  const checksum: number[] = [];
  for (let p = 0; p < 6; p++) checksum.push((mod >> (5 * (5 - p))) & 31);
  return hrp + "1" + data5.concat(checksum).map((d) => CHARSET[d]).join("");
}

/** npub -> 64-char lowercase hex. Throws on anything that is not a valid npub. */
export function npubToHex(npub: string): string {
  const { hrp, data } = bech32Decode(npub);
  if (hrp !== "npub") throw new Error(`not an npub (hrp=${hrp})`);
  const bytes = convertBits(data, 5, 8, false);
  if (bytes.length !== 32) throw new Error(`npub payload is ${bytes.length} bytes, want 32`);
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 64-char hex -> npub. Throws on malformed hex. */
export function hexToNpub(hex: string): string {
  const h = hex.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("not a 32-byte hex pubkey");
  const bytes: number[] = [];
  for (let i = 0; i < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
  return bech32Encode("npub", convertBits(bytes, 8, 5, true));
}

// --------------------------------------------------------------------------
// tags, dedupe
// --------------------------------------------------------------------------

export function tagValues(tags: string[][], name: string): string[] {
  const out: string[] = [];
  for (const t of tags) {
    if (Array.isArray(t) && t[0] === name && typeof t[1] === "string") out.push(t[1]);
  }
  return out;
}

/** Stable per-service slug. Absent `d` is a real value (replaceable, not addressable). */
export function eventD(e: NostrEvent): string {
  return tagValues(e.tags, "d")[0] ?? "";
}

/** ADR-0001 D6: replaceable events are deduped by (kind, pubkey, d). */
export function dedupeKey(e: NostrEvent): string {
  return `${e.kind}:${e.pubkey}:${eventD(e)}`;
}

/**
 * Keep the newest created_at per (kind, pubkey, d). Ties break on the larger
 * event id so the output is byte-stable across runs (idempotent re-runs).
 */
export function dedupe(events: NostrEvent[]): NostrEvent[] {
  const best = new Map<string, NostrEvent>();
  for (const e of events) {
    if (!e || typeof e.kind !== "number" || typeof e.pubkey !== "string") continue;
    const k = dedupeKey(e);
    const prev = best.get(k);
    if (
      !prev ||
      e.created_at > prev.created_at ||
      (e.created_at === prev.created_at && String(e.id) > String(prev.id))
    ) {
      best.set(k, e);
    }
  }
  return [...best.values()].sort((a, b) =>
    a.kind - b.kind || a.pubkey.localeCompare(b.pubkey) || eventD(a).localeCompare(eventD(b))
  );
}

function uniqSorted(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

// --------------------------------------------------------------------------
// allow-list (ADR-0001 D12a) — fail closed
// --------------------------------------------------------------------------

export interface CuratorEntry {
  npub: string;
  role?: string;
  note?: string;
  derived_from?: string;
}

export interface AllowList {
  curators: CuratorEntry[];
  /** hex pubkeys that may be rendered */
  hex: string[];
  errors: string[];
}

export function parseCurators(raw: unknown): AllowList {
  const errors: string[] = [];
  const curators: CuratorEntry[] = [];
  const hex: string[] = [];
  const obj = raw as { curators?: unknown };
  const list = Array.isArray(obj?.curators) ? obj.curators as CuratorEntry[] : [];
  if (!Array.isArray(obj?.curators)) {
    errors.push("curators.json has no 'curators' array");
  }
  for (const c of list) {
    const npub = typeof c?.npub === "string" ? c.npub.trim() : "";
    if (!npub) {
      errors.push("curator entry without an npub");
      continue;
    }
    try {
      const h = npubToHex(npub);
      if (!hex.includes(h)) {
        hex.push(h);
        curators.push({ npub, role: c.role, note: c.note, derived_from: c.derived_from });
      }
    } catch (err) {
      // fail closed: an unparseable npub can never authorise anything
      errors.push(`curator npub does not decode: ${npub} (${(err as Error).message})`);
    }
  }
  return { curators, hex, errors };
}

export interface AllowListResult {
  kept: NostrEvent[];
  dropped: NostrEvent[];
}

export function applyAllowList(events: NostrEvent[], allowHex: string[]): AllowListResult {
  const allow = new Set(allowHex.map((h) => h.toLowerCase()));
  const kept: NostrEvent[] = [];
  const dropped: NostrEvent[] = [];
  for (const e of events) {
    (allow.has(String(e.pubkey).toLowerCase()) ? kept : dropped).push(e);
  }
  return { kept, dropped };
}

// --------------------------------------------------------------------------
// classification (ADR-0001 D3/D14 + vocab/service-inputs.json)
// --------------------------------------------------------------------------

export interface Cap {
  tool: string;
  amount: number;
  unit: string;
}

export interface TierAssessment {
  declared: string[];
  recomputed: string | null;
  mismatch: boolean;
}

export interface RequirementAssessment {
  required: string[];
  optional: string[];
  unknown: string[];
  none_sentinel: boolean;
  /** absent is not none: no cvm:req:* and no cvm:opt:* tag at all */
  unclassified: boolean;
}

export interface Classified {
  event_id: string;
  kind: number;
  pubkey: string;
  npub: string;
  d: string;
  created_at: number;
  classes: string[];
  name: string | null;
  about: string | null;
  website: string | null;
  links: string[];
  geohashes: string[];
  caps: Cap[];
  tier: TierAssessment;
  requirements: RequirementAssessment;
}

/**
 * The `r` tags: the provider's own outbound links — for a venue, the ordering
 * deep-link. Only absolute http(s) URLs are kept, so a hostile announcement
 * cannot smuggle a `javascript:`/`data:` href onto the rendered page.
 */
export function parseLinks(tags: string[][]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    if (!Array.isArray(t) || t[0] !== "r") continue;
    const raw = typeof t[1] === "string" ? t[1].trim() : "";
    if (!raw) continue;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    out.push(u.toString());
  }
  return uniqSorted(out);
}

/** Per-tool prices: ["cap","tool:<name>","<n>","sats"]. */
export function parseCaps(tags: string[][]): Cap[] {
  const out: Cap[] = [];
  for (const t of tags) {
    if (!Array.isArray(t) || t[0] !== "cap") continue;
    const tool = typeof t[1] === "string" ? t[1] : "";
    const amount = Number(t[2]);
    const unit = typeof t[3] === "string" ? t[3] : "";
    if (!tool.startsWith("tool:") || !Number.isFinite(amount)) continue;
    out.push({ tool: tool.slice("tool:".length), amount, unit });
  }
  return out;
}

export function classify(e: NostrEvent, vocab: Vocab): Classified {
  const t = tagValues(e.tags, "t");
  const classes = uniqSorted(
    t.filter((v) => v.startsWith(CLASS_PREFIX)).map((v) => v.slice(CLASS_PREFIX.length)),
  );
  const reqAll = t.filter((v) => v.startsWith(REQ_PREFIX)).map((v) => v.slice(REQ_PREFIX.length));
  const optAll = t.filter((v) => v.startsWith(OPT_PREFIX)).map((v) => v.slice(OPT_PREFIX.length));
  const declared = uniqSorted(
    t.filter((v) => v.startsWith(TIER_PREFIX)).map((v) => v.slice(TIER_PREFIX.length)),
  );

  const none_sentinel = reqAll.includes("none");
  const required = uniqSorted(reqAll.filter((f) => f !== "none"));
  const optional = uniqSorted(optAll.filter((f) => f !== "none"));
  const declaredFields = uniqSorted([...required, ...optional]);
  // unknown fields fail LOUD: surfaced, never counted as cvm:req:none
  const unknown = declaredFields.filter((f) => !(f in vocab.fields));
  const unclassified = reqAll.length === 0 && optAll.length === 0;

  // "the field list is the truth": the recomputed max wins over the published tag
  let recomputed: string | null = null;
  if (!unclassified) {
    if (declaredFields.length === 0) {
      recomputed = "none"; // only the cvm:req:none sentinel
    } else {
      let bestRank = -1;
      let bestName = "none";
      for (const f of declaredFields) {
        // an unknown field is treated at the most restrictive rank (never 'none')
        const tier = vocab.fields[f]?.tier ?? "sensitive";
        const rank = TIER_RANKS[tier] ?? TIER_RANKS.sensitive;
        if (rank > bestRank) {
          bestRank = rank;
          bestName = tier;
        }
      }
      recomputed = bestName;
    }
  }

  const expected = recomputed === null ? [] : [recomputed];
  const mismatch = declared.join(",") !== expected.join(",");

  return {
    event_id: e.id,
    kind: e.kind,
    pubkey: e.pubkey,
    npub: hexToNpub(e.pubkey),
    d: eventD(e),
    created_at: e.created_at,
    classes,
    name: tagValues(e.tags, "name")[0] ?? null,
    about: tagValues(e.tags, "about")[0] ?? null,
    website: tagValues(e.tags, "website")[0] ?? null,
    links: parseLinks(e.tags),
    geohashes: uniqSorted(tagValues(e.tags, "g")),
    caps: parseCaps(e.tags),
    tier: { declared, recomputed, mismatch },
    requirements: { required, optional, unknown, none_sentinel, unclassified },
  };
}

// --------------------------------------------------------------------------
// filter helpers — the single-letter rule and the local AND
// --------------------------------------------------------------------------

/**
 * ADR-0001 D2: only single-letter tags are filterable. Throws when a REQ filter
 * keys on a multi-letter tag, which is the mistake this repo exists to avoid.
 */
export function assertSingleLetterFilters(filter: Record<string, unknown>): void {
  for (const key of Object.keys(filter)) {
    if (FILTER_KEYS.has(key)) continue;
    if (!key.startsWith("#")) throw new Error(`filter key '${key}' is not a tag filter`);
    const letter = key.slice(1);
    if (letter.length !== 1) {
      throw new Error(`multi-letter tag filter '#${letter}' is not filterable (D2)`);
    }
  }
}

/** Server-side tier prefilter values for a shorthand, e.g. "no_personal_data". */
export function tierPrefilter(shorthand: string): string[] {
  const tiers = TIER_SHORTHAND[shorthand];
  if (!tiers) throw new Error(`unknown tier shorthand '${shorthand}'`);
  return tiers.map((tier) => TIER_PREFIX + tier);
}

/**
 * The tier shorthand matches against the RECOMPUTED tier (conservative: never
 * looser than the worst declared field), never against the published tag.
 */
export function matchesTierShorthand(entry: Classified, shorthand: string): boolean {
  const allowed = TIER_SHORTHAND[shorthand];
  if (!allowed) throw new Error(`unknown tier shorthand '${shorthand}'`);
  if (entry.requirements.unclassified) return false;
  return entry.tier.recomputed !== null && allowed.includes(entry.tier.recomputed);
}

/**
 * Field-level AND, computed locally on the cache (a single REQ with several #t
 * values is OR, so the relay can only prefilter). An entry with an UNKNOWN
 * declared field can never pass an "unknown is allowed" test silently: the
 * caller decides, but by default unknown fields fail the filter.
 */
export function matchesFieldAnd(
  entry: Classified,
  requiredFields: string[],
  opts: { allowUnknown?: boolean } = {},
): boolean {
  if (entry.requirements.unclassified) return false;
  const declared = new Set([...entry.requirements.required, ...entry.requirements.optional]);
  for (const f of requiredFields) if (!declared.has(f)) return false;
  if (!opts.allowUnknown && entry.requirements.unknown.length > 0) return false;
  return true;
}
