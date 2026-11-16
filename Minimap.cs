using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;

namespace ChestCounter;

/// Where you are in a match, and which way you face, from the game's own minimap: twice a second while you move,
/// every 2 s while you stand still, facing alone 5 times a second (the page and the card glide between reads), while Fortnite is the active window, the
/// minimap square (top right) is captured and matched against the full map picture (fortnite-api.com, 2048 px) with
/// normalised cross-correlation: a coarse search over the whole map at 1/8 size, then a fine one around the best spot
/// at 1/2 size (after a fix, only near the last one: ~10 ms). The player arrow sits in the middle of the minimap, so
/// the middle of the match is the position, and the arrow's tip gives the facing (the minimap is north-up).
/// Only that small square is read; nothing is sent anywhere.
/// shortcut: minimap box and zoom measured at 1920x1080 with the default HUD scale (Nov 2026, the box is 251 px, 32 px
/// from the top right, and shows 238 px of the 2048 px map); a different HUD scale needs those numbers re-measured.
public sealed class MinimapTracker
{
    const double Box = 251, Margin = 32, Span = 238.45; // px at 1080p; Span = map px across the whole minimap
    const double SkipTop = 0.3; // the top of the minimap carries the place name; match on the rest
    // A position read is ~10 ms of one core after the first fix; facing alone comes from a ~40 px square around the
    // arrow (~1-2 ms). How often: Settings › Overlay › Map overlay › Tracking quality (High by default).
    public static readonly TimeSpan Idle = TimeSpan.FromSeconds(2);
    public Func<string> Quality = () => "high";
    (TimeSpan Moving, TimeSpan Still, TimeSpan Turn) Rates() => Quality() switch
    {
        "low" => (TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(3), TimeSpan.FromMilliseconds(300)),
        "balanced" => (TimeSpan.FromMilliseconds(500), TimeSpan.FromSeconds(2), TimeSpan.FromMilliseconds(200)),
        _ => (TimeSpan.FromMilliseconds(250), TimeSpan.FromSeconds(1), TimeSpan.FromMilliseconds(100)),
    };

    /// x, y in 2048 px map space (the Map page's space), facing in degrees (0 = east, 90 = south; NaN if unseen), score 0..1.
    public event Action<double, double, double, double> Found;
    /// Facing only (degrees), between position reads, when it changed.
    public event Action<double> Turned;
    Timer turnTimer;
    int turnBusy;
    double lastTurn = double.NaN, smooth = double.NaN, pendingTurn = double.NaN;

    static double Diff(double a, double b) => ((a - b) % 360 + 540) % 360 - 180;

    /// Reads of the arrow wobble by a few degrees: blend each into the running facing. A big change is taken only when
    /// the next read agrees (a real flick), so one bad read (a ping or teammate over the arrow) can't swing it.
    double Smooth(double h)
    {
        if (double.IsNaN(h)) return smooth;
        if (double.IsNaN(smooth)) return smooth = h;
        var d = Diff(h, smooth);
        if (Math.Abs(d) > 50)
        {
            var agrees = !double.IsNaN(pendingTurn) && Math.Abs(Diff(h, pendingTurn)) < 25;
            pendingTurn = agrees ? double.NaN : h;
            if (!agrees) return smooth;
            return smooth = h;
        }
        pendingTurn = double.NaN;
        return smooth = Diff(smooth + d * 0.6, 0);
    }

    (double X, double Y, DateTime At)? pending; // a far jump waiting for a second read to agree

    /// A new fix is taken unless it jumps farther than anyone moves (~60 m/s, plus slack) and isn't a near-perfect
    /// match: then the next read must land in the same place first. So one look-alike spot elsewhere on the map can't
    /// throw you across it, while a real relocation (respawn, launch) is taken a read later.
    bool Accept(double x, double y, double score)
    {
        var now = DateTime.UtcNow;
        if (last is var (lx, ly, at) && now - at < TimeSpan.FromSeconds(3))
        {
            var jump = Math.Sqrt((x - lx) * (x - lx) + (y - ly) * (y - ly));
            if (jump > 20 + 40 * (now - at).TotalSeconds && score < 0.85)
            {
                if (pending is not var (px, py, pt) || now - pt > TimeSpan.FromSeconds(3) || Math.Abs(px - x) + Math.Abs(py - y) > 12)
                {
                    pending = (x, y, now);
                    return false;
                }
            }
        }
        pending = null;
        last = (x, y, now);
        return true;
    }
    (double X, double Y, DateTime At)? last;
    public Func<bool> Active = () => false;

