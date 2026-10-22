"""Read back an exported GLB and report what the explorer will get: triangles, materials, size
in scene axes, images, alpha and double-sided flags. Plain Python, also runnable outside Blender:

    python3 scene/tools/kit/glb.py scene/models/kit/city/*.glb
"""
import json
import os
import struct
import sys


def inspect(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, _, _ = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise ValueError(f"{path}: not a GLB")
    jlen, jtype = struct.unpack_from("<II", data, 12)
    gltf = json.loads(data[20:20 + jlen])
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
    return {
        "tris": tris,
        "materials": len(materials),
        "material_names": [m.get("name") for m in materials],
        "alpha": sorted({m.get("alphaMode", "OPAQUE") for m in materials}),
        "double_sided": any(m.get("doubleSided") for m in materials),
        "emissive": any("emissiveTexture" in m for m in materials),
        "images": len(gltf.get("images", [])),
        "min": lo, "max": hi,
        "size": {k: round(hi[i] - lo[i], 3) for i, k in enumerate("xyz")},
        "bytes": os.path.getsize(path),
    }


if __name__ == "__main__":
    for p in sys.argv[1:]:
        r = inspect(p)
        print(f"{os.path.basename(p):28s} {r['tris']:4d} tris  {r['materials']} mat  "
              f"{r['size']['x']:6.2f} x {r['size']['y']:5.2f} x {r['size']['z']:6.2f}  {r['bytes'] / 1024:7.1f} KB")
