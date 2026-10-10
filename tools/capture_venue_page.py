#!/usr/bin/env python3
"""Re-shoot ONE venue's own ordering page into `docs/e2e/` — nothing else.

Why this exists: `npm run e2e` attempts the click-through to the venues' own
pages only when EVERY venue answers its probe cleanly (`tools/run-e2e.mjs`).
One venue being Cloudflare-blocked therefore closes the click-through for BOTH
venues, and the two page stills (`02b-…png`, `03b-…png`) are never rewritten —
which is deliberate (re-shooting there would file a bot challenge as the
venue's page) but also means a venue whose page DOES answer cannot have its
still refreshed. This tool is the supported way to refresh the one still that
can be refreshed, and it uses the leg's own classification (`CHALLENGE_RE` from
`e2e/venue_deep_link_e2e.py`) so it cannot file a challenge as a page either.

It writes exactly the path the leg writes for that venue's index, so the file
it produces is the file the README already points at.

Usage
-----
    xvfb-run -a python3 tools/capture_venue_page.py doppelt-kaese-berlin
    python3 tools/capture_venue_page.py <slug> --headless   # no display needed

Exit codes: 0 still written; 2 no still written (challenged, unreachable, or a
bad slug/URL) — a non-zero exit here means the ON-DISK STILL IS UNCHANGED.
"""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "e2e"))

import venue_deep_link_e2e as leg  # noqa: E402  (path set up above on purpose)
from playwright.sync_api import sync_playwright  # noqa: E402


def log(msg: str) -> None:
    print(f"[capture] {msg}", flush=True)


def out_path(slug: str) -> pathlib.Path:
    """The exact filename the leg writes: index from the leg's own VENUES order."""
    idx = list(leg.VENUES).index(slug) + 2
    return leg.OUT / f"0{idx}b-venue-page-{slug}.png"


def main() -> int:
    ap = argparse.ArgumentParser(description="re-shoot one venue's own ordering page")
    ap.add_argument("slug", help="venue slug, as in e2e/venue_deep_link_e2e.py VENUES")
    ap.add_argument("--url", default=None,
                    help="override the URL (must match the announced deep-link; default: the leg's)")
    ap.add_argument("--out", default=None, help="override the output path")
    ap.add_argument("--headed", action="store_true",
                    help="headed browser (the Cloudflare-safe path; needs a display / xvfb-run)")
    ap.add_argument("--settle-ms", type=int, default=12_000,
                    help="wait after domcontentloaded before shooting (default 12000)")
    args = ap.parse_args()

    if args.slug not in leg.VENUES:
        log(f"FATAL: unknown slug {args.slug!r}. Known: {', '.join(leg.VENUES)}")
        return 2
    url = args.url or leg.VENUES[args.slug]
    if args.url and args.url != leg.VENUES[args.slug]:
        # The still is evidence that the ANNOUNCED deep-link resolves, so a URL
        # that differs from the one the leg verifies in the dashboard DOM is not
        # evidence of anything. Refuse rather than shoot the wrong page.
        log(f"FATAL: --url {args.url!r} != the announced deep-link {leg.VENUES[args.slug]!r}")
        return 2
    dest = pathlib.Path(args.out) if args.out else out_path(args.slug)

    launch_kwargs: dict = {"headless": not args.headed}
    channel = leg.resolve_channel() if args.headed else None
    if channel:
        launch_kwargs["channel"] = channel

    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_kwargs)
        ctx = browser.new_context(viewport={"width": 1280, "height": 800}, locale="de-DE")
        try:
            page = ctx.new_page()
            page.set_default_timeout(45_000)
            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_timeout(args.settle_ms)
            title = page.title()
            final_url = page.url
            body = (page.inner_text("body") or "")[:4000]
            log(f"title={title!r} final_url={final_url} "
                f"browser={'system chrome (channel=' + str(channel) + ')' if channel else 'playwright chromium'}")
            if leg.CHALLENGE_RE.search(f"{title}\n{body}"):
                log(f"REFUSING to write {leg.repo_rel(dest)}: a bot challenge answered "
                    f"(title={title!r}). The venue's own page was NOT reached, and filing "
                    f"the challenge as its page is the silent green the suite exists to kill.")
                return 2
            dest.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(dest), full_page=False)
        finally:
            ctx.close()
            browser.close()

    data = dest.read_bytes()
    log(f"wrote {leg.repo_rel(dest)} ({len(data)} bytes, sha256 {hashlib.sha256(data).hexdigest()})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
