'use strict';
/* =========================================================
   FIGHTER — Brawlhalla-style physics and combat (Phaser port)

   Changes from vanilla fighter.js:
   • Constructor accepts opts.scene — Phaser.Scene reference
   • setTimeout()   → this._scene.time.delayedCall()
   • setInterval()  → this._scene.time.addEvent({ repeat })
   • GameEffects.*  → window.GameEffects.* (set by GameScene)
   • draw(ctx)      → draw(g)  — Phaser.GameObjects.Graphics
   • InputManager   → input read externally by GameScene; same setInput() API
   ========================================================= */

class Fighter {
    constructor(opts) {
        const C = CONFIG;

        this._scene = opts.scene;     // Phaser.Scene (for timers)
        this.id = opts.id;
        this.isPlayer = opts.isPlayer !== false;
        this.keyMap = opts.keyMap || C.KEYS_P1;
        this.team = opts.team ?? opts.id - 1;

        // ---- Physics state ----
        this.x = opts.x ?? 400;
        this.y = opts.y ?? C.PLATFORMS[0].y;
        this.vx = 0;
        this.vy = 0;
        this.onGround = true;
        this.onPlatform = null;
        this.facing = opts.facingRight ? 1 : -1;
        this.width = 20;

        // Drop-through one-way platform
        this.droppingThrough = false;
        this._dropTimer = 0;

        // ---- Crouch state ----
        this.crouchTimer = 0;
        this._downTapCount = 0;
        this._lastDownTap = 0;

        // ---- Stock / damage ----
        this.stocks = opts.stocks ?? C.DEFAULT_STOCKS;
        this.damage = 0;

        // ---- Energy ----
        this.energy = 0;
        this.collectedSkill = null;   // key in CONFIG.SKILLS, e.g. 'fire'

        // ---- Combat state ----
        this.state = 'idle';
        this.attackType = null;
        this.atkTimer = 0;
        this.atkCooldown = 0;
        this.atkStartup = 0;
        this.atkProgress = 0;
        this.atkDuration = 0;
        this.hurtTimer = 0;
        this.invTimer = 0;
        this.dodgeTimer = 0;
        this.dodgeCooldown = 0;
        this.dashTimer = 0;
        this.dashMomentum = 0;
        this.dashMomentumDir = 0;
        this.dashCooldown = 0;   // anti-spam between dashes
        this.isCrouchAttack = false;
        this.lastAttackDir = 'neutral';
        this.comboHitCount = 0;
        this.inCombo = false;

        // ---- Respawn ----
        this._respawning = false;
        this._respawnTimer = 0;

        // ---- Combo tracking ----
        this._lastAttackTime = 0;
        this._comboCount = 0;

        // ---- Air state tracking ----
        this._airJumpUsed = false;   // double-jump token (reset on land)
        this._usedHeavyAir = false;   // heavy_air token (reset on land)
        this._wasOnGround = true;

        // ---- Wall grab state ----
        this.onWall = false;
        this.wallDir = 0;       // -1 (face left) or 1 (face right) toward wall
        this.wallPlatform = null;
        this._wallJumpCooldown = 0;   // ms before can grab wall again
        this._wallGrabTick = 0;       // ms spent in current wall-grab

        // Input snapshot
        this.input = this._emptyInput();
        this._prevInput = this._emptyInput();

        // ---- Rendering ----
        // Always pass flipX=false: facing direction is fully encoded in this.facing,
        // which _risingEdge / shouldFlip in Stickman.draw() already reads correctly.
        // Passing !facingRight used to invert slot-1's render, making it face the wrong way.
        this.renderer = new Stickman(opts.color, opts.shadow, false);
        this.color = opts.color;
        this.shadow = opts.shadow;
        this.tick = 0;
    }

    _emptyInput() {
        return {
            left: false, right: false, up: false, down: false,
            light: false, heavy: false, dodge: false
        };
    }

    setInput(inp) {
        this._prevInput = this.input;
        this.input = inp;
    }

