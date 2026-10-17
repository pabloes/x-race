#!/usr/bin/env python3
"""
Renders the scene poster from the *same* track data the server turns into colliders, so the
image on Places and the navmap is the circuit you actually drive rather than a stale
screenshot — change the track and the poster follows.

It is a small isometric software renderer: every box in `shared/track.ts` is rotated into
world space, projected through one orthographic camera, back-face culled, shaded against a
single light and painted back to front. The three cars are modelled from `CAR` the same way,
one per thing the scene does: on the grid, mid-jump, and upside down under the ceiling.

Run it from the scene directory, piping the track in:

    cd scene
    (cd ../server && npx tsx -e "import {TRACK} from '../shared/track'; \\
        process.stdout.write(JSON.stringify(TRACK))") | python3 tools/make-thumbnail.py

Output: images/elon-roadster-race.png at 1920x1080. Decentraland documents 16:9 at that size
for `display.navmapThumbnail`, and asks that text and logos stay inside the central 1080x1080
square, because the cards on Places crop the sides — hence SAFE_LEFT/SAFE_RIGHT below. The
file name matters too: the CLI warns on every deploy if it is still the template's
`images/scene-thumbnail.png`.
"""

import json
import math
import os
import random
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

WIDTH, HEIGHT = 1920, 1080
# Places crops to the central square, so nothing that must be read goes outside it.
SAFE_LEFT, SAFE_RIGHT = (WIDTH - HEIGHT) / 2, (WIDTH + HEIGHT) / 2
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'images',
                   'elon-roadster-race.png')

# Camera. Yaw turns the circuit so the start straight runs toward the viewer; pitch is the
# tilt. Both are orthographic — a perspective camera on a square this wide just bends the walls.
YAW, PITCH = math.radians(34), math.radians(33)
LIGHT = (-0.45, 0.82, -0.36)

FONTS = [
    '/System/Library/Fonts/Supplemental/Arial Black.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
]

SURFACE_COLOUR = {
    'road': (46, 50, 60),
    'ramp': (126, 88, 42),
    'startline': (228, 230, 240),
    'building': (30, 34, 46),
    'wall': (40, 34, 38),
    'ceiling': (46, 76, 118),
}


def load_font(size):
    for path in FONTS:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


# ---------------------------------------------------------------- geometry

def rotation(rx, ry, rz):
    """Euler degrees -> 3x3, in Decentraland's Y-X-Z order, the one `shared/track.ts` uses."""
    sx, cx = math.sin(math.radians(rx)), math.cos(math.radians(rx))
    sy, cy = math.sin(math.radians(ry)), math.cos(math.radians(ry))
    sz, cz = math.sin(math.radians(rz)), math.cos(math.radians(rz))
    ry_m = ((cy, 0, sy), (0, 1, 0), (-sy, 0, cy))
    rx_m = ((1, 0, 0), (0, cx, -sx), (0, sx, cx))
    rz_m = ((cz, -sz, 0), (sz, cz, 0), (0, 0, 1))

    def mul(a, b):
        return tuple(tuple(sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3))
                     for i in range(3))

    return mul(mul(ry_m, rx_m), rz_m)


def apply(m, v):
    return (m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
            m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
            m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2])


# The six faces of a unit box as corner indices, wound so the normal points outwards.
BOX_CORNERS = [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1),
               (-1, 1, -1), (1, 1, -1), (1, 1, 1), (-1, 1, 1)]
BOX_FACES = [(4, 5, 6, 7), (0, 3, 2, 1), (3, 7, 6, 2), (0, 1, 5, 4), (1, 2, 6, 5), (0, 4, 7, 3)]


def box(pos, size, rot=(0, 0, 0), colour=(80, 80, 80), emissive=False, alpha=255):
    """One solid, ready for the painter: world corners plus how to paint it."""
    m = rotation(*rot)
    half = (size['x'] / 2, size['y'] / 2, size['z'] / 2)
    pts = []
    for cx, cy, cz in BOX_CORNERS:
        local = (cx * half[0], cy * half[1], cz * half[2])
        r = apply(m, local)
        pts.append((pos['x'] + r[0], pos['y'] + r[1], pos['z'] + r[2]))
    return {'pts': pts, 'colour': colour, 'emissive': emissive, 'alpha': alpha}


def vec(a, b):
    return (b[0] - a[0], b[1] - a[1], b[2] - a[2])


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def normalise(v):
    length = math.sqrt(sum(c * c for c in v)) or 1.0
    return (v[0] / length, v[1] / length, v[2] / length)


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


