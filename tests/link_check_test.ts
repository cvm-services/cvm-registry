/**
 * Tests for the collector's CACHE-TIME link check.
 *
 * Why this exists: the dashboard published `website: https://nosms.orangesync.tech/llms.txt`
 * as the service's page while that URL answered TLS alert 80 and served no
 * certificate at all — nothing in the pipeline had ever fetched it. The rule the
 * dashboard states ("a declaration, not an audited fact") stays true; what
 * changes is that the collector now records ONE observable fact about the
 * declaration: did it answer when the collector last ran.
 *
 * Scope discipline: this is a plain outbound HEAD from the collector at collect
 * time. It is NOT a per-service CVM call, so the cache-not-proxy rule survives.
 *
 * Run: deno test --allow-read --allow-net=127.0.0.1
 */
import { checkServiceLinks, checkUrl } from "../collector/lib.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + msg);
}
function assertEquals<T>(actual: T, expected: T, msg = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`ASSERT (${msg}): got ${a}, want ${b}`);
}

// A real loopback origin: no mocks on the HTTP path.
const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
  const path = new URL(req.url).pathname;
  if (path === "/ok") return new Response("hi", { status: 200 });
  if (path === "/moved") return new Response(null, { status: 301, headers: { location: "/ok" } });
  if (path === "/missing") return new Response("nope", { status: 404 });
  if (path === "/boom") return new Response("bad", { status: 500 });
  if (path === "/head-refused") {
    // a server that answers GET but refuses HEAD (405) — the fallback case
    return new Response(null, { status: req.method === "HEAD" ? 405 : 200 });
  }
  if (path === "/slow") return new Promise<Response>((res) => setTimeout(() => res(new Response("late")), 2000));
  return new Response("?", { status: 418 });
});
const ORIGIN = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;

Deno.test("checkUrl: a live URL is ok, a dead one is not, and neither throws", async () => {
  const ok = await checkUrl(`${ORIGIN}/ok`, { timeoutMs: 3000 });
  assertEquals([ok.ok, ok.http_status, ok.reason], [true, 200, "ok"], "200 is reachable");

  const redir = await checkUrl(`${ORIGIN}/moved`, { timeoutMs: 3000 });
  assertEquals([redir.ok, redir.http_status], [true, 200], "a redirect still answers (it is followed; the final status is recorded)");

  const missing = await checkUrl(`${ORIGIN}/missing`, { timeoutMs: 3000 });
  assertEquals([missing.ok, missing.http_status, missing.reason], [false, 404, "http-404"], "404 is recorded verbatim");

  const boom = await checkUrl(`${ORIGIN}/boom`, { timeoutMs: 3000 });
  assertEquals([boom.ok, boom.http_status, boom.reason], [false, 500, "http-500"], "500 is recorded verbatim");
});

Deno.test("checkUrl falls back to GET when the server refuses HEAD", async () => {
  const r = await checkUrl(`${ORIGIN}/head-refused`, { timeoutMs: 3000 });
  assertEquals([r.ok, r.http_status], [true, 200], "GET succeeded after a 405 HEAD");
});

Deno.test("checkUrl: a timeout is UNKNOWN (ok=null), never silently ok", async () => {
  const r = await checkUrl(`${ORIGIN}/slow`, { timeoutMs: 300 });
  assertEquals([r.ok, r.http_status, r.reason], [null, null, "timeout"], "slow is not reachable and not a pass");
});

Deno.test("checkUrl refuses to fetch what it cannot fetch: bad schemes and junk", async () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "not a url", ""]) {
    const r = await checkUrl(bad, { timeoutMs: 1000 });
    assertEquals([r.ok, r.checked, r.reason], [null, false, "invalid-url"], `refused: ${bad}`);
  }
});

Deno.test("checkUrl: an unresolvable host is unreachable or unknown, but NEVER a pass", async () => {
  const r = await checkUrl("https://no-such-host.invalid/x", { timeoutMs: 2000 });
  assert(r.ok !== true, "an unresolvable host is never reachable");
  assert(r.reason === "unreachable" || r.reason === "timeout", `reason names the transport failure, got ${r.reason}`);
});

Deno.test("checkServiceLinks: disabled records nothing as ok, and never invents a verdict", async () => {
  const services = [{ service_key: "k", website: `${ORIGIN}/ok`, links: [] }] as never[];
  await checkServiceLinks(services, { enabled: false, timeoutMs: 1000, maxUrls: 10 });
  const s = services[0] as { link_status?: { checked: boolean; ok: boolean | null; reason: string } };
  assertEquals([s.link_status!.checked, s.link_status!.ok, s.link_status!.reason], [false, null, "disabled"], "disabled is not a pass");
});

Deno.test("checkServiceLinks: checks website AND r links, dedupes, and caps the work", async () => {
  const mk = (key: string, website: string, links: string[]) => ({ service_key: key, website, links }) as never;
  const services = [
    mk("a", `${ORIGIN}/ok`, [`${ORIGIN}/missing`, `${ORIGIN}/ok`]),
    mk("b", `${ORIGIN}/boom`, []),
    mk("c", `${ORIGIN}/ok`, [`${ORIGIN}/ok`]),
  ];
  await checkServiceLinks(services, { enabled: true, timeoutMs: 3000, maxUrls: 2 });
  const performed = (services as { link_status?: { checked: boolean } }[]).filter((s) => s.link_status?.checked === true);
  assertEquals(performed.length, 2, "the cap is a cap on requests, and it was hit");
  for (const s of services as { link_status?: { url: string; checked: boolean; ok: boolean | null; reason: string } }[]) {
    assert(s.link_status, "every service with a URL gets a labelled verdict");
    assert(s.link_status!.url.length > 0, "each verdict names the URL it judged");
    assert(
      s.link_status!.checked === true || s.link_status!.reason === "disabled" || s.link_status!.reason === "not-checked",
      `skipped is labelled honestly, got ${s.link_status!.reason}`,
    );
    if (!s.link_status!.checked) assert(s.link_status!.ok === null, "an unrun check is never a pass");
  }
});

Deno.test("checkServiceLinks mutates nothing when a service declares no URL at all", async () => {
  const services = [{ service_key: "k", website: null, links: [] }] as never[];
  await checkServiceLinks(services, { enabled: true, timeoutMs: 1000, maxUrls: 10 });
  const s = services[0] as { link_status?: unknown };
  assertEquals(s.link_status, null, "no URL, no verdict");
});

Deno.test("shutdown", async () => {
  await server.shutdown();
  assert(true, "server stopped");
});