    Gray map8, map2; // the map at 1/8 and 1/2 size
    Timer timer;
    int busy;

    public void Start()
    {
        timer = new Timer(_ => timer.Change(Tick(), Timeout.InfiniteTimeSpan), null, TimeSpan.FromSeconds(3), Timeout.InfiniteTimeSpan);
        turnTimer = new Timer(_ => turnTimer.Change(TurnTick(), Timeout.InfiniteTimeSpan), null, TimeSpan.FromSeconds(3), Timeout.InfiniteTimeSpan);
    }

    /// The arrow alone, read from a small square around the minimap's middle, only while a position fix is fresh.
    TimeSpan TurnTick()
    {
        if (Interlocked.Exchange(ref turnBusy, 1) == 1) return Rates().Turn;
        try
        {
            if (last is not var (_, _, at) || DateTime.UtcNow - at > TimeSpan.FromSeconds(6) || !Active() || !Hud.FortniteInFront(out var win)) return Idle;
            var k = win.Height / 1080.0;
            int half = (int)Math.Ceiling(15 * k) + Math.Max(1, (int)Math.Round(3 * k)) + 1, side = 2 * half + 1;
            int cx = (int)Math.Round(win.Right - (Margin + Box) * k + Box * k / 2), cy = (int)Math.Round(win.Top + Margin * k + Box * k / 2);
            using var shot = new Bitmap(side, side, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(shot)) g.CopyFromScreen(cx - half, cy - half, 0, 0, shot.Size);
            var h = Smooth(Heading(shot, half, half, k));
            if (!double.IsNaN(h) && (double.IsNaN(lastTurn) || Math.Abs(Diff(h, lastTurn)) >= 1.5)) // same way: nothing to send
            {
                lastTurn = h;
                Turned?.Invoke(h);
            }
            return Rates().Turn;
        }
        catch (Exception e) when (e is ExternalException or ArgumentException or InvalidOperationException or Win32Exception) { return Idle; }
        finally { Volatile.Write(ref turnBusy, 0); }
    }
    (double X, double Y)? lastSent;

    static readonly string MapFile = Path.Combine(Replays.ImgDir, "map.png");

    async Task<bool> EnsureMap()
    {
        if (map8 != null) return true;
        try
        {
            if (!File.Exists(MapFile) || File.GetLastWriteTimeUtc(MapFile) < DateTime.UtcNow.AddDays(-3)) // a new season can move the map
            {
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
                var bytes = await http.GetByteArrayAsync("https://fortnite-api.com/images/map.png");
                Directory.CreateDirectory(Replays.ImgDir);
                await File.WriteAllBytesAsync(MapFile, bytes);
            }
            using var bmp = new Bitmap(MapFile);
            (map8, map2) = (Gray.From(bmp, bmp.Width / 8, bmp.Height / 8), Gray.From(bmp, bmp.Width / 2, bmp.Height / 2));
            return true;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or IOException or ArgumentException) { return false; } // offline: try again next tick
    }

