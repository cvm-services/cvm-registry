#!/usr/bin/env python3
"""tools/make_pwa_icons.py — regenerate the order client's installable icons.

The order client at /order/ needs *raster* PNG icons; Chrome's Android install
prompt refuses an .svg-only icon set. These are the exact bytes shipped in
site/order/, so they are generated from source rather than hand-edited:

    python3 tools/make_pwa_icons.py            # writes site/order/*.png
    python3 tools/make_pwa_icons.py --check    # verify only, write nothing

Deliberately dependency-free (stdlib zlib/struct and a scanline rasteriser):
the workstation's Pillow install has no working `_imaging` extension, and a
build tool that cannot run on the deploy host is not a build tool.

Design: the ordering surface is amber-on-paper (#f59e0b accent on #f6f5f2 bg in
site/order/style.css), so the tile is a full-bleed amber (#f59e0b) square with
the lightning bolt in ink (#1c1b18) - the cheapest way to read as a "sats" app
at 48px in a launcher.

Two scale factors, deliberately:
  * `any`      - the bolt spans ~74% of the tile (the launcher shows it as-is),
  * `maskable` - the bolt is pulled inside the 80% safe circle Android crops to,
                 so an adaptive launcher can round/squash the tile without
                 clipping the glyph. Measured, not assumed: the script reports
                 the drawn glyph's maximum radial extent and fails closed.

Full-bleed background on every variant (no transparent corners): iOS composites
app icons under its own mask, and a transparent "any" icon renders as a black
tile on some Android launchers.
"""
from __future__ import annotations

import argparse
import math
import struct
import sys
import zlib
from pathlib import Path

AMBER = (245, 158, 11)  # --accent in site/order/style.css
INK = (28, 27, 24)      # --ink

# Classic bolt, centred on (50, 50) inside a 100x100 design box.
BOLT = [(59.0, 8.0), (28.0, 54.0), (45.0, 54.0), (38.0, 92.0), (72.0, 46.0), (52.0, 46.0)]
DESIGN = 100.0

# (filename, pixel size, scale of the design box, kind)
ICONS = [
    ("icon-192.png", 192, 0.88, "any"),
    ("icon-512.png", 512, 0.88, "any"),
    ("icon-maskable-192.png", 192, 0.68, "maskable"),
    ("icon-maskable-512.png", 512, 0.68, "maskable"),
    ("apple-touch-icon.png", 180, 0.88, "any"),
]

GLYPH_DARK_MAX = 110  # mean channel value below which a pixel counts as ink


def bolt_points(size: int, scale: float) -> list[tuple[float, float]]:
    """Design-box points -> pixel points, centred on the tile."""
    u = size / DESIGN * scale
    c = size / 2.0
    return [(c + (x - 50.0) * u, c + (y - 50.0) * u) for x, y in BOLT]


def draw_bolt(size: int, scale: float, ss: int) -> bytearray:
    """Rasterise the tile at `size * ss`, returning RGB bytes."""
    w = h = size * ss
    px = bytearray(bytes(AMBER) * (w * h))
    pts = bolt_points(w, scale)
    edges = list(zip(pts, pts[1:] + pts[:1]))
    ink = bytes(INK)
    for y in range(h):
        yc = y + 0.5
        xs: list[float] = []
        for (x1, y1), (x2, y2) in edges:
            if (y1 <= yc < y2) or (y2 <= yc < y1):
                xs.append(x1 + (yc - y1) / (y2 - y1) * (x2 - x1))
        xs.sort()
        for i in range(0, len(xs) - 1, 2):
            x0 = max(0, math.ceil(xs[i] - 0.5))
            x1 = min(w, math.floor(xs[i + 1] - 0.5) + 1)
            for x in range(x0, x1):
                o = (y * w + x) * 3
                px[o:o + 3] = ink
    return px


def downsample(px: bytearray, size: int, ss: int) -> bytes:
    """Box-filter `ss`x`ss` blocks -> one RGB pixel each (antialiasing)."""
    w = size * ss
    n = ss * ss
    out = bytearray(size * size * 3)
    for y in range(size):
        for x in range(size):
            r = g = b = 0
            for dy in range(ss):
                base = ((y * ss + dy) * w + x * ss) * 3
                for dx in range(ss):
                    o = base + dx * 3
                    r += px[o]
                    g += px[o + 1]
                    b += px[o + 2]
            o = (y * size + x) * 3
            out[o] = r // n
            out[o + 1] = g // n
            out[o + 2] = b // n
    return bytes(out)


def encode_png(width: int, height: int, rgb: bytes) -> bytes:
    """Minimal 8-bit truecolour PNG (filter 0 rows, zlib)."""
    raw = bytearray()
    stride = width * 3
    for y in range(height):
        raw.append(0)  # filter type 0 = None
        raw += rgb[y * stride:(y + 1) * stride]

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def png_size(blob: bytes) -> tuple[int, int]:
    return struct.unpack(">II", blob[16:24])


def measure(size: int, rgb: bytes) -> tuple[float, float]:
    """(max radial extent of ink / size, ink coverage) on the final pixels."""
    cx = cy = (size - 1) / 2.0
    worst = 0.0
    ink = 0
    for y in range(size):
        for x in range(size):
            o = (y * size + x) * 3
            if (rgb[o] + rgb[o + 1] + rgb[o + 2]) / 3.0 < GLYPH_DARK_MAX:
                ink += 1
                worst = max(worst, math.hypot(x - cx, y - cy))
    return worst / size, ink / (size * size)


def render(size: int, scale: float) -> tuple[bytes, float, float]:
    ss = 8 if size <= 256 else 4
    rgb = downsample(draw_bolt(size, scale, ss), size, ss)
    frac, coverage = measure(size, rgb)
    return encode_png(size, size, rgb), frac, coverage


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify the shipped files, write nothing")
    ap.add_argument("--out", default="site/order", help="output directory")
    args = ap.parse_args()

    out = Path(args.out)
    bad = 0
    for name, size, scale, kind in ICONS:
        path = out / name
        if args.check:
            if not path.is_file():
                print(f"FAIL  {path} is missing")
                bad += 1
                continue
            blob = path.read_bytes()
            if blob[:8] != b"\x89PNG\r\n\x1a\n":
                print(f"FAIL  {path} is not a PNG")
                bad += 1
                continue
            if png_size(blob) != (size, size):
                print(f"FAIL  {path} is {png_size(blob)}, want {(size, size)}")
                bad += 1
                continue
            action = "check"
            frac, coverage = 0.0, 0.0
        else:
            blob, frac, coverage = render(size, scale)
            path.write_bytes(blob)
            action = "regen"
        safe = frac <= 0.40 or args.check
        if not safe:
            bad += 1
        print(
            f"{action} {name:24s} {size:>3}x{size:<3} {kind:8s} {len(blob):>7} B  "
            + (f"glyph max radius {frac:.3f}x tile ({frac * 100:.1f}%, safe circle 40%), "
               f"ink {coverage * 100:.1f}%" if not args.check else "magic+IHDR ok")
            + ("  OUTSIDE SAFE ZONE" if not safe else "")
        )
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
