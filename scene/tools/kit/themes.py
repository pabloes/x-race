"""Palettes per theme. Painters and pieces only name roles; a theme gives each role a colour
and, under `glow`, an emissive colour (hex, or (hex, strength) to dim it). The neon theme is
the same kit with dark bodies and glowing trims, plus its own pieces (palm, hologram)."""

# Building styles share key names (b0..b2) so the building builder is theme-agnostic.
CITY = {
    "name": "city",
    "pieces": ["barrier", "kerb", "chevron", "gate-start", "gate-checkpoint", "lamp", "banner", "stand",
               "tree-a", "tree-b", "pad", "pillar", "buildings"],
    "colors": {
        "white": "#f3f3ef",
        "concrete": "#c9ccd1",
        "pole": "#39404b",
        "rail": "#b9c1cb",
        # barrier and kerb
        "barrier_a": "#e3343c",
        "barrier_b": "#f4f4f0",
        "barrier_low": "#6f747c",
        "kerb_a": "#e3343c",
        "kerb_b": "#f4f4f0",
        # chevron
        "chevron_bg": "#1e2128",
        "chevron_fg": "#ffc414",
        # gates
        "gate": "#2457c5",
        "gate_trim": "#f4f4f0",
        "gate_light": "#fff6dc",
        "band": "#e3343c",
        "band_text": "#ffffff",
        "band_line": "#ffc414",
        "checker_a": "#1e2128",
        "checker_b": "#f4f4f0",
        "cp": "#1c2b4d",
        "cp_light": "#28e0ea",
        "cp_text": "#ffffff",
        # lamp, banner
        "lamp_light": "#fff3cf",
        "flag": "#e3343c",
        "flag_text": "#ffffff",
        # stand
        "stand": "#d4d7dc",
        "stand_trim": "#2457c5",
        "stand_roof": "#eef0f2",
        "seat": "#2c4b97",
        "board_a": "#e3343c",
        "board_b": "#2457c5",
        "board_c": "#f4f4f0",
        # pad, pillar
        "pad": "#232a35",
        "pad_light": "#2ef0ff",
        "pillar": "#c4c8cf",
        "hazard_a": "#ffc414",
        "hazard_b": "#1e2128",
        "beacon": "#ff3b30",
        # trees
        "leaf_a": "#62b846",
        "leaf_a_dark": "#2e7a35",
        "leaf_b": "#f38fbd",
        "leaf_b_dark": "#bd4f8a",
        "trunk": "#7b5537",
        # buildings: b0 glass tower, b1 white concrete, b2 blue-grey
        "b0_wall": "#dfe5ec", "b0_trim": "#c3ccd8", "b0_glass": "#4f86d0", "b0_glass_hi": "#a8cdf4", "b0_roof": "#aab3be",
        "b1_wall": "#f1ede4", "b1_trim": "#d9d2c3", "b1_glass": "#41648f", "b1_glass_hi": "#8bb0d8", "b1_roof": "#b9b4a9",
        "b2_wall": "#a9bccf", "b2_trim": "#8399b0", "b2_glass": "#2f4f7a", "b2_glass_hi": "#7fa6cf", "b2_roof": "#8e9aa8",
        "shop_glass": "#2b3644",
        "shop_base": "#4a515c",
        "roof_box": "#9aa3ad",
    },
    "glow": {
        "gate_light": ("#fff6dc", 0.9),
        "cp_light": "#28e8f2",
        "lamp_light": "#ffe2a0",
        "pad_light": "#2ef0ff",
        "beacon": ("#ff3b30", 0.8),
        "window": ("#ffc979", 0.55),
        "shop": ("#ffd7a0", 0.45),
    },
    "window_lit": 0.18,
    "awnings": ["#e3343c", "#ffc414", "#2457c5", "#3fae5a", "#f38fbd", "#ff7a1a"],
    "crowd": ["#e3343c", "#2457c5", "#ffc414", "#f4f4f0", "#3fae5a", "#f38fbd", "#ff7a1a", "#7b4fd0", "#28c8d8"],
    "skin": ["#f2c9a0", "#e0ac7e", "#b67b52", "#7a4b2c"],
    "hair": ["#2a1f1a", "#4a3121", "#8a5a2b", "#d9b46a", "#1b1b1f"],
}

