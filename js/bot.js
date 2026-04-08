'use strict';
/* =========================================================
   BOT - Brawlhalla-style AI controller
   Difficulty-aware behavior with recovery, wall play, and ultimates.
   ========================================================= */

class Bot {
    /**
     * @param {Fighter} fighter
     * @param {number}  difficulty  0-1
     * @param {{scene?: Phaser.Scene, level?: string}} opts
     */
    constructor(fighter, difficulty = 0.5, opts = {}) {
        this.fighter = fighter;
        this.scene = opts.scene || fighter._scene || null;
        this.difficulty = Math.max(0, Math.min(1, difficulty));
        this.level = this._normalizeLevel(opts.level) || this._inferLevelFromDifficulty();
        this._profile = this._buildProfile();

        this._thinkTimer = 0;
        this._action = null;
        this._inputBuffer = fighter._emptyInput();
        this._oppRead = null;
        this._lastOppSample = null;
        this._habit = {
            airborneRate: 0,
            dodgeRate: 0,
            attackRate: 0,
        };

        // Internal anti-spam cooldowns
        this._dodgeCooldown = 0;
        this._ultimateSwapCooldown = 0;
    }

    setDifficulty(d, level = null) {
        this.difficulty = Math.max(0, Math.min(1, d));
        if (level) this.level = this._normalizeLevel(level) || this.level;
        this._profile = this._buildProfile();
    }

    /** Call each frame before fighter.update() */
    update(dt, opponents) {
        const f = this.fighter;
        const opp = this._pickTarget(opponents);
        if (!opp) return;

        if (f.state === 'dead' || f._respawning) {
            f.setInput(f._emptyInput());
            return;
        }

        if (this._dodgeCooldown > 0) this._dodgeCooldown -= dt;
        if (this._ultimateSwapCooldown > 0) this._ultimateSwapCooldown -= dt;
        this._oppRead = this._buildOpponentRead(opp);
        this._updateHabitModel(opp);

        // Emergency recoveries run every frame and can override normal plans.
        if (this._handleEmergencyRecovery(opp)) return;

        this._thinkTimer -= dt;
        if (this._thinkTimer <= 0) {
            this._decide(opp);
            this._thinkTimer = this._nextThinkDelay();
        }

        this._applyAction(opp);
    }

    // ----------------------------------------------------------
    // Decision making
    // ----------------------------------------------------------
    _decide(opp) {
        const f = this.fighter;
        const read = this._oppRead || { predX: opp.x, predY: opp.y };
        const dx = read.predX - f.x;
        const dy = read.predY - f.y;
        const dist = Math.abs(dx);
        const p = this._profile;
        const desiredFacing = Math.sign(dx) || f.facing || 1;

        // Hard AI can actively edgeguard when opponent is drifting near blast zones.
        if (this.level === 'hard' && read.nearBlast && !this._isSelfInEdgeDanger()) {
            this._action = { type: 'edgeguard', facing: desiredFacing };
            return;
        }

        // Medium/Hard recenters when itself is in danger near edge and no immediate punish.
        if (this.level !== 'easy' && this._isSelfInEdgeDanger() && dist > p.closeRange * 1.2) {
            this._action = { type: 'recenter' };
            return;
        }

        // Skill box plan (collect better ultimate, or swap if worthwhile).
        const skillPlan = this._planUltimateUpgrade();
        if (skillPlan) {
            this._action = {
                type: 'seekSkill',
                box: skillPlan.box,
                forceDrop: skillPlan.forceDrop,
                facing: desiredFacing,
            };
            return;
        }

        if (this._shouldUseUltimate(opp, dist, dy)) {
            this._action = { type: 'ultimate', facing: desiredFacing };
            return;
        }

        const finisher = this._pickFinisherAction(opp, dist, dy, desiredFacing);
        if (finisher) {
            this._action = finisher;
            return;
        }

        // Lower levels idle more often.
        if (Math.random() > p.engageChance) {
            this._action = { type: 'idle' };
            return;
        }

        // Defensive dodge
        if (this._dodgeCooldown <= 0) {
            const oppAtking = opp.state === 'attack';
            const closeThreat = dist < p.closeRange * 1.35;
            if (oppAtking && closeThreat && Math.random() < p.dodgeChance) {
                const backDir = -desiredFacing;
                this._action = { type: 'dodge', facing: backDir };
                this._dodgeCooldown = p.dodgeCooldownMs;
                return;
            }
        }

        // Close-range attack logic
        if (dist < p.closeRange) {
            if (Math.random() < p.attackCommitChance) {
                this._action = this._chooseAttackAction(opp, dist, dy, desiredFacing);
                return;
            }

            // Create space when too close, especially on lower levels.
            if (dist < 50 && Math.random() < p.retreatChance) {
                this._action = { type: 'retreat', facing: desiredFacing };
                return;
            }
        }

        // Mid/long range approach
        if (dist > p.closeRange) {
            if (this.level !== 'easy' && this._habit.dodgeRate > p.baitAgainstDodgeThreshold && Math.random() < p.feintChance) {
                this._action = { type: 'feint', facing: desiredFacing };
                return;
            }

            if (
                this.level === 'hard' &&
                this._habit.airborneRate > p.antiAirCounterThreshold &&
                dist < p.closeRange * 1.9 &&
                Math.random() < p.antiAirPrepChance
            ) {
                this._action = { type: 'antiAirPrep', facing: desiredFacing };
                return;
            }

            const dashIn = dist > p.dashMinRange && Math.random() < p.dashChance;
            this._action = { type: dashIn ? 'dash' : 'approach', facing: desiredFacing };
            return;
        }

        // Air chase on stronger levels
        if (!f.onGround && Math.abs(dy) > 60 && Math.random() < p.airHuntChance) {
            this._action = { type: 'approach', facing: desiredFacing, jumpBias: dy < -40 };
            return;
        }

        this._action = { type: 'idle' };
    }

