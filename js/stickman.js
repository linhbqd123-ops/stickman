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
        this.color       = color;
        this.shadow      = shadow;
        this.flipX       = flipX;
        this.intColor    = _cssToInt(color);
        this.intShadow   = _cssToInt(shadow);
        this.shadowAlpha = _cssToAlpha(shadow) * 0.55;
    }

    // =========================================================
    //  draw — entry point called by Fighter.draw()
    //  g     : Phaser.GameObjects.Graphics
    //  state : Fighter instance (or afterimage snapshot)
    // =========================================================
    draw(g, state) {
        const C        = CONFIG;
        const cx       = state.x;
        const gy       = state.y;
        const dir      = state.facing;
        const st       = state.state;
        const atk      = state.attackType || '';
        const dead     = st === 'dead';
        const tick     = state.tick * 0.08;
        // dimAlpha: used by afterimage trail (0.0 – 1.0), defaults to 1.
        const dimAlpha = (state.dimAlpha !== undefined) ? state.dimAlpha : 1.0;

        // Flip: replicate ctx.translate(cx,0); ctx.scale(flip?-1:1, 1)
        const shouldFlip = (!this.flipX && dir < 0) || (this.flipX && dir > 0);
        const fs = shouldFlip ? -1 : 1;   // flip sign

        // wx(localX) → world screen X  (Y coordinates are already absolute)
        const wx = lx => cx + lx * fs;

        // ---- Choose stroke color ----
        const invin = state.invTimer > 0 && !dead;
        let strokeInt = dead    ? _cssToInt(C.DEAD_COLOR)
                      : st === 'hurt' ? 0xffffff
                      : invin   ? this._pulseInt(this.intColor, tick)
                      : this.intColor;

        // ---- Pose angles (identical logic to vanilla stickman.js) ----
        let jumpOff = 0, crouchOff = 0, leanAngle = 0;
        let LA_upper=0, LA_lower=0, RA_upper=0, RA_lower=0;
        let LL_upper=0, LL_lower=0, RL_upper=0, RL_lower=0;

        const walk = Math.sin(tick * 7);

        if (st === 'idle') {
            const b = Math.sin(tick * 2.2) * 1.5;
            crouchOff = b;
            LA_upper  = -0.15 + Math.sin(tick*2.2)*0.04;
            RA_upper  =  0.15 + Math.sin(tick*2.2+0.5)*0.04;
            LL_upper  =  0.05;
            RL_upper  = -0.05;
        } else if (st === 'walk') {
            leanAngle = dir * 0.12;
            LA_upper  = -walk * 0.55;
            RA_upper  =  walk * 0.55;
            LA_lower  = Math.max(0, -walk * 0.40);
            RA_lower  = Math.max(0,  walk * 0.40);
            LL_upper  =  walk * 0.70;
            RL_upper  = -walk * 0.70;
            LL_lower  = Math.max(0, -walk * 0.55);
            RL_lower  = Math.max(0,  walk * 0.55);
            crouchOff = Math.abs(walk) * 2;
        } else if (st === 'crouch') {
            crouchOff = 15;
            LA_upper  = -0.6;
            RA_upper  =  0.6;
            LL_upper  =  0.7;
            RL_upper  = -0.7;
            LL_lower  =  0.3;
            RL_lower  =  0.3;
            leanAngle = dir * 0.08;
        } else if (st === 'airborne' || st === 'jump') {
            jumpOff   = -6;
            leanAngle = dir * 0.10;
            LA_upper  = -0.9;
            RA_upper  =  0.9;
            LA_lower  =  0.4;
            RA_lower  =  0.4;
            LL_upper  =  0.55;
            RL_upper  = -0.55;
            LL_lower  =  0.65;
            RL_lower  =  0.65;
        } else if (st === 'dodge') {
            crouchOff =  10;
            LA_upper  = -0.5;
            RA_upper  =  0.5;
            LL_upper  =  0.5;
            RL_upper  = -0.5;
        } else if (st === 'dash') {
            leanAngle = dir * 0.35;
            LA_upper  = -1.0;
            RA_upper  =  1.0;
            LA_lower  =  0.3;
            RA_lower  =  0.3;
            LL_upper  =  dir * 0.8;
            RL_upper  = -dir * 0.5;
            LL_lower  =  0.5;
            RL_lower  =  0.4;
        } else if (st === 'attack') {
            this._attackPose(atk, state.atkProgress, dir,
                { LA_upper, LA_lower, RA_upper, RA_lower,
                  LL_upper, LL_lower, RL_upper, RL_lower, leanAngle,
                  crouchOff, jumpOff },
                p => {
                    LA_upper  = p.LA_upper;  LA_lower  = p.LA_lower;
                    RA_upper  = p.RA_upper;  RA_lower  = p.RA_lower;
                    LL_upper  = p.LL_upper;  LL_lower  = p.LL_lower;
                    RL_upper  = p.RL_upper;  RL_lower  = p.RL_lower;
                    leanAngle = p.leanAngle;
                    if (p.crouchOff !== undefined) crouchOff = p.crouchOff;
                    if (p.jumpOff   !== undefined) jumpOff   = p.jumpOff;
                });
        } else if (st === 'hurt') {
            LA_upper  = -0.9;
            RA_upper  =  0.9;
            LA_lower  =  0.4;
            RA_lower  =  0.4;
            leanAngle = -dir * 0.28;
        } else if (dead) {
            LA_upper  = -1.4;
            RA_upper  =  1.0;
            LA_lower  =  1.2;
            RA_lower  =  0.8;
            LL_upper  =  0.6;
            RL_upper  =  1.1;
            LL_lower  =  1.0;
            RL_lower  =  0.5;
            leanAngle = dir * 0.5;
            crouchOff = 6;
        }

        // ---- Skeleton measurements ----
        const H     = C.HEAD_R;
        const TL    = C.TORSO_LEN;
        const AU    = C.ARM_UPPER;
        const AL    = C.ARM_LOWER;
        const LU    = C.LEG_UPPER;
        const LL_ln = C.LEG_LOWER;
        const SW    = C.SHOULDER_W;
        const HW    = C.HIP_W;

        const feetY   = gy + jumpOff;
        const hipY    = feetY - (LU + LL_ln) + crouchOff;
        const shouldY = hipY  - TL;
        const headY   = shouldY - H - 4;
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
        g.moveTo(wx(0),          hipY);
        g.lineTo(wx(torsoTopX),  torsoTopY);
        g.strokePath();

        g.beginPath();
        g.moveTo(wx(torsoTopX),  torsoTopY);
        g.lineTo(cx,             headY + H);   // cx = wx(0) — center never flips
        g.strokePath();

        // ARMS
        this._drawArm(g, wx, torsoTopX, torsoTopY, -SW, AU, AL, LA_upper, LA_lower);
        this._drawArm(g, wx, torsoTopX, torsoTopY,  SW, AU, AL, RA_upper, RA_lower);

        // LEGS
        this._drawLeg(g, wx, 0, hipY, -HW, LU, LL_ln, LL_upper, LL_lower, feetY);
        this._drawLeg(g, wx, 0, hipY,  HW, LU, LL_ln, RL_upper, RL_lower, feetY);
    }

    _drawArm(g, wx, sx, sy, xOff, upperLen, lowerLen, angleU, angleL) {
        const ex1 = sx + xOff + Math.sin(angleU) * upperLen;
        const ey1 = sy + Math.cos(angleU) * upperLen;
        g.beginPath();
        g.moveTo(wx(sx + xOff), sy);
        g.lineTo(wx(ex1),       ey1);
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
        g.lineTo(wx(kx),        ky);
        g.strokePath();

        const fx = kx + Math.sin(angleU + angleL) * lowerLen;
        const fy = ky + Math.cos(angleU + angleL) * lowerLen;
        g.beginPath();
        g.moveTo(wx(kx), ky);
        g.lineTo(wx(fx), fy);
        g.strokePath();
    }

    // =========================================================
    //  _attackPose — identical logic to vanilla stickman.js
    // =========================================================
    _attackPose(atkKey, t, dir, pose, set) {
        const p   = Object.assign({}, pose);
        const atk = CONFIG.ATTACKS[atkKey];

        const ACTIVE_WIN = 80;
        const totalDur   = atk ? (atk.delay_start + ACTIVE_WIN + atk.delay_end) : 300;
        const startupEnd = atk ? (atk.delay_start / totalDur) : 0.25;
        const activeEnd  = startupEnd + (ACTIVE_WIN / totalDur);

        let startup = 0, active = 0, recovery = 0;
        if (t <= startupEnd) {
            startup = startupEnd > 0 ? t / startupEnd : 1;
        } else if (t <= activeEnd) {
            active = (t - startupEnd) / Math.max(0.001, activeEnd - startupEnd);
        } else {
            recovery = (t - activeEnd) / Math.max(0.001, 1 - activeEnd);
        }
        const reach = t <= startupEnd ? 0 : t <= activeEnd ? active : 1 - recovery;

        if (atkKey === 'light_neutral') {
            if (startup > 0) {
                p.RA_upper = -0.2 + startup * 0.3;
                p.LA_upper = -0.1;
            } else {
                if (active < 0.4) {
                    p.RA_upper  = -0.1 - reach * 1.0;
                    p.RA_lower  = reach * 0.15;
                    p.leanAngle = reach * 0.12;
                } else if (active < 0.7) {
                    const t2    = (active - 0.4) / 0.3;
                    p.LA_upper  = -0.1 - t2 * 1.0;
                    p.LA_lower  = t2 * 0.15;
                    p.leanAngle = -t2 * 0.10;
                } else {
                    const t3    = (active - 0.7) / 0.3;
                    p.RL_upper  = dir > 0 ? -t3 * 1.2 : t3 * 1.2;
                    p.RL_lower  = t3 * 0.9;
                    p.leanAngle = dir * t3 * 0.15;
                }
            }
        } else if (atkKey === 'light_forward') {
            if (startup > 0) {
                p.leanAngle = dir * startup * 0.20;
                p.LL_upper  = dir > 0 ? startup * 0.3 : -startup * 0.3;
            } else {
                p.RL_upper  = dir > 0 ? -reach * 1.3 : reach * 1.3;
                p.RL_lower  = reach * 0.95;
                p.leanAngle = dir * reach * 0.28;
                p.LA_upper  = -0.3;
                p.RA_upper  = 0.3;
            }
        } else if (atkKey === 'light_down') {
            if (startup > 0) {
                p.leanAngle = dir * startup * 0.4;
                p.LL_upper  = dir > 0 ? startup * 0.4 : -startup * 0.4;
            } else {
                p.leanAngle = dir * 0.55;
                p.RL_upper  = dir > 0 ? -reach * 1.5 : reach * 1.5;
                p.RL_lower  = reach * 0.4;
                p.LL_upper  = dir > 0 ?  0.6 : -0.6;
                p.LL_lower  = 0.3;
                p.LA_upper  = dir > 0 ? -0.5 : 0.5;
                p.RA_upper  = dir > 0 ?  0.5 : -0.5;
                p.leanAngle = dir * (0.45 + reach * 0.15);
            }
        } else if (atkKey === 'light_air') {
            if (startup > 0) {
                p.RL_upper = dir > 0 ? -startup * 0.5 : startup * 0.5;
            } else {
                if (active < 0.4) {
                    p.RL_upper = dir > 0 ? -reach * 1.2 : reach * 1.2;
                    p.RL_lower = reach * 0.8;
                } else if (active < 0.7) {
                    const t2   = (active - 0.4) / 0.3;
                    p.LL_upper = dir > 0 ? -t2 * 1.2 : t2 * 1.2;
                    p.LL_lower = t2 * 0.8;
                } else {
                    const t3    = (active - 0.7) / 0.3;
                    p.RL_upper  = dir > 0 ? -t3 * 1.4 : t3 * 1.4;
                    p.RL_lower  = t3 * 1.0;
                    p.leanAngle = dir * t3 * 0.18;
                }
                p.LA_upper = -0.4;
                p.RA_upper =  0.4;
            }
        } else if (atkKey === 'light_air_down') {
            if (startup > 0) {
                p.RL_upper  = dir > 0 ? -startup * 0.8 : startup * 0.8;
                p.leanAngle = -startup * 0.20;
            } else {
                p.RL_upper  = dir > 0 ? -reach * 1.1 : reach * 1.1;
                p.RL_lower  = -reach * 1.0;
                p.LL_upper  = 0.5;
                p.RA_upper  = dir > 0 ? -reach * 0.6 : reach * 0.6;
                p.LA_upper  = dir > 0 ?  reach * 0.6 : -reach * 0.6;
                p.leanAngle = -reach * 0.30;
            }
        } else if (atkKey === 'heavy_neutral') {
            if (startup > 0) {
                p.RA_upper  =  0.4 + startup * 0.5;
                p.LA_upper  = -0.2;
                p.leanAngle = -startup * 0.18;
            } else {
                p.RA_upper  = -0.2 - reach * 1.5;
                p.RA_lower  = reach * 0.4;
                p.LA_upper  =  0.5;
                p.leanAngle = reach * 0.28;
                p.LL_upper  =  0.18;
                p.RL_upper  = -0.18;
            }
        } else if (atkKey === 'heavy_forward') {
            if (startup > 0) {
                p.leanAngle = dir * startup * 0.35;
                p.LA_upper  = -startup * 0.6;
                p.RA_upper  =  startup * 0.6;
            } else {
                p.LL_upper  = dir > 0 ? -reach * 1.3 : reach * 1.3;
                p.RL_upper  = dir > 0 ? -reach * 1.3 : reach * 1.3;
                p.LL_lower  = reach * 0.5;
                p.RL_lower  = reach * 0.5;
                p.leanAngle = dir * reach * 0.30;
                p.LA_upper  = dir > 0 ? -reach * 0.7 : reach * 0.7;
                p.RA_upper  = dir > 0 ?  reach * 0.7 : -reach * 0.7;
            }
        } else if (atkKey === 'heavy_down') {
            if (startup > 0) {
                p.RL_upper  = -startup * 0.6;
                p.RL_lower  =  startup * 0.5;
                p.leanAngle = dir * startup * 0.12;
                p.LA_upper  = -startup * 0.4;
                p.RA_upper  =  startup * 0.4;
            } else {
                p.RL_upper  = dir > 0 ? -reach * 1.7 : reach * 1.7;
                p.RL_lower  = -reach * 0.8;
                p.LL_upper  =  0.35;
                p.LA_upper  = -0.5;
                p.RA_upper  =  0.5;
                p.leanAngle = dir * reach * 0.15;
            }
        } else if (atkKey === 'heavy_air') {
            if (startup > 0) {
                p.LA_upper = -0.8 - startup * 0.4;
                p.RA_upper =  0.8 + startup * 0.4;
                p.LL_upper =  0.6;
                p.RL_upper = -0.6;
                p.LL_lower =  0.5;
                p.RL_lower =  0.5;
            } else {
                p.LL_upper = dir > 0 ? -reach * 1.3 : reach * 1.3;
                p.RL_upper = dir > 0 ? -reach * 1.3 : reach * 1.3;
                p.LL_lower = reach * 1.4;
                p.RL_lower = reach * 1.4;
                p.leanAngle = 0.12;
                p.LA_upper  = -0.3;
                p.RA_upper  =  0.3;
            }
        } else if (atkKey === 'heavy_air_down') {
            if (startup > 0) {
                p.LL_upper  =  startup * 0.7;
                p.RL_upper  =  startup * 0.7;
                p.LL_lower  =  startup * 0.5;
                p.RL_lower  =  startup * 0.5;
                p.leanAngle = -startup * 0.15;
            } else {
                p.LL_upper  = 0.8;
                p.RL_upper  = 0.8;
                p.LL_lower  = reach * 1.6;
                p.RL_lower  = reach * 1.6;
                p.RA_upper  = dir > 0 ? -reach * 0.8 : reach * 0.8;
                p.LA_upper  = dir > 0 ?  reach * 0.8 : -reach * 0.8;
                p.leanAngle = -reach * 0.40;
            }
        } else if (atkKey === 'ultimate') {
            if (startup > 0) {
                const s     = startup;
                p.LA_upper  = -1.2 - s * 0.5;
                p.RA_upper  =  1.2 + s * 0.5;
                p.LA_lower  = -s * 0.6;
                p.RA_lower  = -s * 0.6;
                p.LL_upper  =  s * 0.4;
                p.RL_upper  = -s * 0.4;
                p.leanAngle = 0;
            } else {
                p.RA_upper  = -0.3 - reach * 1.5;
                p.LA_upper  = -0.3 - reach * 1.5;
                p.RA_lower  = reach * 0.3;
                p.LA_lower  = reach * 0.3;
                p.leanAngle = dir * reach * 0.30;
                p.LL_upper  =  0.2;
                p.RL_upper  = -0.2;
            }
        }

        set(p);
    }

    _pulseInt(color, tick) {
        return Math.sin(tick * 15) > 0 ? color : 0xffffff;
    }
}