    /// One read; returns when to read next.
    TimeSpan Tick()
    {
        var rate = Rates();
        if (Interlocked.Exchange(ref busy, 1) == 1) return rate.Moving;
        try
        {
            if (!Active() || !Hud.FortniteInFront(out var win) || !EnsureMap().GetAwaiter().GetResult()) return Idle;
            var k = win.Height / 1080.0;
            int size = (int)Math.Round(Box * k), skip = (int)Math.Round(size * SkipTop);
            using var shot = new Bitmap(size, size - skip, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(shot))
                g.CopyFromScreen(win.Right - (int)Math.Round((Margin + Box) * k), win.Top + (int)Math.Round(Margin * k) + skip, 0, 0, shot.Size);
            // the whole map is searched only when nothing near you has matched for a while (respawn, launch, first fix):
            // a minimap covered by a ping, the storm or open water then just keeps you where you were
            var lost = last is not var (_, _, seen) || DateTime.UtcNow - seen > TimeSpan.FromSeconds(3);
            if (Locate(shot, skip / (double)size, lost) is not var (x, y, score)) return rate.Moving; // nothing sure: look again soon
            if (lost) Sample(shot, "global", x, y, score);
            if (!Accept(x, y, score)) { Sample(shot, "jump", x, y, score); return rate.Moving; } // a far jump: check it with the next read
            Found?.Invoke(x, y, Smooth(Heading(shot, size / 2.0, size / 2.0 - skip, k)), score);
            var moved = lastSent is not var (lx, ly) || Math.Abs(lx - x) + Math.Abs(ly - y) > 2; // 2 map px ~ 3 m
            lastSent = (x, y);
            return moved ? rate.Moving : rate.Still;
        }
        catch (Exception e) when (e is ExternalException or ArgumentException or InvalidOperationException or Win32Exception) { return Idle; } // screen busy (UAC, lock screen)
        finally { Volatile.Write(ref busy, 0); }
    }

    /// The minimap picture (top part already cut off: skipFrac of its full height) -> its centre on the map.
    internal (double X, double Y, double Score)? Locate(Bitmap mini, double skipFrac, bool searchAll = true)
    {
        var full = Span; // map px across the full minimap
        var wMap = full; var hMap = full * (1 - skipFrac); // map px covered by the captured part
        // the game draws place names, pings, quest and teammate icons over its minimap; none of that is on the map
        // picture, so those pixels are left out of the match (Gray.Template)
        var t8 = Gray.Template(mini, (int)Math.Round(wMap / 8), (int)Math.Round(hMap / 8));
        if (t8.Std() < 4 || t8.Coverage() < 0.4) return null; // open water, a blank frame, or mostly covered
        var t2 = Gray.Template(mini, (int)Math.Round(wMap / 2), (int)Math.Round(hMap / 2));
        // template's top-left in 2048 px = 2 * (x2, y2); the minimap's centre is half a box right and (half - skipped) down
        (double, double, double) Fix(int x2, int y2, double s) => (2 * x2 + full / 2, 2 * y2 + full / 2 - full * skipFrac, s); // Accept() decides
        if (last is var (lx, ly, when) && DateTime.UtcNow - when < TimeSpan.FromSeconds(6))
        {
            // near the last fix: +-64 map px (~95 m) covers well over a read's worth of running, gliding or driving
            int ex = (int)Math.Round((lx - full / 2) / 2), ey = (int)Math.Round((ly - full / 2 + full * skipFrac) / 2);
            var (nx, ny, _) = Ncc(map2, t2, ex - 32, ey - 32, ex + 32, ey + 32, 2);
            var (fx, fy, fs) = Ncc(map2, t2, nx - 2, ny - 2, nx + 2, ny + 2, 1);
            if (fs >= 0.5) return Fix(fx, fy, fs); // a clear match near the last fix (near it, a look-alike is unlikely)
            if (!searchAll) return null; // not sure: hold the last place rather than jump to a look-alike elsewhere
        }
        var (x8, y8, _) = Ncc(map8, t8, 0, 0, map8.W - t8.W, map8.H - t8.H, 1);
        var (x2, y2, s2) = Ncc(map2, t2, x8 * 4 - 12, y8 * 4 - 12, x8 * 4 + 12, y8 * 4 + 12, 1);
        if (s2 < 0.5) return null; // not the minimap (map screen open, bus, menus), or too unsure
        return Fix(x2, y2, s2);
    }