class Camera:
    """Orthographic, framed to whatever it is given."""

    def __init__(self, solids):
        self.view = normalise((math.sin(YAW) * math.cos(PITCH), -math.sin(PITCH),
                               math.cos(YAW) * math.cos(PITCH)))
        raw = [self.flat(p) for solid in solids for p in solid['pts']]
        min_u, max_u = min(p[0] for p in raw), max(p[0] for p in raw)
        min_w, max_w = min(p[1] for p in raw), max(p[1] for p in raw)
        # Leave the lower third of the frame for the title block.
        self.scale = min(1700 / (max_u - min_u), 690 / (max_w - min_w))
        self.cx = WIDTH / 2 - (min_u + max_u) / 2 * self.scale
        self.cy = 430 - (min_w + max_w) / 2 * self.scale

    def flat(self, p):
        """World -> (screen-ish u, w) before scaling, plus the depth we sort on."""
        u = p[0] * math.cos(YAW) - p[2] * math.sin(YAW)
        v = p[0] * math.sin(YAW) + p[2] * math.cos(YAW)
        w = -v * math.sin(PITCH) - p[1] * math.cos(PITCH)
        return (u, w, v)

    def project(self, p):
        u, w, _ = self.flat(p)
        return (self.cx + u * self.scale, self.cy + w * self.scale)

    def depth(self, solid):
        return max(self.flat(p)[2] for p in solid['pts'])


def faces_of(solid, camera):
    """Visible faces of one solid, each with its shaded colour, far ones first."""
    out = []
    for quad in BOX_FACES:
        pts = [solid['pts'][i] for i in quad]
        normal = normalise(cross(vec(pts[0], pts[1]), vec(pts[0], pts[2])))
        if dot(normal, camera.view) >= 0:
            continue  # facing away from the camera
        shade = 0.34 + 0.66 * max(0.0, dot(normal, LIGHT))
        if solid['emissive']:
            shade = 1.0
        colour = tuple(min(255, int(c * shade)) for c in solid['colour'])
        out.append(([camera.project(p) for p in pts], colour))
    return out


# ---------------------------------------------------------------- the cars

def car_solids(pos, rot, boost=False, belly=False, flanks=False, scale=1.0):
    """A Roadster built from the same proportions the scene draws, as a list of solids.

    `scale` is poster licence: a 4.4 m car on a 512 m circuit is three pixels across, so the
    hero cars are drawn several times life size. The proportions are still the car's.
    """
    hx, hy, hz = 0.95 * scale, 0.35 * scale, 2.2 * scale
    m = rotation(*rot)

    def at(local, size, colour, emissive=False):
        r = apply(m, local)
        return box({'x': pos[0] + r[0], 'y': pos[1] + r[1], 'z': pos[2] + r[2]},
                   {k: v * scale for k, v in size.items()}, rot, colour, emissive)

    unit = (0.95, 0.35, 2.2)  # sizes are given at life size; `at` applies `scale`.
    out = [
        at((0, 0, 0), {'x': unit[0] * 2, 'y': unit[1] * 1.6, 'z': unit[2] * 2}, (214, 26, 34)),
        at((0, hy * 0.95, -0.25 * scale),
           {'x': unit[0] * 1.6, 'y': unit[1] * 1.1, 'z': unit[2] * 0.95}, (18, 20, 26)),
        at((0, hy * 1.25, -hz * 0.95), {'x': unit[0] * 1.9, 'y': 0.1, 'z': 0.6}, (16, 16, 18)),
        at((0, 0, -hz - 0.04 * scale), {'x': unit[0] * 1.4, 'y': 0.16, 'z': 0.06}, (255, 40, 30), True),
    ]
    for sx in (-1, 1):
        for sz in (-1, 1):
            out.append(at((hx * 0.98 * sx, -hy * 0.7, hz * 0.62 * sz),
                          {'x': 0.28, 'y': 0.7, 'z': 0.7}, (16, 16, 18)))
    if boost:
        out.append(at((0, -0.1 * scale, -hz - 0.75 * scale), {'x': 0.8, 'y': 0.45, 'z': 1.5},
                      (120, 225, 255), True))
    if belly:
        for sx in (-1, 1):
            for sz in (-1, 1):
                out.append(at((hx * 0.6 * sx, -hy * 0.8 - 0.55 * scale, hz * 0.55 * sz),
                              {'x': 0.26, 'y': 1.1, 'z': 0.26}, (120, 225, 255), True))
    if flanks:
        for sx in (-1, 1):
            out.append(at(((hx + 0.55 * scale) * sx, 0, -hz * 0.15),
                          {'x': 1.1, 'y': 0.22, 'z': 0.22}, (120, 225, 255), True))
    return out


