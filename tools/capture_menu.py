#!/usr/bin/env python3
"""capture_menu.py — build `site/menu.json` from a REAL venue CVM over a real relay.

The dashboard's service view reads ONE static file, `menu.json` (site/app.js,
`MENU_CAPTURE_URL`). This script produces it, and it does so by capturing a live
`tools/call menu` round-trip rather than re-deriving the file from a repo — the
file is evidence, not a build product.

The wire protocol is NOT reimplemented here. We drive the venue server's own
`e2e_client.ts` (single source of truth for the ContextVM transport, and the only
client that proves the server's transport interops with the documented protocol),
and shape its `--json` transcript into the capture the dashboard expects.

Shape written (what site/app.js reads):

    {
      "venues": [ { venve..., "items": [...], "item_count": N } ],   # the menu tool's own result
      "tools":  ["menu", "order"],                                  # the served tools/list
      "_provenance": { ... who/when/how, per venue ... }
    }

Usage:
    tools/capture_menu.py                      # both venues
    tools/capture_menu.py --venue <slug>       # one venue

Env:
    CTXVM_REPO   path to a contextvm-services checkout (default ~/repos/contextvm-services)
    CTXVM_RELAYS comma-separated wss:// (default wss://relay.primal.net)
    KEY_DIR      venue key files (default ~/.hermes/secrets/venues)

The pubkey used per venue is DERIVED from the venue's own key file, so the capture
cannot silently target the wrong announced identity. The secret itself is never
printed and never leaves the key file: only `nak decode <npub>` runs.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CTXVM_REPO = Path(os.environ.get("CTXVM_REPO", Path.home() / "repos" / "contextvm-services"))
RELAYS = os.environ.get("CTXVM_RELAYS", "wss://relay.primal.net")
KEY_DIR = Path(os.environ.get("KEY_DIR", Path.home() / ".hermes" / "secrets" / "venues"))
DENO = os.environ.get("DENO", str(Path.home() / ".local" / "bin" / "deno"))
NAK = os.environ.get("NAK", str(Path.home() / ".local" / "bin" / "nak"))

CLIENT = CTXVM_REPO / "services" / "restaurant-cvm" / "e2e_client.ts"


def pubkey_of(slug: str) -> str:
    """Derive the announced pubkey (hex) from the venue's own key file."""
    key_file = KEY_DIR / f"{slug}.nsec"
    if not key_file.is_file():
        sys.exit(f"no key file for '{slug}' at {key_file}")
    text = key_file.read_text()
    m = re.search(r"NPUB=(npub1[a-z0-9]+)", text)
    if not m:
        sys.exit(f"no NPUB= field in {key_file}")
    out = subprocess.run([NAK, "decode", m.group(1)], capture_output=True, text=True)
    pk = out.stdout.strip().splitlines()[0].strip() if out.stdout.strip() else ""
    if not re.fullmatch(r"[0-9a-f]{64}", pk):
        sys.exit(f"could not derive a pubkey from {key_file}: {out.stderr.strip()[:200]}")
    return pk


