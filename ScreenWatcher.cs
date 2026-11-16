using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using System.Text.RegularExpressions;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;

namespace ChestCounter;

/// Live chest count for the player at this PC (opened or broken). Fortnite's interact prompt shows only the key icon
/// and a verb ("AÇ", "OPEN", "ABRIR" ...), never the container's name, and it can be anywhere on screen. So on an
/// Interact press or an attack click while Fortnite is in front:
///  1. the whole game window is read with Windows OCR; a prompt is a short line whose word is the "open" verb
///     (a quest line like "5 sandık aç (0/5)" is not); a missed read is retried at 2x around the screen centre;
///  2. it must be a chest: the object right left of the prompt must look like one: yellow-gold, not grey
///     (ammo boxes) nor orange (lanterns); measured on real captures: chest 20% yellow / 3% grey, ammo box 7% / 22%;
///  3. the prompt must then vanish from that spot (two reads in a row): the chest was opened or broken.
///     A door turns into "KAPAT"/"CLOSE" (dropped); turning the camera away also hides it, so a big mouse
///     movement in between cancels.
/// Only the screen and input events are read, never the game's memory.
public sealed class ScreenWatcher
{
    public event Action<string> Detected; // raised on a thread-pool thread

    public bool Enabled = true;
    public string DebugDir; // when set, every read is saved there with what OCR saw (for tuning)
    public Func<long> MouseTravel = () => 0; // raw mouse counts moved so far (from InputWatcher)

    /// Yellow-gold share of the object left of the prompt that marks a chest (chest 20%, ammo box 7%).
    internal const double YellowForChest = 0.12;
    /// Mouse travel (raw counts) while breaking that means the camera turned away rather than the chest breaking.
    const long MaxTravel = 4000;
    static readonly int[] ConfirmInteract = [300, 600, 950, 1400, 2000, 2700, 3500];
    static readonly int[] ConfirmAttack = [400, 800, 1300, 1900, 2600, 3400, 4300, 5300]; // breaking takes a few swings

    readonly OcrEngine ocr = OcrEngine.TryCreateFromUserProfileLanguages();
    readonly Func<bool> inMatch;
    int busy;

    public ScreenWatcher(Func<bool> inMatch) => this.inMatch = inMatch;

    public bool Available => ocr != null;

    /// Called on every Interact press or attack click (from <see cref="InputWatcher"/>).
    public void OnPress(bool attack)
    {
        if (!Enabled || ocr == null || !FortniteRect(out var win) || !inMatch()) return;
        if (Interlocked.Exchange(ref busy, 1) == 1) return; // already following a chest
        var started = Stopwatch.StartNew();
        var first = Capture(win); // right now, while the prompt is surely on screen
        _ = Task.Run(() => Follow(first, attack, started)).ContinueWith(_ => Volatile.Write(ref busy, 0));
    }

    async Task Follow(Bitmap first, bool attack, Stopwatch started)
    {
        var tag = attack ? "vur" : "bas";
        RectangleF prompt;
        using (first)
        {
            var (found, text) = await FindPrompt(first, OpenVerbs, null);
            if (found == null) { if (!attack) Save(first, $"{tag}-1-yok", text); return; } // attack clicks without a prompt are normal
            prompt = found.Value;
            var (yellow, grey) = Look(first, ObjectBox(prompt, first.Size));
            var chest = yellow >= YellowForChest && grey < yellow;
            Save(first, $"{tag}-1-ac-sari{yellow * 100:F0}-gri{grey * 100:F0}-{(chest ? "sandik" : "degil")}", text);
            if (!chest) return; // a prompt for something that isn't a chest (ammo box, door, ...)
        }

        var travel = MouseTravel();
        var gone = 0;
        foreach (var at in attack ? ConfirmAttack : ConfirmInteract)
        {
            var wait = at - (int)started.ElapsedMilliseconds;
            if (wait > 0) await Task.Delay(wait);
            if (!FortniteRect(out var win)) return; // alt-tabbed: can't tell
            using var bmp = Capture(win);
            if (attack && MouseTravel() - travel > MaxTravel) { Save(bmp, $"{tag}-2-kamera-dondu", ""); return; }
            var (door, doorText) = await FindPrompt(bmp, CloseVerbs, prompt);
            if (door != null) { Save(bmp, $"{tag}-2-kapi", doorText); return; }
            var (still, text) = await FindPrompt(bmp, OpenVerbs, prompt);
            if (still != null) { gone = 0; continue; } // still there: still searching / still standing
            if (++gone < 2) continue; // one empty read can be an OCR miss
            Save(bmp, attack ? "vur-2-kirildi" : "bas-2-acildi", text);
            Detected?.Invoke("chest");
            return;
        }
        // the prompt never went away: not opened or broken
    }

    /// The object a prompt belongs to sits just left of the prompt box (box icon, then the verb), scaled to 1080p.
    static Rectangle ObjectBox(RectangleF word, Size img)
    {
        var k = img.Height / 1080f;
        var r = Rectangle.FromLTRB((int)(word.Left - 260 * k), (int)(word.Top - 100 * k), (int)(word.Left - 80 * k), (int)(word.Bottom + 100 * k));
        r.Intersect(new Rectangle(Point.Empty, img));
        return r;
    }

