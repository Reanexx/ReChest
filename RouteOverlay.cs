using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace ChestCounter;

/// The map card over Fortnite during a match, at the left edge (the game keeps its own panels in the corners): your
/// route and chests on a map picture the Map page draws (ui/map.js, routeBase), and you as an arrow. While your
/// position is known (MinimapTracker) the card follows you at the zoom set in Settings, gliding between reads;
/// otherwise it fits the route. It has its own corner, offset, size, opacity, style and accent (Settings › Overlay ›
/// Map overlay), like the chest panel. The route key shows or hides it (slide + fade from its side), the size key makes it bigger (grows smoothly). Click-through and never focusable, like
/// the chest panel (Hud).
public sealed class RouteOverlay : Window
{
    /// The page's map picture: Img covers map px from (X0, Y0) at Ppu picture px per map px; the route's middle and
    /// size (Cx, Cy, Span, map px; Span 0 = no route) and its summary line.
    /// The route itself comes as points in map space (Route, and its chests: Stops) and is drawn here, so a route
    /// made by the app (route from here) shows at once without a new picture.
    public record Base(string Img, double X0, double Y0, double Ppu, double Cx, double Cy, double Span, string Stats, double[][] Route = null, double[][] Stops = null);

    const double View = 236; // the map window inside the card, DIP at 100%
    const double Follow0 = 170; // map px across the window when following you at 100% zoom (~250 m)
    // position reads come every 0.5 s while moving: glide at an even pace across that gap; facing reads ~7 a second
    static readonly Duration Glide = TimeSpan.FromMilliseconds(520), TurnGlide = TimeSpan.FromMilliseconds(140);
    static readonly IEasingFunction Ease = new CubicEase { EasingMode = EasingMode.EaseOut };

    readonly Func<AppSettings> settings;
    readonly Func<bool> inMatch;
    readonly DispatcherTimer follow = new() { Interval = TimeSpan.FromMilliseconds(250) };
    readonly Border card = new() { CornerRadius = new CornerRadius(16), Padding = new Thickness(10, 9, 10, 10), BorderThickness = new Thickness(1) };
    readonly TextBlock title = new() { FontSize = 15, FontWeight = FontWeights.Black, FontStyle = FontStyles.Italic },
        stats = new() { FontSize = 11, FontWeight = FontWeights.Bold, Margin = new Thickness(0, 1, 0, 7) },
        keys = new() { FontSize = 10, FontWeight = FontWeights.Bold, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top };
    readonly Image picture = new() { Stretch = Stretch.Fill };
    readonly Canvas layer = new();
    BitmapSource full; // the whole island picture; the card shows a crop of it
    Int32Rect crop = Int32Rect.Empty;
    // the route over the picture, in picture px, moved and scaled with it
    readonly System.Windows.Shapes.Path routeShade = new() { Stroke = new SolidColorBrush(Color.FromArgb(180, 0, 0, 30)), StrokeLineJoin = PenLineJoin.Round, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round },
        routeLine = new() { Stroke = Brushes.White, StrokeLineJoin = PenLineJoin.Round, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round },
        stopDots = new() { Fill = new SolidColorBrush(Color.FromRgb(0xff, 0xc8, 0x3d)), Stroke = Brushes.White };
    readonly ScaleTransform picScale = new(1, 1);
    readonly TranslateTransform picMove = new();
    readonly System.Windows.Shapes.Path me = new() { Fill = new SolidColorBrush(Color.FromRgb(0x3b, 0x9c, 0xff)), Stroke = Brushes.White, StrokeThickness = 2, StrokeLineJoin = PenLineJoin.Round, Visibility = Visibility.Collapsed };
    readonly RotateTransform turn = new();
    readonly TranslateTransform meMove = new();
    static readonly Geometry Arrow = Geometry.Parse("M 10,0 L -6.5,-7 L -2.5,0 L -6.5,7 Z"), Dot = new EllipseGeometry(new Point(0, 0), 5.5, 5.5);
    readonly ScaleTransform zoom = new(1, 1);
    readonly TranslateTransform slide = new();
    Grid head;

