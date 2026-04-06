'use strict';
/* =========================================================
   GAME.JS — Main loop, mode management, world rendering
   Depends on: config, audio, particles, stickman,
               fighter, bot, ui  (loaded in that order)
   ========================================================= */

// ---- MODES ----
const MODE = Object.freeze({
    TWO_PLAYER: 'twoPlayer',
    SINGLE: 'singlePlayer',
    TRAINING: 'training',
    TOURNAMENT: 'tournament',
});

// =========================================================
//  WORLD RENDERER — background, ground, stage decorations
// =========================================================
const World = (() => {
    // Pre-build a gradient once; re-use each frame.
    let bgGrad = null;
    let lastW = 0;
    let lastH = 0;

    function _buildGrad(ctx, w, h) {
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, '#0d0d1a');
        g.addColorStop(0.6, '#111128');
        g.addColorStop(1, '#1a0a2e');
        bgGrad = g;
        lastW = w; lastH = h;
    }

    function draw(ctx, W, H) {
        const C = CONFIG;

        if (W !== lastW || H !== lastH) _buildGrad(ctx, W, H);

        // Sky
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, W, H);

        // Distant city silhouette
        ctx.save();
        ctx.fillStyle = 'rgba(20,20,50,0.7)';
        _drawCity(ctx, W, H);
        ctx.restore();

        // Ground platform
        const gy = C.GROUND_Y;
        // Platform surface glow
        const grd = ctx.createLinearGradient(0, gy - 2, 0, gy + 22);
        grd.addColorStop(0, 'rgba(80,200,255,0.28)');
        grd.addColorStop(0.4, 'rgba(40,100,200,0.12)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grd;
        ctx.fillRect(0, gy - 2, W, 24);

        // Ground line
        ctx.strokeStyle = 'rgba(0,229,255,0.55)';
        ctx.lineWidth = 2;
        ctx.shadowColor = 'rgba(0,229,255,0.6)';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(W, gy);
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Floor fill beneath
        ctx.fillStyle = 'rgba(8,8,20,0.85)';
        ctx.fillRect(0, gy, W, H - gy);

        // Grid lines on floor
        ctx.strokeStyle = 'rgba(0,229,255,0.07)';
        ctx.lineWidth = 1;
        const vp = { ox: W / 2, oy: gy + 1 };
        const depth = H - gy;
        for (let i = 0; i <= 8; i++) {
            const tx = (i / 8) * W;
            ctx.beginPath();
            ctx.moveTo(vp.ox, vp.oy);
            ctx.lineTo(tx, H);
            ctx.stroke();
        }
        for (let j = 1; j <= 4; j++) {
            const ty = gy + (j / 4) * depth;
            ctx.beginPath();
            ctx.moveTo(0, ty);
            ctx.lineTo(W, ty);
            ctx.stroke();
        }

        // Wall barriers (visual)
        ctx.strokeStyle = 'rgba(0,229,255,0.18)';
        ctx.lineWidth = 1.5;
        [C.WALL_LEFT, C.WALL_RIGHT].forEach(wx => {
            ctx.beginPath();
            ctx.moveTo(wx, gy - 160);
            ctx.lineTo(wx, gy);
            ctx.stroke();
        });
    }

    function _drawCity(ctx, W, H) {
        const gy = CONFIG.GROUND_Y;
        const buildings = [
            { x: 20, w: 60, h: 200 }, { x: 90, w: 40, h: 160 },
            { x: 140, w: 80, h: 250 }, { x: 230, w: 55, h: 190 },
            { x: 290, w: 35, h: 130 }, { x: 340, w: 70, h: 220 },
            { x: 430, w: 50, h: 170 }, { x: 490, w: 90, h: 260 },
            { x: 600, w: 45, h: 150 }, { x: 660, w: 65, h: 210 },
            { x: 740, w: 50, h: 180 }, { x: 800, w: 80, h: 230 },
            { x: 890, w: 55, h: 160 }, { x: 950, w: 40, h: 140 },
        ];
        buildings.forEach(b => {
            ctx.fillRect(b.x, gy - b.h, b.w, b.h);
        });
    }

    return { draw };
})();

