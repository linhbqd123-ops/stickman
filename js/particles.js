'use strict';
/* =========================================================
   PARTICLES — Blood splatter & hit sparks
   ========================================================= */
class ParticleSystem {
    constructor() {
        this.list = [];
    }

    /** Spawn blood particles at (x, y), flying toward dirX side. */
    spawnBlood(x, y, dirX = 1) {
        const C = CONFIG;
        for (let i = 0; i < C.BLOOD_COUNT; i++) {
            // Spread mostly toward attack direction, upward arc
            const spread = (Math.random() - 0.5) * Math.PI;
            const angle = (dirX > 0 ? 0 : Math.PI) + spread - Math.PI * 0.4;
            const speed = Math.random() * C.BLOOD_SPEED + 1.5;

            this.list.push({
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 2.5,
                life: C.BLOOD_LIFE + Math.random() * 10 | 0,
                maxLife: C.BLOOD_LIFE,
                r: Math.random() * 3.5 + 1.5,
                // Random dark-red to bright-red hue
                hue: Math.random() * 20,
                light: 35 + Math.random() * 20 | 0,
                type: 'blood',
            });
        }
    }

    /** Spark burst at impact point (yellow-white). */
    spawnSpark(x, y) {
        for (let i = 0; i < 9; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 6 + 2;
            this.list.push({
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 12 + Math.random() * 8 | 0,
                maxLife: 16,
                r: Math.random() * 2.5 + 0.8,
                type: 'spark',
            });
        }
    }

    /** Dust puff when landing. */
    spawnDust(x, y) {
        for (let i = 0; i < 5; i++) {
            this.list.push({
                x: x + (Math.random() - 0.5) * 20,
                y,
                vx: (Math.random() - 0.5) * 2.5,
                vy: -Math.random() * 1.5 - 0.5,
                life: 18 + Math.random() * 10 | 0,
                maxLife: 22,
                r: Math.random() * 5 + 3,
                type: 'dust',
            });
        }
    }

    update() {
        for (let i = this.list.length - 1; i >= 0; i--) {
            const p = this.list[i];
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.28;   // light gravity on particles
            p.vx *= 0.97;
            p.life--;
            if (p.life <= 0) this.list.splice(i, 1);
        }
    }

    draw(ctx) {
        this.list.forEach(p => {
            const alpha = p.life / p.maxLife;
            ctx.save();
            ctx.globalAlpha = alpha * alpha;   // quadratic fade

            if (p.type === 'blood') {
                ctx.fillStyle = `hsl(${p.hue}, 88%, ${p.light}%)`;
                ctx.shadowColor = `hsl(${p.hue}, 88%, ${p.light}%)`;
                ctx.shadowBlur = 4;
            } else if (p.type === 'spark') {
                const l = 65 + (1 - alpha) * 25;
                ctx.fillStyle = `hsl(48, 100%, ${l}%)`;
                ctx.shadowColor = '#fff8c0';
                ctx.shadowBlur = 6;
            } else /* dust */ {
                ctx.fillStyle = `rgba(200,200,220,${alpha * 0.35})`;
                ctx.shadowBlur = 0;
            }

            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        });
    }

    clear() { this.list = []; }
}
