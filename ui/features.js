'use strict';
/* ReChest extras: daily goal and streaks, activity heatmap, records and badges, container types, match tags,
   a shareable summary card, sounds, and broadcast history. Loaded before app.js; nothing here runs until
   app.js renders, so it can use app.js helpers (D, S, $, esc, tipAttr, ...) freely. */

const FX = { goal: 25, sound: true, vol: 0.6, tags: {}, goalDay: '', sent: [] };
try { Object.assign(FX, JSON.parse(localStorage.getItem('rechest.fx') || '{}')); } catch { /* storage blocked */ }
const saveFx = () => { try { localStorage.setItem('rechest.fx', JSON.stringify(FX)); } catch { /* ignore */ } };

const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const keyTime = (k) => new Date(k + 'T12:00').getTime();
const hmin = (sec) => { const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
const fxStats = (items) => `<div class="istats">${items.map(([v, l]) => `<div><b>${v}</b><small>${l}</small></div>`).join('')}</div>`;

/** Per local day: your chests, matches, and time spent in matches (from the replays' durations). */
function dayStats() {
  const mine = new Map(), games = new Map(), play = new Map();
  for (const o of D.chests) if (o.by === D.me) mine.set(dayKey(o.at), (mine.get(dayKey(o.at)) || 0) + 1);
  for (const m of D.matches) {
    const k = dayKey(new Date(m.startUtc).getTime());
    games.set(k, (games.get(k) || 0) + 1);
    play.set(k, (play.get(k) || 0) + (m.duration || 0));
  }
  return { mine, games, play };
}
/** Days in a row that pass, counting back from today (today still in progress counts only once it passes). */
function streakTo(test) {
  const d = new Date(); d.setHours(12, 0, 0, 0);
  if (!test(dayKey(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (test(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function bestRun(keys) {
  let best = 0, cur = 0, prev = null;
  for (const k of [...keys].sort()) { const t = keyTime(k); cur = prev != null && Math.round((t - prev) / DAY_MS) === 1 ? cur + 1 : 1; prev = t; best = Math.max(best, cur); }
  return best;
}
const todayMine = (st) => (st.mine.get(dayKey(Date.now())) || 0) + (D.liveSince ? D.live.length : 0);

/* ---------- badges ---------- */
function records() {
  const st = dayStats();
  const per = D.matches.map((m) => { const c = chestsOf(m), mine = c.filter((o) => o.by === m.me); return { m, mine: mine.length, all: c.length, first: mine.length ? Math.min(...mine.map((o) => o.t)) : null }; });
  const bestM = per.reduce((a, x) => (!a || x.mine > a.mine ? x : a), null);
  const bestDay = [...st.mine.entries()].reduce((a, x) => (!a || x[1] > a[1] ? x : a), null);
  const firsts = per.filter((x) => x.first != null);
  const fastest = firsts.reduce((a, x) => (!a || x.first < a.first ? x : a), null);
  const total = D.chests.filter((o) => o.by === D.me).length;
  const playAll = [...st.play.values()].reduce((a, b) => a + b, 0);
  const goalDays = [...st.mine.keys()].filter((k) => st.mine.get(k) >= FX.goal);
  const bestGoal = bestRun(goalDays);
  const badges = [
    ['First chest', 'Open your first chest', total >= 1, 'common'],
    ['Looter', '20 of your chests in one match', bestM?.mine >= 20, 'uncommon'],
    ['Vault raider', '40 of your chests in one match', bestM?.mine >= 40, 'epic'],
    ['Century', '100 of your chests in one day', bestDay?.[1] >= 100, 'rare'],
    ['On fire', 'Hit your daily goal 3 days in a row', bestGoal >= 3, 'rare'],
    ['Week warrior', 'Hit your daily goal 7 days in a row', bestGoal >= 7, 'legendary'],
    ['Speedrunner', 'First chest within 30 seconds', fastest?.first <= 30, 'uncommon'],
    ['Winner’s loot', 'Win a match with 15+ of your chests', per.some((x) => x.m.placement === 1 && x.mine >= 15), 'legendary'],
    ['Squad carry', 'More chests than the rest of the squad combined (10+)', per.some((x) => x.mine >= 10 && x.mine > x.all - x.mine), 'epic'],
    ['Thousand', '1,000 chests in total', total >= 1000, 'mythic'],
  ];
  return { st, bestM, bestDay, fastest, total, playAll, bestGoal, badges };
}
const RARITY = { common: '#b5b5b5', uncommon: '#3ccf6e', rare: '#3b9cff', epic: '#b45cff', legendary: '#ff9a2e', mythic: '#ffd23f' };
const BADGE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 15.6 6.6 18.5l1.2-6L3.3 8.3l6.1-.7z"/></svg>';
const LOCK_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 10V8a5 5 0 0 1 10 0v2h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zm2 0h6V8a3 3 0 0 0-6 0z"/></svg>';
const FLAME = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c1 4 5 5.5 5 11a5 5 0 0 1-10 0c0-2.4 1-4 2.2-5.2.3 1.6 1 2.6 2 3C10.6 7.6 11 4.6 12 2z"/></svg>';

/** The last 7 days against the goal line. */
function weekBars(st, now) {
  const days = [...Array(7)].map((_, i) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 6 + i); return d; });
  const vals = days.map((d, i) => (i === 6 ? now : st.mine.get(dayKey(d)) || 0));
  const top = Math.max(FX.goal * 1.25, ...vals, 1);
  return `<div class="wk"><div class="wk-goal" style="bottom:calc(18px + (100% - 18px) * ${FX.goal / top})"><span>goal</span></div>${vals.map((v, i) => `<div class="wk-c" ${tipAttr(`<b>${DAYW.format(days[i])}</b><small>${v} of your chests${v >= FX.goal ? ' · goal hit' : ''}</small>`)}><i class="${v >= FX.goal ? 'hit' : ''}" style="height:${(v / top) * 100}%"></i><small>${new Intl.DateTimeFormat(window.I18N?.locale || 'en-US', { weekday: 'narrow' }).format(days[i])}</small></div>`).join('')}</div>`;
}

/* ---------- Overview row: goal · activity · records ---------- */
function featureRow() {
  const R = records(), st = R.st, today = dayKey(Date.now()), now = todayMine(st);
  const met = (k) => (k === today ? now : st.mine.get(k) || 0) >= FX.goal;
  const goalStreak = streakTo(met), playStreak = streakTo((k) => st.games.has(k));
  const C = 2 * Math.PI * 52, pct = Math.min(1, now / Math.max(1, FX.goal));
  const goal = `<section class="panel ins goalcard rise" style="--i:13">${panelHead('Daily goal', `${FX.goal} of your chests a day`, `<span class="goal-step"><button class="see" data-goal="-5" aria-label="Lower goal">−</button><button class="see" data-goal="5" aria-label="Raise goal">+</button></span>`)}
    <div class="goal-main"><div class="ring ${pct >= 1 ? 'done' : ''}"><svg viewBox="0 0 120 120"><circle class="rt" cx="60" cy="60" r="52"/><circle class="rf" cx="60" cy="60" r="52" style="stroke-dasharray:${C};stroke-dashoffset:${C * (1 - pct)}"/></svg>
      <div class="ring-v"><b>${now}</b><small>of ${FX.goal} today</small></div></div>
      <div class="goal-side"><div class="streak ${goalStreak ? 'hot' : ''}">${FLAME}<b>${goalStreak}</b><small>day${goalStreak === 1 ? '' : 's'} in a row<br>at your goal</small></div>
        <small class="muted">${pct >= 1 ? 'Goal reached today' : `${FX.goal - now} more to go today`}</small></div></div>
    ${weekBars(st, now)}
    ${fxStats([[hmin(st.play.get(today) || 0), 'in matches today'], [playStreak, `day${playStreak === 1 ? '' : 's'} played in a row`], [R.bestGoal, 'best goal streak']])}</section>`;

  // activity: the last 12 weeks, one cell per day
  const start = new Date(); start.setHours(12, 0, 0, 0); start.setDate(start.getDate() - 181 - ((start.getDay() + 6) % 7) + 6);
  const days = [...Array(182)].map((_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const maxDay = Math.max(1, ...days.map((d) => st.mine.get(dayKey(d)) || 0));
  const cells = days.map((d) => {
    const k = dayKey(d), v = st.mine.get(k) || 0, lv = v ? Math.min(4, Math.ceil((v / maxDay) * 4)) : 0, fut = d.getTime() > Date.now();
    return `<i class="hm l${lv} ${fut ? 'fut' : ''} ${k === today ? 'today' : ''}" ${fut ? '' : tipAttr(`<b>${DAYW.format(d)}</b><small>${v} of your chests · ${st.games.get(k) || 0} matches · ${hmin(st.play.get(k) || 0)} in matches</small>`)}></i>`;
  }).join('');
  const myOpens = D.opens.filter((o) => o.by === D.me);
  const types = Object.keys(TYPES).map((t) => [t, myOpens.filter((o) => o.type === t).length]).filter((x) => x[1]).sort((a, b) => b[1] - a[1]);
  const tmax = Math.max(1, ...types.map((x) => x[1]));
  const activity = `<section class="panel ins rise" style="--i:14">${panelHead('Activity', 'Your chests per day · last 26 weeks')}
    <div class="heat">${cells}</div>
    <div class="heat-key"><span>Less</span><i class="hm l0"></i><i class="hm l1"></i><i class="hm l2"></i><i class="hm l3"></i><i class="hm l4"></i><span>More</span></div>
    <div class="ctypes">${types.map(([t, n]) => `<div class="ct" ${tipAttr(`<b>${typeName(t)}</b><small>${n} by you${isChest(t) ? '' : ' · not counted as chests'}</small>`)}>${pic(t, 'xs')}<span class="nm">${typeName(t)}</span><span class="pbar"><i style="width:${(n / tmax) * 100}%;background:${TYPES[t].c}"></i></span><b>${n}</b></div>`).join('') || '<div class="empty">No containers yet</div>'}</div>
    ${fxStats([[hmin(R.playAll), 'in matches, all time'], [R.playAll ? n1(R.total / (R.playAll / 3600)) : '—', 'your chests per hour'], [D.matches.length ? hmin(R.playAll / D.matches.length) : '—', 'per match']])}</section>`;

  const rec = (label, value, sub, id) => `<${id ? `button class="rec" data-match="${esc(id)}"` : 'div class="rec"'}><small>${label}</small><b>${value}</b><em>${sub}</em></${id ? 'button' : 'div'}>`;
  const got = R.badges.filter((b) => b[2]).length;
  const recs = `<section class="panel ins rise" style="--i:15">${panelHead('Records', `${got} of ${R.badges.length} badges unlocked`, '<button class="btn sm" data-act="share">Share</button>')}
    <div class="recs">${rec('Best match', R.bestM ? R.bestM.mine : '—', R.bestM ? when(R.bestM.m) : 'no matches yet', R.bestM?.m.id)}
      ${rec('Best day', R.bestDay ? R.bestDay[1] : '—', R.bestDay ? DAYW.format(new Date(keyTime(R.bestDay[0]))) : '—')}
      ${rec('Fastest first chest', R.fastest ? mmss(R.fastest.first) : '—', R.fastest ? when(R.fastest.m) : '—', R.fastest?.m.id)}</div>
    <div class="badges">${R.badges.map(([name, desc, ok, rar]) => `<span class="badge ${ok ? 'ok' : ''}" style="--c:${RARITY[rar]}" ${tipAttr(`<b>${name}</b><small>${desc}${ok ? ' · unlocked' : ' · locked'}</small>`)}>${ok ? BADGE_ICON : LOCK_ICON}<em>${name}</em></span>`).join('')}</div></section>`;
  return `<div class="grid3 fxrow">${goal}${activity}${recs}</div>`;
}

/* ---------- match tags ---------- */
const TAG_PRESETS = ['Hot drop', 'Good loot', 'Bad luck', 'Practice', 'Clutch', 'Ranked'];
const tagsOf = (m) => FX.tags[m.id] || [];
function tagRow(m) {
  const mine = tagsOf(m), all = [...new Set([...TAG_PRESETS, ...mine])];
  return `<div class="tagrow">${all.map((t) => `<button class="tag ${mine.includes(t) ? 'on' : ''}" data-tag="${esc(t)}" data-tagm="${esc(m.id)}">${esc(t)}</button>`).join('')}<input class="tag-add" data-tagm="${esc(m.id)}" maxlength="20" placeholder="+ Tag" aria-label="Add a tag"></div>`;
}
const tagMini = (m) => (tagsOf(m).length ? `<span class="mi-tags">${tagsOf(m).map((t) => `<i>${esc(t)}</i>`).join('')}</span>` : '');
function tagFilter() {
  const used = [...new Set(Object.values(FX.tags).flat())].sort();
  if (!used.length) return '';
  return `<div class="range tagf">${[['*', 'All tags'], ...used.map((t) => [t, t])].map(([k, t]) => `<button class="${(S.mtag || '*') === k ? 'on' : ''}" data-mtag="${esc(k)}">${esc(t)}</button>`).join('')}</div>`;
}
function setTag(id, tag, on) {
  const list = new Set(FX.tags[id] || []);
  on ? list.add(tag) : list.delete(tag);
  if (list.size) FX.tags[id] = [...list]; else delete FX.tags[id];
  saveFx();
}

/* ---------- sounds (synthesized, no files) ---------- */
let fxAc;
function chime(kind) {
  if (!FX.sound) return;
  try {
    fxAc ||= new AudioContext();
    if (fxAc.state === 'suspended') fxAc.resume();
    const t0 = fxAc.currentTime + 0.02, notes = { match: [659, 880], goal: [523, 659, 784, 1047], tick: [1320] }[kind] || [880];
    notes.forEach((f, i) => {
      const o = fxAc.createOscillator(), g = fxAc.createGain(), t = t0 + i * 0.09;
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18 * FX.vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'tick' ? 0.12 : 0.6));
      o.connect(g); g.connect(fxAc.destination); o.start(t); o.stop(t + 0.7);
    });
  } catch { /* audio unavailable */ }
}
/** After new data: sound for new matches / live chests, and the once-a-day "goal reached" moment. */
let recordToasted = null; // liveSince of the match whose new record was already announced
function fxAfterData(first, newMatches, liveAdded) {
  // the overlay speaks the UI language: keep the saved setting in step with it
  if (first && D.settings && (D.settings.lang || 'en') !== I18N.lang) { D.settings.lang = I18N.lang; send({ type: 'settings', settings: D.settings }); }
  // live new record (hotkey count): toast + chime once per match; the overlay shows it in game
  if (D.liveSince && recordToasted !== D.liveSince) {
    const best = Math.max(0, ...D.matches.map((m) => chestsOf(m).filter((o) => o.by === m.me).length));
    if (best && D.live.length > best) { recordToasted = D.liveSince; if (!first) { chime('goal'); toast('New record!', `${D.live.length} chests this match · your best was ${best}`); } }
  }
  if (!first && newMatches) chime('match');
  else if (!first && liveAdded) chime('tick');
  const today = dayKey(Date.now()), n = todayMine(dayStats());
  if (n >= FX.goal && FX.goalDay !== today) {
    FX.goalDay = today; saveFx();
    if (!first) { chime('goal'); toast('Daily goal reached!', `${n} of your chests today · keep the streak going`); }
  }
}

/* ---------- share card: accent colour, background style and your character, all adjustable ---------- */
const SHARE_DEF = { color: '#ffc83d', style: 'burst', char: true };
const shareOpts = () => ({ ...SHARE_DEF, ...(FX.share || {}) });
const hexRgb = (h) => { const n = parseInt(String(h).replace('#', '').padEnd(6, '0').slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgba = (h, a) => `rgba(${hexRgb(h).join(',')},${a})`;
const mixRgba = (h, w, k, al = 1) => { const a = hexRgb(h), b = hexRgb(w); return `rgba(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')},${al})`; };
const mixHex = (h, w, k) => mixRgba(h, w, k, 1);

/** Your outfit picture from fortnite-api.com (full-body render when there is one, else the icon). */
let shareChar = { id: null, img: null, full: false };
function loadShareChar() {
  const id = D.skins?.[D.me];
  if (!id) return Promise.resolve(null);
  if (shareChar.id === id) return Promise.resolve(shareChar.img ? shareChar : null);
  const base = `https://fortnite-api.com/images/cosmetics/br/${encodeURIComponent(id.toLowerCase())}/`;
  const load = (u) => new Promise((ok) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = () => ok(null); im.src = u; });
  return load(base + 'featured.png').then((im) => (im ? { id, img: im, full: true } : load(base + 'icon.png').then((ic) => ({ id, img: ic, full: false }))))
    .then((c) => { shareChar = c; return c.img ? c : null; });
}

function shareCanvas(o = shareOpts(), ch = null) {
  const R = records(), c = document.createElement('canvas'), x = c.getContext('2d'), W = 1200, H = 630, A = o.color;
  c.width = W; c.height = H;
  const withChar = !!(o.char && ch?.img);
  const cx = withChar ? W * 0.8 : W * 0.8, cy = H * 0.42;
  // base: deep night tinted by the accent
  const bg = x.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, mixHex('#1b1b24', A, 0.08)); bg.addColorStop(0.55, '#121219'); bg.addColorStop(1, '#0a0a0e');
  x.fillStyle = bg; x.fillRect(0, 0, W, H);
  const glow = x.createRadialGradient(cx, cy, 0, cx, cy, 480);
  glow.addColorStop(0, rgba(A, 0.45)); glow.addColorStop(0.35, rgba(A, 0.16)); glow.addColorStop(1, rgba(A, 0));
  x.fillStyle = glow; x.fillRect(0, 0, W, H);
  if (o.style === 'burst') {
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + 0.12, half = i % 2 ? 0.045 : 0.085;
      const g = x.createRadialGradient(cx, cy, 30, cx, cy, 780);
      g.addColorStop(0, mixRgba(A, '#ffffff', 0.3, i % 2 ? 0.1 : 0.2)); g.addColorStop(0.6, rgba(A, 0.04)); g.addColorStop(1, rgba(A, 0));
      x.fillStyle = g; x.beginPath(); x.moveTo(cx, cy); x.arc(cx, cy, 900, a - half, a + half); x.closePath(); x.fill();
    }
  } else if (o.style === 'stripes') {
    x.save(); x.translate(cx, cy); x.rotate(-0.5);
    for (let i = -14; i < 14; i++) {
      const g = x.createLinearGradient(-700, 0, 700, 0);
      g.addColorStop(0, rgba(A, 0)); g.addColorStop(0.5, rgba(A, i % 3 ? 0.07 : 0.14)); g.addColorStop(1, rgba(A, 0));
      x.fillStyle = g; x.fillRect(-700, i * 46, 1400, i % 3 ? 14 : 22);
    }
    x.restore();
  } else if (o.style === 'grid') {
    x.save(); x.strokeStyle = rgba(A, 0.1); x.lineWidth = 1;
    for (let gx = 0; gx <= W; gx += 40) { x.beginPath(); x.moveTo(gx, 0); x.lineTo(gx, H); x.stroke(); }
    for (let gy = 0; gy <= H; gy += 40) { x.beginPath(); x.moveTo(0, gy); x.lineTo(W, gy); x.stroke(); }
    x.restore();
    const fade = x.createRadialGradient(cx, cy, 60, cx, cy, 700);
    fade.addColorStop(0, 'rgba(10,10,14,0)'); fade.addColorStop(1, 'rgba(10,10,14,.85)');
    x.fillStyle = fade; x.fillRect(0, 0, W, H);
  }
  const core = x.createRadialGradient(cx, cy, 0, cx, cy, 130);
  core.addColorStop(0, mixRgba(A, '#ffffff', 0.6, 0.55)); core.addColorStop(1, rgba(A, 0));
  x.fillStyle = core; x.fillRect(cx - 140, cy - 140, 280, 280);
  // the character stands on the glow, right side, cut off by the bottom edge
  if (withChar) {
    const im = ch.img;
    if (ch.full) {
      const h = H * 1.12, w = (im.naturalWidth / im.naturalHeight) * h;
      x.save(); x.shadowColor = rgba(A, 0.55); x.shadowBlur = 50;
      x.drawImage(im, W * 0.8 - w / 2, H - h * 0.93, w, h); x.restore();
    } else {
      const s = 380, px = W * 0.8 - s / 2, py = H / 2 - s / 2 + 10;
      x.save(); x.shadowColor = rgba(A, 0.6); x.shadowBlur = 40;
      x.beginPath(); x.roundRect(px, py, s, s, 36); x.fillStyle = rgba(A, 0.25); x.fill(); x.restore();
      x.save(); x.beginPath(); x.roundRect(px, py, s, s, 36); x.clip(); x.drawImage(im, px, py, s, s); x.restore();
      x.strokeStyle = 'rgba(255,255,255,.75)'; x.lineWidth = 4; x.beginPath(); x.roundRect(px, py, s, s, 36); x.stroke();
    }
  }
  // calm the text side, vignette, accent edge
  const left = x.createLinearGradient(0, 0, W * 0.62, 0);
  left.addColorStop(0, 'rgba(10,10,14,.6)'); left.addColorStop(1, 'rgba(10,10,14,0)');
  x.fillStyle = left; x.fillRect(0, 0, W, H);
  const vig = x.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.78);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.5)');
  x.fillStyle = vig; x.fillRect(0, 0, W, H);
  const edge = x.createLinearGradient(0, 0, W, 0);
  edge.addColorStop(0, rgba(A, 0)); edge.addColorStop(0.5, rgba(A, 0.95)); edge.addColorStop(1, rgba(A, 0));
  x.fillStyle = edge; x.fillRect(0, 0, W, 4);
  const font = (w, s, it = true) => `${it ? 'italic ' : ''}${w} ${s}px Inter, Segoe UI, sans-serif`;
  // logo: accent tile with the key
  const tile = x.createLinearGradient(0, 56, 0, 120);
  tile.addColorStop(0, mixHex(A, '#ffffff', 0.35)); tile.addColorStop(1, A);
  x.fillStyle = tile; x.beginPath(); x.roundRect(60, 56, 64, 64, 15); x.fill();
  x.strokeStyle = '#120f08'; x.lineWidth = 6; x.lineCap = 'round';
  x.beginPath(); x.arc(80, 76, 9, 0, Math.PI * 2); x.stroke();
  x.beginPath(); x.moveTo(87, 83); x.lineTo(107, 103); x.moveTo(96, 92); x.lineTo(102, 86); x.moveTo(102, 98); x.lineTo(108, 92); x.stroke();
  x.fillStyle = '#fff'; x.font = font(900, 38); x.fillText('RECHEST', 140, 102);
  x.fillStyle = '#a4a4b0'; x.font = font(600, 22, false); x.fillText(`${D.me || 'Player'} · ${DAYW.format(new Date())}`, 62, 170);
  x.fillStyle = A; x.font = font(900, 150); x.fillText(NUM.format(R.total), 56, 330);
  x.fillStyle = '#fff'; x.font = font(900, 30); x.fillText(T('Chests opened').toLocaleUpperCase(window.I18N?.locale), 62, 375);
  const tiles = [[T('Matches'), NUM.format(D.matches.length)], [T('Best match'), R.bestM ? R.bestM.mine : '—'], [T('Per hour'), R.playAll ? n1(R.total / (R.playAll / 3600)) : '—'], [T('In matches'), T(hmin(R.playAll))]];
  const tw = withChar ? 168 : 250, gap = withChar ? 12 : 20;
  tiles.forEach(([l, v], i) => {
    const tx = 60 + i * (tw + gap), ty = 430;
    x.fillStyle = 'rgba(255,255,255,.08)'; x.beginPath(); x.roundRect(tx, ty, tw, 130, 18); x.fill();
    x.strokeStyle = 'rgba(255,255,255,.1)'; x.lineWidth = 1.5; x.stroke();
    x.fillStyle = '#fff'; x.font = font(900, withChar ? 36 : 46); x.fillText(String(v), tx + 20, ty + 68);
    x.fillStyle = '#a4a4b0'; x.font = font(700, withChar ? 16 : 20, false); x.fillText(String(l).toLocaleUpperCase(window.I18N?.locale), tx + 20, ty + 104);
  });
  return c;
}

const SHARE_COLORS = ['#ffc83d', '#ff8a3d', '#ff4f8b', '#b45cff', '#6d7bff', '#5ad1ff', '#2dd4bf', '#3ccf6e', '#ffffff'];
async function openShare() {
  closeShare();
  const o = shareOpts();
  const el = document.createElement('div');
  el.id = 'share'; el.className = 'secret share';
  el.style.setProperty('--ox', '50vw'); el.style.setProperty('--oy', '50vh');
  el.innerHTML = `<div class="sc-veil" data-act="shareClose"></div><div class="sc-card share-card"><h2>Share</h2>
    <img id="shareImg" alt="Your ReChest summary">
    <div class="share-opts">
      <div class="so-row"><span class="so-l">Colour</span><span class="swatches">${SHARE_COLORS.map((c) => `<button class="swatch ${o.color.toLowerCase() === c ? 'on' : ''}" style="--c:${c}" data-sharecolor="${c}" aria-label="${c}"></button>`).join('')}<button class="swatch custom" style="--c:${o.color}" data-picker="share" title="Custom colour" aria-label="Custom colour"></button></span></div>
      <div class="so-row"><span class="so-l">Style</span><div class="range sm">${[['burst', 'Burst'], ['stripes', 'Stripes'], ['grid', 'Grid'], ['clean', 'Clean']].map(([k, t]) => `<button class="${o.style === k ? 'on' : ''}" data-sharestyle="${k}">${t}</button>`).join('')}</div></div>
      <div class="so-row"><span class="so-l">Character</span><button class="switch ${o.char ? 'on' : ''}" data-act="shareChar" aria-label="Character"><i></i></button></div>
    </div>
    <div class="share-act"><button class="btn accent" data-act="shareCopy">Copy image</button><a class="btn" id="shareSave" download="rechest-summary.png">Save PNG</a><button class="see" data-act="shareClose">Close</button></div></div>`;
  document.body.appendChild(el);
  redrawShare();
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
  if (o.char && await loadShareChar()) redrawShare();
}
function redrawShare() {
  const el = document.getElementById('share');
  if (!el) return;
  const c = shareCanvas(shareOpts(), shareChar.img ? shareChar : null);
  let url;
  try { url = c.toDataURL('image/png'); } catch { shareChar = { id: shareChar.id, img: null }; return redrawShare(); } // a picture without CORS taints the canvas: drop it
  el._canvas = c;
  el.querySelector('#shareImg').src = url;
  el.querySelector('#shareSave').href = url;
}
function setShare(patch) { FX.share = { ...shareOpts(), ...patch }; saveFx(); redrawShare(); }
function closeShare() { const el = document.getElementById('share'); if (!el) return; el.classList.remove('on'); el.classList.add('off'); setTimeout(() => el.remove(), 320); }

/* ---------- broadcast history (in the hidden panel) ---------- */
const ago = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
function fxBcastHistory(times) {
  const box = document.getElementById('scHist');
  if (!box) return;
  const list = (times || []).map((t) => new Date(t).getTime());
  box.innerHTML = list.length
    ? `<small>Recent broadcasts</small>${list.slice(0, 6).map((t) => `<div class="bh"><i></i><b>${HM.format(new Date(t))}</b><em>${ago(Date.now() - t)}</em>${FX.sent.some((s) => Math.abs(s - t) < 90_000) ? '<span class="vbadge">YOU</span>' : ''}</div>`).join('')}`
    : '<small>No broadcasts in the last 12 hours</small>';
}

/** Clicks for the features above; returns true when handled. */
function fxClick(t, d) {
  if (d.act === 'mwhoMore') { if (document.getElementById('ppop')) closePlayerPop(); else openPlayerPop(t); return true; }
  if (d.lang) { if (d.lang !== I18N.lang) { D.settings.lang = d.lang; send({ type: 'settings', settings: D.settings }); setTimeout(() => I18N.set(d.lang), 150); } return true; }
  if (d.win) { send({ type: 'win', act: d.win }); return true; }
  if (d.goal) { FX.goal = Math.max(5, Math.min(500, FX.goal + Number(d.goal))); saveFx(); render(false); return true; }
  if (d.tag) { setTag(d.tagm, d.tag, !t.classList.contains('on')); t.classList.toggle('on'); refreshTags(d.tagm); return true; }
  if (d.mtag) { S.mtag = d.mtag === '*' ? '' : d.mtag; S.open = null; render(false); return true; }
  if (d.act === 'share') { openShare(); return true; }
  if (d.act === 'shareClose') { closeShare(); return true; }
  if (d.sharecolor) { setShare({ color: d.sharecolor }); t.parentElement.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === t)); return true; }
  if (d.sharestyle) { setShare({ style: d.sharestyle }); t.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === t)); return true; }
  if (d.act === 'shareChar') { const on = !shareOpts().char; t.classList.toggle('on', on); setShare({ char: on }); if (on) loadShareChar().then(redrawShare); return true; }
  if (d.act === 'shareCopy') {
    document.getElementById('share')?._canvas.toBlob(async (b) => {
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); toast('Image copied', 'Paste it anywhere'); } catch { toast('Could not copy', 'Use Save PNG instead'); }
    });
    return true;
  }
  if (d.act === 'sound') { FX.sound = !FX.sound; saveFx(); t.classList.toggle('on', FX.sound); if (FX.sound) chime('match'); return true; }
  if (d.act === 'broadcast') { FX.sent = [...FX.sent, Date.now()].slice(-20); saveFx(); }
  return false;
}
/** Updates the selected row's tag line without redrawing the list. */
function refreshTags(id) {
  const row = document.querySelector(`.mitem[data-sel="${CSS.escape(id)}"] .mi-when`);
  if (!row) return;
  row.querySelector('.mi-tags')?.remove();
  const m = D.matches.find((x) => x.id === id);
  if (m) row.insertAdjacentHTML('beforeend', tagMini(m));
}
document.addEventListener('keydown', (e) => {
  const inp = e.target.closest?.('.tag-add');
  if (!inp || e.key !== 'Enter') return;
  const v = inp.value.trim();
  if (!v) return;
  setTag(inp.dataset.tagm, v, true);
  inp.value = '';
  const m = D.matches.find((x) => x.id === inp.dataset.tagm);
  if (m) { inp.closest('.tagrow').outerHTML = tagRow(m); refreshTags(m.id); }
});
document.addEventListener('input', (e) => {
  if (!e.target.dataset?.fxvol) return;
  FX.vol = e.target.value / 100; saveFx();
  e.target.style.setProperty('--p', e.target.value + '%');
  e.target.nextElementSibling.textContent = e.target.value + '%';
});

