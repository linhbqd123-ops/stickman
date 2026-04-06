'use strict';
/* =========================================================
   BOOT SCENE — Init audio, then hand off to MenuScene
   ========================================================= */
class BootScene extends Phaser.Scene {
    constructor() { super({ key: 'BootScene' }); }

    preload() {
        // All rendering is procedural — no assets to load.
        // Just show a minimal loading indicator.
        const { width: W, height: H } = this.scale;
        this.add.text(W / 2, H / 2, 'LOADING...', {
            fontFamily: 'Exo 2, sans-serif',
            fontSize:   '22px',
            color:      '#00e5ff',
        }).setOrigin(0.5);
    }

    create() {
        Audio.init();
        this.scene.start('MenuScene');
    }
}
