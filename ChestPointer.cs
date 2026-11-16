using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace ChestCounter;

/// "Chests in view": during a match, the chest spots near you (from the map data, the same spots the Map page shows)
/// that lie inside your view are marked on screen with their rough distance, so you know which way to go. Only your
/// position and facing from the minimap (MinimapTracker) and the public map data are used; nothing of the game is
/// read. The facing gives the horizontal place on screen (perspective, Fortnite's field of view); the camera's
/// up/down tilt isn't known, so the marks sit on one line a little under the middle of the screen. A spot is where
/// a chest can spawn, not a promise that one is there this match.
/// Click-through and never focusable, like the chest panel (Hud).
public sealed class ChestPointer : Window
{
    const double Fov169 = 80; // shortcut: Fortnite's horizontal field of view at 16:9 (default); a changed FOV setting shifts the marks
    const int MaxMarks = 6;
    readonly Func<AppSettings> settings;
    readonly Func<bool> inMatch;
    readonly Canvas strip = new() { IsHitTestVisible = false };
    readonly DispatcherTimer tick = new() { Interval = TimeSpan.FromMilliseconds(500) };
    readonly BitmapImage chestPic;
    (double X, double Y, double H, DateTime At)? me; // map space, degrees
    RouteBuilder.Chests data;
    DateTime dataAt;
    string lastKey = "";

    public ChestPointer(Func<AppSettings> settings, Func<bool> inMatch)
    {
        (this.settings, this.inMatch) = (settings, inMatch);
        (WindowStyle, AllowsTransparency, Background, Topmost, ShowInTaskbar, ShowActivated, ResizeMode, Title, IsHitTestVisible) =
            (WindowStyle.None, true, Brushes.Transparent, true, false, false, ResizeMode.NoResize, "ReChest chests in view", false);
        Content = strip;
        var pic = Path.Combine(Replays.ImgDir, "chest.png"); // the game's chest picture (fetched on first start)
        if (File.Exists(pic))
            try { chestPic = new BitmapImage(); chestPic.BeginInit(); chestPic.CacheOption = BitmapCacheOption.OnLoad; chestPic.UriSource = new Uri(pic); chestPic.DecodePixelWidth = 64; chestPic.EndInit(); chestPic.Freeze(); }
            catch (Exception e) when (e is IOException or NotSupportedException) { chestPic = null; }
        tick.Tick += (_, _) => Update();
    }

    public void Start() => tick.Start();
    public void SetPos(double x, double y, double h) { me = (x, y, double.IsNaN(h) && me is var (_, _, oh, _) ? oh : h, DateTime.UtcNow); Update(); }
    public void SetHeading(double h) { if (me is var (x, y, _, at)) { me = (x, y, h, at); Update(); } }

    /// Horizontal place on a screen of this width for a spot at relDeg from where you face; null when outside the view.
    internal static double? ScreenX(double relDeg, double width, double height)
    {
        var half = Math.Atan(Math.Tan(Fov169 / 2 * Math.PI / 180) * (width / height) / (16.0 / 9)); // wider screens see more
        var rel = relDeg * Math.PI / 180;
        if (Math.Abs(rel) >= half * 0.97) return null;
        return width / 2 + Math.Tan(rel) / Math.Tan(half) * width / 2;
    }

