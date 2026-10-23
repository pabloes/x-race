"""Check renders, made from the exported GLBs (so they also prove the round trip):
one 3/4 view per piece, a line-up of the whole kit, and a decorated 30 m stretch of road from
the chase camera and from above. Daylight, Standard view transform so the atlas colours
show as painted (the explorer does its own tone mapping)."""
import math
import os

import bpy
from mathutils import Vector

ASPHALT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "images", "asphalt.png")
ROAD_W = 15


def setup(scene):
    engines = {i.identifier for i in scene.render.bl_rna.properties["engine"].enum_items}
    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 32
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 1280, 800, 100
    scene.render.image_settings.file_format = "JPEG"     # check images only; keeps the folder small
    scene.render.image_settings.quality = 90
    world = bpy.data.worlds.new("kit_sky")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    scene.world = world
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.angle = math.radians(2)
    sun.rotation_euler = (math.radians(42), math.radians(8), math.radians(-35))
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.lens = 40
    cam.data.clip_end = 2000
    scene.collection.objects.link(cam)
    scene.camera = cam
    for prop in scene.render.bl_rna.properties:
        if prop.identifier.startswith("use_stamp_"):
            setattr(scene.render, prop.identifier, False)
    scene.render.use_stamp_note = True
    scene.render.stamp_font_size = 22
    return cam


def light(night):
    """Daylight, or a moonlit night where the emissives carry the scene (neon)."""
    sc = bpy.context.scene
    bg = sc.world.node_tree.nodes["Background"]
    sun = bpy.data.objects["sun"]
    if night:
        bg.inputs["Color"].default_value = (0.035, 0.03, 0.09, 1)
        bg.inputs["Strength"].default_value = 1.0
        sun.data.energy, sun.data.color = 0.6, (0.6, 0.7, 1.0)
    else:
        bg.inputs["Color"].default_value = (0.50, 0.70, 0.98, 1)
        bg.inputs["Strength"].default_value = 0.9
        sun.data.energy, sun.data.color = 3.6, (1.0, 0.96, 0.9)


def flat_material(name, rgb):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = 0.9
    return m


