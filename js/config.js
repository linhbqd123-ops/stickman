'use strict';
/* =========================================================
   CONFIG — All game constants (Brawlhalla-style upgrade)
   ========================================================= */
const CONFIG = Object.freeze({

    // Canvas
    WIDTH: 1280,
    HEIGHT: 720,

    // Blast zones (losing a stock when crossing these)
    BLAST_LEFT: -300,
    BLAST_RIGHT: 1580,
    BLAST_TOP: -750,
    BLAST_BOTTOM: 900,

    // Physics
    GRAVITY: 0.55,
    MOVE_SPEED: 5.5,     // max ground run speed
    AIR_MOVE: 3.5,     // horizontal air-control force
    JUMP_FORCE: -14,
    FRICTION: 0.78,    // ground decel
    AIR_FRICTION: 0.92,    // air horizontal drag
    MAX_FALL: 22,
    DASH_SPEED: 14,      // grounded dash velocity
    DODGE_DIST: 90,      // airborne dodge micro-movement
    DODGE_DURATION: 1000,    // ms, 1 second invincibility window
    DODGE_COOLDOWN: 3000,    // ms, 3 second cooldown from button press
    DASH_DURATION: 200,     // ms, grounded dash duration
    DASH_MOMENTUM: 500,     // ms, momentum after dash (0.5s carryover)
    DASH_COOLDOWN: 200,     // ms, anti-spam cooldown between dashes
    FAST_FALL_ACCEL: 1.5,    // multiplier on gravity when holding down in air

    // Stock system
    DEFAULT_STOCKS: 3,

    // ========================================================================
    //  ATTACK SYSTEM
    //  Each attack: dmg, force, delay_start, delay_end  (the 4 tunable fields)
    //    dmg         — base damage dealt
    //    force       — base knockback magnitude
    //    delay_start — ms before the hit activates (windup animation)
    //    delay_end   — ms after hit before actor can act again (recovery)
    //  Extra technical fields: range, yWin, combo, slideSpeed, etc.
    // ========================================================================
    ATTACKS: {
        // ── LIGHT ATTACKS  (instant – delay_start: 0) ─────────────────────

        // Ground neutral: single punch → 3-hit combo if it connects
        'light_neutral': {
            type: 'light', context: 'ground', dir: 'neutral',
            dmg: 5, force: 4, delay_start: 0, delay_end: 120,
            range: 78, yWin: 60,
            combo: [
                { dmg: 2, force: 2, delay: 100 },   // left punch
                { dmg: 2, force: 2, delay: 200 },   // right punch
                { dmg: 3, force: 6, delay: 300 }    // kick — slight pop
            ]
        },

        // Ground forward: tiny slide + kick → stronger knockback
        'light_forward': {
            type: 'light', context: 'ground', dir: 'forward',
            dmg: 6, force: 11, delay_start: 0, delay_end: 130,
            range: 95, yWin: 65,
            slideSpeed: 6, slideDuration: 110
        },

        // Ground down: soccer slide-tackle → horizontal pop
        'light_down': {
            type: 'light', context: 'ground', dir: 'down',
            dmg: 5, force: 7, delay_start: 0, delay_end: 150,
            range: 90, yWin: 32,
            kbHorizontal: true,
            slideSpeed: 5, slideDuration: 130
        },

        // Air neutral/up: aerial kick → 3-kick combo if connects
        'light_air': {
            type: 'light', context: 'air', dir: 'neutral',
            dmg: 5, force: 5, delay_start: 0, delay_end: 120,
            range: 75, yWin: 70,
            combo: [
                { dmg: 2, force: 3, delay: 100 },   // kick 1
                { dmg: 2, force: 3, delay: 200 },   // kick 2
                { dmg: 3, force: 7, delay: 300 }    // kick 3 — light launch
            ]
        },

        // Air down: diagonal dive-kick (body moves diagonally down)
        'light_air_down': {
            type: 'light', context: 'air', dir: 'down',
            dmg: 7, force: 9, delay_start: 0, delay_end: 140,
            range: 80, yWin: 60,
            diveVx: 9, diveVy: 5
        },

        // ── HEAVY ATTACKS  (delay_start: 70 ms for telegraphed weight) ────

        // Ground neutral: single powerful punch
        'heavy_neutral': {
            type: 'heavy', context: 'ground', dir: 'neutral',
            dmg: 13, force: 16, delay_start: 70, delay_end: 160,
            range: 85, yWin: 65
        },

        // Ground forward: dash + flying double-leg kick
        'heavy_forward': {
            type: 'heavy', context: 'ground', dir: 'forward',
            dmg: 12, force: 15, delay_start: 70, delay_end: 170,
            range: 110, yWin: 75,
            dashSpeed: 13, dashDuration: 140
        },

        // Ground down: crouched diagonal-upward kick → enemy launched up
        'heavy_down': {
            type: 'heavy', context: 'ground', dir: 'down',
            dmg: 12, force: 15, delay_start: 70, delay_end: 180,
            range: 95, yWin: 60,
            kbUp: true
        },

        // Air neutral: full-jump boost then rising uppercut → launches enemy upward
        'heavy_air': {
            type: 'heavy', context: 'air', dir: 'neutral',
            dmg: 14, force: 18, delay_start: 70, delay_end: 170,
            range: 90, yWin: 100,
            extraJumpVy: -12
        },

        // Air down: straight-down power-dive; continues while down is held
        'heavy_air_down': {
            type: 'heavy', context: 'air', dir: 'down',
            dmg: 15, force: 20, delay_start: 70, delay_end: 200,
            range: 85, yWin: 60,
            straightDive: true, diveVy: 18
        },

        // ── ULTIMATE (default / fallback) ──────────────────────────────────
        'ultimate': {
            type: 'ultimate', context: 'any', dir: 'neutral',
            dmg: 35, force: 24, delay_start: 350, delay_end: 600,
            range: 200, yWin: 220
        },

        // ── SKILL ULTIMATES (unlocked by collecting skill items on the map) ──

        // FIRE — rocket punch: dash through enemy at high speed
        'ultimate_fire': {
            type: 'ultimate', context: 'any', dir: 'neutral',
            dmg: 28, force: 26, delay_start: 80, delay_end: 320,
            range: 150, yWin: 130,
            dashSpeed: 20
        },

        // THUNDER — leap + overhead two-fist slam down
        'ultimate_thunder': {
            type: 'ultimate', context: 'any', dir: 'neutral',
            dmg: 30, force: 22, delay_start: 160, delay_end: 380,
            range: 110, yWin: 140,
            extraJumpVy: -12,
            kbUp: false   // thunderslam sends straight up-forward
        },

        // VOID — wide radial blast, hits ALL enemies regardless of facing
        'ultimate_void': {
            type: 'ultimate', context: 'any', dir: 'neutral',
            dmg: 32, force: 25, delay_start: 350, delay_end: 600,
            range: 240, yWin: 280,
            radial: true   // knockback direction = away from attacker
        },

        // BERSERK — rapid 5-hit combo, each hit small KB to keep enemy close
        'ultimate_berserk': {
            type: 'ultimate', context: 'any', dir: 'neutral',
            dmg: 6, force: 5, delay_start: 50, delay_end: 380,
            range: 90, yWin: 120,
            slideSpeed: 3,
            combo: [
                { dmg: 5, force: 4, delay: 80 },
                { dmg: 5, force: 4, delay: 155 },
                { dmg: 7, force: 6, delay: 240 },
                { dmg: 7, force: 6, delay: 320 },
                { dmg: 18, force: 24, delay: 430 }   // final hit — big launch
            ]
        }
    },

    // Energy system
    ENERGY: {
        MAX: 100,
        GAIN_ON_HIT: 8,    // attacker gains this when landing a hit
        GAIN_ON_HURT: 5,    // defender gains this when being hit
    },

    // ── SKILL ITEM SYSTEM ────────────────────────────────────────────────────
    //  Skill items spawn on platforms. Touching one stores it on the fighter.
    //  When energy is full (light+heavy) the stored skill fires as ultimate.
    SKILLS: {
        fire: { atkKey: 'ultimate_fire', name: 'FIRE', color: '#ff6600', shadow: 'rgba(255,102,0,0.8)' },
        thunder: { atkKey: 'ultimate_thunder', name: 'THUNDER', color: '#ffe040', shadow: 'rgba(255,220,40,0.8)' },
        void: { atkKey: 'ultimate_void', name: 'VOID', color: '#cc44ff', shadow: 'rgba(180,0,255,0.8)' },
        berserk: { atkKey: 'ultimate_berserk', name: 'BERSERK', color: '#ff2244', shadow: 'rgba(255,30,60,0.8)' },
    },
    SKILL_SPAWN_INTERVAL: 14000,  // ms between new skill item spawns
    SKILL_LIFETIME: 22000,  // ms before an uncollected item despawns
    SKILL_RADIUS: 22,     // px — collection/draw radius

    HURT_DURATION: 180,   // ms stun after being hit
    INVINCIBLE_FRAMES: 60,    // ms right after a stock loss (respawn invin)

    // Respawn
    RESPAWN_DELAY: 1500,   // ms before fighter respawns
    RESPAWN_INVIN: 2000,   // ms of invincibility after respawn

    // Stickman proportions (px)
    HEAD_R: 14,
    TORSO_LEN: 34,
    ARM_UPPER: 22,
    ARM_LOWER: 20,
    LEG_UPPER: 26,
    LEG_LOWER: 24,
    SHOULDER_W: 18,
    HIP_W: 12,

    // Colors
    P1_COLOR: '#00e5ff',
    P1_SHADOW: 'rgba(0,229,255,0.5)',
    P2_COLOR: '#ff3d3d',
    P2_SHADOW: 'rgba(255,61,61,0.5)',
    P3_COLOR: '#aaff00',
    P3_SHADOW: 'rgba(170,255,0,0.5)',
    P4_COLOR: '#ff9900',
    P4_SHADOW: 'rgba(255,153,0,0.5)',
    HURT_COLOR: '#ffffff',
    DEAD_COLOR: '#555577',

    // Particles
    BLOOD_COUNT: 12,
    BLOOD_SPEED: 5,
    BLOOD_LIFE: 42,

    // Camera
    CAM_PADDING: 120,   // px padding around all fighters
    CAM_MIN_ZOOM: 0.45,
    CAM_MAX_ZOOM: 1.0,
    CAM_LERP: 0.07,

    // Platforms — defined as { x, y, w, h, passThrough }
    // Coordinate space: 1280×720, ground at y≈620
    PLATFORMS: [
        // Main ground
        { x: 0, y: 620, w: 1280, h: 100, passThrough: false },
        // Left mid platform
        { x: 140, y: 430, w: 220, h: 18, passThrough: true },
        // Right mid platform
        { x: 920, y: 430, w: 220, h: 18, passThrough: true },
        // Center top platform
        { x: 490, y: 290, w: 300, h: 18, passThrough: true },
        // Small left side
        { x: 60, y: 320, w: 130, h: 18, passThrough: true },
        // Small right side
        { x: 1090, y: 320, w: 130, h: 18, passThrough: true },
    ],

    // ---- Key bindings ----
    KEYS_P1: {
        left: 'KeyA',
        right: 'KeyD',
        up: 'KeyW',
        down: 'KeyS',
        light: 'KeyJ',
        heavy: 'KeyK',
        dodge: 'KeyL',
    },
    KEYS_P2: {
        left: 'ArrowLeft',
        right: 'ArrowRight',
        up: 'ArrowUp',
        down: 'ArrowDown',
        light: 'Numpad1',
        heavy: 'Numpad2',
        dodge: 'Numpad3',
    },

    // Bot difficulty (base)
    BOT_REACT_MS: 400,
    BOT_ATTACK_RATE: 0.022,

    // Tournament — AI opponents for single-player tournament
    TOURNAMENT_AI: [
        { name: 'ROOKIE', color: '#aaff00', shadow: 'rgba(170,255,0,0.5)', difficulty: 0.25 },
        { name: 'SCRAPPER', color: '#ff9900', shadow: 'rgba(255,153,0,0.5)', difficulty: 0.42 },
        { name: 'BRAWLER', color: '#cc44ff', shadow: 'rgba(204,68,255,0.5)', difficulty: 0.58 },
        { name: 'VETERAN', color: '#ff6688', shadow: 'rgba(255,102,136,0.5)', difficulty: 0.73 },
        { name: 'CHAMPION', color: '#ffd700', shadow: 'rgba(255,215,0,0.5)', difficulty: 0.90 },
        { name: 'LEGEND', color: '#ff3d3d', shadow: 'rgba(255,61,61,0.5)', difficulty: 0.99 },
        { name: 'GHOST', color: '#aaddff', shadow: 'rgba(170,221,255,0.5)', difficulty: 0.99 },
    ],
});

// Expose CONFIG globally for ESM modules
window.CONFIG = CONFIG;

/**
 * Resolve which ATTACKS key to use given type/direction/context.
 * New catalog:  light → neutral | forward | down | air | air_down
 *               heavy → neutral | forward | down | air | air_down
 */
function getAttackKey(type, direction, context = 'ground') {
    if (type === 'light') {
        if (context === 'air') {
            if (direction === 'down') return 'light_air_down';
            return 'light_air';   // neutral / forward / up all become air kick
        }
        if (direction === 'forward') return 'light_forward';
        if (direction === 'down') return 'light_down';
        return 'light_neutral';   // neutral / back / up
    } else if (type === 'heavy') {
        if (context === 'air') {
            if (direction === 'down') return 'heavy_air_down';
            return 'heavy_air';   // neutral / forward / up
        }
        if (direction === 'forward') return 'heavy_forward';
        if (direction === 'down') return 'heavy_down';
        return 'heavy_neutral';   // neutral / back / up
    }
    return type === 'light' ? 'light_neutral' : 'heavy_neutral';
}

window.getAttackKey = getAttackKey;
