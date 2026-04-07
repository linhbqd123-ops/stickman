# Maps Assets Directory Structure

```
assets/maps/
├── naruto/                      (Hidden Leaf Village theme)
│   ├── bg_main.png             (required: 1600×720)
│   ├── bg_overlay.png          (optional)
│   └── platforms/
│       ├── plat_ground.png
│       ├── plat_wooden.png
│       ├── plat_stone.png
│       ├── plat_chakra.png
│       └── plat_ninja.png
│
├── dragonball/                 (Hyperbolic Time Chamber theme)
│   ├── bg_main.png             (required: 1600×720)
│   ├── bg_energy_aura.png      (optional: animated)
│   └── platforms/
│       ├── plat_ground.png
│       ├── plat_energy_cube.png
│       ├── plat_ki_base.png
│       ├── plat_energy_platform.png
│       └── plat_energy_nexus.png
│
└── fptsoftware/                (Tech Office theme)
    ├── bg_main.png             (required: 1600×720)
    ├── bg_dashboard.png        (optional)
    └── platforms/
        ├── plat_ground.png
        ├── plat_desk.png
        ├── plat_shelf.png
        ├── plat_server_rack.png (or use plat_shelf.png)
        ├── plat_monitor.png
        └── plat_window.png
```

## Total Assets Needed: 23 Images

### Required:
- 6 Background images (1600×720 each)
- 17 Platform images (variable dimensions)

### Optional (for enhanced visuals):
- Overlay images
- Animated background elements (handled via code)

## Upload Instructions:

1. **Find/create 23 images** per the naming convention above
2. **Compress images** (target: < 200KB each)
3. **Place directly into the corresponding folders**
   - e.g., `bg_main.png` → `assets/maps/naruto/`
   - e.g., `plat_chakra.png` → `assets/maps/naruto/platforms/`
4. **No renaming needed** — filenames already follow convention

## Naming Rules:
- Background: `bg_<name>.png` (e.g., `bg_main.png`, `bg_overlay.png`)
- Platforms: `plat_<type>.png` (e.g., `plat_ground.png`, `plat_chakra.png`)
- Music: `<map>_theme.mp3` (e.g., `naruto_theme.mp3`)

See each map's README.md for detailed image specifications.
