#!/usr/bin/env python3
"""
Renders the HUD minimap: a plain top-down plate of the circuit, from the same track data
the server turns into colliders.

    cd scene
    (cd ../server && npx tsx -e "import {TRACK} from '../shared/track'; \\
        process.stdout.write(JSON.stringify(TRACK))") | python3 tools/make-minimap.py

Output: images/minimap.png, 512x512 with an alpha channel.

The scene draws the car over this as a positioned dot, so the projection has to be the one
the UI assumes and nothing else: x straight across, z up the image (north up, like the
explorer's own minimap), the whole parcel block mapped onto the full square. Any crop or
margin here would put the dot in the wrong place, which is why there is neither.
"""

import json
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

SIZE = 512
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'images',
                   'minimap.png')

ROAD = (150, 162, 185, 255)
CORNER_ROAD = (150, 162, 185, 255)
BUILDING = (58, 64, 82, 190)
CEILING = (70, 150, 230, 230)
RAMP = (235, 170, 60, 255)
START = (255, 255, 255, 255)
BOOST = (40, 220, 255, 255)
PLATE = (10, 13, 22, 170)


def main():
    track = json.load(sys.stdin)
    extent = track['extent']
    scale = SIZE / extent

    def project(x, z):
        """World (x, z) -> image (px, py), north up."""
        return x * scale, (extent - z) * scale

    image = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=10, fill=PLATE)

    def quad(pos, size, rot, colour):
        """One axis-aligned box, rotated about Y, as a filled polygon."""
        yaw = math.radians(rot[1])
        hx, hz = size['x'] / 2, size['z'] / 2
        points = []
        for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            lx, lz = sx * hx, sz * hz
            wx = pos['x'] + lx * math.cos(yaw) + lz * math.sin(yaw)
            wz = pos['z'] - lx * math.sin(yaw) + lz * math.cos(yaw)
            points.append(project(wx, wz))
        draw.polygon(points, fill=colour)

    for s in track['surfaces']:
        if s['kind'] in ('ground', 'wall'):
            continue
        colour = {
            'road': ROAD,
            'ramp': RAMP,
            'ceiling': CEILING,
            'startline': START,
            'building': BUILDING
        }[s['kind']]
        quad(s['pos'], s['size'], s['rot'], colour)

    for t in track['triggers']:
        if t['kind'] == 'boost':
            quad(t['pos'], t['size'], t['rot'], BOOST)

    # A soft glow under the asphalt, so the line of the circuit reads at a glance even at
    # the size this is drawn in the HUD.
    glow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    for s in track['surfaces']:
        if s['kind'] in ('road', 'ramp', 'startline'):
            yaw = math.radians(s['rot'][1])
            hx, hz = s['size']['x'] / 2, s['size']['z'] / 2
            points = []
            for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                lx, lz = sx * hx, sz * hz
                wx = s['pos']['x'] + lx * math.cos(yaw) + lz * math.sin(yaw)
                wz = s['pos']['z'] - lx * math.sin(yaw) + lz * math.cos(yaw)
                points.append(project(wx, wz))
            glow_draw.polygon(points, fill=(80, 200, 255, 90))
    image.alpha_composite(glow.filter(ImageFilter.GaussianBlur(4)))
    image.alpha_composite(image.copy())

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    image.save(OUT, 'PNG', optimize=True)
    print(f'{os.path.relpath(OUT, os.path.dirname(os.path.dirname(OUT)))}  '
          f'{os.path.getsize(OUT) // 1024} KB  {SIZE}x{SIZE}')


if __name__ == '__main__':
    main()
