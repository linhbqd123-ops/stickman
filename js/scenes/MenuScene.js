'use strict';
/* =========================================================
   MENU SCENE — Drives all DOM-based menus.
   Starts GameScene with a data payload when a match begins.
   When GameScene finishes it calls scene.start('MenuScene', payload)
   so we can resume the tournament bracket if needed.
   ========================================================= */
class MenuScene extends Phaser.Scene {
    constructor() { super({ key: 'MenuScene' }); }

    // Called each time MenuScene is (re)started.
    // data.tournament  — Tournament instance to resume (optional)
    // data.showBracket — show bracket immediately (optional)
    init(data) {
        this._tournament = (data && data.tournament) ? data.tournament : null;
        this._showBracket = !!(data && data.showBracket);
        this._backToLobby = !!(data && data.backToLobby);
        this._selectedMap = (data && data.mapKey) || CONFIG.DEFAULT_MAP;
        this._selectedAiDifficulty = (data && data.aiDifficulty) || 'medium';
        this._pendingMode = null;
        this._pendingAiDifficulty = this._selectedAiDifficulty;
    }

    create() {
        // Wire multi-use "data-action" buttons (re-wire to avoid duplicate listeners).
        // Clone trick: replace node with its clone to strip old listeners.
        this._rewireMenuButtons();
        this._setAiDifficulty(this._selectedAiDifficulty);
        this._showAiDifficulty(false);

        // Wire one-time bracket buttons
        this._rewireBtn('btn-bracket-start', () => this._beginCurrentTournamentMatch());
        this._rewireBtn('btn-bracket-menu', () => {
            this._tournament = null;
            UI.showScreen('menu');
        });

        // ---- Map selection cards ----
        document.querySelectorAll('.map-card').forEach(card => {
            const clone = card.cloneNode(true);
            card.replaceWith(clone);
        });
        document.querySelectorAll('.map-card').forEach(card => {
            card.addEventListener('click', () => {
                Audio.resume && Audio.resume();
                const mapKey = card.dataset.map;
                if (mapKey && this._pendingMode) {
                    this._selectedMap = mapKey;
                    this._launchGame(this._pendingMode, mapKey);
                }
            });
        });

        // Wire pause overlay buttons (to be used by GameScene via events).
        // MenuScene registers them once; GameScene emits events.
        this._rewireBtn('btn-resume', () => this.game.events.emit('game:resume'));
        this._rewireBtn('btn-rematch', () => this.game.events.emit('game:rematch'));
        this._rewireBtn('btn-guide-toggle', () => {
            document.getElementById('overlay-guide').classList.remove('hidden');
        });
        this._rewireBtn('btn-close-guide', () => {
            document.getElementById('overlay-guide').classList.add('hidden');
        });
        this._rewireBtn('btn-exit-match', () => this.game.events.emit('game:exit'));

        // Tournament win overlay
        this._rewireBtn('btn-trophy-menu', () => {
            document.getElementById('overlay-tournament-win').classList.add('hidden');
            this._tournament = null;
            UI.showScreen('menu');
        });

        // ── Online lobby static buttons ──
        this._rewireBtn('btn-copy-link', () => this._copyRoomLink());
        this._rewireBtn('btn-lobby-ready', () => this._toggleReady());
        this._rewireBtn('btn-lobby-start', () => this._hostStartGame());
        this._rewireBtn('btn-lobby-leave', () => this._leaveLobby());

        // Mode pills inside lobby
        document.querySelectorAll('.mode-pill').forEach(pill => {
            const clone = pill.cloneNode(true);
            pill.replaceWith(clone);
        });
        document.querySelectorAll('.mode-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                if (Net.role !== 'host') return;
                const mode = pill.dataset.mode;
                Net.setMode(mode);
                document.querySelectorAll('.mode-pill').forEach(p =>
                    p.classList.toggle('active', p.dataset.mode === mode));
            });
        });

        // Map pills inside lobby (host only — wired here, visibility toggled in _openLobby)
        document.querySelectorAll('#lobby-map-pills .map-pill').forEach(pill => {
            const clone = pill.cloneNode(true);
            pill.replaceWith(clone);
        });
        document.querySelectorAll('#lobby-map-pills .map-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                if (Net.role !== 'host') return;
                const mapKey = pill.dataset.map;
                Net.setMap(mapKey);
                UI.renderLobbyMap(mapKey);
            });
        });

        if (this._backToLobby && Net.role && Net.token) {
            // Returning from an online game — restore the lobby view
            this._setupLobbyCallbacks();
            this._openLobby(Net.token, Net.role === 'host');
        } else if (this._showBracket && this._tournament) {
            UI.showBracketScreen(
                this._tournament,
                () => this._beginCurrentTournamentMatch(),
                () => { this._tournament = null; UI.showScreen('menu'); }
            );
        } else {
            // Check URL for auto-join (?room=TOKEN)
            const urlToken = new URLSearchParams(window.location.search).get('room');
            if (urlToken) {
                this._autoJoin(urlToken);
            } else {
                UI.showScreen('menu');
            }
        }
    }

    // ─────────────────────────────────────────────────────────
    //  Button Utilities
    // ─────────────────────────────────────────────────────────
    _rewireBtn(id, fn) {
        const el = document.getElementById(id);
        if (!el) return;
        const clone = el.cloneNode(true);
        el.replaceWith(clone);
        document.getElementById(id).addEventListener('click', () => {
            Audio.resume && Audio.resume();
            fn();
        });
    }

    _rewireMenuButtons() {
        document.querySelectorAll('[data-action]').forEach(btn => {
            const clone = btn.cloneNode(true);
            btn.replaceWith(clone);
        });
        document.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', () => {
                Audio.resume && Audio.resume();
                this._handleMenuAction(btn.dataset.action);
            });
        });
    }

    // ─────────────────────────────────────────────────────────
    //  Menu Action Handler
    // ─────────────────────────────────────────────────────────
    _handleMenuAction(action) {
        switch (action) {
            case 'play-menu':
                UI.showScreen('mode-select');
                this._showAiDifficulty(false);
                break;
            case 'back-menu':
                UI.showScreen('menu');
                this._showAiDifficulty(false);
                break;
            case 'back-map-select':
                UI.showScreen('mode-select');
                this._showAiDifficulty(false);
                break;
            case '1v1-pvp': this._showMapSelect('1v1'); break;
            case '1v1-ai': this._showAiDifficulty(); break;
            case '1v1-ai-easy': this._setAiDifficulty('easy'); this._showMapSelect('1vAI', 'easy'); break;
            case '1v1-ai-medium': this._setAiDifficulty('medium'); this._showMapSelect('1vAI', 'medium'); break;
            case '1v1-ai-hard': this._setAiDifficulty('hard'); this._showMapSelect('1vAI', 'hard'); break;
            case '2v2': this._show2v2Difficulty(); break;
            case '2v2-easy': this._set2v2Difficulty('easy'); this._showMapSelect('2v2', 'easy'); break;
            case '2v2-medium': this._set2v2Difficulty('medium'); this._showMapSelect('2v2', 'medium'); break;
            case '2v2-hard': this._set2v2Difficulty('hard'); this._showMapSelect('2v2', 'hard'); break;
            case 'tournament': UI.showScreen('tournament-setup'); break;
            case 'start-tournament': this._startTournament(); break;
            // ── Online ──
            case 'online': this._showOnlineMenu(); break;
            case 'online-create': this._createRoom(); break;
            case 'online-join-show': this._showJoinForm(); break;
            case 'online-join-confirm': this._joinRoom(); break;
            default: break;
        }
    }

    // ─────────────────────────────────────────────────────────
    //  Map Selection
    // ────────────────────────────────────────────────────────────
    _showMapSelect(mode, aiDifficulty = null) {
        this._showAiDifficulty(false);
        this._show2v2Difficulty(false);
        this._pendingMode = mode;
        if (mode === '1vAI') {
            this._pendingAiDifficulty = aiDifficulty || this._selectedAiDifficulty || 'medium';
            this._selectedAiDifficulty = this._pendingAiDifficulty;
            this._setAiDifficulty(this._selectedAiDifficulty);
        } else if (mode === '2v2') {
            this._pendingAiDifficulty = aiDifficulty || this._selectedAiDifficulty || 'medium';
            this._selectedAiDifficulty = this._pendingAiDifficulty;
            this._set2v2Difficulty(this._selectedAiDifficulty);
        }
        // Highlight previously selected map
        document.querySelectorAll('.map-card').forEach(card => {
            card.classList.toggle('selected', card.dataset.map === this._selectedMap);
        });
        UI.showScreen('map-select');
    }

    // ────────────────────────────────────────────────────────────
    //  Offline Game Launch
    // ────────────────────────────────────────────────────────────
    _launchGame(mode, mapKey) {
        UI.showScreen('game');
        this.scene.start('GameScene', {
            mode,
            mapKey: mapKey || this._selectedMap,
            aiDifficulty: (mode === '1vAI' || mode === '2v2') ? this._selectedAiDifficulty : null,
            tournament: this._tournament,
            tournamentMatch: null,
        });
    }

    _setAiDifficulty(level) {
        const valid = ['easy', 'medium', 'hard'];
        const next = valid.includes(level) ? level : 'medium';
        this._selectedAiDifficulty = next;

        document.querySelectorAll('.ai-diff-btn').forEach(btn => {
            btn.classList.toggle('selected', btn.dataset.diff === next);
        });
    }

    _showAiDifficulty(force) {
        const panel = document.getElementById('ai-diff-block');
        if (!panel) return;

        if (typeof force === 'boolean') {
            panel.classList.toggle('hidden', !force);
            return;
        }

        panel.classList.toggle('hidden');
    }

    _set2v2Difficulty(level) {
        const valid = ['easy', 'medium', 'hard'];
        const next = valid.includes(level) ? level : 'medium';
        this._selectedAiDifficulty = next;

        const panel = document.getElementById('2v2-diff-block');
        if (!panel) return;
        panel.querySelectorAll('.ai-diff-btn').forEach(btn => {
            btn.classList.toggle('selected', btn.dataset.diff === next);
        });
    }

    _show2v2Difficulty(force) {
        const panel = document.getElementById('2v2-diff-block');
        if (!panel) return;

        if (typeof force === 'boolean') {
            panel.classList.toggle('hidden', !force);
            return;
        }

        panel.classList.toggle('hidden');
    }

    // ─────────────────────────────────────────────────────────
    //  Tournament Setup
    // ─────────────────────────────────────────────────────────
    _startTournament() {
        const C = CONFIG;
        const towerCfg = C.TOURNAMENT_TOWER || {};
        const opponentCount = Math.max(1, towerCfg.OPPONENT_COUNT || 4);

        const player = {
            name: 'PLAYER 1', isPlayer: true,
            color: C.P1_COLOR, shadow: C.P1_SHADOW, difficulty: 0,
        };

        const sortedAi = C.TOURNAMENT_AI
            .slice()
            .sort((a, b) => (a.difficulty || 0) - (b.difficulty || 0));

        const normalCount = Math.max(0, opponentCount - 1);
        const opponents = [];

        for (let i = 0; i < normalCount; i++) {
            const src = sortedAi[Math.min(i, Math.max(0, sortedAi.length - 1))] || {
                name: `CPU ${i + 1}`,
                color: '#ffaa00',
                shadow: 'rgba(255,170,0,0.5)',
                difficulty: 0.5,
            };
            opponents.push({
                ...src,
                isPlayer: false,
                stocks: C.DEFAULT_STOCKS,
                maxAirJumps: 1,
                aiLevel: (src.difficulty || 0) >= 0.82 ? 'hard' : ((src.difficulty || 0) <= 0.35 ? 'easy' : 'medium'),
            });
        }

        const strongest = sortedAi.length ? sortedAi[sortedAi.length - 1] : {
            name: 'BOSS',
            color: '#ff3d3d',
            shadow: 'rgba(255,61,61,0.5)',
            difficulty: 0.95,
        };
        const bossCfg = towerCfg.BOSS || {};
        const boss = {
            ...strongest,
            ...bossCfg,
            name: bossCfg.name || `${strongest.name} Ω`,
            isPlayer: false,
            difficulty: Number.isFinite(bossCfg.difficulty) ? bossCfg.difficulty : 1,
            aiLevel: bossCfg.aiLevel || 'hard',
            stocks: Number.isFinite(bossCfg.stocks) ? bossCfg.stocks : (C.DEFAULT_STOCKS + 3),
            maxAirJumps: Number.isFinite(bossCfg.maxAirJumps) ? bossCfg.maxAirJumps : 3,
        };

        opponents.push(boss);

        this._tournament = new Tournament([player, ...opponents], {
            randomMapPool: towerCfg.RANDOM_MAP_POOL,
            finalMapKey: towerCfg.FINAL_MAP_KEY,
        });

        UI.showBracketScreen(
            this._tournament,
            () => this._beginCurrentTournamentMatch(),
            () => { this._tournament = null; UI.showScreen('menu'); }
        );
    }

    _beginCurrentTournamentMatch() {
        if (!this._tournament || this._tournament.isOver()) return;
        const match = this._tournament.currentMatch();
        if (!match) return;

        UI.showScreen('game');
        this.scene.start('GameScene', {
            mode: 'tournament',
            mapKey: match.mapKey || this._selectedMap,
            tournament: this._tournament,
            tournamentMatch: match,
        });
    }

    // ─────────────────────────────────────────────────────────
    //  Online — Room Management
    // ─────────────────────────────────────────────────────────

    _showOnlineMenu() {
        UI.showOnlineError('');
        const form = document.getElementById('online-join-form');
        if (form) form.classList.add('hidden');
        UI.showScreen('online-menu');
    }

    _showJoinForm() {
        const form = document.getElementById('online-join-form');
        if (form) form.classList.toggle('hidden');
        const input = document.getElementById('join-token-input');
        if (input) input.focus();
    }

    async _createRoom() {
        UI.showOnlineError('');
        const btn = document.querySelector('[data-action="online-create"]');
        if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

        try {
            const token = await Net.createRoom();
            this._setupLobbyCallbacks();
            this._openLobby(token, true);
        } catch (err) {
            UI.showOnlineError('Could not create room: ' + (err.message || err));
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🌐 CREATE ROOM'; }
        }
    }

    async _joinRoom(tokenOverride) {
        const raw = tokenOverride ||
            (document.getElementById('join-token-input') || {}).value || '';
        const token = raw.trim().toLowerCase();
        if (!token) {
            UI.showOnlineError('Please enter a room code.');
            return;
        }

        UI.showOnlineError('');
        const btn = document.querySelector('[data-action="online-join-confirm"]');
        if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }

        // Show connecting indicator while we wait
        this._showConnecting(token);

        try {
            await Net.joinRoom(token);
            this._setupLobbyCallbacks();
            this._openLobby(token, false);
        } catch (err) {
            UI.showScreen('online-menu');
            UI.showOnlineError('Could not join room: ' + (err.message || err));
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '→ JOIN'; }
        }
    }

    async _autoJoin(token) {
        // Clear the URL param so refreshing doesn't re-trigger join
        const url = new URL(window.location.href);
        url.searchParams.delete('room');
        window.history.replaceState({}, '', url.toString());

        this._showConnecting(token);

        try {
            await Net.joinRoom(token);
            this._setupLobbyCallbacks();
            this._openLobby(token, false);
        } catch (err) {
            UI.showScreen('online-menu');
            const inp = document.getElementById('join-token-input');
            if (inp) inp.value = token.toUpperCase();
            const form = document.getElementById('online-join-form');
            if (form) form.classList.remove('hidden');
            UI.showOnlineError('Auto-join failed: ' + (err.message || err));
        }
    }

    _showConnecting(token) {
        // Show lobby screen with a spinner while connecting
        UI.showScreen('online-lobby');
        UI.setLobbyToken(token);
        UI.setLobbyStatus('Connecting…');
        const playersEl = document.getElementById('lobby-players');
        if (playersEl) {
            playersEl.innerHTML =
                '<div class="connecting-wrap"><div class="spinner"></div></div>';
        }
        // Hide action buttons during connect
        const startBtn = document.getElementById('btn-lobby-start');
        const readyBtn = document.getElementById('btn-lobby-ready');
        if (startBtn) startBtn.classList.add('hidden');
        if (readyBtn) readyBtn.classList.add('hidden');
    }

    // ─────────────────────────────────────────────────────────
    //  Lobby UI
    // ─────────────────────────────────────────────────────────

    _openLobby(token, isHost) {
        UI.showScreen('online-lobby');
        UI.setLobbyToken(token);

        const modeRow = document.getElementById('lobby-mode-row');
        const mapRow = document.getElementById('lobby-map-row');
        const startBtn = document.getElementById('btn-lobby-start');
        const readyBtn = document.getElementById('btn-lobby-ready');

        if (modeRow) modeRow.classList.toggle('hidden', !isHost);
        if (mapRow) mapRow.classList.toggle('hidden', !isHost);
        if (startBtn) startBtn.classList.toggle('hidden', !isHost);
        if (readyBtn) readyBtn.classList.remove('hidden');

        // Reset ready button state
        if (readyBtn) {
            readyBtn.textContent = '✓ READY';
            readyBtn.classList.remove('is-ready');
        }

        // Host: pre-select the currently stored map (or first available)
        if (isHost) {
            const defaultMap = Net.selectedMap || CONFIG.DEFAULT_MAP ||
                Object.keys(CONFIG.MAPS || {})[0] || 'naruto';
            Net.setMap(defaultMap);
            UI.renderLobbyMap(defaultMap);
        }

        this._refreshLobby(Net.players);
    }

    _setupLobbyCallbacks() {
        Net.onLobbyUpdate = players => this._refreshLobby(players);

        Net.onGameStart = config => {
            this._launchOnlineGameFromConfig(config);
        };

        Net.onHostDisconnect = () => {
            Net.disconnect();
            UI.showScreen('online-menu');
            UI.showOnlineError('Host disconnected.');
        };

        Net.onKicked = () => {
            Net.disconnect();
            UI.showScreen('online-menu');
            UI.showOnlineError('You were kicked from the room.');
        };

        Net.onMapUpdate = mapKey => {
            // Client: update map pill highlight to reflect host's choice
            UI.renderLobbyMap(mapKey);
        };

        Net.onPlayerLeft = p => {
            UI.setLobbyStatus(`${p.name} left the room.`);
        };

        Net.onError = err => {
            if (Net.role === null) return; // already disconnected
            UI.setLobbyStatus('Connection error: ' + (err.message || err));
        };
    }

    _refreshLobby(players) {
        const localId = Net.localPlayer?.id;
        const isHost = Net.role === 'host';

        UI.renderLobbyPlayers(players, localId, isHost,
            newTeam => Net.switchTeam(newTeam),
            playerId => Net.kickPlayer(playerId));

        // Update mode pill selection for clients
        if (!isHost) {
            document.querySelectorAll('.mode-pill').forEach(p =>
                p.classList.toggle('active', p.dataset.mode === Net.gameMode));
            // Update map pill highlight for clients
            if (Net.selectedMap) UI.renderLobbyMap(Net.selectedMap);
        }

        // Start button: enabled when 2+ players and enough are ready
        const startBtn = document.getElementById('btn-lobby-start');
        const notHost = players.filter(p => p.id !== 1);
        const allReady = notHost.length > 0 && notHost.every(p => p.ready);
        const enoughPlayers = players.length >= 2;
        if (startBtn && isHost) {
            startBtn.disabled = !(enoughPlayers && allReady);
        }

        // Status
        const count = players.length;
        const ready = players.filter(p => p.ready).length;
        const sameTeam = count >= 2 && (new Set(players.map(p => p.team)).size === 1);
        if (count < 2) {
            UI.setLobbyStatus('Waiting for players… (need at least 2)');
        } else {
            let status = `${count} player${count > 1 ? 's' : ''} — ${ready} ready`;
            if (sameTeam) {
                status += ' • All players are on one team - game will switch to FREE FOR ALL.';
            }
            if (!allReady) {
                status += isHost
                    ? ' • Need all guests READY before START GAME.'
                    : ' • Waiting for all players to READY.';
            }
            UI.setLobbyStatus(status);
        }
    }

    // ─────────────────────────────────────────────────────────
    //  Lobby Button Handlers
    // ─────────────────────────────────────────────────────────

    _toggleReady() {
        const isReady = !(Net.localPlayer?.ready);
        Net.setReady(isReady);
        const btn = document.getElementById('btn-lobby-ready');
        if (btn) {
            btn.classList.toggle('is-ready', isReady);
            btn.textContent = isReady ? '✓ READY (click to unready)' : '✓ READY';
        }
    }

    _hostStartGame() {
        if (Net.role !== 'host') return;
        const players = Net.players || [];
        const sameTeam = players.length >= 2 && (new Set(players.map(p => p.team)).size === 1);
        const config = Net.startGame({
            mode: sameTeam ? 'ffa' : Net.gameMode,
            mapKey: Net.selectedMap,
            forcedFFA: sameTeam,
            notice: sameTeam ? 'All players chose one team - switching to FREE FOR ALL.' : '',
        });

        // Fallback in case callbacks are not wired for host.
        if (config && !Net.onGameStart) this._launchOnlineGameFromConfig(config);
    }

    _launchOnlineGameFromConfig(config) {
        const finalMode = (config && config.mode) || Net.gameMode || '1v1';
        Net.gameMode = finalMode;
        document.querySelectorAll('.mode-pill').forEach(p =>
            p.classList.toggle('active', p.dataset.mode === finalMode));

        const start = () => {
            UI.showScreen('game');
            this.scene.start('GameScene', {
                mode: finalMode,
                mapKey: config.mapKey || CONFIG.DEFAULT_MAP,
                online: true,
                netConfig: config,
                tournament: null,
                tournamentMatch: null,
            });
        };

        if (config && config.notice) {
            UI.setLobbyStatus(config.notice);
            this.time.delayedCall(900, start);
        } else {
            start();
        }
    }

    _leaveLobby() {
        Net.disconnect();
        // Remove URL param if present
        const url = new URL(window.location.href);
        url.searchParams.delete('room');
        window.history.replaceState({}, '', url.toString());
        UI.showScreen('menu');
    }

    _copyRoomLink() {
        const token = Net.token;
        if (!token) return;
        const link = `${location.origin}${location.pathname}?room=${token}`;
        navigator.clipboard.writeText(link).then(() => {
            const ok = document.getElementById('lobby-copy-ok');
            if (ok) {
                ok.classList.remove('hidden');
                setTimeout(() => ok.classList.add('hidden'), 2000);
            }
        }).catch(() => {
            // Fallback for browsers that block clipboard
            prompt('Copy this link to share:', link);
        });
    }
}

// Expose scene class globally for ESM modules
window.MenuScene = MenuScene;

