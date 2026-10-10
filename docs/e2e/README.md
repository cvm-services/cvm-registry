# End-to-end evidence — restaurant announcements → dashboard → the venue's own ordering page

Hermetic capture, 2026-10-05; stills and video re-shot against the current
dashboard. Every step below ran for real; nothing is mocked on the CVM path.
Re-run the whole suite with `npm run e2e` (see Reproducing).

## What is actually exercised

```
venues/<slug>/venue.json
  -> tools/emit-venue-announcement.ts   signed kind 11317, ONE KEY PER VENUE
  -> strfry relay  ws://127.0.0.1:7781  plain relay (no NIP-29 write policy)
  -> collector/collect.ts               allow-list applied, fail-closed
  -> site/catalog.json                  static cache
  -> site/index.html                    real browser, real click
  -> the venue's own ordering page
```

## What is NOT in this flow (labelled, not faked)

- **No ContextVM / MCP server call.** The announcement *declares* an `order`
  tool; this capture ends at the venue's own ordering rail.
- **No ring signature / anonymous-set proof.** The ring gate lives in
  `cvm-services/contextvm-services#pr/s4b-ring-gate` and is not part of this run.
- **No payment.** Nothing is bought, quoted, or settled.

## Provenance (from `venue-discovery-e2e.json`)

| venue | announced `r` | final URL | page title |
|---|---|---|---|
| doppelt-kaese-berlin | https://www.doppelt-kaese-berlin.de/speisekarte/doppeltkase | same (no redirect) | `Speisekarte \| doppelt Käse Berlin` |
| pizza-e-pasta-ruedesheimerplatz | https://pizzaepasta-ruedesheimerplatz.de/pizza-e-pasta/takeaway | same (no redirect) | `Essen bestellen bei Pizza e Pasta in Berlin` |

Relay read-back after publish: exactly 2 events, kind 11317, distinct pubkeys
(one per venue), each carrying `cvm:service:restaurant`, `cvm:tier:fulfilment`,
`g` geohashes and its `r` deep-link.

Collector: `raw=2 deduped=2 kept=2 dropped=0`.
Dashboard: `2 allow-listed announcement(s) from 3 curator(s), 2 shown after filters`.

Re-running the suite **rewrites** the committed `venue-discovery-e2e.*` here: the
`.webm`/`.mp4` byte counts change with every recording (measured: 1061464 → 901975
bytes for the same 2-venue capture) and the two dashboard PNGs differ by a few
hundred bytes. That churn is expected, not drift — the committed artifacts are
from a real run of the code at `39e0959`, and a `git status` after a local run is
normally non-empty for exactly these five paths. Don't "fix" it by ignoring the
files: they are tracked on purpose, because this card exists to put the evidence
in history rather than in an attachment.

## Video

[`venue-discovery-e2e.mp4`](venue-discovery-e2e.mp4)

<video src="venue-discovery-e2e.mp4" controls width="100%"></video>

The recording shows: dashboard load → both venue cards → the announcement's
declared tier and input appetite → click the first card's ordering deep-link →
**doppelt Käse's real Speisekarte** → back → click the second → **Pizza e Pasta's
real ordering page**.

## Stills

Dashboard, both venues:

![dashboard with both venue cards](01-dashboard-two-venues.png)

The card, and the real page it opens:

![doppelt-kaese-berlin card](02-card-doppelt-kaese-berlin.png)
![doppelt-kaese-berlin real menu page](02b-venue-page-doppelt-kaese-berlin.png)

![pizza-e-pasta card](03-card-pizza-e-pasta-ruedesheimerplatz.png)
![pizza-e-pasta real ordering page](03b-venue-page-pizza-e-pasta-ruedesheimerplatz.png)

