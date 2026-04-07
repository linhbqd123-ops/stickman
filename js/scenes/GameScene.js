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
        this.mode = data.mode || '1vAI';
        this.mapKey = data.mapKey || CONFIG.DEFAULT_MAP;
        this.tournament = data.tournament || null;
        this.tournamentMatch = data.tournamentMatch || null;
        this.online = !!(data.online);
        this.netConfig = data.netConfig || null;
        // Online networking state (reset on each scene start)
        this._latestSnapshot = null;
        this._netFrameTick = 0;
        this._lastSentInput = null;
        this._prevSnapshot = null;  // delta compression baseline
    }

    // =========================================================
    //  preload — load map-specific assets before create()
    // =========================================================
    preload() {
        const mapDef = CONFIG.MAPS && CONFIG.MAPS[this.mapKey];
        if (!mapDef) return;

        // Background image
        const bgKey = `bg_${this.mapKey}`;
        if (mapDef.bgImagePath && !this.textures.exists(bgKey)) {
            this.load.image(bgKey, mapDef.bgImagePath);
        }

        // Platform images — load each unique imageKey once
        const loaded = new Set();
        for (const plat of mapDef.platforms) {
            if (plat.imageKey && plat.imagePath && !loaded.has(plat.imageKey)) {
                if (!this.textures.exists(plat.imageKey)) {
                    this.load.image(plat.imageKey, plat.imagePath);
                }
                loaded.add(plat.imageKey);
            }
        }
    }

    // =========================================================
    //  create
    // =========================================================
    create() {
        const C = CONFIG;

        // ---- Resolve active map definition ----
        this._mapDef = (CONFIG.MAPS && CONFIG.MAPS[this.mapKey]) || {
            platforms: CONFIG.PLATFORMS,
            canvasWidth: C.WIDTH,
            canvasHeight: C.HEIGHT,
            bgImagePath: null,
            randomPlatformMovement: { enabled: false },
        };

        // ---- State ----
        this.fighters = [];
        this.bots = [];
        this.matchOver = false;
        this.roundPaused = true;
        this.isPaused = false;

        // ---- Camera effect multipliers ----
        this._baseZoom = 0.75;   // auto-follow zoom (lerped)
        this._targetBaseZoom = 0.75;
        this._effectZoom = 1.0;    // transient hit-effect zoom
        this._targetEffectZoom = 1.0;
        this._camTargetX = 0;
        this._camTargetY = 0;

        // ---- Graphics layers (sorted by depth) ----
        // World-space objects (move with camera)
        this._platGfx = this.add.graphics().setDepth(1);
        this._afterImgGfx = this.add.graphics().setDepth(2);
        this._fighterGfxArr = [];   // one entry per fighter, depth 3
        this._particleGfx = this.add.graphics().setDepth(4);
        this._skillGfx = this.add.graphics().setDepth(2.5);
        // Screen-space blast-zone guide (optional, cosmetic)
        this._bzGfx = this.add.graphics().setDepth(5).setScrollFactor(0);

        // ---- Skill items (orbs that spawn on platforms) ----
        this._skillItems = [];

        // ---- Sub-systems ----
        this._platforms = new PlatformSystem(this, this.mapKey);
        this._particles = new PhaserParticleSystem(this);
        this._afterImages = [];

        // ---- Keyboard input ----
        this._p1Keys = this._createKeyMap(C.KEYS_P1);
        this._p2Keys = this._createKeyMap(C.KEYS_P2);

        // ---- Global GameEffects shim (used by Fighter + Stickman) ----
        window.GameEffects = {
            shake: (intensity, duration) => this._triggerShake(intensity, duration),
            flash: (colorStr, duration) => this._triggerFlash(colorStr, duration),
            zoom: (target, duration) => this._triggerEffectZoom(target, duration),
            addAfterImage: (x, y, renderer, state) => this._addAfterImage(x, y, renderer, state),
            addShockwave: (x, y, size) => this._particles.spawnShockwave(x, y, size),
        };

        // ---- Build fighters ----
        this._buildFighters();

        // ---- Camera setup ----
        this._setupCamera();

        // ---- Draw static background once to a texture ----
        this._buildBackgroundTexture();

        // ---- Keyboard pause toggle ----
        this.input.keyboard.on('keydown-ESC', this._togglePause, this);
        this.input.keyboard.on('keydown-P', this._togglePause, this);

        // ---- Resume AudioContext on first key press (browser policy) ----
        this.input.keyboard.on('keydown', () => Audio.resume && Audio.resume());

        // ---- Prevent arrow keys from scrolling the browser window ----
        const KC = Phaser.Input.Keyboard.KeyCodes;
        this.input.keyboard.addCapture([KC.UP, KC.DOWN, KC.LEFT, KC.RIGHT, KC.SPACE]);

        // ---- Game-level events from DOM buttons ----
        this.game.events.on('game:resume', this._resumeFromPause, this);
        this.game.events.on('game:exit', this._exitToMenu, this);

        // ---- Skill item spawn timer (first ~8 s in, then every SKILL_SPAWN_INTERVAL) ----
        this.time.addEvent({
            delay: CONFIG.SKILL_SPAWN_INTERVAL,
            repeat: -1,
            callback: this._spawnSkillItem,
            callbackScope: this,
            startAt: CONFIG.SKILL_SPAWN_INTERVAL - 8000,
        });

        // ---- Fight start countdown ----
        UI.flashFightStart('FIGHT!', 1000);
        this.time.delayedCall(1000, () => {
            this.roundPaused = false;
            Audio.playRoundStart();
        });

        // ---- Online — wire network callbacks for the match ----
        if (this.online) this._setupOnlineCallbacks();
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
        this._platforms.update(delta);
        this._particles.update(delta);
        this._updateSkillItems(delta);
        this._updateCamera(delta);
        this._checkMatchOver();

        // ---- Online networking ----
        if (this.online) {
            if (Net.role === 'host') {
                // Broadcast authoritative state to all clients at ~15 Hz (every 4 frames @ 60 FPS)
                this._netFrameTick++;
                if (this._netFrameTick % 4 === 0) {
                    const snap = this._makeSnapshot();
                    if (snap) Net.broadcastState(snap); // null = nothing changed, skip send
                }
            } else if (Net.role === 'client') {
                // Send local input to host (change-only throttle)
                this._sendLocalInput();
                // Apply latest received server snapshot to remote fighters
                if (this._latestSnapshot) this._applySnapshot(this._latestSnapshot);
            }
        }

        // HUD
        if (this.fighters.length >= 2) {
            UI.updateDamage(this.fighters);
            UI.updateStocks(this.fighters);
            UI.updateEnergy(this.fighters);
        }
    }

    // =========================================================
    //  shutdown — clean up when scene stops
    // =========================================================
    shutdown() {
        // Destroy platform image objects
        if (this._platforms) this._platforms.destroy();
        // Remove game-level event listeners to avoid stacking
        this.game.events.off('game:resume', this._resumeFromPause, this);
        this.game.events.off('game:exit', this._exitToMenu, this);
        // Clear GameEffects reference
        window.GameEffects = null;
        // Clear online callbacks so they don't fire after scene death
        if (this.online) {
            Net.onInputReceived = null;
            Net.onStateReceived = null;
            Net.onHostDisconnect = null;
            Net.onError = null;
        }
    }

    // =========================================================
    //  Fighter Construction
    // =========================================================
    _buildFighters() {
        const C = CONFIG;
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
                id: idx + 1, x, y: this._mapDef.platforms[0].y,
                color: preset.color, shadow: preset.shadow,
                facingRight, isPlayer,
                keyMap: resolvedKeyMap,
                team: team ?? idx,
            });
            f._name = '';
            f._difficulty = diff || 0;
            f._keyMap = resolvedKeyMap;  // explicit reference for input routing
            // Create per-fighter Graphics object
            const gfx = this.add.graphics().setDepth(3);
            this._fighterGfxArr.push(gfx);
            return f;
        };

        const { mode } = this;

        if (this.online && this.netConfig) {
            // ============================================================
            //  ONLINE MODE — build fighters from lobby player list
            // ============================================================
            const SPAWN_POS = [
                { x: 300, fr: true },   // slot 0
                { x: 980, fr: false },   // slot 1
                { x: 520, fr: false },   // slot 2 (2v2)
                { x: 760, fr: true },   // slot 3 (2v2)
            ];
            const players = this.netConfig.players || [];
            players.forEach((p, i) => {
                const sp = SPAWN_POS[i] || SPAWN_POS[i % 2];
                const isLocal = p.id === (Net.localPlayer?.id ?? 1);
                const f = make(i, sp.x, sp.fr, isLocal, C.KEYS_P1,
                    PRESETS[i % 4], p.team ?? (i % 2));
                f._name = p.name;
                f._netPlayerId = p.id;
                f._isLocalNet = isLocal;
                if (!isLocal) {
                    f.setInput({
                        left: false, right: false, up: false,
                        down: false, light: false, heavy: false, dodge: false
                    });
                }
                this.fighters.push(f);
            });

        } else if (mode === '1v1') {
            const f0 = make(0, 300, true, true, C.KEYS_P1, PRESETS[0], 0);
            const f1 = make(1, 980, false, true, C.KEYS_P2, PRESETS[1], 1);
            f0._name = 'PLAYER 1'; f1._name = 'PLAYER 2';
            this.fighters.push(f0, f1);

        } else if (mode === '1vAI') {
            const f0 = make(0, 300, true, true, C.KEYS_P1, PRESETS[0], 0);
            const f1 = make(1, 980, false, false, C.KEYS_P2, PRESETS[1], 1, 0.5);
            f0._name = 'PLAYER 1'; f1._name = 'CPU';
            this.fighters.push(f0, f1);
            this.bots.push({ fighter: f1, bot: new Bot(f1, 0.5) });

        } else if (mode === '2v2') {
            const f0 = make(0, 260, true, true, C.KEYS_P1, PRESETS[0], 0);
            const f1 = make(1, 400, true, false, null, PRESETS[2], 0, 0.45);
            const f2 = make(2, 880, false, true, C.KEYS_P2, PRESETS[1], 1);
            const f3 = make(3, 1020, false, false, null, PRESETS[3], 1, 0.45);
            f0._name = 'PLAYER 1'; f1._name = 'ALLY';
            f2._name = 'PLAYER 2'; f3._name = 'FOE';
            this.fighters.push(f0, f1, f2, f3);
            this.bots.push({ fighter: f1, bot: new Bot(f1, 0.45) });
            this.bots.push({ fighter: f3, bot: new Bot(f3, 0.45) });

        } else if (mode === 'tournament' && this.tournamentMatch) {
            const { p1, p2 } = this.tournamentMatch;
            const f0 = make(0, 360, true, p1.isPlayer, C.KEYS_P1,
                { color: p1.color, shadow: p1.shadow }, 0, p1.difficulty);
            const f1 = make(1, 920, false, p2.isPlayer, C.KEYS_P2,
                { color: p2.color, shadow: p2.shadow }, 1, p2.difficulty);
            f0._name = p1.name; f1._name = p2.name;
            this.fighters.push(f0, f1);
            if (!p1.isPlayer) this.bots.push({ fighter: f0, bot: new Bot(f0, p1.difficulty || 0.5) });
            if (!p2.isPlayer) this.bots.push({ fighter: f1, bot: new Bot(f1, p2.difficulty || 0.5) });
        }

        if (this.fighters.length >= 2) {
            UI.setNames(
                this.fighters[0]?._name, this.fighters[1]?._name,
                this.fighters[2]?._name, this.fighters[3]?._name
            );
        }
        const modeLabels = { '1v1': '2P VS', '1vAI': 'VS AI', '2v2': '2v2 TEAM', 'tournament': 'TOURNAMENT' };
        UI.setModeTag(this.online ? 'ONLINE' : (modeLabels[mode] || mode));
        UI.setHudPlayers(this.fighters.length);
        UI.updateStocks(this.fighters);
        UI.updateDamage(this.fighters);
        UI.updateEnergy(this.fighters);
    }

    // =========================================================
    //  Camera Setup
    // =========================================================
    _setupCamera() {
        const C = CONFIG;
        const cam = this.cameras.main;
        const ground = this._mapDef.platforms[0];

        // World bounds large enough for blast zones
        cam.setBounds(
            C.BLAST_LEFT - 200,
            C.BLAST_TOP - 200,
            (C.BLAST_RIGHT - C.BLAST_LEFT) + 400,
            (C.BLAST_BOTTOM - C.BLAST_TOP) + 400
        );

        // Initial position: center of ground platform
        const gMid = ground.x + ground.w / 2;
        cam.setZoom(0.75);
        cam.scrollX = gMid - C.WIDTH / (2 * 0.75);
        cam.scrollY = ground.y - C.HEIGHT * 0.75 / 0.75;

        this._camTargetX = cam.scrollX;
        this._camTargetY = cam.scrollY;
        this._baseZoom = 0.75;
    }

    _updateCamera(delta) {
        const C = CONFIG;
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

        const pad = C.CAM_PADDING;
        const boxW = (maxX - minX) + pad * 2;
        const boxH = (maxY - minY) + pad * 2;

        const zx = C.WIDTH / Math.max(boxW, 1);
        const zy = C.HEIGHT / Math.max(boxH, 1);
        this._targetBaseZoom = Phaser.Math.Clamp(Math.min(zx, zy), C.CAM_MIN_ZOOM, C.CAM_MAX_ZOOM);

        const midX = (minX + maxX) / 2;
        const midY = (minY + maxY) / 2;
        const tz = this._targetBaseZoom;
        this._camTargetX = midX - (C.WIDTH / tz) / 2;
        this._camTargetY = midY - (C.HEIGHT / tz) / 2;

        const lp = C.CAM_LERP;
        this._baseZoom += (this._targetBaseZoom - this._baseZoom) * lp;
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
        const kb = this.input.keyboard;
        const map = {};
        for (const [action, code] of Object.entries(cfgMap)) {
            map[action] = kb.addKey(_eventCodeToPhaserKey(code));
        }
        return map;
    }

    _readKeyMap(phaserKeyMap) {
        const isDown = k => k && k.isDown;
        return {
            left: isDown(phaserKeyMap.left),
            right: isDown(phaserKeyMap.right),
            up: isDown(phaserKeyMap.up),
            down: isDown(phaserKeyMap.down),
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
            // Online client: remote fighters are driven by server snapshots.
            // Only advance the animation tick locally so they render smoothly
            // between server updates. Full physics runs only on host.
            if (this.online && Net.role === 'client' && !f._isLocalNet) {
                f.tick += delta / 16.667;
                if (f.invTimer > 0) f.invTimer -= delta;
                if (f.hurtTimer > 0) f.hurtTimer -= delta;
                // Adaptive lerp toward server-authoritative position.
                // Larger distance → faster catch-up; very close → barely moves
                // so the fighter doesn't jitter when already accurate.
                if (f._interpTarget) {
                    const dx = f._interpTarget.x - f.x;
                    const dy = f._interpTarget.y - f.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const t = dist > 120 ? 0.55 : (dist > 30 ? 0.35 : 0.15);
                    f.x += dx * t;
                    f.y += dy * t;
                }
                continue;
            }
            const opponents = this.fighters.filter(o => o !== f);
            f.update(delta, opponents, this._platforms, this._particles);
        }
    }

    // =========================================================
    //  Skill Items — spawning, collection, rendering
    // =========================================================
    _spawnSkillItem() {
        if (this.matchOver) return;
        if (this._skillItems.length >= 3) return;   // max 3 active at once

        // Use live platform positions (includes moving platforms)
        const plats = this._platforms.platforms;
        // Prefer floating platforms (index 1+); fall back to ground if only one
        const pool = plats.length > 1 ? plats.slice(1) : plats;
        const plat = pool[Math.floor(Math.random() * pool.length)];
        const x = plat.x + plat.w * (0.25 + Math.random() * 0.5);
        const y = plat.y - CONFIG.SKILL_RADIUS - 6;
        const keys = Object.keys(CONFIG.SKILLS);
        const skillKey = keys[Math.floor(Math.random() * keys.length)];
        this._skillItems.push({ x, y, skillKey, lifetime: CONFIG.SKILL_LIFETIME, animTick: 0 });
    }

    _updateSkillItems(dt) {
        const R = CONFIG.SKILL_RADIUS + 20;   // collection radius (slightly larger than visual)
        this._skillItems = this._skillItems.filter(item => {
            item.lifetime -= dt;
            item.animTick += dt / 16.667;
            if (item.lifetime <= 0) return false;
            for (const f of this.fighters) {
                if (f.state === 'dead' || f._respawning) continue;
                if (f.collectedSkill) continue;       // already holds a skill
                const dx = f.x - item.x;
                const dy = (f.y - 45) - item.y;      // offset to fighter torso centre
                if (dx * dx + dy * dy < R * R) {
                    f.collectSkill(item.skillKey);
                    return false;                     // item consumed
                }
            }
            return true;
        });
    }

    _renderSkillItems() {
        const g = this._skillGfx;
        for (const item of this._skillItems) {
            const s = CONFIG.SKILLS[item.skillKey];
            const sc = parseInt(s.color.replace('#', ''), 16);
            const R = CONFIG.SKILL_RADIUS;
            const fadeFrac = Math.min(1, item.lifetime / 3000);  // fade in last 3 s
            const pulse = 0.55 + Math.sin(item.animTick * 3.5) * 0.45;
            const bob = Math.sin(item.animTick * 2.2) * 4;  // gentle vertical bob
            const iy = item.y + bob;

            // Outer glow halo
            g.lineStyle(4, sc, 0.18 * fadeFrac);
            g.strokeCircle(item.x, iy, R + 9);
            // Main ring
            g.lineStyle(2, sc, pulse * 0.85 * fadeFrac);
            g.strokeCircle(item.x, iy, R);
            // Core fill
            g.fillStyle(sc, pulse * 0.85 * fadeFrac);
            g.fillCircle(item.x, iy, R * 0.60);
            // Inner bright centre
            g.fillStyle(0xffffff, pulse * 0.45 * fadeFrac);
            g.fillCircle(item.x, iy, R * 0.22);
            // Cross sparkle
            const cr = R * 0.32;
            g.lineStyle(1.5, 0xffffff, pulse * 0.55 * fadeFrac);
            g.beginPath(); g.moveTo(item.x - cr, iy); g.lineTo(item.x + cr, iy); g.strokePath();
            g.beginPath(); g.moveTo(item.x, iy - cr); g.lineTo(item.x, iy + cr); g.strokePath();
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

            this.matchOver = true;
            this.roundPaused = true;
            const winTeam = t0Dead ? 1 : 0;
            const localTeam = this.online ? (Net.localPlayer?.team ?? 0) : 0;
            this._showResult(
                winTeam === localTeam ? 'VICTORY!' : 'DEFEAT!',
                winTeam === 0 ? 'TEAM 1 WINS!' : 'TEAM 2 WINS!',
                () => this._restartMatch(),
                () => this._exitToMenu()
            );
        } else {
            const f0 = this.fighters[0], f1 = this.fighters[1];
            if (!f0 || !f1) return;
            if (f0.stocks > 0 && f1.stocks > 0) return;

            this.matchOver = true;
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
                                tournament: this.tournament,
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
                const winnerF = p1Won ? f0 : f1;
                const headline = this.online
                    ? (winnerF._isLocalNet ? 'VICTORY!' : 'DEFEAT!')
                    : (p1Won ? 'VICTORY!' : 'DEFEAT!');
                this._showResult(
                    headline, title,
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
        if (this.online) {
            // Online rematch: return to lobby (Net connection is still live)
            this.scene.start('MenuScene', { tournament: null, backToLobby: true });
            return;
        }
        // Restart GameScene with the same mode (no tournament data needed for rematch)
        this.scene.start('GameScene', {
            mode: this.mode === 'tournament' ? '1vAI' : this.mode,
            mapKey: this.mapKey,
            tournament: null,
        });
    }

    _exitToMenu() {
        if (this.online) Net.disconnect();
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
    //  Background Texture — image if loaded, else procedural canvas
    // =========================================================
    _buildBackgroundTexture() {
        const C = CONFIG;
        const bgKey = `bg_${this.mapKey}`;

        // ---- Use loaded map image if available ----
        if (this.textures.exists(bgKey)) {
            this.add.image(C.WIDTH / 2, C.HEIGHT / 2, bgKey)
                .setDisplaySize(C.WIDTH, C.HEIGHT)
                .setDepth(0)
                .setScrollFactor(0);
            return;
        }

        // ---- Procedural fallback (themed per map) ----
        const W = C.WIDTH, H = C.HEIGHT;
        const key = `stageBg_${this.mapKey}`;

        if (!this.textures.exists(key)) {
            const ct  = this.textures.createCanvas(key, W, H);
            const ctx = ct.getContext();

            // Sky gradient — colours vary by map
            const skyColors = {
                naruto:      ['#1a0800', '#2a1000', '#1a0500'],
                dragonball:  ['#080018', '#10002a', '#0d001e'],
                fptsoftware: ['#000a14', '#001428', '#000814'],
            };
            const [c0, c1, c2] = skyColors[this.mapKey] || ['#080818', '#0d0d28', '#120820'];
            const g = ctx.createLinearGradient(0, 0, 0, H);
            g.addColorStop(0,   c0);
            g.addColorStop(0.5, c1);
            g.addColorStop(1,   c2);
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);

            // Stars
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

            // City silhouette — colour matches map theme
            const silColors = {
                naruto:      'rgba(30,12,0,0.8)',
                dragonball:  'rgba(12,0,28,0.8)',
                fptsoftware: 'rgba(0,10,20,0.8)',
            };
            const buildings = [
                { x: 0,    w: 70, h: 220 }, { x: 80,   w: 45, h: 170 }, { x: 135,  w: 90, h: 270 },
                { x: 235,  w: 60, h: 200 }, { x: 305,  w: 38, h: 145 }, { x: 355,  w: 75, h: 235 },
                { x: 450,  w: 55, h: 185 }, { x: 515,  w: 95, h: 280 }, { x: 625,  w: 50, h: 160 },
                { x: 685,  w: 70, h: 225 }, { x: 770,  w: 55, h: 195 }, { x: 840,  w: 88, h: 250 },
                { x: 940,  w: 60, h: 175 }, { x: 1010, w: 50, h: 155 }, { x: 1075, w: 80, h: 240 },
                { x: 1165, w: 55, h: 180 }, { x: 1230, w: 50, h: 160 },
            ];
            const gy = this._mapDef.platforms[0].y;
            ctx.fillStyle = silColors[this.mapKey] || 'rgba(18,18,45,0.8)';
            buildings.forEach(b => ctx.fillRect(b.x, gy - b.h, b.w, b.h));

            ct.refresh();
        }

        this.add.image(0, 0, key).setOrigin(0, 0).setDepth(0).setScrollFactor(0);
    }

    // =========================================================
    //  Render (called every frame)
    // =========================================================
    _render() {
        this._platGfx.clear();
        this._afterImgGfx.clear();
        this._particleGfx.clear();
        this._skillGfx.clear();
        for (const g of this._fighterGfxArr) g.clear();

        // Platforms
        this._platforms.draw(this._platGfx);

        // Wall-grab contact glow (rendered over platforms, behind fighters)
        this._renderWallGrabFX(this._platGfx);

        // Skill items (glowing orbs on platforms)
        this._renderSkillItems();

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

    // =========================================================
    //  Wall-grab contact glow — pulsing highlight on the platform wall
    //  face and a bright halo at the grip point for each clinging fighter.
    // =========================================================
    _renderWallGrabFX(g) {
        this._wallGrabPulse = ((this._wallGrabPulse || 0) + 0.055) % (Math.PI * 2);
        const pt = this._wallGrabPulse;

        for (const f of this.fighters) {
            if (f.state !== 'wallgrab' || !f.wallPlatform) continue;

            const plat   = f.wallPlatform;
            const isLeft = (f.wallDir > 0);  // fighter on the LEFT-SIDE face of platform
            const wallX  = isLeft ? plat.x : plat.x + plat.w;

            // Vertical contact band: centre on fighter body height, not feet
            const contactY = Phaser.Math.Clamp(
                f.y - 50, plat.y + 6, plat.y + plat.h - 6
            );

            // Fighter color as integer
            const fc = parseInt(f.color.replace('#', ''), 16);
            const pulse = 0.30 + Math.sin(pt * 3.5) * 0.20;

            // ── Glowing strip along the full height of the wall face ──
            g.fillStyle(fc, pulse * 0.22);
            g.fillRect(
                isLeft ? plat.x - 5 : plat.x + plat.w - 3,
                plat.y,
                8, plat.h
            );

            // ── Bright edge line on the wall surface ──
            g.lineStyle(2, fc, pulse * 0.75);
            g.beginPath();
            g.moveTo(wallX, plat.y);
            g.lineTo(wallX, plat.y + plat.h);
            g.strokePath();

            // ── Grip-point halo at hand contact height ──
            const haloR = 14 + Math.sin(pt * 4.5) * 3;
            g.lineStyle(2.5, fc, pulse * 0.85);
            g.beginPath();
            g.arc(wallX, contactY - 18, haloR, 0, Math.PI * 2);
            g.strokePath();
            g.fillStyle(fc, pulse * 0.45);
            g.fillCircle(wallX, contactY - 18, 5);

            // ── Secondary grip halo (lower hand) ──
            g.lineStyle(1.8, fc, pulse * 0.55);
            g.beginPath();
            g.arc(wallX, contactY + 8, haloR * 0.68, 0, Math.PI * 2);
            g.strokePath();

            // ── Crack-line sparks: tiny radiating lines from grip point ──
            const sparkCount = 5;
            g.lineStyle(1, fc, pulse * 0.40);
            for (let si = 0; si < sparkCount; si++) {
                const a   = (si / sparkCount) * Math.PI * 2 + pt;
                const sr  = 16 + Math.sin(pt * 6 + si) * 4;
                const ex  = wallX + Math.cos(a) * sr;
                const ey  = (contactY - 18) + Math.sin(a) * sr;
                g.beginPath();
                g.moveTo(wallX, contactY - 18);
                g.lineTo(ex, ey);
                g.strokePath();
            }
        }
    }

    // =========================================================
    //  Online — callbacks, snapshot, input relay
    // =========================================================

    /** Wire Net callbacks at the start of each online match. */
    _setupOnlineCallbacks() {
        if (Net.role === 'host') {
            // Host receives input events from every client
            Net.onInputReceived = (pid, input) => {
                const f = this.fighters.find(f => f._netPlayerId === pid);
                if (!f || f._isLocalNet) return;
                // Detect rising edges at receipt time and store them on the fighter.
                // This prevents jump/attack inputs from being silently dropped when
                // a key-down + key-up both arrive between the same two host frames
                // (setInput would overwrite _prevInput and erase the rising edge).
                for (const k of ['up', 'light', 'heavy', 'dodge']) {
                    if (!f.input[k] && input[k]) f['_netRise_' + k] = true;
                }
                f.setInput(input);
            };
        } else {
            // Client receives authoritative state from host
            Net.onStateReceived = snapshots => {
                this._latestSnapshot = snapshots;
            };
            Net.onHostDisconnect = () => this._onOnlineDisconnect();
        }
        Net.onError = err => {
            if (!this.matchOver) console.error('[GameScene Net]', err);
        };
    }

    /** Serialize all fighters into a compact snapshot for broadcast. */
    _makeSnapshot() {
        const now = this.fighters.map(f => ({
            npid: f._netPlayerId,
            x: Math.round(f.x),
            y: Math.round(f.y),
            vx: +f.vx.toFixed(2),
            vy: +f.vy.toFixed(2),
            fa: f.facing,
            st: f.state,
            atk: f.attackType,
            dmg: Math.round(f.damage),
            stk: f.stocks,
            eng: Math.round(f.energy),
            tk: Math.round(f.tick),
            inv: f.invTimer > 0 ? Math.round(f.invTimer) : 0,
            hrt: f.hurtTimer > 0 ? Math.round(f.hurtTimer) : 0,
            re: f._respawning ? 1 : 0,
            sk: f.collectedSkill || null,
        }));

        const prev = this._prevSnapshot;
        this._prevSnapshot = now;

        // First frame — always send full snapshot
        if (!prev) return now;

        // Subsequent frames — delta: only include fighters with changed fields
        const delta = [];
        for (let i = 0; i < now.length; i++) {
            const n = now[i], p = prev[i];
            if (!p || n.npid !== p.npid) { delta.push(n); continue; }

            const d = { npid: n.npid };
            let changed = false;
            const chk = (k, threshold = 0) => {
                if (threshold ? Math.abs(n[k] - p[k]) > threshold : n[k] !== p[k]) { d[k] = n[k]; changed = true; }
            };
            chk('x', 1); chk('y', 1); chk('vx', 0.1); chk('vy', 0.1);
            chk('fa'); chk('st'); chk('atk'); chk('dmg'); chk('stk'); chk('eng');
            chk('tk', 1);
            // Always include timers if either prev or now is non-zero
            if (n.inv > 0 || p.inv > 0) { d.inv = n.inv; changed = true; }
            if (n.hrt > 0 || p.hrt > 0) { d.hrt = n.hrt; changed = true; }
            chk('re'); chk('sk');

            if (changed) delta.push(d);
        }
        return delta.length > 0 ? delta : null; // null = nothing changed, skip broadcast
    }

    /** Apply a server snapshot (may be full or delta) to local fighter objects (client only). */
    _applySnapshot(snapshots) {
        for (const snap of snapshots) {
            const f = this.fighters.find(f => f._netPlayerId === snap.npid);
            if (!f) continue;

            if (f._isLocalNet) {
                // Always sync authoritative combat values.
                if (snap.dmg !== undefined) f.damage = snap.dmg;
                if (snap.stk !== undefined) f.stocks = snap.stk;
                if (snap.eng !== undefined) f.energy = snap.eng;

                // Hard-sync position + velocity only when truly necessary:
                //  • host says we were hit  (state='hurt' or hurtTimer > 0)
                //  • host says we respawned (re flag set)
                //  • enormous drift         (>250 px, e.g. blast-zone correction)
                // Otherwise trust local physics so jumps/movement feel instant
                // and double-jumps are never cancelled by a stale server position.
                const snapX = snap.x !== undefined ? snap.x : f.x;
                const snapY = snap.y !== undefined ? snap.y : f.y;
                const drift = Math.abs(f.x - snapX) + Math.abs(f.y - snapY);
                const isHurt = (snap.st === 'hurt') ||
                    (snap.hrt !== undefined && snap.hrt > 0);
                const isDead = !!(snap.re);
                if (isHurt || isDead || drift > 250) {
                    f.x = snapX; f.y = snapY;
                    if (snap.vx !== undefined) f.vx = snap.vx;
                    if (snap.vy !== undefined) f.vy = snap.vy;
                    if (snap.st !== undefined) f.state = snap.st;
                    if (snap.hrt !== undefined) f.hurtTimer = snap.hrt;
                    if (snap.inv !== undefined) f.invTimer = snap.inv;
                }
            } else {
                // Set interpolation target for position (smooth between 15Hz snapshots)
                if (snap.x !== undefined || snap.y !== undefined) {
                    f._interpTarget = f._interpTarget || { x: f.x, y: f.y };
                    if (snap.x !== undefined) f._interpTarget.x = snap.x;
                    if (snap.y !== undefined) f._interpTarget.y = snap.y;
                }
                // Hard-sync all other authoritative state
                if (snap.vx !== undefined) f.vx = snap.vx;
                if (snap.vy !== undefined) f.vy = snap.vy;
                if (snap.fa !== undefined) f.facing = snap.fa;
                if (snap.st !== undefined) f.state = snap.st;
                if (snap.atk !== undefined) f.attackType = snap.atk;
                if (snap.dmg !== undefined) f.damage = snap.dmg;
                if (snap.stk !== undefined) f.stocks = snap.stk;
                if (snap.eng !== undefined) f.energy = snap.eng;
                if (snap.tk !== undefined) f.tick = snap.tk;
                if (snap.inv !== undefined) f.invTimer = snap.inv;
                if (snap.hrt !== undefined) f.hurtTimer = snap.hrt;
                if (snap.re !== undefined) f._respawning = !!snap.re;
                if (snap.sk !== undefined) f.collectedSkill = snap.sk;
            }
        }
    }

    /** Client: read local keys and send to host, throttled to changes only. */
    _sendLocalInput() {
        const localF = this.fighters.find(f => f._isLocalNet);
        if (!localF) return;
        // Online local player always uses P1 key map
        const input = this._readKeyMap(this._p1Keys);
        const last = this._lastSentInput;
        if (last &&
            last.left === input.left && last.right === input.right &&
            last.up === input.up && last.down === input.down &&
            last.light === input.light && last.heavy === input.heavy &&
            last.dodge === input.dodge) return;
        Net.sendInput(input);
        this._lastSentInput = input;
    }

    /** Called when host disconnects mid-game (client only). */
    _onOnlineDisconnect() {
        if (this.matchOver) return;
        this.matchOver = true;
        this.roundPaused = true;
        UI.showRoundResult(
            'DISCONNECTED', 'Host disconnected from the game.',
            () => { Net.disconnect(); this._exitToMenu(); },
            () => { Net.disconnect(); this._exitToMenu(); }
        );
    }

    // =========================================================
    //  Blast Zone Overlay
    // =========================================================

    _drawBlastZones() {
        const C = CONFIG;
        const cam = this.cameras.main;
        const g = this._bzGfx;
        g.clear();

        // Convert world coords → screen coords manually for the screen-fixed gfx
        const toSX = wx => (wx - cam.scrollX) * cam.zoom;
        const toSY = wy => (wy - cam.scrollY) * cam.zoom;

        g.lineStyle(1, 0xff3c3c, 0.15);
        g.setLineDash && g.setLineDash([6, 10]); // only in canvas renderer

        const sx_L = toSX(C.BLAST_LEFT);
        const sx_R = toSX(C.BLAST_RIGHT);
        const sy_B = toSY(C.BLAST_BOTTOM);

        g.beginPath(); g.moveTo(sx_L, 0); g.lineTo(sx_L, C.HEIGHT); g.strokePath();
        g.beginPath(); g.moveTo(sx_R, 0); g.lineTo(sx_R, C.HEIGHT); g.strokePath();
        g.beginPath(); g.moveTo(0, sy_B); g.lineTo(C.WIDTH, sy_B); g.strokePath();
    }
}

// Expose scene class globally for ESM modules
window.GameScene = GameScene;

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
        ArrowUp: Phaser.Input.Keyboard.KeyCodes.UP,
        ArrowDown: Phaser.Input.Keyboard.KeyCodes.DOWN,
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
