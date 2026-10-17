#!/usr/bin/env python3
"""
Builds the Roadster's body and wheel as glTF binaries, one per livery.

    cd scene
    python3 tools/make-car.py

Output: models/roadster-0.glb … models/roadster-7.glb and models/wheel.glb.

Why a file and not boxes at runtime: the scene runtime draws boxes, spheres, cylinders and
planes, and nothing else — there is no custom geometry API — so anything with a shape has
to arrive as a model. And why generated rather than downloaded: the same reason the sounds
and textures are generated here, no asset to license and the shape is a few numbers that
can be argued with.

The body is a loft. A faceted cross-section is swept along the car and its half-width and
heights are read from Catmull-Rom curves through a handful of keys, so the surface is
smooth between them without flattening at them. The technique is the one used in
eduardmur/tesla-roadster-simulator (MIT), which does it in Three.js at runtime; the keys,
the section and the exporter here are this project's own.

Frame: +X right, +Y up, +Z forward, origin at the centre of the chassis collider, which is
what `car.ts` parents everything to.
"""

import json
import math
import os
import struct

CAR_HALF_WIDTH = 0.95
CAR_HALF_HEIGHT = 0.35
CAR_HALF_LENGTH = 2.2
WHEEL_RADIUS = 0.35
WHEEL_WIDTH = 0.28

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'models')

LIVERIES = [
    (0.75, 0.05, 0.08),
    (0.05, 0.30, 0.80),
    (0.95, 0.75, 0.05),
    (0.10, 0.65, 0.30),
    (0.60, 0.10, 0.70),
    (0.95, 0.45, 0.05),
    (0.10, 0.70, 0.75),
    (0.85, 0.85, 0.90)
]


# ---------------------------------------------------------------- curves

def catmull(keys, z):
    """Smooth interpolation through (z, value) keys given nose to tail (z descending)."""
    n = len(keys)
    if z >= keys[0][0]:
        return keys[0][1]
    if z <= keys[-1][0]:
        return keys[-1][1]

    def slope(i):
        a = keys[max(i - 1, 0)]
        b = keys[min(i + 1, n - 1)]
        return (b[1] - a[1]) / (b[0] - a[0])

    for i in range(n - 1):
        z0, v0 = keys[i]
        z1, v1 = keys[i + 1]
        if z0 >= z >= z1:
            h = z1 - z0
            t = (z - z0) / h
            t2, t3 = t * t, t * t * t
            return ((2 * t3 - 3 * t2 + 1) * v0
                    + (t3 - 2 * t2 + t) * h * slope(i)
                    + (-2 * t3 + 3 * t2) * v1
                    + (t3 - t2) * h * slope(i + 1))
    return keys[-1][1]


# Half-width, roof height and floor height along the car, nose (+z) to tail (-z).
WIDTH_KEYS = [(2.2, 0.40), (1.8, 0.74), (1.1, 0.93), (0.0, 0.95), (-1.1, 0.93), (-1.8, 0.82), (-2.2, 0.62)]
TOP_KEYS = [(2.2, -0.10), (1.7, 0.00), (0.9, 0.16), (0.1, 0.22), (-0.9, 0.20), (-1.7, 0.10), (-2.2, 0.04)]
BOTTOM_KEYS = [(2.2, -0.24), (1.6, -0.31), (0.0, -0.34), (-1.6, -0.31), (-2.2, -0.24)]
# The cabin: a glass canopy riding on the deck between these two stations. It is a
# separate, much smaller loft rather than part of the body, so the roofline can be low and
# narrow without dragging the flanks in with it.
CANOPY_FRONT, CANOPY_BACK = 0.80, -1.00
CANOPY_INSET = 0.30
CANOPY_SQUASH = 0.52
CANOPY_LIFT = 0.30


