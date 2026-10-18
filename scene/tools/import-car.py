#!/usr/bin/env python3
"""
Turns the downloaded Roadster model into what the scene can actually drive.

    cd scene
    python3 tools/import-car.py

Input:  models/tesla_roadster.glb (as downloaded)
Output: models/car-body.glb, models/car-wheel-{fl,fr,rl,rr}.glb

Four things have to happen to it, and none of them can happen at runtime:

1. **The backdrop goes.** The file is a Sketchfab scene, so it carries a 12.8 m ground
   plane under the car. Dropped in a racing scene it is a grey disc flying along with you.
2. **The wheels come off.** They are modelled one group per axle, both sides in the same
   meshes, so they are split by the sign of each triangle's centre and re-centred on their
   own hubs. Only then can a wheel spin and steer on its own transform.
3. **It is scaled and seated.** The model is 4.52 m long and its ground is at y = -0.64;
   the car this scene simulates is 4.4 m long and its chassis centre is 0.65 m above the
   contact patch. Both are reconciled here rather than with a scale on the entity, so the
   numbers in `car.ts` stay the car's and not the model's.
4. **The lights are made emissive.** The source has them as plain black and red materials.

The transforms are baked into the vertices: the node tree is a chain of matrices from the
Sketchfab exporter, and flattening it here means the scene can place each piece by its own
position without carrying that chain around.
"""

import importlib.util
import json
import math
import os
import struct

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(os.path.dirname(HERE), 'models')
SOURCE = os.path.join(MODELS, 'tesla_roadster.glb')
# The unpacked copy next to it carries the licence the model is used under.
LICENCE = os.path.join(MODELS, 'tesla_roadster', 'license.txt')

spec = importlib.util.spec_from_file_location('make_car', os.path.join(HERE, 'make-car.py'))
make_car = importlib.util.module_from_spec(spec)
spec.loader.exec_module(make_car)

CAR_LENGTH = 4.4
# Chassis centre above the contact patch, from the wheel anchors and the wheel radius.
RIDE_HEIGHT = 0.65
# Node groups that are wheels, by name in the source file: the tyres and the rims.
WHEEL_GROUPS = {
    'Cube.001_1', 'Cylinder.005_7',   # rear tyre, rear rim
    'Cube.003_3', 'Cylinder.004_6'    # front tyre, front rim
}
# Dropped. `Plane_9` is the 12.8 m ground plane the model was photographed on. The two
# `Cylinder` groups are the springs, dampers and brake discs: they belong to the car, not
# to the wheel, so splitting them per wheel threw them outboard where they read as red
# coil springs hanging in the air beside each tyre. Keeping them with the body would park
# them inside the arches correctly but motionless; they are small, mostly hidden behind
# the rims, and not worth either problem.
SKIP_GROUPS = {'Plane_9', 'Cylinder_4', 'Cylinder.001_5'}
# Materials the scene should light up, and what they should look like.
EMISSIVE = {
    'Tail_Light': ((1.0, 0.05, 0.03), 6.0),
    'Front_Light_Glass': ((0.75, 0.85, 1.0), 4.0)
}


class RawMesh:
    """Positions, normals and indices, shaped the way make-car.py's writer expects."""

    def __init__(self):
        self.positions = []
        self.normals = []
        self.indices = []
        self.lookup = {}


def read_gltf(path):
    data = open(path, 'rb').read()
    json_length = struct.unpack('<I', data[12:16])[0]
    gltf = json.loads(data[20:20 + json_length])
    binary = data[20 + json_length + 8:]
    return gltf, binary


def accessor(gltf, binary, index):
    a = gltf['accessors'][index]
    view = gltf['bufferViews'][a['bufferView']]
    components = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
    dtype = {5126: '<f4', 5125: '<u4', 5123: '<u2', 5121: '<u1'}[a['componentType']]
    item = np.dtype(dtype).itemsize
    stride = view.get('byteStride') or item * components
    start = view.get('byteOffset', 0) + a.get('byteOffset', 0)
    if stride == item * components:
        flat = np.frombuffer(binary, dtype=dtype, count=a['count'] * components, offset=start)
        return flat.reshape(a['count'], components).astype(np.float64)
    out = np.empty((a['count'], components))
    for i in range(a['count']):
        out[i] = np.frombuffer(binary, dtype=dtype, count=components, offset=start + i * stride)
    return out


