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
    }

    create() {
        // Wire multi-use "data-action" buttons (re-wire to avoid duplicate listeners).
        // Clone trick: replace node with its clone to strip old listeners.
        this._rewireMenuButtons();

        // Wire one-time bracket buttons
        this._rewireBtn('btn-bracket-start',  () => this._beginCurrentTournamentMatch());
        this._rewireBtn('btn-bracket-menu',   () => {
            this._tournament = null;
            UI.showScreen('menu');
        });

        // Wire pause overlay buttons (to be used by GameScene via events).
        // MenuScene registers them once; GameScene emits events.
        this._rewireBtn('btn-resume',     () => this.game.events.emit('game:resume'));
        this._rewireBtn('btn-exit-match', () => this.game.events.emit('game:exit'));

        // Tournament win overlay
        this._rewireBtn('btn-trophy-menu', () => {
            document.getElementById('overlay-tournament-win').classList.add('hidden');
            this._tournament = null;
            UI.showScreen('menu');
        });

        if (this._showBracket && this._tournament) {
            UI.showBracketScreen(
                this._tournament,
                () => this._beginCurrentTournamentMatch(),
                () => { this._tournament = null; UI.showScreen('menu'); }
            );
        } else {
            UI.showScreen('menu');
        }
    }

    // ---- Button Utilities ----
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

    // ---- Menu Action Handler ----
    _handleMenuAction(action) {
        switch (action) {
            case 'play-menu':       UI.showScreen('mode-select');         break;
            case 'back-menu':       UI.showScreen('menu');                 break;
            case '1v1-pvp':         this._launchGame('1v1');               break;
            case '1v1-ai':          this._launchGame('1vAI');              break;
            case '2v2':             this._launchGame('2v2');               break;
            case 'tournament':      UI.showScreen('tournament-setup');     break;
            case 'start-tournament':this._startTournament();              break;
            default: break;
        }
    }

    // ---- Game Launch ----
    _launchGame(mode) {
        UI.showScreen('game');
        // Stop MenuScene, start GameScene.
        this.scene.start('GameScene', {
            mode,
            tournament: this._tournament,
            tournamentMatch: null,
        });
    }

    // ---- Tournament Setup ----
    _startTournament() {
        const opts  = UI.getTournamentOptions();
        const C     = CONFIG;

        const entrants = [{
            name: 'PLAYER 1', isPlayer: true,
            color: C.P1_COLOR, shadow: C.P1_SHADOW, difficulty: 0,
        }];
        const aiPool = C.TOURNAMENT_AI.slice();
        for (let i = aiPool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [aiPool[i], aiPool[j]] = [aiPool[j], aiPool[i]];
        }
        for (let i = 1; i < opts.size; i++) {
            entrants.push({ ...aiPool[i - 1], isPlayer: false });
        }
        this._tournament = new Tournament(entrants);

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
            mode:            'tournament',
            tournament:      this._tournament,
            tournamentMatch: match,
        });
    }
}
