/**
 * THE 2:30 ORB RACE — shared simulation. Runs on the server (to pick the
 * winner and post it) and in the browser (to draw it). Same seed → same race,
 * so everyone in the room sees the exact same thing.
 *
 * Four orbs, one big oval, two laps. Random winner — but the orbs have
 * personalities, and each day they roll a mood on top of it.
 */

export const ORBS = [
  { id: 'red',   name: 'Rusty',  color: '#ff4d4d', glow: '#ff9a9a', trait: 'hot-headed — runs angry, sometimes trips on it' },
  { id: 'blue',  name: 'Bluey',  color: '#4da3ff', glow: '#9ccbff', trait: 'moody — brilliant when it feels like it, which is not always' },
  { id: 'green', name: 'Moss',   color: '#4ddc7a', glow: '#a8f0bf', trait: 'steady — never fast, never slow, never gone' },
  { id: 'gold',  name: 'Goldie', color: '#ffcc33', glow: '#ffe89a', trait: 'a show-off — huge starts, big finishes, naps in between' },
];

export const MOODS = {
  crazy:     { label: 'CRAZY COMPETITIVE', line: (n) => `${n} is vibrating at the gate. This is personal.` },
  wontrun:   { label: 'not feeling it',    line: (n) => `${n} has decided today is not a running day.` },
  steady:    { label: 'locked in',         line: (n) => `${n} is locked in. Nothing to report. That is the report.` },
  distracted:{ label: 'distracted',        line: (n) => `${n} keeps looking at the snack table.` },
  late:      { label: 'showed up late',    line: (n) => `${n} is still putting its shoes on.` },
};

export function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Roll today's moods. Each orb gets one; the field always has at least one runner. */
export function rollMoods(seed) {
  const r = rng(seed ^ 0x9e3779b9);
  const keys = Object.keys(MOODS);
  const moods = ORBS.map((o) => {
    const x = r();
    // personality skews the roll
    if (o.id === 'red')   return x < .45 ? 'crazy' : x < .6 ? 'distracted' : 'steady';
    if (o.id === 'blue')  return x < .3 ? 'wontrun' : x < .55 ? 'crazy' : x < .7 ? 'late' : 'steady';
    if (o.id === 'green') return x < .8 ? 'steady' : 'distracted';
    return x < .35 ? 'crazy' : x < .55 ? 'late' : x < .7 ? 'distracted' : 'steady'; // gold
  });
  if (moods.every((m) => m === 'wontrun')) moods[2] = 'steady';
  return moods;
}

const LAPS = 2;
export const TICK = 1 / 30;

/** Simulate the whole race. Returns { ticks: [[p0,p1,p2,p3],...], events, winner, order, duration } */
export function simulate(seed) {
  const r = rng(seed);
  const moods = rollMoods(seed);
  const orbs = ORBS.map((o, i) => ({ ...o, mood: moods[i], p: 0, v: 0, stalled: 0, burst: 0, done: null, jitter: r() * 1000 }));
  const events = [];
  const ticks = [];
  let t = 0;
  const say = (msg) => events.push({ t: +t.toFixed(2), msg });
  for (const o of orbs) say(MOODS[o.mood].line(o.name));
  // start behaviour
  for (const o of orbs) {
    if (o.mood === 'wontrun') o.stalled = 8 + r() * 30;      // may or may not ever go
    if (o.mood === 'late') o.stalled = 3 + r() * 5;
  }
  say('🏁 AND THEY\'RE OFF' );
  let finished = 0;
  while (finished < orbs.length && t < 120) {
    for (const o of orbs) {
      if (o.done !== null) continue;
      if (o.stalled > 0) { o.stalled -= TICK; o.v = 0; if (o.stalled <= 0) say(`${o.name} finally goes!`); continue; }
      let base = 0.085; // laps per second → ~24s a lap
      if (o.mood === 'crazy') base *= 1.09;
      if (o.mood === 'steady') base *= 1.0 + (o.jitter % 7) / 100;
      if (o.mood === 'distracted') base *= 0.92;
      if (o.mood === 'wontrun') base *= 0.85;
      // bursts and wobbles
      if (o.burst > 0) { o.burst -= TICK; base *= 1.6; }
      else if (o.mood === 'crazy' && r() < 0.012) { o.burst = 0.6 + r(); say(`${o.name} SURGES`); }
      else if (o.mood === 'gold' || o.id === 'gold') { if (r() < 0.006) { o.burst = 0.8; say(`${o.name} turns it on for the crowd`); } }
      // stumbles / distractions
      if (o.mood === 'crazy' && r() < 0.009) { o.stalled = 0.8 + r() * 1.6; say(`${o.name} overcooks the corner!`); continue; }
      if (o.mood === 'distracted' && r() < 0.006) { o.stalled = 1 + r() * 2.5; say(`${o.name} stops to look at something`); continue; }
      if (o.mood === 'wontrun' && r() < 0.005) { o.stalled = 2 + r() * 6; say(`${o.name} sits down mid-track`); continue; }
      if (o.id === 'gold' && o.p > 0.6 && o.p < 1.4 && r() < 0.004) { o.stalled = 1.5 + r() * 2; say(`${o.name} is taking a nap on the back straight`); continue; }
      const noise = (r() - 0.5) * 0.05;
      o.v = Math.max(0, base + noise);
      o.p += o.v * TICK;
      if (o.p >= LAPS) { o.p = LAPS; o.done = t; finished++; say(finished === 1 ? `🏆 ${o.name.toUpperCase()} TAKES IT!` : `${o.name} home in P${finished}`); }
    }
    ticks.push(orbs.map((o) => +o.p.toFixed(4)));
    t += TICK;
    if (finished >= 1 && t - Math.min(...orbs.filter((o) => o.done !== null).map((o) => o.done)) > 12) break; // stop 12s after the winner
  }
  const order = [...orbs].sort((a, b) => (a.done ?? 999) - (b.done ?? 999) || b.p - a.p);
  const dnf = orbs.filter((o) => o.done === null);
  for (const o of dnf) say(o.p < 0.05 ? `${o.name} never left the gate.` : o.p < 1 ? `${o.name} gave up.` : `${o.name} is still out there.`);
  return { seed, moods, orbs: orbs.map(({ id, name, color, glow, mood, done, p }) => ({ id, name, color, glow, mood, done, p })), ticks, events, winner: order[0].id, order: order.map((o) => o.id), duration: +t.toFixed(2) };
}

/** x,y on an oval track for progress p (laps, fractional). Start line on the bottom straight, run clockwise. */
export function trackPoint(p, W, H, lane = 0) {
  const u = ((p % 1) + 1) % 1;
  const cx = W / 2, cy = H / 2, rx = W * 0.40 - lane * 14, ry = H * 0.34 - lane * 14;
  const a = Math.PI / 2 + u * Math.PI * 2; // start at bottom, clockwise
  return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
}

if (typeof window !== 'undefined') window.OrbRace = { ORBS, MOODS, simulate, trackPoint, TICK, rollMoods };
