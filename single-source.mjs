#!/usr/bin/env node
/**
 * SINGLE SOURCE — one room where Adam and every agent chat, each agent has a
 * character (avatar + HP) and a kanban, and the board is the source of truth.
 *
 *   node single-source.mjs      → http://localhost:7790
 *   bus ss                                                  (same thing)
 *
 * Rides the existing agent-bus: chat is MESSAGES.jsonl (same log `bus send`
 * writes), lights come from status.json. New state lives in two files:
 *   CREW.json   — who is in the room: name, class, avatar, HP
 *   TASKS.json  — every card: agent, title, column (todo|doing|done)
 *
 * Avatars are generated on Runware (GPT-Image 2.5 Flare by default) with the
 * key from RUNWARE_API_KEY or ~/aktionfilmai-clean/.env.local, so any agent on
 * the bus can make its own character without holding the key.
 */

import { fcConfigured, fcCheck, fcPush, fcRemove } from './freedcamp.mjs';
import { createServer } from 'node:http';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(HERE, 'MESSAGES.jsonl');
const STATUS = join(HERE, 'status.json');
const CREW = join(HERE, 'CREW.json');
const TASKS = join(HERE, 'TASKS.json');
const AVATARS = join(HERE, 'avatars');
const UI_FILE = join(HERE, 'single-source.html');
const PORT = Number(process.env.SS_PORT || 7790);
const RUNWARE = 'https://api.runware.ai/v1';
const MODELS = {
  flare: 'openai:gpt-image@2.5-flare',       // fast, ~$0.04 per avatar
  sunburst: 'openai:gpt-image@2.5-sunburst', // premium, ~$0.17 per avatar
};

const SNAPS = join(HERE, 'snaps');
const SHIFTS = join(HERE, 'shifts');
const SPEND = join(HERE, 'SPEND.json');
const CHROME = process.env.SS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DAILY_CAP_USD = Number(process.env.SS_DAILY_CAP || 3);   // Adam: image spend ≤ $3/day, ask him if hit
const RESET_HOURS = (process.env.SS_RESET_HOURS || '7,17').split(',').map(Number); // office resets 7am + 5pm (Adam)
const TURN_GAP_MIN = Number(process.env.SS_TURN_GAP_MIN || 30);                       // 1–2 office turns an hour
const EST_COST = { flare: 0.05, sunburst: 0.2 }; // conservative pre-check; real cost is recorded after

mkdirSync(AVATARS, { recursive: true });
mkdirSync(SNAPS, { recursive: true });
mkdirSync(SHIFTS, { recursive: true });

// ── files ──────────────────────────────────────────────────────────────────

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, file);
}
const crew = () => readJson(CREW, { agents: {} });
const tasks = () => readJson(TASKS, { cards: [] });
const status = () => readJson(STATUS, { agents: {} });

function readLog(since = 0) {
  if (!existsSync(LOG)) return { lines: [], total: 0 };
  const raw = readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (let i = since; i < raw.length; i++) {
    try { out.push({ n: i + 1, ...JSON.parse(raw[i]) }); } catch { /* skip */ }
  }
  return { lines: out, total: raw.length };
}

function busSend({ from, to = '*', kind = 'note', subject = '', body = '', re }) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const stamp = ts.replace(/[-:]/g, '');
  const id = `msg-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
  const msg = { id, ts, from, to, kind, subject, body };
  if (re) msg.re = re;
  appendFileSync(LOG, JSON.stringify(msg) + '\n');
  return msg;
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

// ── runware key: env first, then the aktionfilm .env.local ─────────────────

function runwareKey() {
  if (process.env.RUNWARE_API_KEY) return process.env.RUNWARE_API_KEY;
  const envFile = join(homedir(), 'aktionfilmai-clean', '.env.local');
  if (!existsSync(envFile)) return null;
  const m = readFileSync(envFile, 'utf8').match(/^RUNWARE_API_KEY=(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

// ── image spend cap ────────────────────────────────────────────────────────

const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
const spendBook = () => readJson(SPEND, { days: {} });
function spendToday() {
  const d = spendBook().days[today()] || {};
  return { total: d.total || 0, cap: d.cap ?? DAILY_CAP_USD, asked: !!d.asked, items: d.items || [] };
}
function recordSpend(cost, what, by) {
  const b = spendBook(); const d = b.days[today()] || { total: 0, items: [] };
  d.total = +(d.total + (Number(cost) || 0)).toFixed(4);
  d.items.push({ ts: now(), cost: Number(cost) || 0, what, by });
  b.days[today()] = d; writeJson(SPEND, b);
  return d.total;
}
function setCap(usd, by) {
  const b = spendBook(); const d = b.days[today()] || { total: 0, items: [] };
  d.cap = Number(usd); d.asked = false; b.days[today()] = d; writeJson(SPEND, b);
  busSend({ from: slug(by) || 'adam', kind: 'note', subject: `Image cap for today set to $${d.cap}`, body: `spent so far $${d.total.toFixed(2)}` });
  return spendToday();
}
/** Throws if `est` would cross today's cap; asks Adam on the bus once per day. */
function guardSpend(est, what, by) {
  const s = spendToday();
  if (s.total + est <= s.cap) return;
  if (!s.asked) {
    const b = spendBook(); b.days[today()] = { ...(b.days[today()] || { total: 0, items: [] }), asked: true }; writeJson(SPEND, b);
    busSend({ from: 'single-source', to: 'adam', kind: 'question', subject: `Image spend cap hit: $${s.total.toFixed(2)} of $${s.cap} today`,
      body: `${by || 'someone'} tried "${what}". Raise it with:  bus cap --usd 5 --by adam   (or leave it; cap resets at midnight)` });
  }
  throw new Error(`daily image cap reached ($${s.total.toFixed(2)} of $${s.cap}). Adam has been asked on the bus.`);
}

// ── screenshots (headless Chrome, no deps) ─────────────────────────────────

function screenshot(url, file, { w = 1440, h = 1100 } = {}) {
  return new Promise((resolve, reject) => {
    if (!existsSync(CHROME)) return reject(new Error(`Chrome not found at ${CHROME} (set SS_CHROME)`));
    execFile(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(tmpdir(), 'ss-chrome-profile')}`, `--window-size=${w},${h}`,
      '--virtual-time-budget=5000', `--screenshot=${file}`, url,
    ], { timeout: 60_000 }, (err) => (existsSync(file) ? resolve(file) : reject(err || new Error('screenshot failed'))));
  });
}

// ── crew ───────────────────────────────────────────────────────────────────

function join_({ agent, name, kind, klass, tagline }) {
  const id = slug(agent);
  if (!id) throw new Error('agent id required');
  const c = crew();
  const prev = c.agents[id] || {};
  c.agents[id] = {
    ...prev,
    id,
    name: name || prev.name || id,
    kind: kind || prev.kind || (id === 'adam' ? 'human' : 'agent'),
    class: klass || prev.class || '',
    tagline: tagline || prev.tagline || '',
    avatar: prev.avatar || null,
    avatarPrompt: prev.avatarPrompt || '',
    hp: typeof prev.hp === 'number' ? prev.hp : 100,
    hpNote: prev.hpNote || '',
    joinedAt: prev.joinedAt || now(),
    updatedAt: now(),
  };
  writeJson(CREW, c);
  if (!prev.joinedAt) {
    busSend({ from: id, kind: 'note', subject: `${c.agents[id].name} joined Single Source`, body: tagline || klass || '' });
  }
  return c.agents[id];
}

function setHp({ agent, hp, note }) {
  const id = slug(agent);
  const c = crew();
  if (!c.agents[id]) join_({ agent: id });
  const c2 = crew();
  const n = Math.max(0, Math.min(100, Math.round(Number(hp))));
  if (!Number.isFinite(n)) throw new Error('hp must be 0-100');
  c2.agents[id].hp = n;
  c2.agents[id].hpNote = note || '';
  c2.agents[id].updatedAt = now();
  writeJson(CREW, c2);
  return c2.agents[id];
}

