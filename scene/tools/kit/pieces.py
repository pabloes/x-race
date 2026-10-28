"""Kit pieces and the tiles they paint. Authoring frame: Blender, Z up, piece front = -Y,
piece right = -X (see geo.py). Every builder returns a Piece already sized to the contract;
build.py recentres it and checks the size against SPEC."""
import math
import random

import numpy as np
from mathutils import Vector

from atlas import Canvas, hexrgb
from geo import Piece, Swatch, Tile

# Contract sizes in scene axes (x, y, z) and the tolerance build.py allows.
SPEC = {
    "barrier": (4, 1, 0.4), "kerb": (6, 0.15, 0.8), "chevron": (2.4, 2, 0.3),
    "gate-start": (19, 7, 1.5), "gate-checkpoint": (19, 6, 1), "lamp": (0.6, 8, 1.6),
    "banner": (0.4, 6, 1.2), "stand": (12, 6, 6), "tree-a": (5, 7, 5), "tree-b": (5, 7, 5),
    "pad": (6, 0.1, 6), "pillar": (2, 6, 2), "palm": (5, 7, 5), "hologram": (8, 12, 0.5),
}
LOOSE = {"tree-a": 0.6, "tree-b": 0.6, "palm": 0.6}     # the contract says "≈" for trees
# Largest texture edge per piece. Flat-patterned pieces get by with 128 (stripes and gradients
# survive any scale); text, crowd and facades need room. Anything not listed may use 512.
TEX_EDGE = {"barrier": 128, "kerb": 128, "pillar": 128, "tree-a": 64, "tree-b": 64, "lamp": 64,
            "banner": 256, "chevron": 256, "pad": 256, "palm": 128}
FOOTPRINTS, HEIGHTS = (20, 28, 36), (12, 24, 36)
for _w in FOOTPRINTS:
    for _h in HEIGHTS:
        SPEC[f"building-{_w}x{_w}x{_h}"] = (_w, _h, _w)


class Kit:
    """Build context: the theme plus the tiles requested so far (name -> (w, h, painter))."""

    def __init__(self, theme):
        self.T = theme
        self.tiles = {}

    def tile(self, name, w, h, painter, **mapping):
        self.tiles.setdefault(name, (int(w), int(h), painter))
        return Tile(name, **mapping)


def sw(key):
    return Swatch(key)


# ============================================================================ barrier
def paint_barrier(c):
    # Four 1 m blocks so consecutive 4 m pieces keep alternating; grime at the foot, a groove
    # between blocks and a light top edge give the moulded-concrete read at no geometry cost.
    bw = c.w / 4
    for i in range(4):
        c.rect(i * bw, 0, (i + 1) * bw, c.h, "barrier_a" if i % 2 == 0 else "barrier_b")
    c.rect(0, c.h * 0.86, c.w, c.h, "barrier_low")
    for i in range(5):
        c.rect(i * bw - 1.5, 0, i * bw + 1.5, c.h, "barrier_low")
    c.shade_v(1.06, 0.82)
    c.rect(0, 0, c.w, c.h * 0.05, "white")


def build_barrier(K):
    p = Piece("barrier")
    t = K.tile("barrier", 512, 84, paint_barrier, u=(-2, 2), v=("z", 0, 0.66))
    top = K.tile("barrier", 512, 84, paint_barrier, u=(-2, 2), v=0.98)
    prof = [(-0.2, 0), (-0.2, 0.12), (-0.11, 0.32), (-0.09, 0.62), (-0.06, 0.66),
            (0.06, 0.66), (0.09, 0.62), (0.11, 0.32), (0.2, 0.12), (0.2, 0)]

    def paint(i, a, b):
        if a[1] == 0 and b[1] == 0:
            return None                              # floor
        return top if a[1] == b[1] else t
    p.prism(prof, -2, 2, paint, caps=sw("concrete"))
    # Rail on two posts; the rail runs the full 4 m so neighbours read as one fence.
    for x in (-1.0, 1.0):
        p.box((x - 0.04, -0.04, 0.66), (x + 0.04, 0.04, 0.92), {"all": sw("pole")})
    p.box((-2, -0.05, 0.92), (2, 0.05, 1.0), {"all": sw("rail"), "edge": sw("rail^")}, bevel=0.02, bottom=True)
    return p