# ---------------------------------------------------------------- the poster

def build_solids(track):
    solids = []
    for s in track['surfaces']:
        if s['kind'] == 'ground':
            continue
        colour = SURFACE_COLOUR[s['kind']]
        if s['kind'] == 'building':
            # A little variation per tower, so the skyline is not one flat block.
            tint = (len(solids) * 37) % 24
            colour = (colour[0] + tint, colour[1] + tint // 2, colour[2] + tint)
        solids.append(box(s['pos'], s['size'], s['rot'], colour,
                          alpha=170 if s['kind'] == 'ceiling' else 255))

    for o in track['obstacles']:
        solids.append(box(o['pos'], o['size'], o['rot'], (208, 92, 20)))

    for t in track['triggers']:
        if t['kind'] == 'boost':
            pad = dict(t['size'])
            pad['y'] = 0.12
            solids.append(box({'x': t['pos']['x'], 'y': 0.22, 'z': t['pos']['z']}, pad,
                              t['rot'], (40, 215, 255), True))
        elif t['kind'] == 'checkpoint':
            first = not t.get('index')
            colour = (255, 215, 50) if first else (50, 230, 140)
            half = t['size']['x'] / 2
            rad = math.radians(t['rot'][1])
            for side in (-1, 1):
                solids.append(box({'x': t['pos']['x'] + math.cos(rad) * half * side,
                                   'y': t['pos']['y'] - t['size']['y'] / 2 + 2.2,
                                   'z': t['pos']['z'] - math.sin(rad) * half * side},
                                  {'x': 0.55, 'y': 4.4, 'z': 0.55}, t['rot'], colour, True))

    solids += hero_cars(track)
    return solids


# Hero cars are drawn this many times life size, so they read on a 512 m circuit.
CAR_SCALE = 7


def hero_cars(track):
    """Four cars, one per idea the scene is built on, placed from the track itself.

    Hand-written coordinates were wrong the moment the circuit was regenerated, which is the
    whole reason the poster reads the track in the first place: the grid comes from the
    spawn points, the jump from the ramp that feeds it, the ceiling car from the flat slab.
    """
    out = []
    for spawn in track['spawns'][:2]:
        out += car_solids((spawn['pos']['x'], spawn['pos']['y'] + 2, spawn['pos']['z']),
                          (0, spawn['yaw'], 0), boost=True, scale=CAR_SCALE)

    # The launch ramp: the car is in the air, past the lip, nose still up.
    ramps = [s for s in track['surfaces'] if s['kind'] == 'ramp']
    if ramps:
        ramp = max(ramps, key=lambda r: r['size']['z'])
        yaw = ramp['rot'][1]
        ahead = math.radians(yaw)
        out += car_solids((ramp['pos']['x'] + math.sin(ahead) * 26, ramp['pos']['y'] + 13,
                           ramp['pos']['z'] + math.cos(ahead) * 26),
                          (-16, yaw, 0), boost=True, belly=True, scale=CAR_SCALE)

    # And one hanging under the flat part of the ceiling, wheels up against the slab.
    flat = [s for s in track['surfaces'] if s['kind'] == 'ceiling' and abs(s['rot'][0]) < 1]
    if flat:
        slab = max(flat, key=lambda c: c['size']['z'])
        out += car_solids((slab['pos']['x'], slab['pos']['y'] - 0.3 - 0.35 * CAR_SCALE,
                           slab['pos']['z']),
                          (0, slab['rot'][1] + 180, 180), flanks=True, scale=CAR_SCALE)
    return out


def draw_sky(base):
    sky = ImageDraw.Draw(base)
    for y in range(HEIGHT):
        t = y / (HEIGHT - 1)
        sky.line([(0, y), (WIDTH, y)],
                 fill=(int(8 + 16 * t), int(10 + 20 * t), int(22 + 34 * t), 255))
    rnd = random.Random(7)
    for _ in range(260):
        x, y = rnd.uniform(0, WIDTH), rnd.uniform(0, HEIGHT * 0.6)
        r = rnd.choice((0.6, 0.8, 1.2))
        v = rnd.randint(90, 210)
        sky.ellipse([x - r, y - r, x + r, y + r], fill=(v, v, min(255, v + 30), 255))
    # A cyan bloom behind the circuit, which is what lifts it off the background.
    halo = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 0))
    ImageDraw.Draw(halo).ellipse([WIDTH / 2 - 760, 60, WIDTH / 2 + 760, 820],
                                 fill=(12, 92, 130, 120))
    base.alpha_composite(halo.filter(ImageFilter.GaussianBlur(170)))