def section(z, inset=0.0, lift=0.0, squash=1.0):
    """
    One cross-section as a closed ring of points, counter-clockwise seen from +z.

    The section is a rounded rectangle whose corners are tightened near the ends of the
    car, which is what gives the nose and tail their creases instead of a sausage.
    """
    half = catmull(WIDTH_KEYS, z) - inset
    top = catmull(TOP_KEYS, z) + lift
    bottom = catmull(BOTTOM_KEYS, z) + lift * 0.2
    mid = (top + bottom) / 2
    height = (top - bottom) / 2 * squash
    points = []
    steps = 16
    for i in range(steps):
        a = (i / steps) * math.tau
        # Superellipse: n large is a box, n = 2 is an ellipse. Flatter along the car's
        # flanks, rounder over the deck.
        cs, sn = math.cos(a), math.sin(a)
        n = 3.2
        x = math.copysign(abs(cs) ** (2 / n), cs) * half
        y = math.copysign(abs(sn) ** (2 / n), sn) * height + mid
        points.append((x, y, z))
    return points


# ---------------------------------------------------------------- mesh building

class Mesh:
    """Positions, normals and triangles for one material."""

    def __init__(self):
        self.positions = []
        self.normals = []
        self.indices = []

    def add_triangle(self, a, b, c):
        normal = cross(sub(b, a), sub(c, a))
        length = math.sqrt(sum(v * v for v in normal)) or 1.0
        normal = tuple(v / length for v in normal)
        base = len(self.positions)
        for p in (a, b, c):
            self.positions.append(p)
            self.normals.append(normal)
        self.indices += [base, base + 1, base + 2]

    def add_quad(self, a, b, c, d):
        self.add_triangle(a, b, c)
        self.add_triangle(a, c, d)

    def add_box(self, centre, size, colour_slot=None):
        hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
        cx, cy, cz = centre
        corners = [
            (cx - hx, cy - hy, cz - hz), (cx + hx, cy - hy, cz - hz),
            (cx + hx, cy + hy, cz - hz), (cx - hx, cy + hy, cz - hz),
            (cx - hx, cy - hy, cz + hz), (cx + hx, cy - hy, cz + hz),
            (cx + hx, cy + hy, cz + hz), (cx - hx, cy + hy, cz + hz)
        ]
        for face in [(4, 5, 6, 7), (1, 0, 3, 2), (5, 1, 2, 6), (0, 4, 7, 3), (3, 7, 6, 2), (0, 1, 5, 4)]:
            self.add_quad(*[corners[i] for i in face])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def loft(mesh, stations, inset=0.0, lift=0.0, squash=1.0):
    """Sweeps the section along `stations` and caps both ends."""
    rings = [section(z, inset, lift, squash) for z in stations]
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        for k in range(len(a)):
            k2 = (k + 1) % len(a)
            mesh.add_quad(a[k], a[k2], b[k2], b[k])
    for ring, flip in ((rings[0], False), (rings[-1], True)):
        centre = (sum(p[0] for p in ring) / len(ring),
                  sum(p[1] for p in ring) / len(ring),
                  ring[0][2])
        for k in range(len(ring)):
            k2 = (k + 1) % len(ring)
            if flip:
                mesh.add_triangle(centre, ring[k2], ring[k])
            else:
                mesh.add_triangle(centre, ring[k], ring[k2])


def body_mesh():
    stations = [CAR_HALF_LENGTH - i * (CAR_HALF_LENGTH * 2 / 24) for i in range(25)]
    mesh = Mesh()
    loft(mesh, stations)
    return mesh


def canopy_mesh():
    """The glass: a shorter, narrower loft sitting on the deck."""
    mesh = Mesh()
    steps = 10
    stations = [CANOPY_FRONT - i * (CANOPY_FRONT - CANOPY_BACK) / steps for i in range(steps + 1)]
    loft(mesh, stations, inset=CANOPY_INSET, lift=CANOPY_LIFT, squash=CANOPY_SQUASH)
    return mesh


