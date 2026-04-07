'use strict';
/* =========================================================
   PLATFORM SYSTEM — Multi-map upgrade
   
   PLATFORM PROPERTIES:
   • id: unique identifier
   • x, y: top-left position
   • w: width in pixels
    • h: collision height (physics/hitbox) — controls where fighter stands
    • displayHeight/visualH: image render height (visual only, never affects collision)
    • imageAnchorY: 0.0–1.0, which row % of the image aligns with plat.y (default 0 = image top)
    • imageOffsetY: pixel fine-tune for image Y after anchor is applied
   • passThrough: one-way platform? (true = can drop through from above)
   • imagePath: asset path to platform image
   • imageKey: Phaser texture key for caching
   
   KEY CONCEPT — anchor point A = (plat.x, plat.y)
   Everything is measured from A independently:

   Collision box  → A down by h px          (player feet snap to A.y)
   Image          → shifted by imageAnchorY  (0% = image top at A.y)

   PNG with transparent top (anchor at 40% = imageAnchorY: 0.4):
   ┌──────────────────────────────────┐ ← image top  (A.y - 0.4*displayHeight)
   │  transparent padding             │
   ├──────────────────────────────────┤ ← A.y = plat.y = player feet ← COLLISION
   │  visible platform surface        │
   │  (actual artwork)                │
   └──────────────────────────────────┘ ← image bottom

   h and displayHeight/imageAnchorY are COMPLETELY INDEPENDENT.
   
   BENEFITS:
   • Clear separation: physics ≠ visuals
    • Config flexibility: tune collision without affecting image scaling
   • Easy to fix: tall visuals + compact collision = no floating fighters
   
   SYSTEM FEATURES:
   • constructor(scene, mapKey) — resolves MAPS config, deep-copies platforms
   • Image support — creates Phaser Image objects for platforms with imageKey
   • Random movement — smooth velocity-based horizontal drift for passThrough
   • Themed fallback colours — per-map neon palette when images are absent
   • destroy() — cleans up Phaser Image objects on scene shutdown
   ========================================================= */

class PlatformSystem {
    constructor(scene, mapKey) {
        const mapDef = (CONFIG.MAPS && CONFIG.MAPS[mapKey]) || null;

        // Deep-copy platforms so runtime movement never mutates CONFIG
        const srcPlats = (mapDef && mapDef.platforms) ? mapDef.platforms : CONFIG.PLATFORMS;
        this.platforms = srcPlats.map(p => Object.assign({}, p));

        this._scene     = scene;
        this._mapKey    = mapKey || 'default';
        this._moveCfg   = (mapDef && mapDef.randomPlatformMovement) || { enabled: false };
        this._platImages  = {};   // id → Phaser.GameObjects.Image
        this._platVels    = {};   // id → current velocity (px per 60-fps frame)
        this._platTimers  = {};   // id → ms until next velocity change

        // ---- Create Phaser Image objects for platforms with loaded textures ----
        for (const plat of this.platforms) {
            const key = plat.imageKey;
            if (key && scene && scene.textures.exists(key)) {
                // Anchor image at TOP-CENTER (origin 0.5, 0):
                // imageOffsetY (default 0): fine-tune image position when PNG has
                // transparent padding at the top so the visible surface doesn't start at pixel row 0.
                //   imageOffsetY: 0   → image top aligns exactly with collision surface (plat.y)
                //   imageOffsetY: -20 → shift image UP 20px (visible surface was 20px too low)
                //   imageOffsetY: +10 → shift image DOWN 10px
                const visualBounds = this._resolveVisualBounds(plat, key);
                const img = scene.add.image(
                    visualBounds.x + visualBounds.w / 2,
                    visualBounds.y,
                    key
                );
                img.setOrigin(0.5, 0);   // top-center anchor: image grows downward from plat.y
                img.setDisplaySize(visualBounds.w, visualBounds.h);
                img.setDepth(1);
                this._platImages[plat.id] = img;

                // Persist resolved visual bounds for debug + runtime sync.
                // These are visual-only and never used for collision.
                plat._visualDx = visualBounds.x - plat.x;
                plat._visualDy = visualBounds.y - plat.y;
                plat._visualW = visualBounds.w;
                plat._visualH = visualBounds.h;
                plat._visualBounds = {
                    x: visualBounds.x,
                    y: visualBounds.y,
                    w: visualBounds.w,
                    h: visualBounds.h,
                };
            }

            // ---- Init movement state for floating (passThrough) platforms ----
            if (plat.passThrough && this._moveCfg.enabled && plat.id) {
                plat._originX               = plat.x;
                this._platVels[plat.id]     = 0;
                // Stagger starting timers so not all platforms move at once
                this._platTimers[plat.id]   = 400 + Math.random() * 2200;
            }
        }
    }

