#!/usr/bin/env python3
"""Renders the Aetherspire app icon. No image libraries on this machine, so this is a
small scanline rasterizer: supersampled polygon fill, a radial ground, and a PNG writer.

The mark is the launcher's own spire (renderer/index.html), redrawn at icon weight — the
UI version's 1.5px strokes vanish below 32px, so the tiers are filled solids separated by
gaps of the ground colour, which stay legible all the way down to 16px."""

import zlib, struct, math, sys

SS = 4  # supersample factor

VOID       = (0x07, 0x0B, 0x17)
VOID_LIFT  = (0x16, 0x22, 0x42)
GOLD_BRIGHT= (0xF7, 0xDA, 0x9C)
GOLD       = (0xE8, 0xB4, 0x5C)
GOLD_DEEP  = (0xC0, 0x8B, 0x3E)
GOLD_BASE  = (0x9A, 0x6E, 0x30)
BLUE_GLOW  = (0x7F, 0xB2, 0xFF)


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def poly_mask(w, h, pts):
    """Coverage 0..1 per pixel for a polygon given in 0..1 space, supersampled."""
    W, H = w * SS, h * SS
    p = [(x * W, y * H) for x, y in pts]
    cov = [0.0] * (w * h)
    ys = [q[1] for q in p]
    y0, y1 = max(0, int(min(ys))), min(H - 1, int(max(ys)) + 1)
    for sy in range(y0, y1 + 1):
        yc = sy + 0.5
        xs = []
        for i in range(len(p)):
            ax, ay = p[i]
            bx, by = p[(i + 1) % len(p)]
            if (ay <= yc < by) or (by <= yc < ay):
                xs.append(ax + (yc - ay) * (bx - ax) / (by - ay))
        xs.sort()
        for i in range(0, len(xs) - 1, 2):
            a, b = int(math.ceil(xs[i] - 0.5)), int(math.floor(xs[i + 1] - 0.5))
            row = (sy // SS) * w
            for sx in range(max(0, a), min(W - 1, b) + 1):
                cov[row + sx // SS] += 1.0
    n = float(SS * SS)
    return [min(1.0, c / n) for c in cov]


def rounded_rect_mask(w, h, radius):
    """Squircle-ish ground. macOS applies no mask of its own, so the icon carries it."""
    cov = [0.0] * (w * h)
    r = radius * w
    for y in range(h):
        for x in range(w):
            acc = 0
            for oy in range(SS):
                for ox in range(SS):
                    px, py = x + (ox + 0.5) / SS, y + (oy + 0.5) / SS
                    cx = min(max(px, r), w - r)
                    cy = min(max(py, r), h - r)
                    if (px - cx) ** 2 + (py - cy) ** 2 <= r * r:
                        acc += 1
            cov[y * w + x] = acc / float(SS * SS)
    return cov


def render(size, ground=True):
    w = h = size
    px = [[0.0, 0.0, 0.0, 0.0] for _ in range(w * h)]

    if ground:
        gm = rounded_rect_mask(w, h, 0.225)
        # Light falls from the crown: the ground lifts toward the upper middle.
        for y in range(h):
            for x in range(w):
                u, v = (x + 0.5) / w, (y + 0.5) / h
                d = math.hypot(u - 0.5, v - 0.30) / 0.85
                c = lerp(VOID_LIFT, VOID, min(1.0, d ** 0.75))
                i = y * w + x
                px[i] = [c[0], c[1], c[2], gm[i] * 255.0]

        # Aether glow behind the crown, additive so it reads as light not paint.
        for y in range(h):
            for x in range(w):
                u, v = (x + 0.5) / w, (y + 0.5) / h
                d = math.hypot(u - 0.5, v - 0.30)
                g = max(0.0, 1.0 - d / 0.42) ** 2.6
                if g <= 0.002:
                    continue
                i = y * w + x
                if px[i][3] <= 0:
                    continue
                for c in range(3):
                    warm = BLUE_GLOW[c] * 0.35 + GOLD[c] * 0.65
                    px[i][c] = min(255.0, px[i][c] + warm * g * 0.42)

    def paint(pts, color, alpha=1.0):
        m = poly_mask(w, h, pts)
        for i, cvg in enumerate(m):
            a = cvg * alpha
            if a <= 0:
                continue
            if ground and px[i][3] <= 0:      # never paint outside the ground
                continue
            if not ground:
                px[i][3] = min(255.0, px[i][3] + a * 255.0)
            for c in range(3):
                px[i][c] = px[i][c] * (1 - a) + color[c] * a

    # The spire, in the launcher mark's own 40x48 coordinates. Scaling both axes by the
    # same factor is what keeps it a spire — fitting 40x48 to a square squats it into a
    # pyramid, which is not the mark.
    K = 0.0160
    def X(u): return 0.5 + (u - 20.0) * K
    def Y(v): return 0.118 + v * K
    def P(*pts): return [(X(u), Y(v)) for u, v in pts]

    # Lower tier first: the tiers overlap in the mark, and the spire is built upward.
    paint(P((10, 31.5), (30, 31.5), (34, 45), (6, 45)), GOLD_DEEP)
    # Upper tier. The mark overlaps its tiers; the icon opens real gaps between them,
    # because at 32px an overlap fuses the whole thing into one cone.
    paint(P((13, 18), (27, 18), (30, 28.5), (10, 28.5)), GOLD)
    # Crown — the sharpest, brightest shape, and the one that survives at 16px.
    paint(P((20, 1.5), (27.5, 11.5), (20, 15), (12.5, 11.5)), GOLD_BRIGHT)
    # Ground line: the spire stands on something.
    paint(P((2, 46.6), (38, 46.6), (38, 48.6), (2, 48.6)), GOLD_BASE)

    out = bytearray()
    for i in range(w * h):
        r, g, b, a = px[i]
        out += bytes((int(r + .5), int(g + .5), int(b + .5), int(a + .5)))
    return bytes(out)


def write_png(path, size, rgba):
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        raw += rgba[y * size * 4:(y + 1) * size * 4]

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + chunk(b'IEND', b''))
    open(path, 'wb').write(png)


if __name__ == '__main__':
    out, size = sys.argv[1], int(sys.argv[2])
    write_png(out, size, render(size))
    print(out, size)