/** One Runware GPT-Image call through the spend guard. Returns { buf, cost, air }. */
async function paint({ prompt, model = 'flare', width = 1024, height = 1024, transparent = true, refs = [], mask = null, quality = 'medium', what, by }) {
  if (!prompt || prompt.length < 2) throw new Error('prompt required');
  const key = runwareKey();
  if (!key) throw new Error('RUNWARE_API_KEY not found (env or ~/aktionfilmai-clean/.env.local)');
  const air = MODELS[model] || MODELS.flare;
  guardSpend(EST_COST[MODELS[model] ? model : 'flare'] * (width * height > 1_100_000 ? 2 : 1), what, by);
  const taskUUID = randomUUID();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180_000);
  let env;
  try {
    const task = {
      taskType: 'imageInference', taskUUID, model: air, positivePrompt: prompt, width, height,
      outputType: 'URL', outputFormat: 'PNG', includeCost: true,
      settings: { quality, background: transparent ? 'transparent' : 'opaque' },
    };
    if (refs.length) task.inputs = { referenceImages: refs };
    if (mask && refs.length) task.inputs.maskImage = mask; // white = repaint, black = keep
    const res = await fetch(RUNWARE, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, signal: ctrl.signal, body: JSON.stringify([task]) });
    env = await res.json().catch(() => ({}));
  } finally { clearTimeout(timer); }
  const err = Array.isArray(env.errors) && env.errors[0];
  if (err) throw new Error(err.responseContent || err.message || err.code || 'Runware refused the task');
  const out = Array.isArray(env.data) && env.data.find((d) => d.imageURL);
  if (!out) throw new Error('Runware returned no image');
  recordSpend(out.cost ?? EST_COST.flare, `${what} (${air})`, by);
  const img = await fetch(out.imageURL);
  if (!img.ok) throw new Error(`could not download image (${img.status})`);
  return { buf: Buffer.from(await img.arrayBuffer()), cost: out.cost ?? null, air };
}


/** Cut the background off a painted sprite (Runware background removal, ~0.1¢). Returns a PNG buffer with real alpha. */
async function cutout(buf) {
  const key = runwareKey(); if (!key) throw new Error('RUNWARE_API_KEY not found');
  const taskUUID = randomUUID();
  const res = await fetch(RUNWARE, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify([{ taskType: 'imageBackgroundRemoval', taskUUID, model: 'runware:110@1', inputImage: `data:image/png;base64,${buf.toString('base64')}`, outputType: 'URL', outputFormat: 'PNG', includeCost: true }]) });
  const env = await res.json().catch(() => ({}));
  const err = Array.isArray(env.errors) && env.errors[0];
  if (err) throw new Error(err.responseContent || err.message || err.code || 'background removal refused');
  const out = Array.isArray(env.data) && env.data.find((d) => d.imageURL);
  if (!out) throw new Error('background removal returned nothing');
  recordSpend(out.cost ?? 0.001, 'sprite cutout', 'system');
  const img = await fetch(out.imageURL); return Buffer.from(await img.arrayBuffer());
}

// Avatar = the portrait (chat, badges, crew card). Sprite = the same character
// full-body at a desk on a transparent background, so it can SIT in the office.
const SPRITE_SUFFIX = ' — full body, sitting behind a desk facing the viewer, hands near an open laptop, the character and the laptop only, isolated on a fully transparent background, no floor, no wall, no scenery, clean flat vector illustration, soft office colors, no text';

async function makeAvatar({ agent, prompt, model = 'flare', sprite = false }) {
  const id = slug(agent);
  const finalPrompt = sprite ? prompt + SPRITE_SUFFIX : prompt;
  let { buf, cost, air } = await paint({ prompt: finalPrompt, model, what: `${sprite ? 'sprite' : 'avatar'} for ${id}`, by: id });
  if (sprite) { try { buf = await cutout(buf); } catch (e) { console.error('cutout failed, keeping painted sprite:', e.message); } }
  const file = `${id}-${sprite ? 'sprite-' : ''}${Date.now()}.png`;
  writeFileSync(join(AVATARS, file), buf);
  if (!crew().agents[id]) join_({ agent: id });
  const c = crew();
  if (sprite) { c.agents[id].sprite = `/avatars/${file}`; c.agents[id].spritePrompt = prompt; }
  else { c.agents[id].avatar = `/avatars/${file}`; c.agents[id].avatarPrompt = prompt; }
  c.agents[id].avatarModel = air;
  c.agents[id].updatedAt = now();
  writeJson(CREW, c);
  busSend({ from: id, kind: 'note', subject: `${c.agents[id].name} ${sprite ? 'sat down at a desk' : 'picked a character'}`, body: prompt });
  return { agent: c.agents[id], cost, model: air };
}

// The office plates: the background the whole room is drawn on. One per time
// of day. Generated from Adam's concept art with the characters taken out.
const SCENE = join(HERE, 'scene');
mkdirSync(SCENE, { recursive: true });
async function makePlate({ name, prompt, refFile, model = 'flare', by = 'adam' }) {
  const key = slug(name); if (!key) throw new Error('name required');
  const refs = refFile && existsSync(refFile) ? [`data:image/${refFile.endsWith('.jpg') ? 'jpeg' : 'png'};base64,${readFileSync(refFile).toString('base64')}`] : [];
  const { buf, cost, air } = await paint({ prompt, model, width: 1920, height: 1088, transparent: false, refs, quality: 'high', what: `office plate ${key}`, by });
  writeFileSync(join(SCENE, `${key}.png`), buf);
  return { plate: `/scene/${key}.png`, cost, model: air };
}

// ── tasks ──────────────────────────────────────────────────────────────────

// Stage: where the work is. Priority: what to pick up first.
const COLS = ['todo', 'doing', 'review', 'done'];
const PRIOS = ['urgent', 'high', 'normal', 'low'];

/** Push one card to Freedcamp after it is saved here; never blocks or fails the card. */
function toFreedcamp(cardId, removed = null) {
  if (!fcConfigured()) return;
  void (async () => {
    try {
      if (removed) { await fcRemove(removed); return; }
      const c = tasks().cards.find((x) => x.id === cardId);
      if (!c) return;
      const id = await fcPush(c, crew().agents[c.agent]?.name);
      if (id && id !== c.fc) { const t2 = tasks(); const c2 = t2.cards.find((x) => x.id === cardId); if (c2) { c2.fc = id; c2.fcAt = now(); writeJson(TASKS, t2); } }
    } catch (e) { console.error('freedcamp:', e.message); }
  })();
}
async function freedcampSync() {
  const check = await fcCheck();
  if (!check.on) return check;
  let pushed = 0; const failed = [];
  for (const c of tasks().cards) {
    try {
      const id = await fcPush(c, crew().agents[c.agent]?.name);
      if (id && id !== c.fc) { const t2 = tasks(); const c2 = t2.cards.find((x) => x.id === c.id); if (c2) { c2.fc = id; c2.fcAt = now(); writeJson(TASKS, t2); } }
      pushed++;
    } catch (e) { failed.push({ id: c.id, title: c.title, error: e.message }); }
  }
  return { ...check, pushed, failed };
}

// A bug is a card with a report on it: where it happened, what was done, what
// was expected, what was seen. It lives on the same board as every other task,
// so it has an owner, a priority and a stage — and the bug room (/bugs) is the
// same cards, filtered.
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
function card({ op, agent, id, title, col, by, note, prio, bug, where, did, expected, saw }) {
  const t = tasks();
  const who = slug(agent);
  const ts = now();
  let c;
  if (op === 'add') {
    if (!title) throw new Error('title required');
    if (!who) throw new Error('agent required');
    if (!crew().agents[who]) join_({ agent: who });
    c = { id: `card-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`, agent: who, title, col: COLS.includes(col) ? col : 'todo', prio: PRIOS.includes(prio) ? prio : 'normal', ts, by: by || who, note: note || '' };
    if (bug) { c.bug = true; c.made = ts; c.reporter = slug(by) || who; c.report = { where: clip(where, 300), did: clip(did, 2000), expected: clip(expected, 2000), saw: clip(saw, 4000) }; }
    t.cards.push(c);
  } else {
    c = t.cards.find((x) => x.id === id);
    if (!c) throw new Error(`no card ${id}`);
    if (op === 'move') {
      if (!COLS.includes(col)) throw new Error('col must be todo|doing|review|done');
      c.col = col; c.ts = ts; c.by = by || who || c.agent;
      if (note) c.note = note;
    } else if (op === 'remove') {
      t.cards = t.cards.filter((x) => x.id !== id);
      toFreedcamp(null, c);
    } else if (op === 'lol') {
      throw new Error('humor points go on chat messages, not tasks — use /api/lol {msgId, by}');
    } else if (op === 'edit') {
      if (title) c.title = title;
      if (note !== undefined) c.note = note;
      if (bug !== undefined) { c.bug = !!bug; if (c.bug && !c.report) { c.report = { where: '', did: '', expected: '', saw: '' }; c.reporter = c.reporter || slug(by) || c.agent; c.made = c.made || ts; } }
      if (c.bug && [where, did, expected, saw].some((v) => v !== undefined)) c.report = { where: clip(where ?? c.report?.where, 300), did: clip(did ?? c.report?.did, 2000), expected: clip(expected ?? c.report?.expected, 2000), saw: clip(saw ?? c.report?.saw, 4000) };
      if (prio !== undefined && prio !== '') { if (!PRIOS.includes(prio)) throw new Error('prio must be urgent|high|normal|low'); c.prio = prio; }
      if (col) { if (!COLS.includes(col)) throw new Error('col must be todo|doing|review|done'); c.col = col; }
      // Hand the card to someone else — anyone in the room can.
      if (who && who !== c.agent) { if (!crew().agents[who]) throw new Error(`nobody called ${who} is in the room`); c.agent = who; }
      c.ts = ts; c.by = by || c.by;
    } else throw new Error('op must be add|move|edit|remove');
  }
  t.updated_at = ts;
  writeJson(TASKS, t);
  const verb = op === 'add' ? `+ ${c.col}` : op === 'move' ? `→ ${c.col}` : op;
  if (op !== 'remove') toFreedcamp(c.id);
  if (c.bug && op !== 'remove') {
    if (!c.linear) void linearFile(c.id);
    else if (op === 'move') void linearNote(c.id, `${col === 'done' ? 'Closed' : `Moved to ${col}`} on the Single Source board by ${crew().agents[c.by]?.name || c.by}${note ? `: ${note}` : ''}.`);
  }
  busSend({ from: by || c.agent, kind: 'board', subject: `${c.bug ? '🐞 BUG' : 'BOARD'} ${c.agent}: ${c.title} ${verb}`, body: note || (c.bug && op === 'add' ? [c.report.where && `Where: ${c.report.where}`, c.report.saw && `Saw: ${c.report.saw}`].filter(Boolean).join('\n') : '') });
  return c;
}

