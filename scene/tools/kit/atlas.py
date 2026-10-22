"""Procedural texture atlas: packer, canvas painter and a stroke font.

Everything is painted with numpy in sRGB floats, top-left origin (row 0 = top), and flipped
when written into a Blender image. Two images share one layout: colour and emissive. A paint
operation names a theme role, so the same painter gives a matt city tile or a glowing neon one
depending on whether the theme lists that role under `glow`.
"""
import math

import numpy as np

SIZE = 2048
GUTTER = 4          # edge-replicated border around every tile, so bilinear/mip sampling never reaches a neighbour
SWATCH = 64         # flat colours sit in 64 px blocks; faces sample their centre, so bleeding only starts at mip 6


def hexrgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], dtype=np.float32)


def shade(rgb, k):
    """k > 0 mixes toward white, k < 0 toward black."""
    rgb = np.asarray(rgb, dtype=np.float32)
    return rgb + (1 - rgb) * k if k > 0 else rgb * (1 + k)


class Theme:
    def __init__(self, spec):
        self.spec = spec
        self.name = spec["name"]

    def color(self, key):
        """Role colour; a trailing '^' lightens and '_' darkens, used for bevel highlights and shadows."""
        k, base = 0.0, key
        while base[-1] in "^_":
            k += 0.22 if base[-1] == "^" else -0.25
            base = base[:-1]
        c = self.spec["colors"].get(base)
        if c is None:
            raise KeyError(f"theme {self.name}: no colour for role '{base}'")
        return shade(hexrgb(c), k) if k else hexrgb(c)

    def glow(self, key):
        base = key.rstrip("^_")
        g = self.spec["glow"].get(base)
        if g is None:
            return None
        col, strength = (g, 1.0) if isinstance(g, str) else g
        return hexrgb(col) * strength

    def __getitem__(self, k):
        return self.spec[k]


# ----------------------------------------------------------------------------- canvas
class Canvas:
    """A tile being painted: rgb and emissive arrays plus pixel-centre coordinate grids."""

    def __init__(self, theme, w, h):
        self.T, self.w, self.h = theme, w, h
        self.rgb = np.zeros((h, w, 3), np.float32)
        self.emit = np.zeros((h, w, 3), np.float32)
        self.y, self.x = np.mgrid[0:h, 0:w].astype(np.float32) + 0.5

    def paint(self, mask, role=None, col=None, emit=None):
        m = np.clip(np.asarray(mask, np.float32), 0, 1)
        if m.ndim == 0:
            m = np.full((self.h, self.w), float(m), np.float32)
        m = m[..., None]
        c = self.T.color(role) if role is not None else np.asarray(col, np.float32)
        e = emit if emit is not None else (self.T.glow(role) if role is not None else None)
        self.rgb = self.rgb * (1 - m) + c * m
        self.emit = self.emit * (1 - m) + (np.zeros(3, np.float32) if e is None else np.asarray(e, np.float32)) * m

    def fill(self, role=None, col=None):
        self.paint(1.0, role, col)

    def rect(self, x0, y0, x1, y1, role=None, col=None, emit=None):
        """Anti-aliased rectangle in pixel units (fractional edges allowed)."""
        mx = np.clip(np.minimum(self.x - x0 + 0.5, x1 - self.x + 0.5), 0, 1)
        my = np.clip(np.minimum(self.y - y0 + 0.5, y1 - self.y + 0.5), 0, 1)
        self.paint(mx * my, role, col, emit)

    def disc(self, cx, cy, rx, ry=None, role=None, col=None):
        ry = rx if ry is None else ry
        d = np.sqrt(((self.x - cx) / rx) ** 2 + ((self.y - cy) / ry) ** 2)
        self.paint(np.clip((1 - d) * min(rx, ry) + 0.5, 0, 1), role, col)

    def polygon(self, pts, role=None, col=None, emit=None):
        self.paint(poly_mask(self.x, self.y, pts), role, col, emit)

    def shade_v(self, top, bottom, y0=0, y1=None):
        """Multiply a vertical light ramp over the tile (cheap stand-in for baked sky light / AO)."""
        y1 = self.h if y1 is None else y1
        t = np.clip((self.y - y0) / max(1.0, y1 - y0), 0, 1)
        self.rgb *= (top + (bottom - top) * t)[..., None]

    def stamp_text(self, text, cx, cy, max_w, max_h, role=None, col=None, italic=0.22, vertical=False):
        m = text_mask(text, max_w if not vertical else max_h, max_h if not vertical else max_w, italic)
        if vertical:
            m = np.rot90(m)     # reads bottom-to-top, like the reference banners
        h, w = m.shape
        x0, y0 = int(round(cx - w / 2)), int(round(cy - h / 2))
        full = np.zeros((self.h, self.w), np.float32)
        xs, ys = max(0, x0), max(0, y0)
        xe, ye = min(self.w, x0 + w), min(self.h, y0 + h)
        full[ys:ye, xs:xe] = m[ys - y0:ye - y0, xs - x0:xe - x0]
        self.paint(full, role, col)

    def noise(self, amount, seed=0, scale=1.0):
        """Per-pixel value noise multiplied in, so large flat areas don't look like vector art."""
        rng = np.random.default_rng(seed)
        n = rng.random((self.h, self.w)).astype(np.float32)
        self.rgb *= (1 - amount * scale + 2 * amount * scale * n)[..., None]