# ============================================================================ kerb
def paint_kerb(c):
    sw_ = c.w / 6
    for i in range(6):
        c.rect(i * sw_, 0, (i + 1) * sw_, c.h, "kerb_a" if i % 2 == 0 else "kerb_b")
    c.noise(0.03, seed=3)


def build_kerb(K):
    p = Piece("kerb")
    t = K.tile("kerb", 768, 96, paint_kerb, u=(-3, 3))
    prof = [(-0.4, 0), (-0.4, 0.02), (-0.2, 0.15), (0.2, 0.15), (0.4, 0.02), (0.4, 0)]
    p.prism(prof, -3, 3, lambda i, a, b: None if a[1] == b[1] == 0 else t, caps=sw("kerb_b"))
    return p


# ============================================================================ chevron
def paint_chevron(c):
    c.fill("chevron_bg")
    m = c.h * 0.08
    c.rect(0, 0, c.w, m, "chevron_fg")
    c.rect(0, c.h - m, c.w, c.h, "chevron_fg")
    # Three arrows pointing +u (right in the tile).
    n, th, depth = 3, c.w * 0.085, c.h * 0.36
    top, bot, mid = c.h * 0.2, c.h * 0.8, c.h * 0.5
    for i in range(n):
        x0 = c.w * (0.12 + 0.27 * i)
        c.polygon([(x0, top), (x0 + th, top), (x0 + th + depth, mid), (x0 + th, bot), (x0, bot), (x0 + depth, mid)], "chevron_fg")


def build_chevron(K):
    # Arrows point to the piece's +X (scene) on both faces: place it with +X along the
    # direction of travel and whichever face looks at the driver shows the turn.
    p = Piece("chevron")
    front = K.tile("chevron", 480, 240, paint_chevron, flip_u=True)
    back = K.tile("chevron", 480, 240, paint_chevron)
    p.box((-1.2, -0.08, 0.8), (1.2, 0.08, 2.0), {"front": front, "back": back, "all": sw("chevron_bg"),
                                                  "edge": sw("chevron_fg")}, bevel=0.03, bottom=True)
    for x in (-0.8, 0.8):
        p.box((x - 0.05, -0.05, 0.06), (x + 0.05, 0.05, 0.8), {"all": sw("pole")})
        p.box((x - 0.07, -0.15, 0), (x + 0.07, 0.15, 0.06), {"all": sw("pole")})
    return p


# ============================================================================ gates
def paint_checker(c, x0, y0, x1, y1, n_rows):
    s = (y1 - y0) / n_rows
    cols = int(round((x1 - x0) / s))
    for r in range(n_rows):
        for k in range(cols):
            c.rect(x0 + k * s, y0 + r * s, x0 + (k + 1) * s, y0 + (r + 1) * s, "checker_a" if (r + k) % 2 else "checker_b")


def paint_start_band(c):
    c.fill("band")
    end = c.h * 1.5
    paint_checker(c, 0, 0, end, c.h, 4)
    paint_checker(c, c.w - end, 0, c.w, c.h, 4)
    line = c.h * 0.06
    c.rect(end, line * 1.2, c.w - end, line * 2.2, "band_line")
    c.rect(end, c.h - line * 2.2, c.w - end, c.h - line * 1.2, "band_line")
    c.stamp_text("ELON RACE", c.w / 2, c.h / 2, c.w - 2 * end - c.h * 0.6, c.h * 0.56, "band_text")


def paint_start_tower(c):
    c.fill("gate")
    s = c.w * 0.26
    x0 = (c.w - 2 * s) / 2
    rows = int(c.h * 0.9 / s)
    paint_checker(c, x0, c.h * 0.08, x0 + 2 * s, c.h * 0.08 + rows * s, rows)
    c.rect(0, 0, c.w, c.h * 0.025, "gate_trim")
    c.shade_v(1.04, 0.84)


def build_gate_start(K):
    p = Piece("gate-start")
    band = K.tile("start_band", 1296, 144, paint_start_band)
    tower = K.tile("start_tower", 112, 560, paint_start_tower, v=("z", 0, 7))
    for x0, x1 in ((-9.5, -8.1), (8.1, 9.5)):
        p.box((x0, -0.75, 0), (x1, 0.75, 7.0),
              {"side": tower, "top": sw("gate_trim"), "edge": sw("gate^")}, bevel=0.08)
    p.box((-8.1, -0.5, 5.0), (8.1, 0.5, 6.8), {"front": band, "back": band, "all": sw("band"),
                                              "edge": sw("band_line")}, bevel=0.05, bottom=True)
    # Light bar under the beam: the only lit part, so the start reads at dusk too.
    p.box((-7.6, -0.18, 4.88), (7.6, 0.18, 5.0), {"all": sw("pole"), "bottom": sw("gate_light")}, bottom=True)
    return p