def lights_mesh(front):
    """Head or tail light bars, as thin boxes set into the nose and tail."""
    mesh = Mesh()
    # Set into the nose and tail rather than hung off them: the body is only ~0.5 m wide
    # at the very ends, so a lamp any further out floats beside the car instead of in it.
    z = 1.94 if front else -1.96
    y = 0.00 if front else 0.04
    for side in (-1, 1):
        mesh.add_box((side * 0.28, y, z), (0.34, 0.09, 0.1))
    if not front:
        # The Roadster's tail bar runs between the lamps.
        mesh.add_box((0, y, z), (0.24, 0.05, 0.09))
    return mesh


def wheel_meshes():
    """Tyre and rim, as a lathe about X so the wheel can be spun by its own transform."""
    tyre = Mesh()
    rim = Mesh()
    segments = 24
    inner = WHEEL_RADIUS - 0.1
    hw = WHEEL_WIDTH / 2
    for i in range(segments):
        a0 = (i / segments) * math.tau
        a1 = ((i + 1) / segments) * math.tau
        p = lambda a, r, x: (x, math.sin(a) * r, math.cos(a) * r)
        # Tread and the two shoulders.
        tyre.add_quad(p(a0, WHEEL_RADIUS, -hw), p(a1, WHEEL_RADIUS, -hw),
                      p(a1, WHEEL_RADIUS, hw), p(a0, WHEEL_RADIUS, hw))
        for x in (-hw, hw):
            flip = x > 0
            a, b = (a0, a1) if flip else (a1, a0)
            tyre.add_quad(p(a, WHEEL_RADIUS, x), p(b, WHEEL_RADIUS, x),
                          p(b, inner, x), p(a, inner, x))
        # Rim face, slightly proud of the tyre's inner edge.
        for x in (-hw * 0.92, hw * 0.92):
            flip = x > 0
            a, b = (a0, a1) if flip else (a1, a0)
            rim.add_triangle((x, 0, 0), p(a, inner, x), p(b, inner, x))
        # Five spokes, as thin wedges, on the outer face only.
        if i % max(segments // 5, 1) == 0:
            mid = a0 + math.tau / segments / 2
            for sign in (-1, 1):
                edge = mid + sign * 0.16
                rim.add_triangle((hw * 0.92, 0, 0), p(mid, inner * 0.95, hw * 0.95),
                                 p(edge, inner * 0.95, hw * 0.95))
    return tyre, rim


# ---------------------------------------------------------------- glTF export

def pack(mesh):
    """One mesh -> (vertex bytes, index bytes, counts, bounds)."""
    vertex = b''.join(struct.pack('<3f', *p) + struct.pack('<3f', *n)
                      for p, n in zip(mesh.positions, mesh.normals))
    index = b''.join(struct.pack('<I', i) for i in mesh.indices)
    lo = [min(p[i] for p in mesh.positions) for i in range(3)]
    hi = [max(p[i] for p in mesh.positions) for i in range(3)]
    return vertex, index, len(mesh.positions), len(mesh.indices), lo, hi


def write_glb(path, parts):
    """
    `parts` is a list of (mesh, material dict). Everything lands in one node, so the scene
    gets one entity per file and the wheels stay separate by being their own file.
    """
    buffer = b''
    views, accessors, materials, primitives = [], [], [], []
    for mesh, material in parts:
        vertex, index, vertex_count, index_count, lo, hi = pack(mesh)
        # Vertex view: position and normal interleaved, 24 bytes of stride.
        views.append({'buffer': 0, 'byteOffset': len(buffer), 'byteLength': len(vertex),
                      'byteStride': 24, 'target': 34962})
        buffer += vertex
        views.append({'buffer': 0, 'byteOffset': len(buffer), 'byteLength': len(index),
                      'target': 34963})
        buffer += index
        # Pad to four bytes, which the spec requires of every view offset.
        while len(buffer) % 4:
            buffer += b'\x00'
        vertex_view = len(views) - 2
        index_view = len(views) - 1
        accessors.append({'bufferView': vertex_view, 'byteOffset': 0, 'componentType': 5126,
                          'count': vertex_count, 'type': 'VEC3', 'min': lo, 'max': hi})
        accessors.append({'bufferView': vertex_view, 'byteOffset': 12, 'componentType': 5126,
                          'count': vertex_count, 'type': 'VEC3'})
        accessors.append({'bufferView': index_view, 'componentType': 5125,
                          'count': index_count, 'type': 'SCALAR'})
        primitives.append({
            'attributes': {'POSITION': len(accessors) - 3, 'NORMAL': len(accessors) - 2},
            'indices': len(accessors) - 1,
            'material': len(materials)
        })
        materials.append(material)

    gltf = {
        'asset': {'version': '2.0', 'generator': 'teslaroadster make-car.py'},
        # Declared because a glTF reader is entitled to refuse an extension it was not
        # told about, and the light bars are the whole point of the emissive one.
        'extensionsUsed': ['KHR_materials_emissive_strength'],
        'scene': 0,
        'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0}],
        'meshes': [{'primitives': primitives}],
        'materials': materials,
        'accessors': accessors,
        'bufferViews': views,
        'buffers': [{'byteLength': len(buffer)}]
    }
    json_chunk = json.dumps(gltf, separators=(',', ':')).encode()
    while len(json_chunk) % 4:
        json_chunk += b' '
    while len(buffer) % 4:
        buffer += b'\x00'
    glb = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(json_chunk) + 8 + len(buffer))
    glb += struct.pack('<II', len(json_chunk), 0x4E4F534A) + json_chunk
    glb += struct.pack('<II', len(buffer), 0x004E4942) + buffer
    with open(path, 'wb') as handle:
        handle.write(glb)
    return len(glb)