    // =========================================================
    //  UPDATE (called each frame by GameScene)
    // =========================================================
    update(dt, opponents, platforms, particles) {
        const C = CONFIG;
        this.tick += dt / 16.667;

        if (this.atkTimer > 0) this.atkTimer -= dt;
        if (this.atkCooldown > 0) this.atkCooldown -= dt;
        if (this.atkStartup > 0) this.atkStartup -= dt;
        if (this.hurtTimer > 0) this.hurtTimer -= dt;
        if (this.invTimer > 0) this.invTimer -= dt;
        if (this.dodgeTimer > 0) this.dodgeTimer -= dt;
        if (this.dodgeCooldown > 0) this.dodgeCooldown -= dt;
        if (this.dashTimer > 0) this.dashTimer -= dt;
        if (this.dashMomentum > 0) this.dashMomentum -= dt;
        if (this.dashCooldown > 0) this.dashCooldown -= dt;
        if (this._wallJumpCooldown > 0) this._wallJumpCooldown -= dt;
        if (this._dropTimer > 0) {
            this._dropTimer -= dt;
            if (this._dropTimer <= 0) this.droppingThrough = false;
        }

        if (this._respawning) {
            this._respawnTimer -= dt;
            if (this._respawnTimer <= 0) this._doRespawn();
            return;
        }

        if (this.state === 'dead') return;

        if (this.atkTimer > 0 && this.atkDuration) {
            this.atkProgress = 1 - (this.atkTimer / this.atkDuration);
        } else {
            this.atkProgress = 0;
        }

        const inAtk = this.atkTimer > 0;
        const inHurt = this.hurtTimer > 0;
        const inDodge = this.dodgeTimer > 0;
        const inDash = this.dashTimer > 0;

        if (inHurt) {
            this.state = 'hurt';
        } else if (inDodge) {
            this.state = 'dodge';
        } else if (inDash) {
            this.state = 'dash';
        } else if (inAtk) {
            this.state = 'attack';
        } else {
            this.isCrouchAttack = false;
            this._handleMovement(dt, C, particles);
            this._handleActions(dt, opponents, particles, C);
        }

        this._applyPhysics(dt, C);
        if (platforms) platforms.resolve(this);
        // Reset air-use tokens on landing
        if (this.onGround && !this._wasOnGround) {
            this._airJumpUsed = false;
            this._usedHeavyAir = false;
        }
        this._wasOnGround = this.onGround;
        this._checkBlastZone(opponents, particles, C);
    }

