'use strict';
/* ReChest UI v3. Data comes from C# (window.chrome.webview messages) or, in a plain browser, from mock.js.
   Layout: the sidebar is the navigation; Overview is a dashboard, Players and Matches are master-detail views
   (list on the left, the selected item on the right), Settings has its own section list. Line charts show every
   point's value under the mouse. Dark and light themes share one set of CSS tokens. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const IN_APP = !!window.chrome?.webview;
const send = (msg) => { if (IN_APP) window.chrome.webview.postMessage(msg); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NUM = new Intl.NumberFormat(window.I18N?.locale || 'en-US', { maximumFractionDigits: 1 });
const DAY = new Intl.DateTimeFormat(window.I18N?.locale || 'en-US', { day: 'numeric', month: 'short' });
const DAYW = new Intl.DateTimeFormat(window.I18N?.locale || 'en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const HM = new Intl.DateTimeFormat(window.I18N?.locale || 'en-US', { hour: '2-digit', minute: '2-digit' });
const DAY_MS = 864e5;
const n1 = (v) => NUM.format(Math.round(v * 10) / 10);
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const sum = (a) => a.reduce((x, y) => x + y, 0);
const when = (m) => `${DAYW.format(new Date(m.startUtc))} · ${HM.format(new Date(m.startUtc))}`;

const TYPES = {
  chest: { name: 'Chest', c: '#F2A51A' },
  faction: { name: 'Faction chest', c: '#E0402F' },
  ammo: { name: 'Ammo box', c: '#6F9A3A' },
  drop: { name: 'Supply drop', c: '#2F86E0' },
  llama: { name: 'Supply llama', c: '#B45CE0' },
  fishing: { name: 'Fishing barrel', c: '#8A5A32' },
  gift: { name: 'Gift box', c: '#E0408F' },
};
const typeName = (t) => TYPES[t]?.name || t;
/** Only real chests count toward totals; ammo boxes, drops, llamas and barrels are shown apart. */
const isChest = (t) => t === 'chest' || t === 'faction';

/* ---------------- state ---------------- */
const S = { page: 'home', who: 'me', ptab: 'overview', open: null, motion: true, scope: 'all', mode: 'team', chart: 'match', msort: 'new', mwho: 'all', stab: 'overlay' };
let D = { matches: [], me: '', others: [], opens: [], chests: [], players: [], liveSince: null, live: [], skins: {}, settings: {}, keys: { interact: [], attack: [] }, demos: true, backups: { count: 0, bytes: 0 }, images: new Set(), version: '' };
let hasData = false;
try { S.motion = localStorage.getItem('rechest.motion') !== 'off'; } catch { /* storage blocked */ }
const IMG = IN_APP ? 'https://img.rechest.local/' : (window.MOCK?.imgBase || '');

/* theme: black (default), blue (the game menus' night), light, or follow Windows (black/light);
   a per-machine preference, so it lives in the page's local storage */
let THEME = 'black';
try { THEME = localStorage.getItem('rechest.theme') || 'black'; } catch { /* storage blocked */ }
if (THEME === 'dark') THEME = 'black'; // the earlier "dark" (blue) setting moves to the new default
const LIGHT = matchMedia('(prefers-color-scheme: light)');
function applyTheme() { document.documentElement.dataset.theme = THEME === 'system' ? (LIGHT.matches ? 'light' : 'black') : THEME; }
/** T / the top-bar button: light ↔ the dark look last used (black unless blue was picked). */
let lastDark = THEME === 'blue' ? 'blue' : 'black';
function toggleTheme() { if (THEME !== 'light' && THEME !== 'system') lastDark = THEME; setTheme(document.documentElement.dataset.theme === 'light' ? lastDark : 'light'); }
function setTheme(t) { THEME = t; try { localStorage.setItem('rechest.theme', t); } catch { /* ignore */ } applyTheme(); }
LIGHT.addEventListener('change', applyTheme);
applyTheme();

/* background: the theme's own, a colour of your choice, or a picture (darkened/blurred so the UI stays readable).
   Per machine, like the theme; the picture is downscaled to a JPEG so it fits in local storage. */
const BG = { kind: 'theme', color: '#6d4bff', dim: 45, blur: 0, img: '' };
try { Object.assign(BG, JSON.parse(localStorage.getItem('rechest.bg') || '{}')); BG.img = localStorage.getItem('rechest.bgimg') || ''; } catch { /* storage blocked */ }
function applyBg() {
  const app = $('.app');
  if (!app) return;
  const kind = BG.kind === 'image' && !BG.img ? 'theme' : BG.kind;
  app.classList.toggle('bg-color', kind === 'color');
  app.classList.toggle('bg-img', kind === 'image');
  app.style.setProperty('--bg-c', BG.color);
  app.style.setProperty('--bg-dim', BG.dim / 100);
  app.style.setProperty('--bg-blur', BG.blur + 'px');
  app.style.setProperty('--bg-url', BG.img ? `url("${BG.img}")` : 'none');
  // panels take on the background's colour: the picked one, or the picture's dominant colour
  if (kind === 'image' && !BG.imgTint) { pictureTint(BG.img).then((c) => { if (c) { BG.imgTint = c; saveBg(); } }); }
  const tint = kind === 'color' ? BG.color : kind === 'image' ? BG.imgTint : null;
  const r = document.documentElement;
  r.classList.toggle('tinted', !!tint);
  if (tint) {
    const mix = (hex, to, k) => { const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16); return [16, 8, 0].map((s) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k)).join(' '); };
    r.style.setProperty('--tint', tint);
    // the panels are the picked colour itself; only very bright ones (gold, white...) come down to a mid tone, so
    // white text stays readable without turning the panels muddy-dark
    const n = parseInt(tint.slice(1), 16), lum = (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255;
    const card = [16, 8, 0].map((s) => Math.round(((n >> s) & 255) * (lum > 0.52 ? 0.52 / lum : 1))).join(' ');
    r.style.setProperty('--tint-card', card);
    r.style.setProperty('--base-dark', card);
    r.style.setProperty('--base-light', mix(tint, '#f6f7ff', 0.86));
  }
}
/** The picture's dominant colour, weighted toward saturated pixels (greys barely count). */
function pictureTint(src) {
  return new Promise((ok) => {
    if (!src) return ok(null);
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = 24;
      const x = c.getContext('2d'); x.drawImage(im, 0, 0, 24, 24);
      const d = x.getImageData(0, 0, 24, 24).data;
      let r = 0, g = 0, b = 0, w = 0;
      for (let i = 0; i < d.length; i += 4) {
        const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        const wt = 0.05 + (mx ? (mx - mn) / mx : 0) ** 2;
        r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
      }
      ok('#' + [r, g, b].map((v) => Math.round(v / w).toString(16).padStart(2, '0')).join(''));
    };
    im.onerror = () => ok(null);
    im.src = src;
  });
}
function saveBg() {
  try { const { img, ...rest } = BG; localStorage.setItem('rechest.bg', JSON.stringify(rest)); } catch { /* ignore */ }
  applyBg();
}
/* glass: on/off, blur strength and how solid the panels are (0 = see-through glass, 100 = solid) */
const GLASS = { on: true, blur: 24, solid: 0 };
try { Object.assign(GLASS, JSON.parse(localStorage.getItem('rechest.glass') || '{}')); } catch { /* storage blocked */ }
function applyGlass() {
  const r = document.documentElement;
  r.classList.toggle('no-glass', !GLASS.on);
  r.style.setProperty('--gblur', (GLASS.on ? GLASS.blur : 0) + 'px');
  r.style.setProperty('--gsolid', GLASS.on ? GLASS.solid / 100 : 1);
}
function saveGlass() { try { localStorage.setItem('rechest.glass', JSON.stringify(GLASS)); } catch { /* ignore */ } applyGlass(); }
applyGlass();

/** Reads a picked file, scales it to at most 2560 px wide and stores it as a JPEG. */
function loadBgImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file), im = new Image();
  im.onload = () => {
    const k = Math.min(1, 2560 / im.naturalWidth), c = document.createElement('canvas');
    c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    let data = c.toDataURL('image/jpeg', 0.86);
    try { localStorage.setItem('rechest.bgimg', data); }
    catch { data = c.toDataURL('image/jpeg', 0.6); try { localStorage.setItem('rechest.bgimg', data); } catch { toast('Picture too large', 'Try a smaller image'); return; } }
    BG.img = data; BG.kind = 'image'; BG.imgTint = null; saveBg(); render(false);
  };
  im.onerror = () => { URL.revokeObjectURL(url); toast('Could not read that picture'); };
  im.src = url;
}

/* themed colour picker: a glass popover with a saturation/brightness field, a hue bar, hex input and presets */
const hsvToHex = (h, s, v) => { const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); }; return '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join(''); };
function hexToHsv(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return [260, 0.7, 1];
  const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  const h = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
}
const PICK_PRESETS = ['#0b0b10', '#1d55c4', '#6d4bff', '#b24fe0', '#ff4f8b', '#ff7a3d', '#ffc83d', '#3ccf6e', '#2dd4bf', '#5ad1ff'];
let PICK = null; // the open picker: { el, h, s, v, onPick }
function closePicker() { PICK?.el.remove(); PICK = null; }
function openPicker(anchor, value, onPick) {
  closePicker();
  const [h, s, v] = hexToHsv(value);
  const el = document.createElement('div');
  el.className = 'cpop';
  el.innerHTML = `<div class="cp-sv"><i></i></div><div class="cp-hue"><i></i></div>
    <div class="cp-row"><span class="cp-now"></span><label class="cp-hex">#<input maxlength="6" spellcheck="false"></label>${'EyeDropper' in window ? '<button class="cp-eye" title="Pick from screen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3z"/></svg></button>' : ''}</div>
    <div class="cp-presets">${PICK_PRESETS.map((c) => `<button style="--c:${c}" data-c="${c}" aria-label="${c}"></button>`).join('')}</div>`;
  document.body.appendChild(el);
  PICK = { el, h, s, v, onPick };
  const r = anchor.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, r.right - el.offsetWidth)) + 'px';
  el.style.top = (r.bottom + el.offsetHeight + 8 > innerHeight ? r.top - el.offsetHeight - 8 : r.bottom + 8) + 'px';
  const sv = $('.cp-sv', el), hue = $('.cp-hue', el), hex = $('.cp-hex input', el);
  const paint = (emit = true) => {
    const c = hsvToHex(PICK.h, PICK.s, PICK.v);
    el.style.setProperty('--hue', `hsl(${PICK.h} 100% 50%)`);
    el.style.setProperty('--cur', c);
    $('i', sv).style.cssText = `left:${PICK.s * 100}%;top:${(1 - PICK.v) * 100}%`;
    $('i', hue).style.left = (PICK.h / 360) * 100 + '%';
    if (document.activeElement !== hex) hex.value = c.slice(1);
    if (emit) PICK.onPick(c);
  };
  const drag = (area, fn) => area.addEventListener('pointerdown', (e) => {
    try { area.setPointerCapture(e.pointerId); } catch { /* synthetic or lost pointer */ }
    const move = (ev) => { const b = area.getBoundingClientRect(); fn(Math.max(0, Math.min(1, (ev.clientX - b.left) / b.width)), Math.max(0, Math.min(1, (ev.clientY - b.top) / b.height))); paint(); };
    move(e);
    area.onpointermove = move;
    area.onpointerup = () => { area.onpointermove = null; };
  });
  drag(sv, (x, y) => { PICK.s = x; PICK.v = 1 - y; });
  drag(hue, (x) => { PICK.h = x * 360; });
  hex.addEventListener('input', () => { if (/^[0-9a-f]{6}$/i.test(hex.value)) { [PICK.h, PICK.s, PICK.v] = hexToHsv(hex.value); paint(); } });
  el.addEventListener('click', async (e) => {
    const p = e.target.closest('[data-c]');
    if (p) { [PICK.h, PICK.s, PICK.v] = hexToHsv(p.dataset.c); paint(); }
    if (e.target.closest('.cp-eye')) { try { const { sRGBHex } = await new window.EyeDropper().open(); [PICK.h, PICK.s, PICK.v] = hexToHsv(sRGBHex); paint(); } catch { /* cancelled */ } }
  });
  paint(false);
}
document.addEventListener('pointerdown', (e) => { if (PICK && !PICK.el.contains(e.target) && !e.target.closest('[data-picker]')) closePicker(); });

