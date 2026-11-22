// Replays a log file line by line into another file, to exercise the live view without the game.
// usage: node scripts/replay.mjs <source.log> <target.log> [msPerLine=400]
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [src, dst, ms = '400'] = process.argv.slice(2);
if (!src || !dst) { console.error('usage: node scripts/replay.mjs <source.log> <target.log> [msPerLine]'); process.exit(1); }
const lines = readFileSync(src, 'utf8').split('\n');
writeFileSync(dst, '');
for (const line of lines) {
  appendFileSync(dst, line + '\n');
  await new Promise((r) => setTimeout(r, Number(ms)));
}
console.log('replayed', lines.length, 'lines');
