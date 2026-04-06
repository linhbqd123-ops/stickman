'use strict';
/* =========================================================
   UI — DOM updates, screen transitions, overlays
   Keeps all DOM manipulation out of game.js.
   ========================================================= */

const UI = (() => {

    // ---- Element cache ----
    const $ = id => document.getElementById(id);

    const screens = {
        menu: $('screen-menu'),
        game: $('screen-game'),
    };

    const el = {
        p1HpBar: $('p1-hp-bar'),
        p2HpBar: $('p2-hp-bar'),
        p1HpText: $('p1-hp-text'),
        p2HpText: $('p2-hp-text'),
        p1Name: $('p1-name'),
        p2Name: $('p2-name'),
        p1Pips: $('p1-pips'),
        p2Pips: $('p2-pips'),
        roundLabel: $('round-label'),
        timerDisplay: $('timer-display'),
        modeTag: $('mode-tag'),

        overlayResult: $('overlay-result'),
        resultTitle: $('result-title'),
        resultSubtitle: $('result-subtitle'),
        btnContinue: $('btn-continue'),
        btnToMenu: $('btn-to-menu'),

        overlayTournamentWin: $('overlay-tournament-win'),
        tournamentWinMsg: $('tournament-win-msg'),
        btnTrophyMenu: $('btn-trophy-menu'),

        overlayFightStart: $('overlay-fight-start'),
        fightStartText: $('fight-start-text'),

        canvasWrap: $('canvas-wrap'),
    };

    // ---- Screen helpers ----
    function showScreen(name) {
        Object.values(screens).forEach(s => s.classList.remove('active'));
        if (screens[name]) screens[name].classList.add('active');
    }

    // ---- HUD ----
    function setNames(p1, p2) {
        el.p1Name.textContent = p1;
        el.p2Name.textContent = p2;
    }

    function setModeTag(text) {
        el.modeTag.textContent = text;
    }

    function updateHP(p1Hp, p1Max, p2Hp, p2Max) {
        const p1Pct = Math.max(0, (p1Hp / p1Max) * 100);
        const p2Pct = Math.max(0, (p2Hp / p2Max) * 100);

        el.p1HpBar.style.width = p1Pct + '%';
        el.p2HpBar.style.width = p2Pct + '%';
        el.p1HpText.textContent = Math.ceil(p1Hp);
        el.p2HpText.textContent = Math.ceil(p2Hp);

        // Low-HP warning colour
        el.p1HpBar.classList.toggle('low', p1Pct < 25);
        el.p2HpBar.classList.toggle('low', p2Pct < 25);
    }

    function updateTimer(seconds) {
        el.timerDisplay.textContent = Math.ceil(seconds);
        el.timerDisplay.classList.toggle('low', seconds <= 10);
    }

    function setRoundLabel(text) {
        el.roundLabel.textContent = text;
    }

    /** Update win-pip dots below each health bar.
     *  @param {number} p1Wins  wins accumulated by P1
     *  @param {number} p2Wins
     *  @param {number} needed  rounds needed to win the match
     */
    function updateWinPips(p1Wins, p2Wins, needed) {
        const makePips = (wins, container) => {
            container.innerHTML = '';
            for (let i = 0; i < needed; i++) {
                const div = document.createElement('div');
                div.className = 'win-pip' + (i < wins ? '' : ' empty');
                if (i >= wins) div.style.opacity = '0.2';
                container.appendChild(div);
            }
        };
        makePips(p1Wins, el.p1Pips);
        makePips(p2Wins, el.p2Pips);
    }

    // ---- Round result overlay ----
    function showRoundResult(title, subtitle, onContinue, onMenu) {
        el.resultTitle.textContent = title;
        el.resultSubtitle.textContent = subtitle;
        el.overlayResult.classList.remove('hidden');

        // Re-bind buttons (clone to clear old listeners)
        const cont = el.btnContinue.cloneNode(true);
        const menu = el.btnToMenu.cloneNode(true);
        el.btnContinue.replaceWith(cont);
        el.btnToMenu.replaceWith(menu);
        el.btnContinue = cont;  // update cache
        el.btnToMenu = menu;

        // Re-query since we cloned
        $('btn-continue').addEventListener('click', () => {
            hideRoundResult();
            onContinue && onContinue();
        }, { once: true });

        $('btn-to-menu').addEventListener('click', () => {
            hideRoundResult();
            onMenu && onMenu();
        }, { once: true });
    }

    function hideRoundResult() {
        $('overlay-result').classList.add('hidden');
    }

    // ---- Tournament win overlay ----
    function showTournamentWin(msg, onMenu) {
        el.tournamentWinMsg.textContent = msg;
        el.overlayTournamentWin.classList.remove('hidden');
        $('btn-trophy-menu').onclick = () => {
            el.overlayTournamentWin.classList.add('hidden');
            onMenu && onMenu();
        };
    }

    // ---- Fight-start flash ----
    /**
     * Flash a large text (e.g. "ROUND 1" or "FIGHT!") that auto-disappears.
     * @param {string}   text
     * @param {number}   duration  ms  (should match CSS animation length)
     * @param {Function} onDone
     */
    function flashFightStart(text, duration = 900, onDone) {
        el.fightStartText.textContent = text;
        el.overlayFightStart.classList.remove('hidden');

        // Re-trigger CSS animation by removing and re-adding the element
        const span = el.fightStartText;
        span.style.animation = 'none';
        void span.offsetWidth; // reflow
        span.style.animation = '';

        setTimeout(() => {
            el.overlayFightStart.classList.add('hidden');
            onDone && onDone();
        }, duration);
    }

    // ---- Menu button wiring ----
    /**
     * @param {Function} callback  called with mode string:
     *   'twoPlayer' | 'singlePlayer' | 'training' | 'tournament'
     */
    function onMenuSelect(callback) {
        document.querySelectorAll('.menu-btn[data-mode]').forEach(btn => {
            btn.addEventListener('click', () => {
                Audio.resume();
                callback(btn.dataset.mode);
            });
        });
    }

    // ---- Canvas sizing ----
    /**
     * Fit canvas to available space while maintaining aspect ratio.
     * Returns the CSS scale factor applied.
     */
    function fitCanvas(canvas) {
        const C = CONFIG;
        const wrap = el.canvasWrap;
        const ww = wrap.clientWidth;
        const wh = wrap.clientHeight;
        const scaleX = ww / C.WIDTH;
        const scaleY = wh / C.HEIGHT;
        const scale = Math.min(scaleX, scaleY);

        canvas.width = C.WIDTH;
        canvas.height = C.HEIGHT;
        canvas.style.width = (C.WIDTH * scale) + 'px';
        canvas.style.height = (C.HEIGHT * scale) + 'px';

        return scale;
    }

    return {
        showScreen,
        setNames,
        setModeTag,
        updateHP,
        updateTimer,
        setRoundLabel,
        updateWinPips,
        showRoundResult,
        hideRoundResult,
        showTournamentWin,
        flashFightStart,
        onMenuSelect,
        fitCanvas,
        el,   // expose for any fine-grained access in game.js
    };
})();
