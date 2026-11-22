// Local companion server: tails Player.log, runs the screen reader, serves the live view.
// Listens on 127.0.0.1 only. Makes no outbound connection.
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine } from './logparser.mjs';
import { createScene } from './scene.mjs';
import { createTracker } from './runstate.mjs';
import { buildView } from './view.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 4747);
const LOG_PATH = process.env.BAZAAR_LOG ?? join(homedir(), 'Library/Logs/Tempo Storm/The Bazaar/Player.log');
const args = process.argv.slice(2);
const SCREEN = !args.includes('--no-screen');
const RECORD = args.includes('--record');

const dataPath = join(ROOT, 'data', 'cards.json');
if (!existsSync(dataPath)) {
  console.error('data/cards.json yok. Önce: npm run setup');
  process.exit(1);
}
const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const artMapPath = join(ROOT, 'data', 'art', 'card_art.json');
data.art = existsSync(artMapPath) ? JSON.parse(readFileSync(artMapPath, 'utf8')) : {}; // card id -> local art file
const tracker = createTracker(data);
const scene = createScene(data);

const status = {
  log: { path: LOG_PATH, exists: false, size: 0, lines: 0, events: 0, lastChange: null },
  screen: { enabled: SCREEN, state: SCREEN ? 'başlıyor' : 'kapalı', game: null, ms: null, lastFrame: null, emptyFrames: 0 },
  data: data.source,
};
let screen = null;
let manualGold = null;
let lastGold = null; // last values read from the screen; kept while a frame fails to read
let lastIncome = null;
let lastHealth = null;
let lastLevel = null;
let pendingFight = null;
// Owned skills as read from the icons beside the hero (the log only gives a skill's instance id, not which skill).
// A skill counts once it was seen in three reads; skills are kept for the run.
const skillSeen = new Map();
let ownedSkills = [];
const pending = {};
let boardSig = null; // own board row as read from the screen; adopted once two frames in a row agree
let screenBoard = null;
let logActivityAt = 0; // when the log last showed an action; a board that changes with no action in the log is a misread
let boardAcceptedAt = 0;
let boardRejected = 0;
let stashSig = null; // the stash as last seen open (upper row while no shop is up)
let screenStash = null;
let watcher = null; // the screen reader process; paused during fights so the game keeps the CPU
const clients = new Set();
let dirty = true;

