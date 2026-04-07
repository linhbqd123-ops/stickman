'use strict';
/* =========================================================
   PLATFORM SYSTEM — Phaser port
   Collision logic: unchanged from vanilla.
   Draw: ported from Canvas 2D API to Phaser.GameObjects.Graphics.
   ========================================================= */

class PlatformSystem {
    constructor(platformDefs) {
        this.platforms = platformDefs || CONFIG.PLATFORMS;
    }

    // ---- Collision (unchanged) ----
    resolve(entity) {
        const halfW = entity.width || 20;
        entity.onGround = false;
        entity.onPlatform = null;

        for (const plat of this.platforms) {
            const prevY = entity.y - entity.vy;
            const withinX = entity.x + halfW > plat.x && entity.x - halfW < plat.x + plat.w;
            if (!withinX) continue;

            if (plat.passThrough) {
                if (entity.vy < 0) continue;
                if (entity.droppingThrough) continue;
                if (prevY > plat.y + 2) continue;
                if (entity.y >= plat.y && prevY <= plat.y + 4) {
                    entity.y = plat.y;
                    entity.vy = 0;
                    entity.onGround = true;
                    entity.onPlatform = plat;
                }
            } else {
                if (entity.vy >= 0 && entity.y >= plat.y && prevY <= plat.y + 4) {
                    entity.y = plat.y;
                    entity.vy = 0;
                    entity.onGround = true;
                    entity.onPlatform = plat;
                }
            }
        }
    }

    // ---- Rendering (Phaser Graphics) ----
    draw(g) {
        for (const plat of this.platforms) {
            if (!plat.passThrough) {
                this._drawGround(g, plat);
            } else {
                this._drawPlatform(g, plat);
            }
        }
    }

    _drawGround(g, p) {
        // Floor fill (dark)
        g.fillStyle(0x080814, 0.92);
        g.fillRect(p.x, p.y, p.w, p.h);

        // Subtle gradient-like glow: two thin rects above the surface
        g.fillStyle(0x0050c8, 0.12);
        g.fillRect(p.x, p.y, p.w, 10);
        g.fillStyle(0x0028a0, 0.05);
        g.fillRect(p.x, p.y - 4, p.w, 4);

        // Neon top line
        g.lineStyle(2, 0x00e5ff, 0.65);
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(p.x + p.w, p.y);
        g.strokePath();

        // Soft glow under the line (second pass, wider & dimmer)
        g.lineStyle(6, 0x00b4cc, 0.18);
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(p.x + p.w, p.y);
        g.strokePath();
    }

    _drawPlatform(g, p) {
        const rx = 8;

        // Fill
        g.fillStyle(0x001a40, 0.58);
        g.fillRoundedRect(p.x, p.y, p.w, p.h, rx);

        // Stroke
        g.lineStyle(1.5, 0x00c8ff, 0.68);
        g.strokeRoundedRect(p.x, p.y, p.w, p.h, rx);

        // Inner highlight line along the top edge
        g.lineStyle(1, 0x40e8ff, 0.35);
        g.beginPath();
        g.moveTo(p.x + rx, p.y + 1);
        g.lineTo(p.x + p.w - rx, p.y + 1);
        g.strokePath();

        // Underside glow
        g.lineStyle(4, 0x00e5ff, 0.18);
        g.beginPath();
        g.moveTo(p.x + rx, p.y + p.h);
        g.lineTo(p.x + p.w - rx, p.y + p.h);
        g.strokePath();
    }
}

window.PlatformSystem = PlatformSystem;
