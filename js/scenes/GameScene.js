'use strict';
/* =========================================================
   GAME SCENE — Core gameplay loop powered by Phaser 3.
   Replaces the entire game.js + camera.js from the vanilla version.

   Key improvements over vanilla:
   • WebGL hardware-accelerated rendering (auto-fallback Canvas)
   • Phaser built-in camera shake / flash / zoomTo (no manual offsets)
   • scene.time.delayedCall replaces all setTimeout (Phaser-managed, paused
     correctly when the scene is paused)
   • scene.time.addEvent replaces setInterval (same benefit)
   • Depth-sorted Graphics layers for clean draw order
   • setScrollFactor(0) for screen-space background + UI overlays
   ========================================================= */

class GameScene extends Phaser.Scene {
    constructor() { super({ key: 'GameScene' }); }

    // =========================================================
    //  init — called before create(), receives data from scene.start()
    // =========================================================
    init(data) {
        this.mode             = data.mode       || '1vAI';
        this.tournament       = data.tournament || null;
        this.tournamentMatch  = data.tournamentMatch || null;
    }

    // =========================================================
    //  create
    // =========================================================
    create() {
        const C = CONFIG;

        // ---- State ----
        this.fighters    = [];
        this.bots        = [];
        this.matchOver   = false;
        this.roundPaused = true;
        this.isPaused    = false;

        // ---- Camera effect multipliers ----
        this._baseZoom       = 0.75;   // auto-follow zoom (lerped)
        this._targetBaseZoom = 0.75;
        this._effectZoom     = 1.0;    // transient hit-effect zoom
        this._targetEffectZoom = 1.0;
        this._camTargetX     = 0;
        this._camTargetY     = 0;

        // ---- Graphics layers (sorted by depth) ----
        // World-space objects (move with camera)
        this._platGfx       = this.add.graphics().setDepth(1);
        this._afterImgGfx   = this.add.graphics().setDepth(2);
        this._fighterGfxArr = [];   // one entry per fighter, depth 3
        this._particleGfx   = this.add.graphics().setDepth(4);
        // Screen-space blast-zone guide (optional, cosmetic)
        this._bzGfx         = this.add.graphics().setDepth(5).setScrollFactor(0);

        // ---- Sub-systems ----
        this._platforms  = new PlatformSystem();
        this._particles  = new PhaserParticleSystem(this);
        this._afterImages = [];

        // ---- Keyboard input ----
        this._p1Keys = this._createKeyMap(C.KEYS_P1);
        this._p2Keys = this._createKeyMap(C.KEYS_P2);

        // ---- Global GameEffects shim (used by Fighter + Stickman) ----
        window.GameEffects = {
            shake:         (intensity, duration) => this._triggerShake(intensity, duration),
            flash:         (colorStr, duration)  => this._triggerFlash(colorStr, duration),
            zoom:          (target, duration)    => this._triggerEffectZoom(target, duration),
            addAfterImage: (x, y, renderer, state) => this._addAfterImage(x, y, renderer, state),
            addShockwave:  (x, y, size)          => this._particles.spawnShockwave(x, y, size),
        };

        // ---- Build fighters ----
        this._buildFighters();

        // ---- Camera setup ----
        this._setupCamera();

        // ---- Draw static background once to a texture ----
        this._buildBackgroundTexture();

        // ---- Keyboard pause toggle ----
        this.input.keyboard.on('keydown-ESC', this._togglePause, this);
        this.input.keyboard.on('keydown-P',   this._togglePause, this);

        // ---- Resume AudioContext on first key press (browser policy) ----
        this.input.keyboard.on('keydown', () => Audio.resume && Audio.resume());

        // ---- Prevent arrow keys from scrolling the browser window ----
        const KC = Phaser.Input.Keyboard.KeyCodes;
        this.input.keyboard.addCapture([KC.UP, KC.DOWN, KC.LEFT, KC.RIGHT, KC.SPACE]);

        // ---- Game-level events from DOM buttons ----
        this.game.events.on('game:resume', this._resumeFromPause, this);
        this.game.events.on('game:exit',   this._exitToMenu,      this);

        // ---- Fight start countdown ----
        UI.flashFightStart('FIGHT!', 1000);
        this.time.delayedCall(1000, () => {
            this.roundPaused = false;
            Audio.playRoundStart();
        });
    }

