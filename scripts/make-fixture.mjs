// Writes test/fixtures/run-constructed.log.
// NOT a recording: no real Player.log existed on this machine when the parser was written.
// Every message uses the exact format string found in the game's TheBazaarRuntime.dll (1.0.13176)
// and real template ids from the game data; the line prefix and the surrounding noise are guesses.
// Replace with an excerpt of a real log as soon as one exists (see README).
import { readFileSync, writeFileSync } from 'node:fs';
const { cards } = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url)));
const all = Object.values(cards);
const by = (pred) => all.find(pred);
const item = (name) => by((c) => c.type === 'Item' && c.name === name).id;
const start = by((c) => /Vanessa's Quarters \(Start Run\)/.test(c.internalName)).id;
const pol = by((c) => c.type === 'EventEncounter' && c.internalName === 'Pol').id;
const fight = by((c) => c.type === 'CombatEncounter' && c.name === 'Training Dummy').id;
const skill = by((c) => c.type === 'Skill' && c.heroes.includes('Vanessa')).id;
let sec = 0;
const out = [];
const L = (msg, tag = 'Info') => out.push(`[${new Date(Date.UTC(2026, 10, 22, 18, 0, sec++)).toISOString()}] [${tag}] ${msg}`);
const state = (a, b) => L(`State changed from [${a}] to [${b}]`);
const buy = (iid, tid, target, section) => L(`Card Purchased: InstanceId: ${iid} - TemplateId${tid} - Target:${target} - Section${section}`);
out.push('Mono path[0] = \'/Applications/TheBazaar.app/Contents/Resources/Data/Managed\'');
out.push('Initialize engine version: 6000.3.27f2 (22188f149405)');
L('Starting new run...');
L('Received: type=NetMessageRunInitialized, id=1');
L('Received run initialization data from server. Loading board...');
state('StartRunAppState', 'ChoiceState');
buy('enc_aaa1', start, 'None', 'None');
state('ChoiceState', 'EncounterState');
buy('itm_n4rwh4l', item('Narwhal'), 'PlayerSocket_0', 'Hand');
L('Received: type=NetMessageGameSim, id=7');
state('EncounterState', 'ChoiceState');
buy('enc_aaa2', pol, 'None', 'None');
state('ChoiceState', 'EncounterState');
buy('itm_gr4pe', item('Grapeshot'), 'PlayerSocket_1', 'Hand');
buy('itm_4nch0r', item('Anchor'), 'PlayerStorageSocket_0', 'Storage');
L('Sold Card itm_gr4pe for 1 gold.');
L('[SFXPlayer] Event not found for GUID: 00000000.', 'Warning');
state('EncounterState', 'ChoiceState');
buy('enc_aaa3', fight, 'None', 'None');
state('ChoiceState', 'CombatState');
L('Combat prepared: frames=412, effectsMs=3');
L('Combat simulation completed: durationMs=6870');
state('CombatState', 'ReplayState');
state('ReplayState', 'LevelUpState');
L(`Selected skill ${skill} to socket 0`);
L('Upgraded Card itm_n4rwh4l Tier from: Bronze to: Silver');
state('LevelUpState', 'ChoiceState');
state('ChoiceState', 'PVPCombatState');
L('Combat simulation completed: durationMs=14210');
state('PVPCombatState', 'ReplayState');
state('ReplayState', 'ChoiceState');
writeFileSync(new URL('../test/fixtures/run-constructed.log', import.meta.url), out.join('\n') + '\n');
console.log(out.length, 'lines');