def paint_cp_band(c):
    c.fill("cp")
    line = c.h * 0.12
    c.rect(0, line * 0.6, c.w, line * 1.4, "cp_light")
    c.rect(0, c.h - line * 1.4, c.w, c.h - line * 0.6, "cp_light")
    end = c.h * 1.2
    paint_checker(c, c.h * 0.3, c.h * 0.25, c.h * 0.3 + end, c.h * 0.75, 2)
    paint_checker(c, c.w - c.h * 0.3 - end, c.h * 0.25, c.w - c.h * 0.3, c.h * 0.75, 2)
    c.stamp_text("CHECKPOINT", c.w / 2, c.h / 2, c.w * 0.6, c.h * 0.5, "cp_text")


def paint_cp_post(c):
    c.fill("cp")
    w = c.w * 0.3
    c.rect((c.w - w) / 2, c.h * 0.05, (c.w + w) / 2, c.h * 0.95, "cp_light")
    c.shade_v(1.05, 0.85)


def build_gate_checkpoint(K):
    p = Piece("gate-checkpoint")
    band = K.tile("cp_band", 1424, 64, paint_cp_band)
    post = K.tile("cp_post", 48, 480, paint_cp_post, v=("z", 0, 6))
    for x0, x1 in ((-9.5, -8.9), (8.9, 9.5)):
        p.box((x0, -0.5, 0), (x1, 0.5, 6.0), {"side": post, "top": sw("cp_light"), "edge": sw("cp^")}, bevel=0.05)
    p.box((-8.9, -0.3, 5.0), (8.9, 0.3, 5.8), {"front": band, "back": band, "all": sw("cp"),
                                              "edge": sw("cp_light")}, bevel=0.04, bottom=True)
    return p


# ============================================================================ lamp, banner
def build_lamp(K):
    p = Piece("lamp")
    p.box((-0.3, -0.3, 0), (0.3, 0.3, 0.7), {"all": sw("pole"), "edge": sw("pole^")}, bevel=0.06)
    p.cyl((0, 0, 0.7), 0.11, 7.0, 8, sw("pole"), r_top=0.08)
    p.box((-0.05, -0.75, 7.55), (0.05, 0.05, 7.7), {"all": sw("pole")}, bottom=True)
    p.box((-0.22, -1.3, 7.45), (0.22, -0.65, 7.72), {"all": sw("pole"), "bottom": sw("lamp_light"),
                                                     "edge": sw("pole^")}, bevel=0.03, bottom=True)
    p.cyl((0, 0, 7.7), 0.06, 0.3, 6, sw("pole^"), top=sw("pole^"), r_top=0.03)
    return p


def paint_flag(c):
    c.fill("flag")
    b = c.w * 0.06
    s = (c.w - 2 * b) / 4
    paint_checker(c, b, b, c.w - b, b + 3 * s, 3)
    c.stamp_text("RACE", c.w / 2, (b + 3 * s + c.h) / 2, c.w * 0.72, (c.h - 3 * s - 2 * b) * 0.9, "flag_text", vertical=True)
    c.rect(0, 0, c.w, b * 0.6, "flag_text")
    c.rect(0, c.h - b * 0.6, c.w, c.h, "flag_text")


def build_banner(K):
    p = Piece("banner")
    flag = K.tile("flag", 88, 416, paint_flag)
    p.box((-0.2, 0.2, 0), (0.2, 0.6, 0.3), {"all": sw("pole"), "edge": sw("pole^")}, bevel=0.04)
    p.cyl((0, 0.4, 0.3), 0.07, 5.6, 6, sw("pole"))
    p.box((-0.04, -0.6, 5.75), (0.04, 0.47, 5.85), {"all": sw("pole")}, bottom=True)
    p.box((-0.03, -0.58, 1.6), (0.03, 0.3, 5.75), {"left": flag, "right": flag, "all": sw("flag")}, bottom=True)
    p.cyl((0, 0.4, 5.9), 0.06, 0.1, 6, sw("pole^"), top=sw("pole^"))
    return p


# ============================================================================ stand
TIERS, TREAD, RISE = 6, 0.8, 0.75


