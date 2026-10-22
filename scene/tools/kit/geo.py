"""Geometry for kit pieces: polygons tagged with a paint, collected per piece, UV'd at the end.

Blender frame used while authoring (Z up). After export the scene sees (x, y, z) = (-bx, bz, -by)
and the image is not mirrored (see the car's export.py), so:
    piece front (+Z in the scene)  = Blender -Y   -> FRONT
    piece right (+X in the scene)  = Blender -X   -> RIGHT
Whatever reads correctly in a Blender render reads the same way in the explorer.

Paints are resolved to UVs only after the atlas is packed, because the packer needs the full
list of tiles and swatches the pieces asked for.
"""
import math
import random

import bmesh
import bpy
from mathutils import Vector

UP = Vector((0, 0, 1))
FRONT = Vector((0, -1, 0))
RIGHT = Vector((-1, 0, 0))


class Swatch:
    """Flat colour: every corner of the face samples the centre of the role's swatch."""

    def __init__(self, key):
        self.key = key


class Tile:
    """Planar projection of a face onto a painted tile.

    u axis = the viewer's right when looking at the face from outside (so text is never
    mirrored); on near-horizontal faces it is the piece's right. v = normal x u (up on walls,
    piece front on tops). u / v: None = this face's own extent; (lo, hi) = fixed range along
    the axis in metres; for v a ('z', lo, hi) tuple maps world height instead (sloped faces);
    a float pins the coordinate. point=True samples one texel per face (faceted foliage).
    """

    def __init__(self, name, u=None, v=None, flip_u=False, flip_v=False, point=False):
        self.name, self.u, self.v = name, u, v
        self.flip_u, self.flip_v, self.point = flip_u, flip_v, point


def newell(pts):
    n = Vector((0, 0, 0))
    for a, b in zip(pts, pts[1:] + pts[:1]):
        n.x += (a.y - b.y) * (a.z + b.z)
        n.y += (a.z - b.z) * (a.x + b.x)
        n.z += (a.x - b.x) * (a.y + b.y)
    return n.normalized() if n.length > 1e-12 else n


SIDES = {(0, 0, 1): "top", (0, 0, -1): "bottom", (0, -1, 0): "front", (0, 1, 0): "back",
         (-1, 0, 0): "right", (1, 0, 0): "left"}


def side_of(n):
    for k, name in SIDES.items():
        if n.dot(Vector(k)) > 0.999:
            return name
    return None


