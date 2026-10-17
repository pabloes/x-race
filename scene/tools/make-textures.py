#!/usr/bin/env python3
"""
Synthesises the two surface textures the circuit is made of, so the scene carries no
licensed image files and the look can be re-tuned by changing a number here.

    cd scene
    python3 tools/make-textures.py

Output: images/gravel.png and images/asphalt.png, 256x256 and tileable.

Tileable matters more than resolution: the ground is a 512 m square with the texture
repeated 128 times across it, so a seam would draw a grid over the whole scene. Every
feature is therefore placed with wraparound — a stone whose centre is near an edge is
drawn again on the opposite one — and the noise is generated from a wrapped lattice.
"""

import math
import os

import numpy as np
from PIL import Image

SIZE = 256
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'images')


def wrapped_noise(cells, seed, size=SIZE):
    """Value noise on a lattice that wraps, so the result tiles."""
    rng = np.random.default_rng(seed)
    lattice = rng.random((cells, cells))
    # Bilinear interpolation of the lattice, with the index wrapping at `cells`.
    u = np.linspace(0, cells, size, endpoint=False)
    i0 = np.floor(u).astype(int) % cells
    i1 = (i0 + 1) % cells
    frac = u - np.floor(u)
    # Smoothstep, so the cells do not show as diamonds.
    t = frac * frac * (3 - 2 * frac)
    a = lattice[np.ix_(i0, i0)] * (1 - t)[:, None] + lattice[np.ix_(i1, i0)] * t[:, None]
    b = lattice[np.ix_(i0, i1)] * (1 - t)[:, None] + lattice[np.ix_(i1, i1)] * t[:, None]
    return a * (1 - t)[None, :] + b * t[None, :]


def octaves(seed, levels=(4, 8, 16, 32)):
    out = np.zeros((SIZE, SIZE))
    weight = 0.0
    for level in levels:
        amplitude = 1 / level
        out += wrapped_noise(level, seed + level) * amplitude
        weight += amplitude
    return out / weight


def to_image(value, tint, name):
    """value is 0..1; tint is the RGB at full brightness."""
    value = np.clip(value, 0, 1)
    rgb = np.stack([value * c for c in tint], axis=-1)
    image = Image.fromarray((rgb * 255).astype('uint8'), 'RGB')
    path = os.path.join(OUT, f'{name}.png')
    image.save(path, 'PNG', optimize=True)
    print(f'images/{name}.png  {os.path.getsize(path) // 1024} KB  {SIZE}x{SIZE}')


def gravel():
    """Loose stones: round blobs of varying brightness over a dusty bed."""
    bed = 0.45 + octaves(3) * 0.35
    rng = np.random.default_rng(11)
    ys, xs = np.mgrid[0:SIZE, 0:SIZE]
    for _ in range(900):
        cx, cy = rng.uniform(0, SIZE, 2)
        radius = rng.uniform(1.6, 4.2)
        shade = rng.uniform(-0.3, 0.42)
        # Wrapped distance, so a stone on an edge continues on the other side.
        dx = np.minimum(np.abs(xs - cx), SIZE - np.abs(xs - cx))
        dy = np.minimum(np.abs(ys - cy), SIZE - np.abs(ys - cy))
        mask = (dx * dx + dy * dy) < radius * radius
        # A little lighting on each stone: brighter on one side than the other.
        bed[mask] += shade + (dy[mask] - dx[mask]) * 0.012
    return bed


def asphalt():
    """
    Tarmac: fine aggregate, a few lighter chips, no large features.

    Kept bright on purpose. The albedo colour the scene applies multiplies this, so a dark
    texture under a dark tint compounds into near black: the first version came out at
    0.16 x 0.2 and the circuit read as a hole in the ground.
    """
    base = 0.52 + octaves(7, levels=(16, 32, 64)) * 0.16
    rng = np.random.default_rng(23)
    chips = rng.random((SIZE, SIZE))
    base += (chips > 0.993) * 0.22
    base -= (chips < 0.004) * 0.06
    return base


def main():
    os.makedirs(OUT, exist_ok=True)
    to_image(gravel(), (0.78, 0.72, 0.62), 'gravel')
    to_image(asphalt(), (0.98, 0.99, 1.04), 'asphalt')


if __name__ == '__main__':
    main()