// ---- log tailing: poll size, read only the new bytes, survive truncation (new game session) ----
const HISTORY = join(ROOT, 'data', 'history.jsonl');
let live = false;
let offset = 0;
let carry = '';
function pollLog() {
  let st;
  try {
    st = statSync(LOG_PATH);
  } catch {
    status.log.exists = false;
    return;
  }
  status.log.exists = true;
  if (st.size < offset) {
    offset = 0;
    carry = '';
    tracker.reset();
    dirty = true;
  }
  if (st.size === offset) return;
  const fd = openSync(LOG_PATH, 'r');
  try {
    const buf = Buffer.alloc(st.size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    offset = st.size;
    const lines = (carry + buf.toString('utf8')).split(/\r?\n/);
    carry = lines.pop() ?? '';
    for (const line of lines) {
      // Anything the player did that can change the board or stash leaves one of these lines.
      if (/Command completed: type=|Card Purchased|Sold Card|State changed|GameSim cards/.test(line)) logActivityAt = Date.now();
      scene.onLine(line);
      status.log.lines += 1;
      const e = parseLine(line);
      if (e) {
        status.log.events += 1;
        tracker.apply(e);
        scene.onEvent(e);
        // Calibration record: what the engine expected of each monster fight, next to how it really went
        // (a win is followed by the loot screen; the real fight length is in the log). One line per fight.
        if (live) {
          try {
            if (e.type === 'state' && e.to === 'CombatState') pendingFight = { at: Date.now(), wantView: true };
            else if (pendingFight?.wantView && e.type === 'purchase' && /^com_/.test(e.instanceId ?? '')) {
              const v = state();
              const mo = v.advice.monsters[0];
              pendingFight = { at: Date.now(), day: v.run.day, monster: mo?.name ?? data.cards[e.templateId]?.name, health: v.health, board: v.board.items.filter((i) => i.where === 'board').map((i) => `${i.name}:${i.tier}`), skills: v.skills, estimate: mo?.fight ?? null };
            } else if (pendingFight && e.type === 'combatDone') pendingFight.realSeconds = Math.round((e.durationMs ?? 0) / 100) / 10;
            else if (pendingFight?.monster && e.type === 'state' && e.from === 'ReplayState') {
              appendFileSync(join(ROOT, 'data', 'fights.jsonl'), JSON.stringify({ ...pendingFight, won: e.to === 'LootState' }) + '\n');
              pendingFight = null;
            }
          } catch { pendingFight = null; }
        }
        // Gold moves the moment the log says so; the screen read confirms or corrects it a moment later.
        if (live && lastGold != null) {
          if (e.type === 'sold' && Number.isFinite(e.gold)) lastGold += e.gold;
          if (e.type === 'purchase' && /^itm_/.test(e.instanceId ?? '') && !(data.cards[tracker.run.current?.templateId]?.shop?.free)) {
            const c = data.cards[e.templateId];
            const price = data.gameMode.buyPrices?.[c?.size]?.[tracker.run.items?.[e.instanceId]?.tier ?? c?.startingTier];
            if (price != null) lastGold = Math.max(0, lastGold - price);
          }
        }
        if (live && e.type !== 'received') appendFileSync(HISTORY, JSON.stringify({ at: Date.now(), ...e }) + '\n'); // local run history
        if (e.type === 'state' || e.type === 'purchase') manualGold = null;
        if (e.type === 'state' && watcher?.stdin?.writable) watcher.stdin.write(/Combat|Replay/.test(e.to ?? '') ? 'pause\n' : 'resume\n');
        if (e.type === 'sold') screenStash = null; // a sale may have come out of the stash; forget it until it is seen again
        if (e.type === 'runStart') { lastLevel = null; skillSeen.clear(); ownedSkills = []; boardAcceptedAt = 0; screenStash = null; stashSig = null; screenBoard = null; boardSig = null; lastGold = null; lastIncome = null; } // typed gold is stale after a move
      }
    }
  } finally {
    closeSync(fd);
  }
  status.log.size = st.size;
  status.log.lastChange = Date.now();
  dirty = true;
}
pollLog(); // catch up on what is already in the log without re-recording it
live = true;
setInterval(pollLog, 300);

// ---- screen reader (optional) ----
function startScreen() {
  const py = join(ROOT, 'vision', '.venv', 'bin', 'python');
  if (!existsSync(py) || !existsSync(join(ROOT, 'data', 'art', 'features.npz'))) {
    status.screen.state = 'kurulmamış (npm run setup:vision)';
    return;
  }
  const child = spawn(py, [join(ROOT, 'vision', 'watch.py'), ...(RECORD ? ['--record'] : []), '--display', process.env.BAZAAR_DISPLAY ?? '1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  watcher = child;
  child.stdin.on('error', () => {});
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) {
      let m;
      try {
        m = JSON.parse(l);
      } catch {
        continue;
      }
      if (m.ready) {
        status.screen.state = 'hazır';
        continue;
      }
      status.screen.game = m.game ?? null;
      status.screen.ms = m.ms ?? null;
      status.screen.lastFrame = Date.now();
      if (m.game === false) status.screen.state = 'oyun açık değil';
      else if (m.front === false) status.screen.state = 'oyun önde değil, bekliyor';
      else if (m.error) status.screen.state = 'ekran yakalanamadı';
      else {
        status.screen.emptyFrames = m.detections.length ? 0 : status.screen.emptyFrames + 1;
        // The game is running, the log says we are in a run, yet nothing is ever recognised:
        // most likely macOS is handing us frames without the game window (no Screen Recording permission).
        status.screen.state = status.screen.emptyFrames > 15 && tracker.run.active ? 'çalışıyor, tanınan eşya yok' : 'çalışıyor';
        screen = m;
        scene.onFrame(m, tracker.run.phase);
        if (Array.isArray(m.ownedSkills) && !m.same && !/Combat|Replay/.test(tracker.run.phase ?? '')) {
          const now = new Set();
          for (const d of m.ownedSkills) {
            const c = (d.cardIds ?? []).map((id) => data.cards[id]).filter(Boolean);
            const pick = c.find((x) => x.heroes?.includes(tracker.run.hero)) ?? c[0];
            if (pick) { now.add(pick.id); const o = skillSeen.get(pick.id) ?? { n: 0, inl: 0 }; skillSeen.set(pick.id, { n: o.n + 1, inl: Math.max(o.inl, d.inliers ?? 0) }); }
          }
          for (const id of [...skillSeen.keys()]) if (!now.has(id) && skillSeen.get(id).n < 3) skillSeen.delete(id); // a one-off misread does not stick
          // The log counts skill picks ("Selected skill ...") without naming them: never claim more skills than it counted.
          ownedSkills = [...skillSeen].filter(([, v]) => v.n >= 3).sort((x, y) => y[1].inl - x[1].inl).slice(0, tracker.run.skills.length).map(([id]) => id);
        }
        const fighting = /Combat|Replay/.test(tracker.run.phase ?? ''); // items flash and vanish in a fight: keep the last board
        let row = fighting ? [] : m.detections.filter((d) => d.kind === 'items' && d.cy >= 0.55 && d.cy < 0.76).sort((a, b) => a.cx - b.cx)
          .map((d) => ({ cardIds: d.cardIds, cx: d.cx, x0: d.box?.[0] ?? d.cx - 0.03, x1: d.box?.[2] ?? d.cx + 0.03 }));
        // An item the reader misses (glow, sparkle, cursor) leaves a hole in the row, or pushes the row off centre
        // (the board is centred on screen). Holes are filled with what was there in the last accepted board.
        if (row.length && screenBoard) {
          const holes = [];
          for (let i = 1; i < row.length; i++) if (row[i].x0 - row[i - 1].x1 > 0.045) holes.push([row[i - 1].x1, row[i].x0]);
          const mid = (row[0].x0 + row[row.length - 1].x1) / 2;
          if (mid - 0.5 > 0.025) holes.push([0, row[0].x0]);
          if (0.5 - mid > 0.025) holes.push([row[row.length - 1].x1, 1]);
          const back = screenBoard.filter((p) => holes.some(([h0, h1]) => p.cx > h0 && p.cx < h1) && !row.some((r) => Math.abs(r.cx - p.cx) < 0.02));
          if (back.length) row = [...row, ...back.map((p) => ({ ...p, kept: true }))].sort((a, b) => a.cx - b.cx);
        }
        const sig = row.map((d) => d.cardIds?.[0]).join('|');
        if (sig && sig === boardSig) {
          const slotsOf = (list) => list.reduce((n, d) => n + ({ Small: 1, Medium: 2, Large: 3 }[data.cards[d.cardIds?.[0]]?.size] ?? 1), 0);
          const bag = (list) => { const m = new Map(); for (const d of list) m.set(d.cardIds?.[0], (m.get(d.cardIds?.[0]) ?? 0) + 1); return m; };
          const cur = screenBoard ? screenBoard.map((d) => d.cardIds?.[0]).join('|') : null;
          const curBag = bag(screenBoard ?? []), nextBag = bag(row);
          const fuller = [...curBag].every(([k, n]) => (nextBag.get(k) ?? 0) >= n) && row.length > (screenBoard?.length ?? 0);
          // Cross-check with the log: more than ten slots is impossible; a different board with no logged action
          // since the last accepted one is a misread, unless it only adds items to what was already seen.
          if (slotsOf(row) > 10 || (cur !== null && sig !== cur && !fuller && logActivityAt <= boardAcceptedAt)) { if (sig !== cur) boardRejected++; }
          else { if (sig !== cur) boardAcceptedAt = Date.now(); screenBoard = row; }
          status.screen.boardRejected = boardRejected;
        }
        if (!fighting) boardSig = sig;
        if (tracker.run.phase === 'ChoiceState') {
          const up = m.detections.filter((d) => d.kind === 'items' && d.cy > 0.28 && d.cy < 0.55).sort((a, b) => a.cx - b.cx);
          const ssig = up.map((d) => d.art).join('|');
          if (ssig && ssig === stashSig) screenStash = up.map((d) => ({ cardIds: d.cardIds, cx: d.cx }));
          stashSig = ssig;
        }
        // A counter is believed only when two frames in a row read the same number (animations garble single reads).
        const steady = (key, v) => { const ok = v != null && pending[key] === v; pending[key] = v; return ok; };
        if (steady('gold', m.gold)) lastGold = m.gold;
        if (steady('income', m.income)) lastIncome = m.income;
        if (steady('level', m.level) && (lastLevel == null || m.level >= lastLevel)) lastLevel = m.level; // levels only go up
        if (steady('health', m.health) && !/Combat|Replay/.test(tracker.run.phase ?? '')) lastHealth = m.health; // outside fights the bar shows max health
      }
      dirty = true;
    }
  });
  child.stderr.on('data', () => {});
  child.on('exit', (code) => {
    status.screen.state = `durdu (kod ${code})`;
    dirty = true;
  });
  process.on('exit', () => child.kill());
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}
if (SCREEN) startScreen();

