# Evidence — t_cdc4442b: the cvm-pwa vhost's unscoped catch-all

All outputs below are raw command output from this worktree (branch `worker-base/t_cdc4442b`),
not restated summaries. `caddy version` = **2.6.2**, the version the host runs, extracted from
`caddy_2.6.2-14_amd64.deb` (no install; run in place).

## The suite (the deliverable's tests)

| file | what it is |
|---|---|
| `RED-final-vs-shipped-vhost.txt` | `deno test --allow-read --allow-net --allow-env tests/` with the **final** test file against the **origin/main** vhost: `FAILED \| 162 passed \| 4 failed`, suite exit 1 |
| `GREEN-final-branch-vhost.txt` | the same suite against the **branch** vhost: `ok \| 166 passed \| 0 failed`, suite exit 0 |
| `RED-suite-vs-shipped-vhost-attempt2.txt` | the first RED run (attempt 2's commit c250a20), kept for provenance of the RED-first claim |
| `RED-matcher-slot-assertion.txt` | the added `redir`-matcher assertion proven RED against the ambiguous spelling `redir /api/ 308` and GREEN against `redir * /api/ 308` |

The branch vhost at the time of these runs: `deploy/caddy-vhost-cvm-pwa.caddy` sha
`f00cbeb8b0fa493ac9b3ebc8dbfff8a005427d2b`; the shipped one: sha `322022abf54d8d6507ff5788c74b0baf9d2fc479`.

## Real HTTP before/after (Caddy 2.6.2 + curl, same docroot layout `deploy-pwa.sh` ships)

| file | what it is |
|---|---|
| `local-matrix-OLD.txt` | origin/main vhost: `GET /api` → **200 text/html, 1851b, the order document**; `/style.css`, `/app.js`, `/nope`, `/` → the order document too |
| `local-matrix-NEW.txt` | branch vhost: `/api` → **308 → Location: /api/**; `/style.css`, `/app.js`, `/nope` → **404**; `/` → 302 → `/order/`; the app, its data, the manifest content-type and `/console/` all still 200 |
| `local-followthrough-OLD.txt` | origin/main: `curl -L /api` → final 200 `text/html`, 0 redirects, body = the order document |
| `local-followthrough-NEW.txt` | branch: `curl -L /api` → final **404 application/json** from the proxied service, 1 redirect; `POST /api` → the upstream sees **method POST** (308 preserves the method and the body) |
| `local-matrix-DOWN-old.txt` | origin/main with nothing on 127.0.0.1:8788: bare `/api` **still 200 + the order document** — the defect was never "the service is down" |
| `local-matrix-DOWN-new.txt` | branch with the service down: `/api` → 308 → `/api/` → **502 application/json** (the `handle_errors` block); `/style.css`, `/nope` → 404 |
| `caddy-adapt-redir-spellings.txt` | `caddy adapt` for ten candidate spellings — the finding behind the final fix |

## harness/

The scripts that produced the above, so the manager can re-run them (`SC` paths point at the
scratch dir used; `matrix.sh` rebuilds the docroot itself from `site/` + `vocab/`):

- `matrix.sh` — builds the docroot, generates both Caddyfiles, starts a stand-in cvm-orders on
  127.0.0.1:8788 (`fake-api.py`), runs the OLD/NEW GET matrices + follow-through, stops.
- `down.sh` — the upstream-DOWN pass (no listener on 8788) for both vhosts.
- `probe-redir.py` — adapts ten `redir` spellings and prints the resulting status/headers.
- `red-final.sh` — swaps in the origin/main vhost, runs the full suite, restores.
- `fake-api.py` — stand-in upstream that echoes the forwarded path and method.
- `old.caddyfile` / `new.caddyfile` — the generated local configs (site address
  `http://127.0.0.1:18080`, root pointed at the local docroot). `variants.caddyfile` is the
  spelling probe source.

### The finding, in one line

Caddy reads `redir`'s first argument as an optional inline matcher, and a token starting with
`/` **is** a path matcher, so `redir /api/ 308` adapts to `match path /api/ → 302, Location: 308`:
bare `/api` answered **200 with an empty body** instead of redirecting. Every `redir` in the
shipped vhost therefore names its matcher (`redir * /api/ 308`), and
`tests/pwa_vhost_test.ts` now fails if any `redir` target sits in the matcher slot.