    Base map;
    (double X, double Y, double H, DateTime At)? pos;
    bool shown; // wanted on screen (animating out counts as not)
    double zoomTo = 1;

    public RouteOverlay(Func<AppSettings> settings, Func<bool> inMatch)
    {
        (this.settings, this.inMatch) = (settings, inMatch);
        (WindowStyle, AllowsTransparency, Background, Topmost, ShowInTaskbar, ShowActivated, ResizeMode, SizeToContent) =
            (WindowStyle.None, true, Brushes.Transparent, true, false, false, ResizeMode.NoResize, SizeToContent.WidthAndHeight);
        Title = "ReChest map";
        IsHitTestVisible = false;
        var font = new FontFamily("Segoe UI Variable Display, Segoe UI");
        foreach (var t in new[] { title, stats, keys }) t.FontFamily = font;

        // the picture and the route sit in one layer, in picture px, moved and scaled together
        layer.RenderTransform = new TransformGroup { Children = { picScale, picMove } };
        me.RenderTransform = new TransformGroup { Children = { turn, meMove } };
        var canvas = new Canvas { Width = View, Height = View, ClipToBounds = true, Background = new SolidColorBrush(Color.FromRgb(0x2f, 0x8f, 0xd8)) };
        layer.Children.Add(picture);
        foreach (var p in new[] { routeShade, routeLine, stopDots }) layer.Children.Add(p);
        canvas.Children.Add(layer);
        canvas.Children.Add(me);
        var window = new Border { Child = canvas, Clip = new RectangleGeometry(new Rect(0, 0, View, View), 10, 10) };

        head = new Grid();
        head.Children.Add(new StackPanel { Children = { title, stats } });
        head.Children.Add(keys);
        card.Child = new StackPanel { Children = { head, window } };
        card.Effect = new DropShadowEffect { BlurRadius = 18, ShadowDepth = 3, Opacity = 0.55 };
        Content = new Border { Child = card, Margin = new Thickness(14), LayoutTransform = zoom, RenderTransform = slide };
        Opacity = 0;
        follow.Tick += (_, _) => Refresh();
        SizeChanged += (_, _) => Pin(); // growing (F6) or a new size: stay pinned to the corner on every frame
    }

    public void Start()
    {
        // the last picture the Map page sent: the card works even when the app started in the background and its
        // page hasn't run yet (the route only changes on that page, so the saved one is current)
        try { if (File.Exists(SavedFile)) SetBase(System.Text.Json.JsonSerializer.Deserialize<Base>(File.ReadAllText(SavedFile)), save: false); }
        catch (Exception e) when (e is IOException or System.Text.Json.JsonException) { }
        follow.Start();
    }

    static readonly string SavedFile = System.IO.Path.Combine(Replays.Dir, "map-card.json");

    public void SetBase(Base b) => SetBase(b, save: true);

    void SetBase(Base b, bool save)
    {
        if (save && b != null)
            _ = Task.Run(() => { try { File.WriteAllText(SavedFile, System.Text.Json.JsonSerializer.Serialize(b)); } catch (IOException) { } });
        map = b;
        var comma = b?.Img?.IndexOf(',') ?? -1;
        if (b == null || comma < 0 || !(b.Img.StartsWith("data:image/jpeg;base64,") || b.Img.StartsWith("data:image/png;base64,"))) { picture.Source = null; Refresh(); return; }
        try
        {
            var bmp = new BitmapImage();
            bmp.BeginInit();
            bmp.CacheOption = BitmapCacheOption.OnLoad;
            bmp.StreamSource = new MemoryStream(Convert.FromBase64String(b.Img[(comma + 1)..]));
            bmp.EndInit();
            bmp.Freeze();
            full = bmp;
            crop = Int32Rect.Empty;
            picture.Source = bmp; // until the first Place crops it
            (picture.Width, picture.Height) = (bmp.PixelWidth, bmp.PixelHeight);
        }
        catch (Exception e) when (e is FormatException or NotSupportedException or IOException) { picture.Source = null; }
        stats.Text = b.Stats ?? "";
        DrawRoute();
        Place(false);
        Refresh();
    }