function derive(data) {
  const matches = (data.matches || []).slice().sort((a, b) => new Date(a.startUtc) - new Date(b.startUtc));
  const me = matches.length ? matches[matches.length - 1].me : '';
  const opens = matches.flatMap((m) => m.opens.map((o) => ({ ...o, m, at: new Date(m.startUtc).getTime() + o.t * 1000 })));
  const chests = opens.filter((o) => isChest(o.type));
  const played = new Map();
  for (const m of matches) for (const p of m.squad) played.set(p, (played.get(p) || 0) + 1);
  const players = [...played.keys()]
    .map((name) => ({ name, played: played.get(name), total: chests.filter((o) => o.by === name).length }))
    .sort((a, b) => b.total - a.total || (a.name === me ? -1 : 1));
  return {
    matches, me, opens, chests, players,
    others: [...played.keys()].filter((p) => p !== me).sort(),
    liveSince: data.liveSince ? new Date(data.liveSince).getTime() : null,
    live: (data.live || []).map((o) => ({ type: o.type, at: new Date(o.atUtc).getTime(), manual: o.manual })),
    skins: Object.assign({}, ...matches.map((m) => m.skins || {})),
    settings: data.settings || {}, keys: data.keys || { interact: [], attack: [] },
    demos: data.demos !== false, backups: data.backups || { count: 0, bytes: 0 }, images: new Set(data.images || []), version: data.version || '',
  };
}
const chestsOf = (m) => m.opens.filter((o) => isChest(o.type));

/* ---------------- players, skins, pictures ---------------- */
const ME_COLOR = '#2fbf6a';
const PALETTE = ['#3b9cff', '#9b7bff', '#e0a030', '#ff5c8a', '#2dd4bf', '#f97316'];
const colorOf = (name) => (name === D.me ? ME_COLOR : PALETTE[Math.max(0, D.others.indexOf(name)) % PALETTE.length]);
const skinUrl = (name) => (D.skins[name] ? `https://fortnite-api.com/images/cosmetics/br/${encodeURIComponent(D.skins[name].toLowerCase())}/smallicon.png` : null);
const avatar = (name, cls = '') => {
  const url = skinUrl(name);
  return `<span class="avatar ${url ? 'skin' : ''} ${cls}" style="--c:${colorOf(name)}">${esc((name || '?')[0].toUpperCase())}${url ? `<img src="${url}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
};
const pic = (type, cls = '') => {
  const t = D.images.has(type) ? type : (type === 'gift' || type === 'faction') && D.images.has('chest') ? 'chest' : null;
  return t ? `<img class="${cls}" src="${IMG}${t}.png" alt="${esc(typeName(type))}">` : `<span class="noimg ${cls}">${esc(typeName(type)[0])}</span>`;
};

const ICON = {
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  person: '<svg class="person" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4 4-6.5 8-6.5s7.2 2.5 8 6.5"/></svg>',
  team: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-6 6.5-6s5.9 2.4 6.5 6"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c2.6 0 4.2 2 4.5 5"/></svg>',
  folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 5h7l2 2h9v12H3z"/></svg>',
  open: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  up: '<svg width="16" height="11" viewBox="0 0 18 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 10l4.5-5 3.5 3.5L16 2M11.5 2H16v4.5"/></svg>',
  down: '<svg width="16" height="11" viewBox="0 0 18 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 2l4.5 5L9 3.5 16 10M11.5 10H16V5.5"/></svg>',
};

/* ---------------- data from C# ---------------- */
function onData(data) {
  const seen = new Set(D.matches.map((m) => m.id));
  const wasLive = D.liveSince, liveBefore = D.live.length;
  D = derive(data);
  window.MapUI.setChests(data.chestMap);
  if (S.who !== 'team' && S.who !== 'me' && !D.players.some((p) => p.name === S.who)) S.who = 'me';
  if (hasData) {
    for (const m of D.matches.filter((x) => !seen.has(x.id)).slice(-2)) {
      const c = chestsOf(m);
      toast(`Match added: <b>${c.filter((o) => o.by === m.me).length}</b> by you, <b>${c.length}</b> by the squad`, `${when(m)}${m.placement ? ' · #' + m.placement : ''}`);
    }
    if (D.liveSince && !wasLive) toast('Match started', 'Add chests with your hotkey; the replay sets the exact count at the end');
    if (D.live.length > liveBefore) toast(`+${D.live.length - liveBefore} chest`, `This match: ${D.live.length}`);
  }
  const first = !hasData;
  hasData = true;
  fxAfterData(first, D.matches.some((x) => !seen.has(x.id)), D.live.length > liveBefore);
  const me = $('#meDot'), url = skinUrl(D.me);
  me.innerHTML = esc((D.me || '?')[0].toUpperCase()) + (url ? `<img src="${url}" alt="" onerror="this.remove()">` : '');
  me.style.setProperty('--c', D.me ? ME_COLOR : '#444');
  if (S.page === 'settings' && !first) { drawPreview(); return; } // don't redraw the sliders under the user's hand
  if (S.page === 'sim' && !first) return; // don't interrupt an opening animation
  if (S.page === 'map' && !first) return; // keep the map under the user's hand
  render(first);
}