    // =========================================================
    //  Movement
    // =========================================================
    _handleMovement(dt, C, particles) {
        const inp = this.input;
        const prev = this._prevInput;
        let moving = false;

        if (this.onGround) {
            if (inp.down) {
                this.crouchTimer += dt;
                if (!prev.down && inp.down) {
                    const now = performance.now();
                    if (now - this._lastDownTap < 300) {
                        if (this.onPlatform && this.onPlatform.passThrough) {
                            this.droppingThrough = true;
                            this._dropTimer = 200;
                            this.vy = 2;
                            this.onGround = false;
                            this.crouchTimer = 0;
                            this._lastDownTap = 0;
                        }
                    }
                    this._lastDownTap = now;
                }
            } else {
                this.crouchTimer = 0;
            }
        } else {
            this.crouchTimer = 0;
        }

        // ================================================================
        //  WALL GRAB — cliff-cling mechanic (Brawlhalla style)
        //  Conditions: airborne, touching a non-passThrough wall, not rising
        //  too fast, and off wall-jump cooldown.
        // ================================================================
        const canWallGrab = !this.onGround &&
            this.onWall &&
            this._wallJumpCooldown <= 0 &&
            this.vy >= -C.WALL_GRAB_ENTER_VY;  // allow grab even slightly upward

        if (canWallGrab) {
            this.facing = this.wallDir;   // always face toward the wall

            if (this.state !== 'wallgrab') {
                // First frame of grab
                this.state = 'wallgrab';
                this._airJumpUsed = false;    // gift a double-jump for climbing off
                this._wallGrabTick = 0;
                if (window.GameEffects) GameEffects.shake(0.25, 60);
                Audio.playDodge && Audio.playDodge();
            }

            this._wallGrabTick += dt;
            this.vx = 0;   // no horizontal drift while clinging

            // ── Auto-release after WALL_GRAB_MAX_MS (prevents bot getting stuck) ──
            if (this._wallGrabTick >= C.WALL_GRAB_MAX_MS) {
                this.state = 'airborne';
                this._wallJumpCooldown = C.WALL_JUMP_COOLDOWN;
                this._wallGrabTick = 0;
                return;
            }

            // ── Wall jump: press UP ──
            if (this._risingEdge('up')) {
                const kickDir = -this.wallDir;   // jump AWAY from wall
                this.vy = C.JUMP_FORCE * 0.92;
                this.vx = kickDir * C.WALL_JUMP_VX;
                this.facing = kickDir;
                this.state = 'airborne';
                this._wallJumpCooldown = C.WALL_JUMP_COOLDOWN;
                this._airJumpUsed = false;    // fresh double-jump after wall jump
                this._wallGrabTick = 0;
                Audio.playJump && Audio.playJump();
                if (window.GameEffects) {
                    GameEffects.shake(0.5, 90);
                    GameEffects.flash('rgba(200,230,255,0.18)', 120);
                }
                if (particles) particles.spawnWallDust(this.x, this.y, this.wallDir);
                return;
            }

            // ── Release: press AWAY from wall ──
            const awayFromWall = (this.wallDir > 0 && inp.left) ||
                (this.wallDir < 0 && inp.right);
            if (awayFromWall) {
                this.state = 'airborne';
                this._wallJumpCooldown = C.WALL_JUMP_COOLDOWN * 0.4;
                this._wallGrabTick = 0;
                return;
            }

            // ── Scrape dust while sliding down ──
            if (this.vy > 0.4 && particles && Math.random() < 0.22) {
                particles.spawnWallDust(this.x, this.y, this.wallDir);
            }

            this.state = 'wallgrab';
            return;   // skip normal movement
        }

        // Not on wall — exit wallgrab if we were in it
        if (this.state === 'wallgrab') {
            this.state = 'airborne';
            this._wallGrabTick = 0;
        }

        if (this.onGround) {
            if (inp.left && !inp.right) {
                this.vx = -C.MOVE_SPEED; this.facing = -1; moving = true;
            } else if (inp.right && !inp.left) {
                this.vx = C.MOVE_SPEED; this.facing = 1; moving = true;
            }
        } else {
            if (inp.left && !inp.right) {
                this.vx -= C.AIR_MOVE;
                this.vx = Math.max(this.vx, -C.MOVE_SPEED);
                this.facing = -1; moving = true;
            } else if (inp.right && !inp.left) {
                this.vx += C.AIR_MOVE;
                this.vx = Math.min(this.vx, C.MOVE_SPEED);
                this.facing = 1; moving = true;
            }
        }

        // Dash momentum cancel
        if (this.dashMomentum > 0) {
            if ((this.dashMomentumDir > 0 && inp.left) ||
                (this.dashMomentumDir < 0 && inp.right)) {
                this.dashMomentum = 0;
            }
        }

        if (this._risingEdge('up') && this.onGround) {
            this.vy = C.JUMP_FORCE;
            this.onGround = false;
            Audio.playJump();
        } else if (this._risingEdge('up') && !this.onGround && !this._airJumpUsed) {
            // Double jump — slightly weaker
            this.vy = Math.round(C.JUMP_FORCE * 0.85);
            this._airJumpUsed = true;
            Audio.playJump && Audio.playJump();
        }

        if (!this.onGround) {
            this.state = 'airborne';
        } else if (inp.down) {
            this.state = 'crouch';
        } else if (moving) {
            this.state = 'walk';
        } else {
            this.state = 'idle';
        }
    }