    /// Facing from the white player arrow in the middle of the minimap. The arrow is a dart (~18 x 15 px at 1080p);
    /// its shape is laid at every degree, and a few px around the middle (its pivot isn't exactly there), over the
    /// pixels' whiteness: the best angle has the whitest inside against the darkest surroundings. Stray white
    /// (pings, teammates, place names) barely moves that, unlike reading the arrow's outline.
    /// Degrees, 0 = east (right), 90 = south (down); NaN when nothing arrow-like is there.
    internal static double Heading(Bitmap mini, double cx, double cy, double k)
    {
        int r = (int)Math.Ceiling(15 * k), off = Math.Max(1, (int)Math.Round(3 * k)), half = r + off;
        int x0 = (int)Math.Round(cx) - half, y0 = (int)Math.Round(cy) - half, side = 2 * half + 1;
        if (x0 < 0 || y0 < 0 || x0 + side > mini.Width || y0 + side > mini.Height) return double.NaN;
        using var part = mini.Clone(new Rectangle(x0, y0, side, side), PixelFormat.Format24bppRgb);
        var white = new float[side * side];
        var data = part.LockBits(new Rectangle(0, 0, side, side), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            var bytes = new byte[data.Stride * side];
            Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            for (var y = 0; y < side; y++)
                for (var x = 0; x < side; x++)
                {
                    var o = y * data.Stride + x * 3;
                    int lo = Math.Min(bytes[o], Math.Min(bytes[o + 1], bytes[o + 2])), hi = Math.Max(bytes[o], Math.Max(bytes[o + 1], bytes[o + 2]));
                    white[y * side + x] = (float)(Math.Clamp((lo - 140) / 90.0, 0, 1) * Math.Clamp(1 - (hi - lo) / 70.0, 0, 1));
                }
        }
        finally { part.UnlockBits(data); }

        var masks = Darts(k, r);
        var disk = masks[^1]; // last entry: every offset inside the disk
        double best = -1, angle = double.NaN;
        int bc = 0;
        double Score(int c, double sd, int deg)
        {
            var m = masks[(deg % 360 + 360) % 360];
            double si = 0;
            foreach (var d in m) si += white[c + d.Y * side + d.X];
            return si / m.Length - (sd - si) / (disk.Length - m.Length);
        }
        double Disk(int c) { double sd = 0; foreach (var d in disk) sd += white[c + d.Y * side + d.X]; return sd; }
        // every 5 degrees at each offset, then each degree around the best (5x cheaper than every degree everywhere)
        for (var oy = -off; oy <= off; oy++)
            for (var ox = -off; ox <= off; ox++)
            {
                var c = (half + oy) * side + half + ox;
                var sd = Disk(c);
                for (var deg = 0; deg < 360; deg += 5)
                    if (Score(c, sd, deg) is var v && v > best) (best, angle, bc) = (v, deg, c);
            }
        if (double.IsNaN(angle)) return double.NaN;
        var bsd = Disk(bc);
        for (var deg = (int)angle - 4; deg <= (int)angle + 4; deg++)
            if (Score(bc, bsd, deg) is var v && v > best) (best, angle) = (v, (deg % 360 + 360) % 360);
        return best > 0.35 ? (angle > 180 ? angle - 360 : angle) : double.NaN;
    }

    /// The dart's pixels at each whole degree (pointing +x at 0, y down), plus the disk around it, for one screen scale.
    static (double K, (int X, int Y)[][] Masks) dartCache;
    static (int X, int Y)[][] Darts(double k, int r)
    {
        if (dartCache.Masks != null && dartCache.K == k) return dartCache.Masks;
        // tip, upper back corner, notch, lower back corner, in 1080p px around the arrow's middle
        (double X, double Y)[] dart = [(11.5, 0), (-6.5, -7.3), (-3.5, 0), (-6.5, 7.3)];
        var masks = new (int X, int Y)[361][];
        for (var deg = 0; deg < 360; deg++)
        {
            double a = deg * Math.PI / 180, cos = Math.Cos(a), sin = Math.Sin(a);
            var poly = dart.Select(p => (X: (p.X * cos - p.Y * sin) * k, Y: (p.X * sin + p.Y * cos) * k)).ToArray();
            var inside = new List<(int, int)>();
            for (var y = -r; y <= r; y++)
                for (var x = -r; x <= r; x++)
                    if (InPolygon(poly, x, y)) inside.Add((x, y));
            masks[deg] = inside.ToArray();
        }
        var all = new List<(int, int)>();
        for (var y = -r; y <= r; y++)
            for (var x = -r; x <= r; x++)
                if (x * x + y * y <= r * r) all.Add((x, y));
        masks[360] = all.ToArray();
        dartCache = (k, masks);
        return masks;
    }

