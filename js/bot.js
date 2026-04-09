'use strict';
/* =========================================================
   BOT — Smart AI controller v3
   Levels: easy | medium | hard | boss
   Key improvements:
   • Deep pit avoidance — distinguishes ground pits from floating platforms
   • Multi-probe abyss scanning with safe-landing check
   • Player input reading — detect incoming attacks and react
   • Counterattack priority system (counter → dodge → normal)
   • Emergency recovery — wall-cling aware, earlier trigger
   • Boss level: immune to bottom pit (teleport back), only dies top/side
   • Hard/boss: stat multipliers applied in fighter + more aggressive profile
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
        this._lastOppInput = null;   // last known opponent input snapshot
        this._habit = {
            airborneRate: 0,
            dodgeRate: 0,
            attackRate: 0,
            ultimateChargeRate: 0,
        };

        // Internal anti-spam cooldowns
        this._dodgeCooldown = 0;
        this._ultimateSwapCooldown = 0;
        this._counterCooldown = 0;   // after counter attempt, brief pause before next

        // State transition tracking for respawn reset
        this._wasRespawning = false;
        this._wasDead = false;
        this._wasOnGroundBot = true;
        this._recoveryHeavyUsed = false;   // track heavy_air usage for recovery
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
        if (!opp) {
            // No valid target (all opponents dead/respawning) — MUST clear input
            // to prevent fighter from continuing last action (e.g. running off edge)
            f.setInput(f._emptyInput());
            this._action = null;
            this._inputBuffer = null;
            return;
        }

        if (f.state === 'dead' || f._respawning) {
            this._wasDead = this._wasDead || f.state === 'dead';
            this._wasRespawning = this._wasRespawning || !!f._respawning;
            f.setInput(f._emptyInput());
            return;
        }

        // ── RESPAWN STATE RESET — clear stale bot state after coming back to life
        if (this._wasRespawning || this._wasDead) {
            this._wasRespawning = false;
            this._wasDead = false;
            this._thinkTimer = 0;           // force immediate decision
            this._action = null;            // clear stale action
            this._oppRead = null;           // stale from (-9999,-9999)
            this._lastOppSample = null;     // stale position data
            this._lastOppInput = null;
            this._counterCooldown = 0;
            this._dodgeCooldown = 0;
            this._recoveryHeavyUsed = false;
        }

        // Boss immunity: teleport to safety when touching map bottom
        if (this.level === 'boss') {
            this._handleBossInvulnerability(opp);
        }

        if (this._dodgeCooldown > 0) this._dodgeCooldown -= dt;
        if (this._ultimateSwapCooldown > 0) this._ultimateSwapCooldown -= dt;
        if (this._counterCooldown > 0) this._counterCooldown -= dt;

        this._oppRead = this._buildOpponentRead(opp);
        this._updateHabitModel(opp);

        // Emergency recoveries run every frame and can override normal plans.
        // Boss is pit-immune — skip recovery and stay on the offensive.
        if (this.level !== 'boss' && this._handleEmergencyRecovery(opp)) return;

        // Per-frame ultimate escape — must be faster than think timer
        if (this._reactiveUltimateEscape(opp)) return;

        // Per-frame reactive defense: dodge incoming attacks between think ticks
        if (this._reactiveDefense(opp)) return;

        this._thinkTimer -= dt;
        if (this._thinkTimer <= 0) {
            this._decide(opp);
            this._thinkTimer = this._nextThinkDelay();
        }

        this._applyAction(opp);

        // ── Force re-think in critical situations ───────────────────────
        if (this._action) {
            const oppDist = Math.abs(opp.x - f.x);
            // Roaming/idle near opponent → instant re-decide
            if ((this._action.type === 'idle' || this._action.type === 'roam') &&
                oppDist < this._profile.closeRange * 1.1) {
                this._thinkTimer = 0;
            }
            // Just landed → reassess immediately
            if (f.onGround && !this._wasOnGroundBot) {
                this._thinkTimer = Math.min(this._thinkTimer, 25);
            }
            // Near edge while approaching → reassess
            if ((this._action.type === 'approach' || this._action.type === 'dash') &&
                f.onGround && this._isOnSolidPlatform()) {
                const moveDir = this._action.facing || (f.vx > 0 ? 1 : -1);
                if (this._isAbyssAheadMultiProbe(moveDir, this._profile.edgeLookAhead * 0.7)) {
                    this._thinkTimer = 0;
                }
            }
        }
        this._wasOnGroundBot = f.onGround;
    }

    // ----------------------------------------------------------
    // Boss immunity — teleport to safe ground if fallen too deep
    // Only teleports from BOTTOM pit. Top/side blasts handled by _checkBlastZone
    // ----------------------------------------------------------
    _handleBossInvulnerability(opp) {
        const f = this.fighter;
        if (f.state === 'dead' || f._respawning) return;

        const b = this._blastBounds();

        // ONLY teleport if falling into BOTTOM pit (way below map)
        // Top/side: Let _checkBlastZone handle normally
        const teleportTriggerY = b.bottom - 180;

        // If above trigger, don't teleport - let normal physics continue
        if (f.y <= teleportTriggerY) return;

        // Below trigger = deep pit, teleport back
        const target = this._bestRecoveryTarget();
        if (!target) return;

        f.x = target.x;
        f.y = target.y - 30;
        f.vx = 0;
        f.vy = -4;
        f.onGround = false;
        f.state = 'airborne';
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

        // ── 0. REACT TO INCOMING ATTACK (counterattack > everything) ────────
        const counterAction = this._evaluateCounterOpportunity(opp, dist, dy, desiredFacing);
        if (counterAction) {
            this._action = counterAction;
            return;
        }

        // ── 0.5 DROP FROM VULNERABLE PLATFORM ──────────────────────────────
        // On a floating platform and opponent below? Drop down to avoid being a sitting duck.
        // Boss skips — it hunts in any position.
        if (this.level !== 'easy' && this.level !== 'boss' && f.onGround && !this._isOnSolidPlatform()) {
            const oppBelow = opp.y > f.y + 30 && Math.abs(opp.x - f.x) < 140;
            const oppThreatBelow = opp.state === 'attack' && oppBelow;
            if (oppThreatBelow || (oppBelow && dist < 90 && Math.random() < 0.35)) {
                this._action = { type: 'dropDown', facing: desiredFacing };
                return;
            }
        }

        // ── 1. ESCAPE IMMINENT ULTIMATE (think-tick fallback) ──────────────
        // Primary path is _reactiveUltimateEscape (per-frame). This is a backup.
        const ultThreat = this._detectUltimateThreat(opp, dist);
        if (ultThreat) {
            const escDir = dx > 0 ? -1 : 1;
            this._action = { type: 'escape', facing: escDir, canCounter: ultThreat.canCounter };
            return;
        }

        // ── 2. EDGE GUARD (hard/boss only) ─────────────────────────────────
        if ((this.level === 'hard' || this.level === 'boss') &&
            read.nearBlast && !this._isSelfInEdgeDanger()) {
            this._action = { type: 'edgeguard', facing: desiredFacing };
            return;
        }

        // ── 3. SELF RECENTER ────────────────────────────────────────────────
        if (this.level !== 'easy' && this._isSelfInEdgeDanger() && dist > p.closeRange * 1.2) {
            this._action = { type: 'recenter' };
            return;
        }

        // ── 4. ULTIMATE PICKUP ──────────────────────────────────────────────
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

        // ── 5. USE ULTIMATE ────────────────────────────────────────────────
        if (this._shouldUseUltimate(opp, dist, dy)) {
            this._action = { type: 'ultimate', facing: desiredFacing };
            return;
        }

        // ── 6. FINISHER ────────────────────────────────────────────────────
        const finisher = this._pickFinisherAction(opp, dist, dy, desiredFacing);
        if (finisher) {
            this._action = finisher;
            return;
        }

        // Lower levels disengage more often — but NEVER idle when opponent is right next to us.
        if (dist > p.closeRange * 0.85 && Math.random() > p.engageChance) {
            this._action = { type: 'roam', facing: desiredFacing };
            return;
        }

        // ── 7. DEFENSIVE DODGE ─────────────────────────────────────────────
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

        // ── 8. ATTACK ──────────────────────────────────────────────────────
        if (dist < p.closeRange) {
            if (Math.random() < p.attackCommitChance) {
                this._action = this._chooseAttackAction(opp, dist, dy, desiredFacing);
                return;
            }

            // Create space when too close
            if (dist < 50 && Math.random() < p.retreatChance) {
                this._action = { type: 'retreat', facing: desiredFacing };
                return;
            }
        }

        // ── 9. APPROACH / FEINT ────────────────────────────────────────────
        if (dist > p.closeRange) {
            if (this.level !== 'easy' &&
                this._habit.dodgeRate > p.baitAgainstDodgeThreshold &&
                Math.random() < p.feintChance) {
                this._action = { type: 'feint', facing: desiredFacing };
                return;
            }

            if ((this.level === 'hard' || this.level === 'boss') &&
                this._habit.airborneRate > p.antiAirCounterThreshold &&
                dist < p.closeRange * 1.9 &&
                Math.random() < p.antiAirPrepChance) {
                this._action = { type: 'antiAirPrep', facing: desiredFacing };
                return;
            }

            // Edge-aware approach: check if abyss is ahead before approaching
            if (f.onGround && this._isOnSolidPlatform()) {
                const edgeAhead = this._isAbyssAheadMultiProbe(desiredFacing, p.edgeLookAhead);
                if (edgeAhead) {
                    const gapDist = Math.abs(opp.x - f.x);
                    if (gapDist < 280 && (f.onGround || this._canUseAirJump())) {
                        // Gap is jumpable — approach with jump
                        this._action = { type: 'approach', facing: desiredFacing, jumpBias: true };
                    } else {
                        // Gap too wide — recenter away from edge instead of standing frozen
                        this._action = { type: 'recenter' };
                    }
                    return;
                }
            }

            let dashIn = dist > p.dashMinRange && Math.random() < p.dashChance;
            // Edge-aware: don't dash toward abyss
            if (dashIn && f.onGround && this._isOnSolidPlatform()) {
                const dashTravel = CONFIG.DASH_SPEED * (CONFIG.DASH_DURATION / 16.667);
                if (this._isAbyssAheadMultiProbe(desiredFacing, dashTravel + 30)) {
                    dashIn = false;
                }
            }
            this._action = { type: dashIn ? 'dash' : 'approach', facing: desiredFacing };
            return;
        }

        // Air chase
        if (!f.onGround && Math.abs(dy) > 60 && Math.random() < p.airHuntChance) {
            this._action = { type: 'approach', facing: desiredFacing, jumpBias: dy < -40 };
            return;
        }

        // Boss: always chase when airborne — use air jumps to close the gap
        if (this.level === 'boss' && !f.onGround) {
            this._action = { type: 'approach', facing: desiredFacing, jumpBias: dy < -50 };
            return;
        }

        // Prefer ground: if idling on a floating platform, drop down (boss skips — it can't die falling)
        if (f.onGround && !this._isOnSolidPlatform() && this.level !== 'easy' && this.level !== 'boss' && Math.random() < 0.25) {
            this._action = { type: 'dropDown', facing: desiredFacing };
            return;
        }

        this._action = { type: 'roam', facing: desiredFacing || f.facing || 1 };
    }

    // ----------------------------------------------------------
    // Counter-attack logic — read opponent input/state
    // ----------------------------------------------------------
    _evaluateCounterOpportunity(opp, dist, dy, desiredFacing) {
        if (this._counterCooldown > 0) return null;
        const f = this.fighter;
        const p = this._profile;

        // Must not be busy ourselves
        if (f.state === 'attack' || f.hurtTimer > 0 || f.invTimer > 120) return null;
        if (f.atkCooldown > 0) return null;

        const oppInput = opp.input || {};
        const oppPrevInput = this._lastOppInput || {};

        // Detect opponent attack startup (they just pressed light or heavy)
        const oppLightRising = oppInput.light && !oppPrevInput.light;
        const oppHeavyRising = oppInput.heavy && !oppPrevInput.heavy;
        const oppIsAttacking = opp.state === 'attack';

        // Detect if opponent may fire ultimate (full energy + pressing light+heavy)
        const oppEnergyFull = (opp.energy || 0) >= ((CONFIG.ENERGY && CONFIG.ENERGY.MAX) || 100);
        const oppUltimateTrigger = oppEnergyFull && oppInput.light && oppInput.heavy;

        this._lastOppInput = { ...oppInput };

        if (!oppIsAttacking && !oppLightRising && !oppHeavyRising) return null;

        // If ultimate is incoming → escape, not counter
        if (oppUltimateTrigger) return null;

        const inCounterRange = dist < p.closeRange * 1.4;
        if (!inCounterRange) return null;

        const counterChance = p.counterChance || 0;
        if (Math.random() >= counterChance) return null;

        this._counterCooldown = p.counterCooldownMs || 600;

        // Choose best counter based on opponent position
        const oppAir = !opp.onGround;
        const oppHigh = (opp.damage || 0) >= 80;

        if (oppAir && dy < -20) {
            // Opponent above — launch upward
            return { type: 'heavy', dir: 'up', facing: desiredFacing };
        }
        if (dy > 30 && opp.state === 'attack') {
            // Opponent below attacking upward — spike them down or dodge
            if (f.onGround && Math.random() < 0.5) {
                return { type: 'heavy', dir: 'down', facing: desiredFacing };
            }
            // Jump away from below-attack if on a platform
            if (!this._isOnSolidPlatform() && f.onGround) {
                return { type: 'dodge', facing: -desiredFacing };
            }
        }
        if (opp.state === 'attack' && dist < 90 && Math.random() < 0.55) {
            // Counter — heavy forward for damage
            this._dodgeCooldown = p.dodgeCooldownMs * 0.6;
            return { type: 'heavy', dir: oppHigh ? 'forward' : 'neutral', facing: desiredFacing };
        }
        if (dist < p.closeRange) {
            return { type: 'light', dir: 'forward', facing: desiredFacing };
        }
        return null;
    }

    // Detect if opponent is threatening an ultimate — returns info object or null
    _detectUltimateThreat(opp, dist) {
        const p = this._profile;
        if (!p.ultimateEscapeRange) return null;
        if (dist > p.ultimateEscapeRange) return null;

        const oppEnergyFull = (opp.energy || 0) >= ((CONFIG.ENERGY && CONFIG.ENERGY.MAX) || 100);
        const oppHasUltimate = !!opp.collectedUltimate;
        const oppChargingUlt = opp.state === 'attack' && (opp.attackType || '').includes('ultimate');
        const oppInput = opp.input || {};
        const oppPressUlt = oppInput.light && oppInput.heavy && oppEnergyFull && oppHasUltimate;

        // Actively firing ultimate
        if (oppChargingUlt) {
            return { urgent: true, canCounter: false };
        }
        // About to fire (detected from inputs)
        if (oppPressUlt && Math.random() < (p.ultimateEscapeChance || 0.8)) {
            // canCounter: we have time to punish if we dodge cleanly
            const canCounter = this.level !== 'easy' && Math.random() < p.counterChance;
            return { urgent: false, canCounter };
        }
        // Pre-emptive: energy nearly full + has ultimate + bot is medium+
        if (this.level !== 'easy' && oppEnergyFull && oppHasUltimate &&
            dist < p.ultimateEscapeRange * 0.65 &&
            Math.random() < (p.ultimateEscapeChance || 0) * 0.45) {
            return { urgent: false, canCounter: false };
        }
        return null;
    }

    // ----------------------------------------------------------
    // Per-frame ultimate escape — runs every frame, highest priority
    // ----------------------------------------------------------
    _reactiveUltimateEscape(opp) {
        const f = this.fighter;
        const p = this._profile;
        if (!p.ultimateEscapeRange) return false;
        if (f.state === 'dead' || f._respawning) return false;

        const dist = Math.abs(opp.x - f.x);
        const threat = this._detectUltimateThreat(opp, dist);
        if (!threat) return false;

        // Already escaping or dodging — let it ride
        if (f.state === 'dodge') return false;

        const dx = opp.x - f.x;
        const escFacing = dx > 0 ? -1 : 1;
        const inp = this._emptyInp();

        const canJump = f.onGround || this._canUseAirJump();
        const canDodge = this._dodgeCooldown <= 0;

        // Jump bias: levels easy=20%, medium=40%, hard=58%, boss=75%
        const jumpBias = this.level === 'boss' ? 0.75 :
            this.level === 'hard' ? 0.58 :
                this.level === 'medium' ? 0.40 : 0.20;

        if (canJump && Math.random() < jumpBias) {
            if (escFacing > 0) inp.right = true; else inp.left = true;
            inp.up = true;
            // After jumping out, immediately aerial counter-punish on hard/boss
            if (threat.canCounter && !f.onGround && f.atkCooldown <= 0 &&
                Math.random() < (this.level === 'boss' ? 0.68 : 0.48)) {
                inp.heavy = true;
            }
        } else if (canDodge) {
            if (escFacing > 0) inp.right = true; else inp.left = true;
            inp.dodge = true;
            this._dodgeCooldown = p.dodgeCooldownMs;
        } else {
            if (escFacing > 0) inp.right = true; else inp.left = true;
        }

        this._applySafetyOverrides(inp, opp);
        f.setInput(inp);
        this._inputBuffer = inp;
        return true;
    }

    // ----------------------------------------------------------
    // Per-frame reactive dodge — reacts to attacks between think ticks
    // ----------------------------------------------------------
    _reactiveDefense(opp) {
        const f = this.fighter;
        const p = this._profile;
        if (this.level === 'easy') return false;
        if (f.state === 'attack' || f.state === 'dodge' || f.state === 'hurt' ||
            f.state === 'wallgrab' || f.state === 'dead') return false;
        if (this._dodgeCooldown > 0) return false;

        const dist = Math.abs(opp.x - f.x);
        if (opp.state !== 'attack' || dist > p.closeRange * 1.6) return false;

        // Chance scales with level
        const chance = this.level === 'boss' ? 0.48 :
            this.level === 'hard' ? 0.32 : 0.16;
        if (Math.random() >= chance) return false;

        const inp = this._emptyInp();
        const away = opp.x > f.x ? -1 : 1;
        if (away > 0) inp.right = true; else inp.left = true;
        inp.dodge = true;
        this._dodgeCooldown = p.dodgeCooldownMs;

        this._applySafetyOverrides(inp, opp);
        f.setInput(inp);
        this._inputBuffer = inp;
        return true;
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
        if (r < p.lightForwardBias) return { type: 'light', dir: 'forward', facing: desiredFacing };
        if (r < p.heavyForwardBias) return { type: 'heavy', dir: 'forward', facing: desiredFacing };
        if (r < p.upBias) return { type: oppAir ? 'heavy' : 'light', dir: 'up', facing: desiredFacing };
        if (r < p.downBias) return { type: 'light', dir: 'down', facing: desiredFacing };
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
        const alpha = (this.level === 'hard' || this.level === 'boss') ? 0.11 :
            this.level === 'medium' ? 0.07 : 0.05;
        const airborne = opp.onGround ? 0 : 1;
        const dodging = (opp.state === 'dodge' || (opp.dodgeTimer || 0) > 0) ? 1 : 0;
        const attacking = opp.state === 'attack' ? 1 : 0;
        const chargeUlt = ((opp.energy || 0) >= 90) ? 1 : 0;

        this._habit.airborneRate += (airborne - this._habit.airborneRate) * alpha;
        this._habit.dodgeRate += (dodging - this._habit.dodgeRate) * alpha;
        this._habit.attackRate += (attacking - this._habit.attackRate) * alpha;
        this._habit.ultimateChargeRate += (chargeUlt - this._habit.ultimateChargeRate) * alpha;
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

        // Do not fire ultimate when bot itself is in edge danger (risks falling in)
        if (this._isSelfInEdgeDanger() && this.level !== 'boss') return false;

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
                if ((this.level === 'hard' || this.level === 'boss') &&
                    (f.onGround || this._canUseAirJump()) &&
                    this._oppRead && this._oppRead.predY < f.y - 90 &&
                    Math.abs(this._oppRead.predX - f.x) < 230) {
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

            case 'escape': {
                // Smart ultimate escape: prefer jump (+ counter-punish) over dodge
                const escFacing = action.facing;
                if (escFacing > 0) inp.right = true; else inp.left = true;
                const canJump = f.onGround || this._canUseAirJump();
                const canDodge = this._dodgeCooldown <= 0;
                if (canJump && Math.random() < (this.level === 'boss' ? 0.72 :
                    this.level === 'hard' ? 0.58 :
                        this.level === 'medium' ? 0.40 : 0.20)) {
                    // Jump escape (harder to punish with most ultimates)
                    inp.up = true;
                    // If we jumped into range, immediately counter-punish
                    if (action.canCounter && !f.onGround && f.atkCooldown <= 0 &&
                        Math.random() < (this.level === 'boss' ? 0.68 :
                            this.level === 'hard' ? 0.50 : 0.28)) {
                        inp.heavy = true;  // aerial heavy punish
                    }
                } else if (canDodge) {
                    inp.dodge = true;
                    this._dodgeCooldown = this._profile.dodgeCooldownMs;
                } else {
                    // Last resort — just run
                    if (escFacing > 0) inp.right = true; else inp.left = true;
                }
                break;
            }

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

            case 'roam': {
                // ── ACTIVE ROAMING — never stand still ──────────────────────
                // Priority: seek skill box > stay on safe ground > move toward center
                const roamTarget = this._computeRoamTarget(opp);

                if (roamTarget.x > f.x + 15) inp.right = true;
                else if (roamTarget.x < f.x - 15) inp.left = true;
                else {
                    // Already near target — jitter to stay mobile
                    if (Math.random() < 0.5) inp.right = true; else inp.left = true;
                }

                // Drop down if target is below and we're on a passthrough
                if (roamTarget.needsDrop && f.onGround) {
                    if (f.onPlatform && f.onPlatform.passThrough) {
                        f.droppingThrough = true;
                        f._dropTimer = 200;
                        f.vy = 2;
                        f.onGround = false;
                        f.crouchTimer = 0;
                        inp.down = true;
                    } else {
                        // Solid platform: disable edge safety so the bot walks off the cliff to drop down
                        this._intentWalkOffEdge = true;
                    }
                }

                // Occasional jumps to stay unpredictable and reach platforms
                if (f.onGround && Math.random() < 0.02 && !roamTarget.needsDrop) inp.up = true;
                // Jump to reach skill box above
                if (roamTarget.needsJump && f.onGround) inp.up = true;

                break;
            }

            case 'dropDown':
                // Directly drop through passthrough platforms (bypasses double-tap)
                if (f.onGround && f.onPlatform && f.onPlatform.passThrough) {
                    f.droppingThrough = true;
                    f._dropTimer = 200;
                    f.vy = 2;
                    f.onGround = false;
                    f.crouchTimer = 0;
                }
                if (dx > 0) inp.right = true; else inp.left = true;
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

        // Hard boundary push-back (blast zone margin)
        // Boss level: disable side boundary protection so it can be hit by side blasts
        if (this.level !== 'boss') {
            if (f.x <= b.left + 110) inp.right = true;
            if (f.x >= b.right - 110) inp.left = true;
        }

        const dir = inp.right ? 1 : (inp.left ? -1 : 0);
        const action = this._action || {};

        // ── Pit avoidance: ground-level scan ────────────────────────────────
        if (dir !== 0) {
            const onSolidGround = f.onGround && this._isOnSolidPlatform();
            if (onSolidGround) {
                const abyssAhead = this._isAbyssAheadMultiProbe(dir, p.edgeLookAhead);
                const inFinishWindow = Math.abs(opp.x - f.x) < 95 &&
                    (opp.damage || 0) > 120 &&
                    (this.level === 'hard' || this.level === 'boss');
                if (abyssAhead && !inFinishWindow) {
                    const isApproaching = action.type === 'approach' || action.type === 'dash';
                    // Only jump the gap if opponent has ground AND gap is jumpable
                    const plats = this._getPlatforms();
                    const oppHasLanding = opp.onGround ||
                        this._hasPlatformSupportAt(opp.x, opp.y + 100, plats);
                    const gapJumpable = Math.abs(opp.x - f.x) < 280;
                    if (isApproaching && oppHasLanding && gapJumpable &&
                        (f.onGround || this._canUseAirJump())) {
                        // Jump toward opponent's platform
                        inp.up = true;
                    } else {
                        // No safe landing ahead — stop at edge AND kill momentum
                        if (dir > 0) { inp.right = false; if (f.vx > 2) f.vx *= 0.2; }
                        else { inp.left = false; if (f.vx < -2) f.vx *= 0.2; }
                    }
                }
            } else if (f.onGround) {
                // On a floating platform: stop at dangerous edge (no reversal)
                // UNLESS the bot explicitly intends to walk off to reach a lower target.
                if (!this._intentWalkOffEdge) {
                    const dangerousEdge = this._isEdgeDangerousDrop(dir, p.edgeLookAhead * 0.75);
                    if (dangerousEdge) {
                        if (dir > 0) { inp.right = false; if (f.vx > 2) f.vx *= 0.3; }
                        else { inp.left = false; if (f.vx < -2) f.vx *= 0.3; }
                    }
                }
                this._intentWalkOffEdge = false; // Reset intent
            }
        }

        // ── Airborne: navigate toward nearest safe landing (not boss — it can't die) ──
        if (!f.onGround && this.level !== 'boss') {
            const noFloorBelow = this._isPitFallAtX(f.x);
            if (noFloorBelow) {
                const target = this._bestRecoveryTarget();
                const wall = this._findNearestWall();
                const recovTarget = target || (wall ? { x: wall.x } : null);
                if (recovTarget) {
                    // Override horizontal input to steer toward platform or wall
                    inp.left = false;
                    inp.right = false;
                    if (recovTarget.x > f.x + 12) inp.right = true;
                    else if (recovTarget.x < f.x - 12) inp.left = true;
                    // Pulse up input: alternate frames to create rising edges for multiple jumps
                    const lastUp = this._inputBuffer && this._inputBuffer.up;
                    if (f.vy > 0.3 && this._canUseAirJump() && !lastUp) inp.up = true;
                    // Use heavy_air for extra altitude when jumps exhausted
                    const lastHeavy = this._inputBuffer && this._inputBuffer.heavy;
                    if (!this._canUseAirJump() && !f._usedHeavyAir &&
                        f.vy > 1 && f.atkCooldown <= 0 && f.atkTimer <= 0 && !lastHeavy) {
                        inp.up = true;
                        inp.heavy = true;
                    }
                }
            }
        }

        // ── Wall intelligence ────────────────────────────────────────────────
        if (f.state === 'wallgrab') {
            // Clear any prior horizontal intent — wall logic takes full control
            inp.left = false;
            inp.right = false;
            if (this._shouldExitWall(opp)) {
                // Wall jump: press AWAY from wall + UP (pulse to create rising edge)
                const lastUpW = this._inputBuffer && this._inputBuffer.up;
                if (f.wallDir > 0) inp.left = true;
                else inp.right = true;
                if (!lastUpW) inp.up = true;
            }
            // else: press nothing → fighter maintains wallgrab (vx=0)
        }
    }

    _handleEmergencyRecovery(opp) {
        const f = this.fighter;
        if (f.onGround) {
            this._recoveryHeavyUsed = false;
            return false;
        }
        if (f.state === 'wallgrab') {
            this._recoveryHeavyUsed = false;
        }

        const b = this._blastBounds();
        const p = this._profile;

        // ── Trajectory prediction: where will we be in ~12 frames? ──────
        const lookFrames = 12;
        const predY = f.y + f.vy * lookFrames + 0.5 * CONFIG.GRAVITY * lookFrames * lookFrames;
        const predX = f.x + f.vx * lookFrames;

        // Trigger based on PREDICTED position, not just current
        const dangerLine = b.bottom - p.recoveryDangerMargin;
        const earlyLine = b.bottom - p.recoveryDangerMargin * 1.8;
        const fallingHard = f.vy > p.recoveryFallVy;
        const deepBelow = f.y > earlyLine;
        const predictedDeep = predY > dangerLine;

        // Lateral blast proximity
        const nearLeftBlast = f.x < b.left + 180 && f.vx < -1.5;
        const nearRightBlast = f.x > b.right - 180 && f.vx > 1.5;
        const predLeftBlast = predX < b.left + 120;
        const predRightBlast = predX > b.right - 120;

        // Over a pit and falling
        const noFloorBelow = this._isPitFallAtX(f.x);
        const fallingOverPit = noFloorBelow && f.vy > 1.5;

        const needsRecovery =
            (f.y > dangerLine && (fallingHard || f.state !== 'wallgrab')) ||
            deepBelow || predictedDeep ||
            nearLeftBlast || nearRightBlast ||
            predLeftBlast || predRightBlast ||
            (fallingOverPit && f.y > earlyLine * 0.85);

        if (!needsRecovery) return false;

        const inp = this._emptyInp();

        // ── Recovery resources ──────────────────────────────────────────
        const airJumpsLeft = Math.max(0, (f.maxAirJumps || 1) - (f._airJumpsUsed || 0));
        const canHeavyAir = !f._usedHeavyAir && !this._recoveryHeavyUsed &&
            f.atkCooldown <= 0 && f.atkTimer <= 0 && f.hurtTimer <= 0;
        const canDodge = this._dodgeCooldown <= 0 && f.dodgeCooldown <= 0;

        if (f.state === 'wallgrab' || f.onWall) {
            // Wall jump: press away + up (pulse for rising edge)
            const away = f.wallDir > 0 ? -1 : 1;
            if (away > 0) inp.right = true; else inp.left = true;
            const lastUpW = this._inputBuffer && this._inputBuffer.up;
            if (!lastUpW) inp.up = true;
        } else {
            // ── Find best recovery destination ──────────────────────────
            const target = this._bestRecoveryTarget();
            const wall = this._findNearestWall();
            const centerX = (b.left + b.right) * 0.5;

            // Prefer platform, then wall (for wall grab), then center
            let tx;
            if (target && target.score < 800) {
                tx = target.x;
            } else if (wall && wall.dist < 300) {
                tx = wall.x;
            } else {
                tx = opp ? opp.x : centerX;
            }

            // Horizontal DI — side blast takes priority
            if (nearLeftBlast || predLeftBlast) {
                inp.right = true;
            } else if (nearRightBlast || predRightBlast) {
                inp.left = true;
            } else {
                if (tx > f.x + 10) inp.right = true;
                else if (tx < f.x - 10) inp.left = true;
            }

            // ── Vertical recovery: jump > heavy_air > dodge ─────────────
            // MUST pulse up/heavy inputs (alternate frames) to create rising
            // edges — fighter uses _risingEdge('up') which only fires on
            // false→true transition. Without this, only 1 jump ever fires.
            const lastUp = this._inputBuffer && this._inputBuffer.up;
            const lastHeavy = this._inputBuffer && this._inputBuffer.heavy;

            if (airJumpsLeft > 0 && f.vy > 0 && !lastUp) {
                // Save last jump for combo with heavy_air unless desperate
                if (airJumpsLeft > 1 || !canHeavyAir || f.y > dangerLine) {
                    inp.up = true;
                }
            }

            // heavy_air (extraJumpVy: -12) as recovery boost
            if (canHeavyAir && f.vy > 0.5 && !lastHeavy) {
                const desperate = f.y > dangerLine || (airJumpsLeft === 0 && noFloorBelow);
                if (desperate) {
                    inp.up = true;
                    inp.heavy = true;
                    this._recoveryHeavyUsed = true;
                }
            }

            // Dodge for fast horizontal escape from side blasts
            if (this.level !== 'easy' && canDodge && !f.onWall &&
                (nearLeftBlast || nearRightBlast || predLeftBlast || predRightBlast || deepBelow)) {
                if (!inp.up) {
                    inp.dodge = true;
                    this._dodgeCooldown = p.dodgeCooldownMs;
                }
            }

            // Cancel dangerous lateral velocity
            if (nearLeftBlast && f.vx < 0) f.vx *= 0.5;
            if (nearRightBlast && f.vx > 0) f.vx *= 0.5;
        }

        f.setInput(inp);
        this._inputBuffer = inp;
        return true;
    }

    // ----------------------------------------------------------
    // Map analysis helpers — platform & pit detection
    // ----------------------------------------------------------

    /** True if the bot is currently standing on a solid (non-passthrough) platform */
    _isOnSolidPlatform() {
        const f = this.fighter;
        if (!f.onGround) return false;
        const plats = this._getPlatforms();
        const nearY = 20;
        for (const plat of plats) {
            if (plat.passThrough) continue;
            if (f.x >= plat.x - 4 && f.x <= plat.x + plat.w + 4 &&
                Math.abs(f.y - plat.y) <= nearY) return true;
        }
        return false;
    }

    /**
     * Multi-probe abyss scan to the front (dir=±1).
     * Returns true if there is no ground-level support ahead.
     */
    _isAbyssAheadMultiProbe(dir, lookAhead) {
        const plats = this._getPlatforms();
        if (!plats.length) return false;

        const f = this.fighter;
        const probeY = f.y;
        // Three probe points: 40%, 70%, 100% of lookAhead
        const probes = [lookAhead * 0.4, lookAhead * 0.7, lookAhead];

        for (const reach of probes) {
            const probeX = f.x + dir * reach;
            if (this._hasPlatformSupportAt(probeX, probeY, plats)) return false;
        }
        return true;
    }

    /** True if there is at least one platform supporting the given position */
    _hasPlatformSupportAt(probeX, probeY, plats) {
        for (const plat of plats) {
            if (!plat) continue;
            const withinX = probeX >= plat.x + 6 && probeX <= (plat.x + plat.w - 6);
            if (!withinX) continue;
            if (plat.y >= probeY - 50 && plat.y <= probeY + 200) return true;
        }
        return false;
    }

    /**
     * When on a FLOATING platform, check if walking off the edge in `dir`
     * would result in a dangerous drop with no platform below.
     */
    _isEdgeDangerousDrop(dir, lookAhead) {
        const plats = this._getPlatforms();
        const f = this.fighter;
        const b = this._blastBounds();

        const probeX = f.x + dir * lookAhead;
        const minSafeY = f.y + 30;
        for (const plat of plats) {
            if (!plat) continue;
            const withinX = probeX >= plat.x + 4 && probeX <= plat.x + plat.w - 4;
            if (!withinX) continue;
            if (plat.y > minSafeY && plat.y < b.bottom - 100) return false;
        }
        return true;
    }

    /**
     * Returns true if at horizontal position `x`, falling from the bot's
     * current height would land in the blast zone (no platform to catch it).
     */
    _isPitFallAtX(x) {
        const plats = this._getPlatforms();
        const f = this.fighter;
        const b = this._blastBounds();

        for (const plat of plats) {
            if (!plat) continue;
            if (x >= plat.x + 4 && x <= plat.x + plat.w - 4 &&
                plat.y > f.y && plat.y < b.bottom - 80) return false;
        }
        return true;
    }

    _bestRecoveryTarget() {
        const plats = this._getPlatforms();
        if (!plats.length) return null;

        const f = this.fighter;
        const b = this._blastBounds();
        let best = null;

        for (const plat of plats) {
            if (!plat) continue;
            if (plat.y > b.bottom - 20) continue;
            const cx = plat.x + plat.w * 0.5;
            const horizontal = Math.abs(cx - f.x);
            const vertical = Math.abs((plat.y - 20) - f.y);
            // Prefer solid (non-passthrough) ground platforms
            const solidBonus = plat.passThrough ? 0 : -120;
            const score = horizontal + vertical * 0.35 + solidBonus;
            if (!best || score < best.score) {
                best = { x: cx, y: plat.y, score };
            }
        }
        return best;
    }

    /** Find the nearest solid wall edge for wall-grab recovery */
    _findNearestWall() {
        const f = this.fighter;
        const plats = this._getPlatforms();
        let best = null;

        for (const plat of plats) {
            if (!plat || plat.passThrough) continue;
            // Only consider walls we could reach vertically
            if (f.y < plat.y - 80 || f.y > plat.y + (plat.h || 100) + 80) continue;

            const leftX = plat.x;
            const rightX = plat.x + plat.w;
            const dLeft = Math.abs(f.x - leftX);
            const dRight = Math.abs(f.x - rightX);

            if (dLeft < dRight) {
                if (!best || dLeft < best.dist) best = { x: leftX - 5, dist: dLeft };
            } else {
                if (!best || dRight < best.dist) best = { x: rightX + 5, dist: dRight };
            }
        }
        return best;
    }

    /**
     * Compute the best position to roam toward when the bot has no
     * specific combat action. Priorities:
     *  1. Nearby valuable skill box (ultimate pickup)
     *  2. Safe ground center (stay away from edges)
     *  3. Gentle oscillation to stay mobile
     */
    _computeRoamTarget(opp) {
        const f = this.fighter;
        const b = this._blastBounds();
        const plats = this._getPlatforms();

        // ── 1. Seek best nearby skill box ───────────────────────────────
        if (this.scene && Array.isArray(this.scene._skillBoxes)) {
            let bestBox = null;
            let bestScore = -Infinity;

            for (const box of this.scene._skillBoxes) {
                if (!box || !box.ultimateId) continue;
                const bx = box.x - f.x;
                const by = box.y - (f.y - 20);
                const dist = Math.hypot(bx, by);
                if (dist > this._profile.skillSeekRange * 1.5) continue;

                // Score: higher value ultimates + closer = better
                const ultScore = this._ultimateScore(box.ultimateId);
                const distPenalty = dist * 0.3;
                const score = ultScore - distPenalty;
                if (score > bestScore) {
                    bestScore = score;
                    bestBox = box;
                }
            }

            if (bestBox) {
                const needsJump = bestBox.y < f.y - 50;
                const needsDrop = bestBox.y > f.y + 50;
                return { x: bestBox.x, needsJump, needsDrop };
            }
        }

        // ── 2. Find safe ground center ──────────────────────────────────
        // Find the largest solid platform and aim for its center
        let bestPlat = null;
        for (const plat of plats) {
            if (!plat || plat.passThrough) continue;
            if (!bestPlat || plat.w > bestPlat.w) bestPlat = plat;
        }

        if (bestPlat) {
            const centerX = bestPlat.x + bestPlat.w * 0.5;
            const edgeMargin = Math.min(bestPlat.w * 0.3, 200);
            // Don't aim for exact center — add some variance to keep moving
            const variance = (Math.sin(performance.now() * 0.001) * edgeMargin * 0.6);
            const safeX = centerX + variance;

            // If we're far from safe ground, head straight there
            if (Math.abs(f.x - safeX) > 30 || Math.abs(bestPlat.y - f.y) > 20) {
                const needsJump = bestPlat.y < f.y - 15;
                const needsDrop = bestPlat.y > f.y + 15;
                return { x: safeX, needsJump, needsDrop };
            }
        }

        // ── 3. Fallback: oscillate around map center ────────────────────
        const mapCenter = (b.left + b.right) * 0.5;
        const roamX = mapCenter + Math.sin(performance.now() * 0.0015) * 200;
        return { x: roamX, needsJump: false, needsDrop: false };
    }

    /**
     * Score an ultimate ID so the bot prefers better ultimates.
     */
    _ultimateScore(id) {
        // One punch man — instant win, highest priority
        if (id === 'saitama' && this.level !== 'boss') return 2000;
        // Powerful directed attacks
        if (id === 'yasuo' || id === 'kamehameha') return 1000;
        // AoE / Meteor rain
        if (id === 'fpt') return 800;
        // Base / Unknown
        return 400;
    }

    /** Cached platform list from scene or CONFIG */
    _getPlatforms() {
        if (this.scene && this.scene._platforms &&
            Array.isArray(this.scene._platforms.platforms)) {
            return this.scene._platforms.platforms;
        }
        return (CONFIG.PLATFORMS || []);
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

        const levelMs = { boss: 240, hard: 210, medium: 130, easy: 70 };
        const horizonMs = levelMs[this.level] || 130;
        const predX = opp.x + vx * (horizonMs / 16.667);
        const predY = opp.y + vy * (horizonMs / 16.667);

        return {
            vx, vy, predX, predY,
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
        return Math.max(16, scaled + Math.random() * p.reactJitter);
    }

    _buildProfile() {
        if (this.level === 'easy') {
            return this._applyMapTuning({
                reactScale: 0.30,
                reactJitter: 170,
                engageChance: 0.42,
                closeRange: 100,
                attackCommitChance: 0.28,
                retreatChance: 0.52,
                dashChance: 0.07,
                dashMinRange: 270,
                dodgeChance: 0.06,
                dodgeCooldownMs: 1400,
                edgeLookAhead: 110,
                recoveryDangerMargin: 300,
                recoveryFallVy: 3.0,
                skillSeekRange: 210,
                swapMinGain: 340,
                ultimateUseChance: 0.26,
                ultimateRange: 140,
                ultimateYWindow: 115,
                ultimateDamageThreshold: 145,
                ultimateEscapeRange: 0,
                ultimateEscapeChance: 0,
                counterChance: 0.08,
                counterCooldownMs: 900,
                lightForwardBias: 0.52,
                heavyForwardBias: 0.70,
                upBias: 0.82,
                downBias: 0.92,
                airHuntChance: 0.04,
                airPunishChance: 0.15,
                downSpikeChance: 0.10,
                finishChance: 0.12,
                wallJumpChance: 0.28,
                finishDamageThreshold: 155,
                finishAerialDownChance: 0.18,
                finishHeavyForwardChance: 0.20,
                finishAntiAirChance: 0.14,
                feintChance: 0.04,
                baitAgainstDodgeThreshold: 0.60,
                antiAirCounterThreshold: 0.76,
                antiAirPrepChance: 0.06,
            });
        }

        if (this.level === 'hard') {
            return this._applyMapTuning({
                reactScale: 0.88,
                reactJitter: 28,
                engageChance: 0.96,
                closeRange: 132,
                attackCommitChance: 0.82,
                retreatChance: 0.12,
                dashChance: 0.46,
                dashMinRange: 150,
                dodgeChance: 0.30,
                dodgeCooldownMs: 800,
                edgeLookAhead: 190,
                recoveryDangerMargin: 480,
                recoveryFallVy: 1.2,
                skillSeekRange: 780,
                swapMinGain: 80,
                ultimateUseChance: 0.70,
                ultimateRange: 260,
                ultimateYWindow: 195,
                ultimateDamageThreshold: 75,
                ultimateEscapeRange: 290,
                ultimateEscapeChance: 0.78,
                counterChance: 0.60,
                counterCooldownMs: 480,
                lightForwardBias: 0.24,
                heavyForwardBias: 0.54,
                upBias: 0.76,
                downBias: 0.90,
                airHuntChance: 0.44,
                airPunishChance: 0.62,
                downSpikeChance: 0.54,
                finishChance: 0.72,
                wallJumpChance: 0.92,
                finishDamageThreshold: 85,
                finishAerialDownChance: 0.62,
                finishHeavyForwardChance: 0.76,
                finishAntiAirChance: 0.58,
                feintChance: 0.26,
                baitAgainstDodgeThreshold: 0.30,
                antiAirCounterThreshold: 0.38,
                antiAirPrepChance: 0.52,
            });
        }

        if (this.level === 'boss') {
            // Boss: near-perfect fighter — aggressive, near-zero mistakes,
            // heavily punishes every opening, always escapes danger.
            return this._applyMapTuning({
                reactScale: 0.96,
                reactJitter: 14,
                engageChance: 0.98,
                closeRange: 140,
                attackCommitChance: 0.90,
                retreatChance: 0.07,
                dashChance: 0.55,
                dashMinRange: 130,
                dodgeChance: 0.38,
                dodgeCooldownMs: 680,
                edgeLookAhead: 220,
                recoveryDangerMargin: 520,
                recoveryFallVy: 0.8,
                skillSeekRange: 900,
                swapMinGain: 60,
                ultimateUseChance: 0.80,
                ultimateRange: 300,
                ultimateYWindow: 220,
                ultimateDamageThreshold: 60,
                ultimateEscapeRange: 320,
                ultimateEscapeChance: 0.94,
                counterChance: 0.80,
                counterCooldownMs: 360,
                lightForwardBias: 0.20,
                heavyForwardBias: 0.50,
                upBias: 0.72,
                downBias: 0.88,
                airHuntChance: 0.54,
                airPunishChance: 0.74,
                downSpikeChance: 0.66,
                finishChance: 0.85,
                wallJumpChance: 0.97,
                finishDamageThreshold: 70,
                finishAerialDownChance: 0.72,
                finishHeavyForwardChance: 0.86,
                finishAntiAirChance: 0.70,
                feintChance: 0.34,
                baitAgainstDodgeThreshold: 0.24,
                antiAirCounterThreshold: 0.30,
                antiAirPrepChance: 0.64,
            });
        }

        // medium (default)
        return this._applyMapTuning({
            reactScale: 0.62,
            reactJitter: 75,
            engageChance: 0.76,
            closeRange: 116,
            attackCommitChance: 0.58,
            retreatChance: 0.28,
            dashChance: 0.24,
            dashMinRange: 200,
            dodgeChance: 0.14,
            dodgeCooldownMs: 1050,
            edgeLookAhead: 150,
            recoveryDangerMargin: 400,
            recoveryFallVy: 2.0,
            skillSeekRange: 430,
            swapMinGain: 175,
            ultimateUseChance: 0.48,
            ultimateRange: 205,
            ultimateYWindow: 160,
            ultimateDamageThreshold: 108,
            ultimateEscapeRange: 200,
            ultimateEscapeChance: 0.45,
            counterChance: 0.32,
            counterCooldownMs: 700,
            lightForwardBias: 0.36,
            heavyForwardBias: 0.62,
            upBias: 0.78,
            downBias: 0.90,
            airHuntChance: 0.20,
            airPunishChance: 0.36,
            downSpikeChance: 0.28,
            finishChance: 0.40,
            wallJumpChance: 0.64,
            finishDamageThreshold: 118,
            finishAerialDownChance: 0.34,
            finishHeavyForwardChance: 0.46,
            finishAntiAirChance: 0.32,
            feintChance: 0.12,
            baitAgainstDodgeThreshold: 0.44,
            antiAirCounterThreshold: 0.54,
            antiAirPrepChance: 0.28,
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
        if (this.difficulty <= 0.35) return 'easy';
        if (this.difficulty >= 0.82) return 'hard'; // boss is assigned externally via aiLevel
        return 'medium';
    }

    _normalizeLevel(level) {
        const v = (level || '').toLowerCase();
        if (v === 'easy' || v === 'medium' || v === 'hard' || v === 'boss') return v;
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
