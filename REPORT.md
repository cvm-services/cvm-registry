# REPORT — t_cdc4442b: the cvm-pwa Caddy vhost served the order app for arbitrary paths

Branch `worker-base/t_cdc4442b` (worktree `/home/c03rad0r/worktrees/t_cdc4442b`), 3 commits off
`origin/main` (`53cf1a9`). **Not merged** — the manager merges after verifying the branch.

| commit | what |
|---|---|
| `c250a20` | `test(pwa)`: RED first — 4 new assertions, failing against the shipped vhost |
| `374ecca` | `fix(deploy)`: scope the SPA fallback, exact `/api`, fallback-free catch-all, `/` alias |
| `9a82291` | `fix(deploy)`: name the matcher slot in the redirects — they were silently inert (see §3) |

## 1. The defect, reproduced

`deploy/caddy-vhost-cvm-pwa.caddy` ended with an UNSCOPED `handle { try_files {path}
/order/index.html }`, and Caddy's `handle_path /api/*` needs the trailing slash, so **bare `/api`
was never claimed by any handler** and fell into the fallback. Live, before the install
(`evidence/t_cdc4442b/live-BEFORE.txt`, 2026-10-10T20:34Z):

```
PATH                               CODE  SIZE      CONTENT-TYPE        BODY-IS-ORDER-DOC
/api                               200   381b      text/html;          ORDER-DOC
/style.css                         200   381b      text/html;          ORDER-DOC
/app.js                            200   381b      text/html;          ORDER-DOC
/nope                              200   381b      text/html;          ORDER-DOC
/                                  200   381b      text/html;          ORDER-DOC
/order/                            200   381b      text/html;          ORDER-DOC
/order/sw.js                       200   381b      text/html;          ORDER-DOC
/order/manifest.webmanifest        200   381b      text/html;          ORDER-DOC
/menu.json                         200   57027b    application/json    no
/console/                          200   1102b     text/html;          no
```

