'use strict';
/* ReChest chest simulator: Epic's published Treasure Hunters odds, target hunting, synthesized sound and
   particle effects. Mounted by app.js into #simRoot; keeps its own state across page visits. */
(() => {
  // Per-chest odds, Fortnite Status (Nov 7 2026), reported by Destructoid and Hudwire.
  const REWARDS = [
    { id: 'gizmo', name: 'Any Gizmo', odds: 127, weekly: false, boost: 1, tier: 'Uncommon', color: '#3ccf6e', icon: 'gizmo' },
    { id: 'loading', name: 'Weekly Loading Screen', odds: 272, weekly: true, boost: 1, tier: 'Rare', color: '#3b9cff', icon: 'loading' },
    { id: 'jam', name: 'Weekly Jam Track', odds: 391, weekly: true, boost: 1, tier: 'Rare', color: '#3b9cff', icon: 'jam' },
    { id: 'pickaxe', name: 'Weekly Pickaxe or Back Bling', odds: 568, weekly: true, boost: 1, tier: 'Epic', color: '#b45cff', icon: 'pickaxe' },
    { id: 'vehicle', name: 'Weekly Vehicle & Decal', odds: 7813, weekly: true, boost: 10, tier: 'Legendary', color: '#ff9a2e', icon: 'vehicle' },
    { id: 'token', name: 'Pirate Shop Access token', odds: 137500, weekly: true, boost: 1.5, tier: 'Mythic', color: '#ffd23f', icon: 'token' },
    { id: 'gold', name: 'Weekly Gold Outfit', odds: 1562500, weekly: true, boost: 7.5, tier: 'Exotic', color: '#ffe9a0', icon: 'gold' },
  ];
  const RANK = Object.fromEntries(REWARDS.map((r, i) => [r.id, i]));
  // flavour loot so a chest never feels empty (not tracked, not real odds)
  const LOOT = ['Assault Rifle', 'Pump Shotgun', 'Tactical SMG', 'Hunting Rifle', 'Shield Potion', 'Small Shield Potion', 'Medkit', 'Bandages', 'Grenades', 'Flowberry Fizz', 'Burst Rifle', 'Sniper Rifle'];
  const LOOT_TIERS = [['Common', '#b5b5b5', 30], ['Uncommon', '#3ccf6e', 35], ['Rare', '#3b9cff', 22], ['Epic', '#b45cff', 10], ['Legendary', '#ff9a2e', 3]];

  // weekly limit is off by default: with it on, every weekly item stops dropping after its first copy and big batches show only Gizmos
  const S = { opened: 0, got: {}, target: 'token', hours: false, weekly: false, fast: false, busy: false, sound: true, vol: 0.7, feed: [], hunt: null, last: null };
  try { const o = JSON.parse(localStorage.getItem('rechest.sim') || '{}'); Object.assign(S, o, { weekly: !!o.weeklyLimit, busy: false, hunt: null, last: null }); } catch { /* defaults */ }
  const save = () => { try { localStorage.setItem('rechest.sim', JSON.stringify({ target: S.target, hours: S.hours, weeklyLimit: S.weekly, fast: S.fast, sound: S.sound, vol: S.vol })); } catch { /* ignore */ } };

  const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  const sig = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 2, maximumFractionDigits: 8 });
  const pct = (p) => (p >= 0.001 ? fmt.format(p * 100) : sig.format(p * 100)) + '%';
  const pOf = (r) => Math.min(1, (S.hours ? r.boost : 1) / r.odds);
  const atLeast = (p, n) => 1 - Math.pow(1 - p, n);
  const need = (p, q) => Math.ceil(Math.log(1 - q) / Math.log(1 - p));
  const byId = (id) => REWARDS.find((r) => r.id === id);
  const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** One chest: every reward is rolled independently; weekly items drop once per (simulated) week. */
  function rollChest() {
    S.opened++;
    const drops = [];
    for (const r of REWARDS) {
      if (S.weekly && r.weekly && S.got[r.id]) continue;
      if (Math.random() < pOf(r)) { S.got[r.id] = (S.got[r.id] || 0) + 1; drops.push(r); }
    }
    return drops;
  }
  function flavourLoot() {
    const pick = () => { let x = Math.random() * 100; for (const t of LOOT_TIERS) { if ((x -= t[2]) < 0) return t; } return LOOT_TIERS[0]; };
    return [0, 1].map(() => { const t = pick(); return { name: LOOT[Math.floor(Math.random() * LOOT.length)], tier: t[0], color: t[1] }; });
  }

  /* ================= sound (Web Audio, synthesized) ================= */
  let ac, master, verb;
  function audio() {
    if (!S.sound) return null;
    if (!ac) {
      ac = new AudioContext();
      master = ac.createGain();
      master.connect(ac.destination);
      // a short feedback delay gives the chimes some sparkle and space
      verb = ac.createDelay(1);
      verb.delayTime.value = 0.13;
      const fb = ac.createGain(); fb.gain.value = 0.35;
      const wet = ac.createGain(); wet.gain.value = 0.35;
      verb.connect(fb); fb.connect(verb); verb.connect(wet); wet.connect(master);
    }
    if (ac.state === 'suspended') ac.resume();
    master.gain.value = S.vol * 0.9;
    return ac;
  }
  function tone(freq, t, dur, { type = 'sine', gain = 0.25, glide = null, wet = false, attack = 0.005 } = {}) {
    const a = audio(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); if (wet) g.connect(verb);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(t, dur, { freq = 1200, q = 1, gain = 0.3, type = 'bandpass', sweep = null } = {}) {
    const a = audio(); if (!a) return;
    const len = Math.ceil(a.sampleRate * dur), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = buf; f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t);
  }
  const SFX = {
    rattle(intensity = 1) { const a = audio(); if (!a) return; const t = a.currentTime; noise(t, 0.07, { freq: 900 + Math.random() * 900, q: 3, gain: 0.18 * intensity }); tone(140 + Math.random() * 40, t, 0.06, { type: 'square', gain: 0.03 * intensity }); },
    charge(dur) { const a = audio(); if (!a) return; const t = a.currentTime; tone(220, t, dur, { type: 'triangle', gain: 0.07, glide: 880, attack: dur * 0.6 }); tone(330, t, dur, { type: 'sine', gain: 0.05, glide: 1320, attack: dur * 0.7, wet: true }); noise(t, dur, { freq: 400, sweep: 6000, q: 0.7, gain: 0.08, type: 'bandpass' }); },
    tease(color) { const a = audio(); if (!a) return; const t = a.currentTime; [784, 988, 1175].forEach((f, i) => tone(f, t + i * 0.07, 0.3, { type: 'sine', gain: 0.06, wet: true })); },
    burst(big = false) { const a = audio(); if (!a) return; const t = a.currentTime; noise(t, big ? 0.9 : 0.45, { freq: 3000, sweep: 200, q: 0.5, gain: big ? 0.5 : 0.32, type: 'lowpass' }); tone(90, t, big ? 0.7 : 0.35, { type: 'sine', gain: 0.5, glide: 40 }); tone(1600, t, 0.25, { type: 'triangle', gain: 0.06, glide: 2600, wet: true }); },
    coins(n = 6) { const a = audio(); if (!a) return; const t = a.currentTime; for (let i = 0; i < n; i++) tone(2200 + Math.random() * 1600, t + 0.05 + i * 0.045 + Math.random() * 0.03, 0.12, { type: 'triangle', gain: 0.05, wet: true }); },
    chime(rank) {
      const a = audio(); if (!a) return; const t = a.currentTime + 0.05;
      const scales = [[659, 988], [523, 659, 784], [523, 659, 784, 1047], [440, 554, 659, 880, 1109], [392, 494, 587, 784, 988, 1175], [349, 440, 523, 698, 880, 1047, 1397], [330, 415, 494, 659, 831, 988, 1319, 1661]];
      const notes = scales[Math.min(rank, scales.length - 1)];
      notes.forEach((f, i) => { tone(f, t + i * 0.085, 0.9, { type: 'triangle', gain: 0.12, wet: true }); tone(f * 2, t + i * 0.085, 0.5, { type: 'sine', gain: 0.04, wet: true }); });
      if (rank >= 4) noise(t, 1.4, { freq: 7000, q: 0.4, gain: 0.05, type: 'highpass' }); // shimmer
    },
    fanfare() {
      const a = audio(); if (!a) return; const t = a.currentTime + 0.05;
      const chord = (fs, at, dur) => fs.forEach((f) => { tone(f, t + at, dur, { type: 'sawtooth', gain: 0.045, attack: 0.03 }); tone(f, t + at, dur, { type: 'triangle', gain: 0.07, attack: 0.02, wet: true }); });
      chord([392, 494, 587], 0, 0.22); chord([392, 494, 587], 0.24, 0.12); chord([392, 494, 587], 0.38, 0.12); chord([523, 659, 784, 1047], 0.52, 1.6);
      noise(t + 0.52, 1.8, { freq: 8000, q: 0.3, gain: 0.07, type: 'highpass' });
      tone(65, t + 0.52, 1.2, { type: 'sine', gain: 0.35, glide: 45 });
      SFX.coins(14);
    },
    tick() { const a = audio(); if (!a) return; tone(1800, a.currentTime, 0.03, { type: 'square', gain: 0.025 }); },
    nothing() { const a = audio(); if (!a) return; const t = a.currentTime; tone(520, t, 0.18, { type: 'triangle', gain: 0.07 }); tone(390, t + 0.1, 0.25, { type: 'triangle', gain: 0.06 }); },
  };

  /* ================= particles ================= */
  const parts = [];
  let raf = 0, stageCanvas = null, fxCanvas = null;
  function emit(canvas, x, y, n, colors, { speed = 9, gravity = 0.25, life = 70, shape = 'spark', spread = Math.PI * 2, dir = -Math.PI / 2, size = 4 } = {}) {
    for (let i = 0; i < n; i++) {
      const a = dir + (Math.random() - 0.5) * spread, v = speed * (0.35 + Math.random() * 0.9);
      parts.push({ canvas, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: gravity, life: life * (0.6 + Math.random() * 0.6), max: life, color: colors[Math.floor(Math.random() * colors.length)], shape, size: size * (0.6 + Math.random() * 0.8), rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4 });
    }
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function tick() {
    const ctxs = new Map();
    for (const c of [stageCanvas, fxCanvas]) {
      if (!c || !c.isConnected) continue;
      const dpr = devicePixelRatio || 1, w = c.clientWidth, hh = c.clientHeight;
      if (c.width !== w * dpr || c.height !== hh * dpr) { c.width = w * dpr; c.height = hh * dpr; }
      const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, hh); ctxs.set(c, x);
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i], x = ctxs.get(p.canvas);
      p.vy += p.g; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life--;
      if (p.life <= 0 || !x) { parts.splice(i, 1); continue; }
      const a = Math.min(1, p.life / (p.max * 0.4));
      x.globalAlpha = a; x.fillStyle = p.color;
      if (p.shape === 'confetti') { x.save(); x.translate(p.x, p.y); x.rotate(p.rot); x.fillRect(-p.size, -p.size * 0.4, p.size * 2, p.size * 0.8); x.restore(); }
      else if (p.shape === 'coin') { x.beginPath(); x.ellipse(p.x, p.y, p.size, p.size * Math.abs(Math.cos(p.rot)) + 0.6, 0, 0, 6.28); x.fill(); }
      else { x.shadowColor = p.color; x.shadowBlur = 10; x.beginPath(); x.arc(p.x, p.y, p.size * a, 0, 6.28); x.fill(); x.shadowBlur = 0; }
    }
    for (const x of ctxs.values()) x.globalAlpha = 1;
    raf = parts.length ? requestAnimationFrame(tick) : 0;
    if (!parts.length) for (const x of ctxs.values()) x.clearRect(0, 0, 9999, 9999);
  }

  /* ================= icons ================= */
  const ICONS = {
    gizmo: '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm8.6 2.3l-1.9-.4a7 7 0 0 0-.8-1.9l1.1-1.6-1.9-1.9-1.6 1.1a7 7 0 0 0-1.9-.8L13.2 3h-2.4l-.4 1.9a7 7 0 0 0-1.9.8L6.9 4.6 5 6.5l1.1 1.6a7 7 0 0 0-.8 1.9l-1.9.4v2.4l1.9.4c.2.7.4 1.3.8 1.9L5 16.7l1.9 1.9 1.6-1.1c.6.4 1.2.6 1.9.8l.4 1.9h2.4l.4-1.9c.7-.2 1.3-.4 1.9-.8l1.6 1.1 1.9-1.9-1.1-1.6c.4-.6.6-1.2.8-1.9l1.9-.4z"/>',
    loading: '<path d="M4 5h16v14H4zM6 7v10h12V7zm2 8l3-4 2 2.5 1.5-2L17 15z"/>',
    jam: '<path d="M9 17.5A2.5 2.5 0 1 1 6.5 15 2.5 2.5 0 0 1 9 17.5zm10-2A2.5 2.5 0 1 1 16.5 13a2.5 2.5 0 0 1 2.5 2.5zM9 17.5V6l10-2v11.5h-2V7l-6 1.2v9.3z"/>',
    pickaxe: '<path d="M14.5 3.5c3.6.2 6 2.4 6.2 5.9-1.7-1.4-3.4-2.2-5.2-2.4l-9.8 9.8 1.4 1.4-2.1 2.1-3-3 2.1-2.1 1.4 1.4 9.8-9.8c-.2-1.4-.4-2.4-.8-3.3z"/>',
    vehicle: '<path d="M5 11l1.6-4.2A2 2 0 0 1 8.5 5.5h7a2 2 0 0 1 1.9 1.3L19 11h1a1 1 0 0 1 1 1v4h-2v1.5a1.5 1.5 0 0 1-3 0V16H8v1.5a1.5 1.5 0 0 1-3 0V16H3v-4a1 1 0 0 1 1-1zm2.2 0h9.6l-1.1-3.3a.5.5 0 0 0-.5-.2H8.8a.5.5 0 0 0-.5.2zM6.5 14a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm11 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/>',
    token: '<circle cx="12" cy="12" r="9"/><path fill="#5a3a00" d="M12 6.5a4 4 0 0 0-2.2 7.3V16h4.4v-2.2A4 4 0 0 0 12 6.5zm-1.4 3.7a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8zm2.8 0a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8zM10.5 17h3v1h-3z"/>',
    gold: '<path d="M12 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm-6 18l1.2-7.2A3 3 0 0 1 10.2 11h3.6a3 3 0 0 1 3 2.8L18 21z"/>',
  };
  const icon = (r, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICONS[r.icon]}</svg>`;

  /* ================= UI ================= */
  let root = null;
  const $ = (s) => root?.querySelector(s);

  function mount(el) {
    root = el;
    const D = window.D_FOR_SIM ? window.D_FOR_SIM() : { mine: 0, squad: 0, perDay: 0, img: '' };
    el.innerHTML = `
      <div class="sim2">
        <section class="sim-left panel">
          <div class="stage" id="stage">
            <div class="rays" id="rays"></div>
            <div class="flash" id="flash"></div>
            <div class="floor"></div>
            ${D.img ? `<img class="chest" id="chest" src="${D.img}" alt="">` : '<div class="chest noimg" id="chest">?</div>'}
            <canvas class="stage-fx" id="stageFx"></canvas>
            <div class="reveal" id="reveal"></div>
            <div class="counter"><small>Chests opened</small><b id="cnt">${fmt.format(S.opened)}</b></div>
            <div class="hunting" id="hunting"></div>
          </div>
          <div class="sim-actions">
            <button class="open-btn" id="openBtn"><span>Open chest</span><kbd>Space</kbd></button>
            <div class="multi" role="group" aria-label="Open several"><button data-n="10">×10</button><button data-n="100">×100</button><button data-n="1000">×1,000</button></div>
            <button class="hunt-btn" id="huntBtn"><span id="huntIc"></span><span class="hb-t"><b id="huntLbl">Open until I get it</b><small id="huntName"></small></span></button>
          </div>
          <div class="sim-opts2">
            <label class="opt"><button class="switch ${S.fast ? 'on' : ''}" data-opt="fast"><i></i></button>Fast mode</label>
            <label class="opt"><button class="switch ${S.hours ? 'on' : ''}" data-opt="hours"><i></i></button>Treasure Hours</label>
            <label class="opt"><button class="switch ${S.weekly ? 'on' : ''}" data-opt="weekly"><i></i></button>Weekly limit</label>
            <label class="opt"><button class="switch ${S.sound ? 'on' : ''}" data-opt="sound"><i></i></button>Sound<input type="range" min="0" max="100" value="${Math.round(S.vol * 100)}" id="vol" style="--p:${Math.round(S.vol * 100)}%"></label>
            <button class="see" id="reset">Reset</button>
          </div>
        </section>
        <section class="sim-right panel">
          <div class="ph"><div><h2>Pick your target</h2><small id="tally"></small></div></div>
          <div class="targets" id="targets"></div>
          <div class="feed-h">Recent drops</div>
          <div class="feed" id="feed"></div>
        </section>
      </div>
      <div class="simfacts">
        <section class="panel"><div class="ph"><div><h2>Odds per chest</h2><small>Every reward is rolled on its own, each chest</small></div></div><div id="oddsTable"></div></section>
        <section class="panel"><div class="ph"><div><h2>Token facts</h2><small>Pirate Shop Access token, from your replays</small></div></div><div id="facts"></div></section>
      </div>
