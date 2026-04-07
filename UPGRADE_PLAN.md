# 🎮 Game Upgrade Plan: Multi-Map & Asset System

## 📋 Overview

Upgrade Stickman Fighter từ single map → **3 themed maps** với:
- **Expandable canvas** (wider maps, more platforms)
- **Themed platforms** (images + colors theo style)
- **Background environments** (theo style)
- **Random platform movement** (dynamic gameplay)
- **Map selection UI** (player picks map trước khi fight)

---

## 🎨 Map Design Specifications

### Map 1: NARUTO STYLE
**Theme**: Hidden Leaf Village battle arena  
**Canvas**: 1600×720 (320px wider than current)  
**Background**: Village/temple aesthetic, evening lighting  
**Primary Color**: Orange (#FF8C00), Black (#1a1a1a)

#### Platforms:
```
- Ground floor (main): x:0, y:620, w:1600, h:100 (passThrough: false)
  └─ Image: stone/dirt ground with naruto symbols
- Left quarter: x:120, y:480, w:200, h:20 (passThrough: true)
  └─ Image: wooden plank/ninja platform
- Left center: x:380, y:360, w:240, h:20 (passThrough: true)
  └─ Image: stone/rock platform
- Center: x:650, y:280, w:300, h:20 (passThrough: true)
  └─ Image: floating chakra platform (glowing)
- Right center: x:980, y:360, w:240, h:20 (passThrough: true)
  └─ Image: wooden platform
- Right quarter: x:1280, y:480, w:200, h:20 (passThrough: true)
  └─ Image: ninja platform
- Left high: x:80, y:200, w:150, h:20 (passThrough: true)
  └─ Image: small stone platform
- Right high: x:1370, y:200, w:150, h:20 (passThrough: true)
  └─ Image: small stone platform
```

**Background Elements** (non-colliding):
- Village silhouette (back layer, y:50-200)
- Trees/structures (side panels)
- Lighting effects (evening glow)

---

### Map 2: DRAGON BALL STYLE
**Theme**: Hyperbolic Time Chamber / Battle Island  
**Canvas**: 1600×720  
**Background**: Ethereal/cosmic energy, purple-blue tones  
**Primary Color**: Purple (#8B00FF), Cyan (#00D9FF)

#### Platforms:
```
- Ground floor: x:0, y:620, w:1600, h:100 (passThrough: false)
  └─ Image: energy floor with ki trails
- Lower left: x:100, y:500, w:220, h:18 (passThrough: true)
  └─ Image: energy cube/block
- Lower right: x:1280, y:500, w:220, h:18 (passThrough: true)
  └─ Image: energy cube/block
- Left mid: x:150, y:390, w:200, h:16 (passThrough: true)
  └─ Image: ki-based platform (semi-transparent)
- Center low: x:650, y:400, w:280, h:16 (passThrough: true)
  └─ Image: energy platform (glowing lines)
- Right mid: x:1250, y:390, w:200, h:16 (passThrough: true)
  └─ Image: ki-based platform
- Left high: x:200, y:280, w:180, h:16 (passThrough: true)
  └─ Image: floating energy sphere base
- Center high: x:680, y:220, w:240, h:16 (passThrough: true)
  └─ Image: energy nexus platform (bright glow)
- Right high: x:1220, y:280, w:180, h:16 (passThrough: true)
  └─ Image: floating energy sphere base
```

**Background Elements**:
- Energy aura/halo (animated shimmer, rotates slowly)
- Cosmic particles (optional parallax)
- Time chamber walls (side edges, semi-visible)

---

### Map 3: FPT SOFTWARE STYLE
**Theme**: Tech office / Digital workspace  
**Canvas**: 1600×720  
**Background**: Modern office, tech-sleek (blue/green neon)  
**Primary Color**: FPT Pink (#FF006E), Neon Green (#39FF14), Dark Blue (#0A1E3F)

#### Platforms:
```
- Ground floor: x:0, y:620, w:1600, h:100 (passThrough: false)
  └─ Image: office floor (polished tile/carpet)
- Lower left desk: x:80, y:520, w:200, h:16 (passThrough: true)
  └─ Image: desk/cubicle edge
- Lower right desk: x:1320, y:520, w:200, h:16 (passThrough: true)
  └─ Image: desk/cubicle edge
- Left shelf: x:120, y:410, w:180, h:18 (passThrough: true)
  └─ Image: bookshelf/server rack
- Center shelf (low): x:680, y:430, w:240, h:18 (passThrough: true)
  └─ Image: server rack
- Right shelf: x:1300, y:410, w:180, h:18 (passThrough: true)
  └─ Image: bookshelf/server rack
- Left high window: x:140, y:320, w:160, h:16 (passThrough: true)
  └─ Image: window frame / monitor edge
- Center monitor: x:720, y:280, w:160, h:16 (passThrough: true)
  └─ Image: monitor edge (digital glow)
- Right high window: x:1300, y:320, w:160, h:16 (passThrough: true)
  └─ Image: window frame / monitor edge
```

**Background Elements**:
- Office interior (desks, chairs silhouettes)
- Windows with city lights
- Digital dashboard (top or side)
- Periodic screen flashes (tech aesthetic)

---

## 🧩 Code Structure Changes

### 1. **Config System Refactor** (`js/config.js`)

**Current**: Single static `PLATFORMS` array

**New**: Map definitions object
```javascript
const MAPS = {
    naruto: {
        canvasWidth: 1600,
        canvasHeight: 720,
        name: 'Hidden Leaf Village',
        backgroundImagePath: 'assets/maps/naruto/bg_main.png',
        backgroundMusicPath: 'assets/music/naruto_theme.mp3',
        platforms: [ /* array of platform objects */ ],
        randomPlatformMovement: {
            enabled: true,
            probability: 0.3,  // 30% chance per platform to move
            minVelocity: -2,
            maxVelocity: 2,
            moveRange: 60,  // pixels
        }
    },
    dragonball: { /* similar structure */ },
    fptsoftware: { /* similar structure */ },
};

const CONFIG = Object.freeze({
    // ... existing config ...
    MAPS,
    DEFAULT_MAP: 'naruto',
    // ... rest ...
});
```

### 2. **Platform System Enhancement** (`js/platform.js`)

#### Add platform image rendering:
```javascript
class PlatformSystem {
    constructor(mapKey) {
        const mapDef = CONFIG.MAPS[mapKey];
        this.platforms = mapDef.platforms;
        this.mapKey = mapKey;
        this.platformImages = {}; // cache loaded images
    }

    // Load platform sprites for the map
    loadSprites(scene) {
        for (let plat of this.platforms) {
            if (plat.imagePath) {
                scene.load.image(plat.imageKey, plat.imagePath);
                this.platformImages[plat.imageKey] = { path: plat.imagePath, loaded: false };
            }
        }
    }

    // Draw platforms with images or fallback colors
    draw(g) {
        for (const plat of this.platforms) {
            if (plat.imagePath && this.platformImages[plat.imageKey]?.image) {
                // Draw image
                g.drawImage(this.platformImages[plat.imageKey].image, plat.x, plat.y);
            } else {
                // Fallback: color-based drawing (current system)
                if (!plat.passThrough) {
                    this._drawGround(g, plat);
                } else {
                    this._drawPlatform(g, plat);
                }
            }
        }
    }
}
```

#### Add random movement:
```javascript
class PlatformSystem {
    constructor(mapKey) {
        // ... existing ...
        this.platformVelocities = {};  // per-platform movement velocities
        this.platformOriginalPositions = {};  // store original x/y
    }

    update(deltaTime, scene) {
        const config = CONFIG.MAPS[this.mapKey].randomPlatformMovement;
        if (!config.enabled) return;

        for (let plat of this.platforms) {
            if (!this.platformVelocities[plat.id]) {
                this.platformVelocities[plat.id] = 0;
                this.platformOriginalPositions[plat.id] = { x: plat.x, y: plat.y };
            }

            // Random direction change
            if (Math.random() < config.probability) {
                this.platformVelocities[plat.id] = 
                    config.minVelocity + Math.random() * (config.maxVelocity - config.minVelocity);
            }

            // Move platform
            plat.x += this.platformVelocities[plat.id];

            // Clamp within move range
            const origX = this.platformOriginalPositions[plat.id].x;
            const minX = origX - config.moveRange;
            const maxX = origX + config.moveRange;
            if (plat.x < minX || plat.x > maxX) {
                this.platformVelocities[plat.id] *= -1;  // reverse direction
                plat.x = Math.max(minX, Math.min(maxX, plat.x));
            }
        }
    }
}
```

### 3. **GameScene Updates** (`js/scenes/GameScene.js`)

#### Accept map selection in `init()`:
```javascript
init(data) {
    this.mode = data.mode || '1vAI';
    this.mapKey = data.mapKey || CONFIG.DEFAULT_MAP;  // NEW
    this.tournament = data.tournament || null;
    // ... rest ...
}
```

#### Update canvas size & platform system in `create()`:
```javascript
create() {
    const C = CONFIG;
    const mapDef = CONFIG.MAPS[this.mapKey];  // NEW

    // Resize canvas if needed
    if (mapDef.canvasWidth !== C.WIDTH) {
        // Update camera bounds, blast zones, etc.
        this.game.scale.resize(mapDef.canvasWidth, mapDef.canvasHeight);
    }

    // ... existing state ...
    
    // Initialize platforms for selected map
    this._platforms = new PlatformSystem(this.mapKey);  // CHANGED
    
    // Load background image
    this.add.image(mapDef.canvasWidth / 2, mapDef.canvasHeight / 2, 
                   `bg_${this.mapKey}`)
        .setScrollFactor(0)
        .setDepth(0);

    // ... rest of create ...
}
```

#### Update `update()` to call platform movement:
```javascript
update(time, delta) {
    this._render();
    if (this.roundPaused || this.isPaused || this.matchOver) return;

    this._updateInput();
    this._updateBots(delta);
    this._updateFighters(delta);
    this._platforms.update(delta, this);  // NEW: update platform positions
    this._particles.update(delta);
    // ... rest ...
}
```

### 4. **Menu / Map Selection** (`js/scenes/MenuScene.js`)

Create map selection screen or integrate into play menu:
```javascript
class MenuScene extends Phaser.Scene {
    create() {
        // ... existing menu code ...
        
        // Add map selector buttons
        const mapKeys = Object.keys(CONFIG.MAPS);
        mapKeys.forEach((key, i) => {
            const btn = this.add.text(/* position for grid */);
            btn.setInteractive().on('pointerdown', () => {
                this.selectedMap = key;
                // Update button styling to show selection
                this.updateMapSelection();
            });
        });

        // Modify Play button to pass selected map
        this.playBtn.on('pointerdown', () => {
            this.scene.start('GameScene', { 
                mapKey: this.selectedMap || CONFIG.DEFAULT_MAP,
                mode: '1vAI' 
            });
        });
    }
}
```

---

## 📁 Asset Folder Structure & Naming Convention

### Directory Layout:
```
project-root/
├── assets/                          (NEW folder)
│   ├── maps/
│   │   ├── naruto/
│   │   │   ├── bg_main.png         (1600×720 background)
│   │   │   ├── bg_overlay.png      (optional parallax layer)
│   │   │   └── platforms/
│   │   │       ├── plat_ground.png
│   │   │       ├── plat_wooden.png
│   │   │       ├── plat_stone.png
│   │   │       ├── plat_chakra.png
│   │   │       └── plat_ninja.png
│   │   │
│   │   ├── dragonball/
│   │   │   ├── bg_main.png
│   │   │   ├── bg_energy_aura.png  (animated overlay)
│   │   │   └── platforms/
│   │   │       ├── plat_ground.png
│   │   │       ├── plat_energy_block.png
│   │   │       ├── plat_ki_base.png
│   │   │       ├── plat_energy_platform.png
│   │   │       └── plat_energy_nexus.png
│   │   │
│   │   └── fptsoftware/
│   │       ├── bg_main.png
│   │       ├── bg_dashboard.png    (overlay HUD)
│   │       └── platforms/
│   │           ├── plat_ground.png
│   │           ├── plat_desk.png
│   │           ├── plat_shelf.png
│   │           ├── plat_server_rack.png
│   │           └── plat_monitor.png
│   │
│   └── music/
│       ├── naruto_theme.mp3
│       ├── dragonball_theme.mp3
│       └── fptsoftware_theme.mp3
```

### Naming Convention:

#### Background Images:
- **Format**: `bg_<map>_<layer>.png`
- **Examples**:
  - `bg_naruto_main.png` — main background
  - `bg_naruto_overlay.png` — front layer (optional)
  - `bg_dragonball_energy_aura.png` — animated glow

#### Platform Images:
- **Format**: `plat_<map>_<type>.png` OR `plat_<type>_<map>.png`
- **Choose convention**: Use first one (`plat_<map>_<type>`) for easier map organization
- **Examples**:
  - `plat_naruto_ground.png`
  - `plat_naruto_chakra.png`
  - `plat_dragonball_energy_block.png`
  - `plat_fptsoftware_monitor.png`

#### Dimensions:
- **Background**: 1600×720 (full canvas)
- **Platforms**: Variable (see platform specs above)
  - Ground: 1600×100
  - Mid platforms: 200-300 wide, 16-20 tall
  - Suggested: Create at 1x scale initially, resize in code if needed
- **Overlay/Secondary**: 1600×720

#### File Format:
- **PNG** (transparency support)
- **Quality**: Compress but keep visual clarity (tool: TinyPNG or ImageOptim)
- **Avoid**: JPG (artifacts), BMP (size)

---

## 🎯 Asset Requirements Checklist

### NARUTO Map:
- [ ] `bg_naruto_main.png` — Village scene, evening lighting
- [ ] `plat_naruto_ground.png` — Stone/dirt ground
- [ ] `plat_naruto_wooden.png` — Ninja wooden platform
- [ ] `plat_naruto_stone.png` — Rock/stone platform
- [ ] `plat_naruto_chakra.png` — Glowing chakra platform (floating)
- [ ] `plat_naruto_ninja.png` — Small ninja platform
- [ ] `naruto_theme.mp3` — Background music

### DRAGON BALL Map:
- [ ] `bg_dragonball_main.png` — Hyperbolic Chamber / Island
- [ ] `bg_dragonball_energy_aura.png` — Rotating energy glow (animated)
- [ ] `plat_dragonball_ground.png` — Energy floor
- [ ] `plat_dragonball_energy_cube.png` — Energy block/cube
- [ ] `plat_dragonball_ki_base.png` — Ki-based platform
- [ ] `plat_dragonball_energy_platform.png` — Glowing energy platform
- [ ] `plat_dragonball_energy_nexus.png` — Bright energy platform (center high)
- [ ] `dragonball_theme.mp3` — Background music

### FPT SOFTWARE Map:
- [ ] `bg_fptsoftware_main.png` — Modern office interior
- [ ] `bg_fptsoftware_dashboard.png` — Digital dashboard (overlay, optional)
- [ ] `plat_fptsoftware_ground.png` — Office floor/carpet
- [ ] `plat_fptsoftware_desk.png` — Desk/cubicle edge
- [ ] `plat_fptsoftware_shelf.png` — Bookshelf / server rack
- [ ] `plat_fptsoftware_monitor.png` — Monitor edge (digital style)
- [ ] `plat_fptsoftware_window.png` — Window frame (neon-lit)
- [ ] `fptsoftware_theme.mp3` — Background music (tech vibes)

---

## 📸 Image Search & Sourcing Guide

### Recommended Sources:
1. **Free Assets**:
   - [Freepik](https://freepik.com) — Search "naruto background game", "dragon ball arena"
   - [Unsplash](https://unsplash.com) — Technical office, abstract energy
   - [Pexels](https://pexels.com) — Office, nature, tech backgrounds
   - [OpenGameArt.org](https://opengameart.org) — Game-specific assets (may find anime-style)

2. **Anime/Gaming Specific**:
   - [Itch.io](https://itch.io) — Search "naruto asset pack", "dragon ball tileset"
   - [DeviantArt](https://deviantart.com) — Fan art (verify usage rights)
   - [ArtStation](https://artstation.com) — Professional game art

3. **AI Generation** (Fast):
   - [Midjourney](https://midjourney.com) — "Naruto ninja battle arena 1600x720"
   - [DALL-E](https://openai.com/dall-e) — "Dragon Ball hyperbolic chamber"
   - [Stable Diffusion](https://huggingface.co/spaces/stabilityai/stable-diffusion-webui)

### Search Keywords:

#### Naruto Map:
- "Hidden Leaf Village background"
- "Naruto battle arena"
- "Japanese temple evening"
- "Ninja training ground"
- "Chakra energy platform"

#### Dragon Ball Map:
- "Hyperbolic Time Chamber"
- "Dragon Ball S energy arena"
- "Purple energy nebula"
- "Floating island battle"
- "Ki energy environment"

#### FPT Software Map:
- "Modern tech office interior" + "neon blue green"
- "Digital dashboard background"
- "Server room aesthetic"
- "Futuristic workspace"
- "Neon city office nighttime"

---

## 🛠 Implementation Roadmap

### Phase 1: Code Structure (Agent Task)
1. **Config Extension** — Add `MAPS` object with 3 map definitions
2. **Platform System Refactor** — Support image rendering + random movement
3. **GameScene Updates** — Accept `mapKey`, load map assets, update platform logic
4. **Menu Integration** — Add map selector UI

### Phase 2: Asset Sourcing & Preparation (Your Task)
1. Find/create 21 images (see checklist above)
2. Download and organize into `assets/` folder structure
3. Name following convention (e.g., `plat_naruto_chakra.png`)
4. Compress images (target: ~100-200KB per image)

### Phase 3: Asset Integration (Agent Task)
1. Wire up image loading in PlatformSystem
2. Add background image rendering in GameScene
3. Test collision with image-based platforms
4. Implement random platform movement logic

### Phase 4: Polish (Both)
1. Tune platform movement speeds / probabilities
2. Sound effects / music integration
3. UI feedback for map selection
4. Performance optimization

---

## 📝 Detailed Specs for Each Platform

### Platform Object Properties:

```javascript
{
    x: number,              // left edge pixel position
    y: number,              // top edge pixel position
    w: number,              // width in pixels
    h: number,              // height in pixels
    passThrough: boolean,   // true = one-way (drop-through), false = solid
    id: string,             // unique identifier (e.g., "naruto_plat_01")
    imagePath: string,      // path to image (optional, e.g., "assets/maps/naruto/platforms/...")
    imageKey: string,       // Phaser cache key for loaded image
    randomMovement: {       // (optional) per-platform override
        enabled: boolean,
        moveRange: number,
        minVelocity: number,
        maxVelocity: number
    }
}
```

---

## ✅ Verification Checklist

**Before Agent Coding**:
- [ ] All 3 maps designed with platform coordinates
- [ ] Asset folder structure planned
- [ ] Naming convention agreed upon

**Before You Source Assets**:
- [ ] Reviewed map layout diagrams (see specs above)
- [ ] Understood dimension requirements (1600×720 for backgrounds)
- [ ] Bookmarked image sources

**After Assets Created**:
- [ ] All images renamed per convention
- [ ] Images placed in correct `assets/maps/<map>/` folders
- [ ] Images compressed (target: < 500KB total per map)
- [ ] Verified transparency (PNG) for platforms

**After Code Integration**:
- [ ] Map selector appears in menu
- [ ] Can switch between all 3 maps
- [ ] Platforms display with images (fallback colors if loading fails)
- [ ] Random movement works smoothly
- [ ] No collision bugs with image-based platforms

---

## 🎬 Example Map Configuration (Config.js)

```javascript
const MAPS = {
    naruto: {
        name: 'Hidden Leaf Village',
        canvasWidth: 1600,
        canvasHeight: 720,
        backgroundImagePath: 'assets/maps/naruto/bg_main.png',
        backgroundMusicKey: 'music_naruto',
        randomPlatformMovement: {
            enabled: true,
            probability: 0.25,
            minVelocity: -1.5,
            maxVelocity: 1.5,
            moveRange: 50,
        },
        platforms: [
            { id: 'naruto_ground', x: 0, y: 620, w: 1600, h: 100, passThrough: false, 
              imagePath: 'assets/maps/naruto/platforms/plat_ground.png', imageKey: 'plat_naruto_ground' },
            { id: 'naruto_left_quarter', x: 120, y: 480, w: 200, h: 20, passThrough: true,
              imagePath: 'assets/maps/naruto/platforms/plat_wooden.png', imageKey: 'plat_naruto_wooden' },
            // ... more platforms ...
        ]
    },
    // dragonball: { ... },
    // fptsoftware: { ... }
};
```

---

## 📞 Next Steps

1. **Agent** → Implement code changes (Phase 1)
2. **You** → Source & prepare assets (Phase 2)
3. **Agent** → Integrate assets into code (Phase 3)
4. **Both** → Polish & test (Phase 4)

Once assets are ready, share the folder structure and agent will wire everything up! 🚀
