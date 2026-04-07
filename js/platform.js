'use strict';
/* =========================================================
   PLATFORM SYSTEM — Multi-map upgrade
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
                const img = scene.add.image(
                    plat.x + plat.w / 2,
                    plat.y + plat.h / 2,
                    key
                );
                img.setDisplaySize(plat.w, plat.h);
                img.setDepth(1);
                this._platImages[plat.id] = img;
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
    //  Collision (unchanged from original)
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
                if (prevY > plat.y + 2) continue;
                if (entity.y >= plat.y && prevY <= plat.y + 4) {
                    entity.y = plat.y; entity.vy = 0;
                    entity.onGround = true; entity.onPlatform = plat;
                }
            } else {
                if (entity.vy >= 0 && entity.y >= plat.y && prevY <= plat.y + 4) {
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

            // Keep Phaser Image in sync
            const img = this._platImages[id];
            if (img) img.setPosition(plat.x + plat.w / 2, plat.y + plat.h / 2);
        }
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
