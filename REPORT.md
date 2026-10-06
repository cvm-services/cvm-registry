# REPORT — dashboard-side discovery evidence

## What this is
A recorded, asserted run of the live registry dashboard
(https://cvm.orangesync.tech/) that ends on the venue's own ordering page.

## Scope (operator choice, 2026-10-06)
DISCOVERY ONLY. No cart, no address, no payment. The run stops the instant the
browser lands on the venue's own host, so the video cannot imply a completed
order. Rationale: the `order` tool declares zero arguments and returns a URL —
today a venue CVM is a discovery pointer, not an orderable service.

## Result (live, run 2026-10-06T17:22Z)
- dashboard loaded: both venues + the two digital services rendered
- `meatspace` chip present; clicking it kept both pickup venues and dropped
  `cvm-lambda-01` and `nosms` — the facet behaves live
- clicked through to https://www.doppelt-kaese-berlin.de/ ("Best Burger in Berlin Wilmersdorf")
- verdict: PASS

## Artifacts
- evidence/e2e-discovery/dashboard-discovery.mp4 — the recording
- evidence/e2e-discovery/facts.json — machine-readable step log + verdict
- e2e/dashboard-discovery.mjs — the recorder

## Run
    xvfb-run -a --server-args="-screen 0 1440x1000x24" node e2e/dashboard-discovery.mjs

## Not verified / honest limits
- the video shows the venue's page, NOT an order being placed
- the card facts (pickup wait, per-method prices) come from the registry PR #8,
  which is verified but not yet merged/deployed — the video is against live main
- vendor CDN video transcoding is unavailable for GitHub-attached files; the mp4
  is committed to the branch and linked from the PR