/* own title bar (in the app only): drag by the top bar, double-click to maximise, resize from the edges */
if (window.chrome?.webview) {
  document.documentElement.classList.add('in-app');
  const NOT_DRAG = 'button, a, input, .tabs, .brand, .tablabel';
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const rz = e.target.closest('.rz');
    if (rz) { e.preventDefault(); send({ type: 'win', act: 'resize', edge: rz.dataset.edge }); return; }
    if (e.target.closest('.top') && !e.target.closest(NOT_DRAG) && e.detail === 1) send({ type: 'win', act: 'drag' });
  });
  document.addEventListener('dblclick', (e) => { if (e.target.closest('.top') && !e.target.closest(NOT_DRAG)) send({ type: 'win', act: 'max' }); });
}

/* Matches › "+N more": a searchable list of the other players, in the same glass as the colour picker */
function openPlayerPop(anchor) {
  closePlayerPop();
  const el = document.createElement('div');
  el.id = 'ppop'; el.className = 'cpop ppop';
  const list = (q = '') => (window.MWHO_REST || []).filter(([n]) => n.toLowerCase().includes(q.toLowerCase()))
    .map(([n, g]) => `<button class="pp-row ${S.mwho === n ? 'on' : ''}" data-mwho="${esc(n)}">${avatar(n, 'xs')}<b>${esc(n)}</b><em>${g} match${g === 1 ? '' : 'es'}</em></button>`).join('') || '<div class="empty">No player found</div>';
  el.innerHTML = `<input class="pp-q" placeholder="Search players" aria-label="Search players"><div class="pp-list">${list()}</div>`;
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, r.left)) + 'px';
  el.style.top = r.bottom + 8 + 'px';
  const q = el.querySelector('.pp-q');
  q.addEventListener('input', () => { el.querySelector('.pp-list').innerHTML = list(q.value); });
  q.focus();
}
function closePlayerPop() { document.getElementById('ppop')?.remove(); }
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#ppop, [data-act="mwhoMore"]')) closePlayerPop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.getElementById('ppop')) { e.stopImmediatePropagation(); closePlayerPop(); } }, true);
