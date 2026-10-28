"""Headless build of a scenery kit: pieces -> per-piece textures -> GLBs -> checks -> manifest -> renders.

  /Applications/Blender.app/Contents/MacOS/Blender -b -P scene/tools/kit/build.py -- --theme city [--no-renders]

Writes scene/models/kit/<theme>/<piece>.glb + manifest.json, and check renders to
scene/tools/kit/renders/<theme>/. Exits non-zero if any piece breaks the contract (size,
triangle budget, material count, transparency, texture size).
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import time
import traceback

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import atlas as A    # noqa: E402
import glb           # noqa: E402
import pieces as P   # noqa: E402
import render as R   # noqa: E402
from themes import THEMES  # noqa: E402

SCENE_DIR = os.path.abspath(os.path.join(HERE, "..", ".."))
MAX_TRIS, MAX_TRIS_BUILDING, MAX_MATERIALS = 600, 400, 3
SIZE_TOL = 0.02
MAX_TEX = 512
JPEG_QUALITY = 85
GLOW_EPS = 1.0 / 255


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="build.py")
    ap.add_argument("--theme", default="city", choices=sorted(THEMES))
    ap.add_argument("--no-renders", action="store_true")
    ap.add_argument("--piece", choices=sorted(P.SPEC), help="Rebuild only one piece")
    return ap.parse_args(argv)


def save_image(name, arr, path, quality=0):
    """numpy (top-left origin, sRGB floats, RGB or RGBA) -> PNG/JPEG on disk (by extension),
    reloaded so the exporter finds a file image and, with export_image_format AUTO, keeps its format."""
    h, w, ch = arr.shape
    img = bpy.data.images.new(name, w, h, alpha=ch == 4)
    rgba = np.flipud(arr) if ch == 4 else np.concatenate([np.flipud(arr), np.ones((h, w, 1), np.float32)], axis=2)
    img.pixels.foreach_set(np.ascontiguousarray(rgba).ravel())
    img.filepath_raw = path
    img.file_format = "JPEG" if path.endswith(".jpg") else "PNG"
    if ch == 4:
        img.alpha_mode = "STRAIGHT"
    img.save(quality=quality)
    bpy.data.images.remove(img)
    return bpy.data.images.load(path)


def make_material(name, color_img, emit_img, holo=False):
    """Opaque, single-sided material; the emissive map only where the piece glows. holo: the one
    translucent case the contract allows (hologram glass): one RGBA image drives colour, alpha
    and emission, so the projection glows where it is drawn and the glass between stays faint."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.use_backface_culling = True          # exported as doubleSided: false
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.78
    bsdf.inputs["Metallic"].default_value = 0.0
    tc = nt.nodes.new("ShaderNodeTexImage")
    tc.image = color_img
    nt.links.new(tc.outputs["Color"], bsdf.inputs["Base Color"])
    if holo:
        nt.links.new(tc.outputs["Alpha"], bsdf.inputs["Alpha"])
        nt.links.new(tc.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = 1.0
        m.surface_render_method = "BLENDED"
    elif emit_img is not None:
        te = nt.nodes.new("ShaderNodeTexImage")
        te.image = emit_img
        nt.links.new(te.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = 1.0
    else:
        bsdf.inputs["Emission Strength"].default_value = 0.0
    return m


def texture_piece(piece, K, theme, tmp):
    """Pack and paint the tiles and swatches this piece uses into its own small texture, one
    per material."""
    atlases, materials = {}, {}
    for mat in sorted({pa.mat for pa in piece.paints()}):
        used = [pa for pa in piece.paints() if pa.mat == mat]
        tiles = {pa.name: K.tiles[pa.name] for pa in used if isinstance(pa, P.Tile)}
        swatches = {pa.key for pa in used if isinstance(pa, P.Swatch)}
        edge = P.TEX_EDGE.get(piece.name, MAX_TEX)
        atlas = A.fit(theme, tiles, swatches, edge)
        rgb, emit = atlas.paint()
        stem = os.path.join(tmp, f"{piece.name}-{mat}")
        if mat == "holo":
            # The painter draws the projection as emission; alpha follows its brightness.
            alpha = np.clip(emit.max(axis=2, keepdims=True) * 1.4 + 0.1, 0, 1)
            img = save_image(f"{piece.name}_{mat}", np.concatenate([np.maximum(rgb, emit), alpha], axis=2), stem + ".png")
            materials[mat] = make_material(f"kit_{theme.name}_holo", img, None, holo=True)
        else:
            color = save_image(f"{piece.name}_{mat}", rgb, stem + ".jpg", JPEG_QUALITY)
            glow = save_image(f"{piece.name}_{mat}_emissive", emit, stem + "-emissive.png") if emit.max() > GLOW_EPS else None
            materials[mat] = make_material(f"kit_{theme.name}", color, glow)
        atlases[mat] = atlas
    return atlases, materials


def export_piece(piece, atlases, materials, path):
    me = piece.to_mesh(atlases, materials)
    ob = bpy.data.objects.new(piece.name, me)
    bpy.context.scene.collection.objects.link(ob)
    for o in bpy.context.scene.objects:
        o.select_set(o == ob)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_yup=True, export_apply=True,
        export_cameras=False, export_lights=False, export_extras=False, export_animations=False,
        export_image_format="AUTO")
    bpy.data.objects.remove(ob)
    bpy.data.meshes.remove(me)
    for m in materials.values():
        for img in {n.image for n in m.node_tree.nodes if n.type == "TEX_IMAGE"}:
            bpy.data.images.remove(img)
        bpy.data.materials.remove(m)


def check(name, info):
    errors = []
    want = P.SPEC.get(name)
    if want:
        tol = P.LOOSE.get(name, SIZE_TOL)
        got = (info["size"]["x"], info["size"]["y"], info["size"]["z"])
        if any(abs(g - w) > tol for g, w in zip(got, want)):
            errors.append(f"size {got} != {want} (±{tol})")
    if abs((info["min"][0] + info["max"][0]) / 2) > 0.01 or abs((info["min"][2] + info["max"][2]) / 2) > 0.01 or abs(info["min"][1]) > 0.001:
        errors.append(f"pivot not at ground centre: min {info['min']} max {info['max']}")
    limit = MAX_TRIS_BUILDING if name.startswith("building-") else MAX_TRIS
    if info["tris"] > limit:
        errors.append(f"{info['tris']} tris > {limit}")
    if info["materials"] > MAX_MATERIALS:
        errors.append(f"{info['materials']} materials > {MAX_MATERIALS}")
    if info["tex_max"] > MAX_TEX:
        errors.append(f"embedded image {info['tex_max']}px > {MAX_TEX}")
    if info["alpha"] != ["OPAQUE"] and not (name == "hologram" and set(info["alpha"]) <= {"OPAQUE", "BLEND"}):
        errors.append(f"alpha {info['alpha']}")
    return errors


def main():
    a = parse()
    t0 = time.time()
    spec = THEMES[a.theme]
    theme = A.Theme(spec)
    out_dir = os.path.join(SCENE_DIR, "models", "kit", a.theme)
    ren_dir = os.path.join(HERE, "renders", a.theme)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    K = P.Kit(theme)
    built, missing = P.build_all(K, [a.piece] if a.piece else spec["pieces"])
    if missing:
        raise SystemExit(f"[kit] theme '{a.theme}' lists pieces with no builder yet: {', '.join(missing)}")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(ren_dir, exist_ok=True)
    for p in built:
        p.recentre()
    tmp = tempfile.mkdtemp(prefix=f"kit-{a.theme}-")
    manifest, failures, report = {}, [], []
    if a.piece:
        with open(os.path.join(out_dir, "manifest.json")) as f:
            manifest = json.load(f)
    for p in built:
        path = os.path.join(out_dir, p.name + ".glb")
        atlases, materials = texture_piece(p, K, theme, tmp)
        export_piece(p, atlases, materials, path)
        info = glb.inspect(path)
        errs = check(p.name, info)
        if errs:
            failures.append(f"{p.name}: {'; '.join(errs)}")
        manifest[p.name] = {"size": info["size"], "tris": info["tris"], "materials": info["materials"],
                            "texture": info["texture"], "emissive": info["emissive"]}
        report.append((p.name, info))
        print(f"[kit] {p.name:22s} {info['tris']:4d} tris {info['materials']} mat "
              f"{info['size']['x']:6.2f} x {info['size']['y']:5.2f} x {info['size']['z']:6.2f}  "
              f"tex {info['texture']['w']}x{info['texture']['h']}{' +glow' if info['emissive'] else '      '}  {info['bytes'] / 1024:6.1f} KB"
              f"{'  !! ' + '; '.join(errs) if errs else ''}", flush=True)
    shutil.rmtree(tmp, ignore_errors=True)
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
        f.write("\n")
    total_tris = sum(i["tris"] for _, i in report)
    total_kb = sum(os.path.getsize(os.path.join(out_dir, n)) for n in os.listdir(out_dir)) / 1024
    print(f"[kit] export done: {total_tris} tris total, {total_kb / 1024:.2f} MB on disk, {time.time() - t0:.1f}s", flush=True)

    if not a.no_renders:
        R.render_all(out_dir, ren_dir, report, theme)
        print(f"[kit] renders -> {ren_dir}, {time.time() - t0:.1f}s", flush=True)
    if failures:
        print("[kit] CONTRACT FAILURES\n  " + "\n  ".join(failures), flush=True)
        sys.exit(1)
    print(f"[kit] ok in {time.time() - t0:.1f}s", flush=True)


try:
    main()
except SystemExit:
    raise
except Exception:
    print("[kit] ERROR\n" + traceback.format_exc(), flush=True)
    sys.exit(1)
