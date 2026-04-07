'use strict';
/* =========================================================
   MAIN — Phaser 3 game initialization
   Scenes: BootScene → MenuScene ↔ GameScene
   ========================================================= */

// ── ESM imports (bundled by esbuild) ──
import Phaser from 'phaser';
import Peer from 'peerjs';

// Global reference for PeerJS (used by network.js)
window.Peer = Peer;

// ── Import all game modules in order ──
import './config.js';
import './network.js';
import './audio.js';
import './tournament.js';
import './ui.js';
import './bot.js';
import './platform.js';
import './stickman.js';
import './fighter.js';
import './particles.js';
import './scenes/BootScene.js';
import './scenes/MenuScene.js';
import './scenes/GameScene.js';

window.addEventListener('DOMContentLoaded', () => {
    new Phaser.Game({
        type: Phaser.AUTO,          // WebGL preferred, Canvas fallback
        width: CONFIG.WIDTH,
        height: CONFIG.HEIGHT,
        parent: 'canvas-wrap',      // inject canvas into #canvas-wrap div
        backgroundColor: '#080818',
        scene: [BootScene, MenuScene, GameScene],
        scale: {
            mode: Phaser.Scale.FIT,
            autoCenter: Phaser.Scale.CENTER_BOTH,
            width: CONFIG.WIDTH,
            height: CONFIG.HEIGHT,
        },
        render: {
            antialias: true,
            pixelArt: false,
            powerPreference: 'high-performance',
            batchSize: 2048,
        },
        fps: {
            target: 60,
            forceSetTimeOut: false,
        },
        disableContextMenu: true,
    });
});