    // =========================================================
    //  Phaser update — called every frame
    // =========================================================
    update(time, delta) {
        // Always render (so pause screen shows correctly)
        this._render();

        if (this.roundPaused || this.isPaused || this.matchOver) return;

        this._updateInput();
        this._updateBots(delta);
        this._updateFighters(delta);
        this._particles.update(delta);
        this._updateCamera(delta);
        this._checkMatchOver();

        // HUD
        if (this.fighters.length >= 2) {
            UI.updateDamage(this.fighters.slice(0, 2));
            UI.updateStocks(this.fighters.slice(0, 2));
            UI.updateEnergy(this.fighters.slice(0, 2));
        }
    }

    // =========================================================
    //  shutdown — clean up when scene stops
    // =========================================================
    shutdown() {
        // Remove game-level event listeners to avoid stacking
        this.game.events.off('game:resume', this._resumeFromPause, this);
        this.game.events.off('game:exit',   this._exitToMenu,      this);
        // Clear GameEffects reference
        window.GameEffects = null;
    }

    // =========================================================
    //  Fighter Construction
    // =========================================================
    _buildFighters() {
        const C   = CONFIG;
        const PRESETS = [
            { color: C.P1_COLOR, shadow: C.P1_SHADOW },
            { color: C.P2_COLOR, shadow: C.P2_SHADOW },
            { color: C.P3_COLOR, shadow: C.P3_SHADOW },
            { color: C.P4_COLOR, shadow: C.P4_SHADOW },
        ];

        const make = (idx, x, facingRight, isPlayer, keyMap, preset, team, diff) => {
            const resolvedKeyMap = keyMap || C.KEYS_P1;
            const f = new Fighter({
                scene: this,
                id: idx + 1, x, y: C.PLATFORMS[0].y,
                color: preset.color, shadow: preset.shadow,
                facingRight, isPlayer,
                keyMap: resolvedKeyMap,
                team: team ?? idx,
            });
            f._name       = '';
            f._difficulty = diff || 0;
            f._keyMap     = resolvedKeyMap;  // explicit reference for input routing
            // Create per-fighter Graphics object
            const gfx = this.add.graphics().setDepth(3);
            this._fighterGfxArr.push(gfx);
            return f;
        };

        const { mode } = this;

        if (mode === '1v1') {
            const f0 = make(0, 300,  true,  true,  C.KEYS_P1, PRESETS[0], 0);
            const f1 = make(1, 980,  false, true,  C.KEYS_P2, PRESETS[1], 1);
            f0._name = 'PLAYER 1'; f1._name = 'PLAYER 2';
            this.fighters.push(f0, f1);

        } else if (mode === '1vAI') {
            const f0 = make(0, 300,  true,  true,  C.KEYS_P1, PRESETS[0], 0);
            const f1 = make(1, 980,  false, false, C.KEYS_P2, PRESETS[1], 1, 0.5);
            f0._name = 'PLAYER 1'; f1._name = 'CPU';
            this.fighters.push(f0, f1);
            this.bots.push({ fighter: f1, bot: new Bot(f1, 0.5) });

        } else if (mode === '2v2') {
            const f0 = make(0, 260,  true,  true,  C.KEYS_P1, PRESETS[0], 0);
            const f1 = make(1, 400,  true,  false, null,      PRESETS[2], 0, 0.45);
            const f2 = make(2, 880,  false, true,  C.KEYS_P2, PRESETS[1], 1);
            const f3 = make(3, 1020, false, false, null,      PRESETS[3], 1, 0.45);
            f0._name = 'PLAYER 1'; f1._name = 'ALLY';
            f2._name = 'PLAYER 2'; f3._name = 'FOE';
            this.fighters.push(f0, f1, f2, f3);
            this.bots.push({ fighter: f1, bot: new Bot(f1, 0.45) });
            this.bots.push({ fighter: f3, bot: new Bot(f3, 0.45) });

        } else if (mode === 'tournament' && this.tournamentMatch) {
            const { p1, p2 } = this.tournamentMatch;
            const f0 = make(0, 360, true,  p1.isPlayer, C.KEYS_P1,
                            { color: p1.color, shadow: p1.shadow }, 0, p1.difficulty);
            const f1 = make(1, 920, false, p2.isPlayer, C.KEYS_P2,
                            { color: p2.color, shadow: p2.shadow }, 1, p2.difficulty);
            f0._name = p1.name; f1._name = p2.name;
            this.fighters.push(f0, f1);
            if (!p1.isPlayer) this.bots.push({ fighter: f0, bot: new Bot(f0, p1.difficulty || 0.5) });
            if (!p2.isPlayer) this.bots.push({ fighter: f1, bot: new Bot(f1, p2.difficulty || 0.5) });
        }

        if (this.fighters.length >= 2) {
            UI.setNames(this.fighters[0]._name, this.fighters[1]._name);
        }
        const modeLabels = { '1v1': '2P VS', '1vAI': 'VS AI', '2v2': '2v2 TEAM', 'tournament': 'TOURNAMENT' };
        UI.setModeTag(modeLabels[mode] || mode);
        UI.updateStocks(this.fighters.slice(0, 2));
        UI.updateDamage(this.fighters.slice(0, 2));
        UI.updateEnergy(this.fighters.slice(0, 2));
    }

