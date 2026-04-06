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

        this._scene      = opts.scene;     // Phaser.Scene (for timers)
        this.id          = opts.id;
        this.isPlayer    = opts.isPlayer !== false;
        this.keyMap      = opts.keyMap || C.KEYS_P1;
        this.team        = opts.team ?? opts.id - 1;

        // ---- Physics state ----
        this.x       = opts.x ?? 400;
        this.y       = opts.y ?? C.PLATFORMS[0].y;
        this.vx      = 0;
        this.vy      = 0;
        this.onGround= true;
        this.onPlatform = null;
        this.facing  = opts.facingRight ? 1 : -1;
        this.width   = 20;

        // Drop-through one-way platform
        this.droppingThrough = false;
        this._dropTimer      = 0;

        // ---- Crouch state ----
        this.crouchTimer   = 0;
        this._downTapCount = 0;
        this._lastDownTap  = 0;

        // ---- Stock / damage ----
        this.stocks  = opts.stocks ?? C.DEFAULT_STOCKS;
        this.damage  = 0;

        // ---- Energy ----
        this.energy  = 0;

        // ---- Combat state ----
        this.state       = 'idle';
        this.attackType  = null;
        this.atkTimer    = 0;
        this.atkCooldown = 0;
        this.atkStartup  = 0;
        this.atkProgress = 0;
        this.atkDuration = 0;
        this.hurtTimer   = 0;
        this.invTimer    = 0;
        this.dodgeTimer  = 0;
        this.dodgeCooldown = 0;
        this.dashTimer   = 0;
        this.dashMomentum    = 0;
        this.dashMomentumDir = 0;
        this.isCrouchAttack  = false;
        this.lastAttackDir   = 'neutral';
        this.comboHitCount   = 0;
        this.inCombo         = false;

        // ---- Respawn ----
        this._respawning   = false;
        this._respawnTimer = 0;

        // ---- Combo tracking ----
        this._lastAttackTime = 0;
        this._comboCount     = 0;

        // Input snapshot
        this.input      = this._emptyInput();
        this._prevInput = this._emptyInput();

        // ---- Rendering ----
        this.renderer = new Stickman(opts.color, opts.shadow, !opts.facingRight);
        this.color    = opts.color;
        this.shadow   = opts.shadow;
        this.tick     = 0;
    }

    _emptyInput() {
        return { left:false, right:false, up:false, down:false,
                 light:false, heavy:false, dodge:false };
    }

    setInput(inp) {
        this._prevInput = this.input;
        this.input      = inp;
    }

    // =========================================================
    //  UPDATE (called each frame by GameScene)
    // =========================================================
    update(dt, opponents, platforms, particles) {
        const C = CONFIG;
        this.tick += dt / 16.667;

        if (this.atkTimer    > 0) this.atkTimer    -= dt;
        if (this.atkCooldown > 0) this.atkCooldown -= dt;
        if (this.atkStartup  > 0) this.atkStartup  -= dt;
        if (this.hurtTimer   > 0) this.hurtTimer   -= dt;
        if (this.invTimer    > 0) this.invTimer    -= dt;
        if (this.dodgeTimer  > 0) this.dodgeTimer  -= dt;
        if (this.dodgeCooldown > 0) this.dodgeCooldown -= dt;
        if (this.dashTimer   > 0) this.dashTimer   -= dt;
        if (this.dashMomentum> 0) this.dashMomentum -= dt;
        if (this._dropTimer  > 0) {
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

        const inAtk   = this.atkTimer   > 0;
        const inHurt  = this.hurtTimer  > 0;
        const inDodge = this.dodgeTimer > 0;
        const inDash  = this.dashTimer  > 0;

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
            this._handleMovement(dt, C);
            this._handleActions(dt, opponents, particles, C);
        }

        this._applyPhysics(dt, C);
        if (platforms) platforms.resolve(this);
        this._checkBlastZone(opponents, particles, C);
    }

    // =========================================================
    //  Movement
    // =========================================================
    _handleMovement(dt, C) {
        const inp  = this.input;
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
                            this._dropTimer      = 200;
                            this.vy              = 2;
                            this.onGround        = false;
                            this.crouchTimer     = 0;
                            this._lastDownTap    = 0;
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

        if (this.onGround) {
            if (inp.left && !inp.right) {
                this.vx = -C.MOVE_SPEED; this.facing = -1; moving = true;
            } else if (inp.right && !inp.left) {
                this.vx =  C.MOVE_SPEED; this.facing =  1; moving = true;
            }
        } else {
            if (inp.left && !inp.right) {
                this.vx -= C.AIR_MOVE;
                this.vx  = Math.max(this.vx, -C.MOVE_SPEED);
                this.facing = -1; moving = true;
            } else if (inp.right && !inp.left) {
                this.vx += C.AIR_MOVE;
                this.vx  = Math.min(this.vx,  C.MOVE_SPEED);
                this.facing =  1; moving = true;
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
            this.vy       = C.JUMP_FORCE;
            this.onGround = false;
            Audio.playJump();
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
        if (this.atkCooldown > 0) return;

        const inp  = this.input;

        if (this._risingEdge('dodge') && this.dodgeCooldown <= 0) {
            const hasDir = inp.left || inp.right;
            if (this.onGround) {
                hasDir ? this._startDash(C) : this._startDodge(C, 0);
            } else {
                this._startDodge(C, inp.left ? -1 : (inp.right ? 1 : 0));
            }
            return;
        }

        const lightTrig = this._risingEdge('light');
        const heavyTrig = this._risingEdge('heavy');

        // Ultimate (light+heavy simultaneously)
        if (this.energy >= CONFIG.ENERGY.MAX) {
            const ultiTrig = (lightTrig && inp.heavy) || (heavyTrig && inp.light) || (lightTrig && heavyTrig);
            if (ultiTrig) {
                this.energy = 0;
                this._startAttack('ultimate', opponents, particles, C);
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
        const atkKey  = getAttackKey(atkType, dir, context);
        if (!atkKey) return;

        this.isCrouchAttack = (this.state === 'crouch');
        this.lastAttackDir  = dir;
        this._startAttack(atkKey, opponents, particles, C);
    }

    _startDodge(C, dx) {
        this.dodgeTimer    = C.DODGE_DURATION;
        this.invTimer      = C.DODGE_DURATION;
        this.dodgeCooldown = C.DODGE_COOLDOWN;
        this.atkCooldown   = C.DODGE_DURATION + 80;

        if (dx !== 0) {
            this.vx = dx * (C.DODGE_DIST / (C.DODGE_DURATION / 16));
            this.vy *= 0.3;
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
            const repeats  = Math.floor(C.DODGE_DURATION / INTERVAL);
            this._scene.time.addEvent({
                delay:    INTERVAL,
                repeat:   repeats,
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
        this.dashTimer       = C.DASH_DURATION;
        this.dashMomentum    = C.DASH_MOMENTUM;
        this.dashMomentumDir = this.facing;
        this.atkCooldown     = C.DASH_DURATION + 50;
        this.vx              = this.facing * C.DASH_SPEED;
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

        this.state      = 'attack';
        this.attackType = atkKey;
        this.inCombo    = false;
        this.comboHitCount  = 0;
        this.isCrouchAttack = (this.state === 'crouch');
        this.lastAttackDir  = atk.dir || 'neutral';

        const ACTIVE_WIN = 80;
        const totalDur   = atk.delay_start + ACTIVE_WIN + atk.delay_end;
        this.atkTimer    = totalDur;
        this.atkDuration = totalDur;
        this.atkStartup  = atk.delay_start;
        this.atkCooldown = totalDur + 50;
        this.atkProgress = 0;

        const now = performance.now();
        if (now - this._lastAttackTime < 700) this._comboCount++;
        else this._comboCount = 1;
        this._lastAttackTime = now;

        // Movement effects on attack start
        if (atk.slideSpeed)                         this.vx = this.facing * atk.slideSpeed;
        if (atk.dashSpeed)                          this.vx = this.facing * atk.dashSpeed;
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
                GameEffects.flash('rgba(255,200,100,0.35)', 120);
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
                            if (this._checkHit(atkKey, opp, comboAtk)) {
                                this._applyHit(atkKey, opp, comboAtk, particles, true);
                            }
                        }
                    });
                });
            }

            // Ultimate explosion
            if (atkKey === 'ultimate' && particles) {
                for (let i = 0; i < 3; i++) {
                    this._scheduleTimer(i * 120, () => particles.spawnShockwave(this.x, this.y - 60, 2 + i));
                }
                particles.spawnExplosion && particles.spawnExplosion(this.x, this.y - 60);
            }
        });
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

        const C     = CONFIG;
        const scale = 1 + (opp.damage || 0) / 100;
        const F     = (atk.force || 6) * scale;
        let kbx, kby;

        if (atk.kbHorizontal) {
            kbx = this.facing * F; kby = -1.5;
        } else if (atk.kbUp) {
            kbx = this.facing * F * 0.55; kby = -F * 0.90;
        } else if (atkKey === 'light_air_down') {
            kbx = this.facing * F * 0.65; kby =  F * 0.65;
        } else if (atkKey === 'heavy_air_down') {
            kbx = this.facing * F * 0.15; kby =  F * 1.0;
        } else if (atkKey === 'heavy_air') {
            kbx = this.facing * F * 0.5;  kby = -F * 0.85;
        } else if (atkKey === 'ultimate') {
            kbx = (opp.x >= this.x ? 1 : -1) * F * 0.9; kby = -F * 0.75;
        } else {
            kbx = this.facing * F; kby = -F * 0.55;
        }

        opp.vx        = kbx;
        opp.vy        = kby;
        opp.onGround  = false;
        opp.damage    = (opp.damage || 0) + (atk.dmg || 5);
        opp.hurtTimer = C.HURT_DURATION;
        opp.invTimer  = isCombo ? 60 : 120;

        if (atkKey !== 'ultimate') {
            this.energy = Math.min(C.ENERGY.MAX, this.energy + C.ENERGY.GAIN_ON_HIT);
        }
        opp.energy = Math.min(C.ENERGY.MAX, (opp.energy || 0) + C.ENERGY.GAIN_ON_HURT);

        if (particles) {
            const hitY = opp.y - 40;
            particles.spawnBlood   && particles.spawnBlood(opp.x, hitY, this.facing);
            particles.spawnSpark   && particles.spawnSpark(opp.x, hitY);
            if (atk.type === 'heavy') {
                particles.spawnShockwave && particles.spawnShockwave(opp.x, hitY, 1.3);
            }
        }

        if (window.GameEffects) {
            if (atk.type === 'ultimate') {
                GameEffects.shake(3.0, 500);
                GameEffects.flash('rgba(255,200,50,0.65)', 400);
                GameEffects.zoom(1.12, 400);
            } else if (atk.type === 'heavy') {
                GameEffects.shake(1.5, 200);
                GameEffects.flash('rgba(255,100,80,0.3)', 150);
                GameEffects.zoom(1.05, 250);
            } else if (!isCombo) {
                GameEffects.shake(0.4, 80);
            }
        }

        Audio.playHurt && Audio.playHurt();
    }

    _checkHit(atkKey, opp, atk) {
        if (opp.invTimer > 0) return false;
        const dx    = opp.x - this.x;
        const absDx = Math.abs(dx);
        const dy    = opp.y - this.y;

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
        this.vy += C.GRAVITY;
        this.vy  = Math.min(this.vy, C.MAX_FALL);

        if (!this.onGround && this.state !== 'attack' && this.input && this.input.down) {
            this.vy += C.GRAVITY * 0.8;
            this.vy  = Math.min(this.vy, C.MAX_FALL);
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
        const oob = this.x < C.BLAST_LEFT  || this.x > C.BLAST_RIGHT ||
                    this.y > C.BLAST_BOTTOM || this.y < C.BLAST_TOP;
        if (!oob) return;

        this.stocks--;
        this.damage = 0;
        Audio.playKO();

        if (this.stocks <= 0) {
            this.stocks = 0;
            this.state  = 'dead';
        } else {
            this._respawning   = true;
            this._respawnTimer = C.RESPAWN_DELAY;
            this.vx = 0; this.vy = 0;
            this.x  = -9999; this.y = -9999;
        }
    }

    _doRespawn() {
        const C      = CONFIG;
        this._respawning = false;
        const ground = C.PLATFORMS[0];
        this.x  = ground.x + ground.w / 2 + (this.id % 2 === 0 ? 120 : -120);
        this.y  = ground.y - 200;
        this.vx = 0; this.vy = 0;
        this.state    = 'airborne';
        this.invTimer = C.RESPAWN_INVIN;
        this.hurtTimer= 0;
    }

    // =========================================================
    //  Utility
    // =========================================================
    _risingEdge(key) {
        return this.input[key] && !this._prevInput[key];
    }

    reset(x, facingRight, stocks) {
        const C = CONFIG;
        this.x  = x;
        this.y  = C.PLATFORMS[0].y - 10;
        this.vx = 0; this.vy = 0;
        this.onGround        = true;
        this.facing          = facingRight ? 1 : -1;
        this.damage          = 0;
        this.stocks          = stocks ?? C.DEFAULT_STOCKS;
        this.energy          = 0;
        this.state           = 'idle';
        this.attackType      = null;
        this.atkTimer        = 0;
        this.atkCooldown     = 0;
        this.atkProgress     = 0;
        this.atkDuration     = 0;
        this.hurtTimer       = 0;
        this.invTimer        = 0;
        this.dodgeTimer      = 0;
        this.dashTimer       = 0;
        this.atkStartup      = 0;
        this.dodgeCooldown   = 0;
        this.dashMomentum    = 0;
        this.dashMomentumDir = 0;
        this.inCombo         = false;
        this.comboHitCount   = 0;
        this._respawning     = false;
        this._respawnTimer   = 0;
        this.droppingThrough = false;
        this._dropTimer      = 0;
        this._comboCount     = 0;
        this._lastAttackTime = 0;
        this.input           = this._emptyInput();
        this._prevInput      = this._emptyInput();
        this.tick            = 0;
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
            if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
            Audio.resume && Audio.resume();
        });
        window.addEventListener('keyup', e => { this.keys[e.code] = false; });
    }
    getForMap(keyMap) {
        const k = this.keys;
        return {
            left:  !!k[keyMap.left],  right: !!k[keyMap.right],
            up:    !!k[keyMap.up],    down:  !!k[keyMap.down || ''],
            light: !!k[keyMap.light], heavy: !!k[keyMap.heavy],
            dodge: !!k[keyMap.dodge],
        };
    }
    flush() { this.keys = {}; }
}