Freshness: `01-dashboard-two-venues.png`, `03-card-…png` and
`04-review-venue-confirmed.png` are re-shot by **every** run of `npm run e2e`
(the suite rewrites the evidence in this directory — that is how they stay
current). `02b-…png` and `03b-…png` are the two venue pages and are **not**
rewritten by `npm run e2e`: the click-through gate is all-or-nothing (it opens
the venue pages only when *every* venue answers its probe cleanly), and pizza is
Cloudflare-blocked from this host, so the suite never opens either page here.

`02b` was **re-shot through this repo's own tool** on 2026-10-10 by
`tools/capture_venue_page.py` (below) — the exact path the leg writes, classified
with the leg's own `CHALLENGE_RE`. The result is byte-identical to the committed
file (368501 bytes, sha256
`0f99aacd363b81bfa39e9c656103c128913ce229fcf002cdfc774a8732f53553`), so the
doppelt still is current, not a stale carry-over. History note, because it is
load-bearing: commit `34209ac` had overwritten this file with a nearly-uniform
blank frame (17602 bytes, mean 0.996, zero OCR text) while this README went on
calling it the venue's page; the real capture was restored here.

`03b` is the pizza page from the full-fidelity capture and **cannot** be
refreshed from this host: pizza answers `Attention Required` (Cloudflare) to any
client here, so a re-shoot would file a bot challenge as the venue's page. It
stays as captured until someone runs the capture on a host the venue answers.

### Refreshing one venue's page still

```bash
# the Cloudflare-safe path: headed system Chrome under a display
xvfb-run -a python3 tools/capture_venue_page.py doppelt-kaese-berlin --headed
```

The tool writes exactly the filename the leg writes for that venue, refuses to
write anything (exit 2, on-disk still unchanged) when a bot challenge answers or
the URL differs from the announced deep-link, and prints the title, the final URL,
the browser it used and the sha256 of what it wrote. It is the supported way to
refresh a single still when the all-or-nothing gate above is closed by the other
venue.

## Reproducing

```bash
npm ci          # installs the pinned Playwright (the lockfile is committed)
npm run e2e     # all four scripts, one PASS/FAIL/SKIP summary
```

`npm run e2e` is the entry point. It checks for a browser, installs Playwright's
Chromium if none is present, provisions `site/catalog.json` from the committed
capture (`fixtures/e2e-dashboard.catalog.json`) and serves `site/` on loopback, so
the two offline legs need **no relay, no collector and no live origin**. The other
two legs are network-gated against the deployment.

| selector | legs | needs |
|---|---|---|
| `npm run e2e` | all four | a browser; the open network for the last two |
| `npm run e2e:hermetic` | `catalog_render_e2e.mjs`, `venue_deep_link_e2e.py` | a browser |
| `npm run e2e:live` | `dashboard-discovery.mjs`, `live_deploy_check.mjs` | the open network |

## In CI

`.ngit/act/workflows/ci.yml` runs `npm run e2e:hermetic` as the **gate** and
`npm run e2e:live` as an **observational** leg. The gate can only fail for the
code's reasons: the hermetic legs serve the committed capture on loopback, so no
relay outage or Cloudflare challenge can turn them red. The live legs still run,
still print their PASS/FAIL/SKIP rows and verdict into the job log, and still exit
non-zero locally; the step is marked non-gating in exactly one place
(`continue-on-error: true`, with `E2E_ALLOW_SKIP=1` and a comment saying why).
This is not `|| true`: the check still executes and still speaks.

Measured, not asserted — ngit CI at `791f5a4a`:

```
CI for 791f5a4a (791f5a4a)
  success    .ngit/act/workflows/ci.yml  [Maintainer-directed]  Requested by a maintainer
    integrity: commit present, workflow hash matches
    job deno success [Maintainer-directed]
    job e2e success [Maintainer-directed]
  concluded (success)
```

The commit before the fix (`34209ac`) failed this same job on the evidence
convenience, which is the bug this branch removes.

