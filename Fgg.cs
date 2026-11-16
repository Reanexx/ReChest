using System.IO;
using System.Net.Http;
using System.Text.Json;

namespace ChestCounter;

/// Map spots from fortnite.gg. Its page builds window.Data (every map layer: name, group, icon, markers as [lat, lng] in
/// the site's own map space) from data/spawns.js and data/{lang}.js. A script run in that page posts the layers, the
/// named locations and the game icons the layers use; the locations are matched by name to fortnite-api.com's POI world
/// coordinates, and a straight-line fit per axis converts every spot to world centimetres (Nov 2026: 15 POIs, under
/// 1 m error). Fitting on every capture keeps it right when a season moves the map. The site's [lat, lng] space is also
/// fortnite-api's 2048 px map picture divided by 8, which the Map page uses to draw (ui/map.js).
public static class Fgg
{
    public const string Script = """
        (async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          for (let i = 0; i < 60 && !(window.Data?.data && window.Spawns); i++) await wait(500);
          if (!window.Data?.data) return;
          const strip = (s) => String(s ?? '').replace(/<[^>]*>[\s\S]*$/, '').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
          const cats = [], labels = [], icons = new Set();
          for (const [sk, sec] of Object.entries(Data.data)) {
            for (const [key, c] of Object.entries(sec?.sub || {})) {
              const pts = [];
              for (const m of c?.markers || []) {
                if (!Array.isArray(m?.coords)) continue;
                if (m.name && !Array.isArray(m.coords[0])) { labels.push({ name: strip(m.name), kind: key, lat: m.coords[0], lng: m.coords[1] }); continue; }
                const add = (p) => { if (typeof p?.[0] === 'number') pts.push([p[0], p[1], m.icon ?? c.menu_icon ?? 0]); else if (Array.isArray(p)) p.forEach(add); }; // lines (ziplines) nest one level deeper
                m.coords.forEach(add);
              }
              if (!pts.length) continue;
              cats.push({ key, name: strip(c.name) || key, group: c.group || strip(sec.name) || sk, icon: c.menu_icon ?? pts[0][2], pts });
              icons.add(c.menu_icon); pts.forEach((p) => icons.add(p[2]));
            }
          }
          const img = {};
          for (const id of icons) {
            if (!Number.isInteger(id) || id <= 0) continue;
            try {
              const b = await fetch('/icons/' + id + '.png').then((r) => (r.ok ? r.blob() : null));
              if (b) img[id] = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(b); });
            } catch { /* that icon stays a dot */ }
          }
          window.chrome.webview.postMessage(JSON.stringify({ map: String(Data.map ?? ''), cats, labels, img }));
        })();
        """;

    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };
    static string Key(string name) => name.ToUpperInvariant().Replace('’', '\'').Trim();

    public static async Task<Dictionary<string, (double X, double Y)>> WorldPois()
    {
        using var doc = JsonDocument.Parse(await Http.GetStringAsync("https://fortnite-api.com/v1/map"));
        var pois = new Dictionary<string, (double X, double Y)>();
        foreach (var p in doc.RootElement.GetProperty("data").GetProperty("pois").EnumerateArray())
        {
            var loc = p.GetProperty("location");
            pois[Key(p.GetProperty("name").GetString() ?? "")] = (loc.GetProperty("x").GetDouble(), loc.GetProperty("y").GetDouble());
        }
        return pois;
    }

    /// The page's post -> chests.json content (world cm) and the icons as PNG bytes by id. Throws InvalidDataException
    /// when the site's locations no longer line up with the map's.
    public static (object Map, Dictionary<int, byte[]> Icons) Convert(string payload, Dictionary<string, (double X, double Y)> world)
    {
        using var doc = JsonDocument.Parse(payload);
        var root = doc.RootElement;
        var labels = root.GetProperty("labels").EnumerateArray()
            .Where(l => l.GetProperty("lat").ValueKind == JsonValueKind.Number && l.GetProperty("lng").ValueKind == JsonValueKind.Number)
            .Select(l => (Name: l.GetProperty("name").GetString() ?? "", Kind: l.GetProperty("kind").GetString() ?? "", Lat: l.GetProperty("lat").GetDouble(), Lng: l.GetProperty("lng").GetDouble()))
            .ToList();
        var pairs = labels.Where(l => world.ContainsKey(Key(l.Name))).ToList();
        if (pairs.Count < 3) throw new InvalidDataException($"only {pairs.Count} fortnite.gg locations match the map's POIs");
        var (kx, bx) = Fit(pairs.Select(p => p.Lng).ToList(), pairs.Select(p => world[Key(p.Name)].X).ToList());
        var (ky, by) = Fit(pairs.Select(p => p.Lat).ToList(), pairs.Select(p => world[Key(p.Name)].Y).ToList());
        var worst = pairs.Max(p => Math.Max(Math.Abs(kx * p.Lng + bx - world[Key(p.Name)].X), Math.Abs(ky * p.Lat + by - world[Key(p.Name)].Y)));
        if (worst > 5000) throw new InvalidDataException($"fortnite.gg locations are {worst / 100:F0} m off the map's POIs"); // 50 m
        double X(double lng) => Math.Round(kx * lng + bx);
        double Y(double lat) => Math.Round(ky * lat + by);

        var cats = root.GetProperty("cats").EnumerateArray().Select(c => new
        {
            Key = c.GetProperty("key").GetString(),
            Name = c.GetProperty("name").GetString(),
            Group = c.GetProperty("group").GetString(),
            Icon = Int(c.GetProperty("icon")),
            Items = c.GetProperty("pts").EnumerateArray().Where(p => p.GetArrayLength() >= 2 && p[0].ValueKind == JsonValueKind.Number && p[1].ValueKind == JsonValueKind.Number).Select(p => new[] { X(p[1].GetDouble()), Y(p[0].GetDouble()), Int(p.GetArrayLength() > 2 ? p[2] : default) }).ToList(),
        }).ToList();
        var icons = new Dictionary<int, byte[]>();
        foreach (var i in root.GetProperty("img").EnumerateObject())
        {
            var data = i.Value.GetString() ?? "";
            var comma = data.IndexOf(',');
            if (!int.TryParse(i.Name, out var id) || id <= 0 || !data.StartsWith("data:image/") || comma < 0) continue;
            var bytes = System.Convert.FromBase64String(data[(comma + 1)..]);
            if (bytes.Length > 8 && bytes[0] == 0x89 && bytes[1] == 'P') icons[id] = bytes; // PNG only
        }
        return (new
        {
            UpdatedUtc = DateTime.UtcNow,
            Map = root.TryGetProperty("map", out var mv) ? mv.GetString() : "", // tile set name, e.g. "43"
            Fit = new { Kx = kx, Bx = bx, Ky = ky, By = by },
            Cats = cats,
            Labels = labels.Select(l => new { l.Name, l.Kind, X = X(l.Lng), Y = Y(l.Lat) }),
        }, icons);
    }

    static int Int(JsonElement e) => e.ValueKind == JsonValueKind.Number && e.TryGetInt32(out var i) ? i : 0;

    /// Least-squares line y = k x + b.
    static (double K, double B) Fit(List<double> xs, List<double> ys)
    {
        double mx = xs.Average(), my = ys.Average();
        var k = xs.Zip(ys, (x, y) => (x - mx) * (y - my)).Sum() / xs.Sum(x => (x - mx) * (x - mx));
        return (k, my - k * mx);
    }

    /// Self-check on a made-up map: three named locations with a known linear mapping, one layer (App --selftest).
    public static void SelfTest()
    {
        var world = new Dictionary<string, (double X, double Y)> { ["A"] = (1000, -2000), ["B'S"] = (3000, 0), ["C"] = (1000, 4000) };
        const string payload = """
            {"labels":[{"name":"A","kind":"poi","lat":-10,"lng":5},{"name":"B’s","kind":"poi","lat":-12,"lng":7},{"name":"C","kind":"landmarks","lat":-16,"lng":5}],
             "cats":[{"key":"chests","name":"Chests","group":"Loot","icon":3,"pts":[[-11,6,2]]}],"img":{"2":"data:image/png;base64,AAAA","x":"y"}}
            """;
        var (map, icons) = Convert(payload, world);
        var json = JsonSerializer.Serialize(map);
        if (!json.Contains("\"Items\":[[2000,-1000,2]]") || icons.Count != 0)
            throw new InvalidOperationException("Fgg.Convert: " + json);
    }
}