    _chooseAttackAction(opp, dist, dy, desiredFacing) {
        const f = this.fighter;
        const p = this._profile;
        const oppHigh = (opp.damage || 0) >= 95;
        const oppAir = !opp.onGround;

        if (!f.onGround && oppAir && dy < -20 && Math.random() < p.airPunishChance) {
            return { type: 'heavy', dir: 'up', facing: desiredFacing };
        }

        if (!f.onGround && dy > 45 && Math.random() < p.downSpikeChance) {
            return { type: 'heavy', dir: 'down', facing: desiredFacing };
        }

        if (dist < 70 && oppHigh && Math.random() < p.finishChance) {
            return { type: 'heavy', dir: oppAir ? 'up' : 'forward', facing: desiredFacing };
        }

        const r = Math.random();
        if (r < p.lightForwardBias) {
            return { type: 'light', dir: 'forward', facing: desiredFacing };
        }
        if (r < p.heavyForwardBias) {
            return { type: 'heavy', dir: 'forward', facing: desiredFacing };
        }
        if (r < p.upBias) {
            return { type: oppAir ? 'heavy' : 'light', dir: 'up', facing: desiredFacing };
        }
        if (r < p.downBias) {
            return { type: 'light', dir: 'down', facing: desiredFacing };
        }
        return { type: 'light', dir: 'neutral', facing: desiredFacing };
    }

    _pickFinisherAction(opp, dist, dy, desiredFacing) {
        const f = this.fighter;
        const p = this._profile;
        if (dist > p.closeRange * 1.2) return null;

        const highDamage = (opp.damage || 0) >= p.finishDamageThreshold;
        if (!highDamage) return null;

        const oppNearEdge = this._isOpponentNearBlastEdge(opp);
        const preferVertical = !f.onGround && dy > 35;

        if (preferVertical && Math.random() < p.finishAerialDownChance) {
            return { type: 'heavy', dir: 'down', facing: desiredFacing };
        }

        if (oppNearEdge && Math.random() < p.finishHeavyForwardChance) {
            return { type: 'heavy', dir: 'forward', facing: desiredFacing };
        }

        if (!opp.onGround && Math.random() < p.finishAntiAirChance) {
            return { type: 'heavy', dir: 'up', facing: desiredFacing };
        }

        return null;
    }