    /// Your position (2048 px map space) and facing (degrees; NaN = unknown), ~3 times a second.
    public void SetPos(double x, double y, double heading)
    {
        var fresh = !Following;
        var still = pos is var (ox, oy, oh, _) && !fresh && Math.Abs(ox - x) + Math.Abs(oy - y) < 0.5 && (double.IsNaN(heading) || Math.Abs(((heading - oh) % 360 + 540) % 360 - 180) < 2);
        pos = (x, y, heading, DateTime.UtcNow);
        if (!still) Place(!fresh); // standing still: no redraw at all
    }

    /// A route the app just made (map space points, its chests, summary): shown at once, the card follows it.
    public void SetRoute(List<double[]> route, List<double[]> stops, string summary)
    {
        if (map == null) return;
        double x0 = route.Min(p => p[0]), y0 = route.Min(p => p[1]), x1 = route.Max(p => p[0]), y1 = route.Max(p => p[1]);
        map = map with { Route = route.ToArray(), Stops = stops.ToArray(), Cx = (x0 + x1) / 2, Cy = (y0 + y1) / 2, Span = Math.Max(x1 - x0, y1 - y0), Stats = summary };
        stats.Text = summary;
        DrawRoute();
        Place(true);
        Refresh();
    }

    void DrawRoute()
    {
        if (map == null) return;
        Point P(double[] p) => new((p[0] - map.X0) * map.Ppu, (p[1] - map.Y0) * map.Ppu);
        Geometry line = null;
        if (map.Route is { Length: > 1 } r)
        {
            var fig = new PathFigure { StartPoint = P(r[0]) };
            foreach (var p in r.Skip(1)) fig.Segments.Add(new LineSegment(P(p), true));
            line = new PathGeometry([fig]);
        }
        routeShade.Data = routeLine.Data = line;
        (routeShade.StrokeThickness, routeLine.StrokeThickness) = (3.4 * map.Ppu, 1.8 * map.Ppu);
        var dot = Math.Clamp(settings().RouteDot, 40, 250) / 100.0;
        var dots = new GeometryGroup();
        foreach (var st in map.Stops ?? []) dots.Children.Add(new EllipseGeometry(P(st), 2.2 * dot * map.Ppu, 2.2 * dot * map.Ppu));
        stopDots.Data = dots;
        stopDots.StrokeThickness = 0.8 * dot * map.Ppu;
    }

    /// Facing only, between position reads: turn the arrow right away.
    public void SetHeading(double h)
    {
        if (pos is not var (x, y, _, at) || !Following) return;
        pos = (x, y, h, at);
        if (me.Visibility != Visibility.Visible) return;
        me.Data = Arrow;
        Animate(turn, RotateTransform.AngleProperty, turn.Angle + ((h - turn.Angle) % 360 + 540) % 360 - 180, true);
    }

    /// Your last read position (map space) and facing, if recent.
    public (double X, double Y)? Me => Following ? (pos.Value.X, pos.Value.Y) : null;
    public (double X, double Y, double H)? MeAll => Following ? (pos.Value.X, pos.Value.Y, pos.Value.H) : null;

    bool Following => pos is var (_, _, _, at) && DateTime.UtcNow - at < TimeSpan.FromSeconds(10);

    /// Lays the picture so the view's middle is you (following) or the route, and puts your arrow on it.
    void Place(bool glide)
    {
        if (map == null || picture.Source == null) return;
        double cx, cy, span;
        if (Following) (cx, cy, span) = (pos.Value.X, pos.Value.Y, Follow0 / (Math.Clamp(settings().RouteZoom, 25, 400) / 100.0));
        else if (map.Span > 0) (cx, cy, span) = (map.Cx, map.Cy, Math.Max(150, map.Span * 1.15));
        else return;
        var k = View / span; // DIP per map px
        Crop(cx, cy, span);
        Animate(picScale, ScaleTransform.ScaleXProperty, k / map.Ppu, glide);
        Animate(picScale, ScaleTransform.ScaleYProperty, k / map.Ppu, glide);
        Animate(picMove, TranslateTransform.XProperty, View / 2 - (cx - map.X0) * k, glide);
        Animate(picMove, TranslateTransform.YProperty, View / 2 - (cy - map.Y0) * k, glide);

        if (pos is not var (px, py, h, _) || !Following) { me.Visibility = Visibility.Collapsed; return; }
        me.Visibility = Visibility.Visible;
        me.Data = double.IsNaN(h) ? Dot : Arrow;
        Animate(meMove, TranslateTransform.XProperty, View / 2 + (px - cx) * k, glide);
        Animate(meMove, TranslateTransform.YProperty, View / 2 + (py - cy) * k, glide);
        if (!double.IsNaN(h)) Animate(turn, RotateTransform.AngleProperty, turn.Angle + ((h - turn.Angle) % 360 + 540) % 360 - 180, glide); // the short way round
    }

