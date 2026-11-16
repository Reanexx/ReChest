using System.IO;
using System.Text.Json;

namespace ChestCounter;

/// "Route from here" (route-here key, F4 by default): a new looting route from where you stand, built by the app
/// itself so it works while the Map page sleeps in the tray. Same method as the Map page's auto route (ui/map.js):
/// nearest chest each time, then 2-opt to untangle; chests of the layers shown on the Map page; as many stops as set
/// there. Positions: world cm (the Map page's routes) and 2048 px map space (the card), converted with the fit the
/// fortnite.gg capture saved (Fgg.cs).
public static class RouteBuilder
{
    public const double Near = 1500; // a chest within 15 m of the route counts as on it (as on the Map page)
    const double Run = 6, Open = 2;  // sprint m/s and seconds per chest, for the time estimate

    public record Result(List<double[]> World, List<double[]> Img, List<double[]> StopsImg, double Metres, int Chests, string Stats);

    /// The chests of the layers shown on the Map page, in world cm, and the world <-> map space fit; null without data.
    public record Chests(List<double[]> Items, double Kx, double Bx, double Ky, double By)
    {
        public double[] ToImg(double[] w) => [8 * (w[0] - Bx) / Kx, -8 * (w[1] - By) / Ky];
        public double[] ToWorld(double imgX, double imgY) => [Kx * imgX / 8 + Bx, Ky * -imgY / 8 + By];
    }

    public static Chests Load(AppSettings s)
    {
        JsonElement root;
        try { root = JsonDocument.Parse(File.ReadAllText(StatsWindow.ChestMapFile)).RootElement; }
        catch (Exception e) when (e is IOException or JsonException) { return null; }
        if (!root.TryGetProperty("fit", out var fit) || !root.TryGetProperty("cats", out var cats)) return null;
        var layers = s.MapLayers is { Length: > 0 } l ? l : AppSettings.DefaultLayers;
        var items = new List<double[]>();
        foreach (var c in cats.EnumerateArray())
        {
            var key = c.GetProperty("key").GetString() ?? "";
            if (!key.Contains("chest") || !layers.Contains(key)) continue;
            foreach (var it in c.GetProperty("items").EnumerateArray()) items.Add([it[0].GetDouble(), it[1].GetDouble()]);
        }
        return items.Count == 0 ? null : new Chests(items, fit.GetProperty("kx").GetDouble(), fit.GetProperty("bx").GetDouble(), fit.GetProperty("ky").GetDouble(), fit.GetProperty("by").GetDouble());
    }

    /// From (imgX, imgY) in map space; null without chest data.
    public static Result FromHere(double imgX, double imgY, AppSettings s)
    {
        if (Load(s) is not { } data) return null;
        var items = data.Items;
        double[] ToImg(double[] w) => data.ToImg(w);
        var start = data.ToWorld(imgX, imgY).Select(v => Math.Round(v)).ToArray();
        var route = Auto(start, items, Math.Clamp(s.RouteStops, 2, 500));
        var on = items.Where(it => Enumerable.Range(1, route.Count - 1).Any(i => SegDist(it, route[i - 1], route[i]) < Near)).ToList();
        var metres = Enumerable.Range(1, route.Count - 1).Sum(i => Dist(route[i - 1], route[i])) / 100;
        var secs = (int)Math.Round(metres / Run + on.Count * Open);
        var tr = s.Lang == "tr";
        var dist = metres >= 1000 ? (metres / 1000).ToString("0.#", tr ? new System.Globalization.CultureInfo("tr-TR") : System.Globalization.CultureInfo.InvariantCulture) + " km" : $"{Math.Round(metres)} m";
        var stats = $"{dist} · {on.Count} {(tr ? "sandık" : "chests")} · {secs / 60}:{secs % 60:00}";
        return new Result(route, route.Select(ToImg).ToList(), on.Select(ToImg).ToList(), metres, on.Count, stats);
    }

    /// Nearest unvisited chest n times from the start, then 2-opt on the open path (start fixed). Straight lines.
    public static List<double[]> Auto(double[] start, IList<double[]> items, int n)
    {
        var left = items.ToList();
        var pts = new List<double[]> { start };
        while (pts.Count <= n && left.Count > 0)
        {
            var at = pts[^1];
            var bi = 0;
            for (var i = 1; i < left.Count; i++) if (Dist(left[i], at) < Dist(left[bi], at)) bi = i;
            pts.Add(left[bi]);
            left.RemoveAt(bi);
        }
        for (var better = true; better;)
        {
            better = false;
            for (var i = 1; i < pts.Count - 1; i++)
                for (var k = i + 1; k < pts.Count; k++)
                {
                    var d = k + 1 < pts.Count ? pts[k + 1] : null;
                    if (Dist(pts[i - 1], pts[k]) + (d != null ? Dist(pts[i], d) : 0) < Dist(pts[i - 1], pts[i]) + (d != null ? Dist(pts[k], d) : 0) - 1)
                    {
                        pts.Reverse(i, k - i + 1);
                        better = true;
                    }
                }
        }
        return pts;
    }

    static double Dist(double[] a, double[] b) => Math.Sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]));

    static double SegDist(double[] p, double[] a, double[] b)
    {
        double dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
        var t = l > 0 ? Math.Clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l, 0, 1) : 0;
        return Math.Sqrt(Math.Pow(p[0] - a[0] - t * dx, 2) + Math.Pow(p[1] - a[1] - t * dy, 2));
    }

    /// Self-check (App --selftest): the 3 nearest of 4 chests in a line, in order; 2-opt never makes it longer.
    public static void SelfTest()
    {
        var r = Auto([0, 0], [[300, 0], [100, 0], [9000, 0], [200, 0]], 3);
        if (string.Join(",", r.Select(p => p[0])) != "0,100,200,300") throw new InvalidOperationException("RouteBuilder order");
        var zig = Auto([0, 0], [[100, 10], [100, -10], [200, 12], [200, -12], [300, 0]], 5);
        double Len(List<double[]> p) => Enumerable.Range(1, p.Count - 1).Sum(i => Dist(p[i - 1], p[i]));
        if (Len(zig) > Len([[0, 0], [100, 10], [100, -10], [200, -12], [200, 12], [300, 0]]) + 0.01) throw new InvalidOperationException("RouteBuilder 2-opt");
    }
}
