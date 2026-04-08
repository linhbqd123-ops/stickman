'use strict';
/* =========================================================
   ULTIMATE DEBUG PRESET (OPTIONAL)

   Purpose:
   - Give fighters a chosen ultimate immediately at match start.
   - Set start energy/cooldown for quick testing.

   Disable options:
   1) Set enabled: false (recommended)
   2) Remove/comment import in js/main.js
   3) Keep this file empty

   The game is coded to work even if window.ULTIMATE_DEBUG is missing.
   ========================================================= */

(() => {
    const ULTIMATE_DEBUG = Object.freeze({
        enabled: true,

        // When true, print applied preset details in console.
        logToConsole: true,

        // Apply only to human-controlled fighters.
        onlyPlayers: true,

        // Optional whitelist by fighter id (1..4). Use null to apply all allowed fighters.
        // Example: [1, 2]
        targetIds: null,

        // Global default for fighters affected by the preset.
        // Valid values: default | yasuo | kamehameha | fpt | saitama
        defaultUltimate: 'fpt',

        // 0..100
        energyOnStart: 100,

        // ms
        cooldownOnStart: 0,

        // Per-fighter override (keys are fighter ids).
        // Any field omitted here falls back to the global defaults above.
        perFighter: {
            // 1: { ultimate: 'yasuo',      energy: 100, cooldown: 0 },
            // 2: { ultimate: 'kamehameha', energy: 100, cooldown: 0 },
            // 3: { ultimate: 'fpt',        energy: 100, cooldown: 0 },
            // 4: { ultimate: 'saitama',    energy: 100, cooldown: 0 },
        },
    });

    window.ULTIMATE_DEBUG = ULTIMATE_DEBUG;
})();
