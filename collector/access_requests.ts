/** Signed NIP-78 access requests. Requests are review material, never services. */
import { eventD, hexToNpub, tagValues, type NostrEvent } from "./lib.ts";

export const ACCESS_REQUEST_KIND = 30078;
export const ACCESS_REQUEST_D = "cvm:access-request";

export interface AccessRequest {
  npub: string;
  pubkey: string;
  d: string;
  service_class: string | null;
  contact: string | null;
  evidence: string | null;
  created_at: number;
  first_seen: number;
  event_id: string;
  status: "requested";
}

function httpUrl(value: unknown): string | null {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim()) ? value.trim() : null;
}

/** Parse only attributable, signed kind-30078 requests with the reserved d-tag. */
export function parseAccessRequest(e: NostrEvent, firstSeen = e.created_at): AccessRequest | null {
  if (!e || e.kind !== ACCESS_REQUEST_KIND || !Array.isArray(e.tags)) return null;
  if (!/^[0-9a-f]{64}$/i.test(String(e.pubkey)) || !/^[0-9a-f]{128}$/i.test(String(e.sig))) return null;
  if (eventD(e) !== ACCESS_REQUEST_D) return null;
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(typeof e.content === "string" ? e.content : "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch { return null; }
  const serviceClass = typeof body.service_class === "string" ? body.service_class.trim() :
    (tagValues(e.tags, "class")[0] ?? null);
  const contact = typeof body.contact === "string" ? body.contact.trim() : null;
  const evidence = httpUrl(body.evidence ?? tagValues(e.tags, "evidence")[0]);
  return {
    npub: hexToNpub(e.pubkey),
    pubkey: e.pubkey,
    d: ACCESS_REQUEST_D,
    service_class: serviceClass || null,
    contact: contact || null,
    evidence,
    created_at: e.created_at,
    first_seen: firstSeen,
    event_id: e.id,
    status: "requested",
  };
}

/** Newest request wins by (npub,d), while first_seen remains the oldest observed timestamp. */
export function dedupeAccessRequests(events: NostrEvent[], seenAt = (e: NostrEvent) => e.created_at): AccessRequest[] {
  const first = new Map<string, number>();
  const best = new Map<string, AccessRequest>();
  for (const e of events) {
    const request = parseAccessRequest(e, seenAt(e));
    if (!request) continue;
    const key = `${request.npub}:${request.d}`;
    first.set(key, Math.min(first.get(key) ?? request.first_seen, request.first_seen));
    const previous = best.get(key);
    if (!previous || request.created_at > previous.created_at ||
      (request.created_at === previous.created_at && request.event_id > previous.event_id)) best.set(key, request);
  }
  return [...best.entries()].map(([key, request]) => ({ ...request, first_seen: first.get(key)! }))
    .sort((a, b) => a.npub.localeCompare(b.npub) || a.d.localeCompare(b.d));
}