def node_matrix(node):
    if 'matrix' in node:
        return np.array(node['matrix'], dtype=float).reshape(4, 4).T
    m = np.eye(4)
    if 'scale' in node:
        m = m @ np.diag(list(node['scale']) + [1.0])
    if 'rotation' in node:
        x, y, z, w = node['rotation']
        r = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
        ])
        rot = np.eye(4)
        rot[:3, :3] = r
        m = m @ rot
    if 'translation' in node:
        m[:3, 3] = node['translation']
    return m


def collect(gltf, binary):
    """Every primitive in the file as (group name, material name, positions, normals, indices)."""
    pieces = []

    def walk(index, parent, group):
        node = gltf['nodes'][index]
        matrix = parent @ node_matrix(node)
        name = node.get('name', '')
        if group is None and name not in ('Sketchfab_model', 'root', 'GLTF_SceneRootNode'):
            group = name
        if node.get('mesh') is not None:
            for prim in gltf['meshes'][node['mesh']]['primitives']:
                positions = accessor(gltf, binary, prim['attributes']['POSITION'])
                normals = (accessor(gltf, binary, prim['attributes']['NORMAL'])
                           if 'NORMAL' in prim['attributes'] else np.zeros_like(positions))
                indices = accessor(gltf, binary, prim['indices']).astype(int).ravel()
                homogeneous = np.hstack([positions, np.ones((len(positions), 1))])
                world = (matrix @ homogeneous.T).T[:, :3]
                rotation = matrix[:3, :3]
                world_normals = (rotation @ normals.T).T
                lengths = np.linalg.norm(world_normals, axis=1, keepdims=True)
                world_normals = np.divide(world_normals, np.where(lengths == 0, 1, lengths))
                material = gltf['materials'][prim['material']].get('name', '') if 'material' in prim else ''
                pieces.append((group, material, world, world_normals, indices,
                               gltf['materials'][prim['material']] if 'material' in prim else {}))
        for child in node.get('children', []):
            walk(child, matrix, group)

    for root in gltf['scenes'][gltf.get('scene', 0)]['nodes']:
        walk(root, np.eye(4), None)
    return pieces


# Materials whose surfaces are panels rather than closed volumes, and which therefore get
# their back faces written out as well. `doubleSided` is in the file and Bevy honours it;
# the Unity explorer culls anyway, and a car with its doors culled away is a car you can
# see the far wheels through. Emitting both windings costs triangles and is the only
# version that looks the same in both.
TWO_SIDED_MATERIALS = {'Body', 'Matt', 'Black', 'Material.005', 'Badge'}


def to_mesh(pieces, transform, keep=None):
    """
    Merges pieces into one mesh per material, applying `transform` to every vertex.

    `keep` filters triangles by the centre of each one, which is how an axle that holds
    both wheels is cut into a left and a right half without touching the source file.
    """
    meshes = {}
    for group, material, positions, normals, indices, raw in pieces:
        moved = transform(positions)
        for i in range(0, len(indices), 3):
            tri = indices[i:i + 3]
            if keep is not None and not keep(moved[tri].mean(axis=0)):
                continue
            mesh = meshes.setdefault(material, (RawMesh(), raw))[0]
            for k in tri:
                # Welded back together as it goes. The source is indexed and the writer
                # takes an index buffer, so emitting three fresh vertices per triangle
                # would triple the file for nothing: 300 KB a body instead of 100.
                key = (
                    round(moved[k][0], 4), round(moved[k][1], 4), round(moved[k][2], 4),
                    round(normals[k][0], 3), round(normals[k][1], 3), round(normals[k][2], 3)
                )
                index = mesh.lookup.get(key)
                if index is None:
                    index = len(mesh.positions)
                    mesh.lookup[key] = index
                    mesh.positions.append(tuple(moved[k]))
                    mesh.normals.append(tuple(normals[k]))
                mesh.indices.append(index)
            if material in TWO_SIDED_MATERIALS:
                back = []
                for k in tri:
                    key = (
                        round(moved[k][0], 4), round(moved[k][1], 4), round(moved[k][2], 4),
                        -round(normals[k][0], 3), -round(normals[k][1], 3), -round(normals[k][2], 3)
                    )
                    index = mesh.lookup.get(key)
                    if index is None:
                        index = len(mesh.positions)
                        mesh.lookup[key] = index
                        mesh.positions.append(tuple(moved[k]))
                        mesh.normals.append(tuple(-normals[k]))
                    back.append(index)
                mesh.indices += [back[0], back[2], back[1]]
    return meshes