    /// Shows only a part of the 2560 px island picture: three views wide around the middle, re-cut when the view nears
    /// its edge. Redrawing a see-through window costs by the picture it draws, so this keeps each frame light.
    void Crop(double cx, double cy, double span)
    {
        if (full == null) return;
        double ppu = map.Ppu, px = (cx - map.X0) * ppu, py = (cy - map.Y0) * ppu, view = span * ppu;
        var inner = new Rect(crop.X + view, crop.Y + view, Math.Max(0, crop.Width - 2 * view), Math.Max(0, crop.Height - 2 * view));
        if (!crop.IsEmpty && inner.Contains(px, py)) return; // still well inside the current cut
        int side = (int)Math.Ceiling(view * 3.2);
        int x = (int)Math.Clamp(px - side / 2.0, 0, Math.Max(0, full.PixelWidth - side)), y = (int)Math.Clamp(py - side / 2.0, 0, Math.Max(0, full.PixelHeight - side));
        crop = new Int32Rect(x, y, Math.Min(side, full.PixelWidth - x), Math.Min(side, full.PixelHeight - y));
        var cut = new CroppedBitmap(full, crop);
        cut.Freeze();
        picture.Source = cut;
        (picture.Width, picture.Height) = (crop.Width, crop.Height);
        Canvas.SetLeft(picture, crop.X);
        Canvas.SetTop(picture, crop.Y);
    }

    void Animate(Animatable target, DependencyProperty p, double to, bool glide)
    {
        if (double.IsNaN(to)) return;
        if (!glide) { target.BeginAnimation(p, null); target.SetValue(p, to); return; }
        var q = settings().TrackQuality; // glide across the gap to the next read, at an even pace
        var move = TimeSpan.FromMilliseconds(q == "low" ? 1020 : q == "balanced" ? 520 : 270);
        var a = new DoubleAnimation(to, p == RotateTransform.AngleProperty ? TurnGlide : move);
        Timeline.SetDesiredFrameRate(a, q == "low" ? 20 : 30); // the card draws a small cut of the map (Crop), so 30 fps stays light
        target.BeginAnimation(p, a);
    }

