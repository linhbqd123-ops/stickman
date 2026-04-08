'use strict';
/* =========================================================
   CONFIG — All game constants (Brawlhalla-style upgrade)
   ========================================================= */
const CONFIG = Object.freeze({

    // Canvas
    WIDTH: 1280,
    HEIGHT: 720,

    // Blast zones (losing a stock when crossing these)
    // BLAST_RIGHT expanded to cover the widest map (1600px ground + 300px margin)
    BLAST_LEFT: -300,
    BLAST_RIGHT: 1900,
    BLAST_TOP: -750,
    BLAST_BOTTOM: 900,
    // Per-map blast overrides:
    //  - A map object in `CONFIG.MAPS` may provide `blastLeft`, `blastRight`,
    //    `blastTop`, `blastBottom` to override these global values for that map.
    //  - GameScene uses the map-specific bounds when present; otherwise falls
    //    back to these global `BLAST_*` values.
    // Recommendation: horizontal margin ~300px beyond the map canvas width;
    // vertical: top negative margin large enough for high jumps (~-700..-850),
    // bottom = canvasHeight + ~180 to allow safe camera framing before KO.

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

    // Wall grab / cliff cling (Brawlhalla-style)
    WALL_SLIDE_GRAVITY: 0.10,  // slow-fall gravity while clinging to wall
    WALL_SLIDE_MAX: 1.8,       // max slide-down speed on wall
    WALL_JUMP_VX: 7.5,         // horizontal push when jumping off wall
    WALL_JUMP_COOLDOWN: 380,   // ms before can grab wall again after leaving
    WALL_GRAB_ENTER_VY: 6,     // max falling vy allowed to initiate grab
    WALL_GRAB_MAX_MS: 2800,    // ms: auto-release if held too long (prevents bot stuck)

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

    // ---- Default map key ----
    DEFAULT_MAP: '',

    // ====================================================================
    //  MAP DEFINITIONS
    //  Each map: bgImagePath, platforms[], randomPlatformMovement config
    //  Platform props: id, x, y, w, h, passThrough, imagePath, imageKey
    //  imagePath  — relative path loaded in GameScene.preload()
    //  imageKey   — Phaser texture cache key
    // ====================================================================
    MAPS: {
        naruto: {
            name: 'Hidden Leaf Village',
            canvasWidth: 1600,
            canvasHeight: 720,
            // Map-specific blast bounds (overrides global BLAST_* if present)
            // Horizontal margin: canvas +/- 300px; vertical top/bottom tuned for camera
            blastLeft: -400,
            blastRight: 2000,
            blastTop: -750,
            blastBottom: 1300,
            bgImagePath: 'assets/maps/naruto/bg_main.png',
            randomPlatformMovement: {
                enabled: true,
                minVelocity: -1.8,
                maxVelocity: 1.8,
                moveRange: 55,
            },
            platforms: [
                // COLLISION:  x, y, w, h  — physics only. player feet snap to y.
                // VISUAL:      displayHeight = image height
                //              imageAnchorY  = 0.0~1.0, which % of image aligns with y
                //              imageOffsetY  = pixel fine-tune
                // Example: PNG has 40% transparent top → imageAnchorY: 0.4
                { id: 'n_ground', x: 100, y: 620, w: 1200, h: 500, displayHeight: 600, imageAnchorY: 0, passThrough: false, imagePath: 'assets/maps/naruto/platforms/plat_ground.png', imageKey: 'plat_naruto_ground' },
                { id: 'n_left_q', x: 120, y: 480, w: 200, h: 1, displayHeight: 50, imageAnchorY: 0.5, passThrough: true, imagePath: 'assets/maps/naruto/platforms/plat_wooden.png', imageKey: 'plat_naruto_wooden' },
                { id: 'n_left_c', x: 380, y: 360, w: 240, h: 1, displayHeight: 100, imageAnchorY: 0.5, passThrough: true, imagePath: 'assets/maps/naruto/platforms/plat_stone.png', imageKey: 'plat_naruto_stone' },
                { id: 'n_center', x: 650, y: 280, w: 300, h: 1, displayHeight: 100, imageAnchorY: 0.5, passThrough: true, imagePath: 'assets/maps/naruto/platforms/plat_chakra.png', imageKey: 'plat_naruto_chakra' },
                { id: 'n_right_c', x: 980, y: 360, w: 240, h: 1, displayHeight: 100, imageAnchorY: 0.5, passThrough: true, imagePath: 'assets/maps/naruto/platforms/plat_wooden.png', imageKey: 'plat_naruto_wooden' },
                { id: 'n_right_q', x: 1280, y: 480, w: 200, h: 1, displayHeight: 100, imageAnchorY: 0.5, passThrough: true, imagePath: 'assets/maps/naruto/platforms/plat_ninja.png', imageKey: 'plat_naruto_ninja' },
                { id: 'n_left_high', x: 80, y: 200, w: 150, h: 1, displayHeight: 100, imageAnchorY: 0.5, passThrough: true, imagePath: 'assets/maps/naruto/platforms/plat_stone.png', imageKey: 'plat_naruto_stone' },
                { id: 'n_right_high', x: 1370, y: 200, w: 150, h: 1, displayHeight: 100, imageAnchorY: 0.5, passThrough: true, imagePath: 'assets/maps/naruto/platforms/plat_stone.png', imageKey: 'plat_naruto_stone' },
            ],
        },
        dragonball: {
            name: 'Hyperbolic Time Chamber',
            canvasWidth: 1600,
            canvasHeight: 720,
            // Map-specific blast bounds
            blastLeft: -300,
            blastRight: 1900,
            blastTop: -750,
            blastBottom: 900,
            bgImagePath: 'assets/maps/dragonball/bg_main.png',
            randomPlatformMovement: {
                enabled: true,
                minVelocity: -2.2,
                maxVelocity: 2.2,
                moveRange: 70,
            },
            platforms: [
                { id: 'db_ground', x: 0, y: 620, w: 1600, h: 100, displayHeight: 180, imageAnchorY: 0, passThrough: false, imagePath: 'assets/maps/dragonball/platforms/plat_ground.png', imageKey: 'plat_db_ground' },
                { id: 'db_lower_left', x: 100, y: 500, w: 220, h: 18, displayHeight: 45, imageAnchorY: 0, passThrough: true, imagePath: 'assets/maps/dragonball/platforms/plat_energy_cube.png', imageKey: 'plat_db_energy_cube' },
                { id: 'db_lower_right', x: 1280, y: 500, w: 220, h: 18, displayHeight: 45, imageAnchorY: 0, passThrough: true, imagePath: 'assets/maps/dragonball/platforms/plat_energy_cube.png', imageKey: 'plat_db_energy_cube' },
                { id: 'db_left_mid', x: 150, y: 390, w: 200, h: 16, displayHeight: 40, imageAnchorY: 0, passThrough: true, imagePath: 'assets/maps/dragonball/platforms/plat_ki_base.png', imageKey: 'plat_db_ki_base' },
                { id: 'db_center_low', x: 660, y: 400, w: 280, h: 16, displayHeight: 40, imageAnchorY: 0, passThrough: true, imagePath: 'assets/maps/dragonball/platforms/plat_energy_platform.png', imageKey: 'plat_db_energy_plat' },
                { id: 'db_right_mid', x: 1250, y: 390, w: 200, h: 16, displayHeight: 40, imageAnchorY: 0, passThrough: true, imagePath: 'assets/maps/dragonball/platforms/plat_ki_base.png', imageKey: 'plat_db_ki_base' },
                { id: 'db_left_high', x: 200, y: 280, w: 180, h: 16, displayHeight: 40, imageAnchorY: 0, passThrough: true, imagePath: 'assets/maps/dragonball/platforms/plat_ki_base.png', imageKey: 'plat_db_ki_base' },
                { id: 'db_center_high', x: 710, y: 220, w: 180, h: 16, displayHeight: 40, imageAnchorY: 0, passThrough: true, imagePath: 'assets/maps/dragonball/platforms/plat_energy_nexus.png', imageKey: 'plat_db_energy_nexus' },
                { id: 'db_right_high', x: 1220, y: 280, w: 180, h: 16, displayHeight: 40, imageAnchorY: 0, passThrough: true, imagePath: 'assets/maps/dragonball/platforms/plat_ki_base.png', imageKey: 'plat_db_ki_base' },
            ],
        },
        fptsoftware: {
            name: 'FPT Software Arena',
            canvasWidth: 1600,
            canvasHeight: 720,
            // Map-specific blast bounds
            blastLeft: -300,
            blastRight: 1900,
            blastTop: -750,
            blastBottom: 900,
            bgImagePath: 'assets/maps/fptsoftware/bg_main.png',
            randomPlatformMovement: {
                enabled: true,
                minVelocity: -1.4,
                maxVelocity: 1.4,
                moveRange: 45,
            },
            platforms: [
                { id: 'fpt_ground', x: 0, y: 620, w: 1600, h: 100, displayHeight: 180, imageAnchorY: 0, passThrough: false, imagePath: 'assets/maps/fptsoftware/platforms/plat_ground.png', imageKey: 'plat_fpt_ground' },
                { id: 'fpt_lower_left', x: 80, y: 520, w: 200, h: 16, displayHeight: 40, imageAnchorY: 0, passThrough: true, imagePath: 'assets/maps/fptsoftware/platforms/plat_desk.png', imageKey: 'plat_fpt_desk' },
                { id: 'fpt_lower_right', x: 1320, y: 520, w: 200, h: 16, displayHeight: 40, imageAnchorY: 0, passThrough: true, imagePath: 'assets/maps/fptsoftware/platforms/plat_desk.png', imageKey: 'plat_fpt_desk' },
                { id: 'fpt_left_shelf', x: 120, y: 410, w: 180, h: 18, displayHeight: 45, imageAnchorY: 0, passThrough: true, imagePath: 'assets/maps/fptsoftware/platforms/plat_shelf.png', imageKey: 'plat_fpt_shelf' },
                { id: 'fpt_center_shelf', x: 710, y: 430, w: 180, h: 18, displayHeight: 45, imageAnchorY: 0, passThrough: true, imagePath: 'assets/maps/fptsoftware/platforms/plat_server_rack.png', imageKey: 'plat_fpt_server' },
                { id: 'fpt_right_shelf', x: 1300, y: 410, w: 180, h: 18, displayHeight: 45, imageAnchorY: 0, passThrough: true, imagePath: 'assets/maps/fptsoftware/platforms/plat_shelf.png', imageKey: 'plat_fpt_shelf' },
                { id: 'fpt_left_window', x: 140, y: 320, w: 160, h: 16, displayHeight: 40, imageAnchorY: 0, passThrough: true, imagePath: 'assets/maps/fptsoftware/platforms/plat_window.png', imageKey: 'plat_fpt_window' },
                { id: 'fpt_center_monitor', x: 720, y: 280, w: 160, h: 16, displayHeight: 40, imageAnchorY: 0, passThrough: true, imagePath: 'assets/maps/fptsoftware/platforms/plat_monitor.png', imageKey: 'plat_fpt_monitor' },
                { id: 'fpt_right_window', x: 1300, y: 320, w: 160, h: 16, displayHeight: 40, imageAnchorY: 0, passThrough: true, imagePath: 'assets/maps/fptsoftware/platforms/plat_window.png', imageKey: 'plat_fpt_window' },
            ],
        },
    },

    // Platforms — legacy fallback (used when map key is unknown)
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
        drop: 'KeyF',
    },
    KEYS_P2: {
        left: 'ArrowLeft',
        right: 'ArrowRight',
        up: 'ArrowUp',
        down: 'ArrowDown',
        light: 'Numpad1',
        heavy: 'Numpad2',
        dodge: 'Numpad3',
        drop: 'Numpad0',
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

    ULTIMATE_ICON_BASE_PATH: 'assets/ultimates',
    ULTIMATE_VIDEO_BASE_PATH: 'assets/videos',

    // ======================================================================
    //  ULTIMATE SKILLS V2 — 5 named ultimates, each fully configurable
    // ======================================================================
    ULTIMATE_SKILLS: {
        default: {
            id: 'default',
            name: 'Power Strike',
            description: 'Powerful forward strike',
            color: '#ffffff',
            glowColor: 'rgba(255,255,255,0.6)',
            damage: 80,
            forceStrength: 50,
            hitboxWidth: 220,
            hitboxHeight: 150,
            hitboxOffsetX: 30,
            hitboxOffsetY: -10,
            duration: 500,
            startDelay: 100,
            endDelay: 300,
            energyCost: 30,
            knockbackDuration: 300,
            iconFile: null,
            enabled: true,
        },
        yasuo: {
            id: 'yasuo',
            name: 'Wind Slash',
            description: 'Slash out wind projectile — teleport & 5-hit combo on connect',
            color: '#88ffee',
            glowColor: 'rgba(100,255,220,0.7)',
            damage: 120,
            forceStrength: 80,
            hitboxWidth: 200,
            hitboxHeight: 150,
            hitboxOffsetX: 80,
            hitboxOffsetY: 0,
            duration: 600,
            startDelay: 100,
            endDelay: 400,
            energyCost: 35,
            knockbackDuration: 400,
            projectileSpeed: 10,
            projectileRange: 'full',
            teleportToHit: true,
            comboHits: 5,
            comboDuration: 800,
            iconFile: 'yasuo_ultimate.png',
            enabled: true,
        },
        kamehameha: {
            id: 'kamehameha',
            name: 'Kamehameha',
            description: 'Powerful energy wave',
            color: '#44aaff',
            glowColor: 'rgba(50,150,255,0.75)',
            damage: 100,
            forceStrength: 90,
            hitboxWidth: 180,
            hitboxHeight: 120,
            hitboxOffsetX: 70,
            hitboxOffsetY: -30,
            duration: 700,
            startDelay: 150,
            endDelay: 450,
            energyCost: 40,
            knockbackDuration: 500,
            projectileSpeed: 8,
            projectileRange: 'full',
            projectileWidth: 180,
            projectileHeight: 120,
            iconFile: 'saiyan_ultimate.png',
            enabled: true,
        },
        fpt: {
            id: 'fpt',
            name: 'Meteor Rain',
            description: 'Rain down 8 meteors',
            color: '#ff8844',
            glowColor: 'rgba(255,100,40,0.7)',
            damage: 16,
            forceStrength: 35,
            startDelay: 120,
            endDelay: 300,
            meteorCount: 8,
            meteorSpawnDuration: 3000,
            meteorHitboxRadius: 60,
            meteorSpriteFile: 'meteor.png',
            energyCost: 45,
            knockbackDuration: 250,
            iconFile: 'fpt_ultimate.png',
            enabled: true,
        },
        saitama: {
            id: 'saitama',
            name: 'Serious Punch',
            description: 'One punch to end it all',
            color: '#ffd700',
            glowColor: 'rgba(255,215,0,0.85)',
            damage: 1000,
            forceStrength: 999,
            startDelay: 0,
            endDelay: 500,
            energyCost: 50,
            energyRefund: 25,
            cooldown: 30000,
            knockbackDuration: 800,
            freezeScreenDuration: 500,
            affectAllEnemies: true,
            victimEnergyMultiplier: 0.5,
            maxInstanceCount: 1,
            rarity: 0.02,
            videoPath: 'assets/videos/saitama_punch.mp4',
            videoDuration: 3500,
            enabled: true,
            dropOnMap: true,
            bounceOnMap: true,
            bounceVelocityX: { min: -4, max: 4 },
            bounceVelocityY: { min: -5, max: -2 },
            bounceGravity: 0.3,
            iconFile: 'saitama_ultimate.png',
        },
    },

    // ======================================================================
    //  SKILL DROP SYSTEM — box drops on death; F/0 discards held ultimate
    // ======================================================================
    SKILL_DROP: {
        dropChanceOnDeath: 0.50,    // 50% chance fighter drops skill on KO
        skillBoxSize: 40,
        pickupRadius: 60,
        dropGravity: 0.4,
        dropBounce: 0.45,
        maxLifetime: 60000,         // 60 s before despawn
        mapSpawnInterval: 14000,
        maxActiveOnMap: 3,

        rarity: {
            default: 0.40,
            yasuo: 0.20,
            kamehameha: 0.15,
            fpt: 0.15,
            saitama: 0.02,
            // remaining ~8% → random from above pool
        },
    },
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
