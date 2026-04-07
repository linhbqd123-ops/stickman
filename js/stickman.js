'use strict';
/* =========================================================
   STICKMAN — Phaser.GameObjects.Graphics procedural renderer
   Ported from Canvas 2D API to Phaser 3 Graphics API.

   Key changes from vanilla version:
   • ctx.save()/translate()/scale() → manual wx() flip transform
   • ctx.shadowColor/shadowBlur → two-pass double-draw glow
   • CSS color strings → integer 0xRRGGBB colors
   • ctx.fillStyle/strokeStyle → g.fillStyle()/g.lineStyle()
   ========================================================= */

// ---- Color Utilities ----
function _cssToInt(str) {
    if (!str) return 0xffffff;
    str = str.trim();
    if (str.startsWith('#')) return parseInt(str.slice(1), 16);
    const m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return (parseInt(m[1]) << 16) | (parseInt(m[2]) << 8) | parseInt(m[3]);
    return 0xffffff;
}

function _cssToAlpha(str) {
    if (!str) return 1;
    const m = str.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/);
    return m ? parseFloat(m[1]) : 1;
}

// ---- Stickman Class ----
class Stickman {
    constructor(color, shadow, flipX = false) {
        this.color = color;
        this.shadow = shadow;
        this.flipX = flipX;
        this.intColor = _cssToInt(color);
        this.intShadow = _cssToInt(shadow);
        this.shadowAlpha = _cssToAlpha(shadow) * 0.55;
    }