    _updateHabitModel(opp) {
        const alpha = this.level === 'hard' ? 0.09 : (this.level === 'medium' ? 0.07 : 0.05);
        const airborne = opp.onGround ? 0 : 1;
        const dodging = (opp.state === 'dodge' || (opp.dodgeTimer || 0) > 0) ? 1 : 0;
        const attacking = opp.state === 'attack' ? 1 : 0;

        this._habit.airborneRate += (airborne - this._habit.airborneRate) * alpha;
        this._habit.dodgeRate += (dodging - this._habit.dodgeRate) * alpha;
        this._habit.attackRate += (attacking - this._habit.attackRate) * alpha;
    }

    _shouldUseUltimate(opp, dist, dy) {
        const f = this.fighter;
        const p = this._profile;
        if (!f.collectedUltimate) return false;
        if ((f.energy || 0) < ((CONFIG.ENERGY && CONFIG.ENERGY.MAX) || 100)) return false;
        if ((f.ultimateCooldown || 0) > 0 || (f.atkCooldown || 0) > 0) return false;

        const oppVuln = opp.state === 'attack' || opp.state === 'hurt' || !opp.onGround;
        const oppHighDamage = (opp.damage || 0) >= p.ultimateDamageThreshold;
        const inRange = dist < p.ultimateRange && Math.abs(dy) < p.ultimateYWindow;
        if (!inRange) return false;

        let chance = p.ultimateUseChance;
        if (oppVuln) chance += 0.18;
        if (oppHighDamage) chance += 0.15;
        if (this._isOpponentNearBlastEdge(opp)) chance += 0.16;
        return Math.random() < Math.min(0.95, chance);
    }

    _planUltimateUpgrade() {
        const f = this.fighter;
        const p = this._profile;
        if (!this.scene || !Array.isArray(this.scene._skillBoxes) || !this.scene._skillBoxes.length) return null;

        const best = this._bestVisibleSkillBox();
        if (!best) return null;

        const heldScore = this._ultimateScore(f.collectedUltimate);
        const gain = best.score - heldScore;

        if (!f.collectedUltimate) {
            if (best.dist <= p.skillSeekRange) {
                return { box: best.box, forceDrop: false };
            }
            return null;
        }

        if (gain < p.swapMinGain) return null;

        const pickupR = (CONFIG.SKILL_DROP && CONFIG.SKILL_DROP.pickupRadius) || 60;
        const forceDrop = best.dist <= pickupR * 1.35 && this._ultimateSwapCooldown <= 0;
        return { box: best.box, forceDrop };
    }

    _bestVisibleSkillBox() {
        const f = this.fighter;
        let best = null;

        for (const box of this.scene._skillBoxes) {
            if (!box || !box.ultimateId) continue;
            const dx = box.x - f.x;
            const dy = box.y - (f.y - 40);
            const dist = Math.hypot(dx, dy);
            if (dist > this._profile.skillSeekRange) continue;

            const score = this._ultimateScore(box.ultimateId);
            const distancePenalty = dist * 0.22;
            const weighted = score - distancePenalty;
            if (!best || weighted > best.weighted) {
                best = { box, score, dist, weighted };
            }
        }

        return best;
    }

    _ultimateScore(id) {
        if (!id) return 0;
        const def = CONFIG.ULTIMATE_SKILLS && CONFIG.ULTIMATE_SKILLS[id];
        if (!def) return 0;

        const damage = Number.isFinite(def.damage) ? def.damage : 40;
        const force = Number.isFinite(def.forceStrength) ? def.forceStrength : 25;
        const cooldown = Number.isFinite(def.cooldown) ? def.cooldown : 0;
        const rarity = (CONFIG.SKILL_DROP && CONFIG.SKILL_DROP.rarity && CONFIG.SKILL_DROP.rarity[id]) || 0.12;
        const rarityBoost = rarity > 0 ? (1 / rarity) * 0.7 : 0;
        const cooldownPenalty = (cooldown / 1000) * 0.75;
        const weights = CONFIG.BOT_ULTIMATE_WEIGHTS || {};
        const weight = Number.isFinite(weights[id]) ? weights[id] : 1;

        let score = (damage * 1.55 + force * 1.1 + rarityBoost - cooldownPenalty) * weight;
        if (id === 'saitama') score += 1000;
        return score;
    }

    _dropHeldUltimate() {
        const f = this.fighter;
        if (!f.collectedUltimate || this._ultimateSwapCooldown > 0) return;

        const droppedId = f.discardUltimate();
        if (!droppedId) return;

        if (window.SkillDropSystem && SkillDropSystem.spawnBox) {
            SkillDropSystem.spawnBox(f.x + f.facing * 16, f.y - 30, droppedId);
        }
        this._ultimateSwapCooldown = 900;
    }