def capture(slug: str, timeout_ms: int) -> dict:
    """Run one live tools/list + tools/call menu round-trip; return the shaped venue."""
    pk = pubkey_of(slug)
    cmd = [
        DENO, "run", "--allow-net", "--allow-read", "--allow-env", str(CLIENT),
        "--server", pk,
        *[a for relay in RELAYS.split(",") for a in ("--relay", relay.strip())],
        "--venue", slug,
        "--json",
        "--timeout-ms", str(timeout_ms),
    ]
    print(f"[capture] {slug}: {pk[:16]}... over {RELAYS}", file=sys.stderr)
    proc = subprocess.run(cmd, cwd=CTXVM_REPO, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f"e2e_client failed for {slug} (exit {proc.returncode}):\n{proc.stdout[-1500:]}\n{proc.stderr[-1500:]}")
    try:
        doc = json.loads(proc.stdout)
    except json.JSONDecodeError:
        sys.exit(f"e2e_client did not emit JSON for {slug}:\n{proc.stdout[-1500:]}")

    if not doc.get("all_passed"):
        failed = [c for c in doc.get("checks", []) if not c.get("ok")]
        sys.exit(f"{slug}: the round-trip did not pass all checks: {failed}")

    def call_text(entry: dict) -> str:
        return ((entry.get("mcp") or {}).get("result") or {}).get("content", [{}])[0].get("text", "")

    menu_text = None
    tools: list[str] = []
    for entry in doc.get("transcript", []):
        if entry.get("method") == "tools/list":
            names = (((entry.get("mcp") or {}).get("result") or {}).get("tools") or [])
            tools = [t.get("name") for t in names if t.get("name")]
        if entry.get("tool") == "menu":
            menu_text = call_text(entry)

    if menu_text is None:
        sys.exit(f"{slug}: no tools/call menu result in the transcript")
    # The tool answers `{ total_items, venues: [ {venue_slug, name, currency,
    # item_count, items} ] }` — one entry per announced identity this server serves.
    doc_menu = json.loads(menu_text)
    entries = doc_menu.get("venues") or []
    if len(entries) != 1:
        sys.exit(f"{slug}: expected exactly 1 venue block, got {len(entries)}")
    menu = entries[0]

    # Refuse a capture that disagrees with the identity we asked for — a mismatch
    # here means we would publish another venue's menu under this venue's slug.
    if menu.get("venue_slug") != slug:
        sys.exit(f"{slug}: server answered for '{menu.get('venue_slug')}' instead")
    if not menu.get("items"):
        sys.exit(f"{slug}: menu carries no items")
    if menu.get("item_count") != len(menu["items"]):
        sys.exit(f"{slug}: item_count {menu.get('item_count')} != {len(menu['items'])} items")
    if doc_menu.get("total_items") != len(menu["items"]):
        sys.exit(
            f"{slug}: the tool's total_items {doc_menu.get('total_items')} != "
            f"{len(menu['items'])} items in the block we took"
        )

    menu["_capture"] = {
        "captured_at": int(time.time()),
        "server_pubkey": doc.get("server_pubkey"),
        "client_pubkey": doc.get("client_pubkey"),
        "relays": doc.get("relays"),
        "method": "tools/call menu (JSON-RPC over ContextVM; kind 1059 gift-wrap, NIP-44)",
        "checks": doc.get("checks"),
        "tool": "services/restaurant-cvm/e2e_client.ts --json",
    }
    print(
        f"[capture] {slug}: {len(menu['items'])} items, tools={tools}, "
        f"server={menu['_capture']['server_pubkey'][:16]}...",
        file=sys.stderr,
    )
    return {"venue": menu, "tools": tools}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--venue", action="append", default=None, help="venue slug (repeatable; default: all)")
    ap.add_argument("--out", default=str(REPO / "site" / "menu.json"))
    ap.add_argument("--timeout-ms", type=int, default=60000)
    args = ap.parse_args()

    if not CLIENT.is_file():
        sys.exit(f"e2e_client not found at {CLIENT} — set CTXVM_REPO")

    venues = args.venue or ["doppelt-kaese-berlin", "pizza-e-pasta-ruedesheimerplatz"]
    results = [capture(slug, args.timeout_ms) for slug in venues]

    tools = sorted({t for r in results for t in r["tools"]})
    doc = {
        "venues": [r["venue"] for r in results],
        "tools": tools,
        "_provenance": {
            "what": "A live capture of each venue CVM's own `menu` tool result, over a real relay.",
            "why": "site/app.js reads exactly this file; the dashboard must not invent a menu.",
            "how": "tools/capture_menu.py -> services/restaurant-cvm/e2e_client.ts --json",
            "relays": [r.strip() for r in RELAYS.split(",")],
            "note": "Regenerate rather than hand-edit; each venue block carries its own _capture block.",
        },
    }
    out = Path(args.out)
    out.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    total = sum(len(v["items"]) for v in doc["venues"])
    print(f"[capture] wrote {out} — {len(doc['venues'])} venue(s), {total} items, tools={tools}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