    // =========================================================
    //  draw — entry point called by Fighter.draw()
    //  g     : Phaser.GameObjects.Graphics
    //  state : Fighter instance (or afterimage snapshot)
    // =========================================================
    draw(g, state) {
        const C = CONFIG;
        const cx = state.x;
        const gy = state.y;
        const dir = state.facing;
        const st = state.state;
        const atk = state.attackType || '';
        const dead = st === 'dead';
        const tick = state.tick * 0.08;
        // dimAlpha: used by afterimage trail (0.0 – 1.0), defaults to 1.
        const dimAlpha = (state.dimAlpha !== undefined) ? state.dimAlpha : 1.0;

        // Flip: replicate ctx.translate(cx,0); ctx.scale(flip?-1:1, 1)
        const shouldFlip = (!this.flipX && dir < 0) || (this.flipX && dir > 0);
        const fs = shouldFlip ? -1 : 1;   // flip sign

        // wx(localX) → world screen X  (Y coordinates are already absolute)
        const wx = lx => cx + lx * fs;

        // ---- Choose stroke color ----
        const invin = state.invTimer > 0 && !dead;
        let strokeInt = dead ? _cssToInt(C.DEAD_COLOR)
            : st === 'hurt' ? 0xffffff
                : invin ? this._pulseInt(this.intColor, tick)
                    : this.intColor;

        // ---- Pose angles (identical logic to vanilla stickman.js) ----
        let jumpOff = 0, crouchOff = 0, leanAngle = 0;
        let LA_upper = 0, LA_lower = 0, RA_upper = 0, RA_lower = 0;
        let LL_upper = 0, LL_lower = 0, RL_upper = 0, RL_lower = 0;

        const walk = Math.sin(tick * 7);

        if (st === 'idle') {
            const b = Math.sin(tick * 2.2) * 1.5;
            crouchOff = b;
            LA_upper = -0.15 + Math.sin(tick * 2.2) * 0.04;
            RA_upper = 0.15 + Math.sin(tick * 2.2 + 0.5) * 0.04;
            LL_upper = 0.05;
            RL_upper = -0.05;
        } else if (st === 'walk') {
            leanAngle = 0.12;              // positive = lean forward; wx() handles flip
            LA_upper = -walk * 0.55;
            RA_upper = walk * 0.55;
            LA_lower = Math.max(0, -walk * 0.40);
            RA_lower = Math.max(0, walk * 0.40);
            LL_upper = walk * 0.70;
            RL_upper = -walk * 0.70;
            LL_lower = Math.max(0, -walk * 0.55);
            RL_lower = Math.max(0, walk * 0.55);
            crouchOff = Math.abs(walk) * 2;
        } else if (st === 'crouch') {
            crouchOff = 15;
            LA_upper = -0.6;
            RA_upper = 0.6;
            LL_upper = 0.7;
            RL_upper = -0.7;
            LL_lower = 0.3;
            RL_lower = 0.3;
            leanAngle = 0.08;
        } else if (st === 'airborne' || st === 'jump') {
            jumpOff = -6;
            leanAngle = 0.10;
            LA_upper = -0.9;
            RA_upper = 0.9;
            LA_lower = 0.4;
            RA_lower = 0.4;
            LL_upper = 0.55;
            RL_upper = -0.55;
            LL_lower = 0.65;
            RL_lower = 0.65;
        } else if (st === 'dodge') {
            crouchOff = 10;
            LA_upper = -0.5;
            RA_upper = 0.5;
            LL_upper = 0.5;
            RL_upper = -0.5;
        } else if (st === 'dash') {
            leanAngle = 0.35;
            LA_upper = -1.0;
            RA_upper = 1.0;
            LA_lower = 0.3;
            RA_lower = 0.3;
            LL_upper = 0.8;
            RL_upper = -0.5;
            LL_lower = 0.5;
            RL_lower = 0.4;
        } else if (st === 'attack') {
            this._attackPose(atk, state.atkProgress, dir,
                {
                    LA_upper, LA_lower, RA_upper, RA_lower,
                    LL_upper, LL_lower, RL_upper, RL_lower, leanAngle,
                    crouchOff, jumpOff
                },
                p => {
                    LA_upper = p.LA_upper; LA_lower = p.LA_lower;
                    RA_upper = p.RA_upper; RA_lower = p.RA_lower;
                    LL_upper = p.LL_upper; LL_lower = p.LL_lower;
                    RL_upper = p.RL_upper; RL_lower = p.RL_lower;
                    leanAngle = p.leanAngle;
                    if (p.crouchOff !== undefined) crouchOff = p.crouchOff;
                    if (p.jumpOff !== undefined) jumpOff = p.jumpOff;
                });
        } else if (st === 'hurt') {
            LA_upper = -0.9;
            RA_upper = 0.9;
            LA_lower = 0.4;
            RA_lower = 0.4;
            leanAngle = -0.28;       // lean backward (away from hit); wx() handles flip
        } else if (dead) {
            LA_upper = -1.4;
            RA_upper = 1.0;
            LA_lower = 1.2;
            RA_lower = 0.8;
            LL_upper = 0.6;
            RL_upper = 1.1;
            LL_lower = 1.0;
            RL_lower = 0.5;
            leanAngle = 0.5;
            crouchOff = 6;
        }

        // ---- Skeleton measurements ----
        const H = C.HEAD_R;
        const TL = C.TORSO_LEN;
        const AU = C.ARM_UPPER;
        const AL = C.ARM_LOWER;
        const LU = C.LEG_UPPER;
        const LL_ln = C.LEG_LOWER;
        const SW = C.SHOULDER_W;
        const HW = C.HIP_W;

        const feetY = gy + jumpOff;
        const hipY = feetY - (LU + LL_ln) + crouchOff;
        const shouldY = hipY - TL;
        const headY = shouldY - H - 4;
        const torsoTopX = Math.sin(leanAngle) * TL * 0.5;
        const torsoTopY = shouldY - Math.cos(leanAngle) * 2;

        // ---- Ground shadow ellipse ----
        if (!dead) {
            g.fillStyle(this.intShadow, 0.18 * dimAlpha);
            g.fillEllipse(cx, feetY + 3, 48, 10);
        }

        // ---- Glow pass (thick, transparent) ----
        if (!dead) {
            g.lineStyle(8, this.intShadow, this.shadowAlpha * dimAlpha);
            this._drawSkeleton(g, wx, cx, feetY, hipY, shouldY, headY,
                torsoTopX, torsoTopY, H, TL, AU, AL, LU, LL_ln, SW, HW,
                LA_upper, LA_lower, RA_upper, RA_lower,
                LL_upper, LL_lower, RL_upper, RL_lower);
        }

        // ---- Main pass ----
        g.lineStyle(dead ? 1.5 : 2.2, strokeInt, dimAlpha);
        this._drawSkeleton(g, wx, cx, feetY, hipY, shouldY, headY,
            torsoTopX, torsoTopY, H, TL, AU, AL, LU, LL_ln, SW, HW,
            LA_upper, LA_lower, RA_upper, RA_lower,
            LL_upper, LL_lower, RL_upper, RL_lower);

        // ---- Eye ----
        if (!dead) {
            g.fillStyle(strokeInt, dimAlpha);
            g.fillCircle(wx(H * 0.38), headY - H * 0.1, 2.5);
        }

        // ---- Skill indicator (orb above head) ----
        if (!dead && state.collectedSkill && dimAlpha >= 1) {
            const skillDef = CONFIG.SKILLS[state.collectedSkill];
            if (skillDef) {
                const sc = _cssToInt(skillDef.color);
                const ready = state.energy >= CONFIG.ENERGY.MAX;
                const pulse = ready ? (0.55 + Math.sin(tick * 10) * 0.45) : 0.40;
                const r = ready ? 7 : 5;
                // Glow ring
                g.lineStyle(3, sc, pulse * 0.6);
                g.beginPath();
                g.arc(cx, headY - H - 14, r + 3, 0, Math.PI * 2);
                g.strokePath();
                // Core orb
                g.fillStyle(sc, pulse);
                g.fillCircle(cx, headY - H - 14, r);
            }
        }
    }