    // =========================================================
    //  Camera Setup
    // =========================================================
    _setupCamera() {
        const C   = CONFIG;
        const cam = this.cameras.main;

        // World bounds large enough for blast zones
        cam.setBounds(
            C.BLAST_LEFT  - 200,
            C.BLAST_TOP   - 200,
            (C.BLAST_RIGHT  - C.BLAST_LEFT)  + 400,
            (C.BLAST_BOTTOM - C.BLAST_TOP)   + 400
        );

        // Initial position: center of ground platform
        const gMid = C.PLATFORMS[0].x + C.PLATFORMS[0].w / 2;
        cam.setZoom(0.75);
        cam.scrollX = gMid - C.WIDTH  / (2 * 0.75);
        cam.scrollY = C.PLATFORMS[0].y - C.HEIGHT * 0.75 / 0.75;

        this._camTargetX = cam.scrollX;
        this._camTargetY = cam.scrollY;
        this._baseZoom   = 0.75;
    }

    _updateCamera(delta) {
        const C   = CONFIG;
        const cam = this.cameras.main;
        const live = this.fighters.filter(f => f.state !== 'dead' && !f._respawning);
        if (!live.length) return;

        // Bounding box of all live fighters
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const f of live) {
            if (f.x < minX) minX = f.x;
            if (f.x > maxX) maxX = f.x;
            if (f.y < minY) minY = f.y;
            if (f.y > maxY) maxY = f.y;
        }

        const pad  = C.CAM_PADDING;
        const boxW = (maxX - minX) + pad * 2;
        const boxH = (maxY - minY) + pad * 2;

        const zx = C.WIDTH  / Math.max(boxW, 1);
        const zy = C.HEIGHT / Math.max(boxH, 1);
        this._targetBaseZoom = Phaser.Math.Clamp(Math.min(zx, zy), C.CAM_MIN_ZOOM, C.CAM_MAX_ZOOM);

        const midX = (minX + maxX) / 2;
        const midY = (minY + maxY) / 2;
        const tz   = this._targetBaseZoom;
        this._camTargetX = midX - (C.WIDTH  / tz) / 2;
        this._camTargetY = midY - (C.HEIGHT / tz) / 2;

        const lp = C.CAM_LERP;
        this._baseZoom  += (this._targetBaseZoom - this._baseZoom)  * lp;
        this._effectZoom += (this._targetEffectZoom - this._effectZoom) * 0.08;