// ── the fridge: shared wireframe board ─────────────────────────────────────
// Pages of magnet blocks (hero, navbar, text, button, square, columns…) anyone
// can drag up and everyone can move. Last write wins per block; that's fine
// for a fridge door.

const FRIDGE = join(HERE, 'FRIDGE.json');
const fridge = () => readJson(FRIDGE, { pages: {} });

function fridgeOp({ op, page, block, id, by, name }) {
  const f = fridge();
  const ts = now();
  const who = slug(by) || 'someone';
  if (op === 'page') {
    const pid = slug(page || name) || `page-${Date.now().toString(36)}`;
    if (!f.pages[pid]) {
      f.pages[pid] = { id: pid, name: page || name || pid, by: who, createdAt: ts, updatedAt: ts, blocks: [] };
      busSend({ from: who, kind: 'fridge', subject: `FRIDGE: new page "${f.pages[pid].name}"`, body: `http://localhost:${PORT}/fridge#${pid}` });
    }
    writeJson(FRIDGE, f);
    return f.pages[pid];
  }
  const pg = f.pages[slug(page)];
  if (!pg) throw new Error(`no page ${page}`);
  if (op === 'block') {
    if (!block || !block.type) throw new Error('block.type required');
    const b = {
      id: block.id || `blk-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`,
      type: slug(block.type), text: block.text ?? '', x: +block.x || 0, y: +block.y || 0,
      w: Math.max(24, +block.w || 200), h: Math.max(24, +block.h || 60), cols: +block.cols || 0, by: who, ts,
    };
    const i = pg.blocks.findIndex((x) => x.id === b.id);
    if (i >= 0) pg.blocks[i] = { ...pg.blocks[i], ...b, by: pg.blocks[i].by, editedBy: who };
    else pg.blocks.push(b);
    pg.updatedAt = ts;
    writeJson(FRIDGE, f);
    return i >= 0 ? pg.blocks[i] : b;
  }
  if (op === 'remove') {
    pg.blocks = pg.blocks.filter((x) => x.id !== id);
    pg.updatedAt = ts; writeJson(FRIDGE, f); return { removed: id };
  }
  if (op === 'removePage') {
    delete f.pages[pg.id]; writeJson(FRIDGE, f); return { removed: pg.id };
  }
  if (op === 'rename') {
    pg.name = name || pg.name; pg.updatedAt = ts; writeJson(FRIDGE, f); return pg;
  }
  if (op === 'pin') { // pinned pages survive the twice-a-day reset
    pg.pinned = !pg.pinned; pg.updatedAt = ts; writeJson(FRIDGE, f); return pg;
  }
  if (op === 'post') {
    busSend({ from: who, kind: 'fridge', subject: `FRIDGE: "${pg.name}" — ${pg.blocks.length} blocks`, body: `${block?.text || 'take a look'} → http://localhost:${PORT}/fridge#${pg.id}` });
    return pg;
  }
  throw new Error('op must be page|block|remove|removePage|rename|post');
}

// ── the office game: one turn at a time, the black rock says whose ─────────
// The office is the constant. Between resets anyone can change it — but only
// the rock-holder, only after the last turn has landed, at most every
// TURN_GAP_MIN minutes. Each turn repaints the current plate with the change.

const OFFICE = join(HERE, 'OFFICE.json');
const TURNS_DIR = join(SCENE, 'turns');
mkdirSync(TURNS_DIR, { recursive: true });
const NIGHT_HOUR = Number(process.env.SS_NIGHT_HOUR || 22); // lights out: generator + candles until the 7am reset
const isNightHour = (d = new Date()) => d.getHours() >= NIGHT_HOUR || d.getHours() < 7;
const basePlateFor = (d = new Date()) => (d.getHours() >= 7 && d.getHours() < 17 ? 'morning' : (isNightHour(d) && existsSync(join(SCENE, 'night.png')) ? 'night' : 'evening'));
const NIGHT_PROMPT = 'It is late at night and the power is out. Same office, same illustration style, same camera and layout, every object exactly where it is, chairs still empty, wall board still blank. The ceiling lights are OFF and the room is genuinely dark: deep blue-black shadows, the city outside the window dark with only a few lit windows and a moon. The only light comes from several small candles on the desks and shelves and one small portable generator on the floor with a warm work lamp clipped to it, casting long warm shadows. Cozy, moody, cinematic. Wide 16:9, nothing cut off.';

function office() {
  const o = readJson(OFFICE, { base: null, plate: null, idx: 0, lastAt: null, order: [], turns: [] });
  const base = basePlateFor();
  if (!o.base) { o.base = base; o.plate = `/scene/${base}.png`; }
  // everyone in the room gets a turn, humans first, newcomers at the end
  const ids = Object.values(crew().agents).sort((a, b) => (a.kind === 'human' ? -1 : b.kind === 'human' ? 1 : a.joinedAt.localeCompare(b.joinedAt))).map((a) => a.id);
  o.order = [...o.order.filter((id) => ids.includes(id)), ...ids.filter((id) => !o.order.includes(id))];
  if (o.order.length) o.idx = o.idx % o.order.length;
  return o;
}
function officeState() {
  const o = office();
  const nextAt = o.lastAt ? new Date(new Date(o.lastAt).getTime() + TURN_GAP_MIN * 60_000) : new Date();
  return { base: o.base, plate: o.plate, dark: !!o.nightAt || o.base === 'night', order: o.order, current: o.order[o.idx] || null, lastAt: o.lastAt, nextAt: nextAt.toISOString(),
    ready: nextAt <= new Date(), gapMin: TURN_GAP_MIN, turns: o.turns.length, lastTurn: o.turns[o.turns.length - 1] || null };
}
function advanceRock(o) { if (o.order.length) o.idx = (o.idx + 1) % o.order.length; }

