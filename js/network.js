'use strict';
/* =========================================================
   NETWORK — MultiplayerManager
   WebRTC peer-to-peer via PeerJS.

   Topology: Star (host-centric)
     • Host's PeerJS Peer ID  =  room token  (allows direct join via URL)
     • Up to 4 players total  (1 host + 3 clients)
     • Host is game-state authority; broadcasts state every frame
     • Clients send their key-input to host each frame

   Quick usage:
     const net = window.Net;
     // ── host ──
     const token = await net.createRoom();
     net.onLobbyUpdate = players => redrawLobby(players);
     // ── client ──
     await net.joinRoom(token);
   ========================================================= */

class MultiplayerManager {

    constructor() { this._reset(); }

    /* ── State reset ─────────────────────────────────────── */

    _reset() {
        if (this.peer) { try { this.peer.destroy(); } catch (_) { } }

        this.peer = null;
        this.connections = [];        // DataConnection[]; host = all clients, client = [host]
        this.role = null;      // 'host' | 'client' | null
        this.token = null;      // room token (== host peer ID)
        this.localPlayer = null;      // { id, name, team, ready, isLocal:true }
        this.players = [];        // all players (serialisable snapshot, no conn refs)
        this.gameMode = '1v1';     // current selected mode (host sets)

        // ── Callbacks set by consumer ──
        this.onLobbyUpdate = null;  // (players[]) => void
        this.onGameStart = null;  // (config)    => void
        this.onInputReceived = null;  // (playerId, input) => void   — host only
        this.onStateReceived = null;  // (state)     => void         — clients only
        this.onPlayerLeft = null;  // (player)    => void
        this.onError = null;  // (err)       => void
        this.onHostDisconnect = null;  // ()          => void         — client only
    }

    /* ─────────────────────────────────────────────────────
       PUBLIC API — Room lifecycle
    ───────────────────────────────────────────────────── */

    /**
     * Create a new room (become host).
     * Generates a PeerJS Peer whose ID equals the room token.
     * @returns {Promise<string>} the room token
     */
    createRoom() {
        return new Promise((resolve, reject) => {
            const token = MultiplayerManager._genToken();
            this.token = token;
            this.role = 'host';

            this.peer = new Peer(token, MultiplayerManager._peerCfg());

            this.peer.on('open', () => {
                this.localPlayer = {
                    id: 1, name: 'PLAYER 1', team: 0, ready: false, isLocal: true,
                };
                this.players = [this._stripLocal(this.localPlayer)];
                resolve(token);
            });

            this.peer.on('connection', conn => this._acceptIncoming(conn));

            this.peer.on('error', err => {
                this._emitError(err);
                reject(err);
            });
        });
    }

    /**
     * Join an existing room (become client).
     * @param {string} token  The room token shown in the invite link.
     * @returns {Promise<string>} resolves with token on connection open
     */
    joinRoom(token) {
        return new Promise((resolve, reject) => {
            this.token = token;
            this.role = 'client';

            this.peer = new Peer(MultiplayerManager._peerCfg());

            const onSetupError = err => { this._emitError(err); reject(err); };
            this.peer.on('error', onSetupError);

            this.peer.on('open', () => {
                // Switch to regular error handler after open
                this.peer.off('error', onSetupError);
                this.peer.on('error', err => this._emitError(err));

                const conn = this.peer.connect(token, { reliable: true, serialization: 'json' });
                this._wireConn(conn);

                const timer = setTimeout(() => {
                    reject(new Error('Connection timed out — room may not exist'));
                }, 12000);

                conn.on('open', () => {
                    clearTimeout(timer);
                    conn.send({ type: 'hello' });
                    resolve(token);
                });

                conn.on('error', err => {
                    clearTimeout(timer);
                    reject(err);
                });
            });
        });
    }

    /** Cleanly disconnect and reset all state. */
    disconnect() { this._reset(); }

    /* ─────────────────────────────────────────────────────
       PUBLIC API — Lobby controls
    ───────────────────────────────────────────────────── */

    /** Switch self to a different team (0 = team 1, 1 = team 2). */
    switchTeam(team) {
        if (team !== 0 && team !== 1) return;
        if (this.role === 'host') {
            if (this.localPlayer) this.localPlayer.team = team;
            this._flushLocalToPlayers();
            this._broadcastLobby();
            this._fireLobbyUpdate();
        } else {
            this._sendToHost({ type: 'team-switch', team });
        }
    }

