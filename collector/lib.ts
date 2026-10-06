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

// --------------------------------------------------------------------------
// announcement content — the provider's own declaration of fulfilment / menu /
// settlement facts, carried in the event `content` (a JSON string on the Nostr
// event). Parsed defensively: a malformed or absent content yields null fields,
// never throws, so a hostile or broken announcement can never abort a collect.
// --------------------------------------------------------------------------

/** Per-method fulfilment detail (pickup/delivery/dine_in), loose by design. */
export interface FulfilmentMethodInfo {
  available?: boolean;
  estimated_minutes?: number;
  [k: string]: unknown;
}

export interface DeclaredFulfilment {
  /** the methods the venue offers, e.g. ["pickup","delivery"] */
  methods: string[];
  pickup: FulfilmentMethodInfo | null;
  delivery: FulfilmentMethodInfo | null;
  dine_in: FulfilmentMethodInfo | null;
  method_condition: string | null;
}

/** One method's price breakdown inside menu.prices_by_method. */
export interface PriceBreakdown {
  count?: number;
  min_price?: number;
  max_price?: number;
  [k: string]: unknown;
}

export interface DeclaredMenu {
  item_count: number | null;
  priced_count: number | null;
  currency: string | null;
  min_price: number | null;
  max_price: number | null;
  prices_by_method: Record<string, PriceBreakdown> | null;
  price_basis: string | null;
}

export interface DeclaredSettlement {
  settles: string | null;
  rail: string | null;
  currency: string | null;
  tax: unknown;
  cvm_cap_sats: number | null;
  recorded: boolean | null;
  note: string | null;
}