    // ----------------------------------------------------------
    // Build input and send to fighter
    // ----------------------------------------------------------
    _applyAction(opp) {
        const f = this.fighter;
        const action = this._action || { type: 'idle' };
        const dx = opp.x - f.x;

        const inp = this._emptyInp();

        switch (action.type) {
            case 'seekSkill': {
                const box = action.box;
                if (!box) break;
                const sdx = box.x - f.x;
                const sdy = box.y - (f.y - 20);
                if (sdx > 10) inp.right = true;
                else if (sdx < -10) inp.left = true;

                if (sdy < -65 && (f.onGround || this._canUseAirJump())) inp.up = true;
                if (action.forceDrop) this._dropHeldUltimate();
                break;
            }

            case 'approach':
                if (dx > 0) inp.right = true; else inp.left = true;
                if (action.jumpBias && (f.onGround || this._canUseAirJump())) inp.up = true;
                if (
                    this.level === 'hard' &&
                    (f.onGround || this._canUseAirJump()) &&
                    this._oppRead &&
                    this._oppRead.predY < f.y - 90 &&
                    Math.abs(this._oppRead.predX - f.x) < 230
                ) {
                    inp.up = true;
                }
                break;

            case 'retreat':
                if (dx > 0) inp.left = true; else inp.right = true;
                break;

            case 'dash':
                if (dx > 0) inp.right = true; else inp.left = true;
                inp.dodge = true;
                break;

            case 'feint':
                if (dx > 0) inp.left = true; else inp.right = true;
                if (f.onGround && Math.random() < 0.35) inp.dodge = true;
                break;

            case 'antiAirPrep':
                if (dx > 0) inp.right = true; else inp.left = true;
                if (f.onGround || this._canUseAirJump()) inp.up = true;
                if (!f.onGround && f.atkCooldown <= 0 && Math.random() < 0.62) {
                    inp.up = true;
                    inp.heavy = true;
                }
                break;

            case 'dodge':
                if (action.facing > 0) inp.right = true; else inp.left = true;
                inp.dodge = true;
                break;

            case 'ultimate':
                if (action.facing > 0) inp.right = true; else inp.left = true;
                if (f.atkCooldown <= 0) {
                    inp.light = true;
                    inp.heavy = true;
                }
                break;

            case 'edgeguard':
                if (dx > 0) inp.right = true; else inp.left = true;
                if (Math.abs(dx) < 105 && f.atkCooldown <= 0) {
                    const oppBelow = opp.y > f.y + 26;
                    if (oppBelow && !f.onGround) {
                        inp.down = true;
                        inp.heavy = true;
                    } else {
                        inp.heavy = true;
                    }
                }
                if (f.onGround && opp.y < f.y - 70 && Math.random() < 0.65) inp.up = true;
                break;

            case 'recenter': {
                const b = this._blastBounds();
                const center = (b.left + b.right) * 0.5;
                if (f.x < center - 20) inp.right = true;
                else if (f.x > center + 20) inp.left = true;
                if (f.onGround && Math.random() < 0.2) inp.up = true;
                break;
            }

            case 'light':
                if (action.facing > 0) inp.right = true; else inp.left = true;
                if (f.atkCooldown <= 0) {
                    if (action.dir === 'up') inp.up = true;
                    else if (action.dir === 'down') inp.down = true;
                    inp.light = true;
                }
                break;

            case 'heavy':
                if (action.facing > 0) inp.right = true; else inp.left = true;
                if (f.atkCooldown <= 0) {
                    if (action.dir === 'up') inp.up = true;
                    else if (action.dir === 'down') inp.down = true;
                    inp.heavy = true;
                }
                break;

            case 'idle':
            default:
                break;
        }

        this._applySafetyOverrides(inp, opp);

        this._inputBuffer = inp;
        f.setInput(inp);
    }

