#!/usr/bin/env python3
"""
Renders every image the HUD uses: the logo, the 9-slice frames, buttons, key caps, icons
and the circuit thumbnails of the lobby carousel.

    python3 scene/tools/ui/make-ui.py

Output: scene/images/ui/*.png. Nothing in that folder is edited by hand; change this file
and run it again.

Two rules shape everything below.

The frames are drawn at the size they appear on screen. The explorer draws a 9-slice
border at the texture's own pixel size, so a 24 px chamfer has to be 24 texture pixels;
the slice fractions `ui.tsx` passes are the `slice / size` printed at the end of a run.

Every frame that glows carries a transparent margin for the glow, and its plain twin
carries the same margin, so swapping one for the other (a selected card for an idle one)
never moves anything. `ui.tsx` knows these margins as constants: keep them in step.

Everything is drawn at SS times its size and scaled down, which is the only antialiasing
Pillow's polygon drawing gets.
"""

import math
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'images', 'ui')

SS = 4

ACCENT = (58, 209, 255)
GLASS = (8, 22, 40)
INK = (242, 247, 255)
PINK = (255, 77, 109)
GREEN_TEXT = (5, 42, 18)

SF = '/System/Library/Fonts/SFNS.ttf'
ARIAL_BLACK = '/System/Library/Fonts/Supplemental/Arial Black.ttf'


def rgba(c, a):
    return (c[0], c[1], c[2], int(round(a * 255)))


def save(img, name):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    img.save(path, optimize=True)
    return path


def down(img, size):
    return img.resize(size, Image.LANCZOS)


# --- Shapes -------------------------------------------------------------------------------

def chamfer_poly(x0, y0, x1, y1, tl=0, tr=0, br=0, bl=0):
    """A rectangle with any of its corners cut at 45 degrees."""
    pts = []
    pts += [(x0, y0 + tl), (x0 + tl, y0)] if tl else [(x0, y0)]
    pts += [(x1 - tr, y0), (x1, y0 + tr)] if tr else [(x1, y0)]
    pts += [(x1, y1 - br), (x1 - br, y1)] if br else [(x1, y1)]
    pts += [(x0 + bl, y1), (x0, y1 - bl)] if bl else [(x0, y1)]
    return pts


def shape_mask(size, draw_fn):
    """A full-resolution L mask from a function that draws at SS scale."""
    w, h = size
    m = Image.new('L', (w * SS, h * SS), 0)
    draw_fn(ImageDraw.Draw(m), SS)
    return m


def chamfer_mask(size, inset, chamfers):
    w, h = size

    def fn(d, s):
        d.polygon(chamfer_poly(inset * s, inset * s, (w - inset) * s, (h - inset) * s,
                               *[c * s for c in chamfers]), fill=255)
    return shape_mask(size, fn)


def round_mask(size, inset, radius):
    w, h = size

    def fn(d, s):
        d.rounded_rectangle((inset * s, inset * s, (w - inset) * s - 1, (h - inset) * s - 1),
                            radius=radius * s, fill=255)
    return shape_mask(size, fn)


def erode(mask, px):
    """Shrink a mask by `px` full-resolution pixels (the mask itself is at SS scale)."""
    k = px * SS * 2 + 1
    return mask.filter(ImageFilter.MinFilter(k if k % 2 else k + 1))


def solid(size, colour):
    return Image.new('RGBA', size, colour)