# Night theme: dark bodies, glowing trims; palm replaces tree-b and the hologram is its own.
NEON = {
    "name": "neon",
    "pieces": ["barrier", "kerb", "chevron", "gate-start", "gate-checkpoint", "lamp", "banner", "stand",
               "tree-a", "palm", "pad", "pillar", "hologram", "buildings"],
    "colors": {
        **CITY["colors"],
        "concrete": "#2a2d3a", "pole": "#1b1d26", "rail": "#3a3f52",
        "barrier_a": "#20222e", "barrier_b": "#ff2bd6", "barrier_low": "#14151c",
        "kerb_a": "#20222e", "kerb_b": "#21e6ff",
        "chevron_bg": "#14151c", "chevron_fg": "#ff2bd6",
        "gate": "#1b1d2a", "gate_trim": "#21e6ff", "band": "#2a1036", "band_text": "#ff2bd6", "band_line": "#21e6ff",
        "checker_a": "#14151c", "checker_b": "#ff2bd6",
        "cp": "#16182a", "cp_light": "#ff2bd6",
        "flag": "#2a1036", "flag_text": "#21e6ff",
        "stand": "#2a2d3a", "stand_trim": "#ff2bd6", "stand_roof": "#1b1d26", "seat": "#1b1d2a",
        "board_a": "#ff2bd6", "board_b": "#21e6ff", "board_c": "#14151c",
        "pad": "#14151c", "pillar": "#2a2d3a", "hazard_a": "#21e6ff", "hazard_b": "#14151c",
        "leaf_a": "#2bd18a", "leaf_a_dark": "#0f5a4a",
        "b0_wall": "#1d2030", "b0_trim": "#2a2e44", "b0_glass": "#1a2a55", "b0_glass_hi": "#3a5fa8", "b0_roof": "#15171f",
        "b1_wall": "#24202f", "b1_trim": "#352d45", "b1_glass": "#2a1c4a", "b1_glass_hi": "#6a3fa0", "b1_roof": "#15171f",
        "b2_wall": "#1a2530", "b2_trim": "#24364a", "b2_glass": "#10324a", "b2_glass_hi": "#2a7aa8", "b2_roof": "#15171f",
        "palm_trunk": "#2b2230", "palm_ring": "#ff2bd6", "palm_leaf": "#0f4d4a",
        "holo_frame": "#1b1d26", "holo_glow": "#21e6ff", "holo_accent": "#ff2bd6", "holo_bg": "#06222c",
    },
    "glow": {
        "barrier_b": "#ff2bd6", "kerb_b": "#21e6ff", "chevron_fg": "#ff2bd6",
        "gate_trim": "#21e6ff", "gate_light": "#ffffff", "band_text": "#ff2bd6", "band_line": "#21e6ff",
        "checker_b": ("#ff2bd6", 0.7), "cp_light": "#ff2bd6", "lamp_light": "#21e6ff",
        "flag_text": "#21e6ff", "stand_trim": "#ff2bd6", "board_a": "#ff2bd6", "board_b": "#21e6ff",
        "pad_light": "#21e6ff", "hazard_a": "#21e6ff", "beacon": "#ff2bd6",
        "window": ("#ff6be0", 0.8), "shop": ("#21e6ff", 0.8),
        "palm_ring": ("#ff2bd6", 0.8), "palm_leaf": ("#14d8c4", 0.3),
        "holo_glow": "#21e6ff", "holo_accent": "#ff2bd6",
    },
    "window_lit": 0.35,
    "awnings": ["#ff2bd6", "#21e6ff", "#8a5cff", "#ffb02e"],
    "crowd": CITY["crowd"],
    "skin": CITY["skin"],
    "hair": CITY["hair"],
}

THEMES = {"city": CITY, "neon": NEON}