    // =========================================================
    //  Dodge / Dash / Attack
    // =========================================================
    _handleActions(dt, opponents, particles, C) {
        const inp = this.input;

        // Dodge & Dash are NOT gated by atkCooldown
        if (this._risingEdge('dodge')) {
            const hasDir = inp.left || inp.right;
            if (this.onGround && hasDir && this.dashCooldown <= 0) {
                // Ground + direction = dash (own cooldown, independent of dodgeCooldown)
                this._startDash(C);
                return;
            }
            if (this.dodgeCooldown <= 0) {
                // Neutral ground dodge or any aerial dodge
                this._startDodge(C, this.onGround ? 0 : (inp.left ? -1 : (inp.right ? 1 : 0)));
                return;
            }
        }

        if (this.atkCooldown > 0) return;

        const lightTrig = this._risingEdge('light');
        const heavyTrig = this._risingEdge('heavy');

        // Ultimate: requires a collected skill item (light+heavy at full energy)
        if (this.collectedSkill && this.energy >= CONFIG.ENERGY.MAX) {
            const ultiTrig = (lightTrig && inp.heavy) || (heavyTrig && inp.light) || (lightTrig && heavyTrig);
            if (ultiTrig) {
                const skillDef = CONFIG.SKILLS[this.collectedSkill];
                this.energy = 0;
                this.collectedSkill = null;
                this._startAttack(skillDef.atkKey, opponents, particles, C);
                return;
            }
        }

        if (!lightTrig && !heavyTrig) return;

        let dir = 'neutral';
        if (inp.up && !inp.down) {
            dir = 'up';
        } else if (inp.down && !inp.up) {
            dir = 'down';
        } else if ((inp.right && this.facing > 0) || (inp.left && this.facing < 0)) {
            dir = 'forward';
        } else if ((inp.left && this.facing > 0) || (inp.right && this.facing < 0)) {
            dir = 'back';
        }

        const context = this.onGround ? 'ground' : 'air';
        const atkType = lightTrig ? 'light' : 'heavy';
        const atkKey = getAttackKey(atkType, dir, context);
        if (!atkKey) return;

        this.isCrouchAttack = (this.state === 'crouch');
        this.lastAttackDir = dir;
        // heavy_air can only be used once per airborne period
        if (atkKey === 'heavy_air' && !this.onGround && this._usedHeavyAir) return;
        this._startAttack(atkKey, opponents, particles, C);
    }

    _startDodge(C, dx) {
        this.dodgeTimer = C.DODGE_DURATION;
        this.invTimer = C.DODGE_DURATION;
        this.dodgeCooldown = C.DODGE_COOLDOWN;
        this.atkCooldown = C.DODGE_DURATION + 80;

        if (!this.onGround) {
            // Aerial dodge: hold vertical position; optional gentle horizontal glide
            this.vy = 0;
            this.vx = dx !== 0 ? dx * 4 : 0;
        } else if (dx !== 0) {
            this.vx = dx * (C.DODGE_DIST / (C.DODGE_DURATION / 16));
        } else {
            this.vx *= 0.1;
        }

        if (window.GameEffects) {
            GameEffects.shake(0.5, 80);
            GameEffects.flash('rgba(100,200,255,0.2)', 100);
        }

        // After-image trail during dodge — use Phaser timer instead of setInterval
        if (this._scene && window.GameEffects) {
            const INTERVAL = 30;
            const repeats = Math.floor(C.DODGE_DURATION / INTERVAL);
            this._scene.time.addEvent({
                delay: INTERVAL,
                repeat: repeats,
                callback: () => {
                    if (this.dodgeTimer <= 0) return;
                    GameEffects.addAfterImage(this.x, this.y, this.renderer, {
                        x: this.x, y: this.y,
                        facing: this.facing, state: 'dodge',
                        attackType: null, tick: this.tick,
                        invTimer: this.invTimer,
                        isCrouchAttack: false, atkProgress: 0,
                    });
                },
            });
        }

        Audio.playDodge && Audio.playDodge();
    }

    _startDash(C) {
        this.dashTimer = C.DASH_DURATION;
        this.dashMomentum = C.DASH_MOMENTUM;
        this.dashMomentumDir = this.facing;
        this.dashCooldown = C.DASH_COOLDOWN;
        this.atkCooldown = C.DASH_DURATION + 50;
        this.vx = this.facing * C.DASH_SPEED;
        Audio.playDash && Audio.playDash();
    }