        cam.setZoom(this._baseZoom * this._effectZoom);
        cam.scrollX += (this._camTargetX - cam.scrollX) * lp;
        cam.scrollY += (this._camTargetY - cam.scrollY) * lp;
    }

    // =========================================================
    //  Camera Effects  (called via window.GameEffects)
    // =========================================================
    _triggerShake(intensity, duration) {
        // Phaser shake: duration ms, intensity is amplitude in pixels (0.0–1.0 normalized)
        this.cameras.main.shake(duration, intensity * 0.008);
    }

    _triggerFlash(colorStr, duration) {
        const [r, g, b] = _parseColorRGB(colorStr);
        this.cameras.main.flash(duration, r, g, b);
    }

    _triggerEffectZoom(target, duration) {
        this._targetEffectZoom = target;
        // Restore after duration
        this.time.delayedCall(duration, () => {
            this._targetEffectZoom = 1.0;
        });
    }

    _addAfterImage(x, y, renderer, state) {
        this._afterImages.push({
            renderer, state: Object.assign({}, state),
            life: 150, maxLife: 150,
        });
    }

    // =========================================================
    //  Input
    // =========================================================
    _createKeyMap(cfgMap) {
        const kb  = this.input.keyboard;
        const map = {};
        for (const [action, code] of Object.entries(cfgMap)) {
            map[action] = kb.addKey(_eventCodeToPhaserKey(code));
        }
        return map;
    }

    _readKeyMap(phaserKeyMap) {
        const isDown = k => k && k.isDown;
        return {
            left:  isDown(phaserKeyMap.left),
            right: isDown(phaserKeyMap.right),
            up:    isDown(phaserKeyMap.up),
            down:  isDown(phaserKeyMap.down),
            light: isDown(phaserKeyMap.light),
            heavy: isDown(phaserKeyMap.heavy),
            dodge: isDown(phaserKeyMap.dodge),
        };
    }

    _updateInput() {
        for (const f of this.fighters) {
            if (!f.isPlayer) continue;
            const km = (f._keyMap === CONFIG.KEYS_P2) ? this._p2Keys : this._p1Keys;
            f.setInput(this._readKeyMap(km));
        }
    }

    _updateBots(delta) {
        for (const { fighter, bot } of this.bots) {
            const opponents = this.fighters.filter(
                o => o.team !== fighter.team && !o._respawning && o.state !== 'dead'
            );
            bot.update(delta, opponents);
        }
    }

    _updateFighters(delta) {
        for (const f of this.fighters) {
            const opponents = this.fighters.filter(o => o !== f);
            f.update(delta, opponents, this._platforms, this._particles);
        }
    }

    // =========================================================
    //  Win Condition
    // =========================================================
    _checkMatchOver() {
        if (this.matchOver) return;
        const { mode } = this;

        if (mode === '2v2') {
            const t0Dead = this.fighters.filter(f => f.team === 0).every(f => f.stocks <= 0);
            const t1Dead = this.fighters.filter(f => f.team === 1).every(f => f.stocks <= 0);
            if (!t0Dead && !t1Dead) return;

            this.matchOver   = true;
            this.roundPaused = true;
            const winTeam = t0Dead ? 1 : 0;
            this._showResult(
                winTeam === 0 ? 'VICTORY!' : 'DEFEAT!',
                winTeam === 0 ? 'TEAM 1 WINS!' : 'TEAM 2 WINS!',
                () => this._restartMatch(),
                () => this._exitToMenu()
            );
        } else {
            const f0 = this.fighters[0], f1 = this.fighters[1];
            if (!f0 || !f1) return;
            if (f0.stocks > 0 && f1.stocks > 0) return;

            this.matchOver   = true;
            this.roundPaused = true;
            const p1Won = f1.stocks <= 0;
            const title = p1Won
                ? 'KO! ' + f0._name + ' WINS!'
                : 'KO! ' + f1._name + ' WINS!';

            if (mode === 'tournament' && this.tournament) {
                const side = p1Won ? 0 : 1;
                UI.showRoundResult(
                    p1Won ? 'VICTORY!' : 'DEFEAT!', title,
                    () => {
                        this.tournament.recordWinner(side);
                        if (this.tournament.isOver()) {
                            this._onTournamentEnd();
                        } else {
                            // Return to MenuScene with tournament to show bracket
                            this.scene.start('MenuScene', {
                                tournament:  this.tournament,
                                showBracket: true,
                            });
                        }
                    },
                    () => {
                        this.tournament = null;
                        this._exitToMenu();
                    }
                );
            } else {
                this._showResult(
                    p1Won ? 'VICTORY!' : 'DEFEAT!',
                    title,
                    () => this._restartMatch(),
                    () => this._exitToMenu()
                );
            }
        }
    }

    _onTournamentEnd() {
        const champ = this.tournament.champion();
        UI.showTournamentWin(
            (champ ? champ.name : 'Someone') + ' is the CHAMPION!',
            () => {
                this.tournament = null;
                this._exitToMenu();
            }
        );
    }

    _showResult(title, subtitle, onContinue, onMenu) {
        UI.showRoundResult(title, subtitle, onContinue, onMenu);
    }

    _restartMatch() {
        // Restart GameScene with the same mode (no tournament data needed for rematch)
        this.scene.start('GameScene', {
            mode:       this.mode === 'tournament' ? '1vAI' : this.mode,
            tournament: null,
        });
    }

    _exitToMenu() {
        UI.showScreen('menu');
        document.getElementById('overlay-pause').classList.add('hidden');
        this.scene.start('MenuScene', { tournament: null });
    }

    // =========================================================
    //  Pause
    // =========================================================
    _togglePause() {
        if (this.matchOver || this.roundPaused) return;
        this.isPaused = !this.isPaused;
        const ov = document.getElementById('overlay-pause');
        if (this.isPaused) {
            ov.classList.remove('hidden');
            this.scene.pause();   // Pauses updates AND Phaser timers
        } else {
            this._resumeFromPause();
        }
    }

    _resumeFromPause() {
        this.isPaused = false;
        document.getElementById('overlay-pause').classList.add('hidden');
        this.scene.resume();
    }

    // =========================================================
    //  Background Texture (created once, displayed as static image)
    // =========================================================
    _buildBackgroundTexture() {
        const W = CONFIG.WIDTH, H = CONFIG.HEIGHT;
        const key = 'stageBg';

        if (!this.textures.exists(key)) {
            const ct = this.textures.createCanvas(key, W, H);
            const ctx = ct.getContext();

            // Gradient sky
            const g = ctx.createLinearGradient(0, 0, 0, H);
            g.addColorStop(0,   '#080818');
            g.addColorStop(0.5, '#0d0d28');
            g.addColorStop(1,   '#120820');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);

            // Stars (deterministic)
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            for (let i = 0; i < 80; i++) {
                const sx = ((i * 173 + 37) % W);
                const sy = ((i * 97  + 19) % (H * 0.55));
                const r  = (i % 3 === 0) ? 1.2 : 0.6;
                ctx.globalAlpha = 0.3 + (i % 5) * 0.1;
                ctx.beginPath();
                ctx.arc(sx, sy, r, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;

            // City silhouette
            const buildings = [
                {x:0,   w:70,  h:220},{x:80,  w:45,  h:170},{x:135, w:90,  h:270},
                {x:235, w:60,  h:200},{x:305, w:38,  h:145},{x:355, w:75,  h:235},
                {x:450, w:55,  h:185},{x:515, w:95,  h:280},{x:625, w:50,  h:160},
                {x:685, w:70,  h:225},{x:770, w:55,  h:195},{x:840, w:88,  h:250},
                {x:940, w:60,  h:175},{x:1010,w:50,  h:155},{x:1075,w:80,  h:240},
                {x:1165,w:55,  h:180},{x:1230,w:50,  h:160},
            ];
            const gy = CONFIG.PLATFORMS[0].y;
            ctx.fillStyle = 'rgba(18,18,45,0.8)';
            buildings.forEach(b => ctx.fillRect(b.x, gy - b.h, b.w, b.h));

            ct.refresh();
        }

        // Display as screen-fixed image (setScrollFactor(0) = not affected by camera)
        this.add.image(0, 0, key).setOrigin(0, 0).setDepth(0).setScrollFactor(0);
    }

    // =========================================================
    //  Render (called every frame)
    // =========================================================
    _render() {
        this._platGfx.clear();
        this._afterImgGfx.clear();
        this._particleGfx.clear();
        for (const g of this._fighterGfxArr) g.clear();

        // Platforms
        this._platforms.draw(this._platGfx);

        // After-images (dodge trail)
        this._drawAfterImages();

        // Fighters  (Fighter.draw handles respawn / flicker logic)
        for (let i = 0; i < this.fighters.length; i++) {
            this.fighters[i].draw(this._fighterGfxArr[i]);
        }

        // Particles
        this._particles.draw(this._particleGfx);

        // Blast-zone indicator lines (screen space)
        this._drawBlastZones();
    }

    _drawAfterImages() {
        const g = this._afterImgGfx;
        for (let i = this._afterImages.length - 1; i >= 0; i--) {
            const ai = this._afterImages[i];
            ai.life -= 16.667;
            if (ai.life <= 0) { this._afterImages.splice(i, 1); continue; }
            // Encode the desired alpha into the state snapshot so Stickman can
            // apply it per-draw-command via lineStyle alpha (works in WebGL).
            ai.state.dimAlpha = (ai.life / ai.maxLife) * 0.4;
            ai.renderer.draw(g, ai.state);
        }
    }

    _drawBlastZones() {
        const C   = CONFIG;
        const cam = this.cameras.main;
        const g   = this._bzGfx;
        g.clear();

        // Convert world coords → screen coords manually for the screen-fixed gfx
        const toSX = wx => (wx - cam.scrollX) * cam.zoom;
        const toSY = wy => (wy - cam.scrollY) * cam.zoom;

        g.lineStyle(1, 0xff3c3c, 0.15);
        g.setLineDash && g.setLineDash([6, 10]); // only in canvas renderer

        const sx_L = toSX(C.BLAST_LEFT);
        const sx_R = toSX(C.BLAST_RIGHT);
        const sy_B = toSY(C.BLAST_BOTTOM);

        g.beginPath(); g.moveTo(sx_L, 0);          g.lineTo(sx_L, C.HEIGHT); g.strokePath();
        g.beginPath(); g.moveTo(sx_R, 0);          g.lineTo(sx_R, C.HEIGHT); g.strokePath();
        g.beginPath(); g.moveTo(0,    sy_B);        g.lineTo(C.WIDTH, sy_B);  g.strokePath();
    }
}