    // =========================================================
    //  _drawSkeleton — draws all body parts using Phaser Graphics
    // =========================================================
    _drawSkeleton(g, wx, cx, feetY, hipY, shouldY, headY,
        torsoTopX, torsoTopY, H, TL, AU, AL, LU, LL_ln, SW, HW,
        LA_upper, LA_lower, RA_upper, RA_lower,
        LL_upper, LL_lower, RL_upper, RL_lower) {

        // HEAD
        g.beginPath();
        g.arc(cx, headY, H, 0, Math.PI * 2);
        g.strokePath();

        // TORSO (hip → torso-top → head)
        g.beginPath();
        g.moveTo(wx(0), hipY);
        g.lineTo(wx(torsoTopX), torsoTopY);
        g.strokePath();

        g.beginPath();
        g.moveTo(wx(torsoTopX), torsoTopY);
        g.lineTo(cx, headY + H);   // cx = wx(0) — center never flips
        g.strokePath();

        // ARMS
        this._drawArm(g, wx, torsoTopX, torsoTopY, -SW, AU, AL, LA_upper, LA_lower);
        this._drawArm(g, wx, torsoTopX, torsoTopY, SW, AU, AL, RA_upper, RA_lower);

        // LEGS
        this._drawLeg(g, wx, 0, hipY, -HW, LU, LL_ln, LL_upper, LL_lower, feetY);
        this._drawLeg(g, wx, 0, hipY, HW, LU, LL_ln, RL_upper, RL_lower, feetY);
    }

    _drawArm(g, wx, sx, sy, xOff, upperLen, lowerLen, angleU, angleL) {
        const ex1 = sx + xOff + Math.sin(angleU) * upperLen;
        const ey1 = sy + Math.cos(angleU) * upperLen;
        g.beginPath();
        g.moveTo(wx(sx + xOff), sy);
        g.lineTo(wx(ex1), ey1);
        g.strokePath();

        const ex2 = ex1 + Math.sin(angleU + angleL) * lowerLen;
        const ey2 = ey1 + Math.cos(angleU + angleL) * lowerLen;
        g.beginPath();
        g.moveTo(wx(ex1), ey1);
        g.lineTo(wx(ex2), ey2);
        g.strokePath();
    }