    _applySafetyOverrides(inp, opp) {
        const f = this.fighter;
        const b = this._blastBounds();
        const p = this._profile;

        if (f.x <= b.left + 130) inp.right = true;
        if (f.x >= b.right - 130) inp.left = true;

        // Pit awareness: do not run off a platform unless in a strong finishing window.
        const dir = inp.right ? 1 : (inp.left ? -1 : 0);
        if (f.onGround && dir !== 0) {
            const abyssAhead = this._isAbyssAhead(dir, p.edgeLookAhead);
            const inFinishWindow = Math.abs(opp.x - f.x) < 95 && (opp.damage || 0) > 120;
            if (abyssAhead && !(inFinishWindow && this.level === 'hard')) {
                if (dir > 0) {
                    inp.right = false;
                    inp.left = true;
                } else {
                    inp.left = false;
                    inp.right = true;
                }
                if (this.level === 'hard' && (f.onGround || this._canUseAirJump())) inp.up = true;
            }
        }

        // Wall intelligence: jump away with direction instead of getting stuck sliding forever.
        if (f.state === 'wallgrab') {
            const jumpAway = f.wallDir > 0 ? -1 : 1;
            if (jumpAway > 0) inp.right = true; else inp.left = true;
            if (this._shouldExitWall(opp)) inp.up = true;
        }
    }

    _handleEmergencyRecovery(opp) {
        const f = this.fighter;
        if (f.onGround) return false;

        const b = this._blastBounds();
        const p = this._profile;
        const dangerLine = b.bottom - p.recoveryDangerMargin;
        const fallingHard = f.vy > p.recoveryFallVy;
        if (f.y < dangerLine && !fallingHard && f.state !== 'wallgrab') return false;

        const inp = this._emptyInp();

        if (f.state === 'wallgrab' || f.onWall) {
            const away = f.wallDir > 0 ? -1 : 1;
            if (away > 0) inp.right = true; else inp.left = true;
            inp.up = true;
        } else {
            const target = this._bestRecoveryTarget();
            const tx = target ? target.x : (opp ? opp.x : ((b.left + b.right) * 0.5));

            if (tx > f.x + 10) inp.right = true;
            else if (tx < f.x - 10) inp.left = true;

            if (f.onWall || this._canUseAirJump()) inp.up = true;
            if (this.level !== 'easy' && this._dodgeCooldown <= 0 && !f.onGround) {
                inp.dodge = true;
                this._dodgeCooldown = p.dodgeCooldownMs;
            }
        }

        f.setInput(inp);
        this._inputBuffer = inp;
        return true;
    }

    _bestRecoveryTarget() {
        if (!this.scene || !this.scene._platforms || !Array.isArray(this.scene._platforms.platforms)) {
            return null;
        }

        const f = this.fighter;
        const b = this._blastBounds();
        let best = null;

        for (const plat of this.scene._platforms.platforms) {
            if (!plat) continue;
            if (plat.y > b.bottom - 20) continue;
            const cx = plat.x + plat.w * 0.5;
            const horizontal = Math.abs(cx - f.x);
            const vertical = Math.abs((plat.y - 20) - f.y);
            const score = horizontal + vertical * 0.35;
            if (!best || score < best.score) {
                best = { x: cx, y: plat.y, score };
            }
        }

        return best;
    }

    _isAbyssAhead(dir, lookAhead) {
        if (!this.scene || !this.scene._platforms || !Array.isArray(this.scene._platforms.platforms)) {
            return false;
        }

        const f = this.fighter;
        const probeX = f.x + dir * lookAhead;
        const probeY = f.y + 16;

        for (const plat of this.scene._platforms.platforms) {
            if (!plat) continue;
            const withinX = probeX >= plat.x + 8 && probeX <= (plat.x + plat.w - 8);
            if (!withinX) continue;
            if (plat.y >= probeY - 40 && plat.y <= probeY + 150) return false;
        }

        return true;
    }

    _shouldExitWall(opp) {
        const f = this.fighter;
        const p = this._profile;
        if (!opp) return true;
        if (f.y > opp.y + 20) return true;
        if (f.y > this._blastBounds().bottom - p.recoveryDangerMargin) return true;
        return Math.random() < p.wallJumpChance;
    }

    _isOpponentNearBlastEdge(opp) {
        const b = this._blastBounds();
        return (
            opp.x < b.left + 180 ||
            opp.x > b.right - 180 ||
            opp.y > b.bottom - 120 ||
            opp.y < b.top + 100
        );
    }

