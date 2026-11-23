// Games whose first start has to be done at the PC, with the reason: on that
// start something shows only on the PC's own screen, so a headset that starts
// the game from its library (the Steam Frame) would show nothing useful.
// Kept here by game id for now; a mod.json `firstStartOnPc` (a later
// dvr-package field) takes precedence once there is one.
'use strict';

const FIRST_START_ON_PC = {
  'tpm-vr': "Denuvo's activation pop-up and a page with a code appear on the PC's screen, and the first start shows a blank window for a few minutes.",
  'cataclismo-vr': 'The first start shows a blank window on the PC for a few minutes while the mod gets the game ready.',
};

// The reason, or null for a game whose first start needs nothing at the PC.
const firstStartOnPc = (id, mod) => (typeof mod?.firstStartOnPc === 'string' && mod.firstStartOnPc.trim()) || FIRST_START_ON_PC[id] || null;

module.exports = { FIRST_START_ON_PC, firstStartOnPc };