    static bool InPolygon((double X, double Y)[] poly, double x, double y)
    {
        var inside = false;
        for (int i = 0, j = poly.Length - 1; i < poly.Length; j = i++)
            if ((poly[i].Y > y) != (poly[j].Y > y) && x < (poly[j].X - poly[i].X) * (y - poly[i].Y) / (poly[j].Y - poly[i].Y) + poly[i].X)
                inside = !inside;
        return inside;
    }

    /// Best normalised cross-correlation of t inside m for top-left corners in [x0..x1] x [y0..y1].
    static (int X, int Y, double Score) Ncc(Gray m, Gray t, int x0, int y0, int x1, int y1, int step)
    {
        x0 = Math.Max(0, x0); y0 = Math.Max(0, y0); x1 = Math.Min(m.W - t.W, x1); y1 = Math.Min(m.H - t.H, y1);
        var n = t.W * t.H;
        var w = t.Wt ?? Enumerable.Repeat(1f, n).ToArray(); // per-pixel weight: 0 where an overlay covered the minimap
        var tm = t.Mean();
        var tz = new float[n];
        double tn = 0, wsum = 0;
        for (var i = 0; i < n; i++) { var d = t.P[i] - (float)tm; tz[i] = w[i] * d; tn += w[i] * d * d; wsum += w[i]; }
        tn = Math.Sqrt(tn);
        (int, int, double) best = (x0, y0, -2);
        for (var y = y0; y <= y1; y += step)
            for (var x = x0; x <= x1; x += step)
            {
                double dot = 0, s = 0, s2 = 0;
                for (var ty = 0; ty < t.H; ty++)
                {
                    var row = (y + ty) * m.W + x;
                    var trow = ty * t.W;
                    for (var tx = 0; tx < t.W; tx++)
                    {
                        float v = m.P[row + tx], wv = w[trow + tx] * v;
                        dot += v * tz[trow + tx]; s += wv; s2 += wv * v;
                    }
                }
                var var_ = s2 - s * s / wsum;
                if (var_ <= 1e-6) continue;
                var score = dot / (Math.Sqrt(var_) * tn); // the template is zero-mean, so the window's mean drops out of dot
                if (score > best.Item3) best = (x, y, score);
            }
        return best;
    }

    /// Grey pixels (0..255) of a picture scaled to w x h.
    internal sealed class Gray(int w, int h, float[] p)
    {
        public readonly int W = w, H = h;
        public readonly float[] P = p;
        public float[] Wt; // weights 0..1 (a template with overlays left out), or null = all count
        public double Mean() => Wt == null ? P.Average() : P.Zip(Wt, (v, k) => v * k).Sum() / Math.Max(1e-6, Wt.Sum());
        public double Std() { var m = Mean(); return Wt == null ? Math.Sqrt(P.Average(v => (v - m) * (v - m))) : Math.Sqrt(P.Zip(Wt, (v, k) => k * (v - m) * (v - m)).Sum() / Math.Max(1e-6, Wt.Sum())); }
        public double Coverage() => Wt == null ? 1 : Wt.Average();

