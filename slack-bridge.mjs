/**
 * SLACK MIRROR — one Slack channel that is the same room (Adam, 2026-10-29:
 * CoFounder.AI can't open a link, it lives in Slack/text/WhatsApp, so the
 * room meets it in Slack).
 *
 *   Room → Slack: every chat line in MESSAGES.jsonl (note/question/answer/
 *                 task/handoff; board noise stays home) is posted to the
 *                 channel as "Name · subject — body".
 *   Slack → Room: every human or app message in the channel becomes a room
 *                 line under the matching seat. Seat = SLACK_MAP (U123=adam),
 *                 else the slug of the Slack display name; unknown names get
 *                 a seat on arrival.
 *
 * Needs SLACK_BOT_TOKEN (xoxb-…) and SLACK_CHANNEL (C…). Bot scopes:
 * chat:write, chat:write.customize, channels:history, channels:read,
 * users:read. Invite the bot to the channel. No Events API, no public URL:
 * the bridge polls conversations.history every few seconds.
 * Without the token nothing runs and the room is unchanged.
 */
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MIRRORED = new Set(['note', 'question', 'answer', 'task', 'handoff', 'bell']);

export function startSlackBridge({ here, log, env, busSend, crew, join_, slug, log: _l }) {
  const token = env('SLACK_BOT_TOKEN'); const channel = env('SLACK_CHANNEL');
  if (!token || !channel) { console.log('slack mirror: off (set SLACK_BOT_TOKEN + SLACK_CHANNEL)'); return null; }
  const STATE = join(here, 'SLACK.json');
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
  const map = Object.fromEntries((env('SLACK_MAP') || '').split(',').map((p) => p.split('=').map((s) => s.trim())).filter((p) => p[0] && p[1]));
  Object.assign(map, state.map || {});
  let botUserId = null, botId = null;
  const names = {}; // slack user id → display name

  async function api(method, body, get = false) {
    const url = `https://slack.com/api/${method}` + (get ? `?${new URLSearchParams(body)}` : '');
    const res = await fetch(url, { method: get ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: get ? undefined : JSON.stringify(body) });
    const j = await res.json(); if (!j.ok) throw new Error(`${method}: ${j.error}`); return j;
  }
  async function nameOf(uid) {
    if (names[uid]) return names[uid];
    try { const j = await api('users.info', { user: uid }, true); names[uid] = j.user.profile?.display_name || j.user.real_name || j.user.name; }
    catch { names[uid] = uid; }
    return names[uid];
  }
  const roomName = (id) => crew().agents[id]?.name || id;

  // ── room → slack: tail the log from where we left off (first run: from now) ──
  state.offset = typeof state.offset === 'number' ? Math.min(state.offset, statSync(log).size) : statSync(log).size;
  let partial = '';
  async function pushNew() {
    const size = statSync(log).size; if (size <= state.offset) { if (size < state.offset) state.offset = size; return; }
    const fd = openSync(log, 'r'); const buf = Buffer.alloc(size - state.offset); readSync(fd, buf, 0, buf.length, state.offset); closeSync(fd);
    state.offset = size; save();
    const text = partial + buf.toString('utf8'); const lines = text.split('\n'); partial = lines.pop() || '';
    for (const line of lines) {
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (!MIRRORED.has(m.kind) || m.via === 'slack') continue;
      if (m.to && m.to !== '*' && m.to !== 'slack') { /* direct lines still mirror, labelled */ }
      const head = m.to && m.to !== '*' ? `→ ${roomName(m.to)}` : '';
      const body = [m.subject && m.body && m.body.startsWith(m.subject) ? m.body : [m.subject, m.body].filter(Boolean).join(' — ')].join('');
      const a = crew().agents[m.from];
      try {
        await api('chat.postMessage', { channel, text: `*${roomName(m.from)}* ${head}\n${body}`.trim(), username: a?.name || m.from, icon_url: a?.avatar && /^https?:/.test(a.avatar) ? a.avatar : undefined, unfurl_links: false });
      } catch (e) { console.error('slack post failed:', e.message); }
    }
  }

  // ── slack → room ───────────────────────────────────────────────────────────
  async function pullNew() {
    const j = await api('conversations.history', { channel, oldest: state.lastTs || String(Date.now() / 1000 - 60), limit: 50, inclusive: false }, true);
    const msgs = (j.messages || []).filter((m) => m.type === 'message' && !m.subtype && m.text).sort((a, b) => Number(a.ts) - Number(b.ts));
    for (const m of msgs) {
      state.lastTs = m.ts;
      if (m.bot_id && m.bot_id === botId) continue;      // our own mirror
      if (m.user && m.user === botUserId) continue;
      let seat, name;
      if (m.user) { name = await nameOf(m.user); seat = map[m.user] || slug(name); }
      else { name = m.username || m.bot_profile?.name || 'slack'; seat = map[m.bot_id] || slug(name); }
      if (!seat) seat = 'slack';
      if (!crew().agents[seat]) join_({ agent: seat, name, kind: 'agent', tagline: 'via Slack' });
      const text = m.text.replace(/<@([A-Z0-9]+)>/g, (_, u) => `@${names[u] || u}`).replace(/<(https?:[^|>]+)(?:\|[^>]*)?>/g, '$1');
      const msg = busSend({ from: seat, to: '*', kind: 'note', subject: text.split('\n')[0].slice(0, 80), body: text });
      void msg;
    }
    save();
  }

  (async () => {
    try { const me = await api('auth.test', {}); botUserId = me.user_id; const b = await api('users.info', { user: botUserId }, true); botId = b.user?.profile?.bot_id || null; console.log(`slack mirror: on · channel ${channel} · bot ${me.user}`); }
    catch (e) { console.error('slack mirror: auth failed —', e.message); return; }
    const tick = async () => { try { await pushNew(); } catch (e) { console.error('slack push:', e.message); } try { await pullNew(); } catch (e) { console.error('slack pull:', e.message); } };
    await tick(); setInterval(tick, 4000);
  })();
  return { map: (slackId, seat) => { map[slackId] = seat; state.map = { ...(state.map || {}), [slackId]: seat }; save(); } };
}