    /** Toggle self-ready state. */
    setReady(ready) {
        if (this.role === 'host') {
            if (this.localPlayer) this.localPlayer.ready = !!ready;
            this._flushLocalToPlayers();
            this._broadcastLobby();
            this._fireLobbyUpdate();
        } else {
            this._sendToHost({ type: 'set-ready', ready: !!ready });
        }
    }

    /** Change own display name (max 16 chars). */
    setName(raw) {
        const name = String(raw).slice(0, 16).replace(/[<>&"']/g, '');
        if (this.localPlayer) this.localPlayer.name = name;
        if (this.role === 'host') {
            this._flushLocalToPlayers();
            this._broadcastLobby();
            this._fireLobbyUpdate();
        } else {
            this._sendToHost({ type: 'set-name', name });
        }
    }

    /** Set game mode ('1v1' | '2v2') — host only. */
    setMode(mode) {
        if (this.role !== 'host') return;
        this.gameMode = mode;
        this._broadcast({ type: 'mode-update', mode });
    }

    /** Start the game — host only. Fires onGameStart on all peers. */
    startGame() {
        if (this.role !== 'host') return;
        const config = {
            mode: this.gameMode,
            players: this._serialisePlayers(),
        };
        this._broadcast({ type: 'game-start', config });
        if (this.onGameStart) this.onGameStart(config);
    }

    /* ─────────────────────────────────────────────────────
       PUBLIC API — In-game data
    ───────────────────────────────────────────────────── */

    /**
     * Host → broadcast authoritative fighter snapshot each frame.
     * Keeps payload lean: only variable fighter fields.
     * @param {Object[]} fighterSnapshots
     */
    broadcastState(fighterSnapshots) {
        if (this.role !== 'host' || !this.connections.length) return;
        this._broadcast({ type: 'state', fighters: fighterSnapshots });
    }

    /**
     * Client → send key-state to host.
     * Called every frame (or on change).
     * @param {{ left,right,up,down,light,heavy,dodge: boolean }} input
     */
    sendInput(input) {
        if (this.role !== 'client') return;
        this._sendToHost({ type: 'input', pid: this.localPlayer?.id, input });
    }

    /* ─────────────────────────────────────────────────────
       INTERNAL — Connection wiring
    ───────────────────────────────────────────────────── */

    _acceptIncoming(conn) {
        if (this.players.length >= 4) {
            // Room full — politely reject
            conn.on('open', () => { conn.send({ type: 'room-full' }); conn.close(); });
            return;
        }
        this._wireConn(conn);
    }

    _wireConn(conn) {
        this.connections.push(conn);
        conn.on('data', msg => this._handleMsg(conn, msg));
        conn.on('close', () => this._handleClose(conn));
        conn.on('error', err => this._emitError(err));
    }

    /* ─────────────────────────────────────────────────────
       INTERNAL — Message dispatch
    ───────────────────────────────────────────────────── */

    _handleMsg(conn, msg) {
        if (!msg || typeof msg !== 'object') return;

        switch (msg.type) {

            /* ────────────────────────────────── HOST receives */

            case 'hello': {
                if (this.role !== 'host') break;
                const nextId = this._nextId();
                const player = {
                    id: nextId,
                    name: 'PLAYER ' + nextId,
                    team: (nextId - 1) % 2,  // alternate teams: 0,1,0,1
                    ready: false,
                };
                conn._mpId = nextId;
                this.players.push(player);
                // Tell joiner their slot + current lobby
                conn.send({ type: 'welcome', yourId: nextId, players: this._serialisePlayers(), mode: this.gameMode });
                this._broadcastLobby();
                this._fireLobbyUpdate();
                break;
            }

            case 'team-switch': {
                if (this.role !== 'host') break;
                const p = this._byConn(conn);
                if (p && (msg.team === 0 || msg.team === 1)) {
                    p.team = msg.team;
                    this._broadcastLobby();
                    this._fireLobbyUpdate();
                }
                break;
            }

            case 'set-ready': {
                if (this.role !== 'host') break;
                const p = this._byConn(conn);
                if (p) {
                    p.ready = !!msg.ready;
                    this._broadcastLobby();
                    this._fireLobbyUpdate();
                }
                break;
            }

            case 'set-name': {
                if (this.role !== 'host') break;
                const p = this._byConn(conn);
                const safe = String(msg.name || '').slice(0, 16).replace(/[<>&"']/g, '');
                if (p && safe) {
                    p.name = safe;
                    this._broadcastLobby();
                    this._fireLobbyUpdate();
                }
                break;
            }

            case 'input': {
                if (this.role !== 'host') break;
                if (this.onInputReceived) this.onInputReceived(msg.pid, msg.input);
                break;
            }

            /* ────────────────────────────────── CLIENT receives */

            case 'welcome': {
                if (this.role !== 'client') break;
                this.players = msg.players || [];
                this.gameMode = msg.mode || '1v1';
                this.localPlayer = {
                    ...((this.players.find(p => p.id === msg.yourId)) || { id: msg.yourId }),
                    isLocal: true,
                };
                this._fireLobbyUpdate();
                break;
            }

            case 'lobby-update': {
                if (this.role !== 'client') break;
                this.players = msg.players || [];
                if (this.localPlayer) {
                    const updated = this.players.find(p => p.id === this.localPlayer.id);
                    if (updated) this.localPlayer = { ...updated, isLocal: true };
                }
                this._fireLobbyUpdate();
                break;
            }

            case 'mode-update': {
                if (this.role !== 'client') break;
                this.gameMode = msg.mode;
                this._fireLobbyUpdate();
                break;
            }

            case 'game-start': {
                if (this.role !== 'client') break;
                if (this.onGameStart) this.onGameStart(msg.config);
                break;
            }

            case 'state': {
                if (this.role !== 'client') break;
                if (this.onStateReceived) this.onStateReceived(msg.fighters);
                break;
            }

            /* ────────────────────────────────── SHARED */

            case 'room-full': {
                this._emitError(new Error('Room is full (max 4 players)'));
                break;
            }
        }
    }

    _handleClose(conn) {
        const idx = this.connections.indexOf(conn);
        if (idx !== -1) this.connections.splice(idx, 1);

        if (this.role === 'host') {
            const pi = this.players.findIndex(p => p.id === conn._mpId);
            if (pi !== -1) {
                const [departed] = this.players.splice(pi, 1);
                this._broadcastLobby();
                if (this.onPlayerLeft) this.onPlayerLeft(departed);
                this._fireLobbyUpdate();
            }
        } else {
            if (this.onHostDisconnect) this.onHostDisconnect();
        }
    }

    /* ─────────────────────────────────────────────────────
       INTERNAL — Helpers
    ───────────────────────────────────────────────────── */

    _broadcast(msg) {
        for (const c of this.connections) {
            if (c.open) c.send(msg);
        }
    }

    _sendToHost(msg) {
        const c = this.connections[0];
        if (c?.open) c.send(msg);
    }

    _broadcastLobby() {
        this._broadcast({ type: 'lobby-update', players: this._serialisePlayers() });
    }

    _fireLobbyUpdate() {
        if (this.onLobbyUpdate) this.onLobbyUpdate([...this.players]);
    }

    _serialisePlayers() {
        return this.players.map(({ id, name, team, ready }) => ({ id, name, team, ready }));
    }

    _flushLocalToPlayers() {
        if (!this.localPlayer) return;
        const i = this.players.findIndex(p => p.id === this.localPlayer.id);
        if (i !== -1) this.players[i] = this._stripLocal(this.localPlayer);
    }

    _stripLocal(p) {
        const { isLocal, ...rest } = p; // eslint-disable-line no-unused-vars
        return rest;
    }

    _byConn(conn) {
        return this.players.find(p => p.id === conn._mpId) || null;
    }

    _nextId() {
        return this.players.reduce((m, p) => Math.max(m, p.id), 0) + 1;
    }

    _emitError(err) {
        console.error('[Net]', err);
        if (this.onError) this.onError(err);
    }

    /* ─────────────────────────────────────────────────────
       STATIC helpers
    ───────────────────────────────────────────────────── */

    /**
     * Generate a room token. Format: "sf" + 8 lowercase alphanumeric chars.
     * Matches SAFE_TOKEN_RE in api/signal.js.
     */
    static _genToken() {
        const ch = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let t = 'sf';
        for (let i = 0; i < 8; i++) t += ch[Math.floor(Math.random() * ch.length)];
        return t;
    }

    /**
     * PeerJS constructor options.
     * Uses public PeerJS cloud + Google STUN servers.
     * NOTE: For production, self-host a PeerJS server or use a paid TURN service.
     */
    static _peerCfg() {
        return {
            debug: 0,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' },
                ],
            },
        };
    }
}

/* Singleton — accessible globally as window.Net */
window.Net = new MultiplayerManager();