    void Update()
    {
        var s = settings();
        if (!s.MapPointers || !inMatch() || me is not var (mx, my, mh, at) || DateTime.UtcNow - at > TimeSpan.FromSeconds(6) || double.IsNaN(mh) || !Hud.FortniteInFront(out var r))
        {
            if (IsVisible) Hide();
            lastKey = "";
            strip.Children.Clear();
            shownMarks.Clear();
            return;
        }
        if (data == null || DateTime.UtcNow - dataAt > TimeSpan.FromSeconds(30)) { data = RouteBuilder.Load(s); dataAt = DateTime.UtcNow; } // layers may change on the Map page
        if (data == null) return;
        var here = data.ToWorld(mx, my);
        var range = Math.Clamp(s.MapPointerRange, 10, 200) * 100.0; // cm
        var marks = new List<(int Id, double X, double Metres)>();
        for (var i = 0; i < data.Items.Count; i++)
        {
            var c = data.Items[i];
            double dx = c[0] - here[0], dy = c[1] - here[1], d = Math.Sqrt(dx * dx + dy * dy);
            if (d > range || d < 150) continue; // farther than the range, or right where you stand
            var bearing = Math.Atan2(dy, dx) * 180 / Math.PI; // world and map axes point the same way (x east, y south)
            if (ScreenX(((bearing - mh) % 360 + 540) % 360 - 180, r.Width, r.Height) is double sx) marks.Add((i, sx, d / 100));
        }
        marks = marks.OrderBy(m => m.Metres).Take(MaxMarks).ToList();
        var key = string.Join(";", marks.Select(m => $"{m.Id}:{Math.Round(m.X / 2)}:{Math.Round(m.Metres)}")) + r;
        if (key == lastKey) return; // nothing moved on screen: no redraw
        lastKey = key;

        var dpi = VisualTreeHelper.GetDpi(this);
        double k = r.Height / 1080.0, stripH = 96 * k;
        if (r != placedOn) // only when the game window moved or resized
        {
            placedOn = r;
            (Left, Top, Width, Height) = (r.Left / dpi.DpiScaleX, (r.Top + r.Height * 0.56 - stripH / 2) / dpi.DpiScaleY, r.Width / dpi.DpiScaleX, stripH / dpi.DpiScaleY);
        }
        // each spot keeps its mark: it glides to its new place as you turn, fades in when it comes into view and out
        // when it leaves, instead of everything being redrawn in jumps
        foreach (var gone in shownMarks.Keys.Except(marks.Select(m => m.Id)).ToList())
        {
            var old = shownMarks[gone];
            shownMarks.Remove(gone);
            var fade = Anim(0, 160);
            fade.Completed += (_, _) => strip.Children.Remove(old);
            old.BeginAnimation(OpacityProperty, fade);
        }
        foreach (var (id, x, metres) in marks)
        {
            var near = 1 - Math.Min(1, metres / (range / 100)); // 1 close .. 0 at the range
            var size = (22 + 12 * near) * k / dpi.DpiScaleX;
            if (!shownMarks.TryGetValue(id, out var mark))
            {
                mark = new StackPanel { Opacity = 0, Effect = new DropShadowEffect { BlurRadius = 6, ShadowDepth = 1, Opacity = 0.8 } };
                mark.Children.Add(chestPic != null
                    ? new Image { Source = chestPic }
                    : new System.Windows.Shapes.Ellipse { Fill = new SolidColorBrush(Color.FromRgb(0xff, 0xc8, 0x3d)), Stroke = Brushes.Black, StrokeThickness = 1.5 });
                mark.Children.Add(new TextBlock { Foreground = Brushes.White, FontWeight = FontWeights.Black, FontSize = 12 * k / dpi.DpiScaleX, HorizontalAlignment = HorizontalAlignment.Center, FontFamily = new FontFamily("Segoe UI Variable Display, Segoe UI") });
                strip.Children.Add(mark);
                shownMarks[id] = mark;
                Canvas.SetLeft(mark, x / dpi.DpiScaleX - size / 2);
            }
            var pic = (FrameworkElement)mark.Children[0];
            (pic.Width, pic.Height) = chestPic != null ? (size, size) : (size * 0.6, size * 0.6);
            ((TextBlock)mark.Children[1]).Text = $"≈{Math.Round(metres)} m";
            mark.BeginAnimation(OpacityProperty, Anim(0.55 + 0.45 * near, 160));
            mark.BeginAnimation(Canvas.LeftProperty, Anim(x / dpi.DpiScaleX - size / 2, 200));
            Canvas.SetTop(mark, (stripH / dpi.DpiScaleY - size - 16 * k / dpi.DpiScaleY) / 2);
        }
        if (!IsVisible) Show();
    }

    readonly Dictionary<int, StackPanel> shownMarks = [];
    System.Drawing.Rectangle placedOn;

    static System.Windows.Media.Animation.DoubleAnimation Anim(double to, int ms)
    {
        var a = new System.Windows.Media.Animation.DoubleAnimation(to, TimeSpan.FromMilliseconds(ms)) { EasingFunction = new System.Windows.Media.Animation.QuadraticEase { EasingMode = System.Windows.Media.Animation.EasingMode.EaseOut } };
        System.Windows.Media.Animation.Timeline.SetDesiredFrameRate(a, 30); // a see-through strip: 30 fps is smooth and light
        return a;
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        var h = new WindowInteropHelper(this).Handle;
        // click-through (TRANSPARENT), never activated (NOACTIVATE), no taskbar/alt-tab entry (TOOLWINDOW)
        SetWindowLong(h, -20, GetWindowLong(h, -20) | 0x20 | 0x80000 | 0x08000000 | 0x80);
    }

    /// Self-check (App --selftest): straight ahead is the middle, the view's edge is out, left is left.
    public static void SelfTest()
    {
        if (ScreenX(0, 1920, 1080) is not double mid || Math.Abs(mid - 960) > 0.5) throw new InvalidOperationException("ChestPointer middle");
        if (ScreenX(45, 1920, 1080) != null) throw new InvalidOperationException("ChestPointer edge");
        if (ScreenX(-20, 1920, 1080) is not double left || left >= 960 || left < 0) throw new InvalidOperationException("ChestPointer left");
    }

    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int index, int value);
}