def layer(colour, mask):
    """A flat colour cut by a mask; colour carries its own alpha."""
    img = Image.new('RGBA', mask.size, colour[:3] + (0,))
    a = mask.point(lambda v: v * colour[3] // 255)
    img.putalpha(a)
    return img


def vgradient(size, stops):
    """Vertical gradient through (t, rgba) stops."""
    w, h = size
    col = Image.new('RGBA', (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        for i in range(len(stops) - 1):
            t0, c0 = stops[i]
            t1, c1 = stops[i + 1]
            if t0 <= t <= t1:
                f = (t - t0) / max(1e-6, t1 - t0)
                col.putpixel((0, y), tuple(int(round(c0[j] + (c1[j] - c0[j]) * f)) for j in range(4)))
                break
    return col.resize((w, h))


def hgradient(size, stops):
    w, h = size
    return vgradient((h, w), stops).transpose(Image.ROTATE_90).resize((w, h))


def clip(img, mask):
    out = img.copy()
    out.putalpha(ImageChops.multiply(img.getchannel('A'), mask))
    return out


def ring(outer, width):
    """The band `width` pixels wide just inside a mask's edge."""
    return ImageChops.subtract(outer, erode(outer, width))


def glow(mask, colour, radius, strength):
    blurred = mask.filter(ImageFilter.GaussianBlur(radius * SS))
    return layer(rgba(colour, strength), blurred)


# --- Frames -------------------------------------------------------------------------------

def glass_frame(size, margin, chamfers, border_alpha, glow_strength, fill_alpha=0.86,
                inner_glow=True, radius=None):
    """
    Dark blue glass with a cyan border. `margin` is the transparent band left round the
    panel for the glow; `chamfers` are (tl, tr, br, bl) in pixels, or `radius` rounds them.
    """
    if radius is not None:
        outer = round_mask(size, margin, radius)
    else:
        outer = chamfer_mask(size, margin, chamfers)
    big = (size[0] * SS, size[1] * SS)
    img = Image.new('RGBA', big, (0, 0, 0, 0))
    if glow_strength > 0:
        g = glow(outer, ACCENT, 7, glow_strength)
        # Outside only: the fill is translucent and a glow behind it would tint the glass.
        g.putalpha(ImageChops.multiply(g.getchannel('A'), ImageChops.invert(outer)))
        img = Image.alpha_composite(img, g)
        # A hairline of black just outside the border, as the mockup's 1 px shadow ring:
        # it is what keeps the cyan edge readable against a bright sky.
        halo = ImageChops.subtract(outer.filter(ImageFilter.MaxFilter(SS * 2 + 1)), outer)
        img = Image.alpha_composite(img, layer((0, 0, 0, 110), halo))
    img = Image.alpha_composite(img, layer(rgba(GLASS, fill_alpha), outer))
    if inner_glow:
        inner = ImageChops.subtract(outer, erode(outer, 14)).filter(ImageFilter.GaussianBlur(8 * SS))
        inner = ImageChops.multiply(inner, outer)
        img = Image.alpha_composite(img, layer(rgba(ACCENT, 0.10), inner))
    img = Image.alpha_composite(img, layer(rgba(ACCENT, border_alpha), ring(outer, 2)))
    return down(img, size)


def card(size, margin, radius, border, fill_stops, glow_colour=None, glow_strength=0.0):
    outer = round_mask(size, margin, radius)
    big = (size[0] * SS, size[1] * SS)
    img = Image.new('RGBA', big, (0, 0, 0, 0))
    if glow_colour is not None:
        g = glow(outer, glow_colour, 6, glow_strength)
        g.putalpha(ImageChops.multiply(g.getchannel('A'), ImageChops.invert(outer)))
        img = Image.alpha_composite(img, g)
    img = Image.alpha_composite(img, clip(vgradient(big, fill_stops), outer))
    img = Image.alpha_composite(img, layer(border, ring(outer, 2)))
    return down(img, size)


def toast_frame(size):
    """A plate with pointed ends, for event notices. Stretched sideways only."""
    w, h = size
    p = 16

    def fn(d, s):
        d.polygon([(p * s, 1 * s), ((w - p) * s, 1 * s), ((w - 1) * s, h / 2 * s),
                   ((w - p) * s, (h - 1) * s), (p * s, (h - 1) * s), (1 * s, h / 2 * s)], fill=255)
    outer = shape_mask(size, fn)
    big = (w * SS, h * SS)
    img = Image.new('RGBA', big, (0, 0, 0, 0))
    img = Image.alpha_composite(img, layer(rgba(GLASS, 0.9), outer))
    img = Image.alpha_composite(img, layer(rgba(ACCENT, 0.7), ring(outer, 2)))
    return down(img, size)


def segment(size, colour):
    """One cell of the speed bar: a parallelogram leaning forward."""
    w, h = size
    lean = h * 0.5

    def fn(d, s):
        d.polygon([(lean * s, 0), (w * s, 0), ((w - lean) * s, h * s), (0, h * s)], fill=255)
    return down(layer(colour, shape_mask(size, fn)), size)


def ring_button(size, fill, edge):
    w, h = size

    def fn(d, s):
        d.ellipse((1 * s, 1 * s, (w - 1) * s, (h - 1) * s), fill=255)
    outer = shape_mask(size, fn)
    img = Image.new('RGBA', outer.size, (0, 0, 0, 0))
    img = Image.alpha_composite(img, layer(fill, outer))
    img = Image.alpha_composite(img, layer(edge, ring(outer, 2)))
    return down(img, size)


def dot(size, colour):
    def fn(d, s):
        d.ellipse((1 * s, 1 * s, (size[0] - 1) * s, (size[1] - 1) * s), fill=255)
    return down(layer(colour, shape_mask(size, fn)), size)


# --- Icons --------------------------------------------------------------------------------

def icon(draw_fn, colour, size=32):
    """Icons are drawn on a 24-unit grid, like the mockup's SVGs, and scaled to `size`."""
    s = size * SS / 24.0
    m = Image.new('L', (size * SS, size * SS), 0)
    draw_fn(ImageDraw.Draw(m), s)
    return down(layer(colour, m), (size, size))


def stroke_poly(d, pts, s, width, closed=False):
    pts = [(x * s, y * s) for x, y in pts]
    if closed:
        pts = pts + [pts[0]]
    d.line(pts, fill=255, width=int(width * s), joint='curve')
    for x, y in pts:
        r = width * s / 2
        d.ellipse((x - r, y - r, x + r, y + r), fill=255)


def arc_pts(cx, cy, r, a0, a1, n=24):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


def i_flag(d, s):
    # Chequered flag on a pole, as the RACE SETUP header.
    d.rectangle((2 * s, 3 * s, 4 * s, 22 * s), fill=255)
    cell = 4
    for row in range(3):
        for col in range(5):
            if (row + col) % 2 == 0:
                x = 4 + col * cell
                y = 3 + row * cell
                d.rectangle((x * s, y * s, (x + cell) * s, (y + cell) * s), fill=255)
    # The dark cells are left as gaps, framed so the flag still reads as a rectangle.
    d.rectangle((4 * s, 3 * s, 24 * s - 1, 15 * s), outline=255, width=int(1.2 * s))


def i_mode(d, s):
    # Gamepad.
    d.rounded_rectangle((2 * s, 7 * s, 22 * s, 18 * s), radius=5 * s, outline=255, width=int(2 * s))
    d.rectangle((6 * s, 11.5 * s, 10 * s, 13.5 * s), fill=255)
    d.rectangle((7 * s, 10.5 * s, 9 * s, 14.5 * s), fill=255)
    d.ellipse((14.5 * s, 10 * s, 16.5 * s, 12 * s), fill=255)
    d.ellipse((17 * s, 12.5 * s, 19 * s, 14.5 * s), fill=255)


def i_person(d, s):
    d.ellipse((7.5 * s, 2.5 * s, 16.5 * s, 11.5 * s), fill=255)
    d.chord((3 * s, 13 * s, 21 * s, 29 * s), 180, 360, fill=255)


def i_people(d, s):
    d.ellipse((4.5 * s, 4.5 * s, 11.5 * s, 11.5 * s), fill=255)
    d.ellipse((12.5 * s, 4.5 * s, 19.5 * s, 11.5 * s), fill=255)
    d.chord((1 * s, 13.5 * s, 15 * s, 25 * s), 180, 360, fill=255)
    d.chord((9 * s, 13.5 * s, 23 * s, 25 * s), 180, 360, fill=255)


def i_robot(d, s):
    d.rounded_rectangle((4 * s, 7 * s, 20 * s, 20 * s), radius=3 * s, outline=255, width=int(2 * s))
    d.ellipse((7.5 * s, 11.5 * s, 10.5 * s, 14.5 * s), fill=255)
    d.ellipse((13.5 * s, 11.5 * s, 16.5 * s, 14.5 * s), fill=255)
    d.rectangle((11 * s, 3 * s, 13 * s, 7 * s), fill=255)
    d.ellipse((10 * s, 1.5 * s, 14 * s, 5.5 * s), fill=255)
    d.rectangle((9 * s, 16.5 * s, 15 * s, 17.5 * s), fill=255)


def i_laps(d, s):
    # Circular arrow: one more time round.
    stroke_poly(d, arc_pts(12, 12, 8, -60, 230), s, 2.2)
    d.polygon([(19.5 * s, 2 * s), (21 * s, 10.5 * s), (13 * s, 8 * s)], fill=255)


def i_play(d, s):
    d.polygon([(5 * s, 3 * s), (21 * s, 12 * s), (5 * s, 21 * s)], fill=255)


def i_eye(d, s):
    top = arc_pts(12, 22, 14.5, 213, 327)
    bottom = arc_pts(12, 2, 14.5, 33, 147)
    stroke_poly(d, top + bottom, s, 2, closed=True)
    d.ellipse((8.5 * s, 8.5 * s, 15.5 * s, 15.5 * s), outline=255, width=int(2 * s))
    d.ellipse((10.5 * s, 10.5 * s, 13.5 * s, 13.5 * s), fill=255)


def i_gas(d, s):
    # Fuel pump, for the charge bar: body with its dial window, hose and nozzle on the side.
    d.rounded_rectangle((3 * s, 3 * s, 14 * s, 21 * s), radius=1.5 * s, fill=255)
    d.rectangle((5.5 * s, 5.5 * s, 11.5 * s, 10 * s), fill=0)
    d.rectangle((1.5 * s, 20 * s, 15.5 * s, 22.5 * s), fill=255)
    stroke_poly(d, [(14, 8), (18, 8), (19.5, 10), (19.5, 17), (21, 18.5), (21, 6), (18.5, 3.5)], s, 1.8)


def i_bolt(d, s):
    d.polygon([(14 * s, 1 * s), (4 * s, 14 * s), (11 * s, 14 * s), (9 * s, 23 * s),
               (20 * s, 9 * s), (13 * s, 9 * s)], fill=255)


def i_question(d, s):
    stroke_poly(d, arc_pts(12, 8.5, 5, 180, 360) + [(17, 8.5), (16.5, 10.5), (12, 13.5), (12, 16)], s, 3)
    d.ellipse((10.2 * s, 18.5 * s, 13.8 * s, 22.1 * s), fill=255)


def i_left(d, s):
    stroke_poly(d, [(15, 4), (7, 12), (15, 20)], s, 3)


def i_right(d, s):
    stroke_poly(d, [(9, 4), (17, 12), (9, 20)], s, 3)


def i_up(d, s):
    # Lift: an arrow up off a bar, for the thrusters.
    d.polygon([(12 * s, 2 * s), (20 * s, 11 * s), (15 * s, 11 * s), (15 * s, 17 * s), (9 * s, 17 * s),
               (9 * s, 11 * s), (4 * s, 11 * s)], fill=255)
    d.rectangle((4 * s, 19.5 * s, 20 * s, 22 * s), fill=255)


def i_brake(d, s):
    # Brake pedal: wider and squatter than the accelerator, ribbed across.
    d.rounded_rectangle((3 * s, 5 * s, 21 * s, 17 * s), radius=2 * s, fill=255)
    for y in (8, 11, 14):
        d.rectangle((6 * s, (y - 0.7) * s, 18 * s, (y + 0.7) * s), fill=0)
    d.rectangle((10 * s, 17 * s, 14 * s, 22 * s), fill=255)


def i_pedal(d, s):
    # Accelerator pedal: a tall plate, ribbed, on its hinge.
    d.polygon([(7 * s, 2 * s), (18 * s, 2 * s), (19 * s, 18 * s), (6 * s, 18 * s)], fill=255)
    for y in (6, 10, 14):
        d.rectangle((8.5 * s, y * s, 16.5 * s, (y + 1.4) * s), fill=0)
    d.rectangle((10 * s, 19 * s, 15 * s, 22 * s), fill=255)


ICONS = {
    # name: (drawing, colour). Colours are baked rather than tinted in the scene: the
    # renderer multiplies a background colour into its texture, but an icon that only
    # looks right if every client honours that is an icon that can come out white.
    'flag': (i_flag, INK + (255,)),
    'mode': (i_mode, ACCENT + (255,)),
    'robot': (i_robot, ACCENT + (255,)),
    'laps': (i_laps, ACCENT + (255,)),
    'person': (i_person, INK + (255,)),
    'people': (i_people, INK + (255,)),
    'play': (i_play, GREEN_TEXT + (255,)),
    'eye': (i_eye, ACCENT + (255,)),
    'gas': (i_gas, PINK + (255,)),
    'bolt': (i_bolt, INK + (255,)),
    'question': (i_question, INK + (255,)),
    'left': (i_left, INK + (255,)),
    'right': (i_right, INK + (255,)),
    'up': (i_up, INK + (255,)),
    'pedal': (i_pedal, INK + (255,)),
    'brake': (i_brake, INK + (255,)),
}


# --- Checkpoint arrow --------------------------------------------------------------------

ARROW_STEPS = 16


def arrow(index, size=64):
    """
    The way-back arrow, turned `index` sixteenths of a turn clockwise from straight up
    (straight ahead). The renderer cannot rotate UI, so every heading is its own image and
    the HUD picks the nearest.
    """
    big = size * SS
    m = Image.new('L', (big, big), 0)
    d = ImageDraw.Draw(m)
    u = big / 24.0
    d.polygon([(12 * u, 2 * u), (21 * u, 13 * u), (15.5 * u, 13 * u), (15.5 * u, 22 * u),
               (8.5 * u, 22 * u), (8.5 * u, 13 * u), (3 * u, 13 * u)], fill=255)
    m = m.rotate(-360.0 * index / ARROW_STEPS, resample=Image.BICUBIC)
    keyline = m.filter(ImageFilter.MaxFilter(SS * 2 + 1))
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    img = Image.alpha_composite(img, glow(keyline, ACCENT, 3, 0.5))
    img = Image.alpha_composite(img, layer((4, 12, 24, 230), keyline))
    img = Image.alpha_composite(img, layer(ACCENT + (255,), m))
    return down(img, (size, size))


# --- Logo ---------------------------------------------------------------------------------

def logo_font(size):
    """SF Pro at its widest and heaviest: the closest system face to the logo's extended
    sans. Impact and Arial Black are both narrow, and stretching them fattens the
    verticals but not the horizontals."""
    f = ImageFont.truetype(SF, size)
    f.set_variation_by_axes([150, 96, 400, 1000])
    return f


def word_mask(text, size, shear, tracking, squash=1.0):
    """A word as a mask, set with extra tracking, squashed to the logo's low, wide
    letters and slanted like an italic."""
    font = logo_font(size)
    asc, desc = font.getmetrics()
    pad = int(size * 0.6)
    w = int(sum(font.getlength(ch) for ch in text) + tracking * len(text) + pad * 2)
    h = asc + desc + pad * 2
    m = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(m)
    x = pad
    for ch in text:
        d.text((x, pad), ch, font=font, fill=255)
        x += font.getlength(ch) + tracking
    # Shear about the baseline so the word leans right without sliding along it.
    base = pad + asc
    m = m.transform(m.size, Image.AFFINE, (1, shear, -shear * base, 0, 1, 0), Image.BICUBIC)
    m = m.crop(m.getbbox())
    return m.resize((m.size[0], int(m.size[1] * squash)), Image.LANCZOS)


def styled_word(mask, face_stops, edge, depth_colour, glow_colour, depth):
    """
    Face gradient, a dark keyline, a short extrusion down and to the right, a soft glow
    and a gloss on the upper half: the reference logo's treatment, in layers.
    """
    margin = 60
    w, h = mask.size
    big = Image.new('L', (w + margin * 2, h + margin * 2), 0)
    big.paste(mask, (margin, margin))
    out = Image.new('RGBA', big.size, (0, 0, 0, 0))

    keyline = big.filter(ImageFilter.MaxFilter(7))
    # Extrusion: the keyline repeated a pixel at a time down and right, in the dark tone.
    ext = Image.new('L', big.size, 0)
    for i in range(1, depth + 1):
        ext = ImageChops.lighter(ext, ImageChops.offset(keyline, int(i * 0.45), i))

    shadow = ImageChops.offset(ImageChops.lighter(ext, keyline), 6, 10).filter(ImageFilter.GaussianBlur(9))
    out = Image.alpha_composite(out, layer((0, 0, 0, 150), shadow))
    halo = keyline.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(16))
    out = Image.alpha_composite(out, layer(glow_colour, halo))
    out = Image.alpha_composite(out, layer(depth_colour, ext))
    out = Image.alpha_composite(out, layer(edge, keyline))

    # The face gradient spans the letters' own height, not the padded layer's.
    face = Image.new('RGBA', big.size, (0, 0, 0, 0))
    face.paste(vgradient((big.size[0], h), face_stops), (0, margin))
    out = Image.alpha_composite(out, clip(face, big))

    # Gloss: a lighter band over the top of each letter, fading out before the middle.
    gloss = Image.new('RGBA', big.size, (0, 0, 0, 0))
    gloss.paste(vgradient((big.size[0], h), [(0, (255, 255, 255, 120)), (0.42, (255, 255, 255, 30)),
                                              (0.46, (255, 255, 255, 0)), (1, (255, 255, 255, 0))]),
                (0, margin))
    out = Image.alpha_composite(out, clip(gloss, erode_px(big, 3)))
    # A bright rim along the top edge of each stroke.
    rim = ImageChops.subtract(big, ImageChops.offset(big, 0, 3))
    out = Image.alpha_composite(out, layer((255, 255, 255, 170), rim))
    return out, margin


def erode_px(mask, px):
    return mask.filter(ImageFilter.MinFilter(px * 2 + 1))


def checker_flag(width, height, shear):
    """The waving chequered flag that leads into ROADSTER, fading out to the left."""
    cols, rows = 6, 3
    cw, ch = width / cols, height / rows
    m_white = Image.new('L', (width, height), 0)
    m_dark = Image.new('L', (width, height), 0)
    dw, dd = ImageDraw.Draw(m_white), ImageDraw.Draw(m_dark)
    for r in range(rows):
        for c in range(cols):
            # Each column dips a little, so the flag ripples rather than sitting flat.
            wave = math.sin(c / cols * math.pi * 1.6) * ch * 0.35
            box = [c * cw + 3, r * ch + wave + 3, (c + 1) * cw - 3, (r + 1) * ch + wave - 3]
            (dw if (r + c) % 2 == 0 else dd).rectangle(box, fill=255)
    fade = hgradient((width, height), [(0, (0, 0, 0, 60)), (0.45, (0, 0, 0, 235)), (1, (0, 0, 0, 255))]).getchannel('A')
    pad = int(height * 0.5)
    out = Image.new('RGBA', (width + pad * 2, height + pad * 2), (0, 0, 0, 0))
    white = ImageChops.multiply(m_white, fade)
    dark = ImageChops.multiply(m_dark, fade)
    tmp = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    tmp = Image.alpha_composite(tmp, layer((20, 34, 60, 70), dark))
    tmp = Image.alpha_composite(tmp, layer((245, 250, 255, 255), white))
    out.paste(tmp, (pad, pad))
    a = out.getchannel('A')
    shadow = layer((0, 0, 0, 120), ImageChops.offset(a, 4, 6).filter(ImageFilter.GaussianBlur(5)))
    out = Image.alpha_composite(shadow, out)
    out = out.transform(out.size, Image.AFFINE, (1, shear, -shear * out.size[1], 0, 1, 0), Image.BICUBIC)
    return out


def make_logo(size=(1024, 256)):
    shear = 0.24
    big_scale = 3
    elon = word_mask('ELON', 176 * big_scale, shear, 4 * big_scale, squash=0.66)
    road = word_mask('ROADSTER', 76 * big_scale, shear, 6 * big_scale, squash=0.9)
    race = word_mask('RACE', 76 * big_scale, shear, 6 * big_scale, squash=0.9)

    elon_img, em = styled_word(
        elon, [(0, (255, 255, 255, 255)), (0.6, (236, 242, 250, 255)), (1, (196, 210, 228, 255))],
        (14, 24, 44, 255), (70, 92, 130, 255), (190, 230, 255, 130), 6 * big_scale)
    road_img, rm = styled_word(
        road, [(0, (200, 250, 255, 255)), (0.45, (90, 222, 255, 255)), (1, (30, 150, 230, 255))],
        (6, 22, 48, 255), (14, 70, 130, 255), (58, 209, 255, 190), 4 * big_scale)
    race_img, cm = styled_word(
        race, [(0, (255, 180, 196, 255)), (0.45, (255, 84, 116, 255)), (1, (214, 30, 76, 255))],
        (40, 8, 22, 255), (120, 16, 44, 255), (255, 77, 109, 190), 4 * big_scale)
    flag = checker_flag(150 * big_scale, 78 * big_scale, shear)

    # Layout in the reference's proportions: ELON on top, set in from the left; the flag
    # under its first letter, leading into ROADSTER RACE, which runs further right.
    line2_top = elon.size[1] + 12 * big_scale
    flag_x = 0
    road_x = flag_x + flag.size[0] - 20 * big_scale
    race_x = road_x + road.size[0] + 22 * big_scale
    # ELON starts a little before ROADSTER and ends about where it does.
    elon_x = road_x + road.size[0] - elon.size[0] + 10 * big_scale
    width = race_x + race.size[0] + 60 * big_scale
    height = line2_top + road.size[1] + 40 * big_scale
    canvas = Image.new('RGBA', (width + 200, height + 200), (0, 0, 0, 0))
    o = 100
    canvas.alpha_composite(flag, (o + flag_x, o + line2_top + road.size[1] // 2 - flag.size[1] // 2 + 6 * big_scale))
    canvas.alpha_composite(road_img, (o + road_x - rm, o + line2_top - rm))
    canvas.alpha_composite(race_img, (o + race_x - cm, o + line2_top - cm))
    canvas.alpha_composite(elon_img, (o + elon_x - em, o - em))

    box = canvas.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    canvas = canvas.crop(box)
    # Fit into the texture keeping the aspect, left aligned and vertically centred: the
    # HUD lays the logo out from its top-left corner.
    k = min(size[0] / canvas.size[0], size[1] / canvas.size[1])
    fitted = canvas.resize((int(canvas.size[0] * k), int(canvas.size[1] * k)), Image.LANCZOS)
    out = Image.new('RGBA', size, (0, 0, 0, 0))
    out.alpha_composite(fitted, (0, (size[1] - fitted.size[1]) // 2))
    return out


# --- Circuit thumbnails -------------------------------------------------------------------

def windows(d, x0, y0, x1, y1, colour, step=(10, 9), size=(5, 4)):
    y = y0 + 5
    while y + size[1] < y1 - 2:
        x = x0 + 4
        while x + size[0] < x1 - 3:
            d.rectangle((x, y, x + size[0], y + size[1]), fill=colour)
            x += step[0]
        y += step[1]


def thumb_city(w, h):
    img = vgradient((w, h), [(0, (111, 185, 234, 255)), (0.47, (185, 221, 244, 255)),
                             (0.48, (98, 106, 122, 255)), (1, (62, 69, 82, 255))])
    d = ImageDraw.Draw(img)
    horizon = int(h * 0.48)
    towers = [(18, 0.30, 46), (70, 0.12, 30), (106, 0.34, 40), (160, 0.22, 34), (204, 0.40, 56),
              (276, 0.18, 30), (312, 0.28, 50)]
    for x, top, tw in towers:
        y = int(h * top)
        d.rectangle((x, y, x + tw, horizon), fill=(216, 226, 236, 255))
        d.rectangle((x, y, x + tw, y + 3), fill=(244, 246, 248, 255))
        windows(d, x, y + 3, x + tw, horizon, (143, 182, 216, 255))
    # Kerb and the start straight vanishing towards the middle.
    for i in range(0, w, 16):
        d.rectangle((i, horizon, i + 8, horizon + 3), fill=(227, 59, 59, 255))
        d.rectangle((i + 8, horizon, i + 16, horizon + 3), fill=(244, 244, 244, 255))
    d.polygon([(w * 0.47, horizon + 3), (w * 0.53, horizon + 3), (w * 0.75, h), (w * 0.25, h)],
              fill=(116, 122, 134, 255))
    for k in range(4):
        y0 = horizon + 8 + k * 12
        d.rectangle((w * 0.497, y0, w * 0.503 + k * 0.6, y0 + 5 + k), fill=(232, 236, 242, 255))
    return img


def thumb_skyline(w, h):
    img = vgradient((w, h), [(0, (18, 16, 52, 255)), (0.5, (64, 34, 102, 255)), (0.62, (196, 72, 132, 255)),
                             (0.63, (24, 22, 40, 255)), (1, (12, 12, 22, 255))])
    d = ImageDraw.Draw(img)
    horizon = int(h * 0.62)
    # Stars.
    for i in range(40):
        x = (i * 97) % w
        y = (i * 53) % int(h * 0.45)
        d.point((x, y), fill=(230, 230, 255, 160))
    towers = [(10, 0.20, 34), (48, 0.06, 26), (80, 0.30, 44), (130, 0.02, 30), (166, 0.24, 52),
              (224, 0.10, 28), (258, 0.34, 40), (302, 0.04, 36), (340, 0.28, 16)]
    for i, (x, top, tw) in enumerate(towers):
        y = int(h * top)
        d.rectangle((x, y, x + tw, horizon), fill=(26, 22, 48, 255))
        light = (58, 209, 255, 255) if i % 2 == 0 else (255, 77, 160, 255)
        d.rectangle((x, y, x + tw, y + 2), fill=light)
        windows(d, x, y + 2, x + tw, horizon, (light[0], light[1], light[2], 110), step=(8, 8), size=(3, 3))
    # The gap between rooftops the circuit jumps, as a lit edge with nothing under it.
    d.rectangle((0, horizon, w * 0.42, horizon + 4), fill=(58, 209, 255, 255))
    d.rectangle((w * 0.58, horizon, w, horizon + 4), fill=(58, 209, 255, 255))
    return img


def thumbnail(draw_fn, display=(356, 100), size=(512, 128)):
    """
    Drawn at the size it is shown, then squeezed into a power-of-two texture: the HUD
    stretches it back, so it lands undistorted.
    """
    w, h = display[0] * 2, display[1] * 2
    img = draw_fn(w, h)
    # The bottom of the card darkens so the circuit's name reads over any scene.
    shade = vgradient((w, h), [(0, (4, 12, 24, 0)), (0.45, (4, 12, 24, 0)), (1, (4, 12, 24, 235))])
    img = Image.alpha_composite(img, shade)
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=16, fill=255)
    img = clip(img, mask)
    img = Image.alpha_composite(img, layer(rgba(ACCENT, 0.6), ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(5)))))
    return img.resize(size, Image.LANCZOS)


# --- Main ---------------------------------------------------------------------------------

def main():
    made = []

    def put(img, name, slices=None):
        path = save(img, name)
        made.append((name, img.size, os.path.getsize(path), slices))

    put(make_logo(), 'logo.png')

    # Frames. Comments give the margin (transparent glow band) and slice in pixels.
    # panel-frame: lobby card. Chamfered top-right and bottom-left, glowing. margin 12.
    put(glass_frame((128, 128), 12, (0, 24, 0, 24), 0.8, 0.30), 'panel-frame.png', 40)
    # panel-frame-tr: the HUD cards. Top-right chamfer only, glowing. margin 12.
    put(glass_frame((128, 128), 12, (0, 24, 0, 0), 0.8, 0.30), 'panel-frame-tr.png', 40)
    # panel-soft: secondary panels (standings). Bottom-right chamfer, no glow. margin 2.
    put(glass_frame((64, 64), 2, (0, 0, 18, 0), 0.5, 0.0, fill_alpha=0.86, inner_glow=False),
        'panel-soft.png', 24)
    # panel-tag: small buttons and tags (?, LEAVE, the menu tab). Top-right chamfer 12. margin 2.
    put(glass_frame((64, 64), 2, (0, 12, 0, 0), 0.6, 0.0, fill_alpha=0.86, inner_glow=False),
        'panel-tag.png', 16)
    # panel-plain: the controls legend. Rounded 8, faint border. margin 1.
    put(glass_frame((32, 32), 1, None, 0.35, 0.0, fill_alpha=0.86, inner_glow=False, radius=8),
        'panel-plain.png', 11)

    # Selectable cards share one geometry, so selecting one never moves anything. margin 8.
    put(card((64, 64), 8, 8, rgba(ACCENT, 1), [(0, rgba(ACCENT, 0.38)), (1, rgba(ACCENT, 0.14))],
             ACCENT, 0.35), 'card-on.png', 18)
    put(card((64, 64), 8, 8, (255, 255, 255, 56), [(0, (255, 255, 255, 13)), (1, (255, 255, 255, 13))]),
        'card-off.png', 18)
    # Buttons: the cards' margin, so the whole lobby card lines up on one grid. Glow on
    # the green one only.
    put(card((64, 128), 8, 8, (140, 255, 166, 255),
             [(0, (106, 242, 140, 255)), (1, (46, 204, 99, 255))], (74, 222, 128), 0.5),
        'button-green.png', 18)
    put(card((64, 64), 8, 8, rgba(ACCENT, 0.6), [(0, rgba(ACCENT, 0.09)), (1, rgba(ACCENT, 0.09))]),
        'button-outline.png', 18)
    put(card((32, 32), 0, 4, (255, 255, 255, 102), [(0, (255, 255, 255, 34)), (1, (255, 255, 255, 20))]),
        'key-cap.png', 7)

    put(toast_frame((256, 64)), 'toast-frame.png', 20)
    put(segment((32, 16), rgba(ACCENT, 1)), 'seg-on.png')
    put(segment((32, 16), (255, 255, 255, 46)), 'seg-off.png')
    put(hgradient((64, 8), [(0, PINK + (255,)), (1, ACCENT + (255,))]), 'charge-fill.png')
    # The brake button, made to sit among the explorer's own round buttons: a dark disc
    # with a light ring, brighter while held.
    put(ring_button((64, 64), (0, 0, 0, 110), (255, 255, 255, 170)), 'circle.png')
    put(ring_button((64, 64), rgba(ACCENT, 0.45), (255, 255, 255, 230)), 'circle-held.png')
    put(dot((16, 16), ACCENT + (255,)), 'dot-on.png')
    put(dot((16, 16), (255, 255, 255, 77)), 'dot-off.png')

    for name, (fn, colour) in ICONS.items():
        put(icon(fn, colour), f'icon-{name}.png')

    for i in range(ARROW_STEPS):
        put(arrow(i), f'arrow-{i:02d}.png')

    put(thumbnail(thumb_city), 'thumb-city.png')
    put(thumbnail(thumb_skyline), 'thumb-skyline.png')

    total = 0
    for name, size, nbytes, slices in made:
        total += nbytes
        frac = f'  slice {slices}px = {slices / size[0]:.4f}' if slices else ''
        print(f'{name:22s} {size[0]:4d}x{size[1]:<4d} {nbytes / 1024:6.1f} KB{frac}')
    print(f'{"total":22s} {"":9s} {total / 1024:6.1f} KB')


if __name__ == '__main__':
    main()
