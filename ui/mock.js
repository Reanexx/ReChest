// Preview data for opening index.html in a normal browser (design work). Inside the app the real history arrives
// from C# through window.chrome.webview, and this file does nothing.
if (!window.chrome?.webview) window.MOCK = (() => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const squad = ['Reanex', 'ForceRoad2pro', 'Pudochi', 'ForgottenYak5576'];
  const weight = [1, 1.6, 0.7, 0.45];
  const types = ['chest', 'chest', 'chest', 'chest', 'chest', 'chest', 'ammo', 'ammo', 'drop', 'llama', 'fishing'];
  const now = Date.now();
  const matches = [];
  const make = (start, dur, final) => {
    const opens = [];
    squad.forEach((p, i) => {
      const c = Math.floor(rnd() * 10 * weight[i] * dur / 1000);
      for (let j = 0; j < c; j++) opens.push({ t: Math.round(40 + rnd() * (dur - 40)), type: types[Math.floor(rnd() * types.length)], by: p, broken: rnd() < 0.35 });
    });
    opens.sort((a, b) => a.t - b.t);
    matches.push({ id: 'm' + matches.length, file: '', size: 0, startUtc: new Date(start).toISOString(), duration: Math.round(dur),
      placement: 1 + Math.floor(rnd() * rnd() * 30), kills: Math.floor(rnd() * 7), me: 'Reanex', squad, opens, final,
      skins: { Reanex: 'Character_SacredCuddle', ForceRoad2pro: 'CID_A_373_Athena_Commando_M_OriginPrisoner', Pudochi: 'Character_CactusBait', ForgottenYak5576: 'Character_RumbaShowy' } });
  };
  for (let d = 34; d >= 1; d--) {
    const n = rnd() < 0.3 ? 0 : 1 + Math.floor(rnd() * 4);
    const t0 = new Date(now - d * 864e5);
    t0.setHours(13 + Math.floor(rnd() * 9), Math.floor(rnd() * 60), 0, 0);
    for (let k = 0; k < n; k++) make(t0.getTime() + k * 27 * 60e3, 420 + rnd() * 1000, true);
  }
  make(now - 70 * 60e3, 837, true);
  make(now - 32 * 60e3, 760, true);
  // a match is being played right now (its chests arrive when it ends)
  return {
    matches, liveSince: new Date(now - 7 * 60e3).toISOString(),
    live: [{ type: 'chest', atUtc: new Date(now - 3 * 60e3).toISOString(), manual: false }, { type: 'chest', atUtc: new Date(now - 60e3).toISOString(), manual: true }],
    settings: { hud: true, hudCorner: 'tl', hudX: 24, hudY: 24, hudScale: 100, hudOpacity: 95, hudStyle: 'glass', hudAccent: '#3CCF6E', hudHints: false, hudPlus: true, hudLabels: true, receiveBroadcasts: true, addKey: 0x77, removeKey: 0x78, routeOverlay: true, routeZoom: 100, routeDot: 100, mapCorner: 'tr', mapX: 24, mapY: 320, mapScale: 100, mapOpacity: 95, mapStyle: 'glass', mapHeader: true, mapPointers: false, trackQuality: 'high', mapPointerRange: 60, pointerKey: 0x72, mapAccent: '#FFC93C', routeKey: 0x76, routeBigKey: 0x75, routeFullKey: 0x74, routeHereKey: 0x73, mapTrack: true, startWithWindows: true, showOnFortnite: true, closeToTray: true },
    keys: { interact: ['Mouse wheel down', 'O'], attack: ['Left click'] },
    demos: true, backups: { count: 41, bytes: 512e6 }, version: '2.0.0',
    images: ['chest', 'rare', 'ammo', 'drop', 'llama', 'fishing', 'faction'],
    chestMap: { file: window.MOCK_MAP, iconBase: 'https://fortnite.gg/icons/' }, // ui/mock-map.js
    imgBase: 'file:///C:/Users/d2105/AppData/Roaming/ChestCounter/img/', // design preview only
  };
})();

