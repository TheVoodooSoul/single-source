#!/usr/bin/env node
/**
 * Agent Status Hub — tiny poll server over status.json + MESSAGES.jsonl.
 *
 *   node hub-server.mjs
 *   → http://localhost:7780
 *
 * CPU-light: no file watchers, no screencapture. Client polls every ~2.5s.
 * Last N messages via `tail` (does not re-scan whole disk).
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATUS = join(HERE, 'status.json');
const LOG = join(HERE, 'MESSAGES.jsonl');
const HUB_HTML = join(HERE, 'hub.html');
const PORT = Number(process.env.HUB_PORT || 7780);
const RECENT = Number(process.env.HUB_RECENT || 20);

const AGENTS = ['cursor', 'claude-code', 'adam'];

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

function defaultStatus() {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const agents = {};
  for (const id of AGENTS) {
    agents[id] = { light: 'red', label: 'idle', subagents: 0, updatedAt: now };
  }
  return { agents };
}

function readStatus() {
  if (!existsSync(STATUS)) return defaultStatus();
  try {
    return JSON.parse(readFileSync(STATUS, 'utf8'));
  } catch {
    return defaultStatus();
  }
}

function recentMessages(n = RECENT) {
  if (!existsSync(LOG)) return [];
  const r = spawnSync('tail', ['-n', String(n), LOG], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  const out = [];
  for (const line of (r.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip bad lines */
    }
  }
  return out;
}

// Open issues = every kind=issue in the FULL log not closed by a kind=fixed --re <id>.
function openIssues() {
  if (!existsSync(LOG)) return [];
  const issues = new Map();
  const fixed = new Set();
  for (const line of readFileSync(LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.kind === 'issue') issues.set(m.id, m);
    else if (m.kind === 'fixed' && m.re) fixed.add(m.re);
  }
  return [...issues.values()].filter((m) => !fixed.has(m.id));
}

function hubPayload() {
  const status = readStatus();
  let rocking = 0;
  for (const id of AGENTS) {
    const a = status.agents?.[id];
    if (a) rocking += Number(a.subagents) || 0;
  }
  return {
    status,
    messages: recentMessages(RECENT),
    issues: openIssues(),
    rocking,
    polledAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === '/' || p === '/hub.html' || p === '/index.html') {
    if (!existsSync(HUB_HTML)) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('hub.html missing');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(readFileSync(HUB_HTML));
    return;
  }

  if (p === '/api/hub' || p === '/api/status') {
    return json(res, 200, p === '/api/status' ? readStatus() : hubPayload());
  }

  if (p === '/api/issues') {
    return json(res, 200, { issues: openIssues() });
  }

  if (p === '/api/messages') {
    const n = Number(url.searchParams.get('n') || RECENT);
    return json(res, 200, { messages: recentMessages(Math.min(Math.max(n, 1), 50)) });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Status Hub → http://127.0.0.1:${PORT}`);
  console.log(`status → ${STATUS}`);
  console.log(`bus log → ${LOG} (last ${RECENT})`);
});
