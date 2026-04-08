'use strict';
/* =========================================================
   TOURNAMENT — Tower mode (player climbs sequential floors)
   ========================================================= */

class Tournament {
    /**
     * @param {Array<{name:string, color:string, shadow:string, isPlayer:boolean, difficulty:number}>} entrants
     *   entrants must include exactly one player and 1+ AI opponents.
     * @param {{randomMapPool?: string[], finalMapKey?: string}} options
     */
    constructor(entrants, options = {}) {
        this.entrants = entrants.slice();
        this.player = this.entrants.find(e => e && e.isPlayer) || this.entrants[0] || {
            name: 'PLAYER 1', isPlayer: true, color: '#00e5ff', shadow: 'rgba(0,229,255,0.5)', difficulty: 0,
        };

        const allMaps = Object.keys((window.CONFIG && CONFIG.MAPS) || {});
        this.finalMapKey = options.finalMapKey || allMaps[0] || '';
        const inputPool = Array.isArray(options.randomMapPool) ? options.randomMapPool : [];
        const validPool = inputPool.filter(k => allMaps.includes(k) && k !== this.finalMapKey);
        this.randomMapPool = validPool.length ? validPool : allMaps.filter(k => k !== this.finalMapKey);
        this._lastRandomMap = null;

        const opponents = this.entrants.filter(e => e && !e.isPlayer);
        this.floors = opponents.map((opp, i) => ({
            round: i + 1,
            opponent: opp,
            mapKey: this._pickMapForFloor(i, opponents.length),
            cleared: false,
            failed: false,
        }));

        this.current = 0;      // current floor index
        this._over = this.floors.length === 0;
        this._champion = this._over ? this.player : null;
        this.failedAt = 0;
        this.clearedCount = 0;
    }

    /** Return the current match, or null if tournament is over */
    currentMatch() {
        if (this._over || this.current >= this.floors.length) return null;
        const floor = this.floors[this.current];
        return {
            p1: this.player,
            p2: floor.opponent,
            round: floor.round,
            mapKey: floor.mapKey,
            matchObj: floor,
        };
    }

    /** Record the winner of the current match (0=p1 wins, 1=p2 wins) */
    recordWinner(side) {
        if (this._over || this.current >= this.floors.length) return;

        const floor = this.floors[this.current];
        if (side === 0) {
            floor.cleared = true;
            this.clearedCount++;
            this.current++;
            if (this.current >= this.floors.length) {
                this._over = true;
                this._champion = this.player;
            }
        } else {
            floor.failed = true;
            this.failedAt = floor.round;
            this._over = true;
            this._champion = floor.opponent;
        }
    }

    isOver() { return this._over; }

    champion() {
        if (!this._over) return null;
        return this._champion;
    }

    /**
     * Render the bracket as an HTML string (for injection into DOM).
     * Tower floor cards (easy -> boss).
     */
    renderHTML() {
        let html = '<div class="bracket-tree">';
        html += '<div class="bracket-col">';
        html += '<div class="bracket-round-label">TOWER</div>';

        for (let i = 0; i < this.floors.length; i++) {
            const floor = this.floors[i];
            const isCurrent = !this._over && i === this.current;
            const cls = isCurrent ? ' active' : '';
            const tag = (i === this.floors.length - 1) ? 'BOSS FLOOR' : `FLOOR ${floor.round}`;
            const mark = floor.cleared ? '✔' : (floor.failed ? '✖' : '•');

            html += `<div class="bracket-match${cls}">`;
            html += `<div class="bracket-round-label" style="font-size:0.68rem;margin-bottom:8px;">${tag} ${mark}</div>`;
            if (floor.mapKey) {
                html += `<div class="bracket-round-label" style="font-size:0.62rem;margin-bottom:8px;opacity:0.8;">MAP: ${floor.mapKey.toUpperCase()}</div>`;
            }
            html += this._slotHTML(this.player, floor.cleared && !floor.failed, this.player && this.player.color);
            html += '<div class="bracket-vs">vs</div>';
            html += this._slotHTML(floor.opponent, floor.failed, floor.opponent && floor.opponent.color);
            html += '</div>';
        }

        html += '</div>'; // bracket-col
        return html;
    }

    _slotHTML(player, isWinner, color) {
        if (!player) return `<div class="bracket-slot empty">TBD</div>`;
        const style = color ? `style="color:${color};border-color:${color}40"` : '';
        const winCls = isWinner ? ' winner' : '';
        const name = player.name || '???';
        return `<div class="bracket-slot${winCls}" ${style}>${name}${isWinner ? ' 🏆' : ''}</div>`;
    }

    /** How many floors total */
    get totalRounds() { return this.floors.length; }
    get roundLabel() {
        if (this._over) return this._champion && this._champion.isPlayer ? 'TOWER CLEARED' : 'TOWER FAILED';
        if (this.current >= this.floors.length) return 'COMPLETE';
        return this.current === this.floors.length - 1
            ? `BOSS FLOOR (${this.current + 1}/${this.floors.length})`
            : `FLOOR ${this.current + 1}/${this.floors.length}`;
    }

    _pickMapForFloor(index, total) {
        if (index >= total - 1) return this.finalMapKey;
        if (!this.randomMapPool.length) return this.finalMapKey;

        if (this.randomMapPool.length === 1) {
            this._lastRandomMap = this.randomMapPool[0];
            return this._lastRandomMap;
        }

        const options = this.randomMapPool.filter(k => k !== this._lastRandomMap);
        const pool = options.length ? options : this.randomMapPool;
        const next = pool[Math.floor(Math.random() * pool.length)];
        this._lastRandomMap = next;
        return next;
    }
}

window.Tournament = Tournament;