    // =========================================================
    //  Attack
    // =========================================================
    _startAttack(atkKey, opponents, particles, C) {
        let atk = CONFIG.ATTACKS[atkKey];
        if (!atk) {
            const fb = atkKey.includes('heavy') ? 'heavy_neutral' : 'light_neutral';
            atk = CONFIG.ATTACKS[fb];
            if (!atk) return;
        }

        this.state = 'attack';
        this.attackType = atkKey;
        this.inCombo = false;
        this.comboHitCount = 0;
        this.isCrouchAttack = (this.state === 'crouch');
        this.lastAttackDir = atk.dir || 'neutral';

        const ACTIVE_WIN = 80;
        const totalDur = atk.delay_start + ACTIVE_WIN + atk.delay_end;
        this.atkTimer = totalDur;
        this.atkDuration = totalDur;
        this.atkStartup = atk.delay_start;
        this.atkCooldown = totalDur + 50;
        this.atkProgress = 0;

        const now = performance.now();
        if (now - this._lastAttackTime < 700) this._comboCount++;
        else this._comboCount = 1;
        this._lastAttackTime = now;

        // Mark heavy_air as used for this airborne period
        if (atkKey === 'heavy_air') this._usedHeavyAir = true;

        // Movement effects on attack start
        if (atk.slideSpeed) this.vx = this.facing * atk.slideSpeed;
        if (atk.dashSpeed) this.vx = this.facing * atk.dashSpeed;
        if (atk.diveVx !== undefined && atk.diveVy !== undefined) {
            this.vx = this.facing * atk.diveVx;
            this.vy = atk.diveVy;
            this.onGround = false;
        }
        if (atk.extraJumpVy) {
            this.vy = atk.extraJumpVy;
            this.onGround = false;
        }

        // Visual effects (GameEffects assigned by GameScene)
        if (window.GameEffects) {
            if (atk.type === 'ultimate') {
                GameEffects.shake(2.5, 400);
                GameEffects.flash('rgba(255,220,50,0.7)', 350);
                GameEffects.zoom(0.85, 500);
            } else if (atk.type === 'heavy') {
                GameEffects.shake(1.2, 180);
                GameEffects.zoom(0.95, 280);
            } else {
                GameEffects.shake(0.5, 90);
            }
        }

        // Schedule primary hit — use Phaser timer so it respects scene pause
        const hitDelay = atk.delay_start + 40;
        this._scheduleTimer(hitDelay, () => {
            if (!this || this.state === 'dead' || this._respawning) return;

            let hitAny = false;
            for (const opp of opponents) {
                if (!opp || opp.state === 'dead' || opp._respawning) continue;
                if (opp.team === this.team) continue;
                if (this._checkHit(atkKey, opp, atk)) {
                    this._applyHit(atkKey, opp, atk, particles);
                    hitAny = true;
                }
            }

            // Combo follow-ups
            if (hitAny && atk.combo && atk.combo.length > 0) {
                this.inCombo = true;
                atk.combo.forEach(hit => {
                    this._scheduleTimer(hit.delay, () => {
                        if (!this || this.state === 'dead' || this._respawning) return;
                        for (const opp of opponents) {
                            if (!opp || opp.state === 'dead' || opp._respawning) continue;
                            if (opp.team === this.team) continue;
                            const comboAtk = {
                                range: atk.range * 0.85, yWin: atk.yWin * 1.1,
                                dmg: hit.dmg, force: hit.force, type: atk.type,
                            };
                            // ignoreInv=true: combo hits always connect if in range
                            if (this._checkHit(atkKey, opp, comboAtk, true)) {
                                this._applyHit(atkKey, opp, comboAtk, particles, true);
                            }
                        }
                    });
                });
            }

            // Ultimate explosion / effects per skill
            if (atkKey.startsWith('ultimate') && particles) {
                if (atkKey === 'ultimate_void') {
                    for (let i = 0; i < 5; i++)
                        this._scheduleTimer(i * 80, () => particles.spawnShockwave(this.x, this.y - 50, 1.5 + i * 0.5));
                    particles.spawnExplosion && particles.spawnExplosion(this.x, this.y - 50);
                } else if (atkKey === 'ultimate_thunder') {
                    for (let i = 0; i < 3; i++)
                        this._scheduleTimer(i * 100, () => particles.spawnShockwave(this.x, this.y - 30, 1.5 + i));
                } else if (atkKey === 'ultimate_berserk') {
                    particles.spawnExplosion && particles.spawnExplosion(this.x, this.y - 60);
                } else {
                    // fire, default ultimate
                    for (let i = 0; i < 3; i++)
                        this._scheduleTimer(i * 120, () => particles.spawnShockwave(this.x, this.y - 60, 2 + i));
                    particles.spawnExplosion && particles.spawnExplosion(this.x, this.y - 60);
                }
            }
        });
    }

