// Parser for The Bazaar's Unity Player.log.
//
// The message formats below are the format strings found in the installed game's
// TheBazaarRuntime.dll (build 1.0.13176). The patterns are searched anywhere in the line,
// so timestamps or "[Tag]" prefixes in front of the message do not matter.
//
// What this build does NOT log (removed since 1.0.7097): "Cards Spawned/Dealt/Disposed"
// blocks and "Successfully moved card". So offers, gold and board/stash moves are not here.

const RE = {
  runStart: /Starting new run\.\.\.|NetMessageRunInitialized|Received run initialization data from server/,
  state: /State changed from \[([^\]]*)\] to \[([^\]]*)\]/,
  purchase: /Card Purchased: InstanceId:\s*(\S+)\s*-\s*TemplateId\s*(\S+)\s*-\s*Target:\s*(\S*)\s*-\s*Section\s*(\S*)/,
  sold: /Sold Card\s+(\S+)\s+for\s+(-?\d+)\s+gold/,
  upgraded: /Upgraded Card\s+(\S+)\s+Tier from:\s*(\w+)\s+to:\s*(\w+)/,
  skill: /Selected skill\s+(\S+)\s+to socket\s+(\S+)/,
  received: /Received: type=\s*(\w+)/,
  combatDone: /Combat simulation completed(?:: durationMs=(\d+)| in ([\d.]+)s)/,
  time: /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\]?/,
};

export function parseLine(line) {
  if (!line) return null;
  let m;
  const t = (line.match(RE.time) || [])[1] ?? null;
  if ((m = line.match(RE.purchase))) {
    return { type: 'purchase', instanceId: m[1], templateId: m[2], target: m[3], section: m[4], t };
  }
  if ((m = line.match(RE.state))) return { type: 'state', from: m[1], to: m[2], t };
  if ((m = line.match(RE.sold))) return { type: 'sold', instanceId: m[1], gold: Number(m[2]), t };
  if ((m = line.match(RE.upgraded))) return { type: 'upgraded', instanceId: m[1], from: m[2], to: m[3], t };
  if ((m = line.match(RE.skill))) return { type: 'skillSelected', skill: m[1], socket: m[2], t };
  if (RE.runStart.test(line)) return { type: 'runStart', t };
  if ((m = line.match(RE.combatDone))) {
    return { type: 'combatDone', durationMs: m[1] ? Number(m[1]) : Math.round(Number(m[2]) * 1000), t };
  }
  if ((m = line.match(RE.received))) return { type: 'received', message: m[1], t };
  return null;
}

export function parseLog(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const e = parseLine(line);
    if (e) events.push(e);
  }
  return events;
}