    /// Shows or hides (slide + fade), follows the Fortnite window, applies the panel's look and the bigger size.
    public void Refresh()
    {
        var s = settings();
        var have = picture.Source != null && (map?.Span > 0 || Following);
        var inGame = Hud.FortniteInFront(out var r);
        var want = have && s.RouteOverlay && inGame && inMatch(); // only during a match
        if (!inGame && IsVisible) { shown = false; BeginAnimation(OpacityProperty, null); Opacity = 0; Hide(); return; } // alt-tab: just go
        if (want && !shown)
        {
            shown = true;
            Style(s);
            if (!IsVisible) Show();
            BeginAnimation(OpacityProperty, new DoubleAnimation(s.MapOpacity / 100.0, TimeSpan.FromMilliseconds(220)) { EasingFunction = Ease });
            slide.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(Side(s), 0, TimeSpan.FromMilliseconds(260)) { EasingFunction = Ease });
        }
        else if (!want && shown)
        {
            shown = false;
            var fade = new DoubleAnimation(0, TimeSpan.FromMilliseconds(180)) { EasingFunction = Ease };
            fade.Completed += (_, _) => { if (!shown) Hide(); };
            BeginAnimation(OpacityProperty, fade);
            slide.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(Side(s), TimeSpan.FromMilliseconds(180)) { EasingFunction = Ease });
        }
        if (!shown) return;

        Style(s);
        var target = s.MapScale / 100.0 * (s.RouteBig ? Math.Clamp(r.Height / 1080.0 * 1.9, 1.4, 2.6) : 1);
        if (Math.Abs(zoomTo - target) > 0.001)
        {
            zoomTo = target;
            var grow = new DoubleAnimation(target, TimeSpan.FromMilliseconds(260)) { EasingFunction = Ease };
            zoom.BeginAnimation(ScaleTransform.ScaleXProperty, grow);
            zoom.BeginAnimation(ScaleTransform.ScaleYProperty, grow);
        }
        game = r;
        Pin();
    }

    System.Drawing.Rectangle game;

    /// Pinned to its corner of the Fortnite window, like the chest panel (device px, then DIP).
    void Pin()
    {
        if (game.Width == 0) return;
        var s = settings();
        var dpi = VisualTreeHelper.GetDpi(this);
        double w = ActualWidth * dpi.DpiScaleX, h = ActualHeight * dpi.DpiScaleY;
        double x = s.MapCorner is "tr" or "br" ? game.Right - w - s.MapX : game.Left + s.MapX;
        double y = s.MapCorner is "bl" or "br" ? game.Bottom - h - s.MapY : game.Top + s.MapY;
        (Left, Top) = (x / dpi.DpiScaleX, y / dpi.DpiScaleY);
    }

    /// Slides in from (and out to) the edge it sits on.
    static double Side(AppSettings s) => s.MapCorner is "tr" or "br" ? 40 : -40;

    /// The card's look: glass (neutral dark), solid, minimal or none (no background at all), its accent on the title
    /// and outline, and the title line shown or not.
    void Style(AppSettings s)
    {
        Color accent;
        try { accent = (Color)ColorConverter.ConvertFromString(string.IsNullOrEmpty(s.MapAccent) ? "#FFC93C" : s.MapAccent); }
        catch (FormatException) { accent = Color.FromRgb(0x3c, 0xcf, 0x6e); }
        var (bg, line) = s.MapStyle switch
        {
            "solid" => (Color.FromArgb(250, 16, 17, 22), Color.FromArgb(90, accent.R, accent.G, accent.B)),
            "minimal" => (Color.FromArgb(110, 0, 0, 0), Colors.Transparent),
            "none" => (Colors.Transparent, Colors.Transparent),
            _ => (Color.FromArgb(185, 14, 15, 20), Color.FromArgb(50, 255, 255, 255)),
        };
        card.Background = new SolidColorBrush(bg);
        card.BorderBrush = new SolidColorBrush(line);
        title.Foreground = new SolidColorBrush(accent);
        stats.Foreground = new SolidColorBrush(Color.FromArgb(225, 230, 236, 255));
        keys.Foreground = new SolidColorBrush(Color.FromArgb(150, 255, 255, 255));
        var tr = s.Lang == "tr";
        title.Text = map?.Span > 0 ? (tr ? "ROTA" : "ROUTE") : (tr ? "HARİTA" : "MAP");
        keys.Text = $"{KeyName(s.RouteFullKey)} ⛶   {KeyName(s.RouteBigKey)} ⤢   {KeyName(s.RouteKey)}";
        head.Visibility = s.MapHeader ? Visibility.Visible : Visibility.Collapsed;
        card.Padding = s.MapStyle == "none" ? new Thickness(0) : new Thickness(10, 9, 10, 10);
    }

    internal static string KeyName(int vk) => vk is >= 0x70 and <= 0x87 ? "F" + (vk - 0x6F) : vk is >= 0x30 and <= 0x5A ? ((char)vk).ToString() : "#" + vk;

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        var h = new WindowInteropHelper(this).Handle;
        // click-through (TRANSPARENT), never activated (NOACTIVATE), no taskbar/alt-tab entry (TOOLWINDOW)
        SetWindowLong(h, -20, GetWindowLong(h, -20) | 0x20 | 0x80000 | 0x08000000 | 0x80);
    }

    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int index, int value);
}