        /// The minimap scaled to w x h with each cell's weight = the share of its pixels that are map, not overlay:
        /// overlays are the game's white text and icons and their black outlines, which the painted map never uses.
        public static Gray Template(Bitmap src, int w, int h)
        {
            (w, h) = (Math.Max(2, w), Math.Max(2, h));
            int sw = src.Width, sh = src.Height;
            using var copy = src.Clone(new Rectangle(0, 0, sw, sh), PixelFormat.Format24bppRgb);
            var data = copy.LockBits(new Rectangle(0, 0, sw, sh), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            var bytes = new byte[data.Stride * sh];
            try { Marshal.Copy(data.Scan0, bytes, 0, bytes.Length); }
            finally { copy.UnlockBits(data); }
            double[] sum = new double[w * h], good = new double[w * h], all = new double[w * h];
            for (var y = 0; y < sh; y++)
            {
                var cy = Math.Min(h - 1, y * h / sh);
                for (var x = 0; x < sw; x++)
                {
                    var o = y * data.Stride + x * 3;
                    int b = bytes[o], g = bytes[o + 1], r = bytes[o + 2], lo = Math.Min(r, Math.Min(g, b)), hi = Math.Max(r, Math.Max(g, b));
                    var c = cy * w + Math.Min(w - 1, x * w / sw);
                    all[c]++;
                    if ((lo > 205 && hi - lo < 30) || hi < 45) continue; // white text/icons, black outlines
                    sum[c] += 0.114 * b + 0.587 * g + 0.299 * r;
                    good[c]++;
                }
            }
            var p = new float[w * h];
            var wt = new float[w * h];
            for (var i = 0; i < p.Length; i++)
            {
                var share = all[i] > 0 ? good[i] / all[i] : 0;
                wt[i] = share < 0.5 ? 0 : (float)share; // mostly overlay: leave the cell out
                p[i] = good[i] > 0 ? (float)(sum[i] / good[i]) : 0;
            }
            return new Gray(w, h, p) { Wt = wt };
        }

        public static Gray From(Bitmap src, int w, int h)
        {
            (w, h) = (Math.Max(2, w), Math.Max(2, h));
            using var b = new Bitmap(w, h, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(b)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.PixelOffsetMode = PixelOffsetMode.HighQuality; g.DrawImage(src, 0, 0, w, h); }
            var data = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                var bytes = new byte[data.Stride * h];
                Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
                var p = new float[w * h];
                for (var y = 0; y < h; y++)
                    for (var x = 0; x < w; x++)
                    {
                        var o = y * data.Stride + x * 3;
                        p[y * w + x] = 0.114f * bytes[o] + 0.587f * bytes[o + 1] + 0.299f * bytes[o + 2]; // BGR
                    }
                return new Gray(w, h, p);
            }
            finally { b.UnlockBits(data); }
        }
    }

    // suspicious reads (a whole-map search, a refused jump) saved as small pictures so a wrong place can be traced
    static readonly string SampleDir = Path.Combine(Replays.Dir, "Debug", "minimap");
    int samples = -1;
    void Sample(Bitmap shot, string tag, double x, double y, double score)
    {
        try
        {
            if (samples < 0) { Directory.CreateDirectory(SampleDir); samples = Directory.GetFiles(SampleDir).Length; }
            if (samples >= 300) return; // a few matches' worth; delete the folder to collect again
            samples++;
            shot.Save(Path.Combine(SampleDir, $"{DateTime.Now:yyyyMMdd-HHmmss-fff}-{tag}-{x:F0}_{y:F0}-{score:F2}.png"), ImageFormat.Png);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ExternalException) { }
    }

    /// Debug (App --minimapdir dir out.txt): re-match every saved sample (Debug/minimap) with a whole-map search.
    public static string ExplainDir(string dir)
    {
        var t = new MinimapTracker();
        if (!t.EnsureMap().GetAwaiter().GetResult()) return "no map picture (offline?)";
        var sb = new System.Text.StringBuilder();
        foreach (var f in Directory.GetFiles(dir, "*.png").OrderBy(f => f))
        {
            using var mini = new Bitmap(f);
            var skipFrac = 1 - mini.Height / (double)mini.Width; // the sample is the minimap below its cut-off top
            var r = t.Locate(mini, skipFrac);
            sb.AppendLine($"{Path.GetFileName(f)} -> {(r is var (x, y, s) ? $"{x:F0},{y:F0} score {s:F2}" : "none")}");
        }
        return sb.ToString();
    }