class Piece:
    def __init__(self, name):
        self.name = name
        self.polys = []

    # -------------------------------------------------------------- primitives
    def poly(self, pts, paint, hint=None):
        pts = [Vector(p) for p in pts]
        if hint is not None and newell(pts).dot(Vector(hint)) < 0:
            pts.reverse()
        self.polys.append((pts, paint))

    def box(self, lo, hi, paints, bevel=0.0, edges="all", bottom=False):
        """Axis-aligned box from lo to hi; optional single-segment chamfer.

        paints: dict keyed by front/back/left/right/top/bottom, 'side' (any vertical face),
        'all', and 'edge' (chamfer faces). edges: 'all', 'vertical' or 'top' picks what to chamfer.
        """
        lo, hi = Vector(lo), Vector(hi)
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co = Vector((lo[i] + (v.co[i] + 0.5) * (hi[i] - lo[i]) for i in range(3)))
        if bevel > 0:
            def pick(e):
                a, b = e.verts[0].co, e.verts[1].co
                vertical = abs(a.z - b.z) > 1e-6
                if edges == "vertical":
                    return vertical
                if edges == "top":
                    return not vertical and a.z > hi.z - 1e-6 and b.z > hi.z - 1e-6
                if edges == "nobottom":
                    return vertical or (a.z > hi.z - 1e-6 and b.z > hi.z - 1e-6)
                return True
            bmesh.ops.bevel(bm, geom=[e for e in bm.edges if pick(e)], offset=bevel, offset_type="OFFSET",
                            segments=1, profile=0.5, affect="EDGES", clamp_overlap=True)
        bm.normal_update()
        for f in bm.faces:
            n = f.normal
            s = side_of(n)
            if s == "bottom" and not bottom:
                continue
            if s is None:
                paint = paints.get("edge") or _hi(paints)
            else:
                paint = paints.get(s) or (paints.get("side") if s in ("front", "back", "left", "right") else None) or paints.get("all") or paints["side"]
            self.polys.append(([v.co.copy() for v in f.verts], paint))
        bm.free()

    def prism(self, profile, x0, x1, paint, caps=None):
        """Extrude a (y, z) profile along X. paint: Paint or fn(edge_index, (y, z), (y, z)) -> Paint."""
        prof = list(profile)
        area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(prof, prof[1:] + prof[:1]))
        if area < 0:
            prof.reverse()
        n = len(prof)
        for i in range(n):
            a, b = prof[i], prof[(i + 1) % n]
            dy, dz = b[0] - a[0], b[1] - a[1]
            p = paint(i, a, b) if callable(paint) else paint
            if p is None:
                continue
            self.poly([(x0, a[0], a[1]), (x1, a[0], a[1]), (x1, b[0], b[1]), (x0, b[0], b[1])], p, hint=(0, dz, -dy))
        if caps is not None:
            self.poly([(x1, y, z) for y, z in prof], caps, hint=(1, 0, 0))
            self.poly([(x0, y, z) for y, z in prof], caps, hint=(-1, 0, 0))

    def cyl(self, base, r, h, sides, paint, top=None, r_top=None, rot=0.0):
        """Prism/frustum around Z with its base centre at `base`; no bottom cap."""
        bx, by, bz = base
        r_top = r if r_top is None else r_top
        ring = [(math.cos(rot + 2 * math.pi * i / sides), math.sin(rot + 2 * math.pi * i / sides)) for i in range(sides)]
        for i in range(sides):
            (c0, s0), (c1, s1) = ring[i], ring[(i + 1) % sides]
            mid = (c0 + c1, s0 + s1, 0)
            self.poly([(bx + r * c0, by + r * s0, bz), (bx + r * c1, by + r * s1, bz),
                       (bx + r_top * c1, by + r_top * s1, bz + h), (bx + r_top * c0, by + r_top * s0, bz + h)], paint, hint=mid)
        if top is not None and r_top > 0:
            self.poly([(bx + r_top * c, by + r_top * s, bz + h) for c, s in ring], top, hint=(0, 0, 1))

    def blob(self, center, radius, paint, subdiv=1, scale=(1, 1, 1), jitter=0.12, seed=0, flat_bottom=None):
        """Faceted icosphere for foliage; vertices pushed in/out a little so blobs don't look machined."""
        rng = random.Random(seed)
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
        c = Vector(center)
        for v in bm.verts:
            k = 1 + rng.uniform(-jitter, jitter)
            co = v.co * k
            if flat_bottom is not None:
                co.z = max(co.z, -flat_bottom)
            v.co = c + Vector((co.x * radius * scale[0], co.y * radius * scale[1], co.z * radius * scale[2]))
        bm.normal_update()
        for f in bm.faces:
            self.polys.append(([v.co.copy() for v in f.verts], paint))
        bm.free()

    # -------------------------------------------------------------- queries
    def tris(self):
        return sum(len(p) - 2 for p, _ in self.polys)

    def bounds(self):
        xs = [p for pts, _ in self.polys for p in pts]
        lo = Vector((min(p.x for p in xs), min(p.y for p in xs), min(p.z for p in xs)))
        hi = Vector((max(p.x for p in xs), max(p.y for p in xs), max(p.z for p in xs)))
        return lo, hi

    def recentre(self):
        """Pivot on the ground, centred in X and Z of the scene (Blender X and Y)."""
        lo, hi = self.bounds()
        off = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
        self.polys = [([p - off for p in pts], paint) for pts, paint in self.polys]

    def paints(self):
        return [pa for _, pa in self.polys]

    # -------------------------------------------------------------- mesh
    def to_mesh(self, atlas, material):
        verts, faces, uvs = [], [], []
        for pts, paint in self.polys:
            idx = list(range(len(verts), len(verts) + len(pts)))
            verts.extend(tuple(p) for p in pts)
            faces.append(idx)
            uvs.extend(face_uvs(pts, paint, atlas))
        me = bpy.data.meshes.new(self.name)
        me.from_pydata(verts, [], faces)
        uv = me.uv_layers.new(name="UVMap")
        for i, loop_uv in enumerate(uvs):
            uv.data[i].uv = loop_uv
        me.materials.append(material)
        me.shade_flat()
        me.validate()
        me.update()
        return me


def _hi(paints):
    base = paints.get("all") or paints.get("side") or paints.get("top")
    return Swatch(base.key + "^") if isinstance(base, Swatch) else Swatch("white")


def face_uvs(pts, paint, atlas):
    if isinstance(paint, Swatch):
        return [atlas.uv("sw:" + paint.key, 0.5, 0.5)] * len(pts)
    n = newell(pts)
    u_ax = RIGHT.copy() if abs(n.z) > 0.95 else (-n).cross(UP).normalized()
    v_ax = n.cross(u_ax).normalized()

    def coords(spec, ax, use_height):
        vals = [p.z if use_height else p.dot(ax) for p in pts]
        if isinstance(spec, (int, float)):
            return [float(spec)] * len(pts)
        lo, hi = (min(vals), max(vals)) if spec is None else spec
        return [(x - lo) / ((hi - lo) or 1.0) for x in vals]

    us = coords(paint.u, u_ax, False)
    vspec, use_h = paint.v, False
    if isinstance(vspec, tuple) and len(vspec) == 3 and vspec[0] == "z":
        vspec, use_h = vspec[1:], True
    vs = coords(vspec, v_ax, use_h)
    if paint.flip_u:
        us = [1 - x for x in us]
    if paint.flip_v:
        vs = [1 - x for x in vs]
    if paint.point:
        s, t = sum(us) / len(us), sum(vs) / len(vs)
        return [atlas.uv(paint.name, s, t)] * len(pts)
    return [atlas.uv(paint.name, s, t) for s, t in zip(us, vs)]
