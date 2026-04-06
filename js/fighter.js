'use strict';
/* =========================================================
   FIGHTER — Physics, input, combat, health
   Each Fighter instance owns one Stickman renderer.
   ========================================================= */

class Fighter {
    /**
     * @param {object} opts
     *   id          {number}  1 or 2
     *   x           {number}  spawn X
     *   color       {string}
     *   shadow      {string}
     *   facingRight {boolean} initial facing direction
     *   isPlayer    {boolean} if false → input is driven externally (Bot)
     *   keys        {object}  { left, right, up, punch, kick } key names
     */
    constructor(opts) {
        const C = CONFIG;

        this.id = opts.id;
        this.isPlayer = opts.isPlayer !== false;
        this.keys = opts.keys || {};

        // ---- Physics state ----
        this.x = opts.x;
        this.y = C.GROUND_Y;
        this.vx = 0;
        this.vy = 0;
        this.onGround = true;
        this.facing = opts.facingRight ? 1 : -1;

        // ---- Combat state ----
        this.hp = C.MAX_HP;
        this.maxHp = C.MAX_HP;
        this.state = 'idle';   // idle|walk|jump|punch|kick|hurt|dead
        this.atkTimer = 0;        // ms remaining in current attack
        this.atkCooldown = 0;       // ms until next attack allowed
        this.atkProgress = 0;       // 0→1 attack animation progress
        this.hurtTimer = 0;        // ms remaining in hurt stun
        this.invTimer = 0;        // ms remaining in invincibility

        // Input intentions — set by player (keys) or Bot
        this.input = { left: false, right: false, jump: false, punch: false, kick: false };

        // ---- Rendering ----
        this.renderer = new Stickman(opts.color, opts.shadow, !opts.facingRight);
        this.color = opts.color;
        this.tick = 0;           // frame counter for animations

        // ---- Key state tracking (only for human player) ----
        this._keysDown = {};
        if (this.isPlayer) this._listenKeys();
    }

    // ----------------------------------------------------------
    //  Key handling (human players)
    // ----------------------------------------------------------
    _listenKeys() {
        // We use a shared key map stored on the Fighter itself.
        // game.js wires up actual KeyboardEvent listeners once.
    }

    /** Called by game.js InputManager to update this fighter's input. */
    setInput(input) {
        this.input = input;
    }

    // ----------------------------------------------------------
    //  Update loop — call once per frame with dt in ms
    // ----------------------------------------------------------
    update(dt, opponent, particles) {
        const C = CONFIG;

        this.tick += dt / 16.67;  // normalised to 60 fps

        // ---- Timers ----
        if (this.atkTimer > 0) this.atkTimer -= dt;
        if (this.atkCooldown > 0) this.atkCooldown -= dt;
        if (this.hurtTimer > 0) this.hurtTimer -= dt;
        if (this.invTimer > 0) this.invTimer -= dt;

        if (this.state === 'dead') return;

        // --- Update attack progress (0→1) ---
        if (this.atkTimer > 0) {
            const total = this.currentAtkDuration || C.ATTACK_DURATION;
            this.atkProgress = 1 - (this.atkTimer / total);
        } else {
            this.atkProgress = 0;
        }

        // ---- State machine ----
        const inAtk = this.atkTimer > 0;
        const inHurt = this.hurtTimer > 0;

        if (inHurt) {
            this.state = 'hurt';
        } else if (inAtk) {
            // state already set to punch/kick; physics still apply
        } else {
            // ---- Movement input ----
            let moving = false;
            if (this.input.left && !this.input.right) {
                this.vx -= (C.MOVE_SPEED + Math.abs(this.vx) * 0.1);
                this.vx = Math.max(this.vx, -C.MOVE_SPEED);
                this.facing = -1;
                moving = true;
            } else if (this.input.right && !this.input.left) {
                this.vx += (C.MOVE_SPEED + Math.abs(this.vx) * 0.1);
                this.vx = Math.min(this.vx, C.MOVE_SPEED);
                this.facing = 1;
                moving = true;
            }

            // ---- Jump ----
            if (this.input.jump && this.onGround) {
                this.vy = C.JUMP_FORCE;
                this.onGround = false;
                Audio.playJump();
            }

            // ---- Attack ----
            if (this.atkCooldown <= 0) {
                if (this.input.punch) {
                    this._startAttack('punch', C.PUNCH_DMG, C.ATTACK_DURATION, opponent, particles);
                } else if (this.input.kick) {
                    this._startAttack('kick', C.KICK_DMG, C.ATTACK_DURATION * 1.1, opponent, particles);
                }
            }

            // ---- Derive logical state ----
            if (!this.onGround) {
                this.state = 'jump';
            } else if (moving) {
                this.state = 'walk';
            } else {
                this.state = 'idle';
            }
        }

        // ---- Physics ----
        this.vy += C.GRAVITY;
        this.vy = Math.min(this.vy, C.MAX_FALL);
        this.vx *= C.FRICTION;
        if (Math.abs(this.vx) < 0.1) this.vx = 0;

        this.x += this.vx;
        this.y += this.vy;

        // ---- Ground collision ----
        if (this.y >= C.GROUND_Y) {
            if (!this.onGround && this.vy > 2) {
                particles.spawnDust(this.x, C.GROUND_Y);
            }
            this.y = C.GROUND_Y;
            this.vy = 0;
            this.onGround = true;
        } else {
            this.onGround = false;
        }

        // ---- Wall clamp ----
        this.x = Math.max(C.WALL_LEFT, Math.min(C.WALL_RIGHT, this.x));
    }

