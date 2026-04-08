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
        this.aiDifficulty = (data.aiDifficulty || 'medium').toLowerCase();
        this.tournament = data.tournament || null;
        this.tournamentMatch = data.tournamentMatch || null;
        this.online = !!(data.online);
        this.netConfig = data.netConfig || null;
        // Online networking state (reset on each scene start)
        this._latestSnapshot = null;
        this._newSnapshot = null;   // newly arrived snapshot, consumed once per frame
        this._netFrameTick = 0;
        this._lastSentInput = null;
        this._prevSnapshot = null;  // delta compression baseline

        const netCfg = (CONFIG && CONFIG.NET) || {};
        const stateHz = Math.max(10, Number(netCfg.STATE_HZ) || 30);
        const inputHz = Math.max(10, Number(netCfg.INPUT_HZ) || 30);
        this._netStateInterval = Math.round(1000 / stateHz);
        this._netInputInterval = Math.round(1000 / inputHz);
        this._forceFullStateEveryMs = Math.max(300, Number(netCfg.FULL_STATE_EVERY_MS) || 900);
        this._netStateAccum = 0;
        this._netInputAccum = 0;
        this._netFullStateTimer = 0;
        this._netStateSeq = 0;
        this._lastRecvStateSeq = 0;
        this._saitamaCastSeq = 0;
        this._netSaitamaCast = null;
        this._lastHandledSaitamaCastSeq = 0;
        this._specialSpawnScriptStarted = false;
        this._matchElapsedMs = 0;
        this._pendingInputEdges = { up: 0, light: 0, heavy: 0, dodge: 0, drop: 0 };
        this._inputEdgeTotals = { up: 0, light: 0, heavy: 0, dodge: 0, drop: 0 };
        // World snapshot optimisation: track whether world had content last tick.
        // Allows skipping the world portion of state packets when nothing is active.
        this._hadWorldContent = false;
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

        // Ultimate icons and special effect sprites are shared assets for all maps.
        const ultis = CONFIG.ULTIMATE_SKILLS || {};
        for (const [ultimateId, def] of Object.entries(ultis)) {
            if (!def || !def.iconFile) continue;
            const texKey = this._ultimateIconTextureKey(ultimateId);
            if (!this.textures.exists(texKey)) {
                this.load.image(texKey, this._mapAssetPath(def.iconFile));
            }
        }

        const fpt = ultis.fpt;
        if (fpt && fpt.meteorSpriteFile) {
            const meteorTex = this._meteorTextureKey();
            if (!this.textures.exists(meteorTex)) {
                this.load.image(meteorTex, this._mapAssetPath(fpt.meteorSpriteFile));
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

        // ---- Blast bounds (per-map override supported) ----
        // Map can define: blastLeft, blastRight, blastTop, blastBottom
        // If absent, fall back to global CONFIG.BLAST_* values.
        this._blastBounds = {
            left: (this._mapDef.blastLeft !== undefined) ? this._mapDef.blastLeft : CONFIG.BLAST_LEFT,
            right: (this._mapDef.blastRight !== undefined) ? this._mapDef.blastRight : CONFIG.BLAST_RIGHT,
            top: (this._mapDef.blastTop !== undefined) ? this._mapDef.blastTop : CONFIG.BLAST_TOP,
            bottom: (this._mapDef.blastBottom !== undefined) ? this._mapDef.blastBottom : CONFIG.BLAST_BOTTOM,
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
        this._skillBoxGfx = this.add.graphics().setDepth(2.6);   // V2 skill boxes
        this._projectileGfx = this.add.graphics().setDepth(3.5); // Yasuo/Kame projectiles
        this._meteorGfx = this.add.graphics().setDepth(3.4);      // FPT meteors
        this._overlayGfx = this.add.graphics().setDepth(10).setScrollFactor(0); // Saitama overlay
        this._debugGfx = this.add.graphics().setDepth(9);   // hitbox debug (world-space)
        this._dmgGfx = this.add.graphics().setDepth(8).setScrollFactor(0); // damage numbers (screen-space)
        // Screen-space blast-zone guide (optional, cosmetic)
        this._bzGfx = this.add.graphics().setDepth(5).setScrollFactor(0);

        // ---- Skill items (orbs that spawn on platforms) ----
        this._skillItems = [];
        // ---- V2 projectiles (Yasuo wind, Kamehameha beam) ----
        this._projectiles = [];
        this._projIdCounter = 0;
        // ---- V2 meteors (FPT ultimate) ----
        this._meteors = [];
        this._meteorIdCounter = 0;
        // ---- Saitama state ----
        this._saitamaOverlay = null;
        this._saitamaText = null;
        this._saitamaVideoEl = null;
        // ---- Damage number popups ----
        this._dmgNumbers = [];

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
            spawnDmgNumber: (wx, wy, amount, color) => this._spawnDmgNumber(wx, wy, amount, color),
        };

        // ---- V2 Skill Drop System ----
        this._skillBoxes = [];   // SkillBox objects (V2 ultimate items on map)
        this._skillBoxIdCounter = 0;
        window.SkillDropSystem = {
            dropFromFighter: (fighter) => this._dropUltimateFromFighter(fighter),
            spawnBox: (x, y, id) => this._spawnSkillBox(x, y, id),
            activeSaitamaCount: () => this._skillBoxes.filter(b => b.ultimateId === 'saitama').length,
        };

        // ---- V2 Ultimate System ----
        window.UltimateSystem = {
            fire: (id, fighter, opponents, particles, scene) =>
                this._executeUltimateV2(id, fighter, opponents, particles),
        };

        // ---- Build fighters ----
        this._buildFighters();
        this._applyUltimateDebugPreset();

        // ---- Camera setup ----
        this._setupCamera();

        // ---- Draw static background once to a texture ----
        this._buildBackgroundTexture();

        // ---- Keyboard pause toggle ----
        this.input.keyboard.on('keydown-ESC', this._togglePause, this);
        this.input.keyboard.on('keydown-P', this._togglePause, this);
        // ---- Hitbox debug toggle (press H) ----
        this._debugHitbox = false;
        this.input.keyboard.on('keydown-H', () => {
            this._debugHitbox = !this._debugHitbox;
            if (!this._debugHitbox && this._debugLabel) this._debugLabel.setVisible(false);
        }, this);

        // ---- Resume AudioContext on first key press (browser policy) ----
        this.input.keyboard.on('keydown', () => Audio.resume && Audio.resume());

        // ---- Prevent arrow keys from scrolling the browser window ----
        const KC = Phaser.Input.Keyboard.KeyCodes;
        this.input.keyboard.addCapture([KC.UP, KC.DOWN, KC.LEFT, KC.RIGHT, KC.SPACE]);

        // ---- Game-level events from DOM buttons ----
        this.game.events.on('game:resume', this._resumeFromPause, this);
        this.game.events.on('game:rematch', this._rematchFromPause, this);
        this.game.events.on('game:toggle-guide', this._togglePauseGuide, this);
        this.game.events.on('game:exit', this._exitToMenu, this);

        const authoritativeWorld = !this.online || Net.role === 'host';
        if (authoritativeWorld) {
            // Keep periodic random spawns for long matches.
            const skillSpawnInterval = CONFIG.SKILL_DROP.mapSpawnInterval || CONFIG.SKILL_SPAWN_INTERVAL;
            this.time.addEvent({
                delay: skillSpawnInterval,
                repeat: -1,
                callback: this._spawnRandomSkillBox,
                callbackScope: this,
                startAt: Math.max(0, skillSpawnInterval - 8000),
            });
        }

        // ---- Fight start countdown ----
        UI.flashFightStart('FIGHT!', 1000);
        this.time.delayedCall(1000, () => {
            this.roundPaused = false;
            Audio.playRoundStart();

            if (authoritativeWorld) this._startSpecialSpawnScript();
        });

        // ---- Online — wire network callbacks for the match ----
        if (this.online) this._setupOnlineCallbacks();
    }

    // =========================================================
    //  Phaser update — called every frame
    // =========================================================
    update(time, delta) {
        const blocked = this.roundPaused || this.isPaused || this.matchOver;
        if (blocked) {
            if (this.online && Net.role === 'client') {
                if (this._newSnapshot) {
                    const payload = this._newSnapshot;
                    if (payload.world) this._applyWorldSnapshot(payload.world);
                    if (payload.fighters) this._applySnapshot(payload.fighters);
                    this._newSnapshot = null;
                }
            } else if (this.online && Net.role === 'host') {
                this._hostBroadcastNetState(delta);
            }
            // Render while paused so overlays / pause screen display correctly.
            this._render();
            return;
        }

        this._updateInput();
        this._matchElapsedMs += delta;
        const isClientOnline = this.online && Net.role === 'client';

        if (isClientOnline) {
            // Client: host-authoritative simulation.
            this._sendLocalInput(delta);
            if (this._newSnapshot) {
                const payload = this._newSnapshot;
                if (payload.world) this._applyWorldSnapshot(payload.world);
                if (payload.fighters) this._applySnapshot(payload.fighters);
                this._newSnapshot = null;
            }

            this._updateFighters(delta);
            this._updateCamera(delta);
            this._checkMatchOver();
        } else {
            // Offline + host simulation (authoritative).
            this._updateBots(delta);
            this._updateFighters(delta);
            this._platforms.update(delta);
            this._particles.update(delta);
            this._updateSkillBoxes(delta);
            this._updateProjectiles(delta);
            this._updateMeteors(delta);
            this._updateCamera(delta);
            this._checkMatchOver();

            if (this.online && Net.role === 'host') {
                this._hostBroadcastNetState(delta);
            }
        }

        // HUD
        if (this.fighters.length >= 2) {
            UI.updateDamage(this.fighters);
            UI.updateStocks(this.fighters);
            UI.updateEnergy(this.fighters);
        }

        // Render AFTER physics so Phaser's draw pass shows the freshest state.
        // (Previously rendered at the top, which caused a 1-frame visual lag.)
        this._render();
    }

    // =========================================================
    //  shutdown — clean up when scene stops
    // =========================================================
    shutdown() {
        // Destroy platform image objects
        if (this._platforms) this._platforms.destroy();
        // Remove game-level event listeners to avoid stacking
        this.game.events.off('game:resume', this._resumeFromPause, this);
        this.game.events.off('game:rematch', this._rematchFromPause, this);
        this.game.events.off('game:toggle-guide', this._togglePauseGuide, this);
        this.game.events.off('game:exit', this._exitToMenu, this);
        // Clear GameEffects reference
        window.GameEffects = null;
        window.SkillDropSystem = null;
        window.UltimateSystem = null;
        // Destroy Saitama text if it exists
        if (this._saitamaText) { this._saitamaText.destroy(); this._saitamaText = null; }
        if (this._saitamaVideoEl) {
            if (Audio && Audio.detachMediaElement) Audio.detachMediaElement(this._saitamaVideoEl);
            this._saitamaVideoEl.pause();
            this._saitamaVideoEl.removeAttribute('src');
            this._saitamaVideoEl.load();
            this._saitamaVideoEl.remove();
            this._saitamaVideoEl = null;
        }
        if (this._skillBoxes && this._skillBoxes.length) {
            this._skillBoxes.forEach(box => this._destroySkillBoxVisual(box));
        }
        if (this._meteors && this._meteors.length) {
            this._meteors.forEach(m => {
                if (m.sprite) { m.sprite.destroy(); m.sprite = null; }
            });
        }
        this._saitamaOverlay = null;
        // Destroy debug label
        if (this._debugLabel) { this._debugLabel.destroy(); this._debugLabel = null; }
        // Destroy damage text pool
        if (this._dmgTextPool) { this._dmgTextPool.forEach(t => t.destroy()); this._dmgTextPool = null; }
        // Clear online callbacks so they don't fire after scene death
        if (this.online) {
            Net.onInputReceived = null;
            Net.onStateReceived = null;
            Net.onHostDisconnect = null;
            Net.onError = null;
        }
        this._netSaitamaCast = null;
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

        // Compute spawn X positions relative to the ground platform center
        const _ground = this._mapDef.platforms[0];
        const _cx = _ground.x + _ground.w / 2;   // center of ground
        const _qw = Math.min(_ground.w * 0.22, 200); // quarter-width offset (capped)
        const _sp = {
            left2: _cx - _qw * 1.6,   // far left  (2v2)
            left1: _cx - _qw,          // near left
            right1: _cx + _qw,          // near right
            right2: _cx + _qw * 1.6,   // far right (2v2)
        };

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
            if (!isPlayer && Number.isFinite(diff) && diff >= 0.9) {
                f.maxAirJumps = 2;
            }
            f._keyMap = resolvedKeyMap;  // explicit reference for input routing
            // Create per-fighter Graphics object
            const gfx = this.add.graphics().setDepth(3);
            this._fighterGfxArr.push(gfx);
            return f;
        };

        // Apply stat multipliers from a difficulty preset to a non-player fighter
        const applyPresetStats = (fighter, presetKey) => {
            if (!fighter || fighter.isPlayer) return;
            const presets = CONFIG.BOT_DIFFICULTY_PRESETS || {};
            const p = presets[presetKey];
            if (!p) return;
            if (Number.isFinite(p.speedMult))  fighter.speedMult  = p.speedMult;
            if (Number.isFinite(p.jumpMult))   fighter.jumpMult   = p.jumpMult;
            if (Number.isFinite(p.damageMult)) fighter.damageMult = p.damageMult;
            if (Number.isFinite(p.airJumps))   fighter.maxAirJumps = Math.max(0, p.airJumps);
        };

        const applyTournamentMeta = (fighter, meta) => {
            if (!fighter || !meta) return;
            if (Number.isFinite(meta.stocks)) {
                fighter.stocks = Math.max(1, Math.round(meta.stocks));
            }
            if (Number.isFinite(meta.maxAirJumps)) {
                fighter.maxAirJumps = Math.max(0, Math.floor(meta.maxAirJumps));
            }
            if (meta.aiLevel) {
                fighter._aiLevel = meta.aiLevel;
            }
        };

        const { mode } = this;

        if (this.online && this.netConfig) {
            // ============================================================
            //  ONLINE MODE — build fighters from lobby player list
            // ============================================================
            const SPAWN_POS = [
                { x: _sp.left1, fr: true },    // slot 0
                { x: _sp.right1, fr: false },   // slot 1
                { x: _sp.left2, fr: true },    // slot 2 (2v2)
                { x: _sp.right2, fr: false },   // slot 3 (2v2)
            ];
            const players = this.netConfig.players || [];
            players.forEach((p, i) => {
                const sp = SPAWN_POS[i] || SPAWN_POS[i % 2];
                const isLocal = p.id === (Net.localPlayer?.id ?? 1);
                const team = (mode === 'ffa') ? (10 + i) : (p.team ?? (i % 2));
                const f = make(i, sp.x, sp.fr, isLocal, C.KEYS_P1,
                    PRESETS[i % 4], team);
                f._name = p.name;
                f._netPlayerId = p.id;
                f._isLocalNet = isLocal;
                if (!isLocal) {
                    f.setInput({
                        left: false, right: false, up: false,
                        down: false, light: false, heavy: false, dodge: false, drop: false
                    });
                }
                this.fighters.push(f);
            });

        } else if (mode === '1v1') {
            const f0 = make(0, _sp.left1, true, true, C.KEYS_P1, PRESETS[0], 0);
            const f1 = make(1, _sp.right1, false, true, C.KEYS_P2, PRESETS[1], 1);
            f0._name = 'PLAYER 1'; f1._name = 'PLAYER 2';
            this.fighters.push(f0, f1);

        } else if (mode === '1vAI') {
            const presets = CONFIG.BOT_DIFFICULTY_PRESETS || {};
            const preset = presets[this.aiDifficulty] || presets.medium || { label: 'MEDIUM', scalar: 0.58, airJumps: 1 };
            const aiDiff = Number.isFinite(preset.scalar) ? preset.scalar : 0.58;
            const f0 = make(0, _sp.left1, true, true, C.KEYS_P1, PRESETS[0], 0);
            const f1 = make(1, _sp.right1, false, false, C.KEYS_P2, PRESETS[1], 1, aiDiff);
            f1.maxAirJumps = Number.isFinite(preset.airJumps) ? Math.max(0, preset.airJumps) : 1;
            applyPresetStats(f1, this.aiDifficulty);
            f1._difficultyName = preset.label || this.aiDifficulty.toUpperCase();
            f0._name = 'PLAYER 1'; f1._name = 'CPU';
            this.fighters.push(f0, f1);
            this.bots.push({ fighter: f1, bot: new Bot(f1, aiDiff, { scene: this, level: this.aiDifficulty }) });

        } else if (mode === '2v2') {
            const f0 = make(0, _sp.left2, true, true, C.KEYS_P1, PRESETS[0], 0);
            const f1 = make(1, _sp.left1, true, false, null, PRESETS[2], 0, 0.45);
            const f2 = make(2, _sp.right1, false, true, C.KEYS_P2, PRESETS[1], 1);
            const f3 = make(3, _sp.right2, false, false, null, PRESETS[3], 1, 0.45);
            f0._name = 'PLAYER 1'; f1._name = 'ALLY';
            f2._name = 'PLAYER 2'; f3._name = 'FOE';
            this.fighters.push(f0, f1, f2, f3);
            this.bots.push({ fighter: f1, bot: new Bot(f1, 0.45, { scene: this }) });
            this.bots.push({ fighter: f3, bot: new Bot(f3, 0.45, { scene: this }) });

        } else if (mode === 'tournament' && this.tournamentMatch) {
            const { p1, p2 } = this.tournamentMatch;
            const f0 = make(0, _sp.left1, true, p1.isPlayer, C.KEYS_P1,
                { color: p1.color, shadow: p1.shadow }, 0, p1.difficulty);
            const f1 = make(1, _sp.right1, false, p2.isPlayer, C.KEYS_P2,
                { color: p2.color, shadow: p2.shadow }, 1, p2.difficulty);
            applyTournamentMeta(f0, p1);
            applyTournamentMeta(f1, p2);
            // Apply stat multipliers for hard/boss AI opponents
            if (!p1.isPlayer && p1.aiLevel) applyPresetStats(f0, p1.aiLevel);
            if (!p2.isPlayer && p2.aiLevel) applyPresetStats(f1, p2.aiLevel);
            f0._name = p1.name; f1._name = p2.name;
            this.fighters.push(f0, f1);
            if (!p1.isPlayer) this.bots.push({ fighter: f0, bot: new Bot(f0, p1.difficulty || 0.5, { scene: this, level: p1.aiLevel }) });
            if (!p2.isPlayer) this.bots.push({ fighter: f1, bot: new Bot(f1, p2.difficulty || 0.5, { scene: this, level: p2.aiLevel }) });
        }

        if (this.fighters.length >= 2) {
            UI.setNames(
                this.fighters[0]?._name, this.fighters[1]?._name,
                this.fighters[2]?._name, this.fighters[3]?._name
            );
        }
        const modeLabels = { '1v1': '2P VS', '1vAI': 'VS AI', '2v2': '2v2 TEAM', 'ffa': 'FREE FOR ALL', 'tournament': 'TOWER' };
        let modeLabel = modeLabels[mode] || mode;
        if (mode === '1vAI') {
            const presets = CONFIG.BOT_DIFFICULTY_PRESETS || {};
            const preset = presets[this.aiDifficulty] || presets.medium;
            const diffLabel = (preset && preset.label) ? preset.label : this.aiDifficulty.toUpperCase();
            modeLabel = `${modeLabel} • ${diffLabel}`;
        }
        UI.setModeTag(this.online ? `ONLINE • ${modeLabel}` : modeLabel);
        if (mode === 'tournament' && this.tournament && this.tournament.roundLabel) {
            UI.setRoundLabel(this.tournament.roundLabel);
        } else {
            UI.setRoundLabel('MATCH');
        }
        UI.setHudPlayers(this.fighters.length);
        UI.updateStocks(this.fighters);
        UI.updateDamage(this.fighters);
        UI.updateEnergy(this.fighters);
    }

    _applyUltimateDebugPreset() {
        const dbg = window.ULTIMATE_DEBUG;
        if (!dbg || !dbg.enabled) return;

        // Online: only host should apply authoritative spawn presets.
        const isAuthoritative = !this.online || (typeof Net !== 'undefined' && Net && Net.role === 'host');
        if (!isAuthoritative) return;

        const ultis = CONFIG.ULTIMATE_SKILLS || {};
        const perFighter = dbg.perFighter || {};
        const onlyPlayers = !!dbg.onlyPlayers;
        const targetIds = Array.isArray(dbg.targetIds) ? new Set(dbg.targetIds.map(v => Number(v))) : null;
        const defaultUltimate = dbg.defaultUltimate || null;
        const defaultEnergy = Number.isFinite(dbg.energyOnStart) ? dbg.energyOnStart : null;
        const defaultCooldown = Number.isFinite(dbg.cooldownOnStart) ? dbg.cooldownOnStart : 0;

        let appliedCount = 0;

        for (const f of this.fighters) {
            if (onlyPlayers && !f.isPlayer) continue;
            if (targetIds && !targetIds.has(f.id)) continue;

            const rule = perFighter[f.id] || {};
            const ultimateId = rule.ultimate || defaultUltimate;
            if (ultimateId) {
                const def = ultis[ultimateId];
                if (def && def.enabled) {
                    f.collectedUltimate = ultimateId;
                }
            }

            const energy = Number.isFinite(rule.energy) ? rule.energy : defaultEnergy;
            if (energy !== null) {
                f.energy = Math.max(0, Math.min(CONFIG.ENERGY.MAX, energy));
            }

            const cooldown = Number.isFinite(rule.cooldown) ? rule.cooldown : defaultCooldown;
            f.ultimateCooldown = Math.max(0, cooldown || 0);
            appliedCount++;
        }

        if (window.UI && UI.updateEnergy) UI.updateEnergy(this.fighters);
    }

    // =========================================================
    //  Camera Setup
    // =========================================================
    _setupCamera() {
        const C = CONFIG;
        const cam = this.cameras.main;
        const ground = this._mapDef.platforms[0];

        // World bounds large enough for blast zones (use per-map overrides if present)
        const B = this._blastBounds || { left: C.BLAST_LEFT, right: C.BLAST_RIGHT, top: C.BLAST_TOP, bottom: C.BLAST_BOTTOM };
        cam.setBounds(
            B.left - 200,
            B.top - 200,
            (B.right - B.left) + 400,
            (B.bottom - B.top) + 400
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
            drop: isDown(phaserKeyMap.drop),
        };
    }

    _updateInput() {
        for (const f of this.fighters) {
            if (!f.isPlayer) continue;
            const km = (f._keyMap === CONFIG.KEYS_P2) ? this._p2Keys : this._p1Keys;
            f.setInput(this._readKeyMap(km));

            if (this.online && Net.role === 'client' && f._isLocalNet) {
                this._collectLocalInputEdges(km);
            }
        }
    }

    _collectLocalInputEdges(phaserKeyMap) {
        if (!phaserKeyMap || !Phaser || !Phaser.Input || !Phaser.Input.Keyboard) return;
        const KD = Phaser.Input.Keyboard.JustDown;
        const p = this._pendingInputEdges;
        const t = this._inputEdgeTotals;
        if (KD(phaserKeyMap.up)) { p.up++; t.up++; }
        if (KD(phaserKeyMap.light)) { p.light++; t.light++; }
        if (KD(phaserKeyMap.heavy)) { p.heavy++; t.heavy++; }
        if (KD(phaserKeyMap.dodge)) { p.dodge++; t.dodge++; }
        if (KD(phaserKeyMap.drop)) { p.drop++; t.drop++; }
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
        if (this.online && Net.role === 'client') {
            // Client never runs authoritative fighter physics/combat.
            for (const f of this.fighters) {
                f.tick += delta / 16.667;
                if (f.invTimer > 0) f.invTimer = Math.max(0, f.invTimer - delta);
                if (f.hurtTimer > 0) f.hurtTimer = Math.max(0, f.hurtTimer - delta);

                if (f.atkTimer > 0) {
                    f.atkTimer = Math.max(0, f.atkTimer - delta);
                    if (f.atkDuration > 0) {
                        f.atkProgress = 1 - (f.atkTimer / f.atkDuration);
                    }
                } else {
                    f.atkProgress = 0;
                }

                // Remote fighters are lerped between host snapshots.
                if (!f._isLocalNet && f._interpTarget) {
                    const dx = f._interpTarget.x - f.x;
                    const dy = f._interpTarget.y - f.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const netCfg = (CONFIG && CONFIG.NET) || {};
                    const snapDist = Number(netCfg.REMOTE_SNAP_DIST) || 180;
                    if (dist > snapDist) {
                        f.x = f._interpTarget.x;
                        f.y = f._interpTarget.y;
                    } else {
                        const fast = Number(netCfg.REMOTE_LERP_FAST) || 0.5;
                        const med = Number(netCfg.REMOTE_LERP_MEDIUM) || 0.34;
                        const slow = Number(netCfg.REMOTE_LERP_SLOW) || 0.16;
                        const t = dist > 120 ? fast : (dist > 30 ? med : slow);
                        f.x += dx * t;
                        f.y += dy * t;
                    }
                }
            }
            return;
        }

        for (const f of this.fighters) {
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
        const colorInt = parseInt((CONFIG.SKILLS[skillKey].color || '#ffffff').replace('#', ''), 16);
        this._skillItems.push({ x, y, skillKey, colorInt, lifetime: CONFIG.SKILL_LIFETIME, animTick: 0 });
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
            const sc = item.colorInt;
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

    _mapAssetPath(fileName) {
        return `${CONFIG.ULTIMATE_ICON_BASE_PATH}/${fileName}`;
    }

    _ultimateIconTextureKey(ultimateId) {
        return `ultimate_icon_${ultimateId}`;
    }

    _meteorTextureKey() {
        return 'ultimate_meteor_shared';
    }

    _startSpecialSpawnScript() {
        if (this._specialSpawnScriptStarted) return;
        this._specialSpawnScriptStarted = true;

        // At 5s after fight starts: spawn 2 random skills (excluding Saitama).
        this.time.delayedCall(5000, () => {
            if (this.matchOver) return;
            this._spawnRandomSkillBox({ excludeSaitama: true });
            this._spawnRandomSkillBox({ excludeSaitama: true });
        });

        // At 60s after fight starts: guarantee a Saitama box appears.
        this.time.delayedCall(60000, () => {
            if (this.matchOver) return;
            this._forceSpawnSaitamaBox();
        });
    }

    _pickRandomSkillSpawnPoint() {
        const plats = this._platforms.platforms;
        const pool = plats.length > 1 ? plats.slice(1) : plats;
        if (!pool.length) return null;
        const plat = pool[Math.floor(Math.random() * pool.length)];
        return {
            x: plat.x + plat.w * (0.20 + Math.random() * 0.60),
            y: plat.y - (CONFIG.SKILL_DROP.skillBoxSize * 0.65),
        };
    }

    _spawnRandomSkillBox(options = {}) {
        const noSaitamaMap = !!(this._mapDef && this._mapDef.noSaitama);
        const { excludeSaitama = noSaitamaMap } = options;
        if (this.matchOver) return;
        const D = CONFIG.SKILL_DROP;
        if (this._skillBoxes.length >= (D.maxActiveOnMap || 3)) return;

        const point = this._pickRandomSkillSpawnPoint();
        if (!point) return;
        this._spawnSkillBox(point.x, point.y, this._randomUltimateId(excludeSaitama));
    }

    _forceSpawnSaitamaBox() {
        // Suppressed on maps that forbid Saitama
        if (this._mapDef && this._mapDef.noSaitama) return;

        const hasOnMap = this._skillBoxes.some(b => b.ultimateId === 'saitama');
        const hasHolder = this.fighters.some(f => f.collectedUltimate === 'saitama');
        if (hasOnMap || hasHolder) return;

        const maxActive = (CONFIG.SKILL_DROP && CONFIG.SKILL_DROP.maxActiveOnMap) || 3;
        if (this._skillBoxes.length >= maxActive) {
            const idx = this._skillBoxes.findIndex(b => b.ultimateId !== 'saitama');
            const rm = idx >= 0 ? this._skillBoxes.splice(idx, 1)[0] : this._skillBoxes.shift();
            if (rm) this._destroySkillBoxVisual(rm);
        }

        const point = this._pickRandomSkillSpawnPoint();
        if (!point) return;
        this._spawnSkillBox(point.x, point.y, 'saitama');
    }

    _destroySkillBoxVisual(box) {
        if (box && box.sprite) {
            box.sprite.destroy();
            box.sprite = null;
        }
    }

    // =========================================================
    //  V2 Skill Box — drop, spawn, update, render, pickup, execute
    // =========================================================

    _spawnSkillBox(x, y, ultimateId) {
        const def = CONFIG.ULTIMATE_SKILLS && CONFIG.ULTIMATE_SKILLS[ultimateId];
        if (!def || !def.enabled) return;

        // Enforce Saitama singleton (both on map and currently held by fighters).
        if (ultimateId === 'saitama') {
            const existing = this._skillBoxes.filter(b => b.ultimateId === 'saitama').length;
            const held = this.fighters.filter(f => f.collectedUltimate === 'saitama').length;
            if ((existing + held) >= (def.maxInstanceCount || 1)) return;
        }

        const D = CONFIG.SKILL_DROP;
        const isSaitama = ultimateId === 'saitama';
        const isBouncy = isSaitama && !!def.bounceOnMap;
        const vxRange = def.bounceVelocityX || { min: -3, max: 3 };
        const vyRange = def.bounceVelocityY || { min: -5, max: -2 };
        const spriteKey = this._ultimateIconTextureKey(ultimateId);
        let sprite = null;

        if (this.textures.exists(spriteKey)) {
            sprite = this.add.image(x, y, spriteKey).setDepth(2.65);
            sprite.setDisplaySize(26, 26);
        }

        this._skillBoxes.push({
            id: ++this._skillBoxIdCounter,
            ultimateId,
            x, y,
            vx: isBouncy ? (vxRange.min + Math.random() * (vxRange.max - vxRange.min)) : ((Math.random() - 0.5) * 1.2),
            vy: isBouncy ? (vyRange.min + Math.random() * (vyRange.max - vyRange.min)) : -2,
            gravity: isBouncy ? (def.bounceGravity || D.dropGravity) : D.dropGravity,
            bouncy: isBouncy,
            colorInt: parseInt((def.color || '#ffffff').replace('#', ''), 16),
            animTick: 0,
            lifetime: D.maxLifetime,
            onGround: false,
            sprite,
        }); 
    }

    _dropUltimateFromFighter(fighter) {
        const id = fighter.dropUltimate();
        if (!id) return;
        this._spawnSkillBox(fighter.x, fighter.y - 30, id);
    }

    _randomUltimateId(excludeSaitama = false) {
        const D = CONFIG.SKILL_DROP;
        const rarityEntries = Object.entries(D.rarity || {});
        const candidates = [];
        const saitamaLockedByTime = this._matchElapsedMs < 60000;

        const hasSaitamaOnMap = this._skillBoxes.some(b => b.ultimateId === 'saitama');
        const hasSaitamaHolder = this.fighters.some(f => f.collectedUltimate === 'saitama');

        for (const [id, chance] of rarityEntries) {
            const def = CONFIG.ULTIMATE_SKILLS && CONFIG.ULTIMATE_SKILLS[id];
            if (!def || !def.enabled || !chance || chance <= 0) continue;
            if ((excludeSaitama || saitamaLockedByTime) && id === 'saitama') continue;
            if (id === 'saitama' && (hasSaitamaOnMap || hasSaitamaHolder)) continue;
            candidates.push({ id, chance });
        }

        if (!candidates.length) return 'default';

        const total = candidates.reduce((sum, c) => sum + c.chance, 0);
        const r = Math.random() * total;
        let acc = 0;
        for (const c of candidates) {
            acc += c.chance;
            if (r <= acc) return c.id;
        }

        return 'default';
    }

    _updateSkillBoxes(dt) {
        const D = CONFIG.SKILL_DROP;
        const bounce = D.dropBounce;
        const groundY = this._mapDef.platforms[0].y;   // ground platform top
        const pickupR = D.pickupRadius;
        const mapW = this._mapDef.canvasWidth || 1600;

        this._skillBoxes = this._skillBoxes.filter(box => {
            box.lifetime -= dt;
            box.animTick += dt / 16.667;
            if (box.lifetime <= 0) {
                this._destroySkillBoxVisual(box);
                return false;
            }

            // Physics
            box.vy += (box.gravity || D.dropGravity);
            box.x += box.vx;
            box.y += box.vy;

            // Ground behavior
            if (box.y >= groundY - 20) {
                box.y = groundY - 20;
                if (box.bouncy) {
                    box.vy = -Math.abs(box.vy) * bounce;
                    box.vx *= 0.90;
                    if (Math.abs(box.vy) < 0.55) box.vy = 0;
                } else {
                    box.vy = 0;
                    box.vx *= 0.72;
                    if (Math.abs(box.vx) < 0.08) box.vx = 0;
                }
                box.onGround = true;
            }

            // Wall bounce
            if (box.bouncy) {
                if (box.x < 20) { box.x = 20; box.vx = Math.abs(box.vx); }
                if (box.x > mapW - 20) { box.x = mapW - 20; box.vx = -Math.abs(box.vx); }
            } else {
                if (box.x < 20) { box.x = 20; box.vx = 0; }
                if (box.x > mapW - 20) { box.x = mapW - 20; box.vx = 0; }
            }

            // Pickup check
            for (const f of this.fighters) {
                if (f.state === 'dead' || f._respawning) continue;
                if (f.collectedUltimate) continue;
                const dx = f.x - box.x;
                const dy = (f.y - 45) - box.y;
                if (dx * dx + dy * dy < pickupR * pickupR) {
                    if (f.collectUltimate(box.ultimateId)) {
                        this._destroySkillBoxVisual(box);
                        return false;  // consumed
                    }
                }
            }

            if (box.sprite) {
                box.sprite.setPosition(box.x, box.y);
            }

            return true;
        });
    }

    _renderSkillBoxes() {
        const g = this._skillBoxGfx;
        for (const box of this._skillBoxes) {
            if (!CONFIG.ULTIMATE_SKILLS[box.ultimateId]) continue;
            const color = box.colorInt;
            const R = CONFIG.SKILL_DROP.skillBoxSize / 2;
            const pulse = 0.55 + Math.sin(box.animTick * 4) * 0.45;
            const bob = Math.sin(box.animTick * 2.5) * 3;
            const iy = box.y + bob;

            // Outer glow
            g.lineStyle(5, color, 0.22);
            g.strokeCircle(box.x, iy, R + 10);
            // Ring
            g.lineStyle(2.5, color, pulse * 0.9);
            g.strokeCircle(box.x, iy, R);

            if (box.sprite) {
                box.sprite.setAlpha(0.78 + pulse * 0.22);
            } else {
                // Fallback when icon image was not uploaded.
                g.fillStyle(color, pulse * 0.8);
                g.fillCircle(box.x, iy, R * 0.65);
                g.fillStyle(0xffffff, pulse * 0.5);
                g.fillCircle(box.x, iy, R * 0.25);
            }

            // Rotating indicator lines
            const rot = box.animTick * 0.05;
            const lr = R * 0.55;
            g.lineStyle(1.5, 0xffffff, pulse * 0.6);
            for (let i = 0; i < 4; i++) {
                const a = rot + (i * Math.PI / 2);
                g.beginPath();
                g.moveTo(box.x + Math.cos(a) * (R * 0.35), iy + Math.sin(a) * (R * 0.35));
                g.lineTo(box.x + Math.cos(a) * lr, iy + Math.sin(a) * lr);
                g.strokePath();
            }
        }
    }

    // =========================================================
    //  Death → drop ultimate box
    // =========================================================
    _onFighterKO(fighter) {
        const D = CONFIG.SKILL_DROP;
        // If fighter has a V2 ultimate, always drop it
        if (fighter.collectedUltimate) {
            this._dropUltimateFromFighter(fighter);
            return;
        }
        // Random drop from rarity table
        if (Math.random() < D.dropChanceOnDeath) {
            const id = this._randomUltimateId();
            this._spawnSkillBox(fighter.x, fighter.y - 40, id);
        }
    }

    // =========================================================
    //  V2 Ultimate Execution (stub — filled in Phase 3+)
    // =========================================================
    _executeUltimateV2(id, fighter, opponents, particles) {
        const def = CONFIG.ULTIMATE_SKILLS && CONFIG.ULTIMATE_SKILLS[id];
        if (!def) return;

        switch (id) {
            case 'default': this._ultiDefault(fighter, opponents, particles, def); break;
            case 'yasuo': this._ultiYasuo(fighter, opponents, particles, def); break;
            case 'kamehameha': this._ultiKamehameha(fighter, opponents, particles, def); break;
            case 'fpt': this._ultiFPT(fighter, opponents, particles, def); break;
            case 'saitama': this._ultiSaitama(fighter, opponents, particles, def); break;
            default: this._ultiDefault(fighter, opponents, particles, def); break;
        }
    }

    _lockUltimateAnimation(fighter, attackType, durationMs) {
        const hold = Math.max(80, durationMs || 400);
        fighter.state = 'attack';
        fighter.attackType = attackType || 'ultimate';
        fighter.atkTimer = hold;
        fighter.atkDuration = hold;
        fighter.atkProgress = 0;
        fighter.atkCooldown = Math.max(fighter.atkCooldown || 0, hold + 60);
        this.time.delayedCall(hold, () => {
            if (!fighter || fighter.state === 'dead' || fighter._respawning) return;
            fighter.attackType = null;
            fighter.atkTimer = 0;
            fighter.atkDuration = 0;
            fighter.atkProgress = 0;
            if (fighter.state === 'attack') {
                fighter.state = fighter.onGround ? 'idle' : 'airborne';
            }
        });
    }

    _hideSaitamaVideo() {
        if (!this._saitamaVideoEl) return;
        if (Audio && Audio.detachMediaElement) Audio.detachMediaElement(this._saitamaVideoEl);
        this._saitamaVideoEl.pause();
        this._saitamaVideoEl.removeAttribute('src');
        this._saitamaVideoEl.load();
        this._saitamaVideoEl.remove();
        this._saitamaVideoEl = null;
    }

    _playSaitamaVideo(def, onDone) {
        const done = (() => {
            let called = false;
            return () => {
                if (called) return;
                called = true;
                this._hideSaitamaVideo();
                onDone && onDone();
            };
        })();

        if (!def.videoPath) {
            done();
            return;
        }

        if (!this._saitamaVideoEl) {
            const video = document.createElement('video');
            video.style.position = 'fixed';
            video.style.left = '0';
            video.style.top = '0';
            video.style.width = '100vw';
            video.style.height = '100vh';
            video.style.objectFit = 'cover';
            video.style.zIndex = '99999';
            video.style.background = '#000';
            video.style.display = 'none';
            video.setAttribute('playsinline', 'true');
            // Attempt to allow audio: unmute and route through WebAudio if available.
            video.muted = false;
            document.body.appendChild(video);
            this._saitamaVideoEl = video;
            if (Audio && Audio.attachMediaElement) Audio.attachMediaElement(video);
        }

        const video = this._saitamaVideoEl;
        video.onended = done;
        video.onerror = done;
        video.onabort = done;
        video.style.display = 'block';
        video.currentTime = 0;
        video.src = def.videoPath;
        video.load();

        const playPromise = video.play();
        if (playPromise && playPromise.catch) {
            playPromise.catch(() => done());
        }

        const fallbackDuration = (def.videoDuration || def.duration || 3200) + 500;
        this.time.delayedCall(fallbackDuration, () => {
            if (video.style.display !== 'none') done();
        });
    }

    // =========================================================
    //  V2 Ultimate — Default (fixed hitbox power strike)
    // =========================================================
    _ultiDefault(fighter, opponents, particles, def) {
        const startDelay = def.startDelay || 0;
        const castDuration = startDelay + (def.duration || 450) + (def.endDelay || 0);
        this._lockUltimateAnimation(fighter, 'ultimate', castDuration);

        // Start-up zoom
        if (window.GameEffects) GameEffects.zoom(0.9, startDelay + 120);

        this.time.delayedCall(startDelay, () => {
            if (this.matchOver) return;

            // Forward-anchored hitbox so close-range targets in front are reliable.
            const w = def.hitboxWidth;
            const frontStart = fighter.x + fighter.facing * Math.max(0, (def.hitboxOffsetX || 0) - 40);
            const cx = frontStart + fighter.facing * (w * 0.5);
            const cy = (fighter.y - 50) + (def.hitboxOffsetY || 0);

            this._applyUltimateHit(fighter, opponents, particles, def, cx, cy,
                w, def.hitboxHeight);

            // Burst shockwaves from impact point
            for (let i = 0; i < 3; i++) {
                this.time.delayedCall(i * 80, () => {
                    particles && particles.spawnShockwave &&
                        particles.spawnShockwave(cx, cy, 1.5 + i * 0.6);
                });
            }
            if (window.GameEffects) GameEffects.zoom(1.1, 300);
        });
    }

    // =========================================================
    //  V2 Ultimate — Yasuo Wind Slash
    // =========================================================
    _ultiYasuo(fighter, opponents, particles, def) {
        const startDelay = def.startDelay || 0;
        const castDuration = startDelay + (def.duration || 600) + (def.endDelay || 0);
        this._lockUltimateAnimation(fighter, 'ultimate_fire', castDuration);

        this.time.delayedCall(startDelay, () => {
            if (this.matchOver) return;
            const id = ++this._projIdCounter;
            this._projectiles.push({
                id,
                type: 'yasuo',
                x: fighter.x + fighter.facing * 30,
                y: fighter.y - 50,
                vx: fighter.facing * (def.projectileSpeed || 10),
                w: def.hitboxWidth,
                h: def.hitboxHeight,
                fighter,
                def,
                opponents: opponents.slice(),
                particles,
                hit: false,
                tick: 0,
            });
            if (window.GameEffects) GameEffects.zoom(1.06, 220);
        });
    }

    _yasuoCombo(fighter, opp, def, particles) {
        const launchScale = 1 + (opp.damage || 0) / 100;
        const launchForce = def.forceStrength * launchScale;
        opp.vx = fighter.facing * launchForce * 0.2;
        opp.vy = -launchForce * 0.75;
        opp.onGround = false;
        opp.hurtTimer = CONFIG.HURT_DURATION;
        opp.invTimer = 40;

        // Teleport fighter to opponent
        fighter.x = opp.x - fighter.facing * 65;
        fighter.y = opp.y;

        const totalHits = def.comboHits || 5;
        const dmgPerHit = Math.ceil(def.damage / totalHits);
        const interval = Math.floor((def.comboDuration || 800) / totalHits);
        const slashOffsets = [
            { x: -60, y: -10 },
            { x: -20, y: -80 },
            { x: 55, y: -20 },
            { x: -55, y: 35 },
            { x: 0, y: -15 },
        ];

        for (let i = 0; i < totalHits; i++) {
            this.time.delayedCall(i * interval, () => {
                if (!opp || opp.state === 'dead') return;
                const offset = slashOffsets[i % slashOffsets.length];
                fighter.x = opp.x + offset.x * (fighter.facing > 0 ? 1 : -1);
                fighter.y = opp.y + offset.y;
                fighter.facing = opp.x >= fighter.x ? 1 : -1;

                const scale = 1 + (opp.damage || 0) / 100;
                const F = (def.forceStrength / totalHits) * scale;
                // Alternate directions for each hit
                const dirs = [1, 0, -1, 1, 0];
                const isLast = (i === totalHits - 1);
                const kbx = isLast ? (opp.x >= fighter.x ? 1 : -1) * F * 1.4 : dirs[i % 5] * F * 0.3;
                const kby = isLast ? -F * 1.2 : -F * 0.5;
                opp.vx = kbx; opp.vy = kby;
                opp.onGround = false;
                opp.damage = (opp.damage || 0) + dmgPerHit;
                opp.hurtTimer = CONFIG.HURT_DURATION;
                opp.invTimer = isLast ? 200 : 60;
                if (particles) {
                    particles.spawnSpark && particles.spawnSpark(opp.x, opp.y - 40);
                    if (isLast) particles.spawnShockwave && particles.spawnShockwave(opp.x, opp.y - 40, 2.0);
                }
                this._spawnDmgNumber(opp.x, opp.y - 60, dmgPerHit,
                    isLast ? '#ff4444' : (def.color || '#88ffee'));
                Audio.playHurt && Audio.playHurt();
                if (isLast && window.GameEffects) GameEffects.zoom(1.12, 350);
            });
        }
    }

    // =========================================================
    //  V2 Ultimate — Kamehameha Energy Beam
    // =========================================================
    _ultiKamehameha(fighter, opponents, particles, def) {
        const startDelay = def.startDelay || 0;
        const castDuration = startDelay + (def.duration || 700) + (def.endDelay || 0);
        this._lockUltimateAnimation(fighter, 'ultimate_void', castDuration);
        if (window.GameEffects) GameEffects.zoom(0.88, startDelay + 150);

        this.time.delayedCall(startDelay, () => {
            if (this.matchOver) return;
            const id = ++this._projIdCounter;
            this._projectiles.push({
                id,
                type: 'kamehameha',
                x: fighter.x + fighter.facing * 30,
                y: fighter.y - 50 + (def.hitboxOffsetY || 0),
                vx: fighter.facing * (def.projectileSpeed || 8),
                w: def.projectileWidth || def.hitboxWidth,
                h: def.projectileHeight || def.hitboxHeight,
                fighter,
                def,
                opponents: opponents.slice(),
                particles,
                hitOpponents: new Set(),
                tick: 0,
            });
        });
    }

    // =========================================================
    //  V2 Ultimate — FPT Meteor Rain
    // =========================================================
    _ultiFPT(fighter, opponents, particles, def) {
        const mapW = this._mapDef.canvasWidth || 1600;
        const count = def.meteorCount || 8;
        const totalDur = def.meteorSpawnDuration || 3000;
        const interval = totalDur / count;
        const startDelay = def.startDelay || 0;
        const castDuration = startDelay + totalDur + (def.endDelay || 0);
        const meteorTex = this._meteorTextureKey();

        this._lockUltimateAnimation(fighter, 'ultimate_thunder', castDuration);

        this.time.delayedCall(startDelay, () => {
            for (let i = 0; i < count; i++) {
                this.time.delayedCall(i * interval, () => {
                    if (this.matchOver) return;
                    // Apply configurable randomness to meteor X position
                    const randomness = def.meteorRandomness !== undefined ? def.meteorRandomness : 0;
                    const baseX = 80 + Math.random() * (mapW - 160);
                    const offset = (Math.random() - 0.5) * randomness * mapW; // +/- half of randomness fraction
                    const spawnX = Phaser.Math.Clamp(baseX + offset, 0, mapW);
                    let sprite = null;
                    if (this.textures.exists(meteorTex)) {
                        const size = (def.meteorHitboxRadius || 55) * 1.8;
                        sprite = this.add.image(spawnX, -40, meteorTex).setDepth(3.45);
                        sprite.setDisplaySize(size, size);
                    }
                    this._meteors.push({
                        id: ++this._meteorIdCounter,
                        x: spawnX,
                        y: -40,
                        vx: (Math.random() - 0.5) * 3,
                        vy: 2 + Math.random() * 3,
                        radius: def.meteorHitboxRadius || 55,
                        fighter,
                        def,
                        opponents: opponents.slice(),
                        particles,
                        hitOpponents: new Set(),
                        tick: 0,
                        exploded: false,
                        sprite,
                    });
                });
            }
        });

        if (window.GameEffects) GameEffects.zoom(0.92, 400);
    }

    // =========================================================
    //  V2 Ultimate — Saitama Serious Punch
    // =========================================================
    _ultiSaitama(fighter, opponents, particles, def) {
        const freezeDur = def.freezeScreenDuration || 500;
        const castDuration = freezeDur + (def.videoDuration || 3200) + (def.endDelay || 0);

        if (this.online && Net.role === 'host') {
            this._netSaitamaCast = {
                seq: ++this._saitamaCastSeq,
                owner: fighter ? fighter._netPlayerId : null,
                freezeDur,
                startDelay: def.startDelay || 0,
                videoDuration: def.videoDuration || 3200,
            };
        }

        this._lockUltimateAnimation(fighter, 'ultimate', castDuration);

        // Freeze all fighters
        this.roundPaused = true;

        // Show dramatic overlay while waiting for video to start.
        this._saitamaOverlay = { timer: 0, maxTime: freezeDur + 350, fighter, showText: true };

        const videoDelay = freezeDur + (def.startDelay || 0);
        this.time.delayedCall(videoDelay, () => {
            if (this.matchOver) return;
            this._playSaitamaVideo(def, () => {
                this.roundPaused = false;
                this._saitamaOverlay = null;
                this._overlayGfx.clear();
                if (this._saitamaText) this._saitamaText.setVisible(false);
                this._applySaitamaStrike(fighter, opponents, particles, def);
                if (this.online && Net.role === 'host') this._netSaitamaCast = null;
            });
        });
    }

    _applySaitamaStrike(fighter, opponents, particles, def) {
        const allEnemies = def.affectAllEnemies
            ? this.fighters.filter(f => f !== fighter && f.team !== fighter.team && f.state !== 'dead' && !f._respawning)
            : opponents.filter(o => o && o.state !== 'dead' && !o._respawning && o.team !== fighter.team);

        for (const opp of allEnemies) {
            const scale = 1 + (opp.damage || 0) / 100;
            const F = def.forceStrength * scale;
            const kbDir = opp.x >= fighter.x ? 1 : -1;
            opp.vx = kbDir * F * 1.2;
            opp.vy = -F * 0.9;
            opp.onGround = false;
            opp.damage = (opp.damage || 0) + def.damage;
            opp.energy = Math.floor((opp.energy || 0) * (def.victimEnergyMultiplier || 0.5));
            opp.hurtTimer = CONFIG.HURT_DURATION;
            opp.invTimer = 300;
            if (particles) {
                particles.spawnBlood && particles.spawnBlood(opp.x, opp.y - 40, fighter.facing);
                particles.spawnSpark && particles.spawnSpark(opp.x, opp.y - 40);
                particles.spawnShockwave && particles.spawnShockwave(opp.x, opp.y - 40, 3.5);
                for (let i = 0; i < 3; i++) {
                    this.time.delayedCall(i * 100, () =>
                        particles.spawnShockwave && particles.spawnShockwave(opp.x, opp.y - 40, 2 + i));
                }
            }
            this._spawnDmgNumber(opp.x, opp.y - 60, def.damage, def.color || '#ffd700');
            Audio.playHurt && Audio.playHurt();
        }
        if (window.GameEffects) GameEffects.zoom(1.15, 600);
    }

    // =========================================================
    //  Projectile update (Yasuo wind + Kamehameha beam)
    // =========================================================
    _updateProjectiles(dt) {
        if (!this._projIdCounter) this._projIdCounter = 0;
        const mapW = this._mapDef.canvasWidth || 1600;

        this._projectiles = this._projectiles.filter(proj => {
            proj.tick += dt;
            proj.x += proj.vx;

            // Out of bounds → remove
            if (proj.x < -200 || proj.x > mapW + 200) return false;
            // Max lifetime 4s
            if (proj.tick > 4000) return false;

            const hw = proj.w / 2;
            const hh = proj.h / 2;

            if (proj.type === 'yasuo') {
                // Single hit then 5-combo
                for (const opp of proj.opponents) {
                    if (proj.hit) break;
                    if (!opp || opp.state === 'dead' || opp._respawning) continue;
                    if (opp.team === proj.fighter.team) continue;
                    if (opp.invTimer > 0) continue;
                    const dx = Math.abs(opp.x - proj.x);
                    const dy = Math.abs((opp.y - 50) - proj.y);
                    if (dx <= hw && dy <= hh) {
                        proj.hit = true;
                        this._yasuoCombo(proj.fighter, opp, proj.def, proj.particles);
                        return false;
                    }
                }
                return !proj.hit;

            } else if (proj.type === 'kamehameha') {
                // Hits all opponents once, beam continues full length
                for (const opp of proj.opponents) {
                    if (!opp || opp.state === 'dead' || opp._respawning) continue;
                    if (opp.team === proj.fighter.team) continue;
                    if (proj.hitOpponents.has(opp)) continue;
                    if (opp.invTimer > 0) continue;
                    const dx = Math.abs(opp.x - proj.x);
                    const dy = Math.abs((opp.y - 50) - proj.y);
                    if (dx <= hw && dy <= hh) {
                        proj.hitOpponents.add(opp);
                        const scale = 1 + (opp.damage || 0) / 100;
                        const F = proj.def.forceStrength * scale;
                        const kbDir = proj.fighter.facing;
                        opp.vx = kbDir * F * 1.0;
                        opp.vy = -F * 0.5;
                        opp.onGround = false;
                        opp.damage = (opp.damage || 0) + proj.def.damage;
                        opp.hurtTimer = CONFIG.HURT_DURATION;
                        opp.invTimer = 200;
                        if (proj.particles) {
                            proj.particles.spawnBlood && proj.particles.spawnBlood(opp.x, opp.y - 40, proj.fighter.facing);
                            proj.particles.spawnSpark && proj.particles.spawnSpark(opp.x, opp.y - 40);
                            proj.particles.spawnShockwave && proj.particles.spawnShockwave(opp.x, opp.y - 40, 2.2);
                        }
                        Audio.playHurt && Audio.playHurt();
                        this._spawnDmgNumber(opp.x, opp.y - 60, proj.def.damage, proj.def.color || '#44aaff');
                        if (window.GameEffects) GameEffects.zoom(1.1, 300);
                    }
                }
                return true;  // beam always travels to edge
            }
            return true;
        });
    }

    // =========================================================
    //  Meteor update (FPT)
    // =========================================================
    _updateMeteors(dt) {
        const groundY = this._mapDef.platforms[0].y;

        this._meteors = this._meteors.filter(m => {
            if (m.exploded) {
                m.tick += dt;
                if (m.tick >= 400) {
                    if (m.sprite) { m.sprite.destroy(); m.sprite = null; }
                    return false;
                }
                return true;  // linger 400ms for explosion anim
            }

            m.tick += dt;
            m.vy += 0.35;  // gravity
            m.x += m.vx;
            m.y += m.vy;

            if (m.sprite) {
                m.sprite.setPosition(m.x, m.y);
                m.sprite.rotation += 0.08;
            }

            // Hit opponents
            for (const opp of m.opponents) {
                if (!opp || opp.state === 'dead' || opp._respawning) continue;
                if (opp.team === m.fighter.team) continue;
                if (m.hitOpponents.has(opp)) continue;
                if (opp.invTimer > 0) continue;
                const dx = opp.x - m.x;
                const dy = (opp.y - 50) - m.y;
                if (dx * dx + dy * dy < m.radius * m.radius) {
                    m.hitOpponents.add(opp);
                    const scale = 1 + (opp.damage || 0) / 100;
                    const F = m.def.forceStrength * scale;
                    const kbDir = opp.x >= m.fighter.x ? 1 : -1;
                    opp.vx = kbDir * F * 0.7;
                    opp.vy = -F * 0.9;
                    opp.onGround = false;
                    opp.damage = (opp.damage || 0) + m.def.damage;
                    opp.hurtTimer = CONFIG.HURT_DURATION;
                    opp.invTimer = 150;
                    if (m.particles) {
                        m.particles.spawnBlood && m.particles.spawnBlood(opp.x, opp.y - 40, 0);
                        m.particles.spawnSpark && m.particles.spawnSpark(opp.x, opp.y - 40);
                        m.particles.spawnShockwave && m.particles.spawnShockwave(m.x, m.y, 1.8);
                    }
                    this._spawnDmgNumber(opp.x, opp.y - 60, m.def.damage, m.def.color || '#ff8844');
                    Audio.playHurt && Audio.playHurt();
                    m.exploded = true;
                    m.tick = 0;
                    if (m.sprite) m.sprite.setVisible(false);
                    return true;
                }
            }

            // Hit ground
            if (m.y >= groundY - 10) {
                if (m.particles) {
                    m.particles.spawnShockwave && m.particles.spawnShockwave(m.x, groundY, 1.5);
                    m.particles.spawnDust && m.particles.spawnDust(m.x, groundY);
                }
                m.exploded = true;
                m.tick = 0;
                if (m.sprite) m.sprite.setVisible(false);
                return true;
            }

            return m.tick < 8000;  // max 8s flight time
        });
    }

    // =========================================================
    //  Projectile render
    // =========================================================
    _renderProjectiles() {
        const g = this._projectileGfx;
        for (const proj of this._projectiles) {
            if (proj.type === 'yasuo') {
                // Swirling wind slash — horizontal streak
                const alpha = 0.7 + Math.sin(proj.tick * 0.03) * 0.3;
                const hw = proj.w * 0.5;
                const hh = proj.h * 0.5;
                // Core blade
                g.fillStyle(0x88ffee, alpha * 0.85);
                g.fillEllipse(proj.x, proj.y, proj.w, proj.h * 0.45);
                // Blade edge lines
                g.lineStyle(2, 0xffffff, alpha * 0.7);
                g.beginPath();
                g.moveTo(proj.x - hw, proj.y);
                g.lineTo(proj.x + hw, proj.y);
                g.strokePath();
                // Wind arcs
                for (let i = 0; i < 3; i++) {
                    const off = (i - 1) * (hh * 0.35);
                    const arcAlpha = (0.5 - Math.abs(i - 1) * 0.15) * alpha;
                    g.lineStyle(1.5, 0x44ffcc, arcAlpha);
                    g.beginPath();
                    g.arc(proj.x, proj.y + off, hw * 0.55, 0, Math.PI, false);
                    g.strokePath();
                }
                // Outer glow
                g.lineStyle(6, 0x88ffee, 0.12 * alpha);
                g.strokeEllipse(proj.x, proj.y, proj.w + 20, proj.h * 0.6);

            } else if (proj.type === 'kamehameha') {
                // Energy beam — expanding from caster to current x
                const owner = proj.fighter;
                const startX = owner ? (owner.x + owner.facing * 30) : (proj.x - Math.sign(proj.vx || 1) * 40);
                const beamLen = Math.abs(proj.x - startX);
                const bx = (startX + proj.x) / 2;
                const by = proj.y;
                const pulse = 0.65 + Math.sin(proj.tick * 0.035) * 0.35;

                // Wide outer glow
                g.fillStyle(0x44aaff, 0.12 * pulse);
                g.fillEllipse(bx, by, beamLen, proj.h * 1.2);
                // Mid layer
                g.fillStyle(0x99ddff, 0.35 * pulse);
                g.fillEllipse(bx, by, beamLen, proj.h * 0.7);
                // Core beam
                g.fillStyle(0xffffff, 0.85 * pulse);
                g.fillEllipse(bx, by, beamLen, proj.h * 0.25);
                // Leading ball
                g.fillStyle(0xaaddff, 0.9 * pulse);
                g.fillCircle(proj.x, proj.y, proj.h * 0.5);
                g.fillStyle(0xffffff, pulse);
                g.fillCircle(proj.x, proj.y, proj.h * 0.2);
            }
        }
    }

    // =========================================================
    //  Meteor render
    // =========================================================
    _renderMeteors() {
        const g = this._meteorGfx;
        for (const m of this._meteors) {
            if (m.exploded) {
                // Explosion ring
                const progress = m.tick / 400;
                const r = m.radius * (0.5 + progress * 1.2);
                g.lineStyle(4, 0xff6600, (1 - progress) * 0.8);
                g.strokeCircle(m.x, m.y, r);
                g.lineStyle(2, 0xffaa00, (1 - progress) * 0.5);
                g.strokeCircle(m.x, m.y, r * 0.6);
                g.fillStyle(0xff8800, (1 - progress) * 0.2);
                g.fillCircle(m.x, m.y, r * 0.55);
                continue;
            }

            if (m.sprite) {
                // Keep a subtle aura/trail while the uploaded meteor sprite is visible.
                const pulseAura = 0.6 + Math.sin(m.tick * 0.04) * 0.4;
                g.fillStyle(0xff8800, 0.16 * pulseAura);
                g.fillCircle(m.x - m.vx * 5, m.y - m.vy * 5, m.radius * 0.75);
                g.fillStyle(0xff5500, 0.10 * pulseAura);
                g.fillCircle(m.x - m.vx * 9, m.y - m.vy * 9, m.radius * 0.52);
                continue;
            }

            const R = m.radius * 0.5;
            const pulse = 0.7 + Math.sin(m.tick * 0.04) * 0.3;

            // Fire trail
            g.fillStyle(0xff8800, 0.18 * pulse);
            g.fillCircle(m.x - m.vx * 4, m.y - m.vy * 4, R * 1.3);
            g.fillStyle(0xff5500, 0.12 * pulse);
            g.fillCircle(m.x - m.vx * 8, m.y - m.vy * 8, R * 0.9);

            // Outer glow
            g.fillStyle(0xff6600, 0.3 * pulse);
            g.fillCircle(m.x, m.y, R * 1.4);
            // Rock body
            g.fillStyle(0x884422, 0.95);
            g.fillCircle(m.x, m.y, R);
            // Hot core
            g.fillStyle(0xff9900, 0.7 * pulse);
            g.fillCircle(m.x, m.y, R * 0.55);
            g.fillStyle(0xffee88, 0.5 * pulse);
            g.fillCircle(m.x, m.y, R * 0.25);
        }
    }

    // =========================================================
    //  Saitama overlay render (screen-space)
    // =========================================================
    _renderSaitamaOverlay() {
        const ov = this._saitamaOverlay;
        if (!ov) return;
        const g = this._overlayGfx;
        g.clear();
        ov.timer += 16.667;
        const progress = ov.timer / ov.maxTime;

        // Dark vignette
        g.fillStyle(0x000000, Math.min(0.7, progress * 2));
        g.fillRect(0, 0, this.scale.width, this.scale.height);

        if (ov.showText) {
            // Draw text via Phaser Text object (create once, reuse)
            if (!this._saitamaText) {
                this._saitamaText = this.add.text(
                    this.scale.width / 2, this.scale.height / 2,
                    'SERIOUS PUNCH',
                    {
                        fontFamily: 'Orbitron, sans-serif',
                        fontSize: '64px',
                        color: '#ffd700',
                        stroke: '#000000',
                        strokeThickness: 8,
                        alpha: 0,
                    }
                ).setOrigin(0.5).setDepth(11).setScrollFactor(0);
            }
            const textProgress = Math.min(1, (ov.timer - (ov.maxTime * 0.28)) / 400);
            const scale = 0.5 + textProgress * 0.5;
            this._saitamaText.setVisible(true);
            this._saitamaText.setAlpha(textProgress);
            this._saitamaText.setScale(scale);
        }
    }

    // Shared hit-application helper used by all ultimates
    _applyUltimateHit(fighter, opponents, particles, def, cx, cy, w, h) {
        const halfW = w / 2;
        const halfH = h / 2;
        for (const opp of opponents) {
            if (!opp || opp.state === 'dead' || opp._respawning) continue;
            if (opp.team === fighter.team) continue;
            if (opp.invTimer > 0) continue;
            const dx = Math.abs(opp.x - cx);
            const dy = Math.abs((opp.y - 50) - cy);
            if (dx <= halfW && dy <= halfH) {
                const scale = 1 + (opp.damage || 0) / 100;
                const F = def.forceStrength * scale;
                const kbDir = opp.x >= fighter.x ? 1 : -1;
                opp.vx = kbDir * F * 0.9;
                opp.vy = -F * 0.7;
                opp.onGround = false;
                opp.damage = (opp.damage || 0) + def.damage;
                opp.hurtTimer = CONFIG.HURT_DURATION;
                opp.invTimer = 180;
                if (particles) {
                    particles.spawnBlood && particles.spawnBlood(opp.x, opp.y - 40, fighter.facing);
                    particles.spawnSpark && particles.spawnSpark(opp.x, opp.y - 40);
                    particles.spawnShockwave && particles.spawnShockwave(opp.x, opp.y - 40, 2.0);
                }
                this._spawnDmgNumber(opp.x, opp.y - 60, def.damage, def.color || '#ffffff');
                if (window.GameEffects) GameEffects.zoom(1.1, 350);
                Audio.playHurt && Audio.playHurt();
            }
        }
    }

    // =========================================================
    //  Damage Number Popup System
    // =========================================================
    _createDmgTextObject() {
        return this.add.text(0, 0, '', {
            fontFamily: 'Orbitron, sans-serif',
            fontSize: '16px',
            color: '#ffd700',
            stroke: '#000000',
            strokeThickness: 4,
        }).setDepth(12).setScrollFactor(0);
    }

    _isDmgTextHealthy(t) {
        return !!(
            t &&
            t.active &&
            t.scene &&
            t.frame &&
            t.frame.source &&
            t.frame.source.image
        );
    }

    _getDmgTextFromPool(index, forceRecreate = false) {
        if (!this._dmgTextPool) this._dmgTextPool = [];

        let t = this._dmgTextPool[index];
        if (forceRecreate || !this._isDmgTextHealthy(t)) {
            if (t && t.destroy) {
                try { t.destroy(); } catch (_) { /* ignore */ }
            }
            t = this._createDmgTextObject();
            this._dmgTextPool[index] = t;
        }
        return t;
    }

    _spawnDmgNumber(wx, wy, amount, color) {
        const cam = this.cameras.main;
        // Convert world → screen
        const sxRaw = (wx - cam.scrollX) * cam.zoom;
        const syRaw = (wy - cam.scrollY) * cam.zoom;
        const sx = Number.isFinite(sxRaw) ? sxRaw : 0;
        const sy = Number.isFinite(syRaw) ? syRaw : 0;
        const safeAmount = Number.isFinite(amount) ? amount : 0;
        const safeColor = (typeof color === 'string' && color.trim()) ? color : '#ffd700';
        const isCrit = safeAmount >= 100;
        this._dmgNumbers.push({
            sx, sy,
            text: '+' + Math.round(safeAmount),
            color: isCrit ? '#ff4444' : safeColor,
            fontSize: isCrit ? 22 : 16,
            life: 1200,     // ms
            maxLife: 1200,
            vy: -0.9,       // drift upward in screen-space px/frame
        });
    }

    _renderDmgNumbers() {
        // Use Phaser Text objects pooled in _dmgTextPool
        if (!this._dmgTextPool) this._dmgTextPool = [];

        const frameDt = 16.667;

        // Trim pool to current numbers count
        while (this._dmgTextPool.length < this._dmgNumbers.length) {
            this._dmgTextPool.push(this._createDmgTextObject());
        }

        // Update alive numbers
        const alive = [];
        let poolIdx = 0;
        for (const n of this._dmgNumbers) {
            n.life -= frameDt;
            n.sy += n.vy;
            if (n.life <= 0) {
                // Hide this pool slot
                if (poolIdx < this._dmgTextPool.length) {
                    const stale = this._dmgTextPool[poolIdx];
                    if (stale && stale.setVisible) stale.setVisible(false);
                    poolIdx++;
                }
                continue;
            }
            alive.push(n);
            const slot = poolIdx++;
            let t = this._getDmgTextFromPool(slot);
            if (!t) continue;
            const alpha = Math.min(1, n.life / (n.maxLife * 0.3));
            const scale = 0.6 + (1 - n.life / n.maxLife) * 0.6;

            try {
                if (t._lastDmgText !== n.text) {
                    t.setText(n.text);
                    t._lastDmgText = n.text;
                }
                if (t._lastDmgColor !== n.color) {
                    t.setColor(n.color);
                    t._lastDmgColor = n.color;
                }
                if (t._lastDmgFontSize !== n.fontSize) {
                    t.setFontSize(n.fontSize);
                    t._lastDmgFontSize = n.fontSize;
                }
                t.setAlpha(alpha);
                t.setScale(scale);
                t.setPosition(n.sx, n.sy);
                t.setVisible(true);
            } catch (err) {
                // Recover from rare Phaser text-frame invalidation at runtime.
                t = this._getDmgTextFromPool(slot, true);
                if (!t) continue;
                t.setText(n.text);
                t.setColor(n.color);
                t.setFontSize(n.fontSize);
                t.setAlpha(alpha);
                t.setScale(scale);
                t.setPosition(n.sx, n.sy);
                t.setVisible(true);
            }
        }

        // Hide any unused pool slots
        for (let i = poolIdx; i < this._dmgTextPool.length; i++) {
            const t = this._dmgTextPool[i];
            if (t && t.setVisible) t.setVisible(false);
        }

        this._dmgNumbers = alive;
    }

    // =========================================================
    //  Hitbox Debug Visualizer (press H)
    // =========================================================
    _renderHitboxDebug() {
        const g = this._debugGfx;

        // Fighter hitboxes (circle = rough body, different for attack/idle)
        for (const f of this.fighters) {
            if (f.state === 'dead') continue;
            const fc = f.colorInt;

            // Body bounding box
            g.lineStyle(1, fc, 0.6);
            g.strokeRect(f.x - 15, f.y - 100, 30, 100);

            // Active attack hitbox
            if (f.state === 'attack' && f.attackType) {
                const atk = CONFIG.ATTACKS[f.attackType];
                if (atk) {
                    const hx = f.x + f.facing * (atk.range * 0.5);
                    const hy = f.y - 50;
                    g.lineStyle(2, 0xff4400, 0.9);
                    g.strokeRect(hx - atk.range * 0.5, hy - atk.yWin * 0.5, atk.range, atk.yWin);
                    // Origin dot
                    g.fillStyle(0xff4400, 1);
                    g.fillCircle(f.x, f.y - 50, 4);
                }
            }

            // V2 ultimate hitbox when in startup
            if (f.state === 'attack' && f.collectedUltimate === null) {
                // Check if a V2 ultimate was just fired — show the hitbox area
                // (we mark it via f._ultiHitboxDebug set by fire())
            }

            // Energy bar above head
            const epct = f.energy / CONFIG.ENERGY.MAX;
            g.lineStyle(1, 0x444444, 0.7);
            g.strokeRect(f.x - 20, f.y - 115, 40, 5);
            g.fillStyle(epct >= 1 ? 0xffd700 : 0x00aaff, 0.85);
            g.fillRect(f.x - 20, f.y - 115, 40 * epct, 5);
        }

        // V2 Projectile hitboxes
        for (const proj of this._projectiles) {
            const hw = proj.w / 2, hh = proj.h / 2;
            g.lineStyle(1.5, 0x88ffee, 0.75);
            g.strokeRect(proj.x - hw, proj.y - hh, proj.w, proj.h);
            // Center cross
            g.lineStyle(1, 0xffffff, 0.5);
            g.beginPath();
            g.moveTo(proj.x - 5, proj.y); g.lineTo(proj.x + 5, proj.y);
            g.moveTo(proj.x, proj.y - 5); g.lineTo(proj.x, proj.y + 5);
            g.strokePath();
        }

        // Meteor hitboxes
        for (const m of this._meteors) {
            if (m.exploded) continue;
            g.lineStyle(1.5, 0xff8844, 0.75);
            g.strokeCircle(m.x, m.y, m.radius);
        }

        // Platform collision boxes (green=solid, cyan=passThrough) + image bounds (yellow)
        // Collision surface = top edge of green/cyan box = where player feet land
        if (this._platforms) {
            for (const plat of this._platforms.platforms) {
                const col = plat.passThrough ? 0x00ffcc : 0x00ff44;
                g.lineStyle(1.5, col, 0.85);
                g.strokeRect(plat.x, plat.y, plat.w, Math.max(plat.h, 4));
                // Dot marks exact collision line (entity.y snaps here)
                g.fillStyle(col, 1);
                g.fillRect(plat.x, plat.y - 1, plat.w, 2);

                // Image visual bounds — yellow (purely visual, separate from collision)
                if (plat._visualBounds) {
                    g.lineStyle(1, 0xffff00, 0.45);
                    g.strokeRect(
                        plat._visualBounds.x,
                        plat._visualBounds.y,
                        plat._visualBounds.w,
                        plat._visualBounds.h
                    );
                }
            }
        }

        // Skill box pickup radii
        const pickupR = CONFIG.SKILL_DROP.pickupRadius;
        for (const box of this._skillBoxes) {
            g.lineStyle(1, 0xffd700, 0.3);
            g.strokeCircle(box.x, box.y, pickupR);
        }

        // Debug label in corner
        if (!this._debugLabel) {
            this._debugLabel = this.add.text(10, 10, '[H] hitbox debug', {
                fontFamily: 'monospace', fontSize: '11px',
                color: '#aaffaa', backgroundColor: '#00000088',
                padding: { x: 4, y: 2 },
            }).setDepth(13).setScrollFactor(0).setVisible(false);
        }
        this._debugLabel.setVisible(true);
    }

    _checkMatchOver() {
        if (this.matchOver) return;
        const mode = this.mode;

        if (mode === 'ffa') {
            const alive = this.fighters.filter(f => f.stocks > 0);
            if (alive.length > 1) return;

            this.matchOver = true;
            this.roundPaused = true;

            const winner = alive[0] || null;
            const title = winner ? `KO! ${winner._name} WINS!` : 'NO CONTEST';
            const local = this.fighters.find(f => f._isLocalNet);
            const headline = winner && local && winner === local ? 'VICTORY!' : 'DEFEAT!';

            this._showResult(
                headline,
                title,
                () => this._restartMatch(),
                () => this._exitToMenu(),
                { continueLabel: 'REMATCH', menuLabel: 'LOBBY' }
            );
            return;
        }

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
                if (p1Won) {
                    const nextRank = this.tournament.getCurrentRank();
                    UI.showRoundResult(
                        'VICTORY!', `Rank up to ${nextRank.name}!`,
                        () => {
                            this.tournament.recordWinner(0);
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
                        },
                        { continueLabel: 'CONTINUE', menuLabel: 'QUIT' }
                    );
                } else {
                    this.tournament.recordWinner(1);
                    this._onTournamentEnd();
                }
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
        const playerWon = !!(champ && champ.isPlayer);
        const reward = this.tournament.getReward();
        
        let title = playerWon ? 'CHAMPION!' : 'LEVEL FAILED';
        let msg = playerWon ? 'You conquered the tower!' : `Tournament ended at floor ${this.tournament.clearedCount + 1}.`;
        
        if (reward) {
            UI.showTournamentWin(
                msg,
                () => {
                    this.tournament = null;
                    this._exitToMenu();
                },
                {
                    title: title,
                    rewardName: reward.name,
                    rewardDesc: reward.desc,
                    rewardColor: reward.color,
                    isCup: reward.type === 'CUP'
                }
            );
        } else {
            this._exitToMenu();
        }
    }

    _showResult(title, subtitle, onContinue, onMenu, options = {}) {
        UI.showRoundResult(title, subtitle, onContinue, onMenu, options);
    }

    _restartMatch() {
        if (this.online) {
            // Online rematch: return to lobby (Net connection is still live)
            this.scene.start('MenuScene', { tournament: null, backToLobby: true });
            return;
        }

        if (this.mode === 'tournament' && this.tournament && this.tournamentMatch) {
            // Retry current floor in tournament mode.
            this.scene.start('GameScene', {
                mode: 'tournament',
                mapKey: this.mapKey,
                tournament: this.tournament,
                tournamentMatch: this.tournamentMatch,
            });
            return;
        }

        // Restart GameScene with the same mode
        this.scene.start('GameScene', {
            mode: this.mode,
            mapKey: this.mapKey,
            aiDifficulty: this.aiDifficulty,
            tournament: null,
        });
    }

    _exitToMenu() {
        if (this.online) Net.disconnect();
        UI.showScreen('menu');
        document.getElementById('overlay-pause').classList.add('hidden');
        const guide = document.getElementById('pause-guide');
        if (guide) guide.classList.add('hidden');
        this.scene.start('MenuScene', { tournament: null });
    }

    // =========================================================
    //  Pause
    // =========================================================
    _togglePause() {
        if (this.matchOver || this.roundPaused) return;
        this.isPaused = !this.isPaused;
        const ov = document.getElementById('overlay-pause');
        const guide = document.getElementById('pause-guide');
        if (this.isPaused) {
            ov.classList.remove('hidden');
            if (guide) guide.classList.add('hidden');
            this.scene.pause();   // Pauses updates AND Phaser timers
        } else {
            this._resumeFromPause();
        }
    }

    _resumeFromPause() {
        this.isPaused = false;
        document.getElementById('overlay-pause').classList.add('hidden');
        const guide = document.getElementById('pause-guide');
        if (guide) guide.classList.add('hidden');
        this.scene.resume();
    }

    _rematchFromPause() {
        if (!this.isPaused) return;
        this.isPaused = false;
        document.getElementById('overlay-pause').classList.add('hidden');
        this.scene.resume();
        this._restartMatch();
    }

    _togglePauseGuide() {
        if (!this.isPaused) return;
        const guide = document.getElementById('pause-guide');
        if (!guide) return;
        guide.classList.toggle('hidden');
    }

    // =========================================================
    //  Background Texture — image if loaded, else procedural canvas
    // =========================================================
    _buildBackgroundTexture() {
        const C = CONFIG;
        const bgKey = `bg_${this.mapKey}`;
        const mapW = this._mapDef.canvasWidth || C.WIDTH;
        const mapH = this._mapDef.canvasHeight || C.HEIGHT;

        // ---- Use loaded map image if available ----
        if (this.textures.exists(bgKey)) {
            this.add.image(mapW / 2, mapH / 2, bgKey)
                .setDisplaySize(mapW, mapH)
                .setDepth(0)
                .setScrollFactor(0);
            return;
        }

        // ---- Procedural fallback (themed per map) ----
        const W = mapW, H = mapH;
        const key = `stageBg_${this.mapKey}`;

        if (!this.textures.exists(key)) {
            const ct = this.textures.createCanvas(key, W, H);
            const ctx = ct.getContext();

            // Sky gradient — colours vary by map
            const skyColors = {
                naruto: ['#1a0800', '#2a1000', '#1a0500'],
                dragonball: ['#080018', '#10002a', '#0d001e'],
                fptsoftware: ['#000a14', '#001428', '#000814'],
                voidrift: ['#06010e', '#130426', '#04000a'],
            };
            const [c0, c1, c2] = skyColors[this.mapKey] || ['#080818', '#0d0d28', '#120820'];
            const g = ctx.createLinearGradient(0, 0, 0, H);
            g.addColorStop(0, c0);
            g.addColorStop(0.5, c1);
            g.addColorStop(1, c2);
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);

            // Stars (scaled to map size)
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            for (let i = 0; i < 80; i++) {
                const sx = ((i * 173 + 37) % W);
                const sy = ((i * 97 + 19) % (H * 0.55));
                const r = (i % 3 === 0) ? 1.2 : 0.6;
                ctx.globalAlpha = 0.3 + (i % 5) * 0.1;
                ctx.beginPath();
                ctx.arc(sx, sy, r, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;

            // City silhouette — colour matches map theme
            const silColors = {
                naruto: 'rgba(30,12,0,0.8)',
                dragonball: 'rgba(12,0,28,0.8)',
                fptsoftware: 'rgba(0,10,20,0.8)',
                voidrift: 'rgba(24,0,32,0.78)',
            };
            const buildings = [
                { x: 0, w: 70, h: 220 }, { x: 80, w: 45, h: 170 }, { x: 135, w: 90, h: 270 },
                { x: 235, w: 60, h: 200 }, { x: 305, w: 38, h: 145 }, { x: 355, w: 75, h: 235 },
                { x: 450, w: 55, h: 185 }, { x: 515, w: 95, h: 280 }, { x: 625, w: 50, h: 160 },
                { x: 685, w: 70, h: 225 }, { x: 770, w: 55, h: 195 }, { x: 840, w: 88, h: 250 },
                { x: 940, w: 60, h: 175 }, { x: 1010, w: 50, h: 155 }, { x: 1075, w: 80, h: 240 },
                { x: 1165, w: 55, h: 180 }, { x: 1230, w: 50, h: 160 },
            ];
            const gy = this._mapDef.platforms[0].y;
            ctx.fillStyle = silColors[this.mapKey] || 'rgba(18,18,45,0.8)';
            buildings.forEach(b => ctx.fillRect(b.x, gy - b.h, b.w, b.h));

            if (this.mapKey === 'voidrift') {
                // Rift core + cracks for a more iconic nightmare stage look.
                const cx = W * 0.5;
                const cy = H * 0.38;
                const rg = ctx.createRadialGradient(cx, cy, 20, cx, cy, 260);
                rg.addColorStop(0, 'rgba(244,180,255,0.95)');
                rg.addColorStop(0.18, 'rgba(201,82,255,0.65)');
                rg.addColorStop(0.42, 'rgba(84,20,130,0.35)');
                rg.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = rg;
                ctx.beginPath();
                ctx.arc(cx, cy, 260, 0, Math.PI * 2);
                ctx.fill();

                ctx.strokeStyle = 'rgba(214,118,255,0.38)';
                ctx.lineWidth = 3;
                for (let i = 0; i < 9; i++) {
                    const sx = 120 + i * 165;
                    const ex = sx + (i % 2 === 0 ? 60 : -70);
                    const sy = gy - 130 - (i % 3) * 45;
                    const ey = sy - 110 - (i % 2) * 35;
                    ctx.beginPath();
                    ctx.moveTo(sx, sy);
                    ctx.lineTo((sx + ex) * 0.5, (sy + ey) * 0.5 - 22);
                    ctx.lineTo(ex, ey);
                    ctx.stroke();
                }
            }

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
        this._skillBoxGfx.clear();
        this._projectileGfx.clear();
        this._meteorGfx.clear();
        this._debugGfx.clear();
        this._dmgGfx.clear();
        if (!this._saitamaOverlay) {
            this._overlayGfx.clear();
            if (this._saitamaText) this._saitamaText.setVisible(false);
        }
        for (const g of this._fighterGfxArr) g.clear();

        // Platforms
        this._platforms.draw(this._platGfx);

        // Wall-grab contact glow (rendered over platforms, behind fighters)
        this._renderWallGrabFX(this._platGfx);

        // V2 skill boxes
        this._renderSkillBoxes();

        // V2 projectiles & meteors
        this._renderProjectiles();
        this._renderMeteors();

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

        // Hitbox debug visualizer (press H)
        if (this._debugHitbox) this._renderHitboxDebug();

        // Damage number popups (screen-space)
        this._renderDmgNumbers();

        // Saitama screen overlay (screen-space, topmost)
        if (this._saitamaOverlay) this._renderSaitamaOverlay();
    }

    _drawAfterImages() {
        const g = this._afterImgGfx;
        const arr = this._afterImages;
        let w = 0;
        for (let i = 0; i < arr.length; i++) {
            const ai = arr[i];
            ai.life -= 16.667;
            if (ai.life <= 0) continue;
            // Encode the desired alpha into the state snapshot so Stickman can
            // apply it per-draw-command via lineStyle alpha (works in WebGL).
            ai.state.dimAlpha = (ai.life / ai.maxLife) * 0.4;
            ai.renderer.draw(g, ai.state);
            arr[w++] = ai;
        }
        arr.length = w;
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

            const plat = f.wallPlatform;
            const isLeft = (f.wallDir > 0);  // fighter on the LEFT-SIDE face of platform
            const wallX = isLeft ? plat.x : plat.x + plat.w;

            // Vertical contact band: centre on fighter body height, not feet
            const contactY = Phaser.Math.Clamp(
                f.y - 50, plat.y + 6, plat.y + plat.h - 6
            );

            // Fighter color as integer
            const fc = f.colorInt;
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
                const a = (si / sparkCount) * Math.PI * 2 + pt;
                const sr = 16 + Math.sin(pt * 6 + si) * 4;
                const ex = wallX + Math.cos(a) * sr;
                const ey = (contactY - 18) + Math.sin(a) * sr;
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

    _hostBroadcastNetState(delta) {
        this._netStateAccum += delta;
        this._netFullStateTimer += delta;

        while (this._netStateAccum >= this._netStateInterval) {
            this._netStateAccum -= this._netStateInterval;
            let forceFullWorld = false;
            if (this._netFullStateTimer >= this._forceFullStateEveryMs) {
                this._prevSnapshot = null; // periodic hard refresh baseline
                this._hadWorldContent = true; // force world resync on full-state tick
                this._netFullStateTimer = 0;
                forceFullWorld = true;
            }

            const fighters = this._makeSnapshot();
            const world = this._makeWorldSnapshot(forceFullWorld);
            // Skip packet entirely when both fighters and world are empty/unchanged.
            if (fighters === null && world === null) continue;
            Net.broadcastState({
                seq: ++this._netStateSeq,
                t: Math.round(this.time.now || 0),
                fighters,
                world,
            });
        }
    }

    /** Wire Net callbacks at the start of each online match. */
    _setupOnlineCallbacks() {
        if (Net.role === 'host') {
            // Host receives input events from every client
            Net.onInputReceived = (pid, input, edges) => {
                const f = this.fighters.find(f => f._netPlayerId === pid);
                if (!f || f._isLocalNet) return;
                // Detect rising edges at receipt time and store them on the fighter
                // BEFORE calling setInput (which overwrites _prevInput).
                // Because guest now sends every frame, we compare against the current
                // live input state — if the key is newly pressed this packet, it's a
                // rising edge. The counter lets two rapid presses (double-jump) both
                // be processed on successive host update ticks.
                const isTotalMode = !!(edges && edges._mode === 'total');
                if (isTotalMode && !f._netEdgeSeen) {
                    f._netEdgeSeen = { up: 0, light: 0, heavy: 0, dodge: 0, drop: 0 };
                }

                for (const k of ['up', 'light', 'heavy', 'dodge', 'drop']) {
                    if (isTotalMode) {
                        const total = Math.max(0, Number(edges[k]) || 0);
                        const seen = Math.max(0, Number(f._netEdgeSeen[k]) || 0);
                        if (total > seen) {
                            f['_netRise_' + k] = (f['_netRise_' + k] || 0) + (total - seen);
                        }
                        f._netEdgeSeen[k] = Math.max(seen, total);
                    } else {
                        const explicit = Number(edges && edges[k]) || 0;
                        if (explicit > 0) {
                            f['_netRise_' + k] = (f['_netRise_' + k] || 0) + explicit;
                        } else if (!f.input[k] && input[k]) {
                            f['_netRise_' + k] = (f['_netRise_' + k] || 0) + 1;
                        }
                    }
                }
                f.setInput(input);
            };
        } else {
            // Client receives authoritative state from host
            Net.onStateReceived = payload => {
                const normalised = (payload && !Array.isArray(payload))
                    ? payload
                    : { fighters: payload || null, world: null };

                const seq = Number(normalised.seq) || 0;
                if (seq && seq <= this._lastRecvStateSeq) return;
                if (seq) this._lastRecvStateSeq = seq;

                this._latestSnapshot = normalised;  // keep ref for potential debug
                this._newSnapshot = normalised;  // consumed once in update()
            };
            Net.onHostDisconnect = () => this._onOnlineDisconnect();
        }
        Net.onError = err => {
            if (!this.matchOver) console.error('[GameScene Net]', err);
        };
    }

    /** Serialize all fighters into a compact delta snapshot for broadcast.
     *
     *  Delta strategy — only fields that actually changed are included per fighter.
     *  Idle fighters (not moving, not in combat) produce zero changed fields → the
     *  whole snapshot becomes null → NO packet is sent that frame.
     *
     *  Fields intentionally OMITTED from the network payload:
     *   • tk  (animation tick) — increments every single frame, so including it would
     *     pollute every delta and guarantee a packet even when nothing is happening.
     *     Clients maintain their own tick locally (_updateFighters increments it
     *     independently), so network sync is redundant and wasteful.
     */
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
            at: Math.max(0, Math.round(f.atkTimer || 0)),
            ad: Math.max(0, Math.round(f.atkDuration || 0)),
            dmg: Math.round(f.damage),
            stk: f.stocks,
            eng: Math.round(f.energy),
            // tk intentionally omitted — see comment above
            inv: f.invTimer > 0 ? Math.round(f.invTimer) : 0,
            hrt: f.hurtTimer > 0 ? Math.round(f.hurtTimer) : 0,
            re: f._respawning ? 1 : 0,
            sk: f.collectedSkill || null,
            uk: f.collectedUltimate || null,
        }));

        const prev = this._prevSnapshot;
        this._prevSnapshot = now;

        // First frame — always send full snapshot
        if (!prev) return now;

        // Subsequent frames — delta: only include fighters with changed fields.
        // A fighter standing still with no active combat produces an empty diff
        // → not included in delta → if ALL fighters are idle, delta is empty
        // → null is returned → Net.broadcastState is skipped entirely.
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
            chk('fa'); chk('st'); chk('atk'); chk('at'); chk('ad'); chk('dmg'); chk('stk'); chk('eng');
            // Timers: include when either side is non-zero (transition in or out)
            if (n.inv > 0 || p.inv > 0) { d.inv = n.inv; changed = true; }
            if (n.hrt > 0 || p.hrt > 0) { d.hrt = n.hrt; changed = true; }
            chk('re'); chk('sk'); chk('uk');

            if (changed) delta.push(d);
        }
        return delta.length > 0 ? delta : null; // null = nothing changed, no packet sent
    }

    _makeWorldSnapshot(force = false) {
        // Determine whether there is any active world content this tick.
        const hasPhasedPlatforms = this._platforms && this._platforms.platforms
            ? this._platforms.platforms.some(p => p._phaseCycleMs)
            : false;
        const hasContent =
            this._skillBoxes.length > 0 ||
            this._projectiles.length > 0 ||
            this._meteors.length > 0 ||
            this._netSaitamaCast != null ||
            hasPhasedPlatforms;

        if (!hasContent) {
            if (this._hadWorldContent || force) {
                // Transition: send one empty flush so clients clear their local state.
                this._hadWorldContent = false;
                return { platforms: [], skillBoxes: [], projectiles: [], meteors: [], saitamaCast: null };
            }
            // Nothing active, nothing changed — skip world entirely.
            return null;
        }

        this._hadWorldContent = true;
        return {
            platforms: (this._platforms && this._platforms.platforms)
                ? this._platforms.platforms
                    .filter(p => p && p.id && (p.passThrough || p._phaseCycleMs))
                    .map(p => ({
                        id: p.id,
                        x: +p.x.toFixed(2),
                        y: +p.y.toFixed(2),
                        pa: p._phaseActive === false ? 0 : 1,
                        pal: Number.isFinite(p._phaseAlpha) ? +p._phaseAlpha.toFixed(3) : 1,
                    }))
                : [],
            skillBoxes: this._skillBoxes.map(b => ({
                id: b.id,
                u: b.ultimateId,
                x: +b.x.toFixed(2),
                y: +b.y.toFixed(2),
                t: +b.animTick.toFixed(3),
                l: Math.max(0, Math.round(b.lifetime || 0)),
            })),
            projectiles: this._projectiles.map(p => ({
                id: p.id,
                tp: p.type,
                o: p.fighter ? p.fighter._netPlayerId : null,
                x: +p.x.toFixed(2),
                y: +p.y.toFixed(2),
                vx: +p.vx.toFixed(2),
                w: p.w,
                h: p.h,
                tk: +p.tick.toFixed(2),
            })),
            meteors: this._meteors.map(m => ({
                id: m.id,
                o: m.fighter ? m.fighter._netPlayerId : null,
                x: +m.x.toFixed(2),
                y: +m.y.toFixed(2),
                vx: +m.vx.toFixed(2),
                vy: +m.vy.toFixed(2),
                r: m.radius,
                tk: +m.tick.toFixed(2),
                ex: m.exploded ? 1 : 0,
            })),
            saitamaCast: this._netSaitamaCast
                ? {
                    seq: this._netSaitamaCast.seq,
                    owner: this._netSaitamaCast.owner,
                    freezeDur: this._netSaitamaCast.freezeDur,
                    startDelay: this._netSaitamaCast.startDelay,
                    videoDuration: this._netSaitamaCast.videoDuration,
                }
                : null,
        };
    }

    /** Apply a server snapshot (may be full or delta) to local fighter objects (client only). */
    _applySnapshot(snapshots) {
        for (const snap of snapshots) {
            const f = this.fighters.find(f => f._netPlayerId === snap.npid);
            if (!f) continue;

            if (f._isLocalNet) {
                // Host is the authoritative source. Hard-sync ALL state from every
                // snapshot. Because host now broadcasts every frame and guest sends
                // input every frame, the positions are tightly coupled — there is no
                // "client prediction divergence" to work around, so soft-lerp
                // reconciliation is both unnecessary and harmful (it was the cause of
                // the perceived lag and sync drift under the old change-only scheme).
                if (snap.x !== undefined) f.x = snap.x;
                if (snap.y !== undefined) f.y = snap.y;
                if (snap.vx !== undefined) f.vx = snap.vx;
                if (snap.vy !== undefined) f.vy = snap.vy;
                if (snap.fa !== undefined) f.facing = snap.fa;
                if (snap.st !== undefined) f.state = snap.st;
                if (snap.atk !== undefined) f.attackType = snap.atk;
                if (snap.ad !== undefined) f.atkDuration = snap.ad;
                if (snap.at !== undefined) {
                    f.atkTimer = snap.at;
                    f.atkProgress = (f.atkDuration > 0) ? (1 - (f.atkTimer / f.atkDuration)) : 0;
                }
                if (snap.dmg !== undefined) f.damage = snap.dmg;
                if (snap.stk !== undefined) f.stocks = snap.stk;
                if (snap.eng !== undefined) f.energy = snap.eng;
                if (snap.inv !== undefined) f.invTimer = snap.inv;
                if (snap.hrt !== undefined) f.hurtTimer = snap.hrt;
                if (snap.re !== undefined) f._respawning = !!snap.re;
                if (snap.sk !== undefined) f.collectedSkill = snap.sk;
                if (snap.uk !== undefined) f.collectedUltimate = snap.uk;
                // Re-run platform collision after every position sync so onGround
                // is immediately correct and the fighter never clips through the floor.
                if (this._platforms) this._platforms.resolve(f);
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
                if (snap.ad !== undefined) f.atkDuration = snap.ad;
                if (snap.at !== undefined) {
                    f.atkTimer = snap.at;
                    f.atkProgress = (f.atkDuration > 0) ? (1 - (f.atkTimer / f.atkDuration)) : 0;
                }
                if (snap.dmg !== undefined) f.damage = snap.dmg;
                if (snap.stk !== undefined) f.stocks = snap.stk;
                if (snap.eng !== undefined) f.energy = snap.eng;
                // tk not synced — clients increment tick locally in _updateFighters
                if (snap.inv !== undefined) f.invTimer = snap.inv;
                if (snap.hrt !== undefined) f.hurtTimer = snap.hrt;
                if (snap.re !== undefined) f._respawning = !!snap.re;
                if (snap.sk !== undefined) f.collectedSkill = snap.sk;
                if (snap.uk !== undefined) f.collectedUltimate = snap.uk;
            }
        }
    }

    _applyWorldSnapshot(world) {
        if (!world || Net.role !== 'client') return;

        if (Array.isArray(world.platforms) && this._platforms && this._platforms.platforms) {
            const byId = new Map(world.platforms.map(p => [p.id, p]));
            for (const plat of this._platforms.platforms) {
                if (!plat || !plat.id) continue;
                const snap = byId.get(plat.id);
                if (!snap) continue;

                plat.x = snap.x;
                plat.y = snap.y;
                if (snap.pa !== undefined) plat._phaseActive = !!snap.pa;
                if (snap.pal !== undefined) plat._phaseAlpha = snap.pal;

                const img = this._platforms._platImages && this._platforms._platImages[plat.id];
                if (img) {
                    const visualX = plat.x + (plat._visualDx || 0);
                    const visualY = plat.y + (plat._visualDy || 0);
                    img.setPosition(visualX + (plat._visualW || plat.w) / 2, visualY);
                    if (plat._phaseCycleMs) img.setAlpha(Number.isFinite(plat._phaseAlpha) ? plat._phaseAlpha : 1);
                }
            }
        }

        if (Array.isArray(world.skillBoxes)) this._syncRemoteSkillBoxes(world.skillBoxes);
        if (Array.isArray(world.projectiles)) {
            this._projectiles = world.projectiles.map(p => ({
                id: p.id,
                type: p.tp,
                x: p.x,
                y: p.y,
                vx: p.vx,
                w: p.w,
                h: p.h,
                tick: p.tk,
                fighter: this.fighters.find(f => f._netPlayerId === p.o) || null,
            }));
        }
        if (Array.isArray(world.meteors)) this._syncRemoteMeteors(world.meteors);
        this._syncRemoteSaitamaCast(world.saitamaCast || null);
    }

    _syncRemoteSaitamaCast(cast) {
        if (!cast || !cast.seq) return;
        if (cast.seq <= this._lastHandledSaitamaCastSeq) return;
        this._lastHandledSaitamaCastSeq = cast.seq;

        const def = (CONFIG.ULTIMATE_SKILLS && CONFIG.ULTIMATE_SKILLS.saitama) || {};
        const freezeDur = Number.isFinite(cast.freezeDur) ? cast.freezeDur : (def.freezeScreenDuration || 500);
        const owner = this.fighters.find(f => f._netPlayerId === cast.owner) || null;

        this._saitamaOverlay = { timer: 0, maxTime: freezeDur + 350, fighter: owner, showText: true };
        this._playSaitamaVideo(def, () => {
            this._saitamaOverlay = null;
            this._overlayGfx.clear();
            if (this._saitamaText) this._saitamaText.setVisible(false);
        });
    }

    _syncRemoteSkillBoxes(serialized) {
        const existing = new Map(this._skillBoxes.map(b => [b.id, b]));
        const next = [];

        for (const sb of serialized) {
            let box = existing.get(sb.id);
            if (!box) {
                box = {
                    id: sb.id,
                    ultimateId: sb.u,
                    x: sb.x,
                    y: sb.y,
                    vx: 0,
                    vy: 0,
                    gravity: 0,
                    bouncy: false,
                    animTick: sb.t || 0,
                    lifetime: sb.l || 0,
                    onGround: false,
                    sprite: null,
                };
                const spriteKey = this._ultimateIconTextureKey(sb.u);
                if (this.textures.exists(spriteKey)) {
                    box.sprite = this.add.image(box.x, box.y, spriteKey).setDepth(2.65);
                    box.sprite.setDisplaySize(26, 26);
                }
            }

            box.ultimateId = sb.u;
            box.x = sb.x;
            box.y = sb.y;
            box.animTick = sb.t || 0;
            box.lifetime = sb.l || 0;
            if (box.sprite) box.sprite.setPosition(box.x, box.y);
            next.push(box);
            existing.delete(sb.id);
        }

        for (const stale of existing.values()) this._destroySkillBoxVisual(stale);
        this._skillBoxes = next;
    }

    _syncRemoteMeteors(serialized) {
        const existing = new Map(this._meteors.map(m => [m.id, m]));
        const next = [];
        const meteorTex = this._meteorTextureKey();

        for (const sm of serialized) {
            let m = existing.get(sm.id);
            if (!m) {
                m = {
                    id: sm.id,
                    x: sm.x,
                    y: sm.y,
                    vx: sm.vx,
                    vy: sm.vy,
                    radius: sm.r,
                    fighter: this.fighters.find(f => f._netPlayerId === sm.o) || null,
                    def: null,
                    opponents: [],
                    particles: null,
                    hitOpponents: new Set(),
                    tick: sm.tk || 0,
                    exploded: !!sm.ex,
                    sprite: null,
                };

                if (this.textures.exists(meteorTex)) {
                    const size = (m.radius || 55) * 1.8;
                    m.sprite = this.add.image(m.x, m.y, meteorTex).setDepth(3.45);
                    m.sprite.setDisplaySize(size, size);
                }
            }

            m.x = sm.x;
            m.y = sm.y;
            m.vx = sm.vx;
            m.vy = sm.vy;
            m.radius = sm.r;
            m.tick = sm.tk || 0;
            m.exploded = !!sm.ex;
            m.fighter = this.fighters.find(f => f._netPlayerId === sm.o) || m.fighter;

            if (m.sprite) {
                m.sprite.setPosition(m.x, m.y);
                m.sprite.setVisible(!m.exploded);
            }

            next.push(m);
            existing.delete(sm.id);
        }

        for (const stale of existing.values()) {
            if (stale.sprite) {
                stale.sprite.destroy();
                stale.sprite = null;
            }
        }

        this._meteors = next;
    }

    /** Client: send local input on fixed tick, with immediate edge/change flush. */
    _sendLocalInput(delta) {
        const localF = this.fighters.find(f => f._isLocalNet);
        if (!localF) return;

        const keys = ['left', 'right', 'up', 'down', 'light', 'heavy', 'dodge', 'drop'];
        const nowInput = localF.input;

        const edgeKeys = ['up', 'light', 'heavy', 'dodge', 'drop'];
        const hasRisingEdge = edgeKeys.some(k => !!nowInput[k] && !localF._prevInput[k]);
        const changed = !this._lastSentInput || keys.some(k => !!nowInput[k] !== !!this._lastSentInput[k]);

        this._netInputAccum += delta;
        const edges = this._pendingInputEdges || { up: 0, light: 0, heavy: 0, dodge: 0, drop: 0 };
        const edgeTotals = this._inputEdgeTotals || { up: 0, light: 0, heavy: 0, dodge: 0, drop: 0 };
        const hasPendingEdges = (edges.up + edges.light + edges.heavy + edges.dodge + edges.drop) > 0;
        const due = this._netInputAccum >= this._netInputInterval;
        if (!due && !hasRisingEdge && !changed && !hasPendingEdges) return;

        Net.sendInput(nowInput, {
            _mode: 'total',
            up: edgeTotals.up,
            light: edgeTotals.light,
            heavy: edgeTotals.heavy,
            dodge: edgeTotals.dodge,
            drop: edgeTotals.drop,
        });
        this._lastSentInput = {
            left: !!nowInput.left,
            right: !!nowInput.right,
            up: !!nowInput.up,
            down: !!nowInput.down,
            light: !!nowInput.light,
            heavy: !!nowInput.heavy,
            dodge: !!nowInput.dodge,
            drop: !!nowInput.drop,
        };
        this._pendingInputEdges = { up: 0, light: 0, heavy: 0, dodge: 0, drop: 0 };
        this._netInputAccum = 0;
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

        const B = this._blastBounds || { left: C.BLAST_LEFT, right: C.BLAST_RIGHT, top: C.BLAST_TOP, bottom: C.BLAST_BOTTOM };
        const sx_L = toSX(B.left);
        const sx_R = toSX(B.right);
        const sy_B = toSY(B.bottom);

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
