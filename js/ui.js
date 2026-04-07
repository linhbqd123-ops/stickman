'use strict';
/* =========================================================
   UI — DOM updates, screen transitions, overlays
   Brawlhalla upgrade: stock display, damage%, bracket, 2v2
   ========================================================= */

const UI = (() => {

    const $ = id => document.getElementById(id);

    // ---- Screen map ----
    const SCREENS = ['menu', 'mode-select', 'map-select', 'tournament-setup', 'bracket', 'game',
        'online-menu', 'online-lobby'];

    function showScreen(name) {
        SCREENS.forEach(s => {
            const el = $('screen-' + s);
            if (el) el.classList.toggle('active', s === name);
        });
    }

    // ---- HUD ----
    function setNames(p1, p2, p3, p4) {
        const e1 = $('p1-name'); if (e1) e1.textContent = p1 || '';
        const e2 = $('p2-name'); if (e2) e2.textContent = p2 || '';
        const e3 = $('p3-name'); if (e3) e3.textContent = p3 || '';
        const e4 = $('p4-name'); if (e4) e4.textContent = p4 || '';
    }

    /** Show/hide the compact sub-HUD slots for p3 and p4. */
    function setHudPlayers(n) {
        const p3 = $('hud-p3'); if (p3) p3.classList.toggle('hidden', n < 3);
        const p4 = $('hud-p4'); if (p4) p4.classList.toggle('hidden', n < 4);
    }

    function setModeTag(text) {
        const e = $('mode-tag'); if (e) e.textContent = text;
    }

    function setRoundLabel(text) {
        const e = $('round-label'); if (e) e.textContent = text;
    }

    /** Update damage % display (Brawlhalla-style) */
    function updateDamage(fighters) {
        // fighters = array of Fighter objects
        fighters.forEach((f, i) => {
            const pct = Math.round(f.damage);
            const bar = $(`p${i + 1}-dmg`);
            if (bar) {
                bar.textContent = pct + '%';
                bar.classList.toggle('high', pct >= 80);
                bar.classList.toggle('crit', pct >= 150);
            }
        });
    }

    /** Render stock icons (hearts/skulls) */
    function updateStocks(fighters) {
        fighters.forEach((f, i) => {
            const container = $(`p${i + 1}-stocks`);
            if (!container) return;
            container.innerHTML = '';
            const total = CONFIG.DEFAULT_STOCKS;
            for (let s = 0; s < total; s++) {
                const icon = document.createElement('span');
                icon.className = 'stock-icon' + (s < f.stocks ? '' : ' lost');
                icon.textContent = s < f.stocks ? '◆' : '◇';
                container.appendChild(icon);
            }
        });
    }

    function updateTimer(seconds) {
        const e = $('timer-display');
        if (!e) return;
        e.textContent = Math.max(0, Math.ceil(seconds));
        e.classList.toggle('low', seconds <= 10);
    }

    // ---- Round result overlay ----
    function showRoundResult(title, subtitle, onContinue, onMenu) {
        const ov = $('overlay-result');
        if (!ov) return;
        $('result-title').textContent = title;
        $('result-subtitle').textContent = subtitle;
        ov.classList.remove('hidden');

        const cont = $('btn-continue');
        const menu = $('btn-to-menu');
        const newCont = cont.cloneNode(true);
        const newMenu = menu.cloneNode(true);
        cont.replaceWith(newCont);
        menu.replaceWith(newMenu);

        $('btn-continue').addEventListener('click', () => {
            ov.classList.add('hidden');
            onContinue && onContinue();
        }, { once: true });
        $('btn-to-menu').addEventListener('click', () => {
            ov.classList.add('hidden');
            onMenu && onMenu();
        }, { once: true });
    }

    function hideRoundResult() {
        const ov = $('overlay-result');
        if (ov) ov.classList.add('hidden');
    }

    // ---- Tournament win overlay ----
    function showTournamentWin(msg, onMenu) {
        const ov = $('overlay-tournament-win');
        const msgEl = $('tournament-win-msg');
        if (!ov) return;
        if (msgEl) msgEl.textContent = msg;
        ov.classList.remove('hidden');
        const btn = $('btn-trophy-menu');
        if (btn) btn.onclick = () => { ov.classList.add('hidden'); onMenu && onMenu(); };
    }

    // ---- Fight start flash ----
    function flashFightStart(text, duration = 900, onDone) {
        const ov = $('overlay-fight-start');
        const span = $('fight-start-text');
        if (!ov || !span) { onDone && onDone(); return; }
        span.textContent = text;
        span.style.animation = 'none';
        void span.offsetWidth;
        span.style.animation = '';
        ov.classList.remove('hidden');
        setTimeout(() => { ov.classList.add('hidden'); onDone && onDone(); }, duration);
    }

    // ---- Menu button wiring ----
    function onMenuSelect(callback) {
        document.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', () => {
                Audio.resume && Audio.resume();
                callback(btn.dataset.action, btn.dataset);
            });
        });
    }

    // ---- Tournament bracket render ----
    function renderBracket(tournament) {
        const el = $('bracket-container');
        if (el && tournament) el.innerHTML = tournament.renderHTML();
    }

    function showBracketScreen(tournament, onStart, onMenu) {
        renderBracket(tournament);
        showScreen('bracket');
        const btnStart = $('btn-bracket-start');
        const btnMenu = $('btn-bracket-menu');
        if (btnStart) {
            const nb = btnStart.cloneNode(true);
            btnStart.replaceWith(nb);
            $('btn-bracket-start').addEventListener('click', () => { onStart && onStart(); }, { once: true });
        }
        if (btnMenu) {
            const nb = btnMenu.cloneNode(true);
            btnMenu.replaceWith(nb);
            $('btn-bracket-menu').addEventListener('click', () => { showScreen('menu'); onMenu && onMenu(); }, { once: true });
        }
    }

    // ---- Canvas sizing ----
    function fitCanvas(canvas) {
        const C = CONFIG;
        // Internal drawing buffer — always full resolution
        canvas.width = C.WIDTH;
        canvas.height = C.HEIGHT;

        // CSS display sizing: let CSS handle the scaling
        // We use max-width/max-height with aspect-ratio so the browser
        // scales it correctly regardless of when clientWidth is available.
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.maxWidth = C.WIDTH + 'px';
        canvas.style.maxHeight = C.HEIGHT + 'px';
        canvas.style.objectFit = 'contain';

        return 1;
    }

    // ---- Tournament setup ----
    function getTournamentOptions() {
        const sizeEl = $('tournament-size');
        const size = sizeEl ? parseInt(sizeEl.value) || 4 : 4;
        return { size };
    }

    /** Update energy bar display for both fighters */
    function updateEnergy(fighters) {
        fighters.forEach((f, i) => {
            const fill = $(`p${i + 1}-energy`);
            if (!fill) return;
            const pct = Math.round((f.energy / CONFIG.ENERGY.MAX) * 100);
            fill.style.width = pct + '%';
            fill.classList.toggle('full', f.energy >= CONFIG.ENERGY.MAX);
        });
    }

    // ---- Online lobby helpers ----

    const TEAM_COLORS = ['#00e5ff', '#ff3d3d', '#aaff00', '#ff9900'];
    const TEAM_LABELS = ['TEAM 1', 'TEAM 2'];
    const TEAM_ICONS = ['▲', '▼'];

    /**
     * Render players in #lobby-players.
     * @param {Object[]} players   Serialised player list from Net
     * @param {number}   localId   net.localPlayer.id
     * @param {boolean}  isHost
     * @param {Function} onSwitchTeam  (newTeam) => void  — only for local player
     */
    function renderLobbyPlayers(players, localId, isHost, onSwitchTeam) {
        const container = $('lobby-players');
        if (!container) return;
        container.innerHTML = '';

        for (let slot = 0; slot < 4; slot++) {
            const p = players[slot];
            const card = document.createElement('div');

            if (!p) {
                // Empty slot
                card.className = 'player-card empty-slot';
                card.innerHTML = `<span class="empty-slot-text">Waiting for player ${slot + 1}…</span>`;
                container.appendChild(card);
                continue;
            }

            const isLocal = (p.id === localId);
            card.className = `player-card team-${p.team}${isLocal ? ' local' : ''}`;

            // Avatar
            const avatar = document.createElement('div');
            avatar.className = `player-avatar team-${p.team}`;
            avatar.textContent = TEAM_ICONS[p.team] || '●';

            // Info block
            const info = document.createElement('div');
            info.className = 'player-info';
            const youTag = isLocal ? '<span class="you-tag">(you)</span>' : '';
            const hostTag = (isHost && slot === 0) || (p.id === 1) ? 'host' : 'team-' + p.team;
            info.innerHTML =
                `<div class="player-name">${_escHtml(p.name)}${youTag}</div>` +
                `<div class="player-tag ${hostTag}">${p.id === 1 ? '✪ HOST — ' : ''}${TEAM_LABELS[p.team]}</div>`;

            // Ready dot
            const dot = document.createElement('div');
            dot.className = 'player-ready-dot' + (p.ready ? ' ready' : '');
            dot.title = p.ready ? 'Ready' : 'Not ready';

            card.appendChild(avatar);
            card.appendChild(info);
            card.appendChild(dot);

            // Team-switch button — only shown on local player's card
            if (isLocal) {
                const newTeam = p.team === 0 ? 1 : 0;
                const switchBtn = document.createElement('button');
                switchBtn.className = `team-switch-btn to-team-${newTeam}`;
                switchBtn.textContent = `⇆ ${TEAM_LABELS[newTeam]}`;
                switchBtn.addEventListener('click', () => onSwitchTeam && onSwitchTeam(newTeam));
                card.appendChild(switchBtn);
            }

            container.appendChild(card);
        }
    }

    function setLobbyToken(token) {
        const el = $('lobby-token');
        if (el) el.textContent = token ? token.toUpperCase() : '--------';
    }

    function setLobbyStatus(text) {
        const el = $('lobby-status');
        if (el) el.textContent = text;
    }

    function showOnlineError(msg) {
        const el = $('online-error');
        if (!el) return;
        el.textContent = msg;
        el.classList.toggle('hidden', !msg);
    }

    function _escHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    return {
        showScreen, setNames, setModeTag, setRoundLabel,
        updateDamage, updateStocks, updateEnergy, updateTimer,
        showRoundResult, hideRoundResult,
        showTournamentWin, flashFightStart,
        onMenuSelect, renderBracket, showBracketScreen,
        fitCanvas, getTournamentOptions,
        // online
        renderLobbyPlayers, setLobbyToken, setLobbyStatus, showOnlineError,
        setHudPlayers,
    };
})();

// Expose UI globally for ESM modules
window.UI = UI;
