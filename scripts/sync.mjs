// Run at every start: if the installed game version differs from the imported data, re-import.
// Card art is re-extracted only when the vision environment exists. Local files only.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildData, dataTag, findGameApp, loadData } from './import-data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = findGameApp();
if (!app) {
  console.log('Oyun kurulumu bulunamadı; eldeki veriyle devam.');
  process.exit(0);
}
const installed = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')]).toString().trim();
const src = loadData()?.source;
const have = src?.gameVersion ?? null;
const tag = dataTag();
if (have === installed && (src?.dataTag ?? null) === tag) {
  console.log(`Veri güncel (${installed.split('-')[0]}).`);
} else {
  console.log(have === installed ? 'Oyun verisi güncellenmiş; eşya verisi yenileniyor...' : `Oyun sürümü değişti (${have ?? 'yok'} → ${installed}); eşya verisi yenileniyor...`);
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data', 'cards.json'), JSON.stringify(buildData(app)));
  const py = join(ROOT, 'vision', '.venv', 'bin', 'python');
  if (existsSync(py) && have !== null) {
    if (have !== installed) {
      console.log('Eşya görselleri yenileniyor (birkaç dakika)...');
      execFileSync(py, [join(ROOT, 'vision', 'extract_art.py'), app], { stdio: 'inherit' });
    }
    execFileSync(py, [join(ROOT, 'vision', 'matcher.py'), '--rebuild'], { stdio: 'inherit' });
  }
}