    // =========================================================
    //  Collision Detection
    //  KEY: h defines collision height tolerance
    //    - displayHeight = visual appearance
    //    - h = collision box height (from plat.y to plat.y + h)
    //    - Entity stands at plat.y (top surface)
    //    - colHeight = Math.max(h, 4) ensures minimum tolerance
    // =========================================================
    resolve(entity) {
        const halfW = entity.width || 20;
        entity.onGround   = false;
        entity.onPlatform = null;

        for (const plat of this.platforms) {
            const prevY   = entity.y - entity.vy;
            const withinX = entity.x + halfW > plat.x && entity.x - halfW < plat.x + plat.w;
            if (!withinX) continue;

            if (plat.passThrough) {
                if (entity.vy < 0) continue;
                if (entity.droppingThrough) continue;
                // Use h to define collision height; minimum 4px tolerance for safety
                const colHeight = Math.max(plat.h, 4);
                if (prevY > plat.y + colHeight) continue;  // h MATTERS: bigger h = can approach from higher
                if (entity.y >= plat.y && prevY <= plat.y + colHeight) {
                    entity.y = plat.y; entity.vy = 0;
                    entity.onGround = true; entity.onPlatform = plat;
                }
            } else {
                // Use h for solid platforms too
                const colHeight = Math.max(plat.h, 4);
                if (entity.vy >= 0 && entity.y >= plat.y && prevY <= plat.y + colHeight) {
                    entity.y = plat.y; entity.vy = 0;
                    entity.onGround = true; entity.onPlatform = plat;
                }
            }
        }

        // ---- Wall-side contact detection (non-passThrough platforms only) ----
        // Reset each frame; filled below if touching a wall while airborne.
        entity.onWall      = false;
        entity.wallDir     = 0;
        entity.wallPlatform = null;

        if (!entity.onGround) {
            const WF = 10;   // wall-feel threshold (px)
            for (const plat of this.platforms) {
                if (plat.passThrough) continue;

                // Vertical overlap: entity body (approx y-90 to y) vs platform surface
                const eTop  = entity.y - 90;
                const eFeet = entity.y;
                if (eFeet < plat.y + 6 || eTop > plat.y + plat.h) continue;

                // Entity's right edge touching platform's LEFT face
                const rightEdge = entity.x + halfW;
                if (rightEdge >= plat.x - WF && rightEdge <= plat.x + WF &&
                    entity.x < plat.x + halfW) {
                    entity.onWall       = true;
                    entity.wallDir      = 1;           // fighter faces RIGHT toward wall
                    entity.wallPlatform = plat;
                    entity.x            = plat.x - halfW;   // snap flush
                    if (entity.vx > 0) entity.vx = 0;
                    break;
                }

                // Entity's left edge touching platform's RIGHT face
                const leftEdge = entity.x - halfW;
                if (leftEdge <= plat.x + plat.w + WF && leftEdge >= plat.x + plat.w - WF &&
                    entity.x > plat.x + plat.w - halfW) {
                    entity.onWall       = true;
                    entity.wallDir      = -1;          // fighter faces LEFT toward wall
                    entity.wallPlatform = plat;
                    entity.x            = plat.x + plat.w + halfW;  // snap flush
                    if (entity.vx < 0) entity.vx = 0;
                    break;
                }
            }
        }
    }