def draw_title(base):
    text = ImageDraw.Draw(base)
    # A band under the circuit so the type always has contrast, whatever the render does.
    band = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 0))
    ImageDraw.Draw(band).rectangle([0, 790, WIDTH, HEIGHT], fill=(4, 7, 14, 200))
    base.alpha_composite(band.filter(ImageFilter.GaussianBlur(40)))
    text.line([(SAFE_LEFT + 40, 812), (SAFE_RIGHT - 40, 812)], fill=(26, 217, 255, 150), width=2)

    # The title has to live inside the central square Places keeps, so it is sized to fit
    # rather than set at one size that happened to look right for one wording.
    title, tracking, limit = 'ELON ROADSTER RACE', 6, HEIGHT - 140
    size = 104
    while size > 40:
        font = load_font(size)
        widths = [text.textlength(c, font=font) for c in title]
        total = sum(widths) + tracking * (len(title) - 1)
        if total <= limit:
            break
        size -= 2
    x = WIDTH / 2 - total / 2
    for char, w in zip(title, widths):
        # Cyan ghost behind the white, for a little neon without a filter pass.
        text.text((x + 3, 873), char, font=font, fill=(26, 180, 230, 110))
        text.text((x, 870), char, font=font, fill=(255, 255, 255, 255))
        x += w + tracking

    sub = 'SERVER-AUTHORITATIVE STUNT RACING  ·  RAMPS  ·  THRUSTERS  ·  CEILING RUN'
    sub_size = 27
    while sub_size > 14:
        sub_font = load_font(sub_size)
        if text.textlength(sub, font=sub_font) <= limit:
            break
        sub_size -= 1
    text.text((WIDTH / 2 - text.textlength(sub, font=sub_font) / 2, 1002), sub,
              font=sub_font, fill=(26, 217, 255, 255))


def main():
    track = json.load(sys.stdin)
    solids = build_solids(track)
    camera = Camera(solids)

    base = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 255))
    draw_sky(base)

    # The floor the circuit sits on, drawn once as a single quad.
    ground = track['extent']
    plate = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 0))
    ImageDraw.Draw(plate).polygon(
        [camera.project(p) for p in ((0, 0, 0), (ground, 0, 0), (ground, 0, ground), (0, 0, ground))],
        fill=(14, 17, 26, 235))
    base.alpha_composite(plate)

    opaque = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(opaque)
    glow = Image.new('RGB', (WIDTH, HEIGHT), (0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    translucent = []

    for solid in sorted(solids, key=camera.depth, reverse=True):
        for pts, colour in faces_of(solid, camera):
            if solid['alpha'] < 255:
                translucent.append((pts, colour + (solid['alpha'],)))
                continue
            draw.polygon(pts, fill=colour + (255,), outline=(0, 0, 0, 90))
            if solid['emissive']:
                glow_draw.polygon(pts, fill=colour)

    base.alpha_composite(opaque)
    # The ceiling slab last: it is above everything, and you should see the inverted car
    # through it.
    if translucent:
        glass = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 0))
        glass_draw = ImageDraw.Draw(glass)
        for pts, colour in translucent:
            glass_draw.polygon(pts, fill=colour, outline=(120, 190, 255, 120))
        base.alpha_composite(glass)

    # Bloom: the emissive faces again, blurred and added back.
    bloom = glow.filter(ImageFilter.GaussianBlur(26))
    base = Image.alpha_composite(base, Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 0)))
    rgb = ImageChops.add(base.convert('RGB'), bloom.point(lambda v: int(v * 0.85)))
    rgb = ImageChops.add(rgb, glow.filter(ImageFilter.GaussianBlur(7)).point(lambda v: int(v * 0.5)))
    base = rgb.convert('RGBA')

    # Vignette, so the eye lands in the middle of the frame.
    mask = Image.new('L', (WIDTH, HEIGHT), 0)
    ImageDraw.Draw(mask).ellipse([-460, -380, WIDTH + 460, HEIGHT + 380], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(220))
    dark = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 255))
    base = Image.composite(base, dark, mask)

    draw_title(base)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    base.convert('RGB').save(OUT, 'PNG', optimize=True)
    print(f'{OUT} {os.path.getsize(OUT) // 1024} KB')


if __name__ == '__main__':
    main()
