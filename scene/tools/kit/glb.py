"""Read back an exported GLB and report what the explorer will get: triangles, materials, size
in scene axes, images, alpha and double-sided flags. Plain Python, also runnable outside Blender:

    python3 scene/tools/kit/glb.py scene/models/kit/city/*.glb
"""
import json
import os
import struct
import sys


def image_size(blob):
    """(w, h) of a PNG or JPEG byte string."""
    if blob[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", blob[16:24])
    if blob[:2] == b"\xff\xd8":
        i = 2
        while i < len(blob):
            marker, seglen = blob[i + 1], struct.unpack(">H", blob[i + 2:i + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", blob[i + 5:i + 9])
                return w, h
            i += 2 + seglen
    raise ValueError("unknown image format")


def inspect(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, _, _ = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise ValueError(f"{path}: not a GLB")
    jlen, jtype = struct.unpack_from("<II", data, 12)
    gltf = json.loads(data[20:20 + jlen])
    bin_start = 20 + jlen + 8
    sizes = []
    for img in gltf.get("images", []):
        bv = gltf["bufferViews"][img["bufferView"]]
        off = bin_start + bv.get("byteOffset", 0)
        sizes.append(image_size(data[off:off + bv["byteLength"]]))
    acc = gltf.get("accessors", [])
    tris, lo, hi, mats = 0, [1e9] * 3, [-1e9] * 3, set()
    for mesh in gltf.get("meshes", []):
        for prim in mesh["primitives"]:
            if prim.get("mode", 4) != 4:
                raise ValueError(f"{path}: non-triangle primitive")
            n = acc[prim["indices"]]["count"] if "indices" in prim else acc[prim["attributes"]["POSITION"]]["count"]
            tris += n // 3
            pos = acc[prim["attributes"]["POSITION"]]
            lo = [min(a, b) for a, b in zip(lo, pos["min"])]
            hi = [max(a, b) for a, b in zip(hi, pos["max"])]
            if "material" in prim:
                mats.add(prim["material"])
    for node in gltf.get("nodes", []):
        if any(k in node for k in ("translation", "rotation", "scale", "matrix")):
            raise ValueError(f"{path}: node '{node.get('name')}' has a transform; geometry must be baked")
    materials = [gltf["materials"][i] for i in sorted(mats)]
    textures = gltf.get("textures", [])

    def tex_size(m, key):
        ref = m.get("pbrMetallicRoughness", {}).get(key) if key == "baseColorTexture" else m.get(key)
        return sizes[textures[ref["index"]]["source"]] if ref else None
    color = [tex_size(m, "baseColorTexture") for m in materials]
    color = [c for c in color if c]
    return {
        "tris": tris,
        "materials": len(materials),
        "material_names": [m.get("name") for m in materials],
        "alpha": sorted({m.get("alphaMode", "OPAQUE") for m in materials}),
        "double_sided": any(m.get("doubleSided") for m in materials),
        "emissive": any("emissiveTexture" in m or any(m.get("emissiveFactor", [0, 0, 0])) for m in materials),
        "images": len(sizes),
        "texture": {"w": color[0][0], "h": color[0][1]} if color else None,
        "tex_max": max((max(wh) for wh in sizes), default=0),
        "min": lo, "max": hi,
        "size": {k: round(hi[i] - lo[i], 3) for i, k in enumerate("xyz")},
        "bytes": os.path.getsize(path),
    }


if __name__ == "__main__":
    for p in sys.argv[1:]:
        r = inspect(p)
        print(f"{os.path.basename(p):28s} {r['tris']:4d} tris  {r['materials']} mat  "
              f"{r['size']['x']:6.2f} x {r['size']['y']:5.2f} x {r['size']['z']:6.2f}  "
              f"{r['images']} img <= {r['tex_max']}px{' glow' if r['emissive'] else ''}  {r['bytes'] / 1024:7.1f} KB")