    _isSelfInEdgeDanger() {
        const f = this.fighter;
        const b = this._blastBounds();
        return (
            f.x < b.left + 220 ||
            f.x > b.right - 220 ||
            f.y > b.bottom - 190
        );
    }

    _buildOpponentRead(opp) {
        const now = performance.now();
        let vx = Number.isFinite(opp.vx) ? opp.vx : 0;
        let vy = Number.isFinite(opp.vy) ? opp.vy : 0;

        if (this._lastOppSample && this._lastOppSample.id === opp.id) {
            const dt = Math.max(1, now - this._lastOppSample.t);
            vx = (opp.x - this._lastOppSample.x) * (16.667 / dt);
            vy = (opp.y - this._lastOppSample.y) * (16.667 / dt);
        }

        this._lastOppSample = { id: opp.id, x: opp.x, y: opp.y, t: now };

        const horizonMs = this.level === 'hard' ? 210 : (this.level === 'medium' ? 130 : 70);
        const predX = opp.x + vx * (horizonMs / 16.667);
        const predY = opp.y + vy * (horizonMs / 16.667);

        return {
            vx,
            vy,
            predX,
            predY,
            nearBlast: this._isOpponentNearBlastEdge({ x: predX, y: predY }),
        };
    }

    _blastBounds() {
        if (this.scene && this.scene._blastBounds) return this.scene._blastBounds;
        return {
            left: CONFIG.BLAST_LEFT,
            right: CONFIG.BLAST_RIGHT,
            top: CONFIG.BLAST_TOP,
            bottom: CONFIG.BLAST_BOTTOM,
        };
    }

    _pickTarget(opponents) {
        if (!opponents || !opponents.length) return null;
        const f = this.fighter;

        let best = null;
        for (const opp of opponents) {
            if (!opp || opp.state === 'dead' || opp._respawning) continue;
            const d = Math.hypot(opp.x - f.x, (opp.y - f.y) * 0.65);
            if (!best || d < best.dist) best = { opp, dist: d };
        }
        return best ? best.opp : null;
    }

    _canUseAirJump() {
        const f = this.fighter;
        const max = Number.isFinite(f.maxAirJumps) ? f.maxAirJumps : 1;
        const used = Number.isFinite(f._airJumpsUsed) ? f._airJumpsUsed : 0;
        return !f.onGround && used < max;
    }

    _nextThinkDelay() {
        const base = CONFIG.BOT_REACT_MS || 400;
        const p = this._profile;
        const scaled = base * (1 - this.difficulty * p.reactScale);
        return Math.max(45, scaled + Math.random() * p.reactJitter);
    }