    /// Share of yellow-gold pixels (hue 38-62, saturated, bright) and of grey pixels (low saturation) in an area.
    internal static (double Yellow, double Grey) Look(Bitmap bmp, Rectangle area)
    {
        if (area.Width <= 0 || area.Height <= 0) return (0, 1);
        var data = bmp.LockBits(area, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var px = new byte[data.Stride * data.Height];
        Marshal.Copy(data.Scan0, px, 0, px.Length);
        bmp.UnlockBits(data);
        int yellow = 0, grey = 0, n = 0;
        for (var y = 0; y < area.Height; y += 2)
            for (var x = 0; x < area.Width; x += 2)
            {
                var i = y * data.Stride + x * 4; // BGRA
                double b = px[i] / 255.0, g = px[i + 1] / 255.0, r = px[i + 2] / 255.0;
                double mx = Math.Max(r, Math.Max(g, b)), mn = Math.Min(r, Math.Min(g, b)), d = mx - mn;
                var sat = mx > 0 ? d / mx : 0;
                n++;
                if (sat < 0.18) { grey++; continue; }
                if (d < 1e-6 || sat <= 0.45 || mx <= 0.45) continue;
                var hue = mx == r ? (g - b) / d % 6 : mx == g ? (b - r) / d + 2 : (r - g) / d + 4;
                hue = (hue * 60 + 360) % 360;
                if (hue is >= 38 and <= 62) yellow++;
            }
        return n == 0 ? (0, 1) : ((double)yellow / n, (double)grey / n);
    }

    /// A prompt is a short OCR line containing one of the verbs. With <paramref name="near"/>, only one close to that
    /// spot counts. A miss is retried at 2x on the area where prompts usually are (OCR needs it for small text).
    async Task<(RectangleF? Rect, string Text)> FindPrompt(Bitmap bmp, string[] verbs, RectangleF? near)
    {
        var res = await ReadLines(bmp);
        var hit = Pick(res, verbs, near, 1, PointF.Empty);
        var text = res?.Text ?? "";
        if (hit != null) return (hit, text);

        var area = near is { } n
            ? Rectangle.FromLTRB((int)n.Left - 500, (int)n.Top - 300, (int)n.Right + 500, (int)n.Bottom + 300)
            : Rectangle.FromLTRB(bmp.Width * 20 / 100, bmp.Height * 20 / 100, bmp.Width * 85 / 100, bmp.Height * 85 / 100);
        area.Intersect(new Rectangle(Point.Empty, bmp.Size));
        if (area.Width < 20 || area.Height < 20) return (null, text);
        var scale = Math.Min(2f, 2500f / Math.Max(area.Width, area.Height)); // OCR's size limit
        using var big = new Bitmap((int)(area.Width * scale), (int)(area.Height * scale), PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(big))
        {
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            g.DrawImage(bmp, new Rectangle(0, 0, big.Width, big.Height), area, GraphicsUnit.Pixel);
        }
        var res2 = await ReadLines(big);
        return (Pick(res2, verbs, near, scale, area.Location), text + " | 2x: " + res2?.Text);
    }

    static RectangleF? Pick(OcrResult res, string[] verbs, RectangleF? near, float scale, PointF offset)
    {
        if (res == null) return null;
        foreach (var line in res.Lines)
        {
            if (line.Words.Count > 3 || line.Text.Contains('/')) continue; // prompts are a word or two, quests are longer
            foreach (var w in line.Words)
            {
                if (!HasVerb(w.Text, verbs)) continue;
                var b = w.BoundingRect;
                var r = new RectangleF(offset.X + (float)b.X / scale, offset.Y + (float)b.Y / scale, (float)b.Width / scale, (float)b.Height / scale);
                if (near is { } n && Math.Abs(r.X - n.X) + Math.Abs(r.Y - n.Y) > 260) continue; // a different prompt
                return r;
            }
        }
        return null;
    }

    static Bitmap Capture(Rectangle win)
    {
        var bmp = new Bitmap(win.Width, win.Height, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bmp);
        g.CopyFromScreen(win.Location, Point.Empty, win.Size);
        return bmp;
    }

    async Task<OcrResult> ReadLines(Bitmap bmp)
    {
        if (bmp.Width > OcrEngine.MaxImageDimension || bmp.Height > OcrEngine.MaxImageDimension) return null;
        var data = bmp.LockBits(new Rectangle(Point.Empty, bmp.Size), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var bytes = new byte[data.Stride * data.Height];
        Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
        bmp.UnlockBits(data);
        using var soft = SoftwareBitmap.CreateCopyFromBuffer(bytes.AsBuffer(), BitmapPixelFormat.Bgra8, bmp.Width, bmp.Height, BitmapAlphaMode.Premultiplied);
        return await ocr.RecognizeAsync(soft).AsTask().ConfigureAwait(false); // no UI context: callers may block on it
    }

    /// Debug entry (--ocr): prompt found?, gold beside it, raw text.
    public async Task<string> Explain(Bitmap bmp)
    {
        var (p, text) = await FindPrompt(bmp, OpenVerbs, null);
        if (p is not { } r) return $"istem=yok | {text}";
        var (yellow, grey) = Look(bmp, ObjectBox(r, bmp.Size));
        return $"istem=var ({r.X:F0},{r.Y:F0}) sari={yellow * 100:F1}% gri={grey * 100:F1}% sandik={(yellow >= YellowForChest && grey < yellow)} | {text}";
    }

    // ---------------------------------------------------------------------------------------------
    // The prompt verbs per game language, normalised (lower case, no accents, ı→i).
    internal static readonly string[] OpenVerbs = ["ac", "open", "abrir", "offnen", "ouvrir", "apri", "otworz", "открыть"];
    internal static readonly string[] CloseVerbs = ["kapat", "close", "cerrar", "schliessen", "fermer", "chiudi", "zamknij", "закрыть"];

    internal static string Normalize(string s)
    {
        var d = s.Replace('ı', 'i').Replace('İ', 'I').ToLowerInvariant().Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(d.Length);
        foreach (var c in d)
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark) sb.Append(c);
        return sb.ToString();
    }

    /// True when one of the words is a whole word of the text. A trailing stray letter is allowed
    /// (OCR read "AÇ" as "AÇL" next to the key icon), but "AL" (pick up) never matches "AÇ".
    internal static bool HasVerb(string text, string[] words)
    {
        foreach (var t in Regex.Split(Normalize(text), @"[^\p{L}]+").Where(t => t.Length > 0))
            foreach (var w in words)
                if (t == w || t.Length == w.Length + 1 && t.StartsWith(w) || w.Length >= 5 && Math.Abs(t.Length - w.Length) <= 1 && Distance(t, w) <= 1)
                    return true;
        return false;
    }

    static int Distance(string a, string b)
    {
        var prev = new int[b.Length + 1];
        var cur = new int[b.Length + 1];
        for (var j = 0; j <= b.Length; j++) prev[j] = j;
        for (var i = 1; i <= a.Length; i++)
        {
            cur[0] = i;
            for (var j = 1; j <= b.Length; j++)
                cur[j] = Math.Min(Math.Min(cur[j - 1], prev[j]) + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
            (prev, cur) = (cur, prev);
        }
        return prev[b.Length];
    }

    internal static void SelfTest()
    {
        (string, bool)[] open =
        [
            ("AÇ", true), ("Aç", true), ("89 m AÇ", true), ("AÇL", true), ("OPEN", true), ("Abrir", true), ("Öffnen", true), ("Ouvrir", true),
            ("AL", false), ("ALA VKAÇIRAN LEVYELİ TÜFEK AL", false), ("Şu anda çekilemiyor", false), ("KAPAT", false), ("", false),
        ];
        foreach (var (text, want) in open)
            if (HasVerb(text, OpenVerbs) != want) throw new Exception($"HasVerb(open, \"{text}\") != {want}");
        if (!HasVerb("KAPAT", CloseVerbs) || !HasVerb("Close", CloseVerbs) || HasVerb("AÇ", CloseVerbs)) throw new Exception("close verbs");
        var t0 = DateTime.UtcNow;
        if (!InputWatcher.NewWheelPress(default, t0) || InputWatcher.NewWheelPress(t0, t0.AddMilliseconds(60)) || !InputWatcher.NewWheelPress(t0, t0.AddMilliseconds(500)))
            throw new Exception("wheel burst rule");
        if (KeyBinds.Interact().Concat(KeyBinds.Attack()).Any(k => Binding.From(k) == null)) throw new Exception("key binds");
    }

    void Save(Bitmap bmp, string tag, string text)
    {
        if (DebugDir == null) return;
        try
        {
            Directory.CreateDirectory(DebugDir);
            var name = Path.Combine(DebugDir, $"{DateTime.Now:HHmmss_fff}_{tag}");
            using (var small = new Bitmap(bmp, bmp.Width / 2, bmp.Height / 2)) small.Save(name + ".jpg", ImageFormat.Jpeg); // half size keeps the folder small
            File.WriteAllText(name + ".txt", text);
            foreach (var old in new DirectoryInfo(DebugDir).GetFiles().OrderByDescending(f => f.CreationTimeUtc).Skip(120)) old.Delete(); // ~60 reads
        }
        catch (IOException) { } // debug output only
    }

    static bool FortniteRect(out Rectangle r)
    {
        r = default;
        var h = GetForegroundWindow();
        GetWindowThreadProcessId(h, out var pid);
        try { if (Process.GetProcessById((int)pid).ProcessName != "FortniteClient-Win64-Shipping") return false; }
        catch (ArgumentException) { return false; }
        if (!GetClientRect(h, out var c)) return false;
        var p = new POINT();
        ClientToScreen(h, ref p);
        r = new Rectangle(p.X, p.Y, c.Right, c.Bottom);
        return r.Width > 200 && r.Height > 200;
    }

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
}
