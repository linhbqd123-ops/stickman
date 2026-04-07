'use strict';
/* =========================================================
   PHASER PARTICLE SYSTEM
   Ported from vanilla particles.js.

   Changes:
   • Accepts scene reference for timer scheduling
   • setTimeout() → scene.time.delayedCall()
   • Draw targets Phaser.GameObjects.Graphics instead of ctx
   • Color passed as CSS strings → inline computed per-particle
   ========================================================= */

class PhaserParticleSystem {
    constructor(scene) {
        this._scene = scene;   // Phaser.Scene
        this.list = [];
    }

    // ---- Spawn methods (identical API to original ParticleSystem) ----

    spawnBlood(x, y, dirX = 1) {
        const C = CONFIG;
        for (let i = 0; i < C.BLOOD_COUNT; i++) {
            const spread = (Math.random() - 0.5) * Math.PI;
            const angle = (dirX > 0 ? 0 : Math.PI) + spread - Math.PI * 0.4;
            const speed = Math.random() * C.BLOOD_SPEED + 1.5;
            this.list.push({
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 2.5,
                life: C.BLOOD_LIFE + (Math.random() * 10 | 0),
                maxLife: C.BLOOD_LIFE,
                r: Math.random() * 3.5 + 1.5,
                hue: Math.random() * 20,
                light: 35 + (Math.random() * 20 | 0),
                type: 'blood',
            });
        }
    }

    spawnSpark(x, y) {
        for (let i = 0; i < 9; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 6 + 2;
            this.list.push({
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 12 + (Math.random() * 8 | 0),
                maxLife: 16,
                r: Math.random() * 2.5 + 0.8,
                type: 'spark',
            });
        }
    }

    spawnDust(x, y) {
        for (let i = 0; i < 5; i++) {
            this.list.push({
                x: x + (Math.random() - 0.5) * 20, y,
                vx: (Math.random() - 0.5) * 2.5,
                vy: -Math.random() * 1.5 - 0.5,
                life: 18 + (Math.random() * 10 | 0),
                maxLife: 22,
                r: Math.random() * 5 + 3,
                type: 'dust',
            });
        }
    }

    // Wall-scrape dust — sprays outward from the contact point when sliding down
    spawnWallDust(x, y, wallDir) {
        for (let i = 0; i < 3; i++) {
            this.list.push({
                x: x + wallDir * 12 + (Math.random() - 0.5) * 5,
                y: y - 35 - Math.random() * 25,
                vx: -wallDir * (Math.random() * 1.8 + 0.3) + (Math.random() - 0.5) * 0.4,
                vy: Math.random() * 0.5 - 0.6,
                life: 14 + (Math.random() * 8 | 0),
                maxLife: 18,
                r: Math.random() * 2.5 + 1.0,
                type: 'dust',
            });
        }
    }

    spawnExplosion(x, y) {
        // Fire burst
        for (let i = 0; i < 30; i++) {
            const angle = (i / 30) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
            const speed = Math.random() * 11 + 4;
            this.list.push({
                x: x + (Math.random() - 0.5) * 20,
                y: y + (Math.random() - 0.5) * 20,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 3,
                life: 28 + (Math.random() * 20 | 0),
                maxLife: 40,
                r: Math.random() * 5 + 2,
                type: 'explosion',
                hue: Math.random() * 60,
            });
        }
        // Shockwave rings (delayed)
        for (let ring = 0; ring < 4; ring++) {
            this._scheduleTimer(ring * 60, () => {
                this.list.push({
                    x, y,
                    type: 'shockwave',
                    radius: 8 + ring * 12,
                    maxRadius: 140 + ring * 50,
                    life: 280 + ring * 60,
                    maxLife: 280 + ring * 60,
                    width: 4 - ring * 0.5,
                    r: 0,           // unused but required by update loop guard
                    vx: 0, vy: 0,
                    color_r: 255, color_g: 200 - ring * 40, color_b: Math.max(0, 50 - ring * 10),
                    alpha0: 0.85 - ring * 0.18,
                });
            });
        }
    }