def paint_crowd(c):
    # One row per riser (5 rows). People sit low in the row: shirt, head, hair, a few arms up.
    # Each row is painted on its own canvas so nobody spills onto another riser.
    T = c.T
    rng = random.Random(7)
    rows = TIERS - 1
    ppm = c.w / 12.0
    for r in range(rows):
        top, bottom = round(r * c.h / rows), round((r + 1) * c.h / rows)
        rh = bottom - top
        row = Canvas(T, c.w, rh)
        row.fill("seat")
        y_bot = rh
        x = rng.uniform(0, 0.3) * ppm
        while x < c.w + 0.3 * ppm:
            shirt = hexrgb(rng.choice(T["crowd"]))
            skin = hexrgb(rng.choice(T["skin"]))
            hair = hexrgb(rng.choice(T["hair"]))
            sw_, sh = 0.42 * ppm, rh * rng.uniform(0.42, 0.55)
            hr = 0.12 * ppm
            hy = y_bot - sh - hr * 0.8
            if rng.random() < 0.18:                    # cheering: arms up
                for dx in (-0.17, 0.17):
                    row.rect(x + dx * ppm - 0.035 * ppm, hy - 0.32 * ppm, x + dx * ppm + 0.035 * ppm, y_bot - sh * 0.6, col=skin)
            row.disc(x, y_bot - sh * 0.35, sw_ / 2, sh * 0.75, col=shirt)
            row.disc(x, hy, hr, hr * 1.1, col=skin)
            row.disc(x, hy - hr * 0.45, hr * 1.02, hr * 0.62, col=hair)
            x += rng.uniform(0.48, 0.62) * ppm
        row.rect(0, y_bot - rh * 0.1, c.w, y_bot, "seat_")
        row.shade_v(0.9, 1.0)
        c.rgb[top:bottom] = row.rgb


def paint_board(c):
    roles = ("board_a", "board_b", "board_c")
    n = 6
    pw = c.w / n
    for i in range(n):
        role = roles[i % 3]
        c.rect(i * pw, 0, (i + 1) * pw, c.h, role)
        text_role = "board_c" if role != "board_c" else "board_a"
        c.stamp_text("RACE", (i + 0.5) * pw, c.h / 2, pw * 0.6, c.h * 0.62, text_role)
    c.rect(0, 0, c.w, c.h * 0.08, "white")


def build_stand(K):
    p = Piece("stand")
    crowd_px = (768, 5 * 48)
    board = K.tile("stand_board", 768, 48, paint_board, u=(-6, 6))
    y0 = -3.0
    prof = [(y0, 0)]
    for k in range(TIERS):
        prof += [(y0 + k * TREAD, (k + 1) * RISE), (y0 + (k + 1) * TREAD, (k + 1) * RISE)]
    y_back = y0 + TIERS * TREAD
    roof_z = 5.55
    prof += [(y_back, roof_z), (3.0, roof_z), (3.0, 0)]

    def paint(i, a, b):
        if a[1] == b[1] == 0:
            return None
        if a[1] == b[1]:                                   # treads and the back-wall top
            return sw("seat") if min(a[0], b[0]) < y_back else sw("stand")
        if a[0] == b[0] == y0:
            return board
        if a[0] == b[0] and a[0] < y_back:                 # riser k sits under tread k
            k = int(round((a[0] - y0) / TREAD))
            r = k - 1
            z_lo = k * RISE
            base = z_lo - r * RISE
            return K.tile("crowd", *crowd_px, paint_crowd, u=(-6, 6), v=("z", base, base + 5 * RISE))
        if a[0] == b[0] == y_back:
            return sw("stand_trim")
        return sw("stand")
    p.prism(prof, -6, 6, paint, caps=sw("stand"))
    p.box((-6, -1.9, roof_z), (6, 3.0, 6.0), {"top": sw("stand_roof"), "side": sw("stand_trim"),
                                              "bottom": sw("stand"), "edge": sw("stand_roof")}, bevel=0.05, bottom=True)
    for x in (-5.85, 5.85):
        p.box((x - 0.08, -1.8, 2 * RISE), (x + 0.08, -1.64, roof_z), {"all": sw("pole")})
    return p