function snapshot() {
  // What the view reads as "the screen": everything remembered for the current scene, plus the parts of the
  // latest frame that are not scene choices (own row, the opponent's portrait).
  const liveDets = screen && Date.now() - screen.ts * 1000 < 6000 ? (screen.detections ?? []).filter((d) => d.cy >= 0.55 || d.cy <= 0.24) : [];
  const merged = { ...(screen ?? {}), ts: Date.now() / 1000, detections: [...scene.detections(), ...liveDets] };
  return { ...buildView(tracker.run, merged, data, { now: Date.now(), gold: manualGold, screenBoard, screenStash, screenGold: lastGold, income: lastIncome, health: lastHealth, hovered: scene.hovered(), facts: scene.facts(), skills: ownedSkills, level: lastLevel }), status, t: Date.now() };
}

setInterval(() => {
  if (!dirty || !clients.size) return;
  dirty = false;
  const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(msg);
}, 250);
setInterval(() => {
  dirty = true; // refresh status ages and drop stale offers even when nothing arrives
}, 2000);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot()));
    return;
  }
  if (url.pathname === '/api/gold' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const g = Number(JSON.parse(body || '{}').gold);
      manualGold = Number.isFinite(g) && body.includes('gold') && JSON.parse(body).gold !== null ? g : null;
      dirty = true;
      res.writeHead(204).end();
    });
    return;
  }
  if (url.pathname === '/api/screen' && req.method === 'POST') {
    // Feed a recognised frame by hand (replaying recorded captures, tests). Same shape as watch.py output.
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        screen = { ...JSON.parse(body), ts: Date.now() / 1000 };
        status.screen.state = 'çalışıyor';
        // A hand-fed frame is taken at its word: it goes into the scene memory and sets the board row and counters.
        scene.onFrame(screen, tracker.run.phase);
        const row = (screen.detections ?? []).filter((d) => d.kind === 'items' && d.cy >= 0.55 && d.cy < 0.76).sort((x, y) => x.cx - y.cx);
        if (row.length) screenBoard = row.map((d) => ({ cardIds: d.cardIds, cx: d.cx }));
        if (screen.gold != null) lastGold = screen.gold;
        if (screen.income != null) lastIncome = screen.income;
        if (screen.health != null) lastHealth = screen.health;
        if (screen.level != null) lastLevel = screen.level;
        dirty = true;
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });
    return;
  }
  const clean = decodeURIComponent(url.pathname).replace(/\.\./g, '');
  const file = clean.startsWith('/art/') ? join(ROOT, 'data', clean) : join(ROOT, 'public', clean === '/' ? 'index.html' : clean);
  if (existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
    return;
  }
  res.writeHead(404).end('not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Bazaar Companion: http://localhost:${PORT}`);
  console.log(`log: ${LOG_PATH}`);
  console.log(`ekran okuma: ${status.screen.state}`);
});
