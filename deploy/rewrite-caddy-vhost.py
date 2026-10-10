#!/usr/bin/env python3
"""Replace the Caddy site block for one domain — idempotent, fail-closed.

    rewrite-caddy-vhost.py <domain> <block-file> <caddyfile>

Removes every top-level site block whose opening line is `<domain> {` (brace
counted, so nested blocks survive the cut) and appends the contents of
<block-file>. Writes a .bak-<ts> copy first and then re-writes the file only if
the result differs, so re-running the deploy does not churn the Caddyfile.

Why not `grep -q && append`: the first cvm-pwa deploy appended a block, and a
later change to the block (the /api proxy) would have been silently skipped —
the host would keep serving the legacy vhost while the repo said otherwise.
"""
import re
import shutil
import sys
import time


def strip_block(text: str, domain: str) -> tuple[str, int]:
    keep: list[str] = []
    removed = 0
    depth = 0
    opener = re.compile(r"^" + re.escape(domain) + r"\s*\{")
    for line in text.splitlines(keepends=True):
        if depth == 0 and opener.match(line):
            removed += 1
            depth = line.count("{") - line.count("}")
            continue
        if depth > 0:
            depth += line.count("{") - line.count("}")
            if depth <= 0:
                depth = 0
            continue
        keep.append(line)
    return "".join(keep).rstrip("\n") + "\n", removed


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    domain, block_file, caddyfile = argv[1], argv[2], argv[3]

    with open(caddyfile, encoding="utf-8") as fh:
        original = fh.read()
    block = open(block_file, encoding="utf-8").read().strip("\n")

    if not re.search(r"^" + re.escape(domain) + r"\s*\{", block, re.MULTILINE):
        print(f"ERROR: {block_file} has no `{domain} {{` block — refusing to install", file=sys.stderr)
        return 1

    stripped, removed = strip_block(original, domain)
    updated = stripped + "\n" + block + "\n"

    if updated == original:
        print(f"   {domain}: vhost already current ({removed} block(s) matched)")
        return 0

    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    shutil.copy2(caddyfile, f"{caddyfile}.vhostbak-{stamp}")
    with open(caddyfile, "w", encoding="utf-8") as fh:
        fh.write(updated)
    print(f"   {domain}: replaced {removed} block(s); backup {caddyfile}.vhostbak-{stamp}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
