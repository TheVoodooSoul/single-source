// Single Source → Freedcamp, one way.
//
// Single Source is the source of truth: a card is added, moved or edited in the
// room, and the same task is created or updated in Freedcamp. Nothing is read
// back. If Freedcamp is unreachable the card still saves — the push is retried
// the next time that card changes, or with `bus freedcamp sync`.
//
// Turned on by a file only Adam writes: ~/agent-bus/.freedcamp.json
//   { "api_key": "…", "api_secret": "…", "project_id": "3777905" }
// (api_secret only for a secured key.) Nothing here prints the key or secret.
//
// API (freedcamp.com "Freedcamp Public API" wiki): https://freedcamp.com/api/v1/
//   auth   api_key, or api_key + timestamp + hash = HMAC-SHA1(api_key + timestamp, api_secret)
//   tasks  POST /tasks  { title, description, project_id, priority, status }
//   status   0 not started · 1 completed · 2 in progress
//   priority 0 none · 1 low · 2 medium · 3 high

import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, '.freedcamp.json');
const BASE = 'https://freedcamp.com/api/v1';

export function fcConfig() {
  if (!existsSync(FILE)) return null;
  try {
    const c = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!c || typeof c.api_key !== 'string' || !c.api_key.trim() || !c.project_id) return null;
    return { key: c.api_key.trim(), secret: typeof c.api_secret === 'string' ? c.api_secret.trim() : '', project: String(c.project_id) };
  } catch { return null; }
}
export const fcConfigured = () => !!fcConfig();

function auth(c) {
  const q = new URLSearchParams({ api_key: c.key });
  if (c.secret) {
    const ts = String(Math.floor(Date.now() / 1000));
    q.set('timestamp', ts);
    q.set('hash', createHmac('sha1', c.secret).update(c.key + ts).digest('hex'));
  }
  return q.toString();
}

async function call(c, method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(`${BASE}${path}?${auth(c)}`, {
      method, signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.http_code >= 400) throw new Error(data?.msg || data?.message || `Freedcamp ${res.status}`);
    return data?.data ?? data;
  } finally { clearTimeout(timer); }
}

const STATUS = { todo: 0, doing: 2, review: 2, done: 1 };
const PRIORITY = { urgent: 3, high: 3, normal: 2, low: 1 };
const STAGE = { todo: 'To do', doing: 'In progress', review: 'In review', done: 'Done' };

function taskBody(c, card, ownerName) {
  const prio = card.prio || 'normal';
  const lines = [
    `Owner: ${ownerName || card.agent}`,
    `Stage: ${STAGE[card.col] || card.col}`,
    `Priority: ${prio[0].toUpperCase()}${prio.slice(1)}`,
    card.note ? `Note: ${card.note}` : '',
    `From Single Source · ${card.id}`,
  ].filter(Boolean);
  return {
    title: `${prio === 'urgent' ? '[URGENT] ' : ''}${card.title}`.slice(0, 250),
    description: lines.join('\n'),
    project_id: c.project,
    priority: PRIORITY[prio] ?? 2,
    status: STATUS[card.col] ?? 0,
  };
}

/** Who the key belongs to — the cheapest call that proves the key works. */
export async function fcCheck() {
  const c = fcConfig();
  if (!c) return { on: false, reason: 'no ~/agent-bus/.freedcamp.json' };
  try {
    const s = await call(c, 'GET', '/sessions/current');
    return { on: true, project: c.project, secured: !!c.secret, user: s?.user_id ?? s?.users?.[0]?.id ?? null };
  } catch (e) { return { on: false, reason: e.message }; }
}

/** Create the task, or update the one this card already has. Returns the Freedcamp task id. */
export async function fcPush(card, ownerName) {
  const c = fcConfig();
  if (!c) return null;
  const body = taskBody(c, card, ownerName);
  if (card.fc) {
    await call(c, 'POST', `/tasks/${encodeURIComponent(card.fc)}`, body);
    return card.fc;
  }
  const made = await call(c, 'POST', '/tasks', body);
  const task = made?.tasks?.[0] ?? made?.task ?? made;
  const id = task?.id ?? null;
  if (!id) throw new Error('Freedcamp accepted the task but returned no id');
  return String(id);
}

export async function fcRemove(card) {
  const c = fcConfig();
  if (!c || !card.fc) return;
  await call(c, 'DELETE', `/tasks/${encodeURIComponent(card.fc)}`);
}
