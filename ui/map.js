'use strict';
/* ReChest map: fortnite.gg's map tiles and every layer it shows (chests, vaults, vehicles, NPCs...), read by the app from
   fortnite.gg's own page (Fgg.cs, StatsWindow.CaptureFgg), with the game icons it uses; looting routes the user draws
   or builds from a landing spot (kept in this machine's local storage). Mounted by app.js into #mapRoot; keeps its
   view and route across page visits.
   Spaces: world = game centimetres (routes, distances); img = 2048 px for the whole map = fortnite.gg's [lat, lng]
   space x 8 (lng right, -lat down), which is also fortnite-api.com's map picture used when the tiles can't load. */
(() => {
  const NEAR = 1500; // a chest within 15 m of the route counts as on it
  const RUN = 6, OPEN = 2; // sprint speed in m/s and seconds to open a chest, for the time estimate
  const CLUSTER = 60; // screen px: markers of one layer closer than this stack into one counted icon
  const SPREAD = 4; // view scale from which every marker shows on its own
  const DEFAULT_ON = ['chests', 'rare_chests', 'buried_chests', 'sprite_chests', 'key_vaults'];
  const FALLBACK = 'https://fortnite-api.com/images/map.png';
  const DOT = '#ffc83d';
  const MAX_STOPS = 500;
  const stopsPct = (n) => ((n - 2) / (MAX_STOPS - 2)) * 100 + '%';

  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off: lives for this session */ } };
  const S = {
    on: load('rechest.map.layers', DEFAULT_ON), view: null, mode: 'pan', stops: load('rechest.map.stops', 10), land: null,
    route: load('rechest.route', []), saved: load('rechest.routes', []),
    file: null, cats: [], busy: false, needsCheck: false, error: '', iconBase: '', fgg: false, fggClosed: false, msg: '',
    routeZoom: 100, routeHereKey: 0x73, routeOn: true, routeKey: 0x76, routeBigKey: 0x75, routeFullKey: 0x74, routeDot: 100, track: true, me: null,
  };
  const LOCALE = window.I18N?.locale || 'en-US';
  const fmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
  const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const send = (m) => window.chrome?.webview?.postMessage(m);

  // Turkish for this page (ui/i18n.js translates the DOM; canvas place names stay as the game spells them)
  window.I18N?.add({
    'Chest spots from fortnite.gg': 'fortnite.gg sandık noktaları', 'draw and save your looting route': 'yağma rotanı çiz ve kaydet',
    'Updating from fortnite.gg…': 'fortnite.gg\'den güncelleniyor…', 'Getting the map spots from fortnite.gg…': 'Harita noktaları fortnite.gg\'den alınıyor…',
    'fortnite-api.com did not answer': 'fortnite-api.com yanıt vermedi', 'fortnite.gg changed its map data': 'fortnite.gg harita verisini değiştirmiş',
    'Get fresh spots from fortnite.gg': 'fortnite.gg\'den yeni noktaları al', 'Updates in the app': 'Uygulamada güncellenir',
    Route: 'Rota', Move: 'Kaydır', Draw: 'Çiz', 'Auto route': 'Oto rota', Stops: 'Durak',
    'Drag to move · wheel to zoom': 'Sürükleyerek kaydır · tekerlekle yakınlaştır',
    'Click to add a point · right-click removes the last': 'Tıklayınca nokta eklenir · sağ tık sonuncuyu siler',
    'Click where you land: ReChest builds the fastest chest route from there': 'İneceğin yere tıkla: ReChest oradan en hızlı sandık rotasını kurar',
    'Waiting for the chest spots': 'Sandık noktaları bekleniyor',
    Distance: 'Mesafe', 'Chests on route': 'Rotadaki sandık', 'Est. time': 'Tahmini süre', 'Route name': 'Rota adı', Save: 'Kaydet', Clear: 'Temizle',
    'fortnite.gg check': 'fortnite.gg doğrulaması', 'fortnite.gg wants a quick check. Pass it below and ReChest takes the spots.': 'fortnite.gg kısa bir doğrulama istiyor. Aşağıda geç, ReChest noktaları alsın.',
    'Shows here in the app': 'Uygulamada burada görünür', Close: 'Kapat',
    'The map could not load (offline?)': 'Harita yüklenemedi (internet yok mu?)', 'Loading map…': 'Harita yükleniyor…',
    'Show in game': 'Oyunda göster', 'Track me in matches': 'Maçta konumumu takip et', 'Reads the minimap every second while you move': 'Hareket ederken mini haritayı her saniye okur', 'Reads the minimap twice a second while you move': 'Hareket ederken mini haritayı saniyede iki kez okur', 'Reads the minimap a few times a second': 'Mini haritayı saniyede birkaç kez okur',
    'Map overlay': 'Harita overlay\'i', 'The map card over Fortnite during a match: your route, the chests and you. Placed and styled on its own, like the chest panel.': 'Maçta Fortnite\'un üstündeki harita kartı: rotan, sandıklar ve sen. Sandık paneli gibi kendi yeri ve görünümü var.',
    'Card zoom': 'Kart yakınlaştırması', 'Stop size': 'Durak boyutu', 'Tracking quality': 'Takip kalitesi', 'Higher reads the minimap more often: smoother and more exact, a bit more CPU': 'Yüksek, mini haritayı daha sık okur: daha akıcı ve daha doğru, biraz daha fazla işlemci', 'Low': 'Düşük', 'Balanced': 'Dengeli', 'High': 'Yüksek', 'Reads the minimap while you play': 'Oynarken mini haritayı okur', 'Chests in view': 'Görüşteki sandıklar', 'Marks nearby chest spots you are facing on screen, with their rough distance': 'Baktığın yöndeki yakın sandık noktalarını ekranda yaklaşık mesafeleriyle işaretler', 'Chests in view: range': 'Görüşteki sandıklar: mesafe', 'Chests in view: on / off': 'Görüşteki sandıklar: aç / kapa', 'Only spots closer than this': 'Sadece bundan yakın noktalar', 'None': 'Yok', 'Show title': 'Başlığı göster', 'Route, distance and keys above the map': 'Haritanın üstünde rota, mesafe ve kısayollar', 'Route from here': 'Buradan rota', 'A new route from where you stand; the old one is kept in Saved routes': 'Bulunduğun yerden yeni rota; eskisi Kayıtlı rotalar\'a eklenir', '18 chests': '18 sandık', 'Map card preview': 'Harita kartı önizlemesi', 'The chests on your route': 'Rotandaki sandıklar', 'How close the card follows you': 'Kartın seni ne kadar yakından takip ettiği',
    'Show / hide': 'Göster / gizle', 'Bigger card': 'Büyük kart', 'Full-screen map': 'Tam ekran harita', 'Scroll to zoom, drag to move; the same key or Esc closes it': 'Tekerlekle yakınlaştır, sürükleyerek gez; aynı tuş ya da Esc kapatır',
    'Track my position': 'Konumumu takip et', 'Press a key…': 'Bir tuşa bas…', 'Press F5 or Esc to close': 'Kapatmak için F5 ya da Esc',
    'Center on me': 'Beni ortala', 'You': 'Sen', 'Over Fortnite in matches': 'Maçta Fortnite\'un üstünde', 'Zoom in': 'Yakınlaştır', 'Zoom out': 'Uzaklaştır', 'Fit map': 'Haritayı sığdır',
    // fortnite.gg layer groups and names
    Loot: 'Ganimet', Sprites: 'Sprite\'lar', Movement: 'Hareket', Vehicles: 'Araçlar', Healing: 'İyileşme', Fishing: 'Balıkçılık', Other: 'Diğer', NPCs: 'NPC\'ler',
    Vaults: 'Kasalar', Chests: 'Sandıklar', 'Buried Chests': 'Gömülü Sandıklar', 'Rare Chests': 'Nadir Sandıklar', 'Loot Cannons': 'Ganimet Topları',
    'Ammo Boxes': 'Mühimmat Kutuları', 'Sprite Chests': 'Sprite Sandıkları', 'Wanted Posters': 'Aranıyor Afişleri', 'Extraction Sites': 'Tahliye Noktaları',
    'Launch Pads': 'Fırlatma Rampaları', Cannons: 'Toplar', 'Sports Cars': 'Spor Arabalar', Motorboats: 'Sürat Tekneleri', 'Off-Road Tires': 'Arazi Lastikleri',
    Ziplines: 'Teleferikler', 'Port-a-Potty': 'Seyyar Tuvalet', Campfires: 'Kamp Ateşleri', 'Produce Boxes': 'Ürün Kasaları', 'Slurp Barrels': 'Slurp Varilleri',
    'Slurp Trucks': 'Slurp Kamyonları', 'Slurp Cacti': 'Slurp Kaktüsleri', 'Fishing Rods': 'Oltalar', 'Fishing Spots': 'Balık Noktaları', 'Reboot Vans': 'Reboot Minibüsleri',
  });
  window.I18N?.rules([
    [/^([\d.,]+) chests$/i, '$1 sandık'], [/^([\d.,]+) points$/i, '$1 nokta'], [/^Delete (.+)$/i, '$1 sil'],
    [/^(\S+) turns it on and off$/i, '$1 ile açılıp kapanır'], [/^(\S+) makes it bigger$/i, '$1 ile büyür'], [/^(\S+) full-screen map$/i, '$1 tam ekran harita'],
    [/^Press (\S+) or Esc to close$/i, 'Kapatmak için $1 ya da Esc'], [/^(\S+) new route from where you are$/i, '$1 bulunduğun yerden yeni rota'],
    [/^Got ([\d.,]+) spots from fortnite\.gg$/i, 'fortnite.gg\'den $1 nokta alındı'], [/^Route (\d+)$/i, 'Rota $1'],
  ]);

  /* ---------- spaces ---------- */
  const FIT0 = { kx: 1171.61, bx: -141417, ky: -1171.6, by: -149458 }; // Nov 2026 fit, until the app sends its own
  const fitOf = () => S.file?.fit || FIT0;
  const toImg = (p) => { const f = fitOf(); return [(8 * (p.x - f.bx)) / f.kx, (-8 * (p.y - f.by)) / f.ky]; };
  const toWorld = (ix, iy) => { const f = fitOf(); return { x: Math.round((f.kx * ix) / 8 + f.bx), y: Math.round((f.ky * -iy) / 8 + f.by) }; };

  /* ---------- pictures: tiles, fallback map, icons ---------- */
  const pics = new Map(); // url -> Image (loading, loaded or failed)
  function pic(url) {
    let im = pics.get(url);
    if (!im) {
      im = new Image();
      im.onload = () => { im.ok = true; queueDraw(); };
      im.onerror = () => { im.bad = true; if (url.includes('/maps/')) tileErrors++; queueDraw(); };
      im.src = url;
      pics.set(url, im);
    }
    return im;
  }
  let tileErrors = 0;
  const tileUrl = (z, x, y) => `https://fortnite.gg/maps/${S.file?.map || '43'}/${z}/${x}/${y}.webp`;
  const iconOf = (id) => (S.iconBase && id ? pic(S.iconBase + id + '.png') : null);

  let root, cv, ctx, raf = 0;
  const queueDraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };

  /* ---------- layers and route maths ---------- */
  const isChest = (c) => c.key.includes('chest');
  const shown = () => S.cats.filter((c) => S.on.includes(c.key));
  const routable = () => shown().filter(isChest).flatMap((c) => c.items);
  const length = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0) / 100; // metres
  function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  }
  function onRoute(pts) {
    if (!pts.length) return [];
    const items = routable();
    if (pts.length === 1) return items.filter((c) => Math.hypot(c.x - pts[0].x, c.y - pts[0].y) < NEAR);
    return items.filter((c) => pts.some((p, i) => i && segDist(c, pts[i - 1], p) < NEAR));
  }
  const saveRoute = () => store('rechest.route', S.route);
  const eta = (m, chests) => { const t = Math.round(m / RUN + chests * OPEN); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

  /** Auto route: from the landing spot take the nearest unvisited chest n times (nearest neighbour), then untangle
      the order with 2-opt on the open path (start fixed). Straight-line distance; terrain and buildings are ignored. */
  function autoRoute(start, items, n) {
    const left = items.slice(), pts = [start];
    while (pts.length <= n && left.length) {
      const at = pts[pts.length - 1];
      let bi = 0, bd = Infinity;
      left.forEach((c, i) => { const d = Math.hypot(c.x - at.x, c.y - at.y); if (d < bd) { bd = d; bi = i; } });
      pts.push(left.splice(bi, 1)[0]);
    }
    const D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    for (let better = true; better;) {
      better = false;
      for (let i = 1; i < pts.length - 1; i++) {
        for (let k = i + 1; k < pts.length; k++) {
          const a = pts[i - 1], b = pts[i], c = pts[k], d = pts[k + 1];
          if (D(a, c) + (d ? D(b, d) : 0) < D(a, b) + (d ? D(c, d) : 0) - 1) { pts.splice(i, k - i + 1, ...pts.slice(i, k + 1).reverse()); better = true; }
        }
      }
    }
    return pts.map((p) => ({ x: p.x, y: p.y }));
  }
  function buildAuto() {
    if (!S.land) return;
    const items = routable();
    S.route = items.length ? autoRoute(S.land, items, S.stops) : [S.land];
    saveRoute();
  }

  /* ---------- the map card over the game (RouteOverlay.cs): the app draws the card; this sends its map picture ---------- */
  const keyName = (vk) => (vk >= 0x70 && vk <= 0x87 ? 'F' + (vk - 0x6f) : 'Key ' + vk);
  const tr = (t) => (window.T ? window.T(t) : t);
  const overMap = new Image(); // fortnite-api's picture: it allows reading back from a canvas, fortnite.gg's tiles don't
  overMap.crossOrigin = 'anonymous';
  overMap.onload = () => sendRoute(true);
  overMap.src = FALLBACK;
  let sentRoute = null, routeTimer = 0;
  let sentPrefs = '';
  function sendRoute(force) {
    const prefs = JSON.stringify([S.on, S.stops]);
    if (prefs !== sentPrefs && window.chrome?.webview && S.cats.length) { sentPrefs = prefs; send({ type: 'routePrefs', on: S.on, stops: S.stops }); }
    if (!window.chrome?.webview || !overMap.naturalWidth) return;
    const key = JSON.stringify(S.route) + S.on.join() + (S.file?.updatedUtc || '') + LOCALE + S.routeDot; // layers matter: every shown chest is on the card
    if (!force && key === sentRoute) return;
    sentRoute = key;
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => send({ type: 'routeImg', ...routeBase() }), 250);
  }
  /** The card's map: always the whole island (the card follows you anywhere, not only along the route) with every
      shown chest as a small dot; the route and its stops go as points, which the card draws over it. JPEG keeps it
      light; it's sent only when the route, layers or stop size change. */
  function routeBase() {
    const pts = S.route.map(toImg), has = pts.length > 1;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const [bx0, by0, bx1, by1] = has ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : [0, 0, 2048, 2048];
    const x0 = 0, y0 = 0, x1 = 2048, y1 = 2048;
    const ppu = 1.25; // picture px per map px: sharp at the card's default zoom
    const c = document.createElement('canvas');
    c.width = Math.round((x1 - x0) * ppu); c.height = Math.round((y1 - y0) * ppu);
    const x = c.getContext('2d'), at = (p) => [(p[0] - x0) * ppu, (p[1] - y0) * ppu];
    x.fillStyle = '#2f8fd8'; x.fillRect(0, 0, c.width, c.height);
    x.imageSmoothingQuality = 'high';
    x.drawImage(overMap, -x0 * ppu, -y0 * ppu, 2048 * ppu, 2048 * ppu);
    const on = has ? onRoute(S.route) : [], dot = S.routeDot / 100; // stop size from Settings › Overlay
    for (const it of routable()) { // every chest of the shown layers: plain yellow dots (the card rings the route's own)
      const [a, b2] = at(toImg(it));
      x.beginPath(); x.arc(a, b2, 1.7 * dot * ppu, 0, 7); x.fillStyle = '#ffc83d'; x.fill(); x.lineWidth = 0.6 * dot * ppu; x.strokeStyle = '#1a1200'; x.stroke();
    }
    const dist = length(S.route), r1 = (v) => Math.round(v * 10) / 10;
    return {
      img: c.toDataURL('image/jpeg', 0.86), x0, y0, ppu,
      route: has ? pts.map(([a, b2]) => [r1(a), r1(b2)]) : null, stops: on.map((it) => toImg(it).map(r1)),
      cx: (bx0 + bx1) / 2, cy: (by0 + by1) / 2, span: has ? Math.max(bx1 - bx0, by1 - by0) : 0,
      stats: has ? `${dist >= 1000 ? fmt.format(dist / 1000) + ' km' : Math.round(dist) + ' m'} · ${tr(`${fmt.format(on.length)} chests`)} · ${eta(dist, on.length)}` : '',
    };
  }

  /* ---------- fortnite.gg check view: the app lays a browser view over #fggArea, so it follows that box ---------- */
  let fggTimer = null, lastBox = '';
  function syncFgg() {
    const a = root?.querySelector('#fggArea'), main = document.getElementById('main');
    if (!S.fgg || !a?.isConnected) { clearInterval(fggTimer); fggTimer = null; lastBox = ''; return send({ type: 'fggHide' }); }
    const r = a.getBoundingClientRect(), m = main ? main.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    const bar = document.querySelector('.top')?.getBoundingClientRect().bottom ?? 0; // the page scrolls under the floating top bar
    const top = Math.max(r.top, m.top, bar), hh = Math.max(1, Math.min(r.bottom, m.bottom) - top); // clip to the visible page
    const box = [r.left, top, r.width, hh].map(Math.round);
    if (box.join() !== lastBox) { lastBox = box.join(); send({ type: 'fgg', x: box[0], y: box[1], w: box[2], h: box[3] }); }
  }
  const watchFgg = () => { if (S.fgg && !fggTimer && window.chrome?.webview) fggTimer = setInterval(syncFgg, 150); };

  /* ---------- canvas ---------- */
  function fit() {
    const w = cv.clientWidth, hh = cv.clientHeight;
    const s = Math.min(w, hh) / 1250; // the island fills about 1250 px of the 2048 px map
    S.view = { s, ox: w / 2 - 1080 * s, oy: hh / 2 - 1130 * s };
  }
  function zoomAt(f, sx, sy) {
    const v = S.view, s = Math.min(24, Math.max(0.15, v.s * f));
    v.ox = sx - ((sx - v.ox) * s) / v.s;
    v.oy = sy - ((sy - v.oy) * s) / v.s;
    v.s = s;
    queueDraw();
  }

  /** fortnite.gg tiles: z3 (8 x 8) always as the base, then the zoom that matches the screen, only where visible. */
  function drawMap(w, hh, dpr) {
    const { s, ox, oy } = S.view;
    if (tileErrors > 12) { // the site's tiles don't load here: fortnite-api's picture instead
      const im = pic(FALLBACK);
      if (im.ok) ctx.drawImage(im, 0, 0, 2048, 2048);
      return;
    }
    const z = Math.max(3, Math.min(8, Math.ceil(Math.log2((8 * s * dpr) / 1.15))));
    for (const zz of z > 3 ? [3, z] : [3]) {
      const n = 2 ** zz, size = 2048 / n;
      const x0 = Math.max(0, Math.floor(-ox / s / size)), x1 = Math.min(n - 1, Math.floor((w - ox) / s / size));
      const y0 = Math.max(0, Math.floor(-oy / s / size)), y1 = Math.min(n - 1, Math.floor((hh - oy) / s / size));
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const im = pic(tileUrl(zz, x, y));
          if (im.ok) ctx.drawImage(im, x * size, y * size, size + 0.5 / s, size + 0.5 / s); // +half a pixel hides seams
        }
      }
    }
  }

  /** One layer's markers stacked like fortnite.gg: computed in map space once per half zoom step (cached), so
      stacks stay put while panning and only merge or split when the zoom crosses a step. A marker joins the first
      stack whose centre is within CLUSTER screen px at that step, else starts its own. On-route chests are left out
      (drawn on their own, ringed). */
  const stackCache = new Map();
  function clusters(cat, s, skip, routeKey) {
    const step = Math.floor(Math.log2(s) * 2) / 2, spread = s >= SPREAD;
    const key = `${cat.key}|${spread ? 'all' : step}|${routeKey}`;
    let out = stackCache.get(key);
    if (out) return out;
    const r = CLUSTER / 2 ** step, r2 = spread ? 0 : r * r; // radius in map px at this step
    out = [];
    for (const it of cat.items) {
      if (skip.has(it)) continue;
      const [ix, iy] = toImg(it);
      const c = r2 ? out.find((o) => (o.cx - ix) ** 2 + (o.cy - iy) ** 2 < r2) : null;
      if (c) { c.n++; c.x += ix; c.y += iy; } else out.push({ n: 1, x: ix, y: iy, cx: ix, cy: iy, icon: it.icon || cat.icon });
    }
    out = out.map((c) => ({ n: c.n, x: c.x / c.n, y: c.y / c.n, icon: c.icon }));
    if (stackCache.size > 400) stackCache.clear(); // old route versions
    stackCache.set(key, out);
    return out;
  }
  function marker(x, y, icon, n, size, ring) {
    const im = iconOf(icon);
    if (ring) { ctx.beginPath(); ctx.arc(x, y, size * 0.62, 0, 7); ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fill(); }
    if (im?.ok) ctx.drawImage(im, x - size / 2, y - size / 2, size, size);
    else { ctx.beginPath(); ctx.arc(x, y, size * 0.22, 0, 7); ctx.fillStyle = DOT; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#000'; ctx.stroke(); }
    if (n > 1) {
      const t = n > 999 ? '999+' : String(n);
      ctx.font = '900 11px Inter, sans-serif';
      const bw = Math.max(18, ctx.measureText(t).width + 9), bx = x + size * 0.18, by = y - size * 0.62;
      ctx.beginPath(); ctx.roundRect(bx, by, bw, 17, 8.5); ctx.fillStyle = '#e8213a'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, bx + bw / 2, by + 9);
    }
  }
  function labels(s, ox, oy) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    for (const l of S.file?.labels || []) {
      const poi = l.kind === 'poi';
      if (!poi && s < 0.55) continue; // landmarks once zoomed in a bit
      const [ix, iy] = toImg(l), x = ox + ix * s, y = oy + iy * s;
      ctx.font = `italic 900 ${poi ? 15 : 11.5}px Inter, sans-serif`;
      ctx.lineWidth = poi ? 4.5 : 3.5; ctx.strokeStyle = 'rgba(0,0,0,.9)'; ctx.strokeText(l.name, x, y);
      ctx.fillStyle = poi ? '#fff' : '#e6e1c9'; ctx.fillText(l.name, x, y);
    }
  }

  function draw() {
    if (!cv?.isConnected) return;
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, hh = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
    if (!S.view) fit();
    const { s, ox, oy } = S.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy); // map space
    ctx.imageSmoothingQuality = 'high';
    drawMap(w, hh, dpr);
    const px = 1 / s;
    if (S.route.length) {
      const pts = S.route.map(toImg);
      ctx.lineJoin = ctx.lineCap = 'round';
      for (const [wd, col] of [[8, 'rgba(0,0,30,.6)'], [4, '#ffffff']]) {
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.lineWidth = wd * px; ctx.strokeStyle = col; ctx.stroke();
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // screen space: icons and names keep their size at any zoom
    const hit = new Set(onRoute(S.route));
    const size = Math.max(22, Math.min(34, 20 + s * 6));
    const routeKey = S.route.map((p) => p.x + ':' + p.y).join();
    for (const cat of shown()) for (const c of clusters(cat, s, hit, routeKey)) marker(ox + c.x * s, oy + c.y * s, c.icon, c.n, size, false);
    for (const it of hit) { const [ix, iy] = toImg(it); marker(ox + ix * s, oy + iy * s, it.icon, 1, size + 4, true); }
    labels(s, ox, oy);
    if (S.me && Date.now() - S.me.t < 60e3) { // from the minimap (MinimapTracker.cs), a few seconds old at most
      const x = ox + S.me.x * s, y = oy + S.me.y * s;
      if (S.me.h != null) { // where you look: a soft cone ahead, like a phone map
        const a = (S.me.h * Math.PI) / 180, g = ctx.createRadialGradient(x, y, 4, x, y, 58);
        g.addColorStop(0, 'rgba(59,156,255,.55)'); g.addColorStop(1, 'rgba(59,156,255,0)');
        ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, 58, a - 0.55, a + 0.55); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
      }
      ctx.beginPath(); ctx.arc(x, y, 17, 0, 7); ctx.fillStyle = 'rgba(59,156,255,.22)'; ctx.fill();
      ctx.save(); ctx.translate(x, y);
      if (S.me.h != null) { ctx.rotate((S.me.h * Math.PI) / 180); ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(-7, -8); ctx.lineTo(-3, 0); ctx.lineTo(-7, 8); ctx.closePath(); }
      else { ctx.beginPath(); ctx.arc(0, 0, 8, 0, 7); }
      ctx.fillStyle = '#3b9cff'; ctx.fill(); ctx.lineJoin = 'round'; ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.restore();
      ctx.font = 'italic 900 11px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.85)';
      ctx.strokeText(tr('You').toLocaleUpperCase(LOCALE), x, y - 20); ctx.fillStyle = '#fff'; ctx.fillText(tr('You').toLocaleUpperCase(LOCALE), x, y - 20);
    }
    S.route.forEach((p, i) => {
      const [ix, iy] = toImg(p);
      ctx.beginPath(); ctx.arc(ox + ix * s, oy + iy * s, i === 0 ? 8 : 5, 0, 7);
      ctx.fillStyle = i === 0 ? '#5cdc6e' : i === S.route.length - 1 ? '#ffc83d' : '#fff';
      ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = '#0a1440'; ctx.stroke();
    });
    const m = root.querySelector('#mapMsg'), base = tileErrors > 12 ? pics.get(FALLBACK) : pics.get(tileUrl(3, 4, 4));
    m.textContent = base?.bad ? 'The map could not load (offline?)' : base?.ok ? '' : 'Loading map…';
    m.hidden = !m.textContent;
    // the side panel only changes with the route, layers or data, not while panning
    const key = [S.route.length, S.route[0]?.x, S.routeOn, S.track, S.routeZoom, S.mode, S.stops, S.fgg, S.msg, S.busy, S.error, S.saved.length, S.file?.updatedUtc, S.on.join()].join();
    if (key !== sideKey) { sideKey = key; side(); }
    sendRoute();
  }
  let sideKey = '';

  /* ---------- side panel ---------- */
  function side() {
    const el = root.querySelector('#mapSide');
    if (!el) return;
    const on = onRoute(S.route), dist = length(S.route), any = S.cats.length > 0;
    const updated = S.file?.updatedUtc ? new Date(S.file.updatedUtc).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }) : '';
    const groups = [...new Set(S.cats.map((c) => c.group))];
    const ico = (id) => (S.iconBase && id ? `<img src="${h(S.iconBase + id)}.png" alt="" onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'lay-dot'}))">` : '<i class="lay-dot"></i>');
    const status = S.busy ? 'Updating from fortnite.gg…' : S.error ? S.error : any ? `fortnite.gg · ${h(updated)}` : 'Getting the map spots from fortnite.gg…';
    el.innerHTML = `
      <section class="panel map-layers">
        <div class="ph"><div><h2>Map</h2><small>${status}</small></div><button class="see" data-map="update" ${S.busy ? 'disabled' : ''} title="Get fresh spots from fortnite.gg">↻</button></div>
        <div class="lay-list">${groups.map((g) => `<div class="lay-g"><small>${h(g)}</small>${S.cats.filter((c) => c.group === g).map((c) => `
          <button class="lay ${S.on.includes(c.key) ? 'on' : ''}" data-map="layer" data-k="${h(c.key)}">${ico(c.icon)}<span>${h(c.name)}</span><b>${fmt.format(c.items.length)}</b><i class="switch ${S.on.includes(c.key) ? 'on' : ''}"><i></i></i></button>`).join('')}</div>`).join('')}</div>
        ${S.msg ? `<small class="map-note">${h(S.msg)}</small>` : ''}
      </section>
      <section class="panel">
        <div class="ph"><div><h2>Route</h2><small>${{ pan: 'Drag to move · wheel to zoom', draw: 'Click to add a point · right-click removes the last', auto: any ? 'Click where you land: ReChest builds the fastest chest route from there' : 'Waiting for the chest spots' }[S.mode]}</small></div></div>
        <div class="mode">${[['pan', 'Move'], ['draw', 'Draw'], ['auto', 'Auto route']].map(([m, l]) => `<button class="${S.mode === m ? 'on' : ''}" data-map="${m}">${l}</button>`).join('')}</div>
        ${S.mode === 'auto' ? `<label class="map-stops"><span>Stops</span><input type="range" id="mapStops" min="2" max="${MAX_STOPS}" value="${S.stops}" style="--p:${stopsPct(S.stops)}"><input type="number" id="stopsNum" min="2" max="${MAX_STOPS}" value="${S.stops}" aria-label="Stops"></label>` : ''}
        <div class="map-stats">
          <div><small>Distance</small><b>${dist >= 1000 ? fmt.format(dist / 1000) + ' km' : Math.round(dist) + ' m'}</b></div>
          <div><small>Chests on route</small><b>${any ? on.length : '–'}</b></div>
          <div><small>Est. time</small><b>${S.route.length > 1 ? eta(dist, on.length) : '–'}</b></div>
        </div>
        <label class="map-stops"><span>Card zoom</span><input type="range" id="cardZoom" min="50" max="300" step="10" value="${S.routeZoom}" style="--p:${((S.routeZoom - 50) / 250) * 100}%"><b id="cardZoomVal">${S.routeZoom}%</b></label>
        <button class="map-ov" data-map="overlay"><span><b>Show in game</b><small>Over Fortnite in matches · ${keyName(S.routeKey)} turns it on and off · ${keyName(S.routeBigKey)} makes it bigger · ${keyName(S.routeFullKey)} full-screen map · ${keyName(S.routeHereKey)} new route from where you are</small></span><i class="switch ${S.routeOn ? 'on' : ''}"><i></i></i></button>
        <button class="map-ov" data-map="track"><span><b>Track me in matches</b><small>Reads the minimap while you play</small></span><i class="switch ${S.track ? 'on' : ''}"><i></i></i></button>
        <div class="map-save"><input id="routeName" maxlength="40" placeholder="Route name" aria-label="Route name"><button class="btn sm accent" data-map="save" ${S.route.length > 1 ? '' : 'disabled'}>Save</button><button class="btn sm" data-map="clear" ${S.route.length ? '' : 'disabled'}>Clear</button></div>
        ${S.saved.length ? `<div class="map-routes">${S.saved.map((r, i) => `<div class="map-route"><button class="mr-load" data-map="load" data-i="${i}"><b>${h(r.name)}</b><small>${Math.round(length(r.pts))} m · ${any ? onRoute(r.pts).length + ' chests' : r.pts.length + ' points'}</small></button><button class="see" data-map="del" data-i="${i}" aria-label="Delete ${h(r.name)}">✕</button></div>`).join('')}</div>` : ''}
      </section>
      ${S.fgg ? `<section class="panel map-fgg"><div class="ph"><div><h2>fortnite.gg check</h2><small>fortnite.gg wants a quick check. Pass it below and ReChest takes the spots.</small></div><button class="see" data-map="fggClose" aria-label="Close">✕</button></div>
        <div class="fgg-area" id="fggArea">${window.chrome?.webview ? '' : '<small>Shows here in the app</small>'}</div></section>` : ''}`;
    lastBox = '';
  }

  function act(t) {
    const a = t.dataset.map, i = Number(t.dataset.i);
    if (a === 'in' || a === 'out') return zoomAt(a === 'in' ? 1.5 : 1 / 1.5, cv.clientWidth / 2, cv.clientHeight / 2);
    if (a === 'fit') { fit(); return queueDraw(); }
    if (a === 'layer') {
      const k = t.dataset.k;
      S.on = S.on.includes(k) ? S.on.filter((x) => x !== k) : S.on.concat(k);
      store('rechest.map.layers', S.on);
      buildAuto();
      return draw();
    }
    if (a === 'update') { S.msg = ''; S.fggClosed = false; send({ type: 'fggUpdate' }); if (!window.chrome?.webview) S.msg = 'Updates in the app'; return draw(); }
    if (a === 'pan' || a === 'draw' || a === 'auto') { S.mode = a; cv.classList.toggle('drawing', a !== 'pan'); return draw(); }
    if (a === 'track') { S.track = !S.track; send({ type: 'mapTrack', on: S.track }); return draw(); }
    if (a === 'me') {
      if (!S.me) return;
      const v = S.view; v.s = Math.max(v.s, 1.5); v.ox = cv.clientWidth / 2 - S.me.x * v.s; v.oy = cv.clientHeight / 2 - S.me.y * v.s;
      return queueDraw();
    }
    if (a === 'overlay') { S.routeOn = !S.routeOn; send({ type: 'routeOverlay', on: S.routeOn }); return draw(); }
    if (a === 'clear') { S.route = []; S.land = null; saveRoute(); return draw(); }
    if (a === 'save') {
      const name = root.querySelector('#routeName').value.trim() || `Route ${S.saved.length + 1}`;
      S.saved = S.saved.filter((r) => r.name !== name).concat({ name, pts: S.route });
      store('rechest.routes', S.saved);
      sideKey = ''; return draw();
    }
    if (a === 'load') { S.route = S.saved[i].pts.slice(); saveRoute(); return draw(); }
    if (a === 'del') { S.saved.splice(i, 1); store('rechest.routes', S.saved); return draw(); }
    if (a === 'fggClose') { S.fgg = false; S.fggClosed = true; draw(); return syncFgg(); }
  }

  function mount(el) {
    root = el;
    sideKey = '';
    el.innerHTML = `<div class="map2">
      <section class="panel map-stage"><canvas id="mapCv" class="${S.mode === 'pan' ? '' : 'drawing'}"></canvas><div class="map-msg" id="mapMsg" hidden></div>
        <div class="map-zoom"><button data-map="in" aria-label="Zoom in">+</button><button data-map="out" aria-label="Zoom out">−</button><button data-map="fit" aria-label="Fit map">⤢</button><button data-map="me" aria-label="Center on me" title="Center on me">◎</button></div>
      </section>
      <aside class="map-side" id="mapSide"></aside></div>`;
    cv = el.querySelector('#mapCv');
    ctx = cv.getContext('2d');
    el.addEventListener('click', (e) => { const t = e.target.closest('[data-map]'); if (t) act(t); });
    el.addEventListener('input', (e) => { if (e.target.id === 'mapStops') { e.target.style.setProperty('--p', stopsPct(e.target.value)); root.querySelector('#stopsNum').value = e.target.value; } });
    el.addEventListener('input', (e) => { if (e.target.id === 'cardZoom') { e.target.style.setProperty('--p', ((e.target.value - 50) / 250) * 100 + '%'); root.querySelector('#cardZoomVal').textContent = e.target.value + '%'; } });
    el.addEventListener('change', (e) => { if (e.target.id === 'cardZoom') { S.routeZoom = Number(e.target.value); send({ type: 'routeZoom', value: S.routeZoom }); } });
    el.addEventListener('change', (e) => {
      if (e.target.id !== 'mapStops' && e.target.id !== 'stopsNum') return;
      S.stops = Math.max(2, Math.min(MAX_STOPS, Math.round(Number(e.target.value)) || 2));
      store('rechest.map.stops', S.stops);
      buildAuto();
      sideKey = '';
      draw();
    });
    el.addEventListener('keydown', (e) => {
      if (e.target.id === 'routeName' && e.key === 'Enter') act({ dataset: { map: 'save' } });
      if (e.target.id === 'stopsNum' && e.key === 'Enter') e.target.blur(); // blur fires change
    });

    let down = null;
    cv.addEventListener('pointerdown', (e) => { if (e.button === 0) { down = { x: e.clientX, y: e.clientY, moved: false }; cv.setPointerCapture(e.pointerId); } });
    cv.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) < 4) return;
      down.moved = true;
      S.view.ox += dx; S.view.oy += dy;
      down.x = e.clientX; down.y = e.clientY;
      queueDraw();
    });
    cv.addEventListener('pointerup', (e) => {
      const click = down && !down.moved;
      down = null;
      if (!click) return;
      const r = cv.getBoundingClientRect(), v = S.view, sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (S.mode === 'pan') return;
      const p = toWorld((sx - v.ox) / v.s, (sy - v.oy) / v.s);
      if (S.mode === 'auto') { S.land = p; buildAuto(); } else { S.route.push(p); saveRoute(); }
      draw();
    });
    cv.addEventListener('dblclick', (e) => { const r = cv.getBoundingClientRect(); if (S.mode === 'pan') zoomAt(2, e.clientX - r.left, e.clientY - r.top); });
    cv.addEventListener('contextmenu', (e) => { e.preventDefault(); if (S.mode === 'draw' && S.route.length) { S.route.pop(); saveRoute(); draw(); } });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); const r = cv.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    new ResizeObserver(queueDraw).observe(cv);
    draw();
    watchFgg();
  }

  /** From the app: { file: { updatedUtc, map, fit, cats: [{ key, name, group, icon, items: [[x, y, icon]] }], labels },
      busy, needsCheck, error, iconBase }. */
  function setChests(st) {
    if (!st) return;
    const fresh = st.file?.updatedUtc && st.file.updatedUtc !== S.file?.updatedUtc;
    Object.assign(S, { busy: !!st.busy, needsCheck: !!st.needsCheck, error: st.error || '', iconBase: st.iconBase || '', routeOn: st.routeOn ?? S.routeOn, routeKey: st.routeKey || S.routeKey, routeBigKey: st.routeBigKey || S.routeBigKey, routeFullKey: st.routeFullKey || S.routeFullKey, routeDot: st.routeDot || S.routeDot, routeZoom: st.routeZoom || S.routeZoom, routeHereKey: st.routeHereKey || S.routeHereKey, track: st.track ?? S.track });
    if (fresh) {
      S.file = st.file;
      stackCache.clear();
      S.cats = (st.file.cats || []).map((c) => ({ ...c, items: c.items.map(([x, y, icon]) => ({ x, y, icon })) }));
      if (S.fgg) S.msg = `Got ${fmt.format(S.cats.reduce((n, c) => n + c.items.length, 0))} spots from fortnite.gg`;
      S.fgg = false;
    }
    const nr = st.newRoute;
    if (nr?.id && nr.id !== load('rechest.route.applied', '')) {
      store('rechest.route.applied', nr.id); // first view to see it takes it (the other gets the storage event)
      if (S.route.length > 1) {
        const t = new Date();
        S.saved = S.saved.concat({ name: `${tr('Route')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`, pts: S.route });
        store('rechest.routes', S.saved);
      }
      S.route = nr.pts.map((p) => ({ x: p.x, y: p.y }));
      S.land = null;
      saveRoute();
      stackCache.clear();
      sideKey = '';
    }
    if (S.needsCheck && !S.fgg && !S.fggClosed && !fresh) { S.fgg = true; watchFgg(); } // the hidden fetch hit fortnite.gg's check: show it
    draw();
    syncFgg();
    sendRoute();
  }

  /** Your position (2048 px map space) and facing (degrees, 0 = east, 90 = south) from the app, every second in a match. */
  /** Position reads come every 0.5 s while moving, facing ~7 times a second; the marker glides to each (the short way round). */
  let meTarget = null, glideAt = 0;
  function setPos(x, y, h) {
    meTarget = { x, y, h: Number.isFinite(h) ? h : null, t: Date.now() };
    const far = !S.me || Math.hypot(S.me.x - x, S.me.y - y) > 60; // a jump (relocated, new match): no glide
    if (far || !cv?.isConnected) { S.me = { ...meTarget }; queueDraw(); return; }
    S.me.t = meTarget.t;
    if (!glideAt) { glideAt = performance.now(); requestAnimationFrame(glide); }
  }
  function setHeading(h) {
    if (!S.me || !Number.isFinite(h)) return;
    meTarget = { ...(meTarget || S.me), h, t: Date.now() };
    if (!cv?.isConnected) { S.me.h = h; return; }
    if (!glideAt) { glideAt = performance.now(); requestAnimationFrame(glide); }
  }
  function glide(now) {
    if (!cv?.isConnected || !meTarget) { glideAt = 0; if (meTarget) S.me = { ...meTarget }; return; }
    if (now - glideAt < 33) { requestAnimationFrame(glide); return; } // ~30 fps: smooth, and light on the PC
    const a = 1 - Math.exp(-(now - glideAt) / 110); // reads every 0.5 s (facing ~7/s): catch up fast, still smooth
    glideAt = now;
    S.me.x += (meTarget.x - S.me.x) * a;
    S.me.y += (meTarget.y - S.me.y) * a;
    if (meTarget.h == null) S.me.h = null;
    else if (S.me.h == null) S.me.h = meTarget.h;
    else S.me.h += ((((meTarget.h - S.me.h) % 360) + 540) % 360 - 180) * a;
    draw();
    const done = Math.hypot(meTarget.x - S.me.x, meTarget.y - S.me.y) < 0.05 && (meTarget.h == null || Math.abs((((meTarget.h - S.me.h) % 360) + 540) % 360 - 180) < 0.3);
    if (done) { glideAt = 0; return; }
    requestAnimationFrame(glide);
  }

  /** Settings › Overlay: the map card as it will look over the game with these settings (laid out like RouteOverlay.cs:
      256 px wide at 100%, the map window 236 px, following you at the card zoom). */
  let pvArgs = null;
  function cardPreview(el, st) {
    if (!el || !st) return;
    pvArgs = [el, st];
    if (!el.querySelector('.pv-card')) el.innerHTML = '<canvas class="pv-screen"></canvas><canvas class="pv-card"></canvas>';
    screenPreview(el.querySelector('.pv-screen'), st);
    const none = st.mapStyle === 'none', head = st.mapHeader !== false, pad = none ? 0 : 10, top = (head ? 46 : 0) + pad;
    const sc = (st.mapScale || 100) / 100, V = 236, W = V + 2 * pad, H = top + V + pad, k = devicePixelRatio || 1;
    const c = el.querySelector('.pv-card');
    c.width = Math.round(W * sc * k); c.height = Math.round(H * sc * k);
    c.style.width = W * sc + 'px'; c.style.height = H * sc + 'px';
    c.style.opacity = (st.mapOpacity || 95) / 100;
    const x = c.getContext('2d');
    x.setTransform(sc * k, 0, 0, sc * k, 0, 0);
    const acc = st.mapAccent || '#FFC93C';
    const [bg, line] = { solid: ['rgba(16,17,22,.98)', acc + '5a'], minimal: ['rgba(0,0,0,.43)', 'transparent'], none: ['transparent', 'transparent'] }[st.mapStyle] || ['rgba(14,15,20,.73)', 'rgba(255,255,255,.2)'];
    x.beginPath(); x.roundRect(0.5, 0.5, W - 1, H - 1, 16); x.fillStyle = bg; x.fill(); x.lineWidth = 1; x.strokeStyle = line; x.stroke();
    x.textBaseline = 'alphabetic'; x.textAlign = 'left';
    if (head) {
    x.fillStyle = acc; x.font = 'italic 900 15px "Segoe UI", Inter, sans-serif';
    x.fillText(tr('Route').toLocaleUpperCase(LOCALE), 10, 25);
    x.fillStyle = 'rgba(230,236,255,.88)'; x.font = '700 11px "Segoe UI", Inter, sans-serif';
    x.fillText(`521 m · ${tr('18 chests')} · 2:03`, 10, 41);
    x.textAlign = 'right'; x.fillStyle = 'rgba(255,255,255,.6)'; x.font = '700 10px "Segoe UI", Inter, sans-serif';
    x.fillText(`${keyName(st.routeFullKey || 0x74)} ⛶   ${keyName(st.routeBigKey || 0x75)} ⤢   ${keyName(st.routeKey || 0x76)}`, W - 10, 21);
    }
    // the map window, following "you" near Lantern Landing with a short sample route
    const ox = pad, oy = top, cx = 905, cy = 1050, span = 170 / ((st.routeZoom || 100) / 100), kk = V / span, dot = (st.routeDot || 100) / 100;
    const at = ([a, b]) => [ox + V / 2 + (a - cx) * kk, oy + V / 2 + (b - cy) * kk];
    x.save();
    x.beginPath(); x.roundRect(ox, oy, V, V, 10); x.clip();
    x.fillStyle = '#2f8fd8'; x.fillRect(ox, oy, V, V);
    if (overMap.naturalWidth) x.drawImage(overMap, ox + V / 2 - cx * kk, oy + V / 2 - cy * kk, 2048 * kk, 2048 * kk);
    else overMap.addEventListener('load', () => pvArgs && cardPreview(...pvArgs), { once: true });
    const route = [[860, 1100], [880, 1072], [905, 1050], [935, 1040], [962, 1012], [990, 1000]];
    x.lineJoin = x.lineCap = 'round';
    for (const [wd, col] of [[3.4, 'rgba(0,0,30,.7)'], [1.8, '#fff']]) {
      x.beginPath(); route.forEach((p, i) => { const [a, b] = at(p); i ? x.lineTo(a, b) : x.moveTo(a, b); });
      x.lineWidth = wd * kk; x.strokeStyle = col; x.stroke();
    }
    for (const p of [[870, 1088], [893, 1062], [925, 1043], [948, 1028], [975, 1006]]) {
      const [a, b] = at(p); x.beginPath(); x.arc(a, b, 2 * dot * kk, 0, 7); x.fillStyle = '#ffc83d'; x.fill(); x.lineWidth = 0.7 * dot * kk; x.strokeStyle = '#1a1200'; x.stroke();
    }
    x.translate(ox + V / 2, oy + V / 2); x.rotate(-0.5);
    x.beginPath(); x.moveTo(10, 0); x.lineTo(-6.5, -7); x.lineTo(-2.5, 0); x.lineTo(-6.5, 7); x.closePath();
    x.fillStyle = '#3b9cff'; x.fill(); x.lineJoin = 'round'; x.lineWidth = 2; x.strokeStyle = '#fff'; x.stroke();
    x.restore();
  }

  /** Where the card sits on a 1080p game screen (corner, offsets, size), with the game's minimap and, when on, the
      "chests in view" marks; a fifth of real size. */
  function screenPreview(c, st) {
    const f = 0.2, SW = 1920 * f, SH = 1080 * f, k = devicePixelRatio || 1;
    c.width = SW * k; c.height = SH * k; c.style.width = SW + 'px'; c.style.height = SH + 'px';
    const x = c.getContext('2d');
    x.setTransform(k, 0, 0, k, 0, 0);
    const sky = x.createLinearGradient(0, 0, 0, SH);
    sky.addColorStop(0, '#7cc4f2'); sky.addColorStop(0.5, '#a9d8f0'); sky.addColorStop(0.52, '#6aa84f'); sky.addColorStop(1, '#3a7d3a');
    x.fillStyle = sky; x.fillRect(0, 0, SW, SH);
    // the game's own minimap, top right
    const mm = 251 * f;
    x.fillStyle = 'rgba(40,120,190,.9)'; x.fillRect(SW - (32 + 251) * f, 32 * f, mm, mm);
    if (overMap.naturalWidth) x.drawImage(overMap, 760, 900, 300, 300, SW - (32 + 251) * f, 32 * f, mm, mm);
    x.strokeStyle = 'rgba(255,255,255,.7)'; x.lineWidth = 1; x.strokeRect(SW - (32 + 251) * f, 32 * f, mm, mm);
    // crosshair
    x.strokeStyle = 'rgba(255,255,255,.8)'; x.beginPath(); x.moveTo(SW / 2 - 4, SH / 2); x.lineTo(SW / 2 + 4, SH / 2); x.moveTo(SW / 2, SH / 2 - 4); x.lineTo(SW / 2, SH / 2 + 4); x.stroke();
    // chests in view: two sample marks on their line
    if (st.mapPointers !== false) for (const [dx, d] of [[-50, 24], [38, 41]]) {
      const px = SW / 2 + dx, py = SH * 0.56;
      x.fillStyle = '#ffc83d'; x.fillRect(px - 4, py - 6, 8, 6); x.fillStyle = '#fff'; x.font = '800 6px "Segoe UI", sans-serif'; x.textAlign = 'center'; x.fillText(`≈${d} m`, px, py + 6);
    }
    // the card where the settings put it
    const sc = (st.mapScale || 100) / 100, none = st.mapStyle === 'none', head = st.mapHeader !== false, pad = none ? 0 : 10;
    const w = (236 + 2 * pad) * sc * f, h = ((head ? 46 : 0) + pad + 236 + pad) * sc * f;
    const cx = /r$/.test(st.mapCorner || 'tr') ? SW - w - (st.mapX ?? 24) * f : (st.mapX ?? 24) * f;
    const cy = /^b/.test(st.mapCorner || 'tr') ? SH - h - (st.mapY ?? 320) * f : (st.mapY ?? 320) * f;
    x.globalAlpha = (st.mapOpacity || 95) / 100;
    const bg = { solid: 'rgba(16,17,22,.98)', minimal: 'rgba(0,0,0,.43)', none: 'transparent' }[st.mapStyle] || 'rgba(14,15,20,.73)';
    x.beginPath(); x.roundRect(cx, cy, w, h, 4); x.fillStyle = bg; x.fill();
    const m = pad * sc * f, top = ((head ? 46 : 0) + pad) * sc * f, v = 236 * sc * f;
    x.fillStyle = '#2f8fd8'; x.fillRect(cx + m, cy + top, v, v);
    if (overMap.naturalWidth) x.drawImage(overMap, 800, 950, 220, 220, cx + m, cy + top, v, v);
    if (head) { x.fillStyle = st.mapAccent || '#FFC93C'; x.fillRect(cx + m, cy + m + 2 * sc * f, 50 * sc * f, 8 * sc * f); }
    x.globalAlpha = 1;
    x.strokeStyle = st.mapAccent || '#FFC93C'; x.lineWidth = 1.5; x.setLineDash([3, 2]); x.strokeRect(cx - 1, cy - 1, w + 2, h + 2); x.setLineDash([]);
  }

  function centerOnMe() { if (S.me && cv?.isConnected) act({ dataset: { map: 'me' } }); }

  // the Map page and the big F5 map are two views of one map: what one saves (route, saved routes, layers, stops)
  // the other picks up at once (both use this profile's storage, which tells the other views when it changes)
  addEventListener('storage', (e) => {
    const k = { 'rechest.route': 'route', 'rechest.routes': 'saved', 'rechest.map.layers': 'on', 'rechest.map.stops': 'stops' }[e.key];
    if (!k) return;
    S[k] = load(e.key, S[k]);
    if (k === 'route') S.land = null; // a route made elsewhere: no landing spot here to rebuild from
    stackCache.clear();
    sideKey = '';
    draw();
  });

  window.MapUI = { mount, setChests, setPos, setHeading, centerOnMe, cardPreview, draw };

  // self-checks: spaces round-trip and match a known POI; auto route order; 2-opt never makes a route longer
  const [lx, ly] = toImg({ x: -51707, y: 16134 }); // Arlong Park: fortnite.gg [-141.34, 76.57] x 8
  console.assert(Math.abs(lx - 612.6) < 2 && Math.abs(ly - 1130.7) < 2, 'map space drifted');
  const back = toWorld(...toImg({ x: 1000, y: -2000 }));
  console.assert(Math.abs(back.x - 1000) < 2 && Math.abs(back.y + 2000) < 2, 'map round-trip');
  const ar = autoRoute({ x: 0, y: 0 }, [{ x: 300, y: 0 }, { x: 100, y: 0 }, { x: 9000, y: 0 }, { x: 200, y: 0 }], 3);
  console.assert(ar.map((p) => p.x).join() === '0,100,200,300', 'auto route order');
  const zig = autoRoute({ x: 0, y: 0 }, [{ x: 100, y: 10 }, { x: 100, y: -10 }, { x: 200, y: 12 }, { x: 200, y: -12 }, { x: 300, y: 0 }], 5);
  console.assert(length(zig) <= length([{ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 100, y: -10 }, { x: 200, y: -12 }, { x: 200, y: 12 }, { x: 300, y: 0 }]) + 0.01, '2-opt');
})();