Exit codes: `0` every leg ran and passed; `1` a leg failed; `3` a leg was
SKIPPED — **a skip is never a pass**, and it prints a loud banner. Only
`E2E_ALLOW_SKIP=1` downgrades that to a warning, and only an operator should set
it. Running the suite rewrites the evidence files in this directory; that is
intentional (it is how they stay current).

A literal clean-clone run — `git clone` into an empty directory, `npm ci`,
`npm run e2e` — is recorded verbatim in
[`clean-clone-transcript.txt`](clean-clone-transcript.txt): exit 0, 4 passed,
0 failed, 0 skipped, with the browser fallback shown rather than assumed.

There is also a fast check with no browser, no relay and no network:

```bash
python3 e2e/transcode_mp4_selftest.py    # 4/4 — evidence transcoding is never fatal
```

It pins the contract that a missing `ffmpeg` degrades the evidence and never the
run — the bug that made the `e2e` job red in CI. Case 2 reproduces that failure
exactly (Playwright's bundled build rejects `-movflags +faststart` with exit 8).

### One sub-assertion can be NOT verified inside a passing leg

The click-through to the venues' **own** pages is the one thing this suite cannot
promise on every host. Both venues sit behind Cloudflare, and the headless shell
is challenged where headed Chrome is not (`title='Just a moment...'` — observed in
ngit CI). So the click-through is attempted only when **every** venue answers the
probe cleanly AND the run has a headed browser (`xvfb-run` + system Chrome), or
when `E2E_VENUE_PAGES=1` asks for it anyway. When it is not attempted:

- a banner says `NOT VERIFIED — the venue pages are not opened`;
- the probe result for each venue is printed, so the reason is the data, not a guess;
- the leg's own detail line reads `venue click-through NOT verified (…)`, and the
  `=== E2E SUMMARY ===` block repeats it next to the verdict.

The dashboard and the announced deep-links (read from the rendered DOM) are
asserted either way. A venue page that answers with a bot challenge is recorded as
`challenged: true` with a note — never as a verified page, because a leg that
passes while the venue's page never loaded is exactly the silent-green failure
this suite exists to kill.

The full-fidelity replay — real relay, real signatures, real collector — is the
longer path below. It needs `strfry` and is not what `npm run e2e` does:

```bash
# 1. a plain local relay (the fleet's 7780 is a NIP-29 relay and rejects these kinds)
strfry --config=~/.hermes/state/e2e-relay/strfry.conf relay &   # 127.0.0.1:7781

# 2. publish both announcements — one key per venue (kind 11317 is replaceable,
#    so a shared key makes the second announce silently overwrite the first)
deno run --allow-read --allow-net --allow-write tools/emit-venue-announcement.ts \
  --venue venues/doppelt-kaese-berlin/venue.json --kind 11317 \
  --key-file .scratch/doppelt-kaese-berlin.nsec --relays ws://127.0.0.1:7781
deno run --allow-read --allow-net --allow-write tools/emit-venue-announcement.ts \
  --venue venues/pizza-e-pasta-ruedesheimerplatz/venue.json --kind 11317 \
  --key-file .scratch/pizza-e-pasta-ruedesheimerplatz.nsec --relays ws://127.0.0.1:7781

# 3. collect
deno run --allow-net --allow-read --allow-write collector/collect.ts \
  --relays ws://127.0.0.1:7781 --allowlist fixtures/curators.e2e.json \
  --out site/catalog.json --policy policy.json --vocab vocab/service-inputs.json

# 4. serve and capture (headed Chrome under xvfb: the headless shell is
#    Cloudflare-challenged on the pizza venue)
python3 -m http.server 8137 --bind 127.0.0.1 --directory site &
xvfb-run -a python e2e/venue_deep_link_e2e.py --headed
```

`fixtures/curators.e2e.json` is the **e2e-only** allow-list: it adds the two
venue service keys so the collector renders them instead of dropping them
fail-closed. The public deployment keeps `curators.json`.