The document at `/api` loads `style.css` and `app.js` by **relative** url, so the browser asked
for `/style.css` and `/app.js`, got `text/html` for both, refused to execute the module script,
and `app.js`'s `Promise.all([fetch("../menu.json")…])` never ran: `<p class="loading">Loading
venues…</p>` stayed on screen with no console error and no failed request. A 200 is what made it
undiagnosable. (`/order/sw.js` and `/order/manifest.webmanifest` also show the host's docroot was
still the pre-PWA bundle — fixed by the same deploy; see §5.)

## 2. What changed (commit `374ecca`)

| handler | before | after |
|---|---|---|
| `handle_path /api/*` | → `reverse_proxy 127.0.0.1:8788` | unchanged |
| `handle /api` (exact) | **absent** → fell into the fallback | `redir * /api/ 308` |
| `handle /` (exact) | **absent** → served the order document at `/` | `redir * /order/ 302` |
| `/console/*` | fallback to `/console/index.html` | unchanged |
| `/order/*` | **not present as its own handler** | `try_files {path} /order/index.html` |
| catch-all | `try_files {path} /order/index.html` + `file_server` | `file_server` only — real files, never a document |

**Bare `/api`: 308 to `/api/`, not a hand-written JSON 404.** The two paths name the same
resource and `/api/` is the form the prefix-stripping proxy already serves, so the edge
normalises the request with its method and body preserved and the client gets the service's OWN
verdict — its JSON 404 when up, this file's JSON 502 when down. Both are JSON; neither is
200 + text/html. A hand-written 404 would have to duplicate the service's error contract at the
edge, and would answer 404 for a POST that the service might have accepted at `/api/`.

**Why the catch-all survives, fallback-free.** `app.js` fetches `../menu.json` and
`../../vocab/service-inputs.json` — paths OUTSIDE `/order/`. Deleting the catch-all instead of
scoping it would 404 the app's own data and hang the page in exactly the same way. It now serves
only real files from the docroot, so an unknown path is a 404 and can never be a document.

**Why `/` became an explicit alias.** Under the old unscoped fallback, `/` served the order
document, so its relative asset urls resolved against `/` — the same trap as `/api`. Scoping the
fallback without handling `/` would have turned the entry point into a 404; a 302 to `/order/`
keeps the entry point working while the document keeps living at its real base. 302 (not 308):
this is a convenience landing alias, not a permanent move.

## 3. The bug the behavioural matrix caught — and the tests could not

The first version of the fix (attempt 2's uncommitted work, committed as `374ecca`) spelled the
redirect the obvious way:

```
handle /api {
    redir /api/ 308
}
```

Under real Caddy 2.6.2 that is **not** a redirect. Caddy reads the FIRST argument of `redir` as
an optional inline matcher, and a token beginning with `/` **is** a path matcher, so
`caddy adapt` produced:

```
match path /api/  ->  static_response status 302, headers { Location: 308 }
```

The rewritten inner route matches only `/api/`, never bare `/api`, so `GET /api` answered
**200 with an EMPTY body** — the defect was still there, dressed as a fix. Same for
`redir /order/ 302` under `handle /`: bare `/` answered 200 + empty body. Both redirects were
inert no-ops.

Ten spellings probed with `caddy adapt` (`evidence/t_cdc4442b/caddy-adapt-redir-spellings.txt`):

```
redir /api/ 308           -> inner-match [{"path":["/api/"]}] status 302  Location "308"     INERT
redir "/api/" 308         -> same (quoting does not help)                                    INERT
redir /api/ permanent     -> Location "permanent", status 302                                INERT
route { redir /api/ 308 } -> same (route{} does not help)                                    INERT
redir /api/ 308 (reversed) -> parse error: "Not a supported redir code type"
redir * /api/ 308         -> status 308   Location "/api/"                                   WORKS
redir https://… 308       -> status 308   Location "https://…"                               WORKS
```

Fix: `redir * /api/ 308` and `redir * /order/ 302` (commit `9a82291`).

The RED-first test file from `c250a20` asserted `/redir\s+\/api\/\s+30[128]/` — **bytes, not
semantics** — so it passed on the broken spelling. That is the honest lesson of this task: a
text assertion about a Caddyfile proves what the file SAYS, not what Caddy DOES. The suite now
(a) requires the matcher slot in both redirects and (b) carries a file-wide rule that no `redir`
target may sit in the matcher slot. Proof, both directions
(`evidence/t_cdc4442b/RED-matcher-slot-assertion.txt`):

```
=== RED: ambiguous 'redir /api/ 308' + new assertion ===
bare /api has its own handler and never reaches the order fallback ... FAILED
the origin root is an explicit alias, not a second copy of the app ... FAILED
no redir target can be read as Caddy's inline matcher slot ... FAILED
FAILED | 8 passed | 3 failed
=== GREEN: 'redir * /api/ 308' ===
no redir target can be read as Caddy's inline matcher slot ... ok
```

## 4. Verification (all raw output committed under `evidence/t_cdc4442b/`)

**Suite.** Test command read from the repo (there is no `deno.json`/`package.json`; CI is
`.ngit/act/workflows/ci.yml`: `deno check collector/ tests/` then
`deno test --allow-read --allow-net --allow-env tests/`). `deno check` exits 0.

```
final test file vs origin/main vhost : FAILED | 162 passed | 4 failed  (suite exit 1)
final test file vs branch vhost      : ok     | 166 passed | 0 failed  (suite exit 0)
```

The 4 failures against the shipped vhost are the four new assertions (`bare /api has its own
handler`, `the SPA fallback is scoped to /order/*`, `the catch-all … only those`, `the origin
root is an explicit alias`), each with the message that names the live symptom:

```
no `handle /api` (exact): bare /api still falls through to the SPA fallback and answers the
order document as text/html
```

**Behaviour, real Caddy 2.6.2 + curl on the same docroot layout `deploy-pwa.sh` ships.**
`evidence/t_cdc4442b/local-matrix-{OLD,NEW}.txt`:

| path | OLD (origin/main) | NEW (branch) |
|---|---|---|
| `/api` | 200 text/html 1851b ORDER-DOC | **308 → Location: /api/** |
| `/api/`, `/api/orders` | 404 JSON (proxied) | 404 JSON (proxied) |
| `/api/health` | 200 JSON | 200 JSON |
| `/style.css`, `/app.js`, `/nope` | 200 text/html ORDER-DOC | **404** |
| `/` | 200 text/html ORDER-DOC | **302 → /order/** |
| `/order/`, `/order/nope-route` | 200 the order document | 200 the order document |
| `/order/style.css`, `/order/sw.js`, `/order/manifest.webmanifest` | 200 css/js/manifest+json | unchanged |
| `/menu.json`, `/vocab/service-inputs.json`, `/fixtures/…` | 200 | unchanged |
| `/console/`, `/console/nope-route` | 200 the CONSOLE document | unchanged |

Follow-through with `curl -L` (`local-followthrough-{OLD,NEW}.txt`):

```
OLD  GET  /api   final=200 ct=text/html redirects=0 size=1851b body=ORDER-DOC
OLD  POST /api   final=200 ct=text/html redirects=0 body=<!doctype html>…
NEW  GET  /api   final=404 ct=application/json redirects=1 body={"error": "not found", "method": "GET", "upstream_path": "/"}
NEW  POST /api   final=404 ct=application/json redirects=1 body={"error": "not found", "method": "POST", "upstream_path": "/"}
NEW  GET  /       final=200 ct=text/html redirects=1 body=ORDER-DOC
```

`upstream_path: "/"` for a request to `/api/` is the evidence that
`handle_path /api/*` still strips the prefix. `method: POST` is the evidence that the 308
preserves the method (and the body) rather than degrading the request to a GET.

Upstream DOWN (`local-matrix-DOWN-{old,new}.txt`, nothing listening on 127.0.0.1:8788):

```
OLD  /api        200 text/html 1851b ORDER-DOC     <- the defect was never "the service is down"
OLD  /api/       502 application/json
NEW  /api        308 → /api/ → 502 application/json
NEW  /api/       502 application/json
NEW  /style.css  404          NEW /nope  404
```

**Live host install (M6), `testserver2.fips`, docroot `/opt/tollgate/cvm-pwa`.** Reached
(ssh BatchMode OK, `sudo -n` OK, caddy active), installed with the documented path
`HOST=debian@testserver2.fips bash deploy/deploy-pwa.sh`
(`evidence/t_cdc4442b/live-INSTALL.txt`):

```
cvm-pwa.orangesync.tech: replaced 1 block(s); backup /etc/caddy/Caddyfile.vhostbak-20261010T203457Z
caddy config: valid
caddy: active
```

Live matrix after the install (`evidence/t_cdc4442b/live-AFTER.txt`, 20:36Z):

```
PATH                               CODE  SIZE      CONTENT-TYPE                LOCATION   BODY-IS-ORDER-DOC
/api                               308   0b        –                           /api/      no
/api/                              404   21b       application/json            –          no
/api/orders                        404   21b       application/json            –          no
/api/health                        200   11b       application/json            –          no
/style.css                         404   0b        –                           –          no
/app.js                            404   0b        –                           –          no
/nope                              404   0b        –                           –          no
/                                  302   0b        –                           /order/    no
/order/                            200   1851b     text/html;                  –          ORDER-DOC
/order/sw.js                       200   5505b     text/javascript;            –          no
/order/manifest.webmanifest        200   1012b     application/manifest+json   –          no
/menu.json                         200   57027b    application/json            –          no
/vocab/service-inputs.json         200   6366b     application/json            –          no
/console/                          200   1102b     text/html;                  –          no
/console/app.js                    200   28538b    text/javascript;            –          no
```

```
// bare /api, live:            HTTP/2 308 / location: /api/ / content-length: 0
// curl -L GET  /api :         final=404 ct=application/json redirects=1 body={"error":"not found"}
// curl -L POST /api :         final=404 ct=application/json redirects=1
```

The deploy's own verifications passed as well: `/console/` document byte-equal to
`site/console/index.html`, `/order/sw.js` byte-identical to the repo's worker and served as
JavaScript, the manifest served as `application/manifest+json` with `start_url`/`scope` `/order/`,
all five icons `image/png`, and `/api/auth/challenge` answering JSON carrying `facilitatorNpub`
(so `/api/*` still proxies to a live cvm-orders).

## 5. What this does NOT prove

- **No browser was driven.** The symptom was "Loading venues… stays on screen forever"; what is
  proven is the HTTP-level cause (bare `/api` served the document, and the document's relative
  assets resolved to `/style.css` and `/app.js`, which also served the document). I did not run
  the Playwright/emulator e2e against the live origin, so I have not seen the rendered app.
  The live docroot was also still the pre-PWA bundle (381b `/order/`, no `sw.js`), so the page
  content itself changed under me in the same deploy; the after-state is consistent
  (`/order/` 1851b, `sw.js` JavaScript, manifest JSON, icons PNG) but "the 6 screens work" is
  not something this task tested.
- **The method-preservation evidence is local.** `POST /api` surviving the 308 as a POST is
  proven against the stand-in upstream (`fake-api.py` echoes the method). Live, the same POST
  chain ends in the service's JSON 404, which does not echo the method.
- **`/api` redirects rather than answering JSON at the edge.** A client that does not follow
  redirects (some SDKs, some curl invocations without `-L`) sees a 308 with an empty body for
  bare `/api`. That is deliberate, and documented at the directive; it is still a behaviour a
  reader might expect to be a JSON body.
- **Bare `/console` and bare `/order` (no trailing slash) now 404.** They used to answer the
  order document (the defect). They are not aliased the way `/` and `/api` are; nothing in the
  card asked for it and the apps' own links use the trailing slash. Called out so it is not a
  surprise: it is a deliberate, visible 404, not a silent wrong document.
- **No caddy(1) runs in CI.** The suite is still text assertions over the shipped file; the
  behavioural matrix that caught the inert redirects is a committed harness
  (`evidence/t_cdc4442b/harness/`) run by hand on caddy 2.6.2, not a CI gate. A future Caddyfile
  edit that produces a semantically different — or invalid — config still needs a human to run it.
- **Not a secret/security review.** The vhost change is routing only; `Cache-Control: no-store`,
  the loopback-only bind of cvm-orders and `handle_errors` are re-asserted, not re-audited.
- **Host state beyond the cvm-pwa block was not inspected.** The install used
  `rewrite-caddy-vhost.py`, which replaces only this domain's block (backup kept at
  `/etc/caddy/Caddyfile.vhostbak-20261010T203457Z`); `caddy fmt --overwrite` from the deploy does
  reformat the whole Caddyfile. Other domains were not re-verified.
- **Not merged, not reviewed.** The manager merges after verifying.
