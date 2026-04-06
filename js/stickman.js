'use strict';
/* =========================================================
   STICKMAN — Procedural canvas drawing with animation states
   Draws a full articulated stickman using canvas 2D paths.
   Angles are derived from fighter state so movement feels
   alive without a sprite sheet.
   ========================================================= */

class Stickman {
    /**
     * @param {string} color   — stroke color (hex/rgb/hsl)
     * @param {string} shadow  — glow color
     * @param {boolean} flipX  — mirrors the character (P2 faces left at start)
     */
    constructor(color, shadow, flipX = false) {
        this.color = color;
        this.shadow = shadow;
        this.flipX = flipX;
    }

    /**
     * Draw the stickman centered at (cx, groundY) where groundY is the
     * bottom of the feet.
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {Object} state  — from Fighter: { x, y, hp, maxHp, facing,
     *   state:'idle'|'walk'|'jump'|'punch'|'kick'|'hurt'|'dead',
     *   atkTimer, tick, onGround }
     */
    draw(ctx, state) {
        const C = CONFIG;
        const cx = state.x;
        const gy = state.y;           // feet Y
        const dir = state.facing;      // 1 = right, -1 = left
        const tick = state.tick * 0.08; // normalized time for oscillation
        const st = state.state;
        const dead = st === 'dead';

        // ---- Choose draw color ----
        let strokeColor = dead ? C.DEAD_COLOR :
            st === 'hurt' ? '#ffffff' : this.color;
        let glowColor = dead ? 'transparent' : this.shadow;

        // ---- Compute joint angles based on state ----
        let walkT = 0;
        let jumpOff = 0;
        let crouchOff = 0;
        let leanAngle = 0;

        // Body sway angles for limbs
        let LA_upper = 0;  // left arm upper angle (from down)
        let LA_lower = 0;
        let RA_upper = 0;
        let RA_lower = 0;
        let LL_upper = 0;  // left leg
        let LL_lower = 0;
        let RL_upper = 0;
        let RL_lower = 0;

        const walk = Math.sin(tick * 7);
        const walkLean = dir * 0.12;

        if (st === 'idle') {
            // Gentle idle breathing bob
            const b = Math.sin(tick * 2.2) * 1.5;
            crouchOff = b;
            LA_upper = -0.15 + Math.sin(tick * 2.2) * 0.04;
            RA_upper = 0.15 + Math.sin(tick * 2.2 + 0.5) * 0.04;
            LL_upper = 0.05;
            RL_upper = -0.05;
        } else if (st === 'walk') {
            const w = Math.sin(tick * 7);
            walkT = w;
            leanAngle = walkLean;
            LA_upper = -w * 0.55;
            RA_upper = w * 0.55;
            LA_lower = Math.max(0, -w * 0.40);
            RA_lower = Math.max(0, w * 0.40);
            LL_upper = w * 0.70;
            RL_upper = -w * 0.70;
            LL_lower = Math.max(0, -w * 0.55);
            RL_lower = Math.max(0, w * 0.55);
            crouchOff = Math.abs(walk) * 2;
        } else if (st === 'jump') {
            jumpOff = -4;
            leanAngle = walkLean;
            LA_upper = -0.8;
            RA_upper = 0.8;
            LA_lower = 0.5;
            RA_lower = 0.5;
            LL_upper = 0.55;
            RL_upper = -0.55;
            LL_lower = 0.72;
            RL_lower = 0.72;
        } else if (st === 'punch') {
            const t = state.atkProgress;   // 0→1 punch advance, 1→0 recoil
            const reach = t < 0.5 ? t * 2 : (1 - t) * 2;
            LA_upper = dir > 0 ? -0.2 : 0.2;
            // dominant arm thrusts forward
            RA_upper = dir > 0 ? reach * -1.2 - 0.1 : reach * 1.2 + 0.1;
            RA_lower = reach * 0.2;
            LL_upper = 0.15;
            RL_upper = -0.15;
            leanAngle = dir * reach * 0.18;
        } else if (st === 'kick') {
            const t = state.atkProgress;
            const reach = t < 0.5 ? t * 2 : (1 - t) * 2;
            LA_upper = -0.35;
            RA_upper = 0.35;
            // dominant leg kicks forward
            RL_upper = dir > 0 ? -reach * 1.4 : reach * 1.4;
            RL_lower = reach * 1.1;
            LL_upper = 0.20;
            leanAngle = dir * reach * 0.12;
        } else if (st === 'hurt') {
            LA_upper = -0.9;
            RA_upper = 0.9;
            LA_lower = 0.4;
            RA_lower = 0.4;
            leanAngle = -dir * 0.28;
            LL_upper = 0.15;
            RL_upper = -0.15;
        } else if (st === 'dead') {
            // Ragdoll collapse
            LA_upper = -1.4;
            RA_upper = 1.0;
            LA_lower = 1.2;
            RA_lower = 0.8;
            LL_upper = 0.6;
            RL_upper = 1.1;
            LL_lower = 1.0;
            RL_lower = 0.5;
            leanAngle = dir * 0.5;
            crouchOff = 6;
        }

        // ---- Skeleton measurements ----
        const H = C.HEAD_R;
        const TL = C.TORSO_LEN;
        const AU = C.ARM_UPPER;
        const AL = C.ARM_LOWER;
        const LU = C.LEG_UPPER;
        const LL_len = C.LEG_LOWER;
        const SW = C.SHOULDER_W;
        const HW = C.HIP_W;

        // Reference Y positions from feet up
        const feetY = gy + jumpOff;
        const hipY = feetY - (LU + LL_len) + crouchOff;
        const shouldY = hipY - TL;
        const headY = shouldY - H - 4;
        const neckY = shouldY + 2;

        // ---- Start drawing ----
        ctx.save();
        ctx.translate(cx, 0);
        if (!this.flipX && dir < 0 || this.flipX && dir > 0) {
            ctx.scale(-1, 1);
        }

        // Apply lean
        ctx.translate(0, 0);

        this._setStyle(ctx, strokeColor, glowColor, dead ? 1.5 : 2.2);

        // Shadow / ground glow
        if (!dead) {
            ctx.save();
            ctx.globalAlpha = 0.18;
            ctx.fillStyle = glowColor;
            ctx.beginPath();
            ctx.ellipse(0, feetY + 3, 24, 5, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        // ---- HEAD ----
        ctx.beginPath();
        ctx.arc(0, headY, H, 0, Math.PI * 2);
        ctx.stroke();
        // Face direction dot
        if (!dead) {
            ctx.save();
            ctx.fillStyle = strokeColor;
            ctx.beginPath();
            ctx.arc(H * 0.38, headY - H * 0.1, 2.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        // ---- TORSO ----
        const bodyLean = leanAngle;
        const torsoTopX = Math.sin(bodyLean) * TL * 0.5;
        const torsoTopY = shouldY - Math.cos(bodyLean) * 2;

        ctx.beginPath();
        ctx.moveTo(0, hipY);
        ctx.lineTo(torsoTopX, torsoTopY);
        ctx.stroke();

        // Neck line
        ctx.beginPath();
        ctx.moveTo(torsoTopX, torsoTopY);
        ctx.lineTo(0, headY + H);
        ctx.stroke();

        // ---- ARMS ----
        this._drawArm(ctx, torsoTopX, torsoTopY, -SW, AU, AL, LA_upper, LA_lower);   // Left arm
        this._drawArm(ctx, torsoTopX, torsoTopY, SW, AU, AL, RA_upper, RA_lower);   // Right arm

        // ---- LEGS ----
        this._drawLeg(ctx, 0, hipY, -HW, LU, LL_len, LL_upper, LL_lower, feetY);
        this._drawLeg(ctx, 0, hipY, HW, LU, LL_len, RL_upper, RL_lower, feetY);

        ctx.restore();
    }

    /** Draw one arm from shoulder pivot. angleU = upper arm angle from vertical */
    _drawArm(ctx, sx, sy, xOff, upperLen, lowerLen, angleU, angleL) {
        const ex1 = sx + xOff + Math.sin(angleU) * upperLen;
        const ey1 = sy + Math.cos(angleU) * upperLen;
        ctx.beginPath();
        ctx.moveTo(sx + xOff, sy);
        ctx.lineTo(ex1, ey1);
        ctx.stroke();
        const ex2 = ex1 + Math.sin(angleU + angleL) * lowerLen;
        const ey2 = ey1 + Math.cos(angleU + angleL) * lowerLen;
        ctx.beginPath();
        ctx.moveTo(ex1, ey1);
        ctx.lineTo(ex2, ey2);
        ctx.stroke();
    }

    /** Draw one leg from hip; snaps lower leg so foot stays near feetY when idle */
    _drawLeg(ctx, hx, hy, xOff, upperLen, lowerLen, angleU, angleL, feetY) {
        const kx = hx + xOff + Math.sin(angleU) * upperLen;
        const ky = hy + Math.cos(angleU) * upperLen;
        ctx.beginPath();
        ctx.moveTo(hx + xOff, hy);
        ctx.lineTo(kx, ky);
        ctx.stroke();
        const fx = kx + Math.sin(angleU + angleL) * lowerLen;
        const fy = ky + Math.cos(angleU + angleL) * lowerLen;
        ctx.beginPath();
        ctx.moveTo(kx, ky);
        ctx.lineTo(fx, fy);
        ctx.stroke();
    }

    _setStyle(ctx, color, glow, lineW) {
        ctx.strokeStyle = color;
        ctx.lineWidth = lineW;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (glow && glow !== 'transparent') {
            ctx.shadowColor = glow;
            ctx.shadowBlur = 10;
        } else {
            ctx.shadowBlur = 0;
        }
    }
}
