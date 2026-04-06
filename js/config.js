'use strict';
/* =========================================================
   CONFIG — All game constants in one place
   ========================================================= */
const CONFIG = Object.freeze({

    // Canvas
    WIDTH: 960,
    HEIGHT: 540,
    GROUND_Y: 460,   // Y coordinate of the ground surface

    // Physics
    GRAVITY: 0.65,
    MOVE_SPEED: 4.5,
    JUMP_FORCE: -15,
    FRICTION: 0.80,
    MAX_FALL: 18,
    WALL_LEFT: 60,
    WALL_RIGHT: 900,

    // Combat
    MAX_HP: 100,
    PUNCH_DMG: 7,
    KICK_DMG: 12,
    KNOCKBACK_X: 7,
    KNOCKBACK_Y: -5,
    ATTACK_DURATION: 280,   // ms — how long the attack box is active
    ATTACK_COOLDOWN: 460,   // ms — time before next attack
    HURT_DURATION: 200,   // ms — stun duration after getting hit
    INVINCIBLE_FRAMES: 320,   // ms — invincibility after a hit

    // Hit-box (relative to fighter center)
    PUNCH_RANGE: 70,   // x reach
    PUNCH_HEIGHT: 30,   // y window around chest/head
    KICK_RANGE: 75,
    KICK_HEIGHT: 55,   // lower — around waist/legs

    // Round
    ROUND_TIME: 60,    // seconds
    ROUNDS_TO_WIN: 2,     // wins needed for match victory

    // Stickman proportions (px)
    HEAD_R: 14,
    TORSO_LEN: 34,
    ARM_UPPER: 22,
    ARM_LOWER: 20,
    LEG_UPPER: 26,
    LEG_LOWER: 24,
    SHOULDER_W: 18,   // half-width of shoulder span
    HIP_W: 12,

    // Colors
    P1_COLOR: '#00e5ff',
    P1_SHADOW: 'rgba(0,229,255,0.45)',
    P2_COLOR: '#ff3d3d',
    P2_SHADOW: 'rgba(255,61,61,0.45)',
    HURT_COLOR: '#ffffff',
    DEAD_COLOR: '#555577',

    // Particles
    BLOOD_COUNT: 14,
    BLOOD_SPEED: 5,
    BLOOD_LIFE: 42,

    // Bot difficulty (base)
    BOT_REACT_MS: 480,
    BOT_ATTACK_RATE: 0.022,  // probability per frame to attack (easy)

    // Tournament opponents
    TOURNAMENT_OPPONENTS: [
        { name: 'ROOKIE', difficulty: 0.30 },
        { name: 'BRAWLER', difficulty: 0.50 },
        { name: 'VETERAN', difficulty: 0.70 },
        { name: 'CHAMPION', difficulty: 0.90 },
    ],
});