# ============================================================================ trees
def leaf_painter(role, dark):
    def paint(c):
        t = (c.y / c.h)[..., None]                        # 0 top .. 1 bottom
        top, mid, bot = c.T.color(role + "^"), c.T.color(role), c.T.color(dark)
        ramp = np.where(t < 0.5, top + (mid - top) * (t / 0.5), mid + (bot - mid) * ((t - 0.5) / 0.5))
        rng = np.random.default_rng(11)
        cols = rng.uniform(0.9, 1.1, (1, c.w, 1)).astype(np.float32)
        c.rgb = (ramp * cols).astype(np.float32)
    return paint


def build_tree(K, name, role, blobs, trunk_h):
    p = Piece(name)
    leaf = K.tile("leaf_" + role, 64, 128, leaf_painter("leaf_" + role, "leaf_" + role + "_dark"),
                  u=(-2.5, 2.5), v=("z", trunk_h - 0.8, 7.0), point=True)
    p.cyl((0, 0, 0), 0.26, trunk_h + 0.6, 6, sw("trunk"), r_top=0.15)
    for i, (c, r, sc) in enumerate(blobs):
        p.blob(c, r, leaf, subdiv=2, scale=sc, jitter=0.14, seed=sum(map(ord, name)) + i, flat_bottom=0.55)
    return p


def build_tree_a(K):
    return build_tree(K, "tree-a", "a", [((0, 0, 4.55), 2.45, (1, 1, 0.98)), ((0.75, -0.55, 3.75), 1.45, (1, 1, 0.9))], 2.8)


def build_tree_b(K):
    return build_tree(K, "tree-b", "b", [((0, 0, 5.15), 2.5, (1, 1, 0.75)), ((-0.45, 0.6, 4.2), 1.5, (1, 1, 0.8))], 3.4)


# ============================================================================ pad, pillar
def paint_pad(c):
    c.fill("pad")
    for k in range(1, 6):                                  # faint grid of plates
        g = c.w * k / 6
        c.rect(g - 1, 0, g + 1, c.h, "pad_")
        c.rect(0, g - 1, c.w, g + 1, "pad_")
    b = c.w * 0.05
    w = c.w * 0.025
    c.rect(b, b, c.w - b, b + w, "pad_light")
    c.rect(b, c.h - b - w, c.w - b, c.h - b, "pad_light")
    c.rect(b, b, b + w, c.h - b, "pad_light")
    c.rect(c.w - b - w, b, c.w - b, c.h - b, "pad_light")
    cx, cy, r = c.w / 2, c.h / 2, c.w * 0.3
    d = np.hypot(c.x - cx, c.y - cy)
    c.paint(np.clip(np.minimum(d - (r - c.w * 0.03), r - d) + 0.5, 0, 1), "pad_light")
    s = c.w / 384
    bolt = [(212, 92), (140, 206), (186, 206), (166, 292), (246, 168), (198, 168), (226, 92)]
    c.polygon([(x * s, y * s) for x, y in bolt], "pad_light")


def build_pad(K):
    p = Piece("pad")
    p.box((-3, -3, 0), (3, 3, 0.1), {"top": K.tile("pad", 384, 384, paint_pad), "all": sw("pad"),
                                     "edge": sw("pad^")}, bevel=0.03, edges="nobottom")
    return p


def paint_pillar(c):
    c.fill("pillar")
    ppm = c.h / 5.7

    def hazard(z0, z1):
        y0, y1 = c.h - z1 * ppm, c.h - z0 * ppm
        stripe = (((c.x + c.y) / (0.35 * ppm)) % 2) < 1
        m = ((c.y >= y0) & (c.y < y1)).astype(np.float32)
        c.paint(m * stripe, "hazard_a")
        c.paint(m * ~stripe, "hazard_b")
    hazard(0.0, 0.9)
    hazard(4.9, 5.5)
    c.noise(0.035, seed=5)


def build_pillar(K):
    p = Piece("pillar")
    r = 1.0 / math.cos(math.pi / 8)                        # octagon whose flats sit at +-1 m
    p.cyl((0, 0, 0), r, 5.7, 8, K.tile("pillar", 96, 456, paint_pillar, v=("z", 0, 5.7)), rot=math.pi / 8)
    p.cyl((0, 0, 5.7), r, 0.22, 8, sw("pillar^"), top=sw("pillar"), r_top=r * 0.86, rot=math.pi / 8)
    p.cyl((0, 0, 5.92), 0.18, 0.08, 6, sw("beacon"), top=sw("beacon"))
    return p