/** The provider-declared facts read from event content (all nullable). */
export interface Declared {
  fulfilment: DeclaredFulfilment | null;
  menu: DeclaredMenu | null;
  settlement: DeclaredSettlement | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function methodInfo(v: unknown): FulfilmentMethodInfo | null {
  const r = asRecord(v);
  if (!r) return null;
  return r as FulfilmentMethodInfo;
}

function priceBreakdown(v: unknown): PriceBreakdown | null {
  const r = asRecord(v);
  if (!r) return null;
  return r as PriceBreakdown;
}

function parseFulfilment(v: unknown): DeclaredFulfilment | null {
  const r = asRecord(v);
  if (!r) return null;
  return {
    methods: strArray(r.methods),
    pickup: methodInfo(r.pickup),
    delivery: methodInfo(r.delivery),
    dine_in: methodInfo(r.dine_in),
    method_condition: strOrNull(r.method_condition),
  };
}

function parseMenu(v: unknown): DeclaredMenu | null {
  const r = asRecord(v);
  if (!r) return null;
  let prices_by_method: Record<string, PriceBreakdown> | null = null;
  const pbm = asRecord(r.prices_by_method);
  if (pbm) {
    prices_by_method = {};
    for (const [k, val] of Object.entries(pbm)) {
      const b = priceBreakdown(val);
      if (b) prices_by_method[k] = b;
    }
  }
  return {
    item_count: numOrNull(r.item_count),
    priced_count: numOrNull(r.priced_count),
    currency: strOrNull(r.currency),
    min_price: numOrNull(r.min_price),
    max_price: numOrNull(r.max_price),
    prices_by_method,
    price_basis: strOrNull(r.price_basis),
  };
}

function parseSettlement(v: unknown): DeclaredSettlement | null {
  const r = asRecord(v);
  if (!r) return null;
  return {
    settles: strOrNull(r.settles),
    rail: strOrNull(r.rail),
    currency: strOrNull(r.currency),
    tax: r.tax ?? null,
    cvm_cap_sats: numOrNull(r.cvm_cap_sats),
    recorded: boolOrNull(r.recorded),
    note: strOrNull(r.note),
  };
}

/**
 * Parse the event `content` (a JSON string) into declared facts. Never throws:
 * a malformed, absent or non-object content yields an all-null Declared, so a
 * broken announcement is inert, not fatal.
 */
export function parseDeclared(content: string): Declared {
  let raw: unknown = null;
  try {
    raw = JSON.parse(content);
  } catch {
    raw = null;
  }
  const r = asRecord(raw);
  if (!r) return { fulfilment: null, menu: null, settlement: null };
  return {
    fulfilment: parseFulfilment(r.fulfilment),
    menu: parseMenu(r.menu),
    settlement: parseSettlement(r.settlement),
  };
}

/**
 * The "meatspace" capability facet: does this entry represent a PHYSICAL
 * handover (a venue you pick up from, dine in at, or is explicitly tagged
 * `cvm:service:meatspace`), rather than a purely digital service?
 *
 * Two clauses, both required:
 *  (1) NO required field starts with `ship.` — a delivery-only venue that
 *      REQUIRES a shipping address cannot be fulfilled in meatspace.
 *  (2) a physical handover is affirmatively declared — content.fulfilment.methods
 *      includes "pickup" or "dine_in", OR the `cvm:service:meatspace` class tag
 *      is present.
 *
 * Clause (2) exists precisely to keep digital services out. A digital service
 * that requires nothing (tier `none`, class `compute`) or only `payment.amount`
 * (class `sms`) trivially satisfies clause (1) — it has no `ship.*` requirement
 * at all — so without an affirmative handover declaration it would be
 * mislabelled "meatspace". Only an explicit pickup/dine_in method, or the
 * explicit `cvm:service:meatspace` tag, counts as a physical handover.
 */
export function isMeatspace(required: string[], classes: string[], declared: Declared): boolean {
  const noShipRequired = !required.some((f) => f.startsWith("ship."));
  if (!noShipRequired) return false;
  const methods = declared.fulfilment?.methods ?? [];
  if (methods.includes("pickup") || methods.includes("dine_in")) return true;
  // cvm:service:meatspace is an ADDITIONAL, explicit signal (a parallel change in
  // contextvm-services); treat it as additive, never as a dependency.
  return classes.includes("meatspace");
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
  /** provider-declared fulfilment/menu/settlement facts from event content */
  declared: Declared;
  /** physical handover (pickup/dine_in/meatspace-tagged), never a digital service */
  meatspace: boolean;
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

  const declaredContent = parseDeclared(e.content);

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
    website: httpUrlOrNull(tagValues(e.tags, "website")[0] ?? null),
    links: parseLinks(e.tags),
    geohashes: uniqSorted(tagValues(e.tags, "g")),
    caps: parseCaps(e.tags),
    tier: { declared, recomputed, mismatch },
    requirements: { required, optional, unknown, none_sentinel, unclassified },
    declared: declaredContent,
    meatspace: isMeatspace(required, classes, declaredContent),
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

// --------------------------------------------------------------------------
// service grouping — CEP-6 kinds 11316-11320 are FACETS of ONE service
// --------------------------------------------------------------------------
//
// The dashboard used to render one card per ANNOUNCEMENT, so a service that
// publishes its server announcement (11316) and its tools list (11317) — which
// CEP-6 defines as facets of one service — was painted TWICE, and the header
// counted "2 announcements from 2 curators" for a single signer. Identity is
// (pubkey, d): `kind` classifies a facet, it never identifies a service. The
// per-kind dedupe in `dedupe()` stays as it is — it is the right rule for a
// retraction within a kind — this is a second level on top of it.

export interface ServiceFacet {
  kind: number;
  event_id: string;
  created_at: number;
}

export interface Service {
  /** `${pubkey}:${d}` — the service's identity, stable across re-announcements. */
  service_key: string;
  pubkey: string;
  npub: string;
  /** the announcement slug; "" for the many CEP-6 servers that omit `d` */
  d: string;
  /** the CEP-6 kinds present, ascending */
  kinds: number[];
  facets: ServiceFacet[];
  name: string | null;
  about: string | null;
  website: string | null;
  links: string[];
  geohashes: string[];
  classes: string[];
  caps: Cap[];
  tier: TierAssessment;
  requirements: RequirementAssessment;
  /** provider-declared fulfilment/menu/settlement facts (merged from facets) */
  declared: Declared;
  /** physical handover (pickup/dine_in/meatspace-tagged), never a digital service */
  meatspace: boolean;
  /** newest facet timestamp */
  created_at: number;
  /** filled by the collector's cache-time link check; null = no URL declared */
  link_status: LinkStatus | null;
}

/** The identity of a service: the signer plus its announcement slug. */
export function serviceKey(e: { pubkey: string; d: string }): string {
  return `${String(e.pubkey).toLowerCase()}:${e.d ?? ""}`;
}

const TIER_RANK: Record<string, number> = {
  none: 0,
  financial: 1,
  contact: 2,
  fulfilment: 3,
  legal: 4,
  sensitive: 5,
};

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/**
 * Collapse classified announcements into services, one per (pubkey, d).
 *
 * Merges are deliberately conservative, never generous:
 *   * display fields (name/about/website) come from the LOWEST kind that
 *     declares them — 11316 is the server announcement and speaks for identity;
 *   * `tier.recomputed` is the WORST (highest-rank) facet, so a tools list
 *     cannot loosen the input the server announcement declared;
 *   * `requirements.unclassified` is true only when NO facet classifies — a
 *     service whose 11317 declares requirements is not "unclassified";
 *   * every facet keeps its event id, so the evidence chain survives the merge.
 *
 * Output order is (pubkey, d) — deterministic, independent of input order.
 */
export function groupServices(entries: Classified[]): Service[] {
  const byKey = new Map<string, Classified[]>();
  for (const e of entries) {
    const k = serviceKey(e);
    const arr = byKey.get(k);
    if (arr) arr.push(e);
    else byKey.set(k, [e]);
  }

  const services: Service[] = [];
  for (const [key, group] of byKey) {
    const sorted = [...group].sort((a, b) => a.kind - b.kind || a.event_id.localeCompare(b.event_id));
    const firstNonEmpty = <T>(pick: (e: Classified) => T | null | undefined): T | null => {
      for (const e of sorted) {
        const v = pick(e);
        if (v !== null && v !== undefined && (v as unknown as string) !== "") return v as T;
      }
      return null;
    };
    const worstTier = sorted.reduce<string | null>((acc, e) => {
      const r = e.tier.recomputed;
      if (r === null) return acc;
      if (acc === null) return r;
      return (TIER_RANK[r] ?? 0) > (TIER_RANK[acc] ?? 0) ? r : acc;
    }, null);

    const caps: Cap[] = [];
    const seenCaps = new Set<string>();
    for (const e of sorted) {
      for (const c of e.caps) {
        const ck = JSON.stringify(c);
        if (seenCaps.has(ck)) continue;
        seenCaps.add(ck);
        caps.push(c);
      }
    }

    services.push({
      service_key: key,
      pubkey: sorted[0].pubkey,
      npub: sorted[0].npub,
      d: sorted[0].d,
      kinds: sorted.map((e) => e.kind),
      facets: sorted.map((e) => ({ kind: e.kind, event_id: e.event_id, created_at: e.created_at })),
      name: firstNonEmpty((e) => e.name),
      about: firstNonEmpty((e) => e.about),
      website: firstNonEmpty((e) => e.website),
      links: uniq(sorted.flatMap((e) => e.links)).sort(),
      geohashes: uniq(sorted.flatMap((e) => e.geohashes)).sort(),
      classes: uniq(sorted.flatMap((e) => e.classes)).sort(),
      caps,
      tier: {
        declared: uniq(sorted.flatMap((e) => e.tier.declared)).sort(),
        recomputed: worstTier,
        mismatch: sorted.some((e) => e.tier.mismatch),
      },
      requirements: {
        required: uniq(sorted.flatMap((e) => e.requirements.required)).sort(),
        optional: uniq(sorted.flatMap((e) => e.requirements.optional)).sort(),
        unknown: uniq(sorted.flatMap((e) => e.requirements.unknown)).sort(),
        none_sentinel: sorted.some((e) => e.requirements.none_sentinel),
        unclassified: sorted.every((e) => e.requirements.unclassified),
      },
      // content facts merge per-field from the lowest kind that declares them
      // (the 11316 server announcement speaks for identity and content); a
      // service is meatspace if ANY facet is — the venue's 11316 declares the
      // handover, its 11317 tools list does not.
      declared: {
        fulfilment: firstNonEmpty((e) => e.declared.fulfilment),
        menu: firstNonEmpty((e) => e.declared.menu),
        settlement: firstNonEmpty((e) => e.declared.settlement),
      },
      meatspace: sorted.some((e) => e.meatspace),
      created_at: Math.max(...sorted.map((e) => e.created_at)),
      link_status: null,
    });
  }
  return services.sort((a, b) => a.pubkey.localeCompare(b.pubkey) || a.d.localeCompare(b.d));
}

// --------------------------------------------------------------------------
// cache-time link check — did the DECLARED url answer when we last collected?
// --------------------------------------------------------------------------
//
// A dead URL reached a "live" dashboard because nothing ever fetched it: the
// page renders the provider's own declaration, and a declaration nobody tests
// is indistinguishable from a working one. This records ONE observable fact
// about that declaration, at COLLECT time, as data on the cache.
//
// Scope discipline: a plain outbound HEAD from the collector. It is NOT a
// per-service CVM call and NOT a relay connection, so the cache-not-proxy rule
// (ADR-0001 D7) is untouched. The page still makes zero network calls.

export interface LinkStatus {
  url: string;
  /** false when the check did not run (disabled or over budget) */
  checked: boolean;
  /** true = answered 2xx/3xx, false = did not answer, null = UNKNOWN */
  ok: boolean | null;
  http_status: number | null;
  reason: string;
  /** What the PAGE should say about this URL; null when there is nothing to
   *  report (a confirmed answer). Computed here, not in the page, so the page
   *  cannot disagree with the catalog about what a verdict means. */
  text?: string | null;
  checked_at: number;
}

export interface LinkCheckPolicy {
  enabled: boolean;
  timeoutMs: number;
  maxUrls: number;
}

const LINK_USER_AGENT = "cvm-registry-collector/1.0 (+https://cvm.orangesync.tech/)";

/** Absolute http(s) only — the same rule `parseLinks` applies before rendering. */
export function validHttpUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u.toString();
}

/**
 * Ask whether a declared URL answers. Never throws: a transport failure is a
 * RESULT (unreachable/timeout), not an exception that could abort a collect.
 * A timeout is `ok: null` — unknown, never a pass.
 */
export async function checkUrl(
  raw: string,
  opts: { timeoutMs?: number; now?: number; fetchImpl?: typeof fetch } = {},
): Promise<LinkStatus> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const url = validHttpUrl(raw);
  if (!url) {
    return { url: raw, checked: false, ok: null, http_status: null, reason: "invalid-url", checked_at: now };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const attempt = async (method: string): Promise<Response> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await doFetch(url, {
        method,
        redirect: "follow",
        signal: ctl.signal,
        headers: { "user-agent": LINK_USER_AGENT, "accept": "*/*" },
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res: Response;
    try {
      res = await attempt("HEAD");
      if (res.status === 405 || res.status === 501) res = await attempt("GET");
    } catch {
      // some origins close the connection on HEAD; one GET retry, then decide
      res = await attempt("GET");
    }
    const ok = res.status >= 200 && res.status < 400;
    return {
      url,
      checked: true,
      ok,
      http_status: res.status,
      reason: ok ? "ok" : `http-${res.status}`,
      checked_at: now,
    };
  } catch (err) {
    const name = (err as Error)?.name ?? "";
    const reason = name === "AbortError" || name === "TimeoutError" ? "timeout" : "unreachable";
    return { url, checked: true, ok: null, http_status: null, reason, checked_at: now };
  }
}

/**
 * Check each service's declared URL (the `website` tag, else its first `r`
 * link) and attach the verdict as `link_status`. Bounded: at most `maxUrls`
 * requests per collect, each capped by `timeoutMs`. Services over budget are
 * labelled `not-checked` — an unrun check is never reported as a pass.
 */
export async function checkServiceLinks(
  services: Service[],
  policy: LinkCheckPolicy,
  deps: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<void> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  let budget = Math.max(0, policy.maxUrls);
  for (const s of services) {
    const candidates = uniq([s.website, ...s.links].map((u) => validHttpUrl(u)).filter((u): u is string => u !== null));
    if (candidates.length === 0) {
      s.link_status = null;
      continue;
    }
    if (!policy.enabled) {
      s.link_status = { url: candidates[0], checked: false, ok: null, http_status: null, reason: "disabled", text: verdictText({ checked: false, ok: null, reason: "disabled" }), checked_at: now };
      continue;
    }
    if (budget === 0) {
      s.link_status = { url: candidates[0], checked: false, ok: null, http_status: null, reason: "not-checked", text: verdictText({ checked: false, ok: null, reason: "not-checked" }), checked_at: now };
      continue;
    }
    budget -= 1;
    s.link_status = await checkUrl(candidates[0], { timeoutMs: policy.timeoutMs, now, ...deps });
    s.link_status.text = verdictText(s.link_status);
  }
}

/** Honest tally for the catalog header — counts the CHECKS, not the services. */
export function linkCheckTally(services: Service[]): { checked: number; unreachable: number; not_checked: number; no_url: number } {
  let checked = 0, unreachable = 0, not_checked = 0, no_url = 0;
  for (const s of services) {
    if (!s.link_status) {
      no_url += 1;
      continue;
    }
    if (!s.link_status.checked) not_checked += 1;
    else {
      checked += 1;
      if (s.link_status.ok !== true) unreachable += 1;
    }
  }
  return { checked, unreachable, not_checked, no_url };
}

// --------------------------------------------------------------------------
// what the page is allowed to say — decided HERE, never in the page
// --------------------------------------------------------------------------

/** A provider-supplied URL that is absolute http(s), or nothing.
 *
 * The `website` tag is attacker-controlled text and the page puts it in an
 * `href`. `javascript:`/`data:`/`file:` must never survive that trip, so the
 * check happens once here and the page renders only what passed it. Same rule
 * `parseLinks` applies to `r` tags, and it returns the string UNCHANGED (no
 * normalisation) so the catalog keeps the provider's own spelling. */
export function httpUrlOrNull(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

/**
 * The page-facing verdict for a link check: what to render, or null for nothing.
 *
 * Returns null ONLY for a confirmed answer (`ok === true`) or no check at all.
 * Everything else gets words, because silence is what made the first cut of this
 * check useless: a transport failure is `ok: null` (UNKNOWN), and the page — which
 * tested for `ok === false` — rendered it as a plain, healthy-looking link. The
 * live TLS failure that motivated the check was therefore invisible on the page.
 * UNKNOWN is never a pass, and it is never quiet either.
 */
export function verdictText(st: { checked?: boolean; ok: boolean | null; reason?: string } | null | undefined): string | null {
  if (!st) return null;
  if (st.checked === false) return "not checked";
  if (st.ok === true) return null;
  if (st.reason === "timeout") return "no reply";
  if (st.reason && st.reason.startsWith("http-")) return "unreachable " + st.reason.slice(5);
  return "unreachable";
}
