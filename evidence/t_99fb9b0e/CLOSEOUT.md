# t_99fb9b0e — close-out: fresh live re-check + evidence provenance

Re-measured 2026-10-10T05:53:54Z (UTC) from CobradorWave, after all commits were pushed.
Companion to `deploy-matrix.txt` (which holds the before/after/down/recovered matrix).

## Fresh live re-check (this run)

```
GET https://cvm-pwa.orangesync.tech/api/auth/challenge  200 application/json  {"nonce":"583acde7-…","facilitatorNpub":"npub1c03rad0r…","expiresIn":300}
GET https://cvm-pwa.orangesync.tech/api/orders/queue    200 application/json  {"orders":[]}
GET https://cvm-pwa.orangesync.tech/api/health          200 application/json  {"ok":true}
GET https://cvm-pwa.orangesync.tech/console/            200 text/html; charset=utf-8
GET https://cvm-pwa.orangesync.tech/order/              200 text/html; charset=utf-8
GET https://cvm-pwa.orangesync.tech/                    200 text/html; charset=utf-8
```

Host-side, same timestamp:

```
$ systemctl is-active cvm-orders.service   -> active
$ systemctl is-enabled cvm-orders.service  -> enabled
$ sudo ss -ltnp | grep 8788
LISTEN 0  511  127.0.0.1:8788  0.0.0.0:*  users:(("deno",pid=887563,fd=20))
$ systemctl is-active caddy                -> active
$ sudo grep -c cvm-pwa.orangesync.tech /etc/caddy/Caddyfile -> 2
```

## Screenshot provenance (honest)

`console-signin.png` is a real headless-Chromium capture of the **deployed** URL
`https://cvm-pwa.orangesync.tech/console/` (HTTP 200), 2560x1728.

Render verification method — **not** a vision model:

* Vision analysis was **unavailable**: `vision_analyze` on this PNG returns
  `503 - all providers exhausted (flat router)`, `model: glm-4.6v`. Same failure as during
  the deploy run. No vision verdict was ever produced, so none is claimed.
* Instead the render was verified two ways that are stronger than "it is not blank":
  1. **Pixel statistics** on the PNG: 2560x1728, 2322 distinct colours, mean luminance 0.079,
     sd 0.055 — i.e. real dark-theme page content, not an empty/white frame.
  2. **Live DOM text** dumped from the same deployed URL with the same Chromium
     (`--dump-dom`, see `console-dom.txt` in this directory):
     `TITLE: Facilitator console — facilitated sats orders`
     `VISIBLE_TEXT: … Facilitator console Sign in with the facilitator npub. The order service issues a challenge (GET /api/auth/challenge); your signer signs it as a NIP-98 event, and the signed challenge is attached to every call as authorization … No password, no session cookie. Sign in with Nostr …`
  Together: the deployed `/console/` serves the console's *own* document (title and copy are the
  console's, not the ordering app's), and it renders with the sign-in screen and its
  "Sign in with Nostr" control.

## What was NOT done (and why)

* **No sign-in was completed.** A NIP-98 signer is not available in this headless environment and
  server-side challenge verification does not exist yet (`t_d790103d`). The deliverable was
  "console is served + `/api` is proxied", not "auth works end-to-end".
* **The pay step is still not completable**, discovered only because the proxy now exists — see
  follow-up card `t_5198c7da` (order-create contract + missing `GET /orders/:id/invoice`).

## Card evidence (attached)

| attachment id | file | bytes | sha256 (verified byte-identical to this worktree) |
|---|---|---|---|
| 77 | `deploy-matrix.txt` | 4612 | `41e2c13f8eee4c7f873fd73c16092de9c8a2edb966d583de847bedf4e7e6cabe` |
| 78 | `console-signin.png` | 76976 | `24369c1ca9107c91f0f13fc04eebd29c738bd6e1ef223f58315a0d006b44bffb` |

Attach path: `hermes kanban --board contextvm-services attach t_99fb9b0e <path>`.
The `kanban_attach` tool was not used because its only input channel is base64 passed inline, and
the harness elides the middle of long base64 blobs in tool output — the bytes would have landed
corrupted. The CLI takes a path, so the delivered bytes were hashed and confirmed identical to the
source (above). Both attachments re-listed with `kanban_attachments` and verified.

## Commits (both pushed, local == origin, verified with `git rev-parse` after `git fetch`)

* cvm-registry `pr/facilitator-console`
  * `026f2d0` feat(deploy): repo-managed cvm-pwa vhost — /api proxy, per-app fallback, console route
  * `4f62056` docs(t_99fb9b0e): deploy record — curl matrix, rollback, and the two contract findings
  * `5ff1d27` evidence(t_99fb9b0e): live curl matrix (before/after/down) + console sign-in screenshot
* cvm-orders `pr/orders-bind-loopback` (PR #2)
  * `0da283f` fix(deploy): bind the order service to loopback by default