def plane(name, x0, y0, x1, y1, z, mat, uv_scale=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], [], [[0, 1, 2, 3]])
    if uv_scale:
        uv = me.uv_layers.new()
        for i, (x, y) in enumerate(((x0, y0), (x1, y0), (x1, y1), (x0, y1))):
            uv.data[i].uv = (x / uv_scale, y / uv_scale)
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def asphalt_material():
    m = flat_material("asphalt", (0.16, 0.17, 0.19))
    if os.path.exists(ASPHALT):
        tex = m.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(os.path.abspath(ASPHALT))
        m.node_tree.links.new(tex.outputs["Color"], m.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
    return m


def load(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    obs = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    return obs[0]


def place(src, x, y, rot_deg=0.0):
    ob = src.copy()
    bpy.context.scene.collection.objects.link(ob)
    ob.location = (x, y, 0)
    ob.rotation_mode = "XYZ"                    # the glTF importer leaves objects in quaternion mode
    ob.rotation_euler = (0, 0, math.radians(rot_deg))
    return ob


def aim(cam, loc, target):
    cam.location = Vector(loc)
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()


def shot(path, note):
    sc = bpy.context.scene
    sc.render.stamp_note_text = note
    sc.render.use_stamp = bool(note)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


def render_all(kit_dir, out_dir, report, theme):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    cam = setup(sc)
    night = theme.name == "neon"
    light(night)
    ground = plane("ground", -400, -400, 400, 400, -0.005, flat_material("ground", (0.42, 0.45, 0.48)))
    src = {}
    for name, _ in report:
        ob = load(os.path.join(kit_dir, name + ".glb"))
        ob.name = "src_" + name
        ob.location = (0, 0, -1000)            # parked under the ground; copies are placed
        src[name] = ob
    infos = dict(report)

    # --- one view per piece: from the piece's front-right (Blender -X, -Y), a bit above
    for name, ob in src.items():
        ob.location = (0, 0, 0)
        s = infos[name]["size"]
        size = Vector((s["x"], s["z"], s["y"]))
        r = size.length / 2
        centre = Vector((0, 0, size.z / 2))
        d = Vector((-0.62, -1.0, 0.42)).normalized()
        dist = r / math.sin(math.radians(15)) * 1.1
        aim(cam, centre + d * dist, centre)
        shot(os.path.join(out_dir, name + ".jpg"), f"{name}   {infos[name]['tris']} tris   {s['x']} x {s['y']} x {s['z']} m")
        ob.location = (0, 0, -1000)

    # --- line-ups: small pieces in two rows (wide ones behind), buildings as a 3 x 3 grid
    small = [n for n in src if not n.startswith("building-")]
    wide = [n for n in small if infos[n]["size"]["x"] >= 10]
    rows = [[n for n in small if n not in wide], wide]
    blds = [n for n in src if n.startswith("building-")]
    grid = [[blds[3 * i + j] for j in range(3)] for i in range(3)]
    for fname, layout, gap, depth in (("lineup.jpg", rows, 2.0, 12.0), ("lineup-buildings.jpg", grid, 10.0, 48.0)):
        placed, width = [], 0.0
        for r, row in enumerate(layout):
            total = sum(infos[n]["size"]["x"] for n in row) + gap * (len(row) - 1)
            width = max(width, total)
            x = total / 2
            for n in row:
                w = infos[n]["size"]["x"]
                placed.append(place(src[n], x - w / 2, r * depth))
                x -= w + gap
        dist = width / 2 / math.tan(math.radians(22)) * 1.05
        mid = depth * (len(layout) - 1) / 2
        aim(cam, (dist * 0.25, mid - dist * 0.9, dist * 0.42), (0, mid, 2))
        shot(os.path.join(out_dir, fname), f"kit {theme.name}: {sum(len(r) for r in layout)} pieces")
        for o in placed:
            bpy.data.objects.remove(o)

    # --- composition: 30 m of straight, decorated as decor.ts will (see docs/contracts/kit.md)
    ground.data.materials[0] = flat_material("verge", (0.55, 0.62, 0.44))
    hw = ROAD_W / 2
    plane("road", -hw, -60, hw, 120, 0.0, asphalt_material(), uv_scale=4)
    white = flat_material("paint", (0.9, 0.9, 0.88))
    for y in range(-58, 120, 8):
        plane(f"dash{y}", -0.12, y, 0.12, y + 4, 0.01, white)
    for sx in (-1, 1):
        plane(f"edge{sx}", sx * (hw - 0.5) - 0.12, -60, sx * (hw - 0.5) + 0.12, 120, 0.01, flat_material("edge", (0.95, 0.75, 0.1)))
        plane(f"walk{sx}", sx * (hw + 0.01), -60, sx * (hw + 14), 120, 0.003, flat_material("walk", (0.48, 0.5, 0.52)))
    bx = hw + 1                                         # barriers at ROAD_W/2 + 1, every 4 m
    for y in range(-13, 16, 4):
        place(src["barrier"], -bx, y, 90)
        place(src["barrier"], bx, y, 90)
    for y in (-12, -6):                                  # kerbs, as on a corner's inside edge
        place(src["kerb"], -hw + 0.4, y, 90)
    place(src["lamp"], -bx - 1.2, -12, 90)              # arm over the road
    place(src["lamp"], bx + 1.2, 18, -90)
    for y in (-8, -2, 4):
        place(src["banner"], bx + 1.4, y)
    place(src["stand"], bx + 2.5 + 3, 6, -90)
    for i, y in enumerate((-14, -7, 0, 7, 14)):
        place(src["tree-a" if i % 2 == 0 else ("palm" if "palm" in src else "tree-b")], -bx - 5 - (i % 2) * 1.5, y, i * 47)
    if "hologram" in src:
        place(src["hologram"], bx + 4, 24, -90)
    place(src["gate-start"], 0, 10)
    place(src["pad"], 3.5, -4)
    place(src["gate-checkpoint"], 0, 48)
    for x in range(-6, 7, 3):                            # end of the straight: the road turns right
        place(src["chevron"], x, 72, 180)
    place(src["pillar"], -bx - 3, 30)
    for name, x, y in (("building-28x28x24", -34, -6), ("building-20x20x36", -30, 24), ("building-36x36x12", 38, -20),
                       ("building-20x20x12", 30, 30), ("building-36x36x36", -40, 70), ("building-28x28x36", 36, 70),
                       ("building-20x20x24", -12, 100), ("building-28x28x12", 16, 104), ("building-36x36x24", 60, 30)):
        place(src[name], x, y)
    aim(cam, (2.5, -26, 3.4), (0.5, 20, 2.2))
    shot(os.path.join(out_dir, "compo-chase.jpg"), "")
    aim(cam, (-16, -44, 30), (2, 10, 0))
    shot(os.path.join(out_dir, "compo-overview.jpg"), "")
    if night:                                            # the explorer runs its own clock: check daylight too
        light(False)
        aim(cam, (2.5, -26, 3.4), (0.5, 20, 2.2))
        shot(os.path.join(out_dir, "compo-chase-day.jpg"), "")