def material_for(name, raw, body_colour=None):
    """
    The source material, carried over rather than reinvented.

    `doubleSided` especially: every material in this model is double sided, the panels are
    open surfaces, and dropping that flag is what put holes through the car.
    """
    pbr = raw.get('pbrMetallicRoughness', {})
    colour = pbr.get('baseColorFactor', [1.0, 1.0, 1.0, 1.0])[:3]
    if name == 'Body' and body_colour is not None:
        colour = list(body_colour)
    emissive, strength = EMISSIVE.get(name, (None, 0.0))
    # When a factor is absent, glTF says metallic 1.0 and roughness 1.0 — a mirror. That
    # is almost never what an exporter meant by leaving it out, and applied to a white
    # surface it renders as whatever the sky is doing, which is how trim and panels came
    # back washed out. Absent means matte plastic here, unless the material's own name
    # says metal, which is the only other signal the file offers.
    metallic = pbr.get('metallicFactor', 1.0)
    roughness = pbr.get('roughnessFactor', 1.0)
    if name == 'Body' and body_colour is not None:
        # Paint, not chrome. The source finish is metallic 0.3 at roughness 0.1, which on
        # flat low-poly panels reflects the sky hard enough to wash the livery out: the
        # roof keeps its colour and the door-sized faces come back near white. Matte paint
        # lets the albedo win on every panel, which is the whole point of having liveries.
        metallic = 0.05
        roughness = 0.5
    return make_car.pbr(
        colour,
        metallic=metallic,
        roughness=roughness,
        emissive=emissive,
        strength=strength,
        double_sided=raw.get('doubleSided', False)
    )


def main():
    gltf, binary = read_gltf(SOURCE)
    pieces = collect(gltf, binary)

    everything = np.vstack([p[2] for p in pieces if p[0] not in SKIP_GROUPS])
    low, high = everything.min(axis=0), everything.max(axis=0)
    scale = CAR_LENGTH / (high[2] - low[2])
    centre_xz = (low + high) / 2
    ground = low[1]

    def place(points):
        out = (points - np.array([centre_xz[0], ground, centre_xz[2]])) * scale
        out[:, 1] -= RIDE_HEIGHT
        return out

    body_pieces = [p for p in pieces if p[0] not in SKIP_GROUPS and p[0] not in WHEEL_GROUPS]
    wheel_pieces = [p for p in pieces if p[0] in WHEEL_GROUPS]

    written = 0
    for index, colour in enumerate(make_car.LIVERIES):
        meshes = to_mesh(body_pieces, place)
        parts = [(mesh, material_for(name, raw, colour)) for name, (mesh, raw) in meshes.items()]
        written += make_car.write_glb(os.path.join(MODELS, f'car-body-{index}.glb'), parts)

    # Wheels: cut each axle down the middle, then move the half onto its own hub.
    hubs = {}
    for corner, side, end in (('fl', -1, 1), ('fr', 1, 1), ('rl', -1, -1), ('rr', 1, -1)):
        def keep(centre, side=side, end=end):
            return math.copysign(1, centre[0]) == side and math.copysign(1, centre[2]) == end

        placed = to_mesh(wheel_pieces, place, keep)
        points = np.vstack([m.positions for m, _ in placed.values()])
        # The centre of the bounding box, not the average vertex: a rim carries far more
        # vertices than a tyre, so the average sits off the axle and the wheel would
        # wobble as it span.
        hub = (points.min(axis=0) + points.max(axis=0)) / 2
        # Across the car, though, the box is dragged inboard by the brake disc behind the
        # wheel, and that axis is the one the steering swings about. The tyre is symmetric
        # about the real centre plane, so it is the one that gets asked.
        tyre = [m for name, (m, _) in placed.items() if name in ('Tire', 'Logo')]
        if tyre:
            xs = np.vstack([m.positions for m in tyre])[:, 0]
            hub[0] = (xs.min() + xs.max()) / 2
        parts = []
        for name, (mesh, raw) in placed.items():
            mesh.positions = [tuple(np.array(p) - hub) for p in mesh.positions]
            parts.append((mesh, material_for(name, raw)))
        written += make_car.write_glb(os.path.join(MODELS, f'car-wheel-{corner}.glb'), parts)
        hubs[corner] = hub

    print(f'escala {scale:.3f}, {written // 1024} KB escritos')
    print('posiciones de buje para car.ts:')
    for corner, hub in hubs.items():
        print(f"  {corner}: {{ x: {hub[0]:.3f}, y: {hub[1]:.3f}, z: {hub[2]:.3f} }}")


if __name__ == '__main__':
    main()