// =========================================================
//  GAME — top-level state machine
// =========================================================
const Game = (() => {

    // ---- Canvas ----
    const canvas = document.getElementById('game-canvas');
    const ctx = canvas.getContext('2d');

    // ---- Sub-systems ----
    const particles = new ParticleSystem();
    const input = new InputManager();

    // ---- State ----
    let mode = null;
    let p1 = null;   // Fighter
    let p2 = null;   // Fighter
    let bot = null;   // Bot | null

    let roundTimer = 0;      // seconds remaining
    let p1Wins = 0;
    let p2Wins = 0;
    let roundNum = 1;
    let matchOver = false;
    let roundPaused = false;  // while showing overlay / flash
    let rafId = null;
    let lastTime = 0;

    // Tournament specific
    let tournamentIdx = 0;     // which opponent we're on

    // Training: dummy doesn't die
    let trainingMode = false;

    // =========================================================
    //  PUBLIC — Start a mode
    // =========================================================
    function startMode(selectedMode) {
        mode = selectedMode;
        UI.showScreen('game');
        Audio.init();
        UI.fitCanvas(canvas);
        particles.clear();
        input.flush();

        p1Wins = 0;
        p2Wins = 0;
        roundNum = 1;
        matchOver = false;

        if (mode === MODE.TOURNAMENT) {
            tournamentIdx = 0;
            _setupTournamentRound();
        } else {
            _setupMatch();
        }
    }

    // =========================================================
    //  Setup helpers
    // =========================================================
    function _setupMatch() {
        trainingMode = (mode === MODE.TRAINING);
        const C = CONFIG;
        const needed = C.ROUNDS_TO_WIN;

        // Build fighters
        p1 = new Fighter({
            id: 1, x: 260,
            color: C.P1_COLOR, shadow: C.P1_SHADOW,
            facingRight: true, isPlayer: true,
        });

        const p2IsBot = (mode === MODE.SINGLE || mode === MODE.TRAINING);
        p2 = new Fighter({
            id: 2, x: 700,
            color: C.P2_COLOR, shadow: C.P2_SHADOW,
            facingRight: false, isPlayer: !p2IsBot,
        });

        if (p2IsBot) {
            const diff = mode === MODE.TRAINING ? 0 : 0.45;
            bot = new Bot(p2, diff);
        } else {
            bot = null;
        }

        // HUD
        const p2Label = p2IsBot
            ? (mode === MODE.TRAINING ? 'DUMMY' : 'CPU')
            : 'PLAYER 2';
        UI.setNames('PLAYER 1', p2Label);
        UI.setModeTag(_modeLabel(mode));
        UI.updateWinPips(0, 0, needed);
        _startRound();
    }

    function _setupTournamentRound() {
        const C = CONFIG;
        const opp = C.TOURNAMENT_OPPONENTS[tournamentIdx];

        p1Wins = 0;
        p2Wins = 0;

        p1 = new Fighter({
            id: 1, x: 260,
            color: C.P1_COLOR, shadow: C.P1_SHADOW,
            facingRight: true, isPlayer: true,
        });
        p2 = new Fighter({
            id: 2, x: 700,
            color: C.P2_COLOR, shadow: C.P2_SHADOW,
            facingRight: false, isPlayer: false,
        });

        bot = new Bot(p2, opp.difficulty);

        UI.setNames('PLAYER 1', opp.name);
        UI.setModeTag(`TOURNAMENT — FIGHT ${tournamentIdx + 1}/${C.TOURNAMENT_OPPONENTS.length}`);
        UI.updateWinPips(0, 0, C.ROUNDS_TO_WIN);
        _startRound();
    }

    function _startRound() {
        const C = CONFIG;
        roundTimer = C.ROUND_TIME;
        roundPaused = true;
        matchOver = false;

        // Reset positions
        p1.reset(260, true);
        p2.reset(700, false);
        particles.clear();
        input.flush();

        UI.setRoundLabel('ROUND ' + roundNum);
        UI.updateHP(p1.hp, p1.maxHp, p2.hp, p2.maxHp);
        UI.updateTimer(roundTimer);
        UI.updateWinPips(p1Wins, p2Wins, C.ROUNDS_TO_WIN);

        // Flash start announcement then unpause
        const flashText = roundNum === 1 ? 'FIGHT!' : `ROUND ${roundNum}`;
        UI.flashFightStart(flashText, 900, () => {
            roundPaused = false;
            Audio.playRoundStart();
        });

        // Start loop if not running
        if (!rafId) _loop(performance.now());
    }

    // =========================================================
    //  Game loop
    // =========================================================
    function _loop(ts) {
        rafId = requestAnimationFrame(_loop);

        const dt = Math.min(ts - lastTime, 50); // cap at 50ms to avoid spiral
        lastTime = ts;

        if (!roundPaused) {
            _update(dt);
        }
        _render();
    }

    function _update(dt) {
        const C = CONFIG;

        // Feed input
        p1.setInput(input.getP1());
        if (bot) {
            bot.update(dt, p1);
        } else {
            p2.setInput(input.getP2());
        }

        // Update fighters
        p1.update(dt, p2, particles);
        p2.update(dt, p1, particles);

        // Particles
        particles.update();

        // Timer (only active fighters)
        if (!matchOver) {
            if (!trainingMode) roundTimer -= dt / 1000;

            // HUD
            UI.updateHP(p1.hp, p1.maxHp, p2.hp, p2.maxHp);
            UI.updateTimer(roundTimer);
        }

        // ---- Check round-end conditions ----
        if (!matchOver) {
            const p1Dead = p1.state === 'dead';
            const p2Dead = p2.state === 'dead';
            const timeout = roundTimer <= 0;

            if (p1Dead || p2Dead || timeout) {
                _endRound(p1Dead, p2Dead, timeout);
            }
        }
    }

    // =========================================================
    //  Round / match management
    // =========================================================
    function _endRound(p1Dead, p2Dead, timeout) {
        matchOver = true;
        roundPaused = true;

        const C = CONFIG;

        // Determine round winner (training: never lose)
        let p1WonRound, p2WonRound;
        if (timeout) {
            if (p1.hp > p2.hp) { p1WonRound = true; }
            else if (p2.hp > p1.hp) { p2WonRound = true; }
            else { p1WonRound = true; } // draw → P1 wins (favour player)
        } else {
            p2WonRound = p1Dead && !p2Dead;
            p1WonRound = p2Dead && !p1Dead;
            if (p1Dead && p2Dead) p1WonRound = true; // simultaneous → P1
        }

        if (!trainingMode) {
            if (p1WonRound) p1Wins++;
            else p2Wins++;
        }

        UI.updateWinPips(p1Wins, p2Wins, C.ROUNDS_TO_WIN);

        // Build overlay text
        const title = timeout ? 'TIME!' : 'KO!';
        const winName = p1WonRound ? 'Player 1' : _getP2Name();
        const subtitle = `${winName} wins the round!`;

        // Check match winner
        const p1MatchWin = p1Wins >= C.ROUNDS_TO_WIN;
        const p2MatchWin = p2Wins >= C.ROUNDS_TO_WIN;
        const matchDone = p1MatchWin || p2MatchWin || trainingMode;

        if (matchDone && mode === MODE.TOURNAMENT && p1MatchWin) {
            // Advance tournament
            UI.showRoundResult(title, subtitle, () => {
                tournamentIdx++;
                if (tournamentIdx >= C.TOURNAMENT_OPPONENTS.length) {
                    _showTournamentVictory();
                } else {
                    _setupTournamentRound();
                }
            }, _goToMenu);
        } else if (matchDone) {
            const matchTitle = trainingMode ? 'NICE!' : (p1MatchWin ? 'VICTORY!' : 'DEFEAT!');
            const matchSub = trainingMode
                ? 'Keep training!'
                : (p1MatchWin
                    ? 'You win the match!'
                    : `${_getP2Name()} wins the match!`);
            UI.showRoundResult(matchTitle, matchSub,
                () => { _resetMatch(); },
                _goToMenu
            );
        } else {
            // More rounds to play
            roundNum++;
            UI.showRoundResult(title, subtitle, () => {
                matchOver = false;
                _startRound();
            }, _goToMenu);
        }
    }

    function _resetMatch() {
        roundNum = 1;
        p1Wins = 0;
        p2Wins = 0;
        matchOver = false;
        if (mode === MODE.TOURNAMENT) {
            tournamentIdx = 0;
            _setupTournamentRound();
        } else {
            _setupMatch();
        }
    }

    function _showTournamentVictory() {
        cancelAnimationFrame(rafId);
        rafId = null;
        UI.showTournamentWin(
            'You defeated all opponents — you are the champion!',
            _goToMenu
        );
    }

    function _goToMenu() {
        cancelAnimationFrame(rafId);
        rafId = null;
        input.flush();
        UI.showScreen('menu');
    }

    function _getP2Name() {
        if (mode === MODE.TWO_PLAYER) return 'Player 2';
        if (mode === MODE.TRAINING) return 'Dummy';
        if (mode === MODE.TOURNAMENT) return CONFIG.TOURNAMENT_OPPONENTS[tournamentIdx]?.name || 'CPU';
        return 'CPU';
    }

    function _modeLabel(m) {
        const map = {
            [MODE.TWO_PLAYER]: '2P',
            [MODE.SINGLE]: 'VS CPU',
            [MODE.TRAINING]: 'TRAINING',
            [MODE.TOURNAMENT]: 'TOURNAMENT',
        };
        return map[m] || '';
    }

    // =========================================================
    //  RENDER
    // =========================================================
    function _render() {
        const C = CONFIG;
        const W = C.WIDTH;
        const H = C.HEIGHT;

        ctx.clearRect(0, 0, W, H);

        // Background + stage
        World.draw(ctx, W, H);

        // Fighters
        if (p1) p1.draw(ctx);
        if (p2) p2.draw(ctx);

        // Particles on top
        particles.draw(ctx);

        // Debug: hit-range indicator when attacking (dev only — off in prod)
        // _drawHitboxes(ctx);
    }

    // =========================================================
    //  INIT
    // =========================================================
    function init() {
        Audio.init();
        UI.fitCanvas(canvas);

        // Resize handling
        window.addEventListener('resize', () => UI.fitCanvas(canvas));

        // Menu buttons
        UI.onMenuSelect(selectedMode => startMode(selectedMode));

        // Show menu
        UI.showScreen('menu');
    }

    return { init, startMode };
})();

// ---- Boot ----
window.addEventListener('DOMContentLoaded', () => Game.init());
