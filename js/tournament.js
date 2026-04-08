'use strict';
/* =========================================================
   TOURNAMENT — Tower mode (player climbs sequential floors)
   ========================================================= */

const RANKS = [
    { name: 'ROOKIE', color: '#aaaaaa' },
    { name: 'BRONZE', color: '#cd7f32' },
    { name: 'SILVER', color: '#c0c0c0' },
    { name: 'GOLD', color: '#ffd700' },
    { name: 'PLATINUM', color: '#e5e4e2' },
    { name: 'DIAMOND', color: '#b9f2ff' },
    { name: 'MASTER', color: '#ff00ff' },
    { name: 'GRANDMASTER', color: '#ff4500' },
    { name: 'CHAMPION', color: '#00ffff' }
];

const MEDALS = [
    { name: 'Wooden Medal', desc: 'Better luck next time!', color: '#8b4513' },
    { name: 'Iron Medal', desc: 'A solid start.', color: '#a9a9a9' },
    { name: 'Bronze Medal', desc: 'Showing potential.', color: '#cd7f32' },
    { name: 'Silver Medal', desc: 'The climb continues.', color: '#c0c0c0' },
    { name: 'Gold Medal', desc: 'Expert skill shown.', color: '#ffd700' },
    { name: 'Platinum Medal', desc: 'Elite status reached.', color: '#e5e4e2' },
    { name: 'Diamond Shield', desc: 'Legendary performance!', color: '#b9f2ff' }
];

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
        this.rankIndex = 0;
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
            // Tier up rank based on progress
            this.rankIndex = Math.min(this.current, RANKS.length - 1);
            
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

    getCurrentRank() {
        return RANKS[this.rankIndex] || RANKS[0];
    }

    getReward() {
        if (!this._over) return null;
        if (this._champion && this._champion.isPlayer) {
            return {
                type: 'CUP',
                name: 'GRAND CHAMPION CUP',
                desc: 'You have conquered the Ultimate Tower!',
                color: '#00ffff'
            };
        }
        // Failure reward (medal)
        const idx = Math.min(this.clearedCount, MEDALS.length - 1);
        return {
            type: 'MEDAL',
            ...MEDALS[idx]
        };
    }

    isOver() { return this._over; }

    champion() {
        if (!this._over) return null;
        return this._champion;
    }

    /**
     * Render the bracket as an HTML string (for injection into DOM).
     * Tower floor cards (easy -> boss) with grid layout.
     */
    renderHTML() {
        const currentRank = this.getCurrentRank();
        let html = `<div class="rank-badge-wrap">
            <div class="rank-label">CURRENT RANK</div>
            <div class="rank-name" style="color:${currentRank.color}">${currentRank.name}</div>
        </div>`;
        
        html += '<div class="bracket-tree">';

        for (let i = 0; i < this.floors.length; i++) {
            const floor = this.floors[i];
            const isCurrent = !this._over && i === this.current;
            const isBoss = (i === this.floors.length - 1);
            const cls = (isCurrent ? ' active' : '') + (isBoss ? ' boss-floor' : '');
            const tag = isBoss ? 'FINAL BOSS' : `FLOOR ${floor.round}`;
            const mark = floor.cleared ? '✔' : (floor.failed ? '✖' : '•');

            html += `<div class="bracket-col${isBoss ? ' boss-col' : ''}">`;
            html += `<div class="bracket-round-label">${tag} ${mark}</div>`;
            if (floor.mapKey) {
                html += `<div class="bracket-round-label map-tag">🗺 ${floor.mapKey.toUpperCase()}</div>`;
            }
            html += `<div class="bracket-match${cls}">`;
            html += this._slotHTML(this.player, floor.cleared && !floor.failed, this.player && this.player.color, false);
            html += '<div class="bracket-vs">VS</div>';
            html += this._slotHTML(floor.opponent, floor.failed, floor.opponent && floor.opponent.color, isBoss);
            html += '</div>'; // bracket-match
            html += '</div>'; // bracket-col
        }

        html += '</div>'; // bracket-tree
        return html;
    }

    _slotHTML(player, isWinner, color, isBoss) {
        if (!player) return `<div class="bracket-slot empty">TBD</div>`;
        const style = color ? `style="color:${color};border-color:${color}60"` : '';
        const winCls = (isWinner ? ' winner' : '') + (isBoss ? ' boss-slot' : '');
        const name = player.name || '???';
        return `<div class="bracket-slot${winCls}" ${style}>
            <span class="slot-name">${name}</span>
            ${isWinner ? '<span class="slot-crown">🏆</span>' : ''}
        </div>`;
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