    /// Debug (App --minimap shot.png out.txt): where a full-screen game screenshot puts you.
    public static string Explain(string shotPath)
    {
        var t = new MinimapTracker();
        if (!t.EnsureMap().GetAwaiter().GetResult()) return "no map picture (offline?)";
        using var shot = new Bitmap(shotPath);
        var k = shot.Height / 1080.0;
        int size = (int)Math.Round(Box * k), skip = (int)Math.Round(size * SkipTop);
        using var mini = shot.Clone(new Rectangle(shot.Width - (int)Math.Round((Margin + Box) * k), (int)Math.Round(Margin * k) + skip, size, size - skip), PixelFormat.Format24bppRgb);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var r = t.Locate(mini, skip / (double)size);
        var ms = sw.ElapsedMilliseconds;
        var again = t.Locate(mini, skip / (double)size); // second read: the local search after a fix
        var h = Heading(mini, size / 2.0, size / 2.0 - skip, k);
        return r is var (x, y, s) ? $"x={x:F1} y={y:F1} score={s:F3} heading={h:F0} first={ms} ms next={sw.ElapsedMilliseconds - ms} ms again={again?.X:F1},{again?.Y:F1}" : $"not found ({ms} ms)";
    }

    /// Self-check (App --selftest): a minimap cut from the map itself is found at its own centre.
    public static void SelfTest(string mapPng)
    {
        // a far jump waits for a second read that agrees; one wild facing read doesn't swing the arrow
        var f = new MinimapTracker();
        if (!f.Accept(100, 100, 0.7) || f.Accept(400, 400, 0.7) || !f.Accept(402, 401, 0.7) || !f.Accept(405, 401, 0.7))
            throw new InvalidOperationException("Minimap: jump filter");
        f.Smooth(0);
        if (f.Smooth(120) != 0 || Math.Abs(f.Smooth(118) - 118) > 0.01 || Math.Abs(f.Smooth(128) - 124) > 0.01)
            throw new InvalidOperationException("Minimap: facing filter");
        if (!File.Exists(mapPng)) return; // no map downloaded yet: nothing to test against
        using var bmp = new Bitmap(mapPng);
        var t = new MinimapTracker { map8 = Gray.From(bmp, bmp.Width / 8, bmp.Height / 8), map2 = Gray.From(bmp, bmp.Width / 2, bmp.Height / 2) };
        const double cx = 900, cy = 1050; // Lantern Landing
        var skip = Span * SkipTop;
        using var mini = new Bitmap((int)Span, (int)(Span - skip));
        using (var g = Graphics.FromImage(mini)) g.DrawImage(bmp, new Rectangle(0, 0, mini.Width, mini.Height), new RectangleF((float)(cx - Span / 2), (float)(cy - Span / 2 + skip), mini.Width, mini.Height), GraphicsUnit.Pixel);
        var r = t.Locate(mini, SkipTop) ?? throw new InvalidOperationException("Minimap: not found");
        foreach (var want in new[] { -15.0, 30, 95, 170, -120 })
        {
            using var field = new Bitmap(80, 80, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(field))
            {
                g.Clear(Color.FromArgb(70, 140, 60));
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TranslateTransform(41, 39); // the pivot a little off the middle, as in the game
                g.RotateTransform((float)want);
                PointF[] dart = [new(12, 0), new(-6, -7.5f), new(-3, 0), new(-6, 7.5f)];
                g.FillPolygon(Brushes.White, dart);
                g.DrawPolygon(new Pen(Color.FromArgb(20, 20, 20), 1.5f), dart);
                g.ResetTransform();
                g.FillEllipse(Brushes.White, 52, 14, 9, 9); // a stray white ping nearby
            }
            var got = Heading(field, 40, 40, 1);
            if (double.IsNaN(got) || Math.Abs(((got - want) % 360 + 540) % 360 - 180) > 8) throw new InvalidOperationException($"Minimap heading: {got:F0} instead of {want}");
        }
        if (Math.Abs(r.X - cx) > 6 || Math.Abs(r.Y - cy) > 6) throw new InvalidOperationException($"Minimap: found {r.X:F0},{r.Y:F0} instead of {cx},{cy}");
    }
}