    spawnShockwave(x, y, size = 1) {
        for (let ring = 0; ring < 2; ring++) {
            this._scheduleTimer(ring * 40, () => {
                const lifetime = 200 + ring * 100;
                this.list.push({
                    x, y,
                    type: 'shockwave',
                    radius: 5 + ring * 8,
                    maxRadius: (60 + ring * 40) * size,
                    life: lifetime,
                    maxLife: lifetime,
                    width: 3 + ring * 1.5,
                    r: 0, vx: 0, vy: 0,
                    color_r: 255, color_g: 200, color_b: 100,
                    alpha0: 0.8 - ring * 0.3,
                });
            });
        }
    }

    // ---- Timer helper ----
    _scheduleTimer(delay, fn) {
        if (this._scene && this._scene.time) {
            this._scene.time.delayedCall(delay, fn);
        } else {
            setTimeout(fn, delay);
        }
    }

    // ---- Update (called each frame with delta) ----
    update(delta) {
        for (let i = this.list.length - 1; i >= 0; i--) {
            const p = this.list[i];
            if (p.type !== 'shockwave') {
                p.x += p.vx;
                p.y += p.vy;
                p.vy += 0.28;
                p.vx *= 0.97;
            }
            p.life--;
            if (p.life <= 0) this.list.splice(i, 1);
        }
    }

    // ---- Draw (called each frame, g is Phaser.GameObjects.Graphics) ----
    draw(g) {
        for (const p of this.list) {
            const alpha = p.life / p.maxLife;

            if (p.type === 'shockwave') {
                const progress = 1 - alpha;
                const currentRadius = p.radius + (p.maxRadius - p.radius) * progress;
                const lineAlpha = alpha * 0.7 * p.alpha0;
                const color = (p.color_r << 16) | (p.color_g << 8) | p.color_b;
                g.lineStyle(p.width * (1 - progress * 0.5), color, lineAlpha);
                g.beginPath();
                g.arc(p.x, p.y, currentRadius, 0, Math.PI * 2);
                g.strokePath();
            } else {
                const a = alpha * alpha;   // quadratic fade

                if (p.type === 'blood') {
                    // hsl-like: red/dark-red
                    const lf = p.light / 100;
                    const r = Math.round(lf * 180 + p.hue * 2);
                    const gr = Math.round(lf * 20);
                    const b = Math.round(lf * 20);
                    const color = ((r & 0xff) << 16) | ((gr & 0xff) << 8) | (b & 0xff);
                    g.fillStyle(color, a);
                    g.fillCircle(p.x, p.y, p.r);

                } else if (p.type === 'spark') {
                    const l = 65 + (1 - alpha) * 25;
                    const lf2 = l / 100;
                    const rv = Math.min(255, Math.round(lf2 * 255));
                    const gv = Math.min(255, Math.round(lf2 * 248));
                    const bv = Math.round(lf2 * 192);
                    const color = (rv << 16) | (gv << 8) | bv;
                    g.fillStyle(color, a);
                    g.fillCircle(p.x, p.y, p.r);

                } else if (p.type === 'explosion') {
                    const l = 55 + (1 - alpha) * 20;
                    const lf3 = l / 100;
                    // hue 0-60 = yellow→red
                    const rv2 = Math.min(255, Math.round(255 * lf3));
                    const gv2 = Math.min(255, Math.round((1 - p.hue / 60) * 255 * lf3));
                    const color = (rv2 << 16) | (gv2 << 8);
                    g.fillStyle(color, a);
                    g.fillCircle(p.x, p.y, p.r);

                } else {
                    // dust
                    g.fillStyle(0xc8c8dc, a * 0.35);
                    g.fillCircle(p.x, p.y, p.r);
                }
            }
        }
    }

    clear() { this.list = []; }
}

window.PhaserParticleSystem = PhaserParticleSystem;
