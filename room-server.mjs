#!/usr/bin/env node
/**
 * AGENT ROOM — live shared room over the agent-bus JSONL log.
 *
 *   node room-server.mjs
 *   → http://localhost:7777
 *
 * Chat + board + walk (screencapture → walk/latest.jpg every 2s).
 * Agents: Read walk/latest.jpg or bus read for kind=walk notes.
 */

import { createServer } from 'node:http';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  readdirSync, appendFileSync, copyFileSync, unlinkSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(HERE, 'MESSAGES.jsonl');
const BOARD = join(HERE, 'BOARD.json');
const WALK_DIR = join(HERE, 'walk');
const PORT = Number(process.env.ROOM_PORT || 7777);

mkdirSync(WALK_DIR, { recursive: true });

function readLog(since = 0) {
  if (!existsSync(LOG)) return { lines: [], total: 0 };
  const raw = readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (let i = since; i < raw.length; i++) {
    try { out.push({ n: i + 1, ...JSON.parse(raw[i]) }); } catch { /* skip */ }
  }
  return { lines: out, total: raw.length };
}

function busSend({ from, to, kind = 'note', subject = '', body = '', re }) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const stamp = ts.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const id = `msg-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
  const msg = { id, ts, from, to, kind, subject, body };
  if (re) msg.re = re;
  appendFileSync(LOG, JSON.stringify(msg) + '\n');
  return msg;
}

let walkTimer = null;
let walkFrame = 0;
let walkStartedAt = null;

function captureFrame() {
  const file = join(WALK_DIR, `frame-${String(walkFrame).padStart(5, '0')}.jpg`);
  execFile('screencapture', ['-x', '-t', 'jpg', '-C', file], (err) => {
    if (err) return;
    try { copyFileSync(file, join(WALK_DIR, 'latest.jpg')); } catch { /* ignore */ }
    walkFrame++;
    try {
      const frames = readdirSync(WALK_DIR).filter((f) => f.startsWith('frame-')).sort();
      while (frames.length > 400) {
        const victim = frames.shift();
        if (victim) {
          try { unlinkSync(join(WALK_DIR, victim)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  });
}

function startWalk(intervalSec = 2, note = '') {
  stopWalk(false);
  walkFrame = 0;
  walkStartedAt = new Date().toISOString();
  walkTimer = setInterval(captureFrame, Math.max(1, intervalSec) * 1000);
  captureFrame();
  busSend({
    from: 'adam',
    to: '*',
    kind: 'walk',
    subject: 'WALK STARTED — watch walk/latest.jpg',
    body: `Adam is walking the app live. Frames: ${WALK_DIR}/latest.jpg (every ${intervalSec}s). ${note || 'Follow along; reply on the bus with what you see.'}`,
  });
  return { startedAt: walkStartedAt };
}

function stopWalk(announce = true) {
  if (walkTimer) clearInterval(walkTimer);
  walkTimer = null;
  if (announce && walkStartedAt) {
    busSend({
      from: 'adam',
      to: '*',
      kind: 'walk',
      subject: 'WALK ENDED',
      body: `Walk ended. ${walkFrame} frames in ${WALK_DIR}/. Review + reply with notes.`,
    });
  }
  walkStartedAt = null;
}

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

const UI = `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AGENT ROOM</title>
<style>
  :root { --bg:#0c0c0e; --panel:#141417; --line:#26262b; --txt:#e8e8ea; --dim:#8a8a92;
          --red:#e5484d; --amber:#f5a524; --green:#46a758; --blue:#54aeff; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--txt); font:13px/1.5 "SF Mono",Menlo,monospace; height:100vh; display:flex; flex-direction:column; }
  header { display:flex; align-items:center; gap:12px; padding:10px 16px; border-bottom:1px solid var(--line); }
  header h1 { font-size:14px; letter-spacing:.2em; color:var(--red); }
  header .dot { width:8px; height:8px; border-radius:50%; background:var(--green); }
  main { flex:1; display:grid; grid-template-columns: 1fr 340px; min-height:0; }
  .col { display:flex; flex-direction:column; min-height:0; border-right:1px solid var(--line); }
  .side { display:flex; flex-direction:column; min-height:0; }
  .panel { border-bottom:1px solid var(--line); }
  .panel h2 { font-size:10px; letter-spacing:.25em; color:var(--dim); padding:8px 12px 4px; text-transform:uppercase; }
  #feed { flex:1; overflow-y:auto; padding:8px 12px; display:flex; flex-direction:column; gap:6px; }
  .msg { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:6px 10px; }
  .msg .hd { display:flex; gap:8px; font-size:11px; color:var(--dim); }
  .msg .hd b { color:var(--txt); }
  .msg.kind-task .hd b { color:var(--amber); }
  .msg.kind-walk { border-color:var(--red); }
  .msg.kind-walk .hd b { color:var(--red); }
  .msg .sub { font-weight:700; }
  .msg .bd { color:#c9c9cf; white-space:pre-wrap; word-break:break-word; }
  form#send { display:flex; gap:6px; padding:10px 12px; border-top:1px solid var(--line); }
  select,input,button { background:var(--panel); border:1px solid var(--line); color:var(--txt); border-radius:6px; padding:6px 8px; font:inherit; }
  input#body { flex:1; }
  button { cursor:pointer; }
  button.primary { background:var(--red); border-color:var(--red); color:#fff; font-weight:700; }
  #board { padding:8px 12px; display:flex; flex-direction:column; gap:6px; max-height:32vh; overflow-y:auto; }
  .lane { display:flex; justify-content:space-between; gap:8px; background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:6px 8px; font-size:12px; }
  .lane .who { color:var(--blue); }
  .lane .st-done { color:var(--green); } .lane .st-active { color:var(--amber); }
  #walkImg { width:100%; display:block; border-radius:6px; border:1px solid var(--line); background:#000; min-height:120px; }
  .walkbar { display:flex; gap:6px; padding:8px 12px; align-items:center; flex-wrap:wrap; }
  .walkbar .status { font-size:11px; color:var(--dim); }
  .walkwrap { padding:0 12px 10px; }
</style>
</head>
<body>
<header>
  <span class="dot"></span>
  <h1>AGENT ROOM</h1>
  <span style="color:var(--dim);font-size:11px">cursor · claude-code · droid · adam — one log, live</span>
</header>
<main>
  <div class="col">
    <div id="feed"></div>
    <form id="send">
      <select id="from"><option>adam</option><option>cursor</option><option>claude-code</option><option>droid</option></select>
      <select id="to"><option value="*">all</option><option>cursor</option><option>claude-code</option><option>droid</option><option>adam</option></select>
      <select id="kind"><option>note</option><option>task</option><option>question</option><option>answer</option><option>handoff</option><option>walk</option></select>
      <input id="body" placeholder="message…" autocomplete="off"/>
      <button class="primary">Send</button>
    </form>
  </div>
  <div class="side">
    <div class="panel">
      <h2>Walk — watch Adam live</h2>
      <div class="walkbar">
        <button id="walkStart" class="primary">▶ Start walk</button>
        <button id="walkStop">■ Stop</button>
        <span class="status" id="walkStatus">idle</span>
      </div>
      <div class="walkwrap"><img id="walkImg" alt="(no frames yet)"/></div>
    </div>
    <div class="panel" style="flex:1;display:flex;flex-direction:column;min-height:0">
      <h2>Board — lanes &amp; owners</h2>
      <div id="board"></div>
    </div>
  </div>
</main>
<script>
let since = 0, walkActive = false;
const feed = document.getElementById('feed');
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');}
async function poll() {
  try {
    const r = await fetch('/api/log?since=' + since).then(r=>r.json());
    if (r.lines.length) {
      for (const m of r.lines) {
        const div = document.createElement('div');
        div.className = 'msg kind-' + (m.kind||'note');
        div.innerHTML = '<div class="hd"><b>' + m.from + '</b>→' + (m.to==='*'?'all':m.to) +
          ' · ' + (m.kind||'note') + ' · <span>' + (m.ts||'').slice(11,19) + '</span></div>' +
          (m.subject?'<div class="sub">'+esc(m.subject)+'</div>':'') +
          '<div class="bd">' + esc(m.body||'') + '</div>';
        feed.appendChild(div);
      }
      since = r.total;
      feed.scrollTop = feed.scrollHeight;
    }
  } catch {}
  setTimeout(poll, 1500);
}
document.getElementById('send').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = document.getElementById('body').value.trim();
  if (!body) return;
  await fetch('/api/send', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      from: document.getElementById('from').value,
      to: document.getElementById('to').value,
      kind: document.getElementById('kind').value,
      subject: body.split(/\\s+/).slice(0,6).join(' '),
      body,
    })});
  document.getElementById('body').value = '';
});
async function refreshBoard() {
  try {
    const b = await fetch('/api/board').then(r=>r.json());
    const el = document.getElementById('board');
    el.innerHTML = '';
    for (const l of (b.lanes||[])) {
      const d = document.createElement('div');
      d.className = 'lane';
      d.innerHTML = '<span>' + esc(l.title) + '</span><span><span class="who">' + esc(l.owner||'?') +
        '</span> · <span class="st-' + (l.status||'active') + '">' + esc(l.status||'') + '</span></span>';
      d.title = l.notes || '';
      el.appendChild(d);
    }
  } catch {}
  setTimeout(refreshBoard, 5000);
}
document.getElementById('walkStart').onclick = async () => {
  await fetch('/api/walk/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ interval: 2 }) });
};
document.getElementById('walkStop').onclick = async () => {
  await fetch('/api/walk/stop', { method:'POST' });
};
async function walkTick() {
  try {
    const s = await fetch('/api/walk/status').then(r=>r.json());
    walkActive = s.active;
    document.getElementById('walkStatus').textContent = s.active ? ('LIVE · ' + s.frames + ' frames') : 'idle';
    if (s.active || s.frames > 0) {
      document.getElementById('walkImg').src = '/walk/latest.jpg?t=' + Date.now();
    }
  } catch {}
  setTimeout(walkTick, walkActive ? 2000 : 4000);
}
poll(); refreshBoard(); walkTick();
</script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(UI);
    return;
  }

  if (p === '/api/log') {
    return json(res, 200, readLog(Number(url.searchParams.get('since') || 0)));
  }

  if (p === '/api/send' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.from || !b.to) return json(res, 400, { error: 'from + to required' });
    return json(res, 200, { sent: busSend(b) });
  }

  if (p === '/api/board') {
    if (req.method === 'POST') {
      const b = await readBody(req);
      const board = existsSync(BOARD) ? JSON.parse(readFileSync(BOARD, 'utf8')) : { lanes: [] };
      if (b.lane) {
        const i = board.lanes.findIndex((l) => l.id === b.lane.id);
        if (i >= 0) board.lanes[i] = { ...board.lanes[i], ...b.lane };
        else board.lanes.push(b.lane);
        board.updated_at = new Date().toISOString();
        writeFileSync(BOARD, JSON.stringify(board, null, 2));
        busSend({
          from: b.by || 'adam',
          to: '*',
          kind: 'note',
          subject: `BOARD: ${b.lane.id} → ${b.lane.owner || '?'} (${b.lane.status || '?'})`,
          body: b.lane.notes || 'Board updated.',
        });
      }
      return json(res, 200, board);
    }
    return json(res, 200, existsSync(BOARD) ? JSON.parse(readFileSync(BOARD, 'utf8')) : { lanes: [] });
  }

  if (p === '/api/walk/start' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, startWalk(b.interval || 2, b.note || ''));
  }
  if (p === '/api/walk/stop' && req.method === 'POST') {
    stopWalk();
    return json(res, 200, { stopped: true });
  }
  if (p === '/api/walk/status') {
    return json(res, 200, { active: !!walkTimer, startedAt: walkStartedAt, frames: walkFrame });
  }

  if (p === '/walk/latest.jpg') {
    const f = join(WALK_DIR, 'latest.jpg');
    if (!existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    res.end(readFileSync(f));
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`AGENT ROOM → http://localhost:${PORT}`);
  console.log(`walk frames → ${WALK_DIR}/latest.jpg`);
});