# ============================================================================ buildings
PPM_FACADE = 12
STYLE_OF = {(i, j): (i + j) % 3 for i in range(3) for j in range(3)}


def facade_painter(style, fw, fh, seed):
    def paint(c):
        T = c.T
        b = f"b{style}_"
        rng = np.random.default_rng(seed)
        c.fill(b + "wall")
        # Module (horizontal pitch, floor height) and window size per style, in metres.
        mod_w, win_w, win_h = [(2.0, 1.75, 2.75), (3.0, 1.5, 1.9), (2.5, 2.0, 2.3)][style]
        floors = max(1, int(round(fh / 3.5)))
        fl_h = fh / floors
        cols = max(1, int(round(fw / mod_w)))
        mw = fw / cols
        ppm = c.w / fw
        g0, g1 = T.color(b + "glass_hi"), T.color(b + "glass")
        glow = T.glow("window")
        for f in range(floors):
            for k in range(cols):
                x0 = (k * mw + (mw - win_w) / 2) * ppm
                x1 = x0 + win_w * ppm
                y_floor_top = c.h - (f + 1) * fl_h * ppm
                y0 = y_floor_top + (fl_h - win_h) * 0.45 * ppm
                y1 = y0 + win_h * ppm
                # Sky reflection: light at the top of the pane, darker below; a diagonal sheen.
                t = np.clip((c.y - y0) / max(1, y1 - y0), 0, 1)[..., None]
                tint = rng.uniform(0.92, 1.06)
                pane = (g0 + (g1 - g0) * t) * tint
                sheen = (((c.x - x0) + (c.y - y0) * 0.8) / max(1, (x1 - x0)) % 1.0 < 0.18)[..., None] * 0.08
                m = (np.clip(np.minimum(c.x - x0, x1 - c.x) + 0.5, 0, 1) * np.clip(np.minimum(c.y - y0, y1 - c.y) + 0.5, 0, 1))
                lit = glow is not None and rng.random() < T["window_lit"]
                c.paint(m, col=np.clip(pane + sheen, 0, 1), emit=glow * rng.uniform(0.6, 1.0) if lit else None)
            if style == 0:                                 # curtain wall: thin floor slabs
                yb = c.h - f * fl_h * ppm
                c.rect(0, yb - 0.25 * ppm, c.w, yb, b + "trim")
        if style == 1:                                     # concrete: pilasters between bays
            for k in range(cols + 1):
                c.rect(k * mw * ppm - 0.12 * ppm, 0, k * mw * ppm + 0.12 * ppm, c.h, b + "trim")
        c.shade_v(1.04, 0.9)
    return paint


def shop_painter(fw, seed):
    def paint(c):
        T = c.T
        rng = random.Random(seed)
        ppm = c.w / fw
        c.fill("shop_base")
        units = max(2, int(round(fw / 5.5)))
        uw = fw / units
        glow = T.glow("shop")
        for u in range(units):
            x0, x1 = u * uw * ppm, (u + 1) * uw * ppm
            awn = hexrgb(rng.choice(T["awnings"]))
            c.rect(x0 + 0.25 * ppm, c.h * 0.22, x1 - 0.25 * ppm, c.h * 0.9, "shop_glass", emit=glow * rng.uniform(0.5, 1.0) if glow is not None and rng.random() < 0.7 else None)
            for k in range(1, 3):
                xm = x0 + (x1 - x0) * k / 3
                c.rect(xm - 0.05 * ppm, c.h * 0.22, xm + 0.05 * ppm, c.h * 0.9, "shop_base")
            c.rect(x0 + 0.1 * ppm, 0, x1 - 0.1 * ppm, c.h * 0.18, col=awn)
            stripes = (((c.x - x0) / (0.5 * ppm)) % 2 < 1) & (c.x >= x0) & (c.x < x1) & (c.y < c.h * 0.18)
            c.paint(stripes * 0.35, col=np.array([1, 1, 1], np.float32))
        c.shade_v(1.0, 0.85)
    return paint


