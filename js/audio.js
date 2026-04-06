'use strict';
/* =========================================================
   AUDIO — Procedural Web Audio API sound effects
   No external files needed; fully synthesized.
   ========================================================= */
const Audio = (() => {
    let ctx = null;

    function init() {
        if (ctx) return;
        try {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn('[Audio] Web Audio API not available.');
        }
    }

    /** Resume context after a user gesture (browser policy). */
    function resume() {
        if (ctx && ctx.state === 'suspended') ctx.resume();
    }

    /** Low-level helper: schedule a one-shot oscillator burst. */
    function burst({ type, freqStart, freqEnd, duration, gain, when = 0 }) {
        if (!ctx) return;
        resume();
        const t = ctx.currentTime + when;
        const osc = ctx.createOscillator();
        const vol = ctx.createGain();
        osc.connect(vol);
        vol.connect(ctx.destination);

        osc.type = type;
        osc.frequency.setValueAtTime(freqStart, t);
        if (freqEnd !== undefined)
            osc.frequency.exponentialRampToValueAtTime(freqEnd, t + duration);

        vol.gain.setValueAtTime(gain, t);
        vol.gain.exponentialRampToValueAtTime(0.001, t + duration);

        osc.start(t);
        osc.stop(t + duration + 0.01);
    }

    /** Thin noise burst helper (simulates impact thud). */
    function noiseBurst(gainVal, dur, when = 0) {
        if (!ctx) return;
        resume();
        const t = ctx.currentTime + when;
        const bufLen = Math.ceil(ctx.sampleRate * dur);
        const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufLen; i++) data[i] = (Math.random() * 2 - 1);

        const src = ctx.createBufferSource();
        const vol = ctx.createGain();
        const filt = ctx.createBiquadFilter();

        src.buffer = buffer;
        filt.type = 'bandpass';
        filt.frequency.setValueAtTime(280, t);
        filt.Q.setValueAtTime(0.8, t);

        src.connect(filt);
        filt.connect(vol);
        vol.connect(ctx.destination);

        vol.gain.setValueAtTime(gainVal, t);
        vol.gain.exponentialRampToValueAtTime(0.001, t + dur);

        src.start(t);
        src.stop(t + dur + 0.01);
    }

    // ---- Public sound effects --------------------------------

    function playPunch() {
        noiseBurst(0.55, 0.07);
        burst({ type: 'sawtooth', freqStart: 200, freqEnd: 70, duration: 0.09, gain: 0.25 });
    }

    function playKick() {
        noiseBurst(0.7, 0.10);
        burst({ type: 'triangle', freqStart: 130, freqEnd: 40, duration: 0.13, gain: 0.40 });
    }

    function playHurt() {
        burst({ type: 'square', freqStart: 320, freqEnd: 95, duration: 0.14, gain: 0.20 });
    }

    function playJump() {
        burst({ type: 'sine', freqStart: 190, freqEnd: 370, duration: 0.11, gain: 0.13 });
    }

    function playKO() {
        // Three descending thumps
        [0, 0.10, 0.22].forEach((delay, i) => {
            noiseBurst(0.6, 0.12, delay);
            burst({ type: 'sawtooth', freqStart: 220 - i * 35, freqEnd: 45, duration: 0.18, gain: 0.35, when: delay });
        });
    }

    function playRoundStart() {
        burst({ type: 'sine', freqStart: 440, freqEnd: 660, duration: 0.15, gain: 0.2 });
        burst({ type: 'sine', freqStart: 660, duration: 0.25, gain: 0.25, when: 0.16 });
    }

    return { init, resume, playPunch, playKick, playHurt, playJump, playKO, playRoundStart };
})();