    // =========================================================
    //  Random Movement — call once per game frame from GameScene.update()
    // =========================================================
    update(delta) {
        if (!this._moveCfg.enabled) return;
        const { minVelocity, maxVelocity, moveRange } = this._moveCfg;
        const dt = delta / 16.667;   // normalise to 60 fps

        for (const plat of this.platforms) {
            if (!plat.passThrough || plat._originX === undefined || !plat.id) continue;
            const id = plat.id;

            // Count down; when timer expires pick a new random velocity
            this._platTimers[id] -= delta;
            if (this._platTimers[id] <= 0) {
                this._platVels[id]   = minVelocity + Math.random() * (maxVelocity - minVelocity);
                this._platTimers[id] = 1500 + Math.random() * 2500;
            }

            // Advance position
            plat.x += this._platVels[id] * dt;

            // Bounce at range limits
            const minX = plat._originX - moveRange;
            const maxX = plat._originX + moveRange;
            if (plat.x <= minX) {
                plat.x = minX;
                this._platVels[id] = Math.abs(this._platVels[id]);
            } else if (plat.x >= maxX) {
                plat.x = maxX;
                this._platVels[id] = -Math.abs(this._platVels[id]);
            }

            // Keep Phaser Image in sync with moving platform
            const img = this._platImages[id];
            if (img) {
                const visualX = plat.x + (plat._visualDx || 0);
                const visualY = plat.y + (plat._visualDy || 0);
                img.setPosition(visualX + (plat._visualW || plat.w) / 2, visualY);
                plat._visualBounds = {
                    x: visualX,
                    y: visualY,
                    w: plat._visualW || plat.w,
                    h: plat._visualH || 0,
                };
            }
        }
    }

    _resolveVisualBounds(plat, textureKey) {
        const tex = this._scene && this._scene.textures ? this._scene.textures.get(textureKey) : null;
        const src = tex && tex.getSourceImage ? tex.getSourceImage() : null;

        const naturalW = src && src.width ? src.width : Math.max(plat.w || 1, 1);
        const naturalH = src && src.height ? src.height : naturalW;

        // ── Visual width (never affects collision w) ──────────────────────
        const resolvedW = Number.isFinite(plat.visualW) ? plat.visualW
            : (Number.isFinite(plat.visualWidth) ? plat.visualWidth : plat.w);

        // ── Visual height (NEVER touches plat.h / collision) ─────────────
        // Priority: visualH → visualHeight → displayHeight → natural aspect ratio
        const resolvedH = Number.isFinite(plat.visualH) ? plat.visualH
            : (Number.isFinite(plat.visualHeight) ? plat.visualHeight
            : (Number.isFinite(plat.displayHeight) ? plat.displayHeight
            : Math.max(1, resolvedW * (naturalH / Math.max(naturalW, 1)))));

        // ── Visual X (never affects collision) ───────────────────────────
        const offX = Number.isFinite(plat.imageOffsetX) ? plat.imageOffsetX : 0;
        const visualX = plat.x + offX;

        // ── Visual Y — FULLY INDEPENDENT from collision plat.y ───────────
        //
        //  plat.y  = collision surface (where player feet land). FIXED. Untouched.
        //
        //  imageAnchorY (0.0–1.0): which row of the IMAGE should align with plat.y.
        //    0.0 (default) → image top    aligns with plat.y  (no transparent top)
        //    0.4           → 40% down the image aligns with plat.y
        //                    (PNG has 40% transparent top before visible surface)
        //    0.5           → image center aligns with plat.y
        //  imageOffsetY: additional pixel fine-tune AFTER anchor is applied.
        //
        //  Example: PNG is 100px tall, visible plank starts at row 30 (30% down).
        //    → imageAnchorY: 0.3   image shifts up 30px, plank top lands at plat.y.
        //    Player feet at plat.y = touching visible plank. No floating.
        //
        const anchorY = Number.isFinite(plat.imageAnchorY) ? plat.imageAnchorY : 0;
        const offY    = Number.isFinite(plat.imageOffsetY) ? plat.imageOffsetY : 0;
        // Image top = plat.y shifted up by anchor fraction, then fine-tuned by offY
        const visualY = plat.y - anchorY * resolvedH + offY;

        return { x: visualX, y: visualY, w: resolvedW, h: resolvedH };
    }

