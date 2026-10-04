const fs = require('node:fs');
const raw = fs.readFileSync('evidence/worker-tail.raw.log', 'utf8');
const events = []; let start = -1, depth = 0, quoted = false, escaped = false;
for (let i = 0; i < raw.length; i++) {
  const c = raw[i];
  if (start < 0) { if (c === '{') { start = i; depth = 1; } continue; }
  if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
  if (c === '"') quoted = true;
  else if (c === '{') depth++;
  else if (c === '}' && --depth === 0) {
    try {
      const e = JSON.parse(raw.slice(start, i + 1));
      const r = e.event?.request;
      if (r) events.push({ timestamp: e.eventTimestamp, version: e.scriptVersion?.id, method: r.method, path: new URL(r.url).pathname, status: e.event.response?.status, browser: /Chrome/.test(r.headers?.['user-agent'] || ''), range: r.headers?.range || null, logs: (e.logs || []).flatMap(l => l.message).filter(m => typeof m === 'string' && /media_delivery|ai_legacy_post_sync/.test(m)).map(m => { try { return JSON.parse(m); } catch { return m; } }) });
    } catch {}
    start = -1;
  }
}
fs.writeFileSync('evidence/worker-tail-redacted.json', JSON.stringify(events, null, 2));
console.log(JSON.stringify(events.filter(e => e.browser).slice(-35), null, 2));
