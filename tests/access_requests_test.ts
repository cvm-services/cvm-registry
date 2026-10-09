import {
  ACCESS_REQUEST_D,
  ACCESS_REQUEST_KIND,
  dedupeAccessRequests,
  parseAccessRequest,
} from "../collector/access_requests.ts";
import type { NostrEvent } from "../collector/lib.ts";

const pubkey = "1".repeat(64);
const sig = "2".repeat(128);
function event(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "a".repeat(64), pubkey, created_at: 100, kind: ACCESS_REQUEST_KIND,
    tags: [["d", ACCESS_REQUEST_D]],
    content: JSON.stringify({ service_class: "cvm:service:food", contact: "ops@example.test", evidence: "https://example.test/evidence" }),
    sig, ...over,
  };
}

Deno.test("access request parses signed NIP-78 data and is not a service", () => {
  const request = parseAccessRequest(event(), 50);
  if (!request) throw new Error("request was rejected");
  if (request.status !== "requested") throw new Error("request is not requested");
  if (request.service_class !== "cvm:service:food") throw new Error("class missing");
  if (request.first_seen !== 50) throw new Error("first seen missing");
});

Deno.test("unsigned or wrong-d-tag access requests are rejected", () => {
  if (parseAccessRequest(event({ sig: "" }))) throw new Error("unsigned request accepted");
  if (parseAccessRequest(event({ tags: [["d", "other"]] }))) throw new Error("wrong d accepted");
});

Deno.test("access requests dedupe by npub and d, newest wins, oldest first_seen survives", () => {
  const old = event({ id: "a".repeat(64), created_at: 100 });
  const newer = event({ id: "b".repeat(64), created_at: 200, content: JSON.stringify({ evidence: "https://example.test/new" }) });
  const out = dedupeAccessRequests([newer, old], () => 10);
  if (out.length !== 1) throw new Error("duplicate request survived");
  if (out[0].created_at !== 200 || out[0].evidence !== "https://example.test/new" || out[0].first_seen !== 10) {
    throw new Error("newest/first-seen rule failed");
  }
});