    _drawLeg(g, wx, hx, hy, xOff, upperLen, lowerLen, angleU, angleL, feetY) {
        const kx = hx + xOff + Math.sin(angleU) * upperLen;
        const ky = hy + Math.cos(angleU) * upperLen;
        g.beginPath();
        g.moveTo(wx(hx + xOff), hy);
        g.lineTo(wx(kx), ky);
        g.strokePath();

        const fx = kx + Math.sin(angleU + angleL) * lowerLen;
        const fy = ky + Math.cos(angleU + angleL) * lowerLen;
        g.beginPath();
        g.moveTo(wx(kx), ky);
        g.lineTo(wx(fx), fy);
        g.strokePath();
    }

    // =========================================================
    //  _attackPose — all angles in LOCAL space; wx() handles flip
    //
    //  CONVENTION (no dir conditionals needed for angle signs):
    //   positive angle  = limb extends toward local +X = facing direction
    //   negative angle  = limb extends toward local -X = backward
    //   leanAngle > 0   = torso leans FORWARD  (positive = forward, wx() flips)
    //   leanAngle < 0   = torso leans BACKWARD
    // =========================================================
    _attackPose(atkKey, t, dir, pose, set) {
        const p = Object.assign({}, pose);
        const atk = CONFIG.ATTACKS[atkKey];

        const ACTIVE_WIN = 80;
        const totalDur = atk ? (atk.delay_start + ACTIVE_WIN + atk.delay_end) : 300;
        const startupEnd = atk ? (atk.delay_start / totalDur) : 0.25;
        const activeEnd = startupEnd + (ACTIVE_WIN / totalDur);

        let startup = 0, active = 0, recovery = 0;
        if (t <= startupEnd) {
            startup = startupEnd > 0 ? t / startupEnd : 1;
        } else if (t <= activeEnd) {
            active = (t - startupEnd) / Math.max(0.001, activeEnd - startupEnd);
        } else {
            recovery = (t - activeEnd) / Math.max(0.001, 1 - activeEnd);
        }
        const reach = t <= startupEnd ? 0 : t <= activeEnd ? active : 1 - recovery;

        // ── LIGHT NEUTRAL ─────────────────────────────────────
        // 3-hit ground combo: Right Jab → Left Cross → Kick
        if (atkKey === 'light_neutral') {
            if (startup > 0) {
                // Wind-up: pull right arm back, guard left
                p.RA_upper = -(0.2 + startup * 0.55);
                p.LA_upper = -0.3;
                p.leanAngle = -(startup * 0.10);
            } else {
                if (active < 0.38) {
                    // Hit 1: Right Jab — RA sweeps forward
                    const t1 = active / 0.38;
                    p.RA_upper = -0.75 + t1 * 1.65;   // -0.75 → +0.90
                    p.RA_lower = t1 * 0.35;
                    p.LA_upper = -0.3;
                    p.leanAngle = t1 * 0.15;
                } else if (active < 0.70) {
                    // Hit 2: Left Cross — LA crosses body forward
                    const t2 = (active - 0.38) / 0.32;
                    p.LA_upper = 0.25 + t2 * 0.85;    // +0.25 → +1.10 (crosses fwd)
                    p.LA_lower = t2 * 0.30;
                    p.RA_upper = 0.55;                 // RA settles back
                    p.leanAngle = 0.15 - t2 * 0.05;
                } else {
                    // Hit 3: Kick finisher
                    const t3 = (active - 0.70) / 0.30;
                    p.RL_upper = t3 * 1.40;            // kick forward
                    p.RL_lower = t3 * 0.90;
                    p.leanAngle = 0.10 + t3 * 0.15;
                    p.LA_upper = 0.3;
                    p.RA_upper = 0.3;
                }
            }

            // ── LIGHT FORWARD ─────────────────────────────────────
            // Slide step + forward kick
        } else if (atkKey === 'light_forward') {
            if (startup > 0) {
                p.leanAngle = startup * 0.20;
                p.RL_upper = -(startup * 0.30);        // leg coils back
            } else {
                p.RL_upper = reach * 1.30;             // kick FORWARD (no dir cond.)
                p.RL_lower = reach * 0.95;
                p.leanAngle = 0.20 + reach * 0.10;
                p.LA_upper = -0.3;
                p.RA_upper = 0.4;
            }

            // ── LIGHT DOWN ────────────────────────────────────────
            // Soccer slide-tackle — whole body goes LOW, leg slides forward
        } else if (atkKey === 'light_down') {
            if (startup > 0) {
                p.crouchOff = startup * 14;
                p.leanAngle = startup * 0.35;
                p.RL_upper = startup * 0.40;
            } else {
                p.crouchOff = 14 + reach * 6;           // body very low (max ~20)
                p.leanAngle = 0.35 + reach * 0.15;      // lean well forward
                p.RL_upper = reach * 1.50;             // sliding leg forward (no dir cond.)
                p.RL_lower = reach * 0.25;             // low to ground
                p.LL_upper = -0.50;                    // trailing leg stays behind
                p.LL_lower = 0.20;
                p.LA_upper = -0.30;
                p.RA_upper = 0.30;
            }

            // ── LIGHT AIR ─────────────────────────────────────────
            // Aerial 3-kick combo
        } else if (atkKey === 'light_air') {
            if (startup > 0) {
                p.RL_upper = -(startup * 0.50);         // kick leg coils back
            } else {
                if (active < 0.38) {
                    const t1 = active / 0.38;
                    p.RL_upper = t1 * 1.20;             // kick 1 forward
                    p.RL_lower = t1 * 0.80;
                } else if (active < 0.70) {
                    const t2 = (active - 0.38) / 0.32;
                    p.LL_upper = t2 * 1.20;             // kick 2 (other leg) forward
                    p.LL_lower = t2 * 0.80;
                } else {
                    const t3 = (active - 0.70) / 0.30;
                    p.RL_upper = t3 * 1.40;            // kick 3 big finish
                    p.RL_lower = t3 * 1.00;
                    p.leanAngle = t3 * 0.18;
                }
                p.LA_upper = -0.40;
                p.RA_upper = 0.40;
            }

            // ── LIGHT AIR DOWN ────────────────────────────────────
            // Diagonal dive-kick: body leans HARD forward, leg extends forward-downward
        } else if (atkKey === 'light_air_down') {
            if (startup > 0) {
                p.RL_upper = -(startup * 0.75);        // kick leg coils back
                p.leanAngle = -(startup * 0.15);
            } else {
                // RL at total=1.40 → cos(1.40)≈0.17, sin(1.40)≈0.99 → foot almost horizontal-forward
                // Combined with strong body lean = foot goes FAR diagonally down-forward
                p.RL_upper = reach * 0.80;            // thigh swings forward
                p.RL_lower = reach * 0.60;            // shin continues → diagonal kick
                p.LL_upper = -(reach * 0.50);          // trailing leg
                p.RA_upper = -(reach * 0.70);          // both arms streamline back
                p.LA_upper = -(reach * 0.70);
                p.leanAngle = reach * 0.55;            // STRONG forward dive lean
            }

            // ── HEAVY NEUTRAL ─────────────────────────────────────
            // Big horizontal haymaker punch — strong wind-up, full swing
        } else if (atkKey === 'heavy_neutral') {
            if (startup > 0) {
                // Pull arm WAY back — telegraph the hit
                p.RA_upper = -(0.30 + startup * 0.85); // -0.30 → -1.15
                p.LA_upper = -0.25;
                p.leanAngle = -(startup * 0.28);         // lean back during wind-up
                p.RL_upper = 0.15;
                p.LL_upper = -0.15;
            } else {
                // Full haymaker arc: arm sweeps back-to-forward
                p.RA_upper = -1.15 + reach * 2.40;    // -1.15 → +1.25
                p.RA_lower = 0.10 + reach * 0.45;
                p.leanAngle = -0.28 + reach * 0.60;    // lean back → lean far forward
                p.LA_upper = -0.40;
                p.RL_upper = 0.15;
                p.LL_upper = -0.15;
            }

            // ── HEAVY FORWARD ─────────────────────────────────────
            // Dash + flying double-leg dropkick
        } else if (atkKey === 'heavy_forward') {
            if (startup > 0) {
                p.leanAngle = startup * 0.35;
                p.LL_upper = -(startup * 0.45);        // legs coil back
                p.RL_upper = -(startup * 0.45);
                p.LA_upper = -(startup * 0.50);
                p.RA_upper = startup * 0.50;
            } else {
                // Both legs kick FORWARD simultaneously (no dir cond.)
                p.LL_upper = reach * 1.20;
                p.RL_upper = reach * 1.40;
                p.LL_lower = reach * 0.50;
                p.RL_lower = reach * 0.60;
                p.leanAngle = 0.35;
                p.LA_upper = -(0.30 + reach * 0.35);
                p.RA_upper = -(0.30 + reach * 0.35);
                p.jumpOff = -(reach * 8);             // visual lift off ground
            }

            // ── HEAVY DOWN ────────────────────────────────────────
            // Deep squat → explosive hook-uppercut to the chin (no kick, pure punch)
        } else if (atkKey === 'heavy_down') {
            if (startup > 0) {
                p.crouchOff = startup * 22;            // VERY deep squat
                p.RA_upper = -(startup * 0.70);        // arm coils back, fist low
                p.RA_lower = startup * 0.40;          // elbow bent
                p.LA_upper = startup * 0.30;          // guard arm
                p.LL_upper = startup * 0.45;          // knees bend naturally
                p.RL_upper = -startup * 0.35;
                p.leanAngle = -(startup * 0.20);        // slight back lean = ready
            } else {
                // Spring up + RA hooks upward from below chin
                // At reach≈1: RA_upper=1.40, RA_lower=1.40 → total=2.80 → cos(2.80)≈-0.94 → fist UP
                p.crouchOff = 22 * (1 - reach);       // body snaps upright
                p.RA_upper = -0.70 + reach * 2.10;    // -0.70 → +1.40
                p.RA_lower = 0.40 + reach * 1.00;    // 0.40 → 1.40 → fist arcs up
                p.LA_upper = 0.30;                    // guard
                p.LL_upper = 0.25;
                p.RL_upper = -0.20;
                p.leanAngle = 0.15 + reach * 0.20;    // lean forward into hook
            }

            // ── HEAVY AIR ─────────────────────────────────────────
            // Explosive rising uppercut: deep wind-up → RA hooks from below to above head
        } else if (atkKey === 'heavy_air') {
            if (startup > 0) {
                // Wind-up: arm coils WAY back + down, body crouches before spring
                p.RA_upper = -(startup * 0.90);        // arm pulls backward
                p.RA_lower = startup * 0.40;          // elbow bends, fist low
                p.LA_upper = -0.30;                    // guard arm
                p.LL_upper = 0.55;                    // legs tuck
                p.RL_upper = -0.55;
                p.LL_lower = 0.50;
                p.RL_lower = 0.50;
                p.crouchOff = startup * 8;             // body sinks before spring
                p.leanAngle = -(startup * 0.25);        // lean back for wind-up
            } else {
                // Uppercut arc: fist goes from BELOW hip to ABOVE head
                // At reach≈1: RA_upper=1.20, RA_lower=2.00 → total=3.20 → cos(3.2)≈-1 → hand UP
                p.RA_upper = -0.90 + reach * 2.10;    // -0.90 → +1.20
                p.RA_lower = 0.40 + reach * 1.60;    // 0.40 → 2.00
                p.LA_upper = -0.70;                    // left arm trails back
                p.LL_upper = 0.40;
                p.RL_upper = -0.40;
                p.crouchOff = 8 * (1 - reach);        // body snaps upright then rises
                p.leanAngle = -0.25 + reach * 0.60;    // back → forward
                p.jumpOff = -(reach * 12);           // body at peak during hit
            }

            // ── HEAVY AIR DOWN ────────────────────────────────────
            // Straight power-stomp: legs fully extended, pointing directly downward
        } else if (atkKey === 'heavy_air_down') {
            if (startup > 0) {
                // Tuck legs up hard
                p.LL_upper = -(startup * 0.70);        // legs kick back/up
                p.RL_upper = -(startup * 0.70);
                p.LL_lower = startup * 0.65;          // knees sharply bent
                p.RL_lower = startup * 0.65;
                p.leanAngle = -(startup * 0.15);
            } else {
                // Extend: upper angles to ~0.12 (near vertical), lower to 0 (STRAIGHT)
                p.LL_upper = -0.70 + reach * 0.82;    // -0.70 → +0.12 (nearly vertical)
                p.RL_upper = -0.70 + reach * 0.82;
                p.LL_lower = 0.65 - reach * 0.65;    // 0.65 → 0.00  (fully straight)
                p.RL_lower = 0.65 - reach * 0.65;
                // Arms spread back like a diver for balance
                p.RA_upper = -(0.40 + reach * 0.45);
                p.LA_upper = -(0.40 + reach * 0.45);
                p.leanAngle = -(reach * 0.20);
            }

            // ── ULTIMATE ──────────────────────────────────────────
            // Epic charge → double-arm overhead slam
        } else if (atkKey === 'ultimate') {
            if (startup > 0) {
                const s = startup;
                // Arms spread overhead like a berserker charge
                p.LA_upper = -(1.20 + s * 0.55);
                p.RA_upper = 1.20 + s * 0.55;
                p.LA_lower = -(s * 0.60);
                p.RA_lower = -(s * 0.60);
                p.LL_upper = s * 0.40;
                p.RL_upper = -(s * 0.40);
                p.leanAngle = 0;
            } else {
                // Both arms sweep from behind → forward (double clothesline slam)
                p.RA_upper = -(1.00 - reach * 2.00);  // -1.00 → +1.00
                p.LA_upper = -(1.00 - reach * 2.00);  // both arms forward
                p.RA_lower = reach * 0.35;
                p.LA_lower = reach * 0.35;
                p.leanAngle = reach * 0.38;             // body commits forward
                p.LL_upper = 0.20;
                p.RL_upper = -0.20;
            }

            // ── ULTIMATE FIRE ─────────────────────────────────────
            // Rocket punch: body angles 45° forward, arm becomes a battering ram
        } else if (atkKey === 'ultimate_fire') {
            if (startup > 0) {
                p.leanAngle = -(startup * 0.38);        // lean BACK in wind-up
                p.RA_upper = -(startup * 1.00);        // fist coils behind
                p.LA_upper = startup * 0.35;
                p.RL_upper = startup * 0.25;
                p.LL_upper = -startup * 0.20;
            } else {
                p.leanAngle = reach * 0.55;            // lean hard forward
                p.RA_upper = -1.00 + reach * 2.10;    // -1.00 → +1.10 full extension
                p.RA_lower = reach * 0.30;
                p.LA_upper = -0.60;
                p.RL_upper = 0.30;
                p.LL_upper = -0.30;
                p.jumpOff = -(reach * 6);
            }

            // ── ULTIMATE THUNDER ──────────────────────────────────
            // Leap + overhead two-fist earth-slam
        } else if (atkKey === 'ultimate_thunder') {
            if (startup > 0) {
                // Both arms rise overhead, body lifts
                p.LA_upper = -(1.10 + startup * 0.60);
                p.RA_upper = 1.10 + startup * 0.60;
                p.LA_lower = -(startup * 0.50);
                p.RA_lower = -(startup * 0.50);
                p.LL_upper = startup * 0.55;
                p.RL_upper = -startup * 0.55;
                p.LL_lower = startup * 0.45;
                p.RL_lower = startup * 0.45;
                p.jumpOff = -(startup * 16);
                p.leanAngle = startup * 0.10;
            } else {
                // Both fists crash DOWN together
                p.LA_upper = -1.70 + reach * 1.80;    // both arms slam forward-down
                p.RA_upper = 1.70 - reach * 1.80;
                p.LA_lower = reach * 0.30;
                p.RA_lower = reach * 0.30;
                p.leanAngle = reach * 0.40;
                p.crouchOff = reach * 12;
                p.LL_upper = 0.30;
                p.RL_upper = -0.30;
                p.jumpOff = -16 * (1 - reach);
            }

            // ── ULTIMATE VOID ─────────────────────────────────────
            // Wide radial blast: gather energy → thrust both arms outward
        } else if (atkKey === 'ultimate_void') {
            if (startup > 0) {
                const s = startup;
                p.LA_upper = -(1.30 + s * 0.45);
                p.RA_upper = 1.30 + s * 0.45;
                p.LA_lower = -(s * 0.45);
                p.RA_lower = -(s * 0.45);
                p.LL_upper = s * 0.35;
                p.RL_upper = -(s * 0.35);
                p.leanAngle = -(s * 0.08);
            } else {
                p.LA_upper = -(1.75 - reach * 0.85);
                p.RA_upper = 1.75 - reach * 0.85;
                p.LA_lower = -(0.45 + reach * 0.35);
                p.RA_lower = 0.45 + reach * 0.35;
                p.leanAngle = reach * 0.15;
                p.LL_upper = 0.35;
                p.RL_upper = -0.35;
            }

            // ── ULTIMATE BERSERK ──────────────────────────────────
            // Rapid 5-hit flurry: alternating jabs → final big uppercut
        } else if (atkKey === 'ultimate_berserk') {
            if (startup > 0) {
                p.RA_upper = -(startup * 0.50);
                p.LA_upper = -0.20;
                p.leanAngle = startup * 0.10;
            } else {
                const phase = Math.min(4, Math.floor(active * 5));  // 0..4
                const tp = (active * 5) - phase;                 // 0..1 within phase
                if (phase < 4) {
                    // Alternating rapid jabs
                    const isRA = (phase % 2 === 0);
                    const ext = Math.sin(tp * Math.PI);            // 0→1→0
                    if (isRA) {
                        p.RA_upper = -0.50 + ext * 1.50;
                        p.RA_lower = ext * 0.25;
                        p.LA_upper = -0.25;
                    } else {
                        p.LA_upper = 0.15 + ext * 1.10;
                        p.LA_lower = ext * 0.25;
                        p.RA_upper = 0.35;
                    }
                    p.leanAngle = (isRA ? 1 : -1) * ext * 0.14;
                } else {
                    // Final uppercut
                    p.RA_upper = -0.90 + tp * 2.10;
                    p.RA_lower = 0.40 + tp * 1.60;
                    p.LA_upper = -0.70;
                    p.leanAngle = -0.25 + tp * 0.60;
                    p.jumpOff = -(tp * 10);
                }
            }
        }

        set(p);
    }

    _pulseInt(color, tick) {
        return Math.sin(tick * 15) > 0 ? color : 0xffffff;
    }
}

window.Stickman = Stickman;