/* ---------------- shared bits ---------------- */
function toast(html, sub) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span class="icon sm">${pic('chest')}</span><div>${html}${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 320); }, 4500);
}
function countUp(root) {
  $$('[data-count]', root).forEach((el) => {
    const to = Number(el.dataset.count), dec = Number(el.dataset.dec || 0);
    if (!S.motion || !to) return;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 1000), e = 1 - Math.pow(1 - p, 4);
      el.textContent = NUM.format(dec ? Math.round(to * e * 10 ** dec) / 10 ** dec : Math.round(to * e));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
const cnt = (n, dec = 0) => `<span data-count="${n}" data-dec="${dec}">${NUM.format(n)}</span>`;
function trend(now, before) {
  if (!before) return now ? `<span class="d up">${ICON.up} new</span>` : '';
  const p = ((now - before) / before) * 100, cls = Math.abs(p) < 0.5 ? 'flat' : p > 0 ? 'up' : 'down';
  return `<span class="d ${cls}">${cls === 'down' ? ICON.down : ICON.up}${p > 0 ? '+' : ''}${n1(p)}%</span>`;
}
const placeTag = (p) => `<span class="ptag ${p === 1 ? 'p1' : p && p <= 3 ? 'p3' : p && p <= 10 ? 'p10' : ''}">${p ? '#' + p : '—'}</span>`;

/* ---------------- charts ---------------- */
function smooth(vals, max, w = 100, h = 100) {
  const n = vals.length, pt = (i) => [n === 1 ? w / 2 : (i / (n - 1)) * w, h - (vals[i] / max) * h];
  let d = `M${pt(0).map((v) => v.toFixed(2)).join(',')}`;
  for (let i = 1; i < n; i++) { const [x0, y0] = pt(i - 1), [x1, y1] = pt(i), dx = (x1 - x0) / 3; d += `C${(x0 + dx).toFixed(2)},${y0.toFixed(2)} ${(x1 - dx).toFixed(2)},${y1.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`; }
  return { d, pt };
}
/** A round axis top a bit above the data, so the scale reads 5 / 10 / 25 / 50 instead of 23.4. */
const niceMax = (v) => { const m = Math.max(1, v) * 1.12, p = 10 ** Math.floor(Math.log10(m)); return [1, 2, 2.5, 5, 10].find((k) => k * p >= m) * p; };

/* interactive charts: CH holds each chart's data; the pointer handler below reads it to draw the crosshair */
let CH = [];
/**
 * Line chart where every point's values show under the mouse.
 * series: [{ name, color, vals, dash?, fmt? }]; labels: one per point; ids: match ids (makes points clickable);
 * subs: an extra tooltip line per point; step: draw steps instead of curves (cumulative counts).
 */
function ichart(series, labels, { ids = null, subs = null, height = 220, step = false, area = true } = {}) {
  const n = labels.length;
  if (!n) return '<div class="empty">No data yet</div>';
  const max = niceMax(Math.max(...series.flatMap((s) => s.vals)));
  const x = (i) => (n === 1 ? 50 : (i / (n - 1)) * 100), y = (v) => 100 - (v / max) * 100;
  const path = (vals) => {
    if (!step) return smooth(vals, max).d;
    let d = `M0,${y(vals[0]).toFixed(2)}`;
    for (let i = 1; i < n; i++) d += `H${x(i).toFixed(2)}V${y(vals[i]).toFixed(2)}`;
    return d;
  };
  const id = CH.push({ series, labels, ids, subs, max }) - 1;
  const grid = [1, 0.5, 0].map((f) => `<div class="ic-gl" style="top:${100 - f * 100}%"><span>${NUM.format(max * f)}</span></div>`).join('');
  const lines = series.map((s, k) => {
    const d = path(s.vals), g = `ig${id}_${k}`;
    const fill = area && !s.dash ? `<defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${s.color};stop-opacity:.28"/><stop offset="1" style="stop-color:${s.color};stop-opacity:0"/></linearGradient></defs><path d="${d}L100,100L0,100Z" fill="url(#${g})"/>` : '';
    return `${fill}<path d="${d}" fill="none" style="stroke:${s.color}" stroke-width="${s.dash ? 1.5 : 2.4}" ${s.dash ? 'stroke-dasharray="4 4" opacity=".7"' : ''} stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  const lead = series[0];
  return `<div class="ichart ${ids ? 'clickable' : ''}" data-ch="${id}" style="height:${height}px">${grid}
    <svg class="line" viewBox="0 0 100 100" preserveAspectRatio="none">${lines}</svg>
    <i class="edot" style="left:${x(n - 1)}%;top:${y(lead.vals[n - 1])}%;background:${lead.color}"></i>
    <div class="ic-cursor"></div>${series.map((s, k) => `<i class="ic-dot" data-k="${k}" style="--c:${s.color}"></i>`).join('')}</div>`;
}
function barCard(vals, { hl = vals.length - 1, cls = '', labels = false, tips = null } = {}) {
  const top = Math.max(1, ...vals), max = top * (labels ? 1.22 : 1.12), peakAt = vals.indexOf(top);
  return `<div class="chart"><div class="gl" style="top:${100 - (top / max) * 100}%"><span>${NUM.format(top)}</span></div><div class="gl" style="top:100%"></div><div class="bars ${cls}">${vals.map((v, i) => {
    const show = labels || i === hl || (i === peakAt && v > 0);
    return `<div class="bc ${i === hl ? 'hl' : ''}" style="--h:${v / max};--i:${i}" ${tips ? tipAttr(tips[i]) : ''}>${show && (v || labels) ? `<span class="bv">${NUM.format(v)}</span>` : ''}<i></i></div>`;
  }).join('')}</div></div>`;
}
function spark(vals, color) {
  if (vals.length < 2) vals = [0, ...vals].slice(-2);
  const max = Math.max(1, ...vals), { d, pt } = smooth(vals, max * 1.1, 84, 30), e = pt(vals.length - 1);
  return `<svg class="spark" viewBox="0 0 84 34"><path d="${d}" transform="translate(0,2)" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/><circle cx="${e[0]}" cy="${e[1] + 2}" r="2.6" fill="${color}"/></svg>`;
}
const rankBadge = (r) => (r ? `<span class="rankb ${r <= 3 ? 'r' + r : ''}">${r}</span>` : '');
const iconTile = (type, extra = '', cls = '') => `<span class="icon ${cls}">${pic(type)}${extra}</span>`;

/* tooltips: [data-tip] elements show rich text from TIPS; .ichart shows the hovered point of every series */
let TIPS = [];
const tipAttr = (html) => `data-tip="${TIPS.push(html) - 1}"`;
function placeTip(e) {
  const tip = $('#tip');
  const x = Math.min(innerWidth - tip.offsetWidth - 12, e.clientX + 16), y = Math.max(8, e.clientY - tip.offsetHeight - 14);
  tip.style.transform = `translate(${x}px, ${y}px)`;
  tip.classList.add('on');
}
function hideTips() { $('#tip').classList.remove('on'); $$('.ichart.hover').forEach((c) => c.classList.remove('hover')); }
document.addEventListener('pointermove', (e) => {
  const tip = $('#tip'), ch = e.target.closest?.('.ichart');
  $$('.ichart.hover').forEach((c) => { if (c !== ch) c.classList.remove('hover'); });
  if (ch) {
    const c = CH[Number(ch.dataset.ch)];
    if (!c) return;
    const r = ch.getBoundingClientRect(), n = c.labels.length;
    const i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
    const xp = n === 1 ? 50 : (i / (n - 1)) * 100;
    ch.classList.add('hover');
    ch.dataset.i = i;
    ch.querySelector('.ic-cursor').style.left = `${xp}%`;
    $$('.ic-dot', ch).forEach((d) => { const s = c.series[d.dataset.k]; d.style.left = `${xp}%`; d.style.top = `${100 - (s.vals[i] / c.max) * 100}%`; });
    tip.innerHTML = `<b>${esc(c.labels[i])}</b>${c.series.map((s) => `<span class="tl"><i style="background:${s.color}"></i>${esc(s.name)}<b>${(s.fmt || n1)(s.vals[i])}</b></span>`).join('')}`
      + `${c.subs ? `<small>${esc(c.subs[i])}</small>` : ''}${c.ids ? '<small class="hint">Click to open the match</small>' : ''}`;
    placeTip(e);
    return;
  }
  const el = e.target.closest?.('[data-tip]');
  if (!el) { tip.classList.remove('on'); return; }
  tip.innerHTML = TIPS[Number(el.dataset.tip)] || '';
  placeTip(e);
}, { passive: true });
document.documentElement.addEventListener('mouseleave', hideTips);
$('#main').addEventListener('scroll', hideTips, { passive: true }); // a wheel scroll moves the chart away without a pointer move

/* ---------------- page frame ---------------- */
const liveText = () => `In a match · ${mmss((Date.now() - D.liveSince) / 1000)} · +${D.live.length}`;
const head = (title, sub, tools = '') => `<header class="phd"><div><h1>${title}</h1><p>${sub}</p></div><div class="phd-r">${tools}${D.liveSince ? `<span class="livechip" id="liveChip">${liveText()}</span>` : ''}</div></header>`;
const panelHead = (title, sub = '', right = '') => `<div class="ph"><div><h2>${title}</h2>${sub ? `<small>${sub}</small>` : ''}</div>${right}</div>`;

const PAGES = ['home', 'player', 'matches', 'sim', 'map', 'settings'];
const PAGE_NAMES = { home: 'Overview', player: 'Players', matches: 'Matches', sim: 'Simulator', settings: 'Settings', map: 'Map' };

function render(anim) {
  closePlayerPop();
  closePicker();
  TIPS = [];
  CH = [];
  hideTips();
  $$('.tab[data-page], .setbtn').forEach((b) => b.classList.toggle('on', b.dataset.page === S.page));
  $('#tabLabel').textContent = PAGE_NAMES[S.page];
  placeTabLabel();
  const v = $('#view');
  v.innerHTML = `<div class="page ${anim ? 'anim' : ''}" ${anim ? '' : 'style="animation:none"'}>${({ home, player, matches, sim, settings, map })[S.page]()}</div>`;
  if (anim) countUp(v);
  if (S.page === 'settings') drawPreview();
  if (S.page === 'sim') window.SimUI.mount($('#simRoot'));
  if (S.page === 'map') window.MapUI.mount($('#mapRoot'));
  if (S.page === 'matches') requestAnimationFrame(() => $('.mitem.on')?.scrollIntoView({ block: 'nearest' }));
}

/* one row per match: placement, when, your count, squad count. attr: 'sel' selects it in place, 'match' opens Matches */
function mrow(m, attr, mine = chestsOf(m).filter((o) => o.by === m.me).length) {
  const c = chestsOf(m);
  return `<button class="mitem ${attr === 'sel' && S.open === m.id ? 'on' : ''}" data-${attr}="${esc(m.id)}">${placeTag(m.placement)}
    <span class="mi-when"><b>${when(m)}</b><small>${Math.floor(m.duration / 60)} min${m.kills != null ? ' · ' + m.kills + ' elims' : ''}</small>${tagMini(m)}</span>
    <span class="mi-n"><b>${mine}</b><small>you</small></span><span class="mi-n gold"><b>${c.length}</b><small>squad</small></span></button>`;
}

/* ================= overview: dashboard ================= */
const SCOPES = [['today', 'Today'], ['7', '7 days'], ['30', '30 days'], ['all', 'All time']];
/** Matches in the chosen range; back = 1 gives the same-length range just before it (for the change %). */
function scoped(back = 0) {
  if (S.scope === 'all') return back ? null : D.matches;
  const len = S.scope === 'today' ? 1 : Number(S.scope), end = startOfDay(Date.now()) + DAY_MS - back * len * DAY_MS, start = end - len * DAY_MS;
  return D.matches.filter((m) => { const t = new Date(m.startUtc).getTime(); return t >= start && t < end; });
}
// stat cards in the style of the shop's V-Bucks packs: a rarity-coloured card, big centred number, optional hanging tab
const kpi = (label, value, sub, tone, i, tab = '') => `<div class="kpi ${tone} rise" style="--i:${i}">${tab}<span class="k-l">${label}</span><b class="k-v">${value}</b><span class="k-s">${sub}</span></div>`;
function ktab(now, before) {
  if (before == null || !before) return '';
  const p = ((now - before) / before) * 100;
  return `<span class="k-tab">${p >= 0 ? '+' : ''}${n1(p)}%<em>vs before</em></span>`;
}

function home() {
  const team = S.mode === 'team', ms = scoped(), pv = scoped(1);
  const pick = (m) => chestsOf(m).filter((o) => team || o.by === D.me);
  const all = ms.flatMap(chestsOf), mine = all.filter((o) => o.by === D.me), mates = all.filter((o) => o.by !== D.me);
  const shown = team ? all : mine;
  const per = ms.map((m) => pick(m).length), best = per.length ? Math.max(...per) : 0, bestM = ms[per.indexOf(best)];
  const minutes = sum(ms.map((m) => m.duration)) / 60, avg = ms.length ? shown.length / ms.length : 0;
  const pvShown = pv ? pv.flatMap(pick).length : null, pvAvg = pv?.length ? pvShown / pv.length : null;
  const split = (list) => `${list.filter((o) => !o.broken).length} opened · ${list.filter((o) => o.broken).length} broken`;
  const scopeName = S.scope === 'today' ? 'today' : S.scope === 'all' ? 'all time' : `last ${S.scope} days`;
  const vs = S.scope === 'today' ? 'vs yesterday' : `vs previous ${S.scope} days`;
  const change = (now, before) => (before == null ? '' : `<span class="k-d">${trend(now, before)}<em>${vs}</em></span>`);
  const others = ms.flatMap((m) => m.opens.filter((o) => !isChest(o.type) && (team || o.by === m.me))).length;

  const tools = `<div class="mode"><button class="${team ? '' : 'on'}" data-mode="me">Just you <i>${mine.length}</i></button><button class="${team ? 'on' : ''}" data-mode="team">With squad <i>${all.length}</i></button></div>
    <div class="range">${SCOPES.map(([k, t]) => `<button class="${S.scope === k ? 'on' : ''}" data-scope="${k}">${t}</button>`).join('')}</div>`;

  const kpis = `<div class="kpis">
    <div class="kpi hero rise" style="--i:0"><span class="k-l">${team ? 'Squad chests' : 'Your chests'} · ${scopeName}</span>
      <div class="k-big"><b class="k-num">${cnt(shown.length)}</b>${D.liveSince ? `<span class="k-plus">+${D.live.length}</span>` : ''}</div>
      ${change(shown.length, pvShown)}<span class="k-s">${ms.length} match${ms.length === 1 ? '' : 'es'} · ${split(shown)}${others ? ` · ${others} other containers not counted` : ''}</span></div>
    ${kpi('You', cnt(mine.length), split(mine), 'gold', 1)}
    ${kpi('Teammates', cnt(mates.length), split(mates), 'blue', 2)}
    ${kpi('Per match', cnt(Math.round(avg * 10) / 10, 1), team ? 'squad average' : 'your average', 'green', 3, ktab(avg, pvAvg))}
    ${kpi('Best match', cnt(best), bestM ? when(bestM) : '—', 'purple', 4)}
    ${kpi('Per minute', cnt(minutes ? Math.round((shown.length / minutes) * 10) / 10 : 0, 1), 'of match time', 'red', 5)}
  </div>`;

  // main chart: per match (clickable) or per day
  let labels, subs = null, ids = null, you, squad;
  if (S.chart === 'day') {
    const first = ms.length ? startOfDay(new Date(ms[0].startUtc).getTime()) : startOfDay(Date.now());
    const days = Math.min(60, Math.max(7, Math.round((startOfDay(Date.now()) - first) / DAY_MS) + 1));
    const ds = [...Array(days)].map((_, i) => startOfDay(Date.now()) - (days - 1 - i) * DAY_MS);
    const dm = ds.map((d0) => ms.filter((m) => { const t = new Date(m.startUtc).getTime(); return t >= d0 && t < d0 + DAY_MS; }));
    labels = ds.map((d) => DAYW.format(new Date(d)));
    subs = dm.map((x) => `${x.length} match${x.length === 1 ? '' : 'es'}`);
    you = dm.map((x) => x.flatMap(chestsOf).filter((o) => o.by === D.me).length);
    squad = dm.map((x) => x.flatMap(chestsOf).length);
  } else {
    const last = ms.slice(-40);
    labels = last.map(when);
    ids = last.map((m) => m.id);
    subs = last.map((m) => `${m.placement ? 'Placed #' + m.placement + ' · ' : ''}${Math.floor(m.duration / 60)} min`);
    you = last.map((m) => chestsOf(m).filter((o) => o.by === D.me).length);
    squad = last.map((m) => chestsOf(m).length);
  }
  const series = team ? [{ name: 'Squad', color: 'var(--mates)', vals: squad }, { name: 'You', color: 'var(--you)', vals: you }] : [{ name: 'You', color: 'var(--you)', vals: you }];
  const lead = series[0].vals, mean = lead.length ? sum(lead) / lead.length : 0;
  series.push({ name: 'Average', color: 'var(--muted)', vals: lead.map(() => mean), dash: true });
  const chart = `<section class="panel grow rise" style="--i:6">
    ${panelHead('Chests over time', S.chart === 'day' ? 'Per day · hover to see each day' : 'Last 40 matches · hover for details, click to open a match',
      `<div class="range sm"><button class="${S.chart === 'day' ? '' : 'on'}" data-chart="match">Per match</button><button class="${S.chart === 'day' ? 'on' : ''}" data-chart="day">Per day</button></div>`)}
    <div class="legend2">${series.map((s) => `<span><i class="${s.dash ? 'dash' : ''}" style="background:${s.color}"></i>${s.name}</span>`).join('')}</div>
    ${ichart(series, labels, { ids, subs, height: 300 })}
    ${labels.length ? `<div class="axis"><span>${esc(labels[0])}</span><span>${esc(labels.at(-1))}</span></div>` : ''}
  </section>`;

  const lastM = D.matches.at(-1);
  const side = `<div class="col">${D.liveSince ? liveCard() : lastM ? lastCard(lastM) : ''}
    <section class="panel rise" style="--i:8">${panelHead('Recent matches', '', '<button class="see" data-page="matches">All</button>')}
      <div class="mini">${D.matches.slice(-4).reverse().map((m) => mrow(m, 'match')).join('') || '<div class="empty">No matches yet</div>'}</div></section></div>`;

  // insights
  const bins = [...Array(8)].map((_, i) => shown.filter((o) => o.t >= i * 120 && o.t < (i + 1) * 120).length).concat(shown.filter((o) => o.t >= 960).length);
  const peakBin = bins.indexOf(Math.max(...bins));
  const count = (m) => pick(m).length;
  const placeGroups = [['Win', (p) => p === 1], ['Top 5', (p) => p > 1 && p <= 5], ['Top 10', (p) => p > 5 && p <= 10], ['Top 25', (p) => p > 10 && p <= 25], ['Lower', (p) => p > 25]]
    .map(([name, f]) => { const g = ms.filter((m) => m.placement && f(m.placement)); return { name, n: g.length, avg: g.length ? sum(g.map(count)) / g.length : 0 }; });
  const placeMax = Math.max(1, ...placeGroups.map((g) => g.avg));
  const squadSplit = D.players.map((p) => { const os = all.filter((o) => o.by === p.name); return { name: p.name, opened: os.filter((o) => !o.broken).length, broken: os.filter((o) => o.broken).length }; })
    .filter((x) => x.opened + x.broken > 0 && (team || x.name === D.me)).sort((a, b) => b.opened + b.broken - a.opened - a.broken);
  const splitMax = Math.max(1, ...squadSplit.map((x) => x.opened + x.broken));
  // small stat tiles that close each insight card, so the three cards end level
  const istats = (items) => `<div class="istats">${items.map(([v, l]) => `<div><b>${v}</b><small>${l}</small></div>`).join('')}</div>`;
  const firsts = ms.map((m) => pick(m).map((o) => o.t)).filter((ts) => ts.length).map((ts) => Math.min(...ts));
  const share = (f) => (shown.length ? Math.round((shown.filter(f).length / shown.length) * 100) + '%' : '—');
  const totOp = shown.filter((o) => !o.broken).length, totBr = shown.length - totOp;
  const SPLIT_TOP = 7;
  const brPct = (list) => (list.length ? Math.round((list.filter((o) => o.broken).length / list.length) * 100) + '%' : '—');
  const placed = ms.filter((m) => m.placement);
  const winAvg = placeGroups[0].avg, lowAvg = placeGroups[4].avg;
  const insights = `<div class="grid3">
    <section class="panel ins rise" style="--i:9">${panelHead('When in the match', shown.length ? `Most chests between minute ${peakBin * 2} and ${peakBin * 2 + 2}` : 'No chests yet')}
      ${barCard(bins, { hl: peakBin, tips: bins.map((v, i) => `<b>${i < 8 ? `Minute ${i * 2}–${i * 2 + 2}` : 'After minute 16'}</b><small>${v} chests</small>`) })}
      <div class="axis"><span>0:00</span><span>8:00</span><span>16:00+</span></div>
      ${istats([[firsts.length ? mmss(sum(firsts) / firsts.length) : '—', 'first chest, on average'], [share((o) => o.t < 240), 'in the first 4 minutes'], [share((o) => o.t >= 960), 'after minute 16']])}</section>
    <section class="panel ins rise" style="--i:10">${panelHead('Opened vs broken', 'Opening chests vs breaking them')}
      <div class="sbar total" ${tipAttr(`<b>${team ? 'Squad' : 'You'}</b><small>${totOp} opened · ${totBr} broken</small>`)}><i class="op" style="flex:${totOp || 1}"></i><i class="br" style="flex:${totBr}"></i></div>
      <div class="legend2"><span><i style="background:#3ccf6e"></i>Opened ${shown.length ? Math.round((totOp / shown.length) * 100) : 0}%</span><span><i style="background:#ff8a3d"></i>Broken ${shown.length ? Math.round((totBr / shown.length) * 100) : 0}%</span></div>
      <div class="split">${squadSplit.slice(0, SPLIT_TOP).map((x) => `<div class="srow2" data-who="${esc(x.name === D.me ? 'me' : x.name)}" ${tipAttr(`<b>${esc(x.name)}</b><small>${x.opened} opened · ${x.broken} broken · ${Math.round((x.broken / (x.opened + x.broken)) * 100)}% broken</small>`)}>${avatar(x.name, 'xs')}<span class="nm">${esc(x.name)}</span>
        <span class="sbar" style="width:${((x.opened + x.broken) / splitMax) * 100}%"><i class="op" style="flex:${x.opened}"></i><i class="br" style="flex:${x.broken}"></i></span></div>`).join('') || '<div class="empty">No chests yet</div>'}</div>
      ${squadSplit.length > SPLIT_TOP ? `<button class="see more" data-page="player">+${squadSplit.length - SPLIT_TOP} more players</button>` : ''}
      ${istats([[brPct(mine), 'of your chests broken'], [brPct(mates), 'teammates’ broken'], [ms.length ? n1(totBr / ms.length) : '—', 'broken per match']])}</section>
    <section class="panel ins rise" style="--i:11">${panelHead('Placement vs chests', `${team ? 'Squad' : 'Your'} chests per match by final placement`)}
      <div class="place">${placeGroups.map((g) => `<div class="prow2" ${tipAttr(`<b>${g.name}</b><small>${g.n} match${g.n === 1 ? '' : 'es'} · ${n1(g.avg)} chests on average</small>`)}><span class="nm">${g.name}</span><span class="pbar"><i style="width:${(g.avg / placeMax) * 100}%"></i></span><b>${g.n ? n1(g.avg) : '—'}</b></div>`).join('')}</div>
      ${winAvg && lowAvg ? `<p class="ins-note">Wins average <b>${n1(winAvg / lowAvg)}×</b> the chests of placements below 25th.</p>` : ''}
      ${istats([[placed.length ? '#' + n1(sum(placed.map((m) => m.placement)) / placed.length) : '—', 'average placement'], [placeGroups[0].n, `win${placeGroups[0].n === 1 ? '' : 's'}`], [placed.length ? '#' + Math.min(...placed.map((m) => m.placement)) : '—', 'best placement']])}</section>
  </div>`;

  // squad leaderboard
  const board = D.players.map((p) => {
    const os = all.filter((o) => o.by === p.name), games = ms.filter((m) => m.squad.includes(p.name));
    const perM = games.map((m) => chestsOf(m).filter((o) => o.by === p.name).length);
    return { name: p.name, n: os.length, g: games.length, avg: games.length ? os.length / games.length : 0, best: perM.length ? Math.max(...perM) : 0, br: os.length ? os.filter((o) => o.broken).length / os.length : 0, sp: perM.slice(-10) };
  }).filter((x) => x.g).sort((a, b) => b.n - a.n);
  const table = `<section class="panel rise" style="--i:12">${panelHead('Squad leaderboard', `${scopeName} · click a player for their profile`, '<button class="see" data-page="player">Players</button>')}
    ${board.length ? `<table class="tbl"><thead><tr><th>#</th><th>Player</th><th class="r">Chests</th><th class="r">Matches</th><th class="r">Per match</th><th class="r">Best</th><th class="r">Broken</th><th class="r">Last 10</th></tr></thead>
    <tbody>${board.map((x, i) => `<tr data-who="${esc(x.name === D.me ? 'me' : x.name)}"><td class="rk">${i + 1}</td><td><span class="who">${avatar(x.name, 'xs')}${esc(x.name)}${x.name === D.me ? '<span class="vbadge">YOU</span>' : ''}</span></td>
      <td class="r"><b>${NUM.format(x.n)}</b></td><td class="r">${x.g}</td><td class="r">${n1(x.avg)}</td><td class="r">${x.best}</td><td class="r">${Math.round(x.br * 100)}%</td><td class="r">${spark(x.sp, colorOf(x.name))}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">No players in this range</div>'}</section>`;

  return head('Overview', `${D.matches.length} matches read from your replays${D.backups.count ? ` · ${D.backups.count} backed up` : ''}`, tools)
    + kpis + `<div class="dash">${chart}${side}</div>` + insights + featureRow() + table
    + '<div class="credit">Made by Reanex</div>';
}

const liveCard = () => `<section class="panel livecard rise" style="--i:7"><div class="ph"><h2>Live match</h2><span class="pill-live">Live</span></div>
  <div class="lc-time" id="liveTimer">${mmss((Date.now() - D.liveSince) / 1000)}</div>
  <div class="lc-n"><b>+${D.live.length}</b><span>chests added with your hotkey</span></div>
  <small class="muted">The replay sets the exact count, teammates included, when the match ends.</small></section>`;

function lastCard(m) {
  const c = chestsOf(m), counts = m.squad.map((p) => [p, c.filter((o) => o.by === p).length]).sort((a, b) => b[1] - a[1]), top = Math.max(1, ...counts.map((x) => x[1]));
  return `<section class="panel lastcard rise" style="--i:7">${panelHead('Last match', `${when(m)} · ${Math.floor(m.duration / 60)} min`, placeTag(m.placement))}
    <div class="lm-tot"><b>${c.length}</b><span>squad chests</span></div>
    <div class="lm-bars">${counts.map(([p, n]) => `<div class="lm-row">${avatar(p, 'xs')}<span class="nm">${esc(p)}</span><span class="lm-bar"><i style="width:${(n / top) * 100}%;background:${colorOf(p)}"></i></span><b>${n}</b></div>`).join('')}</div>
    <button class="btn sm" data-match="${esc(m.id)}">Open match ${ICON.open}</button></section>`;
}

/* ================= players: list + profile ================= */
const whoName = (w = S.who) => (w === 'me' ? D.me : w);
const isTeam = (w = S.who) => w === 'team';
const byWho = (w = S.who) => (o) => isTeam(w) || o.by === whoName(w);
const whoMatches = (w = S.who) => (isTeam(w) ? D.matches : D.matches.filter((m) => m.squad.includes(whoName(w))));
const countIn = (m, w = S.who) => chestsOf(m).filter(byWho(w)).length;
const skinName = (id) => (id || '').replace(/^Character_/, '').replace(/^CID_[A-Z]?_?\d+_Athena_Commando_[MF]_/, '').replace(/([a-z])([A-Z])/g, '$1 $2');

function player() {
  const team = isTeam(), name = whoName();
  const list = `<aside class="plist rise">
    <button class="pl ${team ? 'on' : ''}" data-who="team"><span class="avatar sm team">${ICON.team}</span><span class="pl-m"><b>Squad</b><small>${D.players.length} players</small></span><b class="pl-n">${NUM.format(D.chests.length)}</b></button>
    ${D.players.map((x) => `<button class="pl ${!team && x.name === name ? 'on' : ''}" data-who="${esc(x.name === D.me ? 'me' : x.name)}">${avatar(x.name, 'sm')}<span class="pl-m"><b>${esc(x.name)}</b><small>${x.played} matches · ${n1(x.total / x.played)} / match</small></span><b class="pl-n">${NUM.format(x.total)}</b></button>`).join('')}
  </aside>`;
  return head('Players', `${D.players.length} players in your squad`) + `<div class="psplit">${list}<div class="pmain">${profile(team, name)}</div></div>`;
}

function profile(team, name) {
  const ms = whoMatches(), per = ms.map((m) => countIn(m)), sel = D.chests.filter(byWho());
  const rank = team ? null : D.players.findIndex((x) => x.name === name) + 1;
  const today = startOfDay(Date.now()), week = today - 6 * DAY_MS;
  const avg = ms.length ? sel.length / ms.length : 0, best = per.length ? Math.max(...per) : 0;
  const recent = per.slice(-30), recentMs = ms.slice(-30);
  const moving = recent.map((_, i) => { const k = per.length - recent.length + i, w = per.slice(Math.max(0, k - 4), k + 1); return sum(w) / w.length; });
  const weeks = [...Array(6)].map((_, i) => week - (5 - i) * 7 * DAY_MS), weekN = weeks.map((s) => sel.filter((o) => o.at >= s && o.at < s + 7 * DAY_MS).length);
  const days = [...Array(30)].map((_, i) => today - (29 - i) * DAY_MS), dayN = days.map((s) => sel.filter((o) => o.at >= s && o.at < s + DAY_MS).length);
  const hourN = [...Array(24)].map((_, h) => sel.filter((o) => new Date(o.at).getHours() === h).length), bestHour = hourN.indexOf(Math.max(...hourN));
  const allOpens = D.opens.filter(byWho());
  const typeN = Object.keys(TYPES).map((t) => [t, allOpens.filter((o) => o.type === t).length]).filter(([t, n]) => n || t === 'chest').sort((a, b) => b[1] - a[1]);
  const typeMax = Math.max(1, ...typeN.map(([, n]) => n));
  const growth = weekN[4] ? ((weekN[5] - weekN[4]) / weekN[4]) * 100 : null;
  const perOf = (nm) => D.matches.filter((m) => m.squad.includes(nm)).map((m) => chestsOf(m).filter((o) => o.by === nm).length);
  const stat = (f) => D.players.map((x) => ({ n: x.name, v: f(x) })).sort((a, b) => b.v - a.v);
  const standings = team ? [] : [['Total chests', stat((x) => x.total)], ['Per match', stat((x) => x.total / x.played)], ['Best match', stat((x) => Math.max(0, ...perOf(x.name)))], ['Breaks the most', stat((x) => { const os = D.chests.filter((o) => o.by === x.name); return os.length ? os.filter((o) => o.broken).length / os.length : 0; })]];
  const p30 = per.slice(-30), m30 = ms.slice(-30), color = team ? 'var(--mates)' : colorOf(name);

  const top = `<div class="phead rise">${team ? `<span class="avatar lg team">${ICON.team}</span>` : avatar(name, 'lg')}
    <div><h2 class="pname">${esc(team ? 'Squad' : name)}${!team && name === D.me ? '<span class="vbadge">YOU</span>' : ''}</h2>
      <div class="psub">${team ? `${D.players.length} players` : name === D.me ? 'Replay owner' : 'Teammate'}${!team && D.skins[name] ? ` · ${esc(skinName(D.skins[name]))}` : ''}</div>
      <div class="ptags">${team ? '' : `<span>#${rank} in squad</span>`}<span>${ms.length} matches</span></div></div></div>
    <div class="utabs"><button class="utab ${S.ptab === 'overview' ? 'on' : ''}" data-ptab="overview">Overview</button><button class="utab ${S.ptab === 'matches' ? 'on' : ''}" data-ptab="matches">Matches</button></div>`;
  if (S.ptab === 'matches') return top + `<section class="panel mini rise" style="margin-top:16px">${ms.length ? ms.slice().reverse().slice(0, 300).map((m) => mrow(m, 'match', countIn(m))).join('') : '<div class="empty">No matches yet</div>'}</section>`;

  return top + `
    <div class="strip rise" style="--i:1">
      <div><small>Total</small><b>${cnt(sel.length)}</b></div><div><small>Rank</small><b>${team ? '—' : '#' + rank}</b></div><div><small>Matches</small><b>${cnt(ms.length)}</b></div>
      <div><small>Per match</small><b>${cnt(Math.round(avg * 10) / 10, 1)}</b></div><div><small>Best match</small><b>${cnt(best)}</b></div><div><small>This week</small><b>${cnt(weekN[5])}</b></div>
    </div>
    <div class="pgrid">
      <div class="card span2 rise" style="--i:2"><div class="ch"><b>Chests per match</b>${D.liveSince ? '<span class="pill-live">Live</span>' : ''}</div>
        <div class="cbig">${cnt(recent.at(-1) ?? 0)} ${trend(recent.at(-1) ?? 0, avg)}</div><div class="csub">last match · average ${n1(avg)} · hover the line for every match</div>
        ${ichart([{ name: 'Chests', color, vals: recent }, { name: '5-match average', color: 'var(--muted)', vals: moving, dash: true }], recentMs.map(when),
          { ids: recentMs.map((m) => m.id), subs: recentMs.map((m) => `${m.placement ? 'Placed #' + m.placement + ' · ' : ''}${Math.floor(m.duration / 60)} min`), height: 200 })}</div>
      <div class="card rise" style="--i:3"><div class="ch"><b>Growth</b></div>
        <div class="cbig">${growth == null ? cnt(weekN[5]) : `<span class="${growth >= 0 ? 'up' : 'down'}">${growth >= 0 ? '▲' : '▼'} ${n1(Math.abs(growth))}%</span>`}</div><div class="csub">this week ${weekN[5]} · last week ${weekN[4]}</div>
        ${barCard(weekN, { cls: 'wide', labels: true })}<div class="wl">${weeks.map((s) => `<span>${DAY.format(new Date(s))}</span>`).join('')}</div></div>
      <div class="card span2 rise" style="--i:4"><div class="ch"><b>Daily</b></div><div class="cbig">${cnt(dayN[29])} ${trend(dayN[29], sum(dayN.slice(0, 29)) / 29 || 0)}</div><div class="csub">today · ${NUM.format(sum(dayN))} in the last 30 days</div>
        ${barCard(dayN, { tips: days.map((d, i) => `<b>${DAYW.format(new Date(d))}</b><small>${dayN[i]} chests</small>`) })}<div class="axis"><span>${DAY.format(days[0])}</span><span>${DAY.format(days[29])}</span></div></div>
      <div class="card rise" style="--i:5"><div class="ch"><b>Peak</b></div><div class="cbig">${cnt(best)}</div><div class="csub">most in one match · last ${p30.length}</div>
        ${barCard(p30, { hl: p30.lastIndexOf(Math.max(0, ...p30)), tips: m30.map((m, i) => `<b>${when(m)}</b><small>${p30[i]} chests</small>`) })}</div>
      <div class="card span2 rise" style="--i:6"><div class="ch"><b>Hours</b></div><div class="cbig">${sel.length ? String(bestHour).padStart(2, '0') + ':00' : '—'}</div><div class="csub">${sel.length ? `best hour · ${hourN[bestHour]} chests` : 'no data yet'}</div>
        ${barCard(hourN, { hl: sel.length ? bestHour : -1, cls: 'gold', tips: hourN.map((v, h) => `<b>${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00</b><small>${v} chests</small>`) })}<div class="axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div></div>
      <div class="card rise" style="--i:7"><div class="ch"><b>${team ? 'Players' : 'Standing in squad'}</b></div>
        <div class="lrows">${team ? D.players.map((x, i) => `<div class="lrow" data-who="${esc(x.name === D.me ? 'me' : x.name)}" style="cursor:pointer">${avatar(x.name)}<span class="meta"><b>${esc(x.name)}</b><small>${x.played} matches · ${n1(x.total / x.played)} / match</small></span><span class="rk">#${i + 1}</span></div>`).join('')
          : standings.map(([t, l]) => `<div class="lrow"><span class="meta"><b>${t}</b><small>among ${l.length} players</small></span><span class="rk">#${l.findIndex((x) => x.n === name) + 1}</span></div>`).join('')}</div></div>
      <div class="card span2 rise" style="--i:8"><div class="ch"><b>Containers</b><span class="csub">${NUM.format(allOpens.length)} searched or broken · only chests count</span></div>
        <div class="lrows two">${typeN.map(([t, n], i) => `<div class="lrow">${iconTile(t, '', 'sm')}<span class="meta"><b>${esc(typeName(t))}${isChest(t) ? '' : ' <em class="muted">not counted</em>'}</b><div class="meter"><i style="--w:${n / typeMax};--c:${TYPES[t].c};--i:${i}"></i></div></span><span class="rk">${n}</span></div>`).join('')}</div></div>
      <div class="card rise" style="--i:9"><div class="ch"><b>Recent matches</b><button class="see" data-ptab="matches">All</button></div>
        <div class="mini">${ms.length ? ms.slice(-5).reverse().map((m) => mrow(m, 'match', countIn(m))).join('') : '<div class="empty">No matches yet</div>'}</div></div>
    </div>`;
}

/* ================= matches: list + detail ================= */
function matches() {
  let ms = D.matches.slice().reverse();
  if (S.mwho !== 'all') ms = ms.filter((m) => m.squad.includes(S.mwho));
  if (S.mtag) ms = ms.filter((m) => tagsOf(m).includes(S.mtag));
  if (S.msort === 'chests') ms.sort((a, b) => chestsOf(b).length - chestsOf(a).length);
  if (S.msort === 'place') ms.sort((a, b) => (a.placement || 999) - (b.placement || 999));
  const sel = ms.find((m) => m.id === S.open) || ms[0];
  if (sel) S.open = sel.id;
  const total = sum(D.matches.map((m) => chestsOf(m).length));
  const tools = `<div class="range">${[['new', 'Newest'], ['chests', 'Most chests'], ['place', 'Best placement']].map(([k, t]) => `<button class="${S.msort === k ? 'on' : ''}" data-msort="${k}">${t}</button>`).join('')}</div>`;
  // player filter: Everyone + the most frequent teammates as avatar chips; the rest sit behind a searchable "More" list
  const games = (n) => D.matches.filter((m) => m.squad.includes(n)).length;
  const ranked = D.players.map((p) => [p.name, games(p.name)]).filter((x) => x[1]).sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 5).map((x) => x[0]);
  if (S.mwho !== 'all' && !top.includes(S.mwho)) top.push(S.mwho);
  const rest = ranked.length - ranked.slice(0, 5).length;
  const chip = (k, label, n) => `<button class="pchip ${S.mwho === k ? 'on' : ''}" data-mwho="${esc(k)}">${k === 'all' ? '<span class="pc-all">ALL</span>' : avatar(k, 'xs')}<b>${esc(label)}</b>${n != null ? `<em>${n}</em>` : ''}</button>`;
  const who = `<div class="pchips">${chip('all', 'Everyone', D.matches.length)}${top.map((n) => chip(n, n, games(n))).join('')}${rest > 0 ? `<button class="pchip more" data-act="mwhoMore">+${rest} more<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 4.5l3 3 3-3"/></svg></button>` : ''}</div>`;
  window.MWHO_REST = ranked.slice(5); // for the "More" list
  return head('Matches', `${D.matches.length} matches · ${NUM.format(total)} squad chests`, tools)
    + (D.matches.length ? `<div class="mtools">${who}${tagFilter()}<span class="muted">${ms.length} shown</span></div>
      <div class="msplit"><div class="mlist2 panel rise" id="mlist">${ms.slice(0, 400).map((m) => mrow(m, 'sel')).join('') || '<div class="empty">No matches for this player</div>'}</div>
      <div class="mpane" id="mpane">${sel ? matchPane(sel) : ''}</div></div>`
      : '<div class="empty">No matches yet. Turn on Fortnite › Settings › Game › Replays › Record Replays; a match shows up here when it ends.</div>');
}

function matchPane(m) {
  const dur = Math.max(1, m.duration), c = chestsOf(m);
  const rows = m.squad.map((p) => { const os = m.opens.filter((o) => o.by === p); return { p, op: os.filter((o) => isChest(o.type) && !o.broken).length, br: os.filter((o) => isChest(o.type) && o.broken).length, other: os.filter((o) => !isChest(o.type)).length }; })
    .sort((a, b) => b.op + b.br - a.op - a.br);
  // cumulative chests per player, sampled across the match so the crosshair can read any moment
  const N = Math.min(150, Math.max(24, Math.round(dur / 6))), ts = [...Array(N)].map((_, i) => (i / (N - 1)) * dur);
  const series = m.squad.map((p) => { const t = c.filter((o) => o.by === p).map((o) => o.t); return { name: p, color: colorOf(p), vals: ts.map((x) => t.filter((v) => v <= x).length), fmt: (v) => String(v) }; });
  return `<section class="panel mp rise">
    <div class="mp-head"><div class="mp-title">${placeTag(m.placement)}<div><h2>${when(m)}</h2><small>${Math.floor(dur / 60)} min${m.kills != null ? ` · ${m.kills} elims` : ''} · ${m.squad.length} players</small></div></div>
      <div class="mp-tot"><b>${c.length}</b><small>squad chests</small></div></div>
    ${tagRow(m)}<div class="mp-players">${rows.map((r) => `<div class="mpc" data-who="${esc(r.p === D.me ? 'me' : r.p)}">${avatar(r.p, 'sm')}<div class="mpc-m"><b>${esc(r.p)}</b><small>${r.op} opened · ${r.br} broken${r.other ? ` · ${r.other} other` : ''}</small></div><span class="mpc-n" style="color:${colorOf(r.p)}">${r.op + r.br}</span></div>`).join('')}</div>
    ${panelHead('Timeline', 'Chests over the match · hover to read any moment')}
    ${ichart(series, ts.map((t) => mmss(t)), { step: true, area: false, height: 190 })}
    <div class="axis"><span>0:00</span><span>${mmss(dur / 2)}</span><span>${mmss(dur)}</span></div>
    ${panelHead('Containers', `${m.opens.length} searched or broken · only chests count`)}
    <div class="olist">${m.opens.length ? m.opens.map((o) => `<div class="orow ${isChest(o.type) ? '' : 'dim'}"><time>${mmss(o.t)}</time>${pic(o.type)}<span class="dot" style="--c:${colorOf(o.by)}"></span><b>${esc(o.by)}</b><span class="muted">${esc(typeName(o.type))}${o.broken ? ' · broken' : ''}</span></div>`).join('') : '<div class="empty">No containers this match</div>'}</div>
  </section>`;
}

/* ================= simulator (ui/sim.js) ================= */
// what the simulator needs from the replays: your chests, the squad's, your pace, the chest picture
window.D_FOR_SIM = () => {
  const mine = D.chests.filter((o) => o.by === D.me).length;
  const days = new Set(D.matches.map((m) => startOfDay(new Date(m.startUtc).getTime()))).size || 1;
  return { mine, squad: D.chests.length, perDay: Math.round((mine / days) * 10) / 10, img: D.images.has('chest') ? IMG + 'chest.png' : '' };
};
const map = () => head('Map', 'Chest spots from fortnite.gg · draw and save your looting route') + '<div id="mapRoot"></div>';
const sim = () => head('Chest simulator', 'Treasure Hunters odds published by Epic · Space opens a chest') + '<div id="simRoot"></div>';

/* ================= settings ================= */
const VK = { 0x70: 'F1', 0x71: 'F2', 0x72: 'F3', 0x73: 'F4', 0x74: 'F5', 0x75: 'F6', 0x76: 'F7', 0x77: 'F8', 0x78: 'F9', 0x79: 'F10', 0x7A: 'F11', 0x7B: 'F12', 0x2D: 'Insert', 0x24: 'Home', 0x21: 'Page Up', 0x22: 'Page Down', 0x23: 'End', 0x2E: 'Delete', 0x6B: 'Num +', 0x6D: 'Num −', 0x08: 'Backspace', 0x09: 'Tab', 0x0D: 'Enter', 0x20: 'Space', 0xBA: ';', 0xBB: '=', 0xBC: ',', 0xBD: '-', 0xBE: '.', 0xBF: '/', 0xC0: '`', 0xDB: '[', 0xDC: '\\', 0xDD: ']', 0xDE: "'" };
const keyName = (vk) => VK[vk] || (vk >= 0x30 && vk <= 0x5A ? String.fromCharCode(vk) : vk >= 0x60 && vk <= 0x69 ? 'Num ' + (vk - 0x60) : 'Key ' + vk);
let capture = null; // which hotkey is waiting for a key press

const STABS = [
  ['overlay', 'In-game overlay', '<rect x="3" y="4" width="18" height="14" rx="2"/><rect x="6" y="7" width="6" height="4" rx="1"/>'],
  ['hotkeys', 'Hotkeys', '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'],
  ['broadcast', 'Broadcast', '<path d="M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4"/><circle cx="12" cy="12" r="1.6"/>'],
  ['appearance', 'Appearance', '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>'],
  ['replays', 'Replays', '<path d="M3 5h7l2 2h9v12H3z"/>'],
  ['startup', 'Startup', '<path d="M12 3v8"/><path d="M6.3 6.6a8 8 0 1 0 11.4 0"/>'],
  ['about', 'About', '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>'],
];

function settings() {
  const s = D.settings, mb = (D.backups.bytes / 1048576).toFixed(0);
  const seg = (key, opts) => `<div class="range">${opts.map(([v, t]) => `<button class="${String(s[key]) === String(v) ? 'on' : ''}" data-set="${key}" data-val="${v}">${t}</button>`).join('')}</div>`;
  const slider = (key, min, max, unit = '') => `<span class="sl"><input type="range" min="${min}" max="${max}" value="${s[key]}" data-range="${key}" style="--p:${((s[key] - min) / (max - min)) * 100}%"><b>${s[key]}${unit}</b></span>`;
  const swatches = ['#3CCF6E', '#2DD4BF', '#3B9CFF', '#6D7BFF', '#9B7BFF', '#FF5C8A', '#FF7A3D', '#FFC93C', '#FFFFFF'];
  const toggle = (key, title, sub) => `<div class="srow"><span><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span><button class="switch ${s[key] ? 'on' : ''}" data-toggle="${key}" aria-label="${title}"><i></i></button></div>`;
  const row = (title, sub, ctl) => `<div class="srow"><span><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span>${ctl}</div>`;
  // the map card over the game (RouteOverlay.cs) and the full-screen map (MapFull.cs); its words are translated in map.js
  const keyBtn = (k) => `<button class="btn key ${capture === k ? 'wait' : ''}" data-capture="${k}">${capture === k ? 'Press a key…' : keyName(s[k])}</button>`;
  const mapOverlay = () => `<section class="panel rise map-ovs" style="--i:2">${panelHead('Map overlay', 'The map card over Fortnite during a match: your route, the chests and you. Placed and styled on its own, like the chest panel.', `<button class="switch ${s.routeOverlay ? 'on' : ''}" data-toggle="routeOverlay" aria-label="Map overlay"><i></i></button>`)}
      ${row('Card zoom', 'How close the card follows you', slider('routeZoom', 50, 300, '%'))}
      ${row('Corner', '', seg('mapCorner', [['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']]))}
      ${row('Offset X', '', slider('mapX', 0, 800, ' px'))}
      ${row('Offset Y', '', slider('mapY', 0, 800, ' px'))}
      ${row('Size', '', slider('mapScale', 60, 200, '%'))}
      ${row('Opacity', '', slider('mapOpacity', 30, 100, '%'))}
      ${row('Style', '', seg('mapStyle', [['glass', 'Glass'], ['solid', 'Solid'], ['minimal', 'Minimal'], ['none', 'None']]))}
      ${toggle('mapHeader', 'Show title', 'Route, distance and keys above the map')}
      ${toggle('mapPointers', 'Chests in view', 'Marks nearby chest spots you are facing on screen, with their rough distance')}
      ${row('Chests in view: on / off', '', keyBtn('pointerKey'))}
      ${row('Chests in view: range', 'Only spots closer than this', slider('mapPointerRange', 20, 150, ' m'))}
      ${row('Accent', '', `<span class="swatches">${swatches.map((c) => `<button class="swatch ${(s.mapAccent || '').toUpperCase() === c ? 'on' : ''}" style="--c:${c}" data-set="mapAccent" data-val="${c}" aria-label="${c}"></button>`).join('')}<button class="swatch custom" style="--c:${esc(s.mapAccent)}" data-picker="mapAccent" title="Custom colour" aria-label="Custom colour"></button></span>`)}
      ${row('Stop size', 'The chests on your route', slider('routeDot', 40, 250, '%'))}
      ${row('Show / hide', '', keyBtn('routeKey'))}
      ${row('Bigger card', '', keyBtn('routeBigKey'))}
      ${row('Full-screen map', 'Scroll to zoom, drag to move; the same key or Esc closes it', keyBtn('routeFullKey'))}
      ${row('Route from here', 'A new route from where you stand; the old one is kept in Saved routes', keyBtn('routeHereKey'))}
      ${toggle('mapTrack', 'Track my position', 'Reads the minimap while you play')}
      ${row('Tracking quality', 'Higher reads the minimap more often: smoother and more exact, a bit more CPU', seg('trackQuality', [['low', 'Low'], ['balanced', 'Balanced'], ['high', 'High']]))}
      <div class="map-card-pv" id="mapCardPv" aria-label="Map card preview"></div>
    </section>`;

  const sections = {
    overlay: () => `<div class="ovl">
      <section class="panel rise">${panelHead('In-game panel', 'Your own chests over Fortnite, only while it is the active window. It can’t be clicked, so it never takes focus from the game.', `<button class="switch ${s.hud ? 'on' : ''}" data-toggle="hud" aria-label="In-game panel"><i></i></button>`)}
        ${row('Corner', '', seg('hudCorner', [['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']]))}
        ${row('Offset X', '', slider('hudX', 0, 600, ' px'))}
        ${row('Offset Y', '', slider('hudY', 0, 400, ' px'))}
        ${row('Size', '', slider('hudScale', 60, 200, '%'))}
        ${row('Opacity', '', slider('hudOpacity', 30, 100, '%'))}
        ${row('Style', '', seg('hudStyle', [['glass', 'Glass'], ['solid', 'Solid'], ['minimal', 'Minimal']]))}
        ${row('Accent', '', `<span class="swatches">${swatches.map((c) => `<button class="swatch ${(s.hudAccent || '').toUpperCase() === c ? 'on' : ''}" style="--c:${c}" data-set="hudAccent" data-val="${c}" aria-label="${c}"></button>`).join('')}<button class="swatch custom" style="--c:${esc(s.hudAccent)}" data-picker="hudAccent" title="Custom colour" aria-label="Custom colour"></button></span>`)}
        ${toggle('hudPlus', 'Show “+this match”', 'The live number next to the total')}
        ${toggle('hudLabels', 'Show labels', 'The CHESTS / THIS MATCH captions')}
        ${toggle('hudHints', 'Show hotkey hints', 'The “F8 +1 · F9 −1” line on the overlay')}
        ${toggle('hudRecord', 'Record alerts', 'During a match: how close you are to your best match, and “New record!” when you pass it')}
      </section>
      <section class="panel sticky rise" style="--i:1">${panelHead('Preview', 'How it sits on a 1080p game')}
        <div class="preview" id="preview"><div class="pv-game"></div><div class="pv-hud" id="pvHud"></div></div>
        <div class="pv-actual"><small>Actual size</small><div class="pv-hud" id="pvHud2"></div></div>
      </section></div>${mapOverlay()}`,
    hotkeys: () => `<section class="panel rise">${panelHead('Hotkeys', 'Count your chests during a match with a key, including chests broken from below. The replay sets the exact count when the match ends.')}
      ${row('Add a chest', 'Press during a match', `<button class="btn key ${capture === 'addKey' ? 'wait' : ''}" data-capture="addKey">${capture === 'addKey' ? 'Press a key…' : keyName(s.addKey)}</button>`)}
      ${row('Remove a chest', 'Undo a wrong count', `<button class="btn key ${capture === 'removeKey' ? 'wait' : ''}" data-capture="removeKey">${capture === 'removeKey' ? 'Press a key…' : keyName(s.removeKey)}</button>`)}
      ${row('Your Fortnite keys', `Interact: ${esc(D.keys.interact.join(', ') || '—')} · Attack: ${esc(D.keys.attack.join(', ') || '—')} (read from Fortnite)`, '')}
    </section>`,
    broadcast: () => `<section class="panel rise">${panelHead('Broadcast', 'Play a video over the screen of everyone who runs ReChest. The signal only says “play”: each app plays its own built-in video, so nothing but the trigger is sent.')}
      ${row('Send to everyone', 'Starts the video on every open ReChest', '<button class="btn accent" data-act="broadcast">Send</button>')}
      ${toggle('receiveBroadcasts', 'Receive others’ broadcasts', 'Let others start the video on your screen')}
    </section>`,
    appearance: () => `<section class="panel rise">${panelHead('Language')}
      <div class="range langs">${[['en', 'English'], ['tr', 'Türkçe']].map(([k, l]) => `<button class="${(window.I18N?.lang || 'en') === k ? 'on' : ''}" data-lang="${k}"><span class="no-tr" lang="${k}">${l}</span></button>`).join('')}</div>
    </section>
    <section class="panel rise">${panelHead('Appearance')}
      <div class="themes">${[['black', 'Black', 'black'], ['blue', 'Blue', 'dark'], ['light', 'Light', 'light'], ['system', 'Windows', 'system']].map(([k, t, art]) => `<button class="tpick ${THEME === k ? 'on' : ''}" data-themeset="${k}"><span class="tp-art ${art}"><i></i><i></i><i></i></span><b${k === "system" ? " lang=\"en\"" : ""}>${t}</b></button>`).join('')}</div>
      ${row('Animations', 'Chart and card entrance motion', `<button class="switch ${S.motion ? 'on' : ''}" data-act="motion" aria-label="Animations"><i></i></button>`)}
    </section>
    <section class="panel rise" style="--i:1">${panelHead('Background', 'Behind every page. Only on this PC.')}
      <div class="bgkinds">${[['theme', 'Theme'], ['color', 'Colour'], ['image', 'Picture']].map(([k, t]) => `<button class="bgk ${k} ${BG.kind === k ? 'on' : ''}" data-bgkind="${k}" style="--bg-c:${esc(BG.color)};--bg-url:${BG.img ? `url('${BG.img}')` : 'none'}"><span class="bgk-art"></span><b>${t}</b></button>`).join('')}</div>
      ${BG.kind === 'color' ? row('Colour', 'Pick any colour; the page shades it from light to dark', `<span class="swatches">${PICK_PRESETS.map((c) => `<button class="swatch ${BG.color.toLowerCase() === c ? 'on' : ''}" style="--c:${c}" data-bgcolor="${c}" aria-label="${c}"></button>`).join('')}<button class="swatch custom" style="--c:${esc(BG.color)}" data-picker="bg" title="Custom colour" aria-label="Custom colour"></button></span>`) : ''}
      ${BG.kind === 'image' ? `${row('Picture', BG.img ? 'Shown behind the pages, filling the window' : 'Choose a picture from your PC', `<span class="bg-file">${BG.img ? `<span class="bg-thumb" style="background-image:url('${BG.img}')"></span><button class="see" data-act="bgclear">Remove</button>` : ''}<label class="btn">${ICON.folder} Choose<input type="file" accept="image/*" id="bgFile" hidden></label></span>`)}
        ${row('Darken', 'Keeps text readable on busy pictures', `<span class="sl"><input type="range" min="0" max="85" value="${BG.dim}" data-bgrange="dim" style="--p:${(BG.dim / 85) * 100}%"><b>${BG.dim}%</b></span>`)}
        ${row('Blur', '', `<span class="sl"><input type="range" min="0" max="24" value="${BG.blur}" data-bgrange="blur" style="--p:${(BG.blur / 24) * 100}%"><b>${BG.blur} px</b></span>`)}` : ''}
    </section>
    <section class="panel rise" style="--i:2">${panelHead('Glass', 'The frosted, see-through look of the panels and bars')}
      ${row('Glass effect', 'Off makes every panel solid', `<button class="switch ${GLASS.on ? 'on' : ''}" data-act="glass" aria-label="Glass effect"><i></i></button>`)}
      ${GLASS.on ? `${row('Blur', 'How much the background is frosted behind panels', `<span class="sl"><input type="range" min="0" max="40" value="${GLASS.blur}" data-glassrange="blur" style="--p:${(GLASS.blur / 40) * 100}%"><b>${GLASS.blur} px</b></span>`)}
        ${row('Panel opacity', 'Higher is more solid; lower lets the background show through', `<span class="sl"><input type="range" min="0" max="100" value="${GLASS.solid}" data-glassrange="solid" style="--p:${GLASS.solid}%"><b>${GLASS.solid}%</b></span>`)}` : ''}
    </section>
    <section class="panel rise" style="--i:3">${panelHead('Sounds', 'A short chime for new matches, live chests and your daily goal')}
      ${row('Sounds', '', `<button class="switch ${FX.sound ? 'on' : ''}" data-act="sound" aria-label="Sounds"><i></i></button>`)}
      ${row('Volume', '', `<span class="sl"><input type="range" min="0" max="100" value="${Math.round(FX.vol * 100)}" data-fxvol="1" style="--p:${Math.round(FX.vol * 100)}%"><b>${Math.round(FX.vol * 100)}%</b></span>`)}
    </section>`,
    replays: () => `<section class="panel rise">${panelHead('Replays')}
      ${row('Replay folder', D.demos ? 'Found. Matches are read a few seconds after they end.' : 'Not found: Fortnite › Settings › Game › Replays › Record Replays.', `<button class="btn" data-act="demos">${ICON.folder} Open</button>`)}
      ${row(`${D.backups.count} replays backed up`, `${mb} MB · Fortnite deletes old replays; every finished match is copied here first`, `<button class="btn" data-act="backups">${ICON.folder} Open</button>`)}
    </section>`,
    startup: () => `<section class="panel rise">${panelHead('Startup', 'ReChest runs quietly in the background and stays light: one check every few seconds, the window wakes only when needed.')}
      ${toggle('startWithWindows', 'Start with Windows', 'Starts hidden in the tray when you sign in')}
      ${toggle('showOnFortnite', 'Show when Fortnite starts', 'Pops up the window (without taking focus) when the game launches')}
      ${toggle('closeToTray', 'Keep running when closed', 'The close button hides ReChest to the tray; quit from the tray icon')}
    </section>`,
    about: () => `<section class="panel rise">${panelHead('About')}
      <div class="about"><span class="logo-lg"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="7.5" r="4.2"/><path d="M10.5 10.5 20 20"/><path d="M15.5 15.5l2.6-2.6"/><path d="M18.5 18.5l2.6-2.6"/></svg></span>
        <span><b>ReChest ${esc(D.version)}</b><small>Chest analytics from your Fortnite replays. Chest pictures: Fortnite Wiki. Skins: fortnite-api.com. Not affiliated with Epic Games.</small></span></div>
      ${row('', '<span>Made with <span class="heart">❤</span> by Reanex</span>', '')}
    </section>`,
  };
  if (S.stab === 'broadcast') S.stab = 'overlay'; // hidden: opened by tapping the logo three times
  const nav = `<nav class="snav rise">${STABS.filter(([k]) => k !== 'broadcast').map(([k, t, ic]) => `<button class="${S.stab === k ? 'on' : ''}" data-stab="${k}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ic}</svg>${t}</button>`).join('')}</nav>`;
  return head('Settings', 'In-game overlay, hotkeys and appearance') + `<div class="ssplit">${nav}<div class="spane">${sections[S.stab]()}</div></div>`;
}

/** Live preview of the in-game panel inside a mock 16:9 game screen. */
function drawPreview() {
  window.MapUI?.cardPreview($('#mapCardPv'), D.settings); // the map card (ui/map.js), next to the panel's preview
  const s = D.settings, box = $('#preview'), hud = $('#pvHud');
  if (!box || !hud) return;
  const k = box.clientWidth / 1920; // preview scale vs a 1080p game
  const hud2 = $('#pvHud2');
  for (const h of [hud, hud2]) {
    h.className = `pv-hud ${s.hudStyle || 'glass'}`;
    h.style.setProperty('--acc', s.hudAccent || '#3CCF6E');
    h.style.opacity = (s.hudOpacity || 95) / 100;
  }
  hud.style.display = s.hud ? '' : 'none';
  const live = D.live.length || 3, total = D.chests.filter((o) => o.by === D.me).length + live;
  const lab = s.hudLabels !== false, plus = s.hudPlus !== false;
  hud.innerHTML = `${D.images.has('chest') ? `<img src="${IMG}chest.png" alt="">` : ''}<span class="h-n">${NUM.format(total)}</span>${plus ? `<span class="h-p">+${live}</span>` : ''}
    ${lab ? '<span class="h-c">CHESTS</span>' : ''}${lab && plus ? '<span class="h-c h-pc">THIS MATCH</span>' : ''}${s.hudHints ? `<span class="h-k">${keyName(s.addKey)} +1 · ${keyName(s.removeKey)} −1</span>` : ''}`;
  hud2.innerHTML = hud.innerHTML;
  hud2.style.transform = `scale(${(s.hudScale || 100) / 100})`;
  const corner = s.hudCorner || 'tl';
  hud.style.transformOrigin = `${corner.includes('r') ? 'right' : 'left'} ${corner.includes('b') ? 'bottom' : 'top'}`;
  hud.style.transform = `scale(${((s.hudScale || 100) / 100) * k * 1.5})`;
  for (const p of ['left', 'right', 'top', 'bottom']) hud.style[p] = '';
  hud.style[corner.includes('r') ? 'right' : 'left'] = `${(s.hudX ?? 24) * k}px`;
  hud.style[corner.includes('b') ? 'bottom' : 'top'] = `${(s.hudY ?? 24) * k}px`;
}

let saveTimer;
function saveSettings(redraw = true) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => send({ type: 'settings', settings: D.settings }), 120);
  if (redraw) render(false); else drawPreview();
}

/* ---------------- events ---------------- */
function go(page, opts = {}) {
  Object.assign(S, opts);
  S.page = page;
  capture = null;
  $('#main').scrollTo({ top: 0 });
  render(true);
}

/** Picks a match in the Matches list without redrawing the list (keeps its scroll position). */
function selectMatch(id, btn) {
  const m = D.matches.find((x) => x.id === id);
  if (!m) return;
  S.open = id;
  $$('.mitem.on').forEach((x) => x.classList.remove('on', 'just-on'));
  btn.classList.add('on', 'just-on');
  CH = [];
  const pane = $('#mpane');
  pane.classList.remove('anim');
  pane.innerHTML = matchPane(m);
  void pane.offsetWidth;
  if (S.motion) pane.classList.add('anim');
}

document.addEventListener('click', (e) => {
  const ic = e.target.closest('.ichart.clickable');
  if (ic) { const id = CH[Number(ic.dataset.ch)]?.ids?.[Number(ic.dataset.i)]; if (id) go('matches', { open: id, mwho: 'all' }); return; }
  const t = e.target.closest('button, [data-who], [data-match], .sc-veil');
  if (!t) return;
  const d = t.dataset;
  if (fxClick(t, d)) return;
  if (d.page) return go(d.page);
  if (d.sel) return selectMatch(d.sel, t);
  if (d.who) return go('player', { who: d.who, ptab: S.page === 'player' ? S.ptab : 'overview' });
  if (d.match) return go('matches', { open: d.match, mwho: 'all' });
  if (d.stab) { S.stab = d.stab; capture = null; render(false); return $(`.snav [data-stab="${d.stab}"]`)?.classList.add('just-on'); }
  if (d.themeset) { setTheme(d.themeset); render(false); return $(`[data-themeset="${d.themeset}"]`)?.classList.add('just-on'); }
  if (d.bgkind) { BG.kind = d.bgkind; saveBg(); if (d.bgkind === 'image' && !BG.img) setTimeout(() => $('#bgFile')?.click()); return render(false); }
  if (d.bgcolor) { BG.color = d.bgcolor; saveBg(); return render(false); }
  if (d.act === 'glass') { GLASS.on = !GLASS.on; saveGlass(); return render(false); }
  if (d.act === 'bgclear') { BG.img = ''; BG.kind = 'theme'; try { localStorage.removeItem('rechest.bgimg'); } catch { /* ignore */ } saveBg(); return render(false); }
  if (d.picker) {
    if (PICK) return closePicker();
    const key = d.picker;
    return openPicker(t, key === 'bg' ? BG.color : key === 'share' ? shareOpts().color : D.settings[key], (c) => {
      if (key === 'share') { t.style.setProperty('--c', c); return setShare({ color: c }); }
      t.style.setProperty('--c', c);
      $$('.swatch.on', t.parentElement).forEach((x) => x.classList.remove('on'));
      if (key === 'bg') { BG.color = c; saveBg(); } else { D.settings[key] = c; saveSettings(false); }
    });
  }
  if (d.scope) { S.scope = d.scope; return render(true); }
  if (d.mode) { S.mode = d.mode; return render(true); }
  if (d.chart) { S.chart = d.chart; return render(true); }
  if (d.ptab) { S.ptab = d.ptab; return render(true); }
  if (d.msort) { S.msort = d.msort; return render(false); }
  if (d.mwho) { S.mwho = d.mwho; S.open = null; return render(false); }
  if (d.set) { D.settings[d.set] = d.val; return saveSettings(); }
  if (d.toggle) { D.settings[d.toggle] = !D.settings[d.toggle]; return saveSettings(); }
  if (d.capture) { capture = capture === d.capture ? null : d.capture; return render(false); }
  if (d.act === 'back') return back();
  if (d.act === 'theme') { toggleTheme(); if (S.page === 'settings') render(false); return; }
  if (d.act === 'motion') { S.motion = !S.motion; try { localStorage.setItem('rechest.motion', S.motion ? 'on' : 'off'); } catch { /* ignore */ } document.documentElement.classList.toggle('still', !S.motion); return render(false); }
  if (d.act === 'secretRecv') { D.settings.receiveBroadcasts = !D.settings.receiveBroadcasts; t.classList.toggle('on', D.settings.receiveBroadcasts); return saveSettings(false); }
  if (d.act === 'secretClose') return closeSecret();
  if (d.act === 'broadcast') { send({ type: 'broadcast' }); t.textContent = 'Sent ✓'; setTimeout(() => { t.textContent = 'Send'; }, 1600); return; }
  if (d.act) send({ type: { demos: 'openDemos', backups: 'openBackups', debug: 'openDebug' }[d.act] });
});
document.addEventListener('change', (e) => { if (e.target.id === 'bgFile') loadBgImage(e.target.files[0]); });
document.addEventListener('input', (e) => {
  const gk = e.target.dataset?.glassrange;
  if (gk) {
    GLASS[gk] = Number(e.target.value);
    e.target.style.setProperty('--p', `${(e.target.value / e.target.max) * 100}%`);
    e.target.nextElementSibling.textContent = e.target.value + (gk === 'solid' ? '%' : ' px');
    return saveGlass();
  }
  const bk = e.target.dataset?.bgrange;
  if (bk) {
    BG[bk] = Number(e.target.value);
    e.target.style.setProperty('--p', `${(e.target.value / e.target.max) * 100}%`);
    e.target.nextElementSibling.textContent = e.target.value + (bk === 'dim' ? '%' : ' px');
    return saveBg();
  }
  const k = e.target.dataset?.range;
  if (!k) return;
  D.settings[k] = Number(e.target.value);
  const { min, max, value } = e.target;
  e.target.style.setProperty('--p', `${((value - min) / (max - min)) * 100}%`);
  e.target.nextElementSibling.textContent = e.target.value + ({ hudScale: '%', hudOpacity: '%', routeZoom: '%', routeDot: '%', mapScale: '%', mapOpacity: '%', mapPointerRange: ' m' }[k] || ' px');
  saveSettings(false);
});
/** Esc / Back: a profile goes back to the player list's squad view, any other page back to Overview. */
function back() {
  if (S.page === 'player' && S.ptab === 'matches') { S.ptab = 'overview'; return render(true); }
  if (S.page !== 'home') go('home');
}
document.addEventListener('keydown', (e) => {
  if (capture) {
    e.preventDefault();
    if (e.key !== 'Escape') D.settings[capture] = e.keyCode; // keyCode equals the Windows virtual-key code
    capture = null;
    saveSettings();
    return;
  }
  // game-menu shortcuts: 1–6 pages, T theme, Esc back (not while typing, and not with modifiers)
  if (e.ctrlKey || e.altKey || e.metaKey || e.target.closest?.('input, select, textarea')) return;
  if (e.key >= '1' && e.key <= '6') return go(PAGES[Number(e.key) - 1]);
  if (e.key === 't' || e.key === 'T') { toggleTheme(); if (S.page === 'settings') render(false); return; }
  if (e.key === 'Escape') return PICK ? closePicker() : $('#share') ? closeShare() : $('#secret') ? closeSecret() : back();
});
addEventListener('resize', () => { if (S.page === 'settings') drawPreview(); });
setInterval(() => {
  if (!D.liveSince) return;
  const c = $('#liveChip'), t = $('#liveTimer');
  if (c) c.textContent = liveText();
  if (t) t.textContent = mmss((Date.now() - D.liveSince) / 1000);
}, 1000);

/* ---------------- start ---------------- */
// design previews: index.html#still&page=sim opens a page with motion off; #theme=light forces a theme
const HASH = new URLSearchParams(location.hash.slice(1));
if (HASH.has('still')) S.motion = false;
if (PAGES.includes(HASH.get('page'))) S.page = HASH.get('page');
if (HASH.get('stab')) S.stab = HASH.get('stab');
if (HASH.get('theme')) { THEME = HASH.get('theme'); applyTheme(); }
if (HASH.has('open')) S.open = window.MOCK?.matches.at(-1)?.id ?? null;
document.documentElement.classList.toggle('still', !S.motion);
applyBg();
if (IN_APP) {
  window.chrome.webview.addEventListener('message', (e) => (e.data?.type === 'bcastHistory' ? fxBcastHistory(e.data.times) : e.data?.type === 'winState' ? document.documentElement.classList.toggle('maxed', e.data.max) : onData(e.data)));
  send({ type: 'ready' });
} else {
  onData(window.MOCK || { matches: [] });
}

// the page name sits centred under the selected tab, like the game's menu
var pillAt = null; // var: render() runs before this line on start
function placeTabLabel() {
  const tab = $('.tab.on'), label = $('#tabLabel'), pill = $('#tabPill');
  // Settings lives on the right of the bar, outside the tabs: no pill or label in the tab row then
  pill.classList.toggle('gone', !tab); label.classList.toggle('gone', !tab);
  if (!tab) { pillAt = null; return; }
  label.style.transform = `translateX(${tab.offsetLeft + tab.offsetWidth / 2 - label.offsetWidth / 2}px)`;
  pill.style.width = tab.offsetWidth + 'px';
  pill.style.transform = `translateX(${tab.offsetLeft}px)`;
  if (pillAt != null && pillAt !== tab.dataset.page) { pill.classList.remove('pop'); void pill.offsetWidth; pill.classList.add('pop'); }
  pillAt = tab.dataset.page;
}
addEventListener('resize', placeTabLabel);
document.fonts?.ready.then(placeTabLabel);

/* the hidden broadcast panel: in Settings, tap the ReChest logo three times quickly */
let brandTaps = [];
$('.brand').addEventListener('click', () => {
  const now = performance.now(), b = $('.brand');
  brandTaps = brandTaps.filter((t) => now - t < 650).concat(now);
  b.classList.remove('tap'); void b.offsetWidth; b.classList.add('tap');
  if (brandTaps.length >= 3 && S.page === 'settings' && !$('#secret')) { brandTaps = []; openSecret(); }
});
function openSecret() {
  const b = $('.brand'), r = b.getBoundingClientRect();
  b.classList.add('unlock');
  setTimeout(() => b.classList.remove('unlock'), 900);
  const el = document.createElement('div');
  el.id = 'secret';
  el.className = 'secret';
  el.style.setProperty('--ox', r.left + r.width / 2 + 'px');
  el.style.setProperty('--oy', r.top + r.height / 2 + 'px');
  el.innerHTML = `<div class="sc-veil" data-act="secretClose"></div>
    <div class="sc-card" role="dialog" aria-label="Broadcast">
      <div class="sc-rays"></div>
      <span class="sc-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/></svg></span>
      <small class="sc-kicker">Secret unlocked</small>
      <h2>Broadcast</h2>
      <p>Play the video over the screen of everyone running ReChest. Only a “play” signal is sent; each app plays its own video.</p>
      <button class="btn accent sc-send" data-act="broadcast">Send</button>
      <div class="srow"><span><b>Receive others’ broadcasts</b><small>Let others start the video on your screen</small></span><button class="switch ${D.settings.receiveBroadcasts ? 'on' : ''}" data-act="secretRecv" aria-label="Receive broadcasts"><i></i></button></div>
      <div class="sc-hist" id="scHist"><small>${IN_APP ? 'Loading recent broadcasts…' : 'Broadcast history shows in the app'}</small></div>
      <button class="see sc-x" data-act="secretClose" aria-label="Close">Esc</button>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
  send({ type: 'bcastHistory' });
}
function closeSecret() {
  const el = $('#secret');
  if (!el) return;
  el.classList.remove('on');
  el.classList.add('off');
  setTimeout(() => el.remove(), 320);
}

// pages start below the floating top bar and scroll under it: keep that offset equal to the bar's height
new ResizeObserver(() => document.documentElement.style.setProperty('--topH', $('.top').offsetHeight + 'px')).observe($('.top'));
