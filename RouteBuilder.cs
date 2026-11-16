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

    const double Looted = 500; // a chest within 5 m of where you have been this match was most likely opened

    static readonly List<double[]> trail = [];
    static DateTime? trailMatch;

    /// Where you have been this match (map space, from the minimap): new routes leave out the chests right by it,
    /// so they don't send you back to what you already looted. A new match (match = its start time) starts afresh.
    public static void Seen(double imgX, double imgY, DateTime? match)
    {
        lock (trail)
        {
            if (match != trailMatch) { trail.Clear(); trailMatch = match; }
            if (match != null && (trail.Count == 0 || Math.Abs(trail[^1][0] - imgX) + Math.Abs(trail[^1][1] - imgY) > 1)) trail.Add([imgX, imgY]);
        }
    }

    /// From (imgX, imgY) in map space, facing heading (degrees, 0 = east, 90 = south; NaN = unknown); null without chest data.
    public static Result FromHere(double imgX, double imgY, double heading, AppSettings s)
    {
        if (Load(s) is not { } data) return null;
        List<double[]> been;
        lock (trail) been = trail.Select(p => data.ToWorld(p[0], p[1])).ToList();
        var items = data.Items.Where(it => !been.Any(p => Dist(p, it) < Looted)).ToList();
        double[] ToImg(double[] w) => data.ToImg(w);
        var start = data.ToWorld(imgX, imgY).Select(v => Math.Round(v)).ToArray();
        double[] dir = null;
        if (!double.IsNaN(heading))
        {
            var ahead = data.ToWorld(imgX + 100 * Math.Cos(heading * Math.PI / 180), imgY + 100 * Math.Sin(heading * Math.PI / 180));
            var len = Dist(ahead, start);
            if (len > 0) dir = [(ahead[0] - start[0]) / len, (ahead[1] - start[1]) / len];
        }
        var route = Auto(start, items, Math.Clamp(s.RouteStops, 2, 500), dir);
        var on = items.Where(it => Enumerable.Range(1, route.Count - 1).Any(i => SegDist(it, route[i - 1], route[i]) < Near)).ToList();
        var metres = Enumerable.Range(1, route.Count - 1).Sum(i => Dist(route[i - 1], route[i])) / 100;
        var secs = (int)Math.Round(metres / Run + on.Count * Open);
        var tr = s.Lang == "tr";
        var dist = metres >= 1000 ? (metres / 1000).ToString("0.#", tr ? new System.Globalization.CultureInfo("tr-TR") : System.Globalization.CultureInfo.InvariantCulture) + " km" : $"{Math.Round(metres)} m";
        var stats = $"{dist} · {on.Count} {(tr ? "sandık" : "chests")} · {secs / 60}:{secs % 60:00}";
        return new Result(route, route.Select(ToImg).ToList(), on.Select(ToImg).ToList(), metres, on.Count, stats);
    }

    const double Lean = 5;     // how much the first third of a route is pulled toward the way you face (0 = not at all)
    const double Cluster = 4000; // chests within 40 m of each other count as one cluster for the greedy start

    /// n chests from start in the least walking: many randomised greedy routes (the first one plain), each leaning
    /// into chest clusters, then polished by 2-opt, moving single stops, and swapping stops for unused chests nearby;
    /// the shortest wins. dir (unit vector, world) pulls the first third of the route toward the way you face, so a
    /// route made while running from the storm keeps going that way. Straight lines; terrain and buildings ignored.
    public static List<double[]> Auto(double[] start, IList<double[]> items, int n, double[] dir = null)
    {
        n = Math.Min(n, items.Count);
        if (n <= 0) return [start];
        var pool = items.OrderBy(c => Dist(start, c) * Pull(start, c, dir)).Take(Math.Max(5 * n, 60)).ToList();
        var dense = pool.Select(c => pool.Count(o => Dist(c, o) < Cluster)).ToArray(); // includes itself
        var rnd = new Random(1); // same place, same facing, same chests: the same (best) route
        var tries = Math.Clamp(3000 / (n * n / 4 + 10), n > 100 ? 1 : 6, 120); // long routes: one careful pass is enough
        List<double[]> best = null;
        var bestCost = double.MaxValue;
        for (var t = 0; t < tries; t++)
        {
            var r = Greedy(start, pool, dense, n, dir, t == 0 ? null : rnd);
            Polish(r, pool, dir);
            var c = Cost(r, dir);
            if (c < bestCost) (best, bestCost) = (r, c);
        }
        return best;
    }

    // >= 1: how much going from start to c turns away from dir (1 = straight ahead, 1 + Lean = straight behind)
    static double Pull(double[] start, double[] c, double[] dir)
    {
        if (dir == null) return 1;
        var d = Dist(start, c);
        return d < 1 ? 1 : 1 + Lean * (1 - ((c[0] - start[0]) * dir[0] + (c[1] - start[1]) * dir[1]) / d) / 2;
    }

    // walking length, plus the facing pull on the first third of the stops
    static double Cost(List<double[]> r, double[] dir)
    {
        double len = 0;
        for (var i = 1; i < r.Count; i++) len += Dist(r[i - 1], r[i]);
        if (dir != null)
            for (var i = 1; i <= Math.Max(1, (r.Count - 1) / 3) && i < r.Count; i++) len += (Pull(r[0], r[i], dir) - 1) * Dist(r[0], r[i]);
        return len;
    }

    // nearest next chest, cheaper in clusters and (early on) ahead; with rnd one of the best three, for variety
    static List<double[]> Greedy(double[] start, List<double[]> pool, int[] dense, int n, double[] dir, Random rnd)
    {
        var used = new bool[pool.Count];
        var r = new List<double[]> { start };
        var early = Math.Max(1, n / 3);
        while (r.Count <= n)
        {
            var at = r[^1];
            int a = -1, b = -1, c = -1;
            double sa = double.MaxValue, sb = double.MaxValue, sc = double.MaxValue;
            for (var i = 0; i < pool.Count; i++)
            {
                if (used[i]) continue;
                var s = Dist(at, pool[i]) * (r.Count <= early ? Pull(start, pool[i], dir) : 1) / (1 + 0.15 * (dense[i] - 1));
                if (s < sa) { (c, sc, b, sb) = (b, sb, a, sa); (a, sa) = (i, s); }
                else if (s < sb) { (c, sc) = (b, sb); (b, sb) = (i, s); }
                else if (s < sc) (c, sc) = (i, s);
            }
            if (a < 0) break;
            var pick = rnd == null ? a : rnd.NextDouble() switch { < 0.6 => a, < 0.85 when b >= 0 => b, _ when c >= 0 => c, _ => a };
            used[pick] = true;
            r.Add(pool[pick]);
        }
        return r;
    }

    // local search until nothing helps: reverse a stretch (2-opt), move one stop elsewhere, swap a stop for an unused chest
    static void Polish(List<double[]> r, List<double[]> pool, double[] dir)
    {
        var cost = Cost(r, dir);
        bool Try(Action change, Action undo)
        {
            change();
            var c = Cost(r, dir);
            if (c < cost - 1) { cost = c; return true; }
            undo();
            return false;
        }
        const int W = 40; // moves look this many stops apart at most: long routes (up to 500 stops) stay quick
        for (var rounds = 0; rounds < 50; rounds++)
        {
            var better = false;
            for (var i = 1; i < r.Count - 1; i++)
                for (var k = i + 1; k < Math.Min(r.Count, i + W); k++)
                {
                    int ii = i, kk = k;
                    better |= Try(() => r.Reverse(ii, kk - ii + 1), () => r.Reverse(ii, kk - ii + 1));
                }
            for (var i = 1; i < r.Count; i++)
                for (var j = Math.Max(1, i - W); j < Math.Min(r.Count, i + W); j++)
                {
                    if (j == i) continue;
                    var p = r[i];
                    int ii = i, jj = j;
                    better |= Try(() => { r.RemoveAt(ii); r.Insert(jj, p); }, () => { r.RemoveAt(jj); r.Insert(ii, p); });
                }
            var inRoute = new HashSet<double[]>(r);
            for (var i = 1; i < r.Count; i++)
            {
                var old = r[i];
                foreach (var cand in pool.Where(c => !inRoute.Contains(c)).OrderBy(c => Dist(c, old)).Take(8))
                {
                    int ii = i;
                    if (Try(() => r[ii] = cand, () => r[ii] = old)) { inRoute.Remove(old); inRoute.Add(cand); better = true; break; }
                }
            }
            if (!better) break;
        }
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
        // facing: chests both ways at the same distance; the route starts the way you face
        double[][] both = [[1000, 0], [1100, 0], [1200, 0], [-1000, 0], [-1100, 0], [-1200, 0]];
        if (Auto([0, 0], both, 3, [1, 0])[1][0] < 0 || Auto([0, 0], both, 3, [-1, 0])[1][0] > 0) throw new InvalidOperationException("RouteBuilder facing");
    }
}