    // =========================================================
    //  Skill collection
    // =========================================================
    collectSkill(skillKey) {
        this.collectedSkill = skillKey;
        const s = CONFIG.SKILLS[skillKey];
        if (window.GameEffects && s) {
            GameEffects.flash(s.shadow, 350);
            GameEffects.shake(0.8, 150);
        }
        Audio.playPowerUp && Audio.playPowerUp();
    }

    // Unified timer — uses Phaser scene timer when available (respects pause),
    // falls back to setTimeout for safety.
    _scheduleTimer(delay, fn) {
        if (this._scene && this._scene.time) {
            this._scene.time.delayedCall(delay, fn, [], this);
        } else {
            setTimeout(fn.bind(this), delay);
        }
    }

    // =========================================================
    //  Hit Detection & Application
    // =========================================================
    _applyHit(atkKey, opp, atk, particles, isCombo = false) {
        if (!atk || !opp) return;
        if (opp.invTimer > 0 || opp.state === 'dead') return;

        const C = CONFIG;
        const scale = 1 + (opp.damage || 0) / 100;
        const F = (atk.force || 6) * scale;
        let kbx, kby;

        if (atk.kbHorizontal) {
            kbx = this.facing * F; kby = -1.5;
        } else if (atk.kbUp) {
            kbx = this.facing * F * 0.55; kby = -F * 0.90;
        } else if (atkKey === 'light_air_down') {
            kbx = this.facing * F * 0.65; kby = F * 0.65;
        } else if (atkKey === 'heavy_air_down') {
            kbx = this.facing * F * 0.15; kby = F * 1.0;
        } else if (atkKey === 'heavy_air') {
            kbx = this.facing * F * 0.5; kby = -F * 0.85;
        } else if (atkKey.startsWith('ultimate') || atkKey === 'ultimate') {
            // Radial: direction based on relative position (all ultimate types)
            const kbDir = (opp.x >= this.x ? 1 : -1);
            if (atk.radial) {
                kbx = kbDir * F * 0.95; kby = -F * 0.55;
            } else {
                kbx = kbDir * F * 0.9; kby = -F * 0.75;
            }
        } else {
            kbx = this.facing * F; kby = -F * 0.55;
        }

        opp.vx = kbx;
        opp.vy = kby;
        opp.onGround = false;
        opp.damage = (opp.damage || 0) + (atk.dmg || 5);
        opp.hurtTimer = C.HURT_DURATION;
        opp.invTimer = isCombo ? 60 : 120;

        if (atkKey !== 'ultimate' && !atkKey.startsWith('ultimate_')) {
            this.energy = Math.min(C.ENERGY.MAX, this.energy + C.ENERGY.GAIN_ON_HIT);
        }
        opp.energy = Math.min(C.ENERGY.MAX, (opp.energy || 0) + C.ENERGY.GAIN_ON_HURT);

        if (particles) {
            const hitY = opp.y - 40;
            particles.spawnBlood && particles.spawnBlood(opp.x, hitY, this.facing);
            particles.spawnSpark && particles.spawnSpark(opp.x, hitY);
            if (atk.type === 'ultimate') {
                particles.spawnShockwave && particles.spawnShockwave(opp.x, hitY, 1.8);
            } else if (atk.type === 'heavy') {
                particles.spawnShockwave && particles.spawnShockwave(opp.x, hitY, 1.3);
            }
        }

        if (window.GameEffects) {
            if (atk.type === 'ultimate') {
                const skillColor = {
                    ultimate_fire: 'rgba(255,100,0,0.7)',
                    ultimate_thunder: 'rgba(255,240,50,0.75)',
                    ultimate_void: 'rgba(180,0,255,0.65)',
                    ultimate_berserk: 'rgba(255,30,60,0.65)',
                }[atkKey] || 'rgba(255,200,50,0.65)';
                GameEffects.shake(3.0, 500);
                GameEffects.flash(skillColor, 400);
                GameEffects.zoom(1.12, 400);
            } else if (atk.type === 'heavy') {
                GameEffects.shake(1.5, 200);
                if (opp.damage >= 100) GameEffects.flash('rgba(255,80,50,0.55)', 220);
                GameEffects.zoom(1.05, 250);
            } else if (!isCombo) {
                GameEffects.shake(0.4, 80);
            }
        }

        Audio.playHurt && Audio.playHurt();
    }

