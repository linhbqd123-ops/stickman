'use strict';
/* =========================================================
   MAIN — Phaser 3 game initialization
   Scenes: BootScene → MenuScene ↔ GameScene
   ========================================================= */
window.addEventListener('DOMContentLoaded', () => {
    new Phaser.Game({
        type: Phaser.AUTO,          // WebGL preferred, Canvas fallback
        width:  CONFIG.WIDTH,
        height: CONFIG.HEIGHT,
        parent: 'canvas-wrap',      // inject canvas into #canvas-wrap div
        backgroundColor: '#080818',
        scene: [BootScene, MenuScene, GameScene],
        scale: {
            mode:       Phaser.Scale.FIT,
            autoCenter: Phaser.Scale.CENTER_BOTH,
            width:      CONFIG.WIDTH,
            height:     CONFIG.HEIGHT,
        },
        render: {
            antialias:       true,
            pixelArt:        false,
            powerPreference: 'high-performance',
            batchSize:       2048,
        },
        fps: {
            target:          60,
            forceSetTimeOut: false,
        },
        disableContextMenu: true,
    });
});
