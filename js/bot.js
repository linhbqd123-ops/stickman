'use strict';
/* =========================================================
   BOT — AI controller for CPU fighter
   Difficulty is a 0–1 float:
     0.0 = passive rookie
     0.5 = balanced brawler
     1.0 = near-perfect champion
   The Bot drives a Fighter via fighter.setInput() each frame.
   ========================================================= */

class Bot {
    /**
     * @param {Fighter} fighter   — the Fighter this Bot controls
     * @param {number}  difficulty — 0 to 1
     */
    constructor(fighter, difficulty = 0.5) {
        this.fighter = fighter;
        this.difficulty = Math.max(0, Math.min(1, difficulty));

        // Internal decision state
        this._thinkTimer = 0;    // ms until next decision recalculation
        this._action = null; // current planned action object
        this._jumpPressed = false;
    }

    setDifficulty(d) {
        this.difficulty = Math.max(0, Math.min(1, d));
    }

    /**
     * Call every frame before fighter.update().
     * @param {number}  dt       — delta time in ms
     * @param {Fighter} opponent — the human/other fighter
     */
    update(dt, opponent) {
        const f = this.fighter;
        const opp = opponent;
        const C = CONFIG;

        if (f.state === 'dead') {
            f.setInput({ left: false, right: false, jump: false, punch: false, kick: false });
            return;
        }

        this._thinkTimer -= dt;
        if (this._thinkTimer <= 0) {
            this._decide(opp);
            // How quickly the bot reacts: harder bots think faster
            const baseReact = C.BOT_REACT_MS;
            this._thinkTimer = baseReact * (1 - this.difficulty * 0.75) + Math.random() * 120;
        }

        this._applyAction(dt, opp);
    }

    // ----------------------------------------------------------
    //  Decision making
    // ----------------------------------------------------------
    _decide(opp) {
        const f = this.fighter;
        const C = CONFIG;
        const dx = opp.x - f.x;
        const dist = Math.abs(dx);
        const d = this.difficulty;

        // At low difficulty, random chance to do nothing
        if (Math.random() > 0.3 + d * 0.65) {
            this._action = { type: 'idle' };
            return;
        }

        // Face the opponent
        const desiredFacing = Math.sign(dx) || 1;

        const punchRange = C.PUNCH_RANGE * 0.88;
        const kickRange = C.KICK_RANGE * 0.88;
        const closeRange = (punchRange + kickRange) / 2;

        // ---- At close range: attack ----
        if (dist < closeRange) {
            // Determine opp vulnerability: mid-air, hurt = bonus
            const oppVuln = (opp.state === 'hurt' || !opp.onGround) ? 1.2 : 1.0;
            const atkRoll = Math.random();
            const atkRate = C.BOT_ATTACK_RATE * (1 + d * 3) * oppVuln;

            if (atkRoll < atkRate * 14) {
                // Vary attacks: harder bots use kick more
                const useKick = Math.random() < 0.35 + d * 0.25;
                this._action = { type: useKick ? 'kick' : 'punch', facing: desiredFacing };
                return;
            }

            // Back off a bit to reset if too close (spacing logic)
            if (dist < 50 && Math.random() < 0.4 + d * 0.3) {
                this._action = { type: 'retreat', facing: desiredFacing };
                return;
            }
        }

        // ---- Approach opponent ----
        if (dist > closeRange) {
            // Harder bots dash in aggressively, easier ones meander
            if (Math.random() < 0.5 + d * 0.45) {
                this._action = { type: 'approach', facing: desiredFacing };
            } else {
                this._action = { type: 'idle' };
            }
            return;
        }

        this._action = { type: 'idle' };
    }

    // ----------------------------------------------------------
    //  Apply chosen action as input
    // ----------------------------------------------------------
    _applyAction(dt, opp) {
        const f = this.fighter;
        const C = CONFIG;
        const action = this._action || { type: 'idle' };
        const dx = opp.x - f.x;
        const d = this.difficulty;

        let input = { left: false, right: false, jump: false, punch: false, kick: false };

        switch (action.type) {
            case 'approach': {
                // Move toward opponent
                if (dx > 0) input.right = true;
                else input.left = true;
                // Harder bots sometimes jump toward opponent
                if (f.onGround && Math.abs(dx) > 160 && Math.random() < 0.015 + d * 0.025) {
                    input.jump = true;
                }
                break;
            }

            case 'retreat': {
                // Move away
                if (dx > 0) input.left = true;
                else input.right = true;
                break;
            }

            case 'punch': {
                // Face and punch
                if (action.facing > 0) input.right = true;
                else input.left = true;
                if (f.atkCooldown <= 0) input.punch = true;
                break;
            }

            case 'kick': {
                if (action.facing > 0) input.right = true;
                else input.left = true;
                if (f.atkCooldown <= 0) input.kick = true;
                break;
            }

            case 'idle':
            default:
                break;
        }

        // ---- Defensive jump: dodge incoming attack ----
        if (d > 0.45 && opp.state === 'punch' && Math.abs(dx) < C.PUNCH_RANGE * 1.1) {
            if (f.onGround && Math.random() < 0.04 + d * 0.06) {
                input.jump = true;
            }
        }

        // ---- Don't walk off edges / walls ----
        if (f.x <= C.WALL_LEFT + 20) input.left = false;
        if (f.x >= C.WALL_RIGHT - 20) input.right = false;

        f.setInput(input);
    }
}