`;
    stageCanvas = $('#stageFx');
    // full-window layers live on <body>: inside the page, its entrance transform would trap position:fixed
    fxCanvas = document.getElementById('simFx') || document.body.appendChild(Object.assign(document.createElement('canvas'), { id: 'simFx', className: 'fx-full' }));
    if (!document.getElementById('simCelebrate')) document.body.appendChild(Object.assign(document.createElement('div'), { id: 'simCelebrate', className: 'celebrate' }));
    drawTargets(); drawTally(); drawFeed(); drawTables(D);
    el.onclick = onClick;
    // design previews: index.html#page=sim&simdemo=reveal|celebrate
    const demo = new URLSearchParams(location.hash.slice(1)).get('simdemo');
    if (demo === 'reveal') { stage().classList.add('burst'); $('#rays').style.opacity = '1'; stage().style.setProperty('--rc', '#ff9a2e'); drawReveal([byId('vehicle'), byId('gizmo')], flavourLoot()); }
    if (demo === 'celebrate') celebrate(byId('token'), 95308, true);
    $('#vol').oninput = (e) => { S.vol = e.target.value / 100; e.target.style.setProperty('--p', e.target.value + '%'); save(); if (master) master.gain.value = S.vol * 0.9; };
  }

  function drawTargets() {
    $('#targets').innerHTML = REWARDS.map((r) => `
      <button class="tcard ${S.target === r.id ? 'on' : ''}" data-target="${r.id}" style="--c:${r.color}">
        <span class="tic">${icon(r)}</span>
        <span class="tmeta"><b>${h(r.name)}</b><small><em>${r.tier}</em> · 1 in ${fmt.format(Math.round(1 / pOf(r)))}</small></span>
        <span class="tgot">${S.got[r.id] ? '×' + fmt.format(S.got[r.id]) : ''}</span>
      </button>`).join('');
    const t = byId(S.target);
    if (!t) return;
    $('#hunting').innerHTML = `<span style="--c:${t.color}">${icon(t)}<em>Target</em>${h(t.name)}</span>`;
    const hb = $('#huntBtn');
    hb.style.setProperty('--c', t.color);
    $('#huntIc').innerHTML = icon(t);
    $('#huntName').textContent = `${t.name} · 1 in ${fmt.format(Math.round(1 / pOf(t)))}`;
  }
  function drawTally() {
    $('#tally').innerHTML = `This session · <b>${fmt.format(S.opened)}</b> chests opened`;
    $('#cnt').textContent = fmt.format(S.opened);
  }
  function drawFeed() {
    $('#feed').innerHTML = S.feed.length
      ? S.feed.slice(0, 8).map((f) => `<span class="fi" style="--c:${f.color}">${icon(byId(f.id))}<b>${h(f.name)}</b><em>#${fmt.format(f.at)}</em></span>`).join('')
      : '<span class="feed-empty">Open a chest: anything rare lands here</span>';
  }
  function drawTables(D) {
    $('#oddsTable').innerHTML = `<table class="odds"><tr><th>Reward</th><th>Odds</th><th>Per chest</th><th>In your ${fmt.format(D.mine)}</th><th>50% after</th></tr>
      ${REWARDS.map((r) => { const p = pOf(r), got = atLeast(p, D.mine); return `<tr style="--c:${r.color}"><td><span class="o-ic">${icon(r)}</span>${h(r.name)}</td><td>1 in ${fmt.format(Math.round(1 / p))}</td><td>${pct(p)}</td><td><span class="pbar"><i style="width:${Math.max(2, got * 100)}%"></i></span>${pct(got)}</td><td>${fmt.format(need(p, 0.5))}</td></tr>`; }).join('')}</table>
      <small class="muted">${S.hours ? 'Treasure Hours: token ×1.5, gold outfit ×7.5, vehicle ×10 (Saturdays 2–4 PM and 9–11 PM ET). ' : ''}Each reward is rolled independently per chest. Source: Epic via Fortnite Status (Nov 7, 2026), reported by Destructoid and Hudwire. Weapons shown when opening are flavour only.</small>`;
    const tok = byId('token'), pt = pOf(tok);
    $('#facts').innerHTML = `<div class="facts">
      <div><b>${pct(atLeast(pt, D.mine))}</b><small>chance you already found the token in your ${fmt.format(D.mine)} chests</small></div>
      <div><b>${pct(atLeast(pt, D.squad))}</b><small>chance your squad did (${fmt.format(D.squad)} chests) · when one finds it, everyone in the match gets it</small></div>
      <div><b>${fmt.format(need(pt, 0.5))}</b><small>chests for a 50% chance · ${fmt.format(need(pt, 0.9))} for 90%</small></div>
      <div><b>${D.perDay ? fmt.format(Math.round(need(pt, 0.5) / D.perDay)) : '—'}</b><small>days at your pace (${fmt.format(D.perDay)} chests a day) for a 50% chance</small></div>
      <div><b>${fmt.format(Math.round(1 / pt))}</b><small>chests per token on average</small></div></div>`;
  }

  function onClick(e) {
    const b = e.target.closest('button');
    if (!b || S.busy && !b.dataset.opt && b.id !== 'huntBtn') return;
    if (b.id === 'openBtn') return openOne();
    if (b.dataset.n) return openMany(Number(b.dataset.n));
    if (b.id === 'huntBtn') return S.hunt ? (S.hunt.stop = true) : hunt();
    if (b.dataset.target) { S.target = b.dataset.target; save(); SFX.tick(); return drawTargets(); }
    if (b.dataset.opt) { S[b.dataset.opt] = !S[b.dataset.opt]; save(); b.classList.toggle('on', S[b.dataset.opt]); if (b.dataset.opt === 'hours') { drawTargets(); drawTables(window.D_FOR_SIM()); } return; }
    if (b.id === 'reset') { Object.assign(S, { opened: 0, got: {}, feed: [] }); drawTargets(); drawTally(); drawFeed(); $('#reveal').innerHTML = ''; }
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const stage = () => $('#stage');
  function setBusy(v) { S.busy = v; root?.querySelectorAll('.sim-actions button:not(#huntBtn)').forEach((b) => { b.disabled = v; }); }

  /** The best drop decides how dramatic the opening is. */
  function opening(drops) {
    const best = drops.reduce((a, r) => (a == null || RANK[r.id] > RANK[a.id] ? r : a), null);
    return { best, rank: best ? RANK[best.id] : -1 };
  }

  async function openOne() {
    if (S.busy) return;
    setBusy(true);
    audio();
    const drops = rollChest(), loot = flavourLoot(), { best, rank } = opening(drops);
    const st = stage(), chest = $('#chest'), rays = $('#rays');
    $('#reveal').innerHTML = '';
    st.style.setProperty('--rc', best ? best.color : '#ffc94a');
    if (!S.fast) {
      // charge: the chest shakes harder and harder; a rare drop tints the glow before it pops
      const charge = rank >= 4 ? 2100 : rank >= 1 ? 1650 : 1300;
      st.classList.add('charging');
      SFX.charge(charge / 1000);
      const t0 = performance.now();
      let teased = false;
      while (performance.now() - t0 < charge) {
        const k = (performance.now() - t0) / charge;
        chest.style.setProperty('--shake', (2 + k * 9).toFixed(1) + 'px');
        rays.style.opacity = String(0.15 + k * 0.6);
        SFX.rattle(0.5 + k);
        if (!teased && k > 0.62 && rank >= 1) { teased = true; st.classList.add('tease'); SFX.tease(); }
        await wait(140 - k * 90);
      }
      st.classList.remove('charging', 'tease');
    }
    // burst
    st.classList.remove('burst'); void st.offsetWidth; st.classList.add('burst');
    rays.style.opacity = best ? '1' : '.35';
    SFX.burst(rank >= 4);
    const cx = stageCanvas.clientWidth / 2, cy = stageCanvas.clientHeight * 0.55;
    emit(stageCanvas, cx, cy, best ? 70 + rank * 25 : 40, best ? [best.color, '#fff', '#ffe29a'] : ['#ffd25a', '#fff1b8', '#ffb020'], { speed: best ? 11 : 8, life: 80 });
    emit(stageCanvas, cx, cy, 12, ['#ffd25a', '#f0b020'], { shape: 'coin', speed: 7, size: 5, life: 90 });
    SFX.coins(best ? 10 : 5);
    drawReveal(drops, loot);
    if (best) { setTimeout(() => SFX.chime(rank), S.fast ? 60 : 180); addFeed(drops); }
    else setTimeout(() => SFX.nothing(), 250);
    drawTally(); drawTargets();
    if (drops.some((r) => r.id === S.target)) await celebrate(byId(S.target), S.opened);
    setTimeout(() => { rays.style.opacity = '0'; }, S.fast ? 500 : 1400);
    await wait(S.fast ? 120 : 700);
    setBusy(false);
  }

  function drawReveal(drops, loot) {
    const cards = drops.slice().sort((a, b) => RANK[b.id] - RANK[a.id]).map((r, i) =>
      `<div class="rcard2 tier-${r.tier.toLowerCase()}" style="--c:${r.color};--d:${i * 0.12}s"><span class="rc-ic">${icon(r)}</span><b>${h(r.name)}</b><small>${r.tier}</small></div>`).join('');
    const lootRow = loot.map((l, i) => `<span class="loot" style="--c:${l.color};--d:${0.15 + i * 0.08}s">${h(l.name)}</span>`).join('');
    $('#reveal').innerHTML = `${cards ? `<div class="rcards">${cards}</div>` : '<div class="nada">No treasure this time</div>'}<div class="lootrow">${lootRow}</div>`;
  }
  function addFeed(drops) {
    for (const r of drops) if (r.id !== 'gizmo' || S.feed.length < 3) S.feed.unshift({ id: r.id, name: r.name, color: r.color, at: S.opened });
    S.feed = S.feed.slice(0, 20);
    drawFeed();
  }

  async function openMany(n) {
    if (S.busy) return;
    setBusy(true);
    audio();
    const all = [];
    let hit = null;
    for (let i = 0; i < n; i++) { const d = rollChest(); all.push(...d); if (!hit && d.some((r) => r.id === S.target)) hit = S.opened; }
    const st = stage();
    st.classList.remove('burst'); void st.offsetWidth; st.classList.add('burst');
    const { best, rank } = opening(all);
    st.style.setProperty('--rc', best ? best.color : '#ffc94a');
    $('#rays').style.opacity = best ? '1' : '.4';
    SFX.burst(rank >= 4);
    emit(stageCanvas, stageCanvas.clientWidth / 2, stageCanvas.clientHeight * 0.55, 60 + Math.max(0, rank) * 25, best ? [best.color, '#fff'] : ['#ffd25a', '#fff'], { speed: 11 });
    // summary: one card per reward type with its count
    const counts = {};
    for (const r of all) counts[r.id] = (counts[r.id] || 0) + 1;
    const types = Object.keys(counts).sort((a, b) => RANK[b] - RANK[a]);
    const locked = S.weekly ? REWARDS.filter((r) => r.weekly && S.got[r.id] && !counts[r.id]) : [];
    const lockNote = locked.length ? `<span class="loot" style="--c:#ff9a2e">Weekly limit reached: ${locked.map((r) => h(r.name.replace('Weekly ', ''))).join(', ')}</span>` : '';
    $('#reveal').innerHTML = types.length
      ? `<div class="rcards">${types.map((id, i) => { const r = byId(id); return `<div class="rcard2 tier-${r.tier.toLowerCase()}" style="--c:${r.color};--d:${i * 0.1}s"><span class="rc-ic">${icon(r)}</span><b>${h(r.name)}</b><small>×${counts[id]}</small></div>`; }).join('')}</div><div class="lootrow"><span class="loot" style="--c:#aaa">${fmt.format(n)} chests opened</span>${lockNote}</div>`
      : `<div class="nada">${fmt.format(n)} chests · no treasure</div><div class="lootrow">${lockNote}</div>`;
    types.forEach((id, i) => setTimeout(() => SFX.chime(RANK[id]), 150 + i * 220));
    addFeed(all.filter((r) => r.id !== 'gizmo'));
    drawTally(); drawTargets();
    if (hit) await celebrate(byId(S.target), hit);
    setTimeout(() => { $('#rays').style.opacity = '0'; }, 1600);
    setBusy(false);
  }

  /** Opens chests at full speed until the target drops, with a rolling counter; Stop ends it. */
  async function hunt() {
    if (S.busy) return;
    const t = byId(S.target);
    setBusy(true);
    audio();
    S.hunt = { stop: false };
    const btn = $('#huntBtn'), st = stage(), start = S.opened;
    $('#huntLbl').textContent = 'Stop hunting'; btn.classList.add('on');
    st.classList.add('hunting-on');
    st.style.setProperty('--rc', t.color);
    $('#reveal').innerHTML = `<div class="nada huntmsg">Hunting ${h(t.name)}…</div>`;
    let found = 0, lastTick = 0;
    const weekly = S.weekly;
    S.weekly = false; // when hunting, only the target matters, not the weekly limit
    const before = { ...S.got };
    while (!found && !S.hunt.stop && S.opened - start < 50_000_000) {
      const chunk = Math.min(40_000, Math.max(200, Math.round(1 / pOf(t) / 60)));
      for (let i = 0; i < chunk; i++) { const d = rollChest(); if (d.some((r) => r.id === t.id)) { found = S.opened; break; } }
      $('#cnt').textContent = fmt.format(S.opened);
      $('#chest').style.setProperty('--shake', (3 + Math.random() * 4).toFixed(1) + 'px');
      if (performance.now() - lastTick > 70) { SFX.rattle(0.6); lastTick = performance.now(); }
      await new Promise(requestAnimationFrame);
    }
    S.weekly = weekly;
    st.classList.remove('hunting-on');
    $('#huntLbl').textContent = 'Open until I get it'; btn.classList.remove('on');
    S.hunt = null;
    drawTally(); drawTargets();
    const gotNow = REWARDS.filter((r) => (S.got[r.id] || 0) > (before[r.id] || 0) && r.id !== 'gizmo');
    addFeed(gotNow);
    if (found) {
      st.classList.remove('burst'); void st.offsetWidth; st.classList.add('burst');
      SFX.burst(true);
      drawReveal([t], []);
      await celebrate(t, found - start, true);
    } else $('#reveal').innerHTML = `<div class="nada">Stopped after ${fmt.format(S.opened - start)} chests</div>`;
    setBusy(false);
  }

  /** Full-screen "you got it" moment: rays, confetti, the reward card and a fanfare. */
  async function celebrate(r, chests, isHunt = false) {
    const D = window.D_FOR_SIM();
    const days = D.perDay ? Math.round(chests / D.perDay) : null;
    const el = document.getElementById('simCelebrate');
    el.style.setProperty('--c', r.color);
    el.innerHTML = `<div class="cb-rays"></div><div class="cb-card">
        <small>YOU GOT IT!</small>
        <span class="cb-ic">${icon(r)}</span>
        <b>${h(r.name)}</b>
        <em>${r.tier} · 1 in ${fmt.format(Math.round(1 / pOf(r)))}</em>
        <p>${isHunt ? `after <b>${fmt.format(chests)}</b> chests` : `on chest <b>#${fmt.format(chests)}</b>`}${days != null && isHunt ? ` · about ${fmt.format(days)} days of play at your pace` : ''}</p>
        <button class="btn big gold" id="cbOk">Keep opening</button></div>`;
    el.classList.add('on');
    SFX.fanfare();
    const w = fxCanvas.clientWidth, hh = fxCanvas.clientHeight;
    const colors = [r.color, '#ffffff', '#ffd23f', '#3b9cff', '#ff5c8a', '#3ccf6e'];
    emit(fxCanvas, w * 0.2, hh * 0.85, 120, colors, { shape: 'confetti', speed: 18, dir: -Math.PI / 2.6, spread: 0.9, gravity: 0.32, life: 160, size: 6 });
    emit(fxCanvas, w * 0.8, hh * 0.85, 120, colors, { shape: 'confetti', speed: 18, dir: -Math.PI + Math.PI / 2.6, spread: 0.9, gravity: 0.32, life: 160, size: 6 });
    setTimeout(() => emit(fxCanvas, w / 2, hh * 0.45, 140, [r.color, '#fff', '#ffe29a'], { speed: 14, life: 110 }), 520);
    await new Promise((ok) => { el.querySelector('#cbOk').onclick = () => { el.classList.remove('on'); ok(); }; });
  }

  // Space opens a chest while the simulator is on screen
  addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || !root?.isConnected || e.target.closest?.('input, textarea')) return;
    e.preventDefault();
    const cel = document.getElementById('simCelebrate');
    if (cel?.classList.contains('on')) return cel.querySelector('#cbOk')?.click();
    openOne();
  });

  window.SimUI = { mount };
})();

