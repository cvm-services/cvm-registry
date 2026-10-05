# Deploying the dashboard — `cvm.orangesync.tech`

The dashboard is a **static site plus a collector timer**. There is no server
process, no database and no relay connection at page-view time.

```
        (every 10 min)                                  (page load)
relays ──► cvm-collector.service ──► site/catalog.json ──► caddy file_server ──► browser
             deno, allow-list           static file          /opt/tollgate/cvm-dashboard/site
             dedupe + classify          policy.json
```

## Where it runs, and why

| item | value |
| --- | --- |
| host | **vps3 / `hermes` — 23.182.128.219** |
| web root | `/opt/tollgate/cvm-dashboard/site` |
| collector | `cvm-collector.timer` (systemd, every 10 min) |
| web server | the existing system Caddy on vps3 (`/etc/caddy/Caddyfile`) |
| DNS | explicit `A cvm.orangesync.tech → 23.182.128.219` (unproxied) |

**Host choice.** `tollgate-infrastructure` says: *"AVX2 needed? vps2. Otherwise
vps3 (more RAM/disk)."* A static site and a Deno collector need no AVX2, so vps3
is the documented pick. It also happens to be the host we can reach: vps2's sshd
is not answering on 22 and its 2222 is publickey-only with no authorised key.

**DNS.** `*.orangesync.tech` is a wildcard `A` at 23.182.128.51 (vps2), and since
2026-07-15 nothing has served `cvm` there (plain HTTP 308 → broken TLS on the
wildcard vhost). An explicit record for `cvm` overrides the wildcard; rollback is
deleting it.

## Deploy / redeploy

```sh
# from a host with deno + relay access (CobradorWave)
HOST=debian@23.182.128.219 bash deploy/deploy.sh
```

`deploy.sh` builds a first catalog, ships the bundle (site/, collector/, vocab/,
policy.json, curators.json) to `/opt/tollgate/cvm-dashboard`, installs the deno
binary at `/usr/local/bin/deno` if missing, and runs `deploy/cvm-remote-setup.sh`
on the host, which writes the systemd units and (once) appends the Caddy block:

```caddyfile
cvm.orangesync.tech {
	root * /opt/tollgate/cvm-dashboard/site
	file_server
	encode gzip
	header {
		Cache-Control "no-cache"
		X-Content-Type-Options "nosniff"
	}
}
```

> **Note for the infra kit.** The vps3 Caddyfile is *not* managed by
> `tollgate-infrastructure-kit` today (only `blossom2` and `git` blocks live
> there, and `/opt/tollgate` is hand-managed for blossom/grasp too). When the
> Caddy role grows a vhost list, move this block into it so an ansible run does
> not drop it.

### Gotchas found while deploying (do not rediscover)

- **403 from a root-owned tree.** `sudo mkdir -p` under a restrictive umask left
  `/opt/tollgate/cvm-dashboard` at `0700`; Caddy runs as user `caddy` and got
  `403` on every path. `cvm-remote-setup.sh` now sets `/opt/tollgate` to `0711`
  (traverse, not list) and the dashboard tree to `0755`/`0644`.
- **Certificate timing.** Caddy issues the cert by HTTP-01, so the DNS record
  must exist *before* the first successful issue. Create DNS, then
  `systemctl reload caddy`. Verified cert: `CN=cvm.orangesync.tech`,
  issuer `Let's Encrypt YE2`.
- **Deno, not Node, and no package manager.** The image ships no deno and no
  working node (`/usr/bin/node` dies with `undefined symbol:
  sqlite3session_attach`). `deploy.sh` copies the host-agnostic deno binary.
- **The collector needs no npm.** Everything is Deno stdlib only.

## What is deployed today (verified 2026-10-05)

```
$ curl -sI https://cvm.orangesync.tech/
HTTP/2 200
cache-control: no-cache
server: Caddy
x-content-type-options: nosniff

$ echo | openssl s_client -connect cvm.orangesync.tech:443 -servername cvm.orangesync.tech \
    | openssl x509 -noout -subject -issuer
subject=CN=cvm.orangesync.tech
issuer=C=US, O=Let's Encrypt, CN=YE2

$ curl -s https://cvm.orangesync.tech/catalog.json
{ "generated_at_iso": "2026-10-05T02:22:52.000Z",
  "counts": { "raw_events": 66, "after_dedupe": 66, "kept": 0, "dropped_not_allowlisted": 66 },
  "relays": [["wss://relay.damus.io", true, 66], ["wss://relay2.orangesync.tech", true, 0]],
  "curators": 1, "entries": 0,
  "policy": { "fresh_ttl_seconds": 900, "max_age_seconds": 21600, "clock_skew_seconds": 120 } }
```

**`kept: 0` is the correct state, not a failure.** The allow-list holds one
curator and that npub has not announced a service yet, so the page renders
nothing and says why (ADR-0001 D12a: an empty allow-list renders nothing, fail
closed). The registry cannot invent providers; the moment the curator publishes a
`11316` the next timer tick makes it visible.

What *is* proven is the render path, on **real captured relay events** with a
demo allow-list (`fixtures/`, see `fixtures/README.md`):

```
$ deno run --allow-read collector/render_check.ts --catalog fixtures/demo-catalog.json --now 1791167060
cache state        fresh — cache is 60s old (ttl 900s)
render entries     true       live claims true
RENDERED: 6 entries as LIVE

$ ... --now 1791174200      # 2 h old
cache state        stale — older than the 900s freshness ttl
render entries     true       live claims false
banner             STALE CACHE — Showing a cached snapshot only; nothing here is live.

$ ... --now 1791339800      # 2 days old
cache state        expired    render entries false   disabled true
RENDERED: (nothing — catalog disabled)
```

## Freshness contract (`policy.json`)

| age | state | behaviour |
| --- | --- | --- |
| ≤ 900 s | fresh | entries presented as current |
| 900 s – 6 h | stale | entries shown **only** as a labelled cached snapshot; banner; **every live claim disabled** |
| > 6 h | expired | catalog **disabled**, nothing rendered |
| missing / future-dated | invalid | catalog **disabled** (fail closed) |

Change the numbers in `policy.json`, redeploy. The collector copies the policy
into the catalog verbatim so the page and the builder cannot disagree.

## Changing the curation

Edit `curators.json`, commit, redeploy (`deploy/deploy.sh`) — that is the whole
process (ADR-0001 D12a). A fork with a different list is a different curator.

## Rollback

```sh
# stop refreshing, then remove the vhost
ssh debian@23.182.128.219 'sudo systemctl disable --now cvm-collector.timer'
# and delete the A record for cvm.orangesync.tech (the wildcard takes over again)
```

## Known limits (state them, do not paper over them)

- **The collector does not verify event signatures.** It trusts the relay's
  answer and then the allow-list. A relay could serve a correctly-allow-listed
  pubkey with an invalid `sig` and the entry would render. Verification is the
  obvious next commit; today the allow-list is the only gate.
- **`#g` is exact match.** The page filters geohashes by substring locally on the
  cache; the relay prefilter would need the publisher's precisions (ADR-0001 D3).
- **The tier prefilter is a prefilter.** Server-side `#t` values are OR, so the
  field-level AND is always computed locally (`matchesFieldAnd`), never reported
  from a relay count (D14).
- **No live CVM calls, by design.** The page never opens a relay connection.