    // =========================================================
    //  Rendering — Graphics fallback (skips image-backed platforms)
    // =========================================================
    draw(g) {
        for (const plat of this.platforms) {
            // Already rendered via Phaser Image — skip
            if (plat.id && this._platImages[plat.id]) continue;

            if (!plat.passThrough) {
                this._drawGround(g, plat);
            } else {
                this._drawPlatform(g, plat);
            }
        }
    }

    // =========================================================
    //  Destroy — call from GameScene.shutdown()
    // =========================================================
    destroy() {
        for (const img of Object.values(this._platImages)) {
            if (img && img.destroy) img.destroy();
        }
        this._platImages = {};
    }

    // =========================================================
    //  Internal drawing helpers (map-themed colours)
    // =========================================================
    _theme() {
        switch (this._mapKey) {
            case 'naruto':
                return { groundFill: 0x1a0a00, glowFill: 0x8b4500, lineColor: 0xff8c00, glowColor: 0xffaa33, platFill: 0x2a1000 };
            case 'dragonball':
                return { groundFill: 0x0d0020, glowFill: 0x4400cc, lineColor: 0x8b00ff, glowColor: 0xcc66ff, platFill: 0x1a004d };
            case 'fptsoftware':
                return { groundFill: 0x020c1a, glowFill: 0x006622, lineColor: 0x39ff14, glowColor: 0x00ff88, platFill: 0x00101a };
            default:
                return { groundFill: 0x080814, glowFill: 0x0050c8, lineColor: 0x00e5ff, glowColor: 0x40e8ff, platFill: 0x001a40 };
        }
    }

    _drawGround(g, p) {
        const t = this._theme();
        g.fillStyle(t.groundFill, 0.92);
        g.fillRect(p.x, p.y, p.w, p.h);

        g.fillStyle(t.glowFill, 0.12);
        g.fillRect(p.x, p.y, p.w, 10);
        g.fillStyle(t.glowFill, 0.05);
        g.fillRect(p.x, p.y - 4, p.w, 4);

        g.lineStyle(2, t.lineColor, 0.65);
        g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x + p.w, p.y); g.strokePath();

        g.lineStyle(6, t.glowColor, 0.18);
        g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x + p.w, p.y); g.strokePath();
    }

    _drawPlatform(g, p) {
        const rx = 8;
        const t  = this._theme();

        g.fillStyle(t.platFill, 0.58);
        g.fillRoundedRect(p.x, p.y, p.w, p.h, rx);

        g.lineStyle(1.5, t.lineColor, 0.68);
        g.strokeRoundedRect(p.x, p.y, p.w, p.h, rx);

        g.lineStyle(1, t.glowColor, 0.35);
        g.beginPath(); g.moveTo(p.x + rx, p.y + 1); g.lineTo(p.x + p.w - rx, p.y + 1); g.strokePath();

        g.lineStyle(4, t.lineColor, 0.18);
        g.beginPath(); g.moveTo(p.x + rx, p.y + p.h); g.lineTo(p.x + p.w - rx, p.y + p.h); g.strokePath();
    }
}

window.PlatformSystem = PlatformSystem;
