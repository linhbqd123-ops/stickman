'use strict';
/* =========================================================
   BOT — Brawlhalla-style AI controller
   Upgraded to use directional attacks, dodge, and dash.
   ========================================================= */

class Bot {
    /**
     * @param {Fighter} fighter
     * @param {number}  difficulty  0–1
     */
    constructor(fighter, difficulty = 0.5) {
        this.fighter    = fighter;
        this.difficulty = Math.max(0, Math.min(1, difficulty));

        this._thinkTimer  = 0;
        this._action      = null;
        this._inputBuffer = fighter._emptyInput();
        this._inputPrev   = fighter._emptyInput();

        // Dodge cooldown to avoid constant dodging
        this._dodgeCooldown = 0;
    }

    setDifficulty(d) {
        this.difficulty = Math.max(0, Math.min(1, d));
    }

    /** Call each frame before fighter.update() */
    update(dt, opponents) {
        const f   = this.fighter;
        const opp = opponents[0]; // primary target
        if (!opp) return;

        if (f.state === 'dead' || f._respawning) {
            f.setInput(f._emptyInput());
            return;
        }

        if (this._dodgeCooldown > 0) this._dodgeCooldown -= dt;

        this._thinkTimer -= dt;
        if (this._thinkTimer <= 0) {
            this._decide(opp);
            const baseReact    = CONFIG.BOT_REACT_MS;
            this._thinkTimer   = baseReact * (1 - this.difficulty * 0.75) + Math.random() * 100;
        }

        this._applyAction(dt, opp);
    }

    // ----------------------------------------------------------
    //  Decision making
    // ----------------------------------------------------------
    _decide(opp) {
        const f    = this.fighter;
        const C    = CONFIG;
        const dx   = opp.x - f.x;
        const dist = Math.abs(dx);
        const d    = this.difficulty;

        // Low difficulty: random idle
        if (Math.random() > 0.28 + d * 0.68) {
            this._action = { type: 'idle' };
            return;
        }

        const desiredFacing = Math.sign(dx) || 1;
        const closeRange    = 110;

        // ---- Defensive dodge ----
        if (d > 0.4 && this._dodgeCooldown <= 0) {
            const oppAtking = opp.state === 'attack';
            if (oppAtking && dist < closeRange * 1.3) {
                const dodgeChance = 0.05 + d * 0.12;
                if (Math.random() < dodgeChance) {
                    this._action      = { type: 'dodge', facing: -desiredFacing };
                    this._dodgeCooldown = 1200;
                    return;
                }
            }
        }

        // ---- At close range: attack ----
        if (dist < closeRange) {
            const oppVuln = (!opp.onGround || opp.state === 'hurt') ? 1.3 : 1.0;
            const atkRate = C.BOT_ATTACK_RATE * (1 + d * 3.5) * oppVuln;

            if (Math.random() < atkRate * 14) {
                // Choose attack type with direction preference
                const r = Math.random();
                let type, dir;
                if (r < 0.30 + d * 0.15) {
                    type = 'light'; dir = 'forward';
                } else if (r < 0.55 + d * 0.10) {
                    type = 'heavy'; dir = 'forward';
                } else if (r < 0.70) {
                    type = 'light'; dir = !opp.onGround ? 'up' : 'neutral';
                } else if (r < 0.85) {
                    type = 'heavy'; dir = !opp.onGround ? 'up' : 'neutral';
                } else {
                    type = 'light'; dir = 'down';
                }
                this._action = { type, dir, facing: desiredFacing };
                return;
            }

            // Space out if too close
            if (dist < 55 && Math.random() < 0.35 + d * 0.25) {
                this._action = { type: 'retreat', facing: desiredFacing };
                return;
            }
        }

        // ---- Approach / dash-in ----
        if (dist > closeRange) {
            const dashIn = d > 0.5 && dist > 200 && Math.random() < 0.25 + d * 0.20;
            this._action  = { type: dashIn ? 'dash' : 'approach', facing: desiredFacing };
            return;
        }

        this._action = { type: 'idle' };
    }

    // ----------------------------------------------------------
    //  Build input and send to fighter
    // ----------------------------------------------------------
    _applyAction(dt, opp) {
        const f      = this.fighter;
        const C      = CONFIG;
        const action = this._action || { type: 'idle' };
        const dx     = opp.x - f.x;
        const d      = this.difficulty;

        // Save previous input for rising-edge
        this._inputPrev   = Object.assign({}, this._inputBuffer);
        const inp         = this._emptyInp();

        switch (action.type) {
            case 'approach':
                if (dx > 0) inp.right = true; else inp.left = true;
                // Jump toward airborne opponents
                if (f.onGround && !opp.onGround && Math.random() < 0.01 + d * 0.02) inp.up = true;
                break;

            case 'retreat':
                if (dx > 0) inp.left = true; else inp.right = true;
                break;

            case 'dash':
                if (dx > 0) inp.right = true; else inp.left = true;
                inp.dodge = true;
                break;

            case 'dodge':
                if (action.facing > 0) inp.right = true; else inp.left = true;
                inp.dodge = true;
                break;

            case 'light':
                if (action.facing > 0) inp.right = true; else inp.left = true;
                if (f.atkCooldown <= 0) {
                    if (action.dir === 'up')       inp.up    = true;
                    else if (action.dir === 'down') inp.down  = true;
                    inp.light = true;
                }
                break;

            case 'heavy':
                if (action.facing > 0) inp.right = true; else inp.left = true;
                if (f.atkCooldown <= 0) {
                    if (action.dir === 'up')       inp.up    = true;
                    else if (action.dir === 'down') inp.down  = true;
                    inp.heavy = true;
                }
                break;

            case 'idle':
            default:
                break;
        }

        // Defensive: avoid walls
        if (f.x <= C.BLAST_LEFT  + 120) inp.right = true;
        if (f.x >= C.BLAST_RIGHT - 120) inp.left  = true;

        // Jump recovery if falling under platforms
        if (!f.onGround && f.vy > 5 && d > 0.3 && Math.random() < 0.01) {
            inp.up = true;
        }

        this._inputBuffer = inp;
        f.setInput(inp);
    }

    _emptyInp() {
        return { left:false, right:false, up:false, down:false,
                 light:false, heavy:false, dodge:false };
    }
}