def build_building(K, w, h):
    name = f"building-{w}x{w}x{h}"
    i, j = FOOTPRINTS.index(w), HEIGHTS.index(h)
    style = STYLE_OF[(i, j)]
    b = f"b{style}_"
    seed = 100 + 10 * i + j
    rng = random.Random(seed)
    p = Piece(name)
    hw = w / 2
    pod_h, slab_t, top_h = 4.0, 0.5, 1.6               # top_h: cornice + roof kit above the facade
    shop_w = w - 1.2
    shop = K.tile(f"shop-{w}", shop_w * 16, pod_h * 16, shop_painter(shop_w, seed))
    p.box((-hw + 0.6, -hw + 0.6, 0), (hw - 0.6, hw - 0.6, pod_h), {"side": shop, "all": sw(b + "trim")})
    p.box((-hw, -hw, pod_h), (hw, hw, pod_h + slab_t), {"all": sw(b + "trim"), "edge": sw(b + "trim^")}, bevel=0.12, bottom=True)
    fz0, fz1 = pod_h + slab_t, h - top_h
    fw = w - 0.5 - 2 * 0.3
    facade = K.tile(f"facade-{w}x{h}", fw * PPM_FACADE, (fz1 - fz0) * PPM_FACADE, facade_painter(style, fw, fz1 - fz0, seed))
    p.box((-hw + 0.25, -hw + 0.25, fz0), (hw - 0.25, hw - 0.25, fz1), {"side": facade, "all": sw(b + "roof"),
                                                                     "edge": sw(b + "wall_")}, bevel=0.3, edges="vertical")
    p.box((-hw, -hw, fz1), (hw, hw, fz1 + 0.6), {"side": sw(b + "trim"), "top": sw(b + "roof"),
                                                 "edge": sw(b + "trim^")}, bevel=0.12, bottom=True)
    # Roof kit: a stair/lift house that sets the exact height, and two AC units.
    rz = fz1 + 0.6
    sx, sy = rng.uniform(-hw + 4, hw - 7), rng.uniform(-hw + 4, hw - 7)
    p.box((sx, sy, rz), (sx + 3.5, sy + 3.0, h), {"all": sw(b + "trim"), "top": sw(b + "roof")})
    for _ in range(2):
        ax, ay = rng.uniform(-hw + 2, hw - 4), rng.uniform(-hw + 2, hw - 4)
        p.box((ax, ay, rz), (ax + 2.2, ay + 1.4, rz + 0.75), {"all": sw("roof_box"), "top": sw("roof_box^")})
    return p


# ============================================================================ palm (neon)
def paint_palm_trunk(c):
    c.fill("palm_trunk")
    n = 9                                                 # growth rings, one glowing line each
    for i in range(n):
        y = (i + 0.5) * c.h / n
        c.rect(0, y - c.h * 0.012, c.w, y + c.h * 0.012, "palm_ring")
        c.rect(0, y + c.h * 0.012, c.w, y + c.h * 0.035, "palm_trunk_")
    c.shade_v(1.0, 0.75)


def build_palm(K):
    p = Piece("palm")
    H, sides, segs, bend = 6.2, 6, 5, 0.9
    trunk = K.tile("palm_trunk", 64, 256, paint_palm_trunk, v=("z", 0, H))

    def ring(i):
        t = i / segs
        cx = bend * t * t                                  # gentle lean toward +X (piece left)
        r = 0.28 + (0.17 - 0.28) * t
        return [(cx + r * math.cos(2 * math.pi * k / sides), r * math.sin(2 * math.pi * k / sides), H * t) for k in range(sides)]
    rings = [ring(i) for i in range(segs + 1)]
    for i in range(segs):
        a, b = rings[i], rings[i + 1]
        for k in range(sides):
            k1 = (k + 1) % sides
            mid = ((a[k][0] + a[k1][0]) / 2 - bend * (i / segs) ** 2, (a[k][1] + a[k1][1]) / 2, 0)
            p.poly([a[k], a[k1], b[k1], b[k]], trunk, hint=mid)
    p.poly(rings[-1], sw("palm_trunk_"), hint=(0, 0, 1))
    top = Vector((bend, 0, H))
    up = Vector((0, 0, 1))
    rng = random.Random(29)
    for f in range(7):
        a = 2 * math.pi * f / 7 + rng.uniform(-0.2, 0.2)
        d = Vector((math.cos(a), math.sin(a), 0))
        side = d.cross(up).normalized()
        reach = rng.uniform(0.92, 1.0)
        p0 = top
        p1 = top + d * 1.0 * reach + up * 0.4
        p2 = top + d * 1.9 * reach + up * 0.1
        p3 = top + d * 2.45 * reach - up * 0.65
        for sgn in (1, -1):
            e1 = p1 + side * 0.48 * sgn - up * 0.14
            e2 = p2 + side * 0.36 * sgn - up * 0.12
            for face in ([p0, p1, e1], [p1, p2, e2, e1], [p2, p3, e2]):
                p.poly(face, sw("palm_leaf"), hint=(0, 0, 1))
                p.poly(list(reversed(face)), sw("palm_leaf_"), hint=(0, 0, -1))
    return p