    _checkHit(atkKey, opp, atk, ignoreInv = false) {
        if (!ignoreInv && opp.invTimer > 0) return false;
        const dx = opp.x - this.x;
        const absDx = Math.abs(dx);
        const dy = opp.y - this.y;

        if (atkKey === 'heavy_air' || atkKey === 'heavy_air_down') {
            if (dy < -20) return false;
        } else if (atkKey === 'heavy_down') {
            if (Math.sign(dx) !== 0 && Math.sign(dx) !== this.facing) return false;
        } else {
            if (absDx > 5 && Math.sign(dx) !== this.facing) return false;
        }

        return absDx <= atk.range && Math.abs(dy) < atk.yWin;
    }

    // =========================================================
    //  Physics
    // =========================================================
    _applyPhysics(dt, C) {
        // ---- Wall grab: slow slide gravity, no horizontal drift ----
        if (this.state === 'wallgrab') {
            this.vy = Math.min(this.vy + C.WALL_SLIDE_GRAVITY, C.WALL_SLIDE_MAX);
            this.vx = 0;
            this.y += this.vy;
            return;
        }

        this.vy += C.GRAVITY;
        this.vy = Math.min(this.vy, C.MAX_FALL);

        if (!this.onGround && this.state !== 'attack' && this.input && this.input.down) {
            this.vy += C.GRAVITY * 0.8;
            this.vy = Math.min(this.vy, C.MAX_FALL);
        }

        // Aerial dodge: counteract gravity every frame to hold height
        if (this.dodgeTimer > 0 && !this.onGround) {
            this.vy = 0;
        }

        if (this.state === 'attack' && this.attackType === 'heavy_air_down') {
            const diveAtk = CONFIG.ATTACKS['heavy_air_down'];
            if (diveAtk && this.input && this.input.down) this.vy = diveAtk.diveVy;
        }

        if (this.dashMomentum > 0) {
            const momentumVx = this.dashMomentumDir * 10;
            if (this.onGround) {
                this.vx = momentumVx;
            } else {
                this.vx = Math.max(
                    Math.min(this.vx + this.dashMomentumDir * 2,
                        Math.abs(momentumVx) * this.dashMomentumDir > 0 ? momentumVx + 2 : C.MOVE_SPEED),
                    -(C.MOVE_SPEED + 2)
                );
            }
            this.dashMomentum -= dt;
        }

        if (this.onGround) {
            if (!this.input.left && !this.input.right && this.dashTimer <= 0 && this.dashMomentum <= 0) {
                this.vx *= C.FRICTION;
            }
        } else {
            this.vx *= C.AIR_FRICTION;
        }

        if (Math.abs(this.vx) < 0.1) this.vx = 0;
        this.x += this.vx;
        this.y += this.vy;
    }

