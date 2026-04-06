'use strict';
/* =========================================================
   TOURNAMENT — Single-elimination bracket for 4-8 players
   ========================================================= */

class Tournament {
    /**
     * @param {Array<{name:string, color:string, shadow:string, isPlayer:boolean, difficulty:number}>} entrants
     *   entrants.length must be 4 or 8
     */
    constructor(entrants) {
        // Pad to next power of 2 if needed
        this.entrants = entrants.slice();
        this.size     = this._nextPow2(this.entrants.length);

        // Fill byes
        while (this.entrants.length < this.size) {
            this.entrants.push({ name: 'BYE', isBye: true, color: '#555', shadow: '' });
        }

        this.rounds  = [];   // rounds[r][m] = { p1Idx, p2Idx, winner:null }
        this.current = 0;    // current round index (0-based)
        this.matchIdx= 0;    // match index within current round

        this._buildBracket();
    }

    _nextPow2(n) {
        let p = 1;
        while (p < n) p <<= 1;
        return p;
    }

    _buildBracket() {
        // First round: pair sequential entrants
        const firstRound = [];
        for (let i = 0; i < this.size; i += 2) {
            firstRound.push({ p1: i, p2: i + 1, winner: null });
        }
        this.rounds.push(firstRound);

        // Build subsequent rounds as placeholders
        let prev = firstRound;
        while (prev.length > 1) {
            const next = [];
            for (let i = 0; i < prev.length; i += 2) {
                next.push({ p1: null, p2: null, winner: null });
            }
            this.rounds.push(next);
            prev = next;
        }
    }

    /** Return the current match, or null if tournament is over */
    currentMatch() {
        if (this.current >= this.rounds.length) return null;
        const round = this.rounds[this.current];
        if (this.matchIdx >= round.length) return null;
        const m = round[this.matchIdx];
        // Skip BYE matches
        const p1 = this.entrants[m.p1];
        const p2 = this.entrants[m.p2];
        return { p1, p2, matchObj: m };
    }

    /** Record the winner of the current match (0=p1 wins, 1=p2 wins) */
    recordWinner(side) {
        if (this.current >= this.rounds.length) return;
        const round = this.rounds[this.current];
        const m     = round[this.matchIdx];
        const winner= side === 0 ? m.p1 : m.p2;
        m.winner    = winner;

        // Advance
        this.matchIdx++;
        if (this.matchIdx >= round.length) {
            // Move to next round, fill in participants
            this.current++;
            this.matchIdx = 0;
            if (this.current < this.rounds.length) {
                const winners = round.map(mm => mm.winner);
                const nextRound = this.rounds[this.current];
                for (let i = 0; i < nextRound.length; i++) {
                    nextRound[i].p1 = winners[i * 2];
                    nextRound[i].p2 = winners[i * 2 + 1];
                }
                // Auto-skip BYE matches
                this._skipByes();
            }
        }
        // Skip current BYE match in same round
        else {
            this._skipByes();
        }
    }

    _skipByes() {
        while (this.current < this.rounds.length) {
            const round = this.rounds[this.current];
            if (this.matchIdx >= round.length) { this.current++; this.matchIdx=0; continue; }
            const m  = round[this.matchIdx];
            const p1 = this.entrants[m.p1];
            const p2 = this.entrants[m.p2];
            if (p1.isBye || p2.isBye) {
                // Auto-advance the non-bye
                const winner = p1.isBye ? m.p2 : m.p1;
                m.winner = winner;
                this.matchIdx++;
            } else { break; }
        }
    }

    isOver() { return this.current >= this.rounds.length; }

    champion() {
        if (!this.isOver()) return null;
        const lastRound = this.rounds[this.rounds.length - 1];
        return this.entrants[lastRound[0].winner];
    }

    /**
     * Render the bracket as an HTML string (for injection into DOM).
     * Highlights current match.
     */
    renderHTML() {
        let html = '<div class="bracket-tree">';
        for (let r = 0; r < this.rounds.length; r++) {
            html += `<div class="bracket-col">`;
            const label = r === this.rounds.length - 1 ? 'FINAL'
                        : r === this.rounds.length - 2 ? 'SEMI-FINAL'
                        : `ROUND ${r + 1}`;
            html += `<div class="bracket-round-label">${label}</div>`;
            for (let m = 0; m < this.rounds[r].length; m++) {
                const match = this.rounds[r][m];
                const isCurrent = (r === this.current && m === this.matchIdx);
                const cls = isCurrent ? ' active' : '';
                html += `<div class="bracket-match${cls}">`;

                const p1 = match.p1 !== null ? this.entrants[match.p1] : null;
                const p2 = match.p2 !== null ? this.entrants[match.p2] : null;
                const w  = match.winner !== null ? match.winner : -1;

                html += this._slotHTML(p1, match.p1 === w, p1 && p1.color);
                html += '<div class="bracket-vs">vs</div>';
                html += this._slotHTML(p2, match.p2 === w, p2 && p2.color);

                html += '</div>';
            }
            html += '</div>';
        }
        html += '</div>';
        return html;
    }

    _slotHTML(player, isWinner, color) {
        if (!player) return `<div class="bracket-slot empty">TBD</div>`;
        const style = color ? `style="color:${color};border-color:${color}40"` : '';
        const winCls= isWinner ? ' winner' : '';
        const name  = player.name || '???';
        return `<div class="bracket-slot${winCls}" ${style}>${name}${isWinner ? ' 🏆' : ''}</div>`;
    }

    /** How many rounds total */
    get totalRounds() { return this.rounds.length; }
    get roundLabel() {
        if (this.current >= this.rounds.length) return 'COMPLETE';
        return this.current === this.rounds.length - 1 ? 'GRAND FINAL'
             : this.current === this.rounds.length - 2 ? 'SEMI-FINAL'
             : `ROUND ${this.current + 1}`;
    }
}