    _buildProfile() {
        const d = this.difficulty;

        if (this.level === 'easy') {
            return this._applyMapTuning({
                reactScale: 0.30,
                reactJitter: 220,
                engageChance: 0.45,
                closeRange: 105,
                attackCommitChance: 0.32 + d * 0.2,
                retreatChance: 0.50,
                dashChance: 0.08,
                dashMinRange: 260,
                dodgeChance: 0.06,
                dodgeCooldownMs: 1300,
                edgeLookAhead: 56,
                recoveryDangerMargin: 130,
                recoveryFallVy: 5.8,
                skillSeekRange: 220,
                swapMinGain: 320,
                ultimateUseChance: 0.28,
                ultimateRange: 150,
                ultimateYWindow: 120,
                ultimateDamageThreshold: 140,
                lightForwardBias: 0.52,
                heavyForwardBias: 0.70,
                upBias: 0.82,
                downBias: 0.92,
                airHuntChance: 0.05,
                airPunishChance: 0.18,
                downSpikeChance: 0.12,
                finishChance: 0.14,
                wallJumpChance: 0.35,
                finishDamageThreshold: 150,
                finishAerialDownChance: 0.20,
                finishHeavyForwardChance: 0.24,
                finishAntiAirChance: 0.18,
                feintChance: 0.06,
                baitAgainstDodgeThreshold: 0.58,
                antiAirCounterThreshold: 0.72,
                antiAirPrepChance: 0.08,
            });
        }

        if (this.level === 'hard') {
            return this._applyMapTuning({
                reactScale: 0.86,
                reactJitter: 60,
                engageChance: 0.94,
                closeRange: 128,
                attackCommitChance: 0.78 + d * 0.18,
                retreatChance: 0.15,
                dashChance: 0.42,
                dashMinRange: 160,
                dodgeChance: 0.26,
                dodgeCooldownMs: 850,
                edgeLookAhead: 118,
                recoveryDangerMargin: 250,
                recoveryFallVy: 3.5,
                skillSeekRange: 720,
                swapMinGain: 90,
                ultimateUseChance: 0.66,
                ultimateRange: 250,
                ultimateYWindow: 185,
                ultimateDamageThreshold: 80,
                lightForwardBias: 0.26,
                heavyForwardBias: 0.56,
                upBias: 0.78,
                downBias: 0.91,
                airHuntChance: 0.40,
                airPunishChance: 0.58,
                downSpikeChance: 0.50,
                finishChance: 0.68,
                wallJumpChance: 0.90,
                finishDamageThreshold: 90,
                finishAerialDownChance: 0.58,
                finishHeavyForwardChance: 0.72,
                finishAntiAirChance: 0.54,
                feintChance: 0.24,
                baitAgainstDodgeThreshold: 0.32,
                antiAirCounterThreshold: 0.42,
                antiAirPrepChance: 0.48,
            });
        }

        // medium
        return this._applyMapTuning({
            reactScale: 0.62,
            reactJitter: 120,
            engageChance: 0.75,
            closeRange: 115,
            attackCommitChance: 0.58 + d * 0.2,
            retreatChance: 0.28,
            dashChance: 0.24,
            dashMinRange: 200,
            dodgeChance: 0.14,
            dodgeCooldownMs: 1050,
            edgeLookAhead: 84,
            recoveryDangerMargin: 180,
            recoveryFallVy: 4.8,
            skillSeekRange: 420,
            swapMinGain: 180,
            ultimateUseChance: 0.48,
            ultimateRange: 200,
            ultimateYWindow: 155,
            ultimateDamageThreshold: 105,
            lightForwardBias: 0.36,
            heavyForwardBias: 0.62,
            upBias: 0.78,
            downBias: 0.90,
            airHuntChance: 0.20,
            airPunishChance: 0.35,
            downSpikeChance: 0.28,
            finishChance: 0.38,
            wallJumpChance: 0.62,
            finishDamageThreshold: 115,
            finishAerialDownChance: 0.34,
            finishHeavyForwardChance: 0.44,
            finishAntiAirChance: 0.30,
            feintChance: 0.12,
            baitAgainstDodgeThreshold: 0.45,
            antiAirCounterThreshold: 0.56,
            antiAirPrepChance: 0.26,
        });
    }

    _applyMapTuning(profile) {
        const mapKey = (this.scene && this.scene.mapKey) ? this.scene.mapKey : '';
        const tuning = (CONFIG.BOT_MAP_TUNING && CONFIG.BOT_MAP_TUNING[mapKey]) || null;
        if (!tuning) return profile;

        const next = Object.assign({}, profile);
        if (Number.isFinite(tuning.edgeLookAheadMult)) {
            next.edgeLookAhead = Math.round(next.edgeLookAhead * tuning.edgeLookAheadMult);
        }
        if (Number.isFinite(tuning.recoveryMarginMult)) {
            next.recoveryDangerMargin = Math.round(next.recoveryDangerMargin * tuning.recoveryMarginMult);
        }
        if (Number.isFinite(tuning.airHuntBonus)) {
            next.airHuntChance = Math.max(0.01, Math.min(0.98, next.airHuntChance + tuning.airHuntBonus));
        }
        if (Number.isFinite(tuning.aggressionBonus)) {
            next.engageChance = Math.max(0.2, Math.min(0.99, next.engageChance + tuning.aggressionBonus));
        }

        return next;
    }

    _inferLevelFromDifficulty() {
        if (this.difficulty <= 0.4) return 'easy';
        if (this.difficulty >= 0.82) return 'hard';
        return 'medium';
    }

    _normalizeLevel(level) {
        const v = (level || '').toLowerCase();
        if (v === 'easy' || v === 'medium' || v === 'hard') return v;
        return null;
    }

    _emptyInp() {
        return {
            left: false,
            right: false,
            up: false,
            down: false,
            light: false,
            heavy: false,
            dodge: false,
            drop: false,
        };
    }
}

window.Bot = Bot;