# ============================================================================ hologram (neon)
def paint_holo(c):
    c.fill("holo_bg")
    for y in range(0, c.h, 6):                            # scanlines
        c.rect(0, y, c.w, y + 1.5, "holo_glow", emit=c.T.glow("holo_glow") * 0.25)
    m = c.w * 0.05
    L, t = c.w * 0.16, max(2.0, c.w * 0.012)
    for x0, sx in ((m, 1), (c.w - m, -1)):                # corner brackets
        for y0, sy in ((m, 1), (c.h - m, -1)):
            c.rect(min(x0, x0 + sx * L), y0 - t / 2, max(x0, x0 + sx * L), y0 + t / 2, "holo_glow")
            c.rect(x0 - t / 2, min(y0, y0 + sy * L), x0 + t / 2, max(y0, y0 + sy * L), "holo_glow")
    cx, cy, r = c.w / 2, c.h * 0.27, c.w * 0.26          # emblem: ring and bolt
    d = np.hypot(c.x - cx, c.y - cy)
    c.paint(np.clip(np.minimum(d - (r - c.w * 0.025), r - d) + 0.5, 0, 1), "holo_accent")
    s = r / 120
    bolt = [(14, -86), (-58, 28), (-12, 28), (-32, 114), (48, -10), (0, -10), (28, -86)]
    c.polygon([(cx + x * s, cy + y * s) for x, y in bolt], "holo_glow")
    c.stamp_text("ELON", c.w / 2, c.h * 0.56, c.w * 0.62, c.h * 0.09, "holo_glow")
    c.stamp_text("ROADSTER", c.w / 2, c.h * 0.68, c.w * 0.84, c.h * 0.08, "holo_accent")
    c.stamp_text("RACE", c.w / 2, c.h * 0.81, c.w * 0.7, c.h * 0.11, "holo_glow")


def build_hologram(K):
    # A projector frame with the projection between the posts. The projection is two
    # back-to-back single-sided quads, so it reads the right way round from both sides.
    p = Piece("hologram")
    p.box((-4, -0.25, 0), (4, 0.25, 0.5), {"all": sw("holo_frame"), "top": sw("holo_glow"),
                                          "edge": sw("holo_frame^")}, bevel=0.04)
    p.box((-4, -0.18, 0.5), (-3.75, 0.18, 12), {"all": sw("holo_frame"), "left": sw("holo_glow")})
    p.box((3.75, -0.18, 0.5), (4, 0.18, 12), {"all": sw("holo_frame"), "right": sw("holo_glow")})
    p.box((-3.75, -0.2, 11.7), (3.75, 0.2, 12), {"all": sw("holo_frame"), "bottom": sw("holo_glow")}, bottom=True)
    holo = K.tile("holo", 256, 352, paint_holo, mat="holo")
    x0, x1, z0, z1 = -3.7, 3.7, 0.65, 11.6
    p.poly([(x0, -0.01, z0), (x1, -0.01, z0), (x1, -0.01, z1), (x0, -0.01, z1)], holo, hint=(0, -1, 0))
    p.poly([(x0, 0.01, z0), (x1, 0.01, z0), (x1, 0.01, z1), (x0, 0.01, z1)], holo, hint=(0, 1, 0))
    return p


BUILDERS = {
    "barrier": build_barrier, "kerb": build_kerb, "chevron": build_chevron,
    "gate-start": build_gate_start, "gate-checkpoint": build_gate_checkpoint,
    "lamp": build_lamp, "banner": build_banner, "stand": build_stand,
    "tree-a": build_tree_a, "tree-b": build_tree_b, "pad": build_pad, "pillar": build_pillar,
    "palm": build_palm, "hologram": build_hologram,
}


def build_all(K, names):
    """names: theme piece list; 'buildings' expands to the catalogue."""
    out, missing = [], []
    for n in names:
        if n == "buildings":
            out += [build_building(K, w, h) for w in FOOTPRINTS for h in HEIGHTS]
        elif n in BUILDERS:
            out.append(BUILDERS[n](K))
        else:
            missing.append(n)
    return out, missing