    // =========================================================
    //  Blast Zones
    // =========================================================
    _checkBlastZone(opponents, particles, C) {
        if (this._respawning || this.state === 'dead') return;
        const oob = this.x < C.BLAST_LEFT || this.x > C.BLAST_RIGHT ||
            this.y > C.BLAST_BOTTOM || this.y < C.BLAST_TOP;
        if (!oob) return;

        this.stocks--;
        this.damage = 0;
        Audio.playKO();

        if (this.stocks <= 0) {
            this.stocks = 0;
            this.state = 'dead';
        } else {
            this._respawning = true;
            this._respawnTimer = C.RESPAWN_DELAY;
            this.vx = 0; this.vy = 0;
            this.x = -9999; this.y = -9999;
        }
    }

    _doRespawn() {
        const C = CONFIG;
        this._respawning = false;
        const ground = C.PLATFORMS[0];
        this.x = ground.x + ground.w / 2 + (this.id % 2 === 0 ? 120 : -120);
        this.y = ground.y - 200;
        this.vx = 0; this.vy = 0;
        this.state = 'airborne';
        this.invTimer = C.RESPAWN_INVIN;
        this.hurtTimer = 0;
    }

    // =========================================================
    //  Utility
    // =========================================================
    _risingEdge(key) {
        // _netRise_<key> flags are set by the host's GameScene when it detects a
        // rising edge in a received network input packet, BEFORE the key could be
        // released again in the same frame (preventing the jump / attack from
        // being silently eaten by fast key-tap + release between host frames).
        const nk = '_netRise_' + key;
        if (this[nk]) { this[nk] = false; return true; }
        return !!(this.input[key] && !this._prevInput[key]);
    }

    reset(x, facingRight, stocks) {
        const C = CONFIG;
        this.x = x;
        this.y = C.PLATFORMS[0].y - 10;
        this.vx = 0; this.vy = 0;
        this.onGround = true;
        this.facing = facingRight ? 1 : -1;
        this.damage = 0;
        this.stocks = stocks ?? C.DEFAULT_STOCKS;
        this.energy = 0;
        this.state = 'idle';
        this.attackType = null;
        this.atkTimer = 0;
        this.atkCooldown = 0;
        this.atkProgress = 0;
        this.atkDuration = 0;
        this.hurtTimer = 0;
        this.invTimer = 0;
        this.dodgeTimer = 0;
        this.dashTimer = 0;
        this.atkStartup = 0;
        this.dodgeCooldown = 0;
        this.dashMomentum = 0;
        this.dashMomentumDir = 0;
        this.inCombo = false;
        this.comboHitCount = 0;
        this._respawning = false;
        this._respawnTimer = 0;
        this.droppingThrough = false;
        this._dropTimer = 0;
        this._comboCount = 0;
        this._lastAttackTime = 0;
        this.input = this._emptyInput();
        this._prevInput = this._emptyInput();
        this.tick = 0;
        this.dashCooldown = 0;
        this._airJumpUsed = false;
        this._usedHeavyAir = false;
        this._wasOnGround = true;
        this.collectedSkill = null;
        this.onWall = false;
        this.wallDir = 0;
        this.wallPlatform = null;
        this._wallJumpCooldown = 0;
        this._wallGrabTick = 0;
    }

    /** Called by GameScene._render() */
    draw(g) {
        if (this._respawning) return;
        if (this.invTimer > 0 && Math.floor(this.tick) % 4 < 2 && this.state !== 'dead') return;
        this.renderer.draw(g, this);
    }
}

/* =========================================================
   INPUT MANAGER — no longer needed directly (GameScene reads
   Phaser keyboard).  Kept for Bot compatibility: same API.
   ========================================================= */
class InputManager {
    constructor() {
        this.keys = {};
        window.addEventListener('keydown', e => {
            this.keys[e.code] = true;
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
            Audio.resume && Audio.resume();
        });
        window.addEventListener('keyup', e => { this.keys[e.code] = false; });
    }
    getForMap(keyMap) {
        const k = this.keys;
        return {
            left: !!k[keyMap.left], right: !!k[keyMap.right],
            up: !!k[keyMap.up], down: !!k[keyMap.down || ''],
            light: !!k[keyMap.light], heavy: !!k[keyMap.heavy],
            dodge: !!k[keyMap.dodge],
        };
    }
    flush() { this.keys = {}; }
}

window.Fighter = Fighter;
window.InputManager = InputManager;