// =========================================================
//  Utility: convert browser event.code → Phaser key identifier
//  Phaser addKey() accepts: letter string ('A'), key name ('LEFT'),
//  or integer key code.
// =========================================================
function _eventCodeToPhaserKey(code) {
    // Letters: 'KeyA' → integer 65 (char code of 'A')
    const letterMatch = code.match(/^Key([A-Z])$/);
    if (letterMatch) return letterMatch[1].charCodeAt(0);
    // Arrows
    const arrows = {
        ArrowLeft: Phaser.Input.Keyboard.KeyCodes.LEFT,
        ArrowRight: Phaser.Input.Keyboard.KeyCodes.RIGHT,
        ArrowUp:   Phaser.Input.Keyboard.KeyCodes.UP,
        ArrowDown:  Phaser.Input.Keyboard.KeyCodes.DOWN,
    };
    if (arrows[code] !== undefined) return arrows[code];
    // Numpad
    const numpad = {
        Numpad0: Phaser.Input.Keyboard.KeyCodes.NUMPAD_ZERO,
        Numpad1: Phaser.Input.Keyboard.KeyCodes.NUMPAD_ONE,
        Numpad2: Phaser.Input.Keyboard.KeyCodes.NUMPAD_TWO,
        Numpad3: Phaser.Input.Keyboard.KeyCodes.NUMPAD_THREE,
        Numpad4: Phaser.Input.Keyboard.KeyCodes.NUMPAD_FOUR,
        Numpad5: Phaser.Input.Keyboard.KeyCodes.NUMPAD_FIVE,
    };
    if (numpad[code] !== undefined) return numpad[code];
    // Space
    if (code === 'Space') return Phaser.Input.Keyboard.KeyCodes.SPACE;
    // Digits
    const digitMatch = code.match(/^Digit(\d)$/);
    if (digitMatch) return digitMatch[1].charCodeAt(0);
    // Unknown — let Phaser try to interpret it as-is
    return code;
}

// =========================================================
//  Utility: parse CSS color string → [r, g, b] (0-255)
// =========================================================
function _parseColorRGB(str) {
    if (!str) return [255, 255, 255];
    const m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
    if (str.startsWith('#')) {
        const n = parseInt(str.replace('#', ''), 16);
        return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    }
    return [255, 255, 255];
}