def poly_mask(x, y, pts):
    """Even-odd point-in-polygon over the pixel grid (pts in pixel units)."""
    inside = np.zeros(x.shape, bool)
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        if y1 == y2:
            continue
        cond = (y1 > y) != (y2 > y)
        xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
        inside ^= cond & (x < xi)
    return inside.astype(np.float32)


# ----------------------------------------------------------------------------- stroke font
# Sporty squared letters as polylines on a 4 x 6 grid (y up). Strokes are rasterised as
# distance fields, which gives clean anti-aliased bold type at any size with no font files.
GLYPHS = {
    "A": [[(0, 0), (0, 4.4), (1.6, 6), (2.4, 6), (4, 4.4), (4, 0)], [(0, 2.7), (4, 2.7)]],
    "C": [[(4, 6), (1.2, 6), (0, 4.8), (0, 1.2), (1.2, 0), (4, 0)]],
    "D": [[(0, 0), (0, 6), (2.8, 6), (4, 4.8), (4, 1.2), (2.8, 0), (0, 0)]],
    "E": [[(4, 6), (0, 6), (0, 0), (4, 0)], [(0, 3), (3, 3)]],
    "F": [[(4, 6), (0, 6), (0, 0)], [(0, 3), (3, 3)]],
    "H": [[(0, 0), (0, 6)], [(4, 0), (4, 6)], [(0, 3), (4, 3)]],
    "I": [[(0, 0), (0, 6)]],
    "K": [[(0, 0), (0, 6)], [(4, 6), (0.2, 2.6)], [(1.4, 3.7), (4, 0)]],
    "L": [[(0, 6), (0, 0), (4, 0)]],
    "N": [[(0, 0), (0, 6), (4, 0), (4, 6)]],
    "O": [[(1.2, 0), (0, 1.2), (0, 4.8), (1.2, 6), (2.8, 6), (4, 4.8), (4, 1.2), (2.8, 0), (1.2, 0)]],
    "P": [[(0, 0), (0, 6), (2.9, 6), (4, 4.9), (4, 4.1), (2.9, 3), (0, 3)]],
    "R": [[(0, 0), (0, 6), (2.9, 6), (4, 4.9), (4, 4.1), (2.9, 3), (0, 3)], [(2.2, 3), (4, 0)]],
    "S": [[(4, 6), (1.1, 6), (0, 4.9), (0, 4.1), (1.1, 3), (2.9, 3), (4, 1.9), (4, 1.1), (2.9, 0), (0, 0)]],
    "T": [[(0, 6), (4, 6)], [(2, 6), (2, 0)]],
    "G": [[(4, 6), (1.2, 6), (0, 4.8), (0, 1.2), (1.2, 0), (4, 0), (4, 2.8), (2.2, 2.8)]],
    "X": [[(0, 0), (4, 6)], [(0, 6), (4, 0)]],
}
STROKE = 1.15       # in grid units: bold, the reference banners use heavy italic type
TRACK = 1.5         # gap between letters
SPACE = 2.6