def pbr(colour, metallic=0.6, roughness=0.35, emissive=None, strength=0.0, alpha=None,
        double_sided=False):
    material = {
        'pbrMetallicRoughness': {
            'baseColorFactor': list(colour) + [1.0 if alpha is None else alpha],
            'metallicFactor': metallic,
            'roughnessFactor': roughness
        },
        # Single-sided by default because the generated shapes are closed. An imported
        # model is usually not: car panels are modelled as surfaces, and rendering them
        # from one side only is what turns a car into a car with holes in it.
        'doubleSided': double_sided
    }
    if emissive:
        material['emissiveFactor'] = list(emissive)
        if strength:
            material['extensions'] = {'KHR_materials_emissive_strength': {'emissiveStrength': strength}}
    if alpha is not None:
        material['alphaMode'] = 'BLEND'
    return material


def main():
    os.makedirs(OUT, exist_ok=True)
    body = body_mesh()
    canopy = canopy_mesh()
    front = lights_mesh(True)
    rear = lights_mesh(False)
    total = 0
    for i, colour in enumerate(LIVERIES):
        size = write_glb(os.path.join(OUT, f'roadster-{i}.glb'), [
            (body, pbr(colour, metallic=0.55, roughness=0.3)),
            (canopy, pbr((0.04, 0.05, 0.07), metallic=0.2, roughness=0.08)),
            (front, pbr((0.9, 0.95, 1.0), emissive=(0.8, 0.9, 1.0), strength=4)),
            (rear, pbr((0.6, 0.05, 0.05), emissive=(1.0, 0.1, 0.05), strength=6))
        ])
        total += size
    tyre, rim = wheel_meshes()
    total += write_glb(os.path.join(OUT, 'wheel.glb'), [
        (tyre, pbr((0.05, 0.05, 0.06), metallic=0.0, roughness=0.95)),
        (rim, pbr((0.72, 0.74, 0.78), metallic=0.9, roughness=0.25))
    ])
    print(f'models/: {len(LIVERIES)} carrocerías + 1 rueda, {total // 1024} KB en total')


if __name__ == '__main__':
    main()