    // ----------------------------------------------------------
    //  Attack execution
    // ----------------------------------------------------------
    _startAttack(type, dmg, duration, opponent, particles) {
        const C = CONFIG;

        this.state = type;  // 'punch' or 'kick'
        this.atkTimer = duration;
        this.currentAtkDuration = duration;
        this.atkCooldown = C.ATTACK_COOLDOWN;
        this.atkProgress = 0;

        // At the peak of the animation (50%) check for a hit
        setTimeout(() => {
            if (this.state === 'dead') return;
            if (this._checkHit(type, opponent)) {
                opponent._receiveHit(dmg, this.facing, type, particles);
                if (type === 'punch') Audio.playPunch();
                else Audio.playKick();
            }
        }, duration * 0.42);
    }

    _checkHit(type, opp) {
        const C = CONFIG;
        const dx = opp.x - this.x;
        const range = type === 'punch' ? C.PUNCH_RANGE : C.KICK_RANGE;
        const yWin = type === 'punch' ? C.PUNCH_HEIGHT : C.KICK_HEIGHT;

        // Must be facing opponent
        if (Math.sign(dx) !== this.facing) return false;

        const dist = Math.abs(dx);
        if (dist > range) return false;

        const dy = Math.abs(this.y - opp.y);   // feet-level difference
        return dy < yWin + 30;
    }

    _receiveHit(dmg, srcFacing, type, particles) {
        const C = CONFIG;
        if (this.invTimer > 0 || this.state === 'dead') return;

        this.hp = Math.max(0, this.hp - dmg);
        this.hurtTimer = C.HURT_DURATION;
        this.invTimer = C.INVINCIBLE_FRAMES;

        // Knockback
        this.vx = srcFacing * C.KNOCKBACK_X;
        this.vy = C.KNOCKBACK_Y;
        this.onGround = false;

        // Blood particles at torso/body level
        const hitY = this.y - (CONFIG.LEG_LOWER + CONFIG.LEG_UPPER) - (type === 'punch' ? 40 : 20);
        particles.spawnBlood(this.x, hitY, srcFacing);
        particles.spawnSpark(this.x, hitY);

        Audio.playHurt();

        if (this.hp <= 0) {
            this.hp = 0;
            this.state = 'dead';
            this.vx = srcFacing * 3;
            this.vy = -6;
            Audio.playKO();
        }
    }

    // ----------------------------------------------------------
    //  Reset for a new round
    // ----------------------------------------------------------
    reset(x, facingRight) {
        const C = CONFIG;
        this.x = x;
        this.y = C.GROUND_Y;
        this.vx = 0;
        this.vy = 0;
        this.onGround = true;
        this.facing = facingRight ? 1 : -1;
        this.hp = C.MAX_HP;
        this.state = 'idle';
        this.atkTimer = 0;
        this.atkCooldown = 0;
        this.atkProgress = 0;
        this.hurtTimer = 0;
        this.invTimer = 0;
        this.input = { left: false, right: false, jump: false, punch: false, kick: false };
        this.tick = 0;
    }

    // ----------------------------------------------------------
    //  Render
    // ----------------------------------------------------------
    draw(ctx) {
        this.renderer.draw(ctx, this);
    }
}

/* =========================================================
   INPUT MANAGER
   Centralises keyboard state; feeds each Fighter.
   ========================================================= */
class InputManager {
    constructor() {
        this.keys = {};

        window.addEventListener('keydown', e => {
            this.keys[e.code] = true;
            // Prevent arrow-key page scroll during gameplay
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
                e.preventDefault();
            }
            Audio.resume();
        });

        window.addEventListener('keyup', e => {
            this.keys[e.code] = false;
        });
    }

    /** Returns input snapshot for Player 1 (WASD + F/G). */
    getP1() {
        return {
            left: !!this.keys['KeyA'],
            right: !!this.keys['KeyD'],
            jump: !!this.keys['KeyW'],
            punch: !!this.keys['KeyF'],
            kick: !!this.keys['KeyG'],
        };
    }

    /** Returns input snapshot for Player 2 (Arrows + L/K). */
    getP2() {
        return {
            left: !!this.keys['ArrowLeft'],
            right: !!this.keys['ArrowRight'],
            jump: !!this.keys['ArrowUp'],
            punch: !!this.keys['KeyL'],
            kick: !!this.keys['KeyK'],
        };
    }

    /** Clear all held keys (e.g. when switching screens). */
    flush() { this.keys = {}; }
}
