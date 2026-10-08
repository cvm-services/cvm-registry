# ngit CI for cvm-registry

`.ngit/act/workflows/ci.yml` is the Nostr CI lane. It exists because the code tier is otherwise
unverifiable: the repo carries no CI at all (no `.github/workflows`, no `.ngit/act/workflows`), so
`ngit_ci_evidence.py cvm-registry --commit <sha>` could never find a kind-9842 result for any head,
and every code card on the `cvm-registry` board was structurally blocked at the code tier (operator
card `t_5de8e74f`; most recently it blocked the phase-0 spike card `t_40a1b65b` even after its PR
#11 was merged as `6ec6f28`).

Nostr CI reads `.ngit/act/workflows/` **only** — `.github/workflows/` is detected but never
executed — so adding this file cannot disturb a GitHub lane (and none exists here).

## What it runs

cvm-registry has **no `deno.json` and no `package.json`**: there is no `deno task check|test` to
delegate to, so the workflow runs the repo's real commands explicitly. There is nothing for the
workflow to drift from — the commands are the same ones a contributor runs locally.

| step       | command                                                | local result on `6ec6f28`                 |
| ---------- | ------------------------------------------------------ | ----------------------------------------- |
| type check | `deno check collector/ tests/`                         | exit 0 (17 modules checked)               |
| unit tests | `deno test --allow-read --allow-net --allow-env tests/` | 112 passed / 0 failed, exit 0             |

Both were verified from a **cold cache** (`DENO_DIR` pointed at an empty `mktemp -d`), i.e. the same
nothing-cached state a fresh runner starts in. The suite has **zero remote imports** (no
`npm:`/`jsr:`/`https:` specifiers anywhere in `collector/`, `tests/`, or `site/render/`), so a cold
runner resolves nothing from the network — the run is identical warm or cold. `--allow-net` is
required only by `tests/link_check_test.ts`, which starts a **loopback** `Deno.serve` on
`127.0.0.1:0`; no external host is contacted. `--allow-env` is required by the tests' policy/env
fixtures.

Pins: `actions/checkout` v4 and `denoland/setup-deno` v2.0.5 by commit SHA, `deno-version: v2.9.0`
(the version the repo is developed against).

## What it deliberately does NOT gate

- **`deno fmt --check`** and **`deno lint`**: both are **pre-existing red** on `main` (`deno fmt`
  flags ~40 files, mostly markdown under `docs/` and `evidence/`; `deno lint` reports 47 problems,
  mostly unused type imports). They are not a gate here because making the suite red at the tip
  would hide real regressions. Fixing them is separate work.
- **`e2e/` and `collector/collect.ts`**: the live collector talks to real Nostr relays over
  WebSocket and the e2e lane drives a real browser against a served site — neither is hermetic, and
  a relay outage or network change would report as a repo failure. The hermetic unit suite in
  `tests/` covers the classification, policy, catalog, render-spec, and link-check logic they build
  on.