def _layout(text, italic):
    x, segs = 0.0, []
    for ch in text:
        if ch == " ":
            x += SPACE
            continue
        g = GLYPHS[ch]
        gw = max(p[0] for line in g for p in line)
        for line in g:
            for a, b in zip(line, line[1:]):
                segs.append(((a[0] + x + italic * a[1], a[1]), (b[0] + x + italic * b[1], b[1])))
        x += gw + TRACK
    width = x - TRACK + italic * 6
    return segs, width


def text_mask(text, max_w, max_h, italic=0.22):
    segs, width = _layout(text, italic)
    pad = STROKE / 2
    scale = min(max_h / (6 + 2 * pad), max_w / (width + 2 * pad))
    w, h = int(math.ceil((width + 2 * pad) * scale)), int(math.ceil((6 + 2 * pad) * scale))
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32) + 0.5
    gx, gy = xx / scale - pad, (h - yy) / scale - pad      # grid coords, y up
    d = np.full((h, w), 1e9, np.float32)
    for (ax, ay), (bx, by) in segs:
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy or 1e-9
        t = np.clip(((gx - ax) * dx + (gy - ay) * dy) / L2, 0, 1)
        d = np.minimum(d, np.hypot(gx - ax - t * dx, gy - ay - t * dy))
    return np.clip((STROKE / 2 - d) * scale + 0.5, 0, 1).astype(np.float32)


# ----------------------------------------------------------------------------- packer
class Atlas:
    """Shelf packer for named tiles plus flat swatches; owns the two painted images."""

    def __init__(self, theme, size=SIZE):
        self.T, self.size = theme, size
        self.rects = {}

    def pack(self, tiles, swatches):
        """tiles: {name: (w, h, painter)}; swatches: iterable of role keys."""
        reqs = [(n, w, h) for n, (w, h, _) in tiles.items()] + [("sw:" + k, SWATCH - 2 * GUTTER, SWATCH - 2 * GUTTER) for k in sorted(swatches)]
        reqs.sort(key=lambda r: (-r[2], -r[1], r[0]))
        x = y = shelf = 0
        for name, w, h in reqs:
            W, H = w + 2 * GUTTER, h + 2 * GUTTER
            if x + W > self.size:
                x, y, shelf = 0, y + shelf, 0
            if y + H > self.size or W > self.size:
                raise RuntimeError(f"atlas {self.size}px full at '{name}' ({w}x{h})")
            self.rects[name] = (x + GUTTER, y + GUTTER, w, h)
            x += W
            shelf = max(shelf, H)
        self.used = (y + shelf) / self.size
        self.tiles, self.swatches = tiles, list(swatches)

    def paint(self):
        rgb = np.zeros((self.size, self.size, 3), np.float32)
        emit = np.zeros_like(rgb)
        for name, (w, h, painter) in self.tiles.items():
            c = Canvas(self.T, w, h)
            painter(c)
            self._put(rgb, emit, name, c.rgb, c.emit)
        for k in self.swatches:
            w = SWATCH - 2 * GUTTER
            c = np.broadcast_to(self.T.color(k), (w, w, 3))
            g = self.T.glow(k)
            e = np.zeros((w, w, 3), np.float32) if g is None else np.broadcast_to(g, (w, w, 3))
            self._put(rgb, emit, "sw:" + k, c, e)
        return np.clip(rgb, 0, 1), np.clip(emit, 0, 1)

    def _put(self, rgb, emit, name, a, e):
        x, y, w, h = self.rects[name]
        G = GUTTER
        rgb[y - G:y + h + G, x - G:x + w + G] = np.pad(a, ((G, G), (G, G), (0, 0)), mode="edge")
        emit[y - G:y + h + G, x - G:x + w + G] = np.pad(e, ((G, G), (G, G), (0, 0)), mode="edge")

    def uv(self, name, s, t):
        """(s, t) in [0, 1] inside the tile, t = 0 at the tile's bottom -> Blender UV."""
        x, y, w, h = self.rects[name]
        s, t = min(max(s, 0.0), 1.0), min(max(t, 0.0), 1.0)
        px = x + 0.5 + s * (w - 1)
        py = y + 0.5 + (1 - t) * (h - 1)
        return px / self.size, 1 - py / self.size