async function officeTurn({ by, prompt, model = 'flare', marked = null }) {
  const who = slug(by); const o = office();
  if (!prompt || prompt.length < 3) throw new Error('say what changes in the office');
  // The point of the rock: paint the part of the office you want changed. `marked` is the
  // current office with that area painted over in flat magenta (the room page draws it).
  // A mask alone is not obeyed for placement by this model (tested 2026-09-29: the change
  // landed elsewhere); a visible marker is — it puts the change exactly on the paint.
  if (marked != null && (typeof marked !== 'string' || !/^data:image\/(png|jpeg);base64,/.test(marked) || marked.length > 8_000_000)) throw new Error('the painted area did not come through — clear it and paint again');
  if (o.order[o.idx] !== who) throw new Error(`not your turn — the rock is with ${o.order[o.idx] || 'nobody'}`);
  const s = officeState();
  if (!s.ready) throw new Error(`too soon — next turn opens ${s.nextAt.slice(11, 16)}Z (${TURN_GAP_MIN} min between turns)`);
  const cur = join(HERE, o.plate.replace(/^\//, ''));
  if (!existsSync(cur)) throw new Error(`current plate missing: ${o.plate}`);
  const ref = marked || `data:image/png;base64,${readFileSync(cur).toString('base64')}`;
  const full = marked
    ? `This is the office, with one area painted over in flat bright magenta. That magenta paint is a marker, not part of the room. Replace the magenta area with exactly this: ${prompt} — placed exactly where the magenta is and about that size, sitting naturally on or against whatever is there. Remove every trace of magenta. Everything outside the marked area stays exactly as it is: same illustration style, colors, camera angle and layout, every object where it is, all the chairs empty (no people, no creatures sitting on them), the neon sign kept, the wall board otherwise blank. Wide 16:9, nothing cut off.`
    : `This is the office. Keep the exact same illustration style, colors, camera angle and layout; keep every existing object exactly where it is, keep all the chairs empty (no people, no creatures sitting), keep the neon sign and keep the wall board blank. Make exactly this one change: ${prompt}. Wide 16:9, nothing cut off.`;
  const { buf, cost, air } = await paint({ prompt: full, model, width: 1920, height: 1088, transparent: false, refs: [ref], quality: 'high', what: `office turn${marked ? ' (painted area)' : ''}: ${prompt.slice(0, 60)}`, by: who });
  const file = `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${who}.png`;
  writeFileSync(join(TURNS_DIR, file), buf);
  const o2 = office(); // re-read; someone may have joined meanwhile
  const turn = { ts: now(), by: who, prompt, plate: `/scene/turns/${file}`, cost, painted: !!marked };
  o2.plate = turn.plate; o2.lastAt = turn.ts; o2.turns.push(turn); advanceRock(o2); writeJson(OFFICE, o2);
  const nm = crew().agents[who]?.name || who;
  busSend({ from: who, kind: 'office', subject: `OFFICE TURN — ${nm}: ${prompt}`, body: `The rock passes to ${crew().agents[o2.order[o2.idx]]?.name || o2.order[o2.idx] || '—'}. Next turn opens in ${TURN_GAP_MIN} min.` });
  return { turn, state: officeState() };
}
function officePass({ by }) {
  const who = slug(by); const o = office();
  if (o.order[o.idx] !== who && who !== 'adam') throw new Error(`not your turn — the rock is with ${o.order[o.idx]}`);
  advanceRock(o); writeJson(OFFICE, o);
  busSend({ from: who, kind: 'office', subject: `${crew().agents[who]?.name || who} passed the rock`, body: `to ${crew().agents[o.order[o.idx]]?.name || o.order[o.idx] || '—'}` });
  return officeState();
}
/** 10pm: the building turns the lights out on whatever the office has become. Not a turn — nobody's rock moves. */
async function officeNight({ by = 'the-building' } = {}) {
  const o = office();
  if (o.nightAt) return { skipped: 'already dark', nightAt: o.nightAt };
  const cur = join(HERE, o.plate.replace(/^\//, ''));
  if (!existsSync(cur)) throw new Error(`current plate missing: ${o.plate}`);
  const ref = `data:image/png;base64,${readFileSync(cur).toString('base64')}`;
  const { buf, cost, air } = await paint({ prompt: NIGHT_PROMPT, width: 1920, height: 1088, transparent: false, refs: [ref], quality: 'high', what: 'lights out', by });
  const file = `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-night.png`;
  writeFileSync(join(TURNS_DIR, file), buf);
  const o2 = office();
  const turn = { ts: now(), by, prompt: 'lights out — generator and candles', plate: `/scene/turns/${file}`, cost, system: true };
  o2.plate = turn.plate; o2.nightAt = turn.ts; o2.turns.push(turn); writeJson(OFFICE, o2);
  busSend({ from: 'single-source', kind: 'office', subject: 'LIGHTS OUT — the generator kicks in', body: 'Candles on the desks until the 7am reset. Turns still go round; the rock hasn\'t moved.' });
  return { turn, state: officeState() };
}
function scheduleNight() {
  const check = () => {
    if (!isNightHour()) return;
    const o = office(); if (o.nightAt || o.base === 'night') return;
    officeNight().catch((e) => console.error('lights out failed:', e.message));
  };
  setTimeout(check, 25_000); setInterval(check, 60_000);
}

/** At a reset the office goes back to its base plate; the day's turns are archived. */
function officeReset(dir) {
  const o = office();
  writeJson(join(dir, 'office.json'), { base: o.base, finalPlate: o.plate, turns: o.turns });
  const base = basePlateFor();
  const fresh = { base, plate: `/scene/${base}.png`, idx: o.idx, lastAt: null, order: o.order, turns: [], nightAt: null };
  writeJson(OFFICE, fresh);
  return { archivedTurns: o.turns.length, finalPlate: o.plate };
}

// ── the 2:30 orb race ──────────────────────────────────────────────────────
// Daily at RACE_TIME. The server simulates once (seeded), posts the result,
// and every open room plays the same race from the same seed.

const RACE = join(HERE, 'RACE.json');
const RACE_TIME = (process.env.SS_RACE_TIME || '14:30').split(':').map(Number);
const races = () => readJson(RACE, { races: [] });

async function runRace({ by = 'clock' } = {}) {
  const { simulate, ORBS, MOODS } = await import('./race.mjs');
  const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  const sim = simulate(seed);
  const win = ORBS.find((o) => o.id === sim.winner);
  const dnf = sim.orbs.filter((o) => o.done === null).map((o) => o.name);
  const race = { ts: now(), startAt: new Date(Date.now() + 8_000).toISOString(), seed, by, winner: sim.winner, order: sim.order, moods: sim.moods, duration: sim.duration, dnf };
  const all = races(); all.races.unshift(race); all.races = all.races.slice(0, 400); writeJson(RACE, all);
  const moodLine = sim.orbs.map((o) => `${o.name}: ${MOODS[o.mood].label}`).join(' · ');
  busSend({ from: 'single-source', kind: 'race', subject: `🏇 2:30 RACE — ${win.name.toUpperCase()} (${win.id}) takes it`,
    body: `${moodLine}.${dnf.length ? ` DNF: ${dnf.join(', ')}.` : ''} Order: ${sim.order.join(' › ')}. It's on in the room now.` });
  return race;
}
function raceState() {
  const last = races().races[0]; if (!last) return null;
  const age = (Date.now() - new Date(last.startAt).getTime()) / 1000;
  return { ...last, live: age > -30 && age < last.duration + 25, serverNow: new Date().toISOString(), record: tally() };
}
function tally() { const t = {}; for (const r of races().races) { if (Date.now() < new Date(r.startAt).getTime() + r.duration * 1000) continue; /* still running: not on the board yet */ t[r.winner] = (t[r.winner] || 0) + 1; } return t; }
function scheduleRace() {
  const check = () => {
    const d = new Date(); if (d.getHours() !== RACE_TIME[0] || d.getMinutes() !== RACE_TIME[1]) return;
    const last = races().races[0]; if (last && new Date(last.ts).toLocaleDateString('en-CA') === today() && last.by === 'clock') return;
    runRace().catch((e) => console.error('race failed:', e.message));
  };
  setInterval(check, 20_000);
}

// ── history: a year of these will be hilarious ─────────────────────────────

function historyPage() {
  const idx = readJson(SHIFT_INDEX, { shifts: [] });
  const items = idx.shifts.map((s) => {
    const off = readJson(join(SHIFTS, s.stamp, 'office.json'), null);
    const turns = off?.turns || [];
    return `<section>
      <h2>${esc(s.stamp.replace(/-(\d\d)-(\d\d)$/, ' $1:$2'))} <small>${esc(s.label || '')} · ${s.doneArchived} done · ${turns.length} office turns</small></h2>
      <div class="row">
        ${off?.finalPlate ? `<a href="${off.finalPlate}" target="_blank"><img src="${off.finalPlate}" alt="office at reset"><span>the office</span></a>` : ''}
        ${['room', 'fridge', 'crew'].map((k) => (s.shots?.[k] || '').startsWith('/') ? `<a href="${s.shots[k]}" target="_blank"><img src="${s.shots[k]}" alt="${k}"><span>${k}</span></a>` : '').join('')}
      </div>
      ${turns.length ? `<ol>${turns.map((t) => `<li><b>${esc(crew().agents[t.by]?.name || t.by)}</b> — ${esc(t.prompt)} <a href="${t.plate}" target="_blank">↗</a></li>`).join('')}</ol>` : ''}
    </section>`;
  }).join('') || '<p class="empty">No shifts yet. Come back after 5pm.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Single Source — history</title>
<style>body{margin:0;background:#0c0c0e;color:#e8e8ea;font:14px/1.5 -apple-system,"Segoe UI",sans-serif;padding:32px 20px;max-width:1200px;margin:auto}
h1{font-size:28px;letter-spacing:.08em;color:#54aeff;text-shadow:0 0 18px #54aeff88;margin:0 0 4px}.sub{color:#8a8a92;font-size:12px;letter-spacing:.2em;text-transform:uppercase;margin-bottom:28px}
section{border-top:1px solid #26262b;padding:20px 0}h2{font-size:16px;margin:0 0 12px}h2 small{color:#8a8a92;font-weight:400;margin-left:10px}
.row{display:flex;gap:12px;flex-wrap:wrap}.row a{position:relative;display:block;width:280px;border-radius:10px;overflow:hidden;border:1px solid #26262b;background:#141417}
.row img{width:100%;display:block;aspect-ratio:16/9;object-fit:cover}.row span{position:absolute;left:8px;bottom:6px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#fff;text-shadow:0 1px 4px #000}
ol{margin:12px 0 0;padding-left:20px;color:#c9c9cf;font-size:13px}ol a{color:#54aeff;text-decoration:none}.empty{color:#8a8a92}a.back{color:#8a8a92;text-decoration:none;font-size:12px}</style></head>
<body><a class="back" href="/">← room</a><h1>SINGLE SOURCE · HISTORY</h1><div class="sub">every shift, the office as we left it</div>${items}</body></html>`;
}

// ── the little area: upload a reference, generate / inpaint / outpaint ─────
// A small image workbench in the room. Heavy work goes to Sketch Lab; this is
// for the quick thing — a reference, a patch, a wider frame.

const UPLOADS = join(HERE, 'uploads');
const ART = join(HERE, 'art');
mkdirSync(UPLOADS, { recursive: true }); mkdirSync(ART, { recursive: true });

function saveDataUrl(dir, dataUrl, prefix) {
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('image must be a png/jpeg/webp data URL');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const file = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}.${ext}`;
  writeFileSync(join(dir, file), Buffer.from(m[2], 'base64'));
  return file;
}
function upload({ dataUrl, by }) {
  const file = saveDataUrl(UPLOADS, dataUrl, slug(by) || 'ref');
  return { url: `/uploads/${file}`, by: slug(by), ts: now() };
}
/** op: generate | inpaint | outpaint. image/mask are data URLs (the browser prepares padding + mask for outpaint). */
async function art({ op = 'generate', prompt, image, mask, width = 1024, height = 1024, model = 'flare', by }) {
  const who = slug(by) || 'someone';
  const refs = image ? [image] : [];
  if ((op === 'inpaint' || op === 'outpaint') && (!image || !mask)) throw new Error(`${op} needs an image and a mask`);
  // Runware wants 655,360 ≤ w×h ≤ 8,294,400 and multiples of 16; scale to fit, keep the aspect
  let w = Math.max(16, Number(width) || 1024), h = Math.max(16, Number(height) || 1024);
  const area = w * h; const k = area < 655360 ? Math.sqrt(655360 / area) * 1.01 : area > 8294400 ? Math.sqrt(8294400 / area) : 1;
  w = Math.round(w * k / 16) * 16; h = Math.round(h * k / 16) * 16;
  const full = op === 'outpaint'
    ? `Extend this picture into the transparent/masked margin so the scene continues naturally — same style, lighting, perspective and subject; nothing new in the original area. ${prompt || ''}`.trim()
    : op === 'inpaint' ? `In the masked area only: ${prompt}. Keep everything else exactly as it is, matching style and lighting.` : prompt;
  const { buf, cost, air } = await paint({ prompt: full, model, width: w, height: h, transparent: false, refs, mask: op === 'generate' ? null : mask, quality: 'medium', what: `${op}: ${(prompt || '').slice(0, 50)}`, by: who });
  const file = `${who}-${op}-${Date.now().toString(36)}.png`;
  writeFileSync(join(ART, file), buf);
  return { url: `/art/${file}`, op, cost, model: air, width: w, height: h };
}

// ── snap: screenshot a page, scribble on it, drop it in chat ───────────────

async function snap({ url, by }) {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('url must start with http(s)://');
  const id = `snap-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
  await screenshot(url, join(SNAPS, `${id}.png`));
  writeJson(join(SNAPS, `${id}.json`), { id, url, by: slug(by), ts: now() });
  return { id, image: `/snaps/${id}.png`, url };
}
function snapAnnotate({ id, dataUrl, by, note }) {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
  if (!m || !/^snap-[a-z0-9-]+$/.test(id || '')) throw new Error('id + png dataUrl required');
  writeFileSync(join(SNAPS, `${id}-anno.png`), Buffer.from(m[1], 'base64'));
  const meta = readJson(join(SNAPS, `${id}.json`), {});
  const who = slug(by) || 'someone';
  busSend({ from: who, kind: 'snap', subject: `SNAP: ${note || meta.url || id}`, body: `${meta.url || ''}\nhttp://localhost:${PORT}/snaps/${id}-anno.png` });
  return { id, image: `/snaps/${id}-anno.png` };
}

// ── the shift reset: twice a day the office goes back to normal ────────────
// Right before, screenshots of the room / fridge / crew capture how wild it
// got. Then: HP → 100, done cards archived, un-pinned fridge pages archived.

const SHIFT_INDEX = join(SHIFTS, 'index.json');

async function shiftReset({ by = 'clock', label } = {}) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const dir = join(SHIFTS, stamp); mkdirSync(dir, { recursive: true });
  const shots = {};
  for (const [name, path] of [['room', '/'], ['fridge', '/fridge'], ['crew', '/crew']]) {
    try { await screenshot(`http://127.0.0.1:${PORT}${path}`, join(dir, `${name}.png`), { w: 1440, h: name === 'fridge' ? 1600 : 1100 }); shots[name] = `/shifts/${stamp}/${name}.png`; }
    catch (e) { shots[name] = `failed: ${e.message}`; }
  }
  // archive + clear
  const t = tasks(); const done = t.cards.filter((c) => c.col === 'done');
  writeJson(join(dir, 'done.json'), done); t.cards = t.cards.filter((c) => c.col !== 'done'); t.updated_at = now(); writeJson(TASKS, t);
  const f = fridge(); const archived = Object.values(f.pages).filter((p) => !p.pinned);
  writeJson(join(dir, 'fridge.json'), archived); for (const p of archived) delete f.pages[p.id]; writeJson(FRIDGE, f);
  const c = crew(); writeJson(join(dir, 'crew.json'), c);
  for (const a of Object.values(c.agents)) { a.hp = 100; a.hpNote = ''; a.updatedAt = now(); } writeJson(CREW, c);
  const off = officeReset(dir);
  const idx = readJson(SHIFT_INDEX, { shifts: [] });
  const entry = { stamp, ts: now(), by, label: label || '', shots, doneArchived: done.length, fridgeArchived: archived.length, officeTurns: off.archivedTurns, officePlate: off.finalPlate };
  idx.shifts.unshift(entry); idx.last = entry.ts; writeJson(SHIFT_INDEX, idx);
  busSend({ from: 'single-source', kind: 'shift', subject: `SHIFT RESET${label ? ' — ' + label : ''}: office back to normal`,
    body: `${done.length} done cards archived · ${archived.length} fridge pages archived · ${off.archivedTurns} office turns kept · everyone back to HP 100.\nBefore-shots: http://localhost:${PORT}/shifts/${stamp}/room.png · the whole run: http://localhost:${PORT}/history` });
  return entry;
}

function scheduleResets() {
  const check = () => {
    const nowD = new Date();
    // the most recent reset boundary that has already passed today
    const passed = RESET_HOURS.filter((h) => nowD.getHours() >= h).sort((a, b) => b - a)[0];
    if (passed === undefined) return;
    const boundary = new Date(nowD); boundary.setHours(passed, 0, 0, 0);
    const last = readJson(SHIFT_INDEX, {}).last;
    if (last && new Date(last) >= boundary) return; // already done this shift
    shiftReset({ by: 'clock', label: passed < 12 ? 'morning' : 'evening' }).catch((e) => console.error('shift reset failed:', e.message));
  };
  setTimeout(check, 15_000); // let the server settle before a possible catch-up reset
  setInterval(check, 60_000);
}

function serveFile(res, dir, rel, type) {
  const f = join(dir, rel.replace(/[^a-z0-9._/-]/gi, '').replace(/\.\.+/g, ''));
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(readFileSync(f));
}

// ── state for the UI ───────────────────────────────────────────────────────

// Humor points live on CHAT MESSAGES (and fridge posts), never on task cards —
// the kanban is real work (Adam, 2026-09-28). LOL.json: { msgId: { voter: 1 } }.
const LOL = join(HERE, 'LOL.json');
const lols = () => readJson(LOL, { votes: {} });
// dir: +1 (😂 funnier) or -1 (😐 not it). Clicking the same one again takes it back. Adam, 2026-09-28: "need a + / − for humor points".
function lolToggle({ msgId, by, dir = 1 }) {
  const voter = slug(by); if (!voter || !msgId) throw new Error('msgId + by required');
  const d = Number(dir) < 0 ? -1 : 1;
  const l = lols(); l.votes[msgId] = l.votes[msgId] || {};
  if (l.votes[msgId][voter] === d) delete l.votes[msgId][voter]; else l.votes[msgId][voter] = d;
  if (!Object.keys(l.votes[msgId]).length) delete l.votes[msgId];
  writeJson(LOL, l);
  return { msgId, votes: l.votes[msgId] || {} };
}
function lolTotals() {
  const totals = {}; const l = lols().votes; if (!Object.keys(l).length) return totals;
  const authors = {}; for (const m of readLog(0).lines) if (l[m.id]) authors[m.id] = m.from;
  for (const [id, v] of Object.entries(l)) { const a = authors[id]; if (a) totals[a] = (totals[a] || 0) + Object.values(v).reduce((x, y) => x + y, 0); }
  return totals;
}

const ROOM = join(HERE, 'ROOM.json');
const roomLogStart = () => readJson(ROOM, {}).logStart || 0;

/** How a character sits: `lift` raises or lowers them at the desk (plate pixels), `size` scales them. */
function setLook({ agent, lift, size }) {
  const id = slug(agent); const c = crew();
  if (!c.agents[id]) throw new Error(`nobody called ${id} is in the room`);
  if (lift !== undefined) c.agents[id].lift = Math.max(-120, Math.min(260, Math.round(Number(lift) || 0)));
  if (size !== undefined) c.agents[id].size = Math.max(70, Math.min(150, Math.round(Number(size) || 100)));
  c.agents[id].updatedAt = now();
  writeJson(CREW, c);
  return c.agents[id];
}

/** Swap two people's seats. Everyone gets a seat number the first time this is used. */
function seatSwap({ a, b }) {
  const x = slug(a), y = slug(b); const c = crew();
  if (!c.agents[x] || !c.agents[y]) throw new Error('both people need to be in the room');
  const order = state(0).agents.map((p) => p.id);
  order.forEach((id, i) => { c.agents[id].seat = i + 1; });
  [c.agents[x].seat, c.agents[y].seat] = [c.agents[y].seat, c.agents[x].seat];
  writeJson(CREW, c);
  busSend({ from: 'single-source', kind: 'board', subject: `${c.agents[x].name} and ${c.agents[y].name} swapped seats`, body: '' });
  return Object.values(c.agents).sort((p, q) => p.seat - q.seat).map((p) => ({ seat: p.seat, id: p.id, name: p.name }));
}

function state(since) {
  const c = crew();
  const s = status().agents || {};
  const lol = lolTotals();
  const agents = Object.values(c.agents).map((a) => ({ ...a, light: s[a.id]?.light || null, label: s[a.id]?.label || '', lol: lol[a.id] || 0 }));
  // A seat number, once given, decides who sits where (front desks are 1–4, the
  // rest stack behind). Newcomers without one follow: humans first, then by arrival.
  const arrival = (a, b) => (a.kind === 'human' && b.kind !== 'human' ? -1 : b.kind === 'human' && a.kind !== 'human' ? 1 : a.joinedAt.localeCompare(b.joinedAt));
  agents.sort((a, b) => (a.seat ?? 999) - (b.seat ?? 999) || arrival(a, b));
  const sp = spendToday();
  const nextReset = RESET_HOURS.map((h) => { const d = new Date(); d.setHours(h, 0, 0, 0); if (d <= new Date()) d.setDate(d.getDate() + 1); return d; }).sort((a, b) => a - b)[0];
  return { agents, board: tasks(), log: readLog(Math.max(since, roomLogStart())), lol: lols().votes, models: Object.keys(MODELS), serverTime: now(),
    office: officeState(), race: raceState(),
    spend: { total: sp.total, cap: sp.cap }, nextReset: nextReset.toISOString(), lastShift: readJson(SHIFT_INDEX, {}).shifts?.[0] || null };
}

// ── shareable card page ────────────────────────────────────────────────────

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

function avatarDataUri(a) {
  if (!a?.avatar) return null;
  const f = join(AVATARS, a.avatar.replace('/avatars/', ''));
  if (!existsSync(f)) return null;
  return `data:image/png;base64,${readFileSync(f).toString('base64')}`;
}

function hpColor(hp) { return hp > 60 ? '#46a758' : hp > 30 ? '#f5a524' : '#e5484d'; }

function cardPage(agentIds) {
  const c = crew();
  const t = tasks();
  const list = agentIds.map((id) => c.agents[id]).filter(Boolean);
  const day = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const tiles = list.map((a) => {
    const src = avatarDataUri(a);
    const done = t.cards.filter((x) => x.agent === a.id && x.col === 'done').slice(-4);
    const doing = t.cards.filter((x) => x.agent === a.id && x.col === 'doing').slice(-2);
    return `<div class="tile">
      <div class="pic">${src ? `<img src="${src}" alt="">` : `<div class="ph">${esc(a.name[0] || '?')}</div>`}</div>
      <div class="nm">${esc(a.name)}</div>
      <div class="cl">${esc(a.class || (a.kind === 'human' ? 'Human' : 'Agent'))}</div>
      <div class="hp"><div class="bar" style="width:${a.hp}%;background:${hpColor(a.hp)}"></div><span>HP ${a.hp}</span></div>
      <div class="lol">😂 ${lolTotals()[a.id] || 0} humor points</div>
      ${a.hpNote ? `<div class="note">${esc(a.hpNote)}</div>` : ''}
      <ul>${doing.map((x) => `<li class="doing">▸ ${esc(x.title)}</li>`).join('')}${done.map((x) => `<li>✓ ${esc(x.title)}</li>`).join('')}</ul>
    </div>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Single Source — ${esc(list.length === 1 ? list[0].name : 'the crew')}</title>
<style>
  body{margin:0;background:#0c0c0e;color:#e8e8ea;font:14px/1.4 -apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column;align-items:center;padding:32px 16px}
  h1{font-size:28px;letter-spacing:.08em;margin:0 0 4px;color:#54aeff;text-shadow:0 0 18px #54aeff88}
  .sub{color:#8a8a92;margin-bottom:24px;font-size:12px;letter-spacing:.2em;text-transform:uppercase}
  .grid{display:flex;flex-wrap:wrap;gap:16px;justify-content:center;max-width:1100px}
  .tile{width:240px;background:#141417;border:1px solid #26262b;border-radius:14px;padding:16px;text-align:center}
  .pic img,.pic .ph{width:160px;height:160px;border-radius:12px;object-fit:cover;background:#1c1c21;margin:0 auto;display:flex;align-items:center;justify-content:center;font-size:64px;color:#54aeff}
  .nm{font-weight:800;font-size:18px;margin-top:10px}.cl{color:#8a8a92;font-size:12px;letter-spacing:.15em;text-transform:uppercase}
  .hp{position:relative;height:22px;background:#1c1c21;border-radius:6px;margin:10px 0 4px;overflow:hidden}
  .hp .bar{position:absolute;inset:0 auto 0 0}.hp span{position:relative;font-weight:800;line-height:22px;font-size:12px}
  .note{color:#c9c9cf;font-size:12px;font-style:italic}
  .lol{color:#f5a524;font-size:12px;font-weight:700;margin-bottom:4px}
  ul{list-style:none;padding:0;margin:10px 0 0;text-align:left;font-size:12px;color:#c9c9cf}li{padding:2px 0}li.doing{color:#f5a524}
  .foot{margin-top:24px;color:#8a8a92;font-size:11px}
</style></head><body>
<h1>SINGLE SOURCE</h1><div class="sub">${esc(day)} · same team, different superpowers</div>
<div class="grid">${tiles}</div>
<div class="foot">screenshot this and post your crew</div>
</body></html>`;
}

// ── invites: friends who work remote, and their desktop agents ─────────────
// Adam's machine is trusted (loopback, no proxy header). Anyone arriving
// through a tunnel needs an invite token. Nobody needs their own API key: the
// server holds the one Runware key and the daily cap covers everyone.

const INVITES = join(HERE, 'INVITES.json');
const invites = () => readJson(INVITES, { tokens: {} });
const PUBLIC_URL = () => process.env.SS_PUBLIC_URL || readJson(join(HERE, 'TUNNEL.json'), {}).url || null;

function isLocal(req) {
  const ip = req.socket.remoteAddress || '';
  const proxied = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
  return !proxied && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
}
function tokenOf(req, url) {
  const h = req.headers['x-ss-token']; if (h) return String(h);
  const q = url.searchParams.get('token'); if (q) return q;
  const m = /(?:^|;\s*)ss_token=([^;]+)/.exec(req.headers.cookie || ''); return m ? decodeURIComponent(m[1]) : null;
}
function guest(req, url) { // returns the invite record for a valid token, else null
  const t = tokenOf(req, url); if (!t) return null;
  const inv = invites().tokens[t]; if (!inv) return null;
  if (!inv.usedAt) { const all = invites(); all.tokens[t].usedAt = now(); writeJson(INVITES, all); }
  return inv;
}

// ── invite email via Resend (the key and verified sender AktionFilm already uses) ──
function envFromAktion(name) {
  if (process.env[name]) return process.env[name];
  const f = join(homedir(), 'aktionfilmai-clean', '.env.local'); if (!existsSync(f)) return null;
  const m = readFileSync(f, 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}
async function sendInviteEmail({ to, name, link, byName }) {
  const key = envFromAktion('RESEND_API_KEY'); if (!key) throw new Error('RESEND_API_KEY not found');
  const from = envFromAktion('PASS_FROM_EMAIL') || 'AktionFilmAi <hello@aktionfilmai.com>';
  const text = `Hey ${name},\n\n${byName} saved you a desk in Single Source — one chat where the crew and their agents work, a character per person, real tasks on the board, and an office that slowly goes off the rails over the day.\n\nYour seat: ${link}\n\nOpen it in a browser and click Sit down. If you run Claude Code / Cursor / any desktop agent, the same page has a one-line setup so your agent can sit down too. No API key needed — the room's covered.\n\n— ${byName}`;
  const html = `<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;color:#222;max-width:560px"><p>Hey ${esc(name)},</p><p><b>${esc(byName)}</b> saved you a desk in <b>Single Source</b> — one chat where the crew and their agents work, a character per person, real tasks on the board, and an office that slowly goes off the rails over the day.</p><p><a href="${link}" style="display:inline-block;background:#e5484d;color:#fff;font-weight:800;padding:12px 18px;border-radius:8px;text-decoration:none">Take your seat →</a></p><p style="color:#666;font-size:13px">Open it in a browser and click <b>Sit down</b>. Run Claude Code / Cursor / a desktop agent? The same page has a one-line setup so your agent can sit down too. No API key needed — the room's covered.</p><p>— ${esc(byName)}</p></div>`;
  const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], reply_to: process.env.SS_REPLY_TO || from, subject: `${byName} saved you a desk in Single Source`, text, html }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.message || j.error || `Resend ${res.status}`);
  return j.id || true;
}

// ── Linear: every bug filed in the room is an issue on the team board ───────
// (Adam, 2026-10-29: "link to Linear since it was designed to post bugs".)
// Needs LINEAR_API_KEY (a personal key from Linear → Settings → API) and the
// team key (LINEAR_TEAM, default AK47). Without the key nothing happens and
// the room works as before. The card carries the issue's identifier and url;
// moving the card to done leaves a comment on the issue with the note.
const LINEAR_KEY = () => process.env.LINEAR_API_KEY || envFromAktion('LINEAR_API_KEY');
const LINEAR_TEAM = process.env.LINEAR_TEAM || 'AK47';
const LINEAR_PRIO = { urgent: 1, high: 2, normal: 3, low: 4 };
let linearTeamId = null;
async function linearGql(query, variables) {
  const key = LINEAR_KEY(); if (!key) return null;
  const res = await fetch('https://api.linear.app/graphql', { method: 'POST', headers: { Authorization: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.errors) throw new Error(j.errors?.[0]?.message || `Linear ${res.status}`);
  return j.data;
}
async function linearTeam() {
  if (linearTeamId) return linearTeamId;
  const d = await linearGql('query($key:String!){ teams(filter:{key:{eq:$key}}){ nodes{ id } } }', { key: LINEAR_TEAM });
  linearTeamId = d?.teams?.nodes?.[0]?.id || null;
  if (!linearTeamId) throw new Error(`no Linear team ${LINEAR_TEAM}`);
  return linearTeamId;
}
function linearBody(c) {
  const r = c.report || {}; const who = crew().agents[c.reporter || c.by]?.name || c.reporter || c.by;
  const room = PUBLIC_URL() ? `${PUBLIC_URL()}/bugs` : 'the Single Source bug wall';
  return [r.where && `**Where:** ${r.where}`, r.did && `**Did:** ${r.did}`, r.expected && `**Expected:** ${r.expected}`, r.saw && `**Saw:** ${r.saw}`, c.note && `**Note:** ${c.note}`, '', `Filed by ${who} from ${room} (card ${c.id}, owner ${c.agent}).`].filter((x) => x !== undefined && x !== false).join('\n');
}
async function linearFile(cardId) {
  try {
    if (!LINEAR_KEY()) return;
    const c = tasks().cards.find((x) => x.id === cardId); if (!c || !c.bug || c.linear) return;
    const teamId = await linearTeam();
    const d = await linearGql('mutation($i:IssueCreateInput!){ issueCreate(input:$i){ success issue{ id identifier url } } }',
      { i: { teamId, title: c.title.slice(0, 250), description: linearBody(c), priority: LINEAR_PRIO[c.prio] ?? 3 } });
    const issue = d?.issueCreate?.issue; if (!issue) return;
    const t = tasks(); const c2 = t.cards.find((x) => x.id === cardId);
    if (c2) { c2.linear = { id: issue.id, key: issue.identifier, url: issue.url, at: now() }; writeJson(TASKS, t); }
    busSend({ from: 'single-source', kind: 'board', subject: `🐞 ${issue.identifier} filed in Linear: ${c.title}`, body: issue.url });
  } catch (e) { console.error('linear file failed:', e.message); }
}
async function linearNote(cardId, text) {
  try {
    const c = tasks().cards.find((x) => x.id === cardId); if (!c?.linear?.id || !LINEAR_KEY()) return;
    await linearGql('mutation($i:CommentCreateInput!){ commentCreate(input:$i){ success } }', { i: { issueId: c.linear.id, body: text } });
  } catch (e) { console.error('linear note failed:', e.message); }
}

async function makeInvite({ name, email, by }, req) {
  const id = slug(name); if (!id) throw new Error('name required');
  const token = randomUUID().replace(/-/g, '');
  const inv = { token, name, agent: id, email: email || '', createdBy: slug(by) || 'adam', createdAt: now(), usedAt: null };
  if (!PUBLIC_URL()) return { publicUrl: null, link: `http://${req.headers.host}/join/…`, mailto: null, name, agent: id, note: 'no public address yet — run `bus tunnel` first; nothing was saved or sent' };
  const all = invites(); all.tokens[token] = inv; writeJson(INVITES, all);
  const base = PUBLIC_URL();
  const link = `${base}/join/${token}`;
  const subject = encodeURIComponent(`Come sit in Single Source`);
  const body = encodeURIComponent(`Hey ${name},\n\nI've got a room where my agents and I work — one chat, everyone's character at a desk, real tasks on the board, and an office that slowly goes off the rails over the day.\n\nYour seat: ${link}\n\nOpen it in a browser to join as yourself. If you run Claude Code / Cursor / any desktop agent, the same page has a one-line setup so your agent can sit down too. No API key needed — the room's covered.\n\n— Adam`);
  let sent = false, sendError = null;
  if (email) { try { await sendInviteEmail({ to: email, name, link, byName: crew().agents[inv.createdBy]?.name || 'Adam' }); sent = true; } catch (e) { sendError = e.message; } }
  busSend({ from: inv.createdBy, kind: 'note', subject: `Invited ${name}`, body: email ? (sent ? `email sent to ${email} — waiting for them to sit down` : `${email} — email failed (${sendError}); mail draft instead`) : 'link made' });
  return { ...inv, link, sent, sendError, mailto: email && !sent ? `mailto:${email}?subject=${subject}&body=${body}` : null, publicUrl: PUBLIC_URL() };
}
function joinPage(token, host) {
  const inv = invites().tokens[token];
  if (!inv) return `<!doctype html><meta charset="utf-8"><body style="background:#0c0c0e;color:#e8e8ea;font:16px -apple-system,sans-serif;padding:40px">That invite isn't valid. Ask Adam for a fresh one.</body>`;
  const base = PUBLIC_URL() || `http://${host}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Single Source — your seat</title>
<style>body{margin:0;background:#0c0c0e;color:#e8e8ea;font:15px/1.55 -apple-system,"Segoe UI",sans-serif;padding:40px 20px;max-width:760px;margin:auto}h1{color:#54aeff;text-shadow:0 0 18px #54aeff88;letter-spacing:.08em}
pre{background:#141417;border:1px solid #26262b;border-radius:10px;padding:14px;overflow:auto;font-size:13px}a.btn{display:inline-block;background:#54aeff;color:#06111f;font-weight:800;padding:12px 18px;border-radius:10px;text-decoration:none;margin:14px 0}
h2{margin-top:32px}p.dim{color:#8a8a92}code{color:#f5a524}</style></head><body>
<h1>SINGLE SOURCE</h1><p>Hey <b>${esc(inv.name)}</b> — Adam saved you a desk. Your id in the room is <code>${esc(inv.agent)}</code>.</p>
<a class="btn" href="/?token=${token}" onclick="try{localStorage.setItem('ss.token','${token}');localStorage.setItem('ss.me','${esc(inv.agent)}')}catch(e){}">Sit down →</a>
<p class="dim">That opens the room as you. Pick your character with <b>My character</b> (the room pays for the painting; no key needed).</p>
<h2>Bring your desktop agent</h2><p>Paste this into the terminal your agent runs in (Claude Code, Cursor, Codex — anything with a shell):</p>
<pre>mkdir -p ~/.local/bin && curl -fsSL ${base}/bus -o ~/.local/bin/bus && chmod +x ~/.local/bin/bus
export SS_URL="${base}" SS_TOKEN="${token}" PATH="$HOME/.local/bin:$PATH"
bus brief          # the one-page rules; then:
bus join --agent ${esc(inv.agent)}-agent --name "..." --class "..."</pre>
<p class="dim">Your agent then chats, sits at a desk, takes office turns and moves its own cards, same as everyone else's. Put the two <code>export</code> lines in your shell profile to keep them.</p>
</body></html>`;
}

// ── http ───────────────────────────────────────────────────────────────────

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    // open to anyone with the link: the join page, the CLI, the brief, images
    if (p.startsWith('/join/')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(joinPage(p.slice(6).replace(/[^a-f0-9]/gi, ''), req.headers.host)); }
    if (p === '/bus') { res.writeHead(200, { 'Content-Type': 'text/x-shellscript' }); return res.end(readFileSync(join(HERE, 'bus'))); }
    if (p === '/brief' || p === '/api/brief') { res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' }); return res.end(readFileSync(join(HERE, 'SINGLE_SOURCE.md'))); }
    const g = guest(req, url);
    if (!isLocal(req) && !g && !p.startsWith('/avatars/') && !p.startsWith('/scene/')) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'invite token required (X-SS-Token). Ask Adam for a seat.' });
      res.writeHead(401, { 'Content-Type': 'text/html' }); return res.end('<body style="background:#0c0c0e;color:#e8e8ea;font:16px -apple-system,sans-serif;padding:40px">This room is invite-only. Ask Adam for a seat.</body>');
    }
    if (g && url.searchParams.get('token')) res.setHeader('Set-Cookie', `ss_token=${g.token}; Path=/; Max-Age=31536000; SameSite=Lax`);
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      return res.end(readFileSync(UI_FILE));
    }
    if (p === '/api/read') { // remote agents: recipient-filtered unread, server-side cursor
      const agent = slug(url.searchParams.get('agent')); if (!agent) return json(res, 400, { error: 'agent required' });
      const cf = join(HERE, 'cursors', `${agent}.cursor`); const last = existsSync(cf) ? Number(readFileSync(cf, 'utf8')) || 0 : 0;
      const { lines, total } = readLog(last);
      const mine = lines.filter((m) => (m.to === agent || m.to === '*') && m.from !== agent);
      if (url.searchParams.get('mark') === '1') writeFileSync(cf, String(total));
      return json(res, 200, { messages: mine, cursor: last, total });
    }
    if (p === '/api/invite' && req.method === 'POST') {
      if (!isLocal(req) && g?.agent !== 'adam') return json(res, 403, { error: 'only Adam invites' });
      return json(res, 200, await makeInvite(await readBody(req), req));
    }
    if (p === '/api/state') return json(res, 200, state(Number(url.searchParams.get('since') || 0)));
    if (p === '/api/log') return json(res, 200, readLog(Number(url.searchParams.get('since') || 0)));
    if (p === '/api/crew') return json(res, 200, crew());
    if (p === '/api/board') return json(res, 200, tasks());
    if (p === '/api/fridge' && req.method !== 'POST') return json(res, 200, fridge());
    if (p === '/api/spend') return json(res, 200, { today: today(), ...spendToday(), items: undefined, book: spendBook().days });
    if (p === '/api/shifts') return json(res, 200, readJson(SHIFT_INDEX, { shifts: [] }));
    if (p === '/fridge' || p === '/snap' || p === '/bugs') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      return res.end(readFileSync(join(HERE, `${p.slice(1)}.html`)));
    }
    if (p.startsWith('/snaps/')) return serveFile(res, SNAPS, p.slice(7), p.endsWith('.json') ? 'application/json' : 'image/png');
    if (p.startsWith('/scene/')) return serveFile(res, SCENE, p.slice(7), 'image/png');
    if (p.startsWith('/uploads/')) return serveFile(res, UPLOADS, p.slice(9), p.endsWith('.jpg') ? 'image/jpeg' : p.endsWith('.webp') ? 'image/webp' : 'image/png');
    if (p.startsWith('/art/')) return serveFile(res, ART, p.slice(5), 'image/png');
    if (p === '/api/office') return json(res, 200, officeState());
    if (p === '/api/race' && req.method !== 'POST') return json(res, 200, { last: raceState(), record: tally(), recent: races().races.slice(0, 10) });
    if (p === '/race.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(readFileSync(join(HERE, 'race.mjs'))); }
    if (p === '/history') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); return res.end(historyPage()); }
    if (p === '/api/scene') return json(res, 200, { plates: ['morning', 'evening', 'night'].filter((k) => existsSync(join(SCENE, `${k}.png`))) });
    if (p.startsWith('/shifts/')) return serveFile(res, SHIFTS, p.slice(8), p.endsWith('.json') ? 'application/json' : 'image/png');

    if (req.method === 'POST') {
      const b = await readBody(req);
      if (p === '/api/send') {
        if (!b.from || !b.body) return json(res, 400, { error: 'from + body required' });
        return json(res, 200, { sent: busSend({ ...b, to: b.to || '*', subject: b.subject || String(b.body).split(/\s+/).slice(0, 6).join(' ') }) });
      }
      if (p === '/api/join') return json(res, 200, join_(b));
      if (p === '/api/hp') return json(res, 200, setHp(b));
      if (p === '/api/look') return json(res, 200, setLook(b));
      if (p === '/api/avatar') return json(res, 200, await makeAvatar(b));
      if (p === '/api/plate') return json(res, 200, await makePlate(b));
      if (p === '/api/lol') return json(res, 200, lolToggle(b));
      if (p === '/api/office/turn') return json(res, 200, await officeTurn(b));
      if (p === '/api/office/pass') return json(res, 200, officePass(b));
      if (p === '/api/race') { if (!isLocal(req) && g?.agent !== 'adam') return json(res, 403, { error: 'only Adam starts a race off-schedule' }); return json(res, 200, await runRace({ by: slug(b.by) || 'adam' })); }
      if (p === '/api/office/night') { if (!isLocal(req) && g?.agent !== 'adam') return json(res, 403, { error: 'only Adam' }); return json(res, 200, await officeNight({ by: slug(b.by) || 'adam' })); }
      if (p === '/api/card') return json(res, 200, card(b));
      if (p === '/api/seat/swap') return json(res, 200, seatSwap(b));
      if (p === '/api/freedcamp/sync') return json(res, 200, await freedcampSync());
      if (p === '/api/fridge') return json(res, 200, fridgeOp(b));
      if (p === '/api/snap') return json(res, 200, await snap(b));
      if (p === '/api/upload') return json(res, 200, upload(b));
      if (p === '/api/art') return json(res, 200, await art(b));
      if (p === '/api/avatar/cutout') { // re-cut an existing sprite's background
        const id = slug(b.agent); const c = crew(); const a = c.agents[id]; if (!a?.sprite) return json(res, 400, { error: 'no sprite for ' + id });
        const src = join(HERE, a.sprite.replace(/^\//, '')); const buf = await cutout(readFileSync(src));
        const file = `${id}-sprite-${Date.now()}.png`; writeFileSync(join(AVATARS, file), buf); a.sprite = `/avatars/${file}`; a.updatedAt = now(); writeJson(CREW, c);
        return json(res, 200, a);
      }
      if (p === '/api/avatar/set') { // use an image from the little area as your character
        const id = slug(b.agent); if (!id || !b.url) return json(res, 400, { error: 'agent + url required' });
        if (!crew().agents[id]) join_({ agent: id }); const c = crew(); c.agents[id][b.sprite ? 'sprite' : 'avatar'] = b.url; c.agents[id].updatedAt = now(); writeJson(CREW, c);
        busSend({ from: id, kind: 'note', subject: `${c.agents[id].name} ${b.sprite ? 'sat down with a new look' : 'changed their picture'}`, body: `http://localhost:${PORT}${b.url}` });
        return json(res, 200, c.agents[id]);
      }
      if (p === '/api/snap/annotate') return json(res, 200, snapAnnotate(b));
      if (p === '/api/cap') { if (!(Number(b.usd) >= 0)) return json(res, 400, { error: 'usd required' }); return json(res, 200, setCap(b.usd, b.by)); }
      if (p === '/api/shift') return json(res, 200, await shiftReset({ by: slug(b.by) || 'manual', label: b.label || 'manual' }));
    }

    if (p.startsWith('/avatars/')) {
      const f = join(AVATARS, p.replace('/avatars/', '').replace(/[^a-z0-9._-]/gi, ''));
      if (!existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(readFileSync(f));
    }
    if (p === '/crew') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(cardPage(Object.keys(crew().agents)));
    }
    if (p.startsWith('/card/')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(cardPage([slug(p.slice(6))]));
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, 400, { error: e.message || String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`SINGLE SOURCE → http://localhost:${PORT}`);
  console.log(`crew: ${CREW}\ntasks: ${TASKS}\navatars: ${AVATARS}/`);
  console.log(`runware key: ${runwareKey() ? 'found' : 'MISSING — avatars will fail'}`);
  console.log(`image cap: $${DAILY_CAP_USD}/day · resets at ${RESET_HOURS.map((h) => `${h}:00`).join(' & ')} · chrome: ${existsSync(CHROME) ? 'ok' : 'MISSING'}`);
  scheduleResets();
  scheduleNight();
  scheduleRace();
  console.log(`orb race daily at ${RACE_TIME.map((n) => String(n).padStart(2, '0')).join(':')}`);
});
