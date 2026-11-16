using System.Diagnostics;
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

/// Small in-game panel with your own chests:
///   [chest]  412        +3
///            CHESTS     THIS MATCH
///            F8 +1 · F9 −1          (hotkeys, during a match)
/// It follows the Fortnite window (corner + offset from settings), shows only while Fortnite is the active window,
/// and is click-through and never focusable, so the mouse can't pull focus away from the game.
public sealed class Hud : Window
{
    readonly Tracker tracker;
    readonly Func<AppSettings> settings;
    readonly DispatcherTimer follow = new() { Interval = TimeSpan.FromMilliseconds(400) };
    readonly Border card = new();
    readonly TextBlock total = new(), plus = new(), totalCap = new() { Text = "CHESTS" }, plusCap = new() { Text = "THIS MATCH" }, keys = new(), rec = new();
    readonly ScaleTransform recPop = new();
    bool recordShown; // "New record!" already celebrated this match
    readonly Image chest = new() { Width = 38, Height = 38, Margin = new Thickness(0, 0, 10, 0), VerticalAlignment = VerticalAlignment.Center };
    readonly ScaleTransform pop = new();
    int shownLive = -1;

    public Hud(Tracker tracker, Func<AppSettings> settings)
    {
        (this.tracker, this.settings) = (tracker, settings);
        (WindowStyle, AllowsTransparency, Background, Topmost, ShowInTaskbar, ShowActivated, ResizeMode, SizeToContent) =
            (WindowStyle.None, true, Brushes.Transparent, true, false, false, ResizeMode.NoResize, SizeToContent.WidthAndHeight);
        Title = "ReChest panel";
        IsHitTestVisible = false;

        var font = new FontFamily("Segoe UI Variable Display, Segoe UI");
        var dim = new SolidColorBrush(Color.FromArgb(165, 255, 255, 255));
        foreach (var t in new[] { total, plus, totalCap, plusCap, keys, rec }) t.FontFamily = font;
        (rec.FontSize, rec.FontWeight, rec.Margin) = (11, FontWeights.Black, new Thickness(1, 4, 0, 0));
        rec.RenderTransform = recPop;
        rec.RenderTransformOrigin = new Point(0, 0.5);
        (total.FontSize, total.FontWeight, total.Foreground) = (24, FontWeights.Black, Brushes.White);
        (plus.FontSize, plus.FontWeight) = (24, FontWeights.Black); // same size as the total, so both sit on one line
        foreach (var c in new[] { totalCap, plusCap }) (c.FontSize, c.FontWeight, c.Foreground, c.Margin) = (9.5, FontWeights.Bold, dim, new Thickness(1, -3, 0, 0));
        (keys.FontSize, keys.FontWeight, keys.Foreground, keys.Margin) = (10, FontWeights.SemiBold, dim, new Thickness(1, 3, 0, 0));
        plus.RenderTransform = pop;
        plus.RenderTransformOrigin = new Point(0.5, 0.5);

        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        for (var i = 0; i < 4; i++) grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        Place(grid, chest, 0, 0, rowSpan: 3);
        Place(grid, total, 0, 1);
        Place(grid, totalCap, 1, 1);
        Place(grid, plus, 0, 2);
        Place(grid, plusCap, 1, 2);
        Place(grid, keys, 2, 1, colSpan: 2);
        Place(grid, rec, 3, 1, colSpan: 2);
        plus.Margin = plusCap.Margin = new Thickness(16, plus.Margin.Top, 0, 0);
        plusCap.Margin = new Thickness(17, -3, 0, 0);
        card.Child = grid;
        card.Padding = new Thickness(10, 7, 14, 7);
        card.CornerRadius = new CornerRadius(14);
        card.Margin = new Thickness(10); // room for the shadow
        Content = card;

        tracker.Changed += Refresh;
        follow.Tick += (_, _) => Follow();
    }

    static void Place(Grid g, UIElement e, int row, int col, int rowSpan = 1, int colSpan = 1)
    {
        Grid.SetRow(e, row); Grid.SetColumn(e, col); Grid.SetRowSpan(e, rowSpan); Grid.SetColumnSpan(e, colSpan);
        g.Children.Add(e);
    }

    public void Start() { Apply(); follow.Start(); }

    /// Re-read settings (style, scale, colours, hotkeys) and redraw.
    public void Apply()
    {
        var s = settings();
        var png = Path.Combine(Replays.ImgDir, "chest.png");
        chest.Source = File.Exists(png) ? new BitmapImage(new Uri(png)) : null;
        chest.Visibility = chest.Source == null ? Visibility.Collapsed : Visibility.Visible;
        var tr = s.Lang == "tr";
        (totalCap.Text, plusCap.Text) = tr ? ("SANDIK", "BU MAÇ") : ("CHESTS", "THIS MATCH");
        var accent = (Color)ColorConverter.ConvertFromString(s.HudAccent);
        plus.Foreground = new SolidColorBrush(accent);
        keys.Text = $"{KeyName(s.AddKey)} +1 · {KeyName(s.RemoveKey)} −1";
        (card.Background, card.BorderBrush, card.BorderThickness, card.Effect) = s.HudStyle switch
        {
            "solid" => ((Brush)new SolidColorBrush(Color.FromRgb(0x1B, 0x1B, 0x1B)), (Brush)new SolidColorBrush(Color.FromArgb(70, accent.R, accent.G, accent.B)), new Thickness(1), (Effect)new DropShadowEffect { BlurRadius = 14, ShadowDepth = 3, Opacity = .5 }),
            "minimal" => (Brushes.Transparent, Brushes.Transparent, new Thickness(0), new DropShadowEffect { BlurRadius = 6, ShadowDepth = 1, Opacity = .9 }),
            _ => (new SolidColorBrush(Color.FromArgb(200, 0x12, 0x12, 0x14)), new SolidColorBrush(Color.FromArgb(50, 255, 255, 255)), new Thickness(1), new DropShadowEffect { BlurRadius = 14, ShadowDepth = 3, Opacity = .45 }),
        };
        LayoutTransform = new ScaleTransform(s.HudScale / 100.0, s.HudScale / 100.0);
        Opacity = s.HudOpacity / 100.0;
        Refresh();
        Follow();
    }

    /// Windows virtual-key code → short name (same names as the app's settings page).
    internal static string KeyName(int vk) => vk switch
    {
        >= 0x70 and <= 0x7B => "F" + (vk - 0x6F),
        >= 0x30 and <= 0x39 or >= 0x41 and <= 0x5A => ((char)vk).ToString(),
        >= 0x60 and <= 0x69 => "Num " + (vk - 0x60),
        0x2D => "Insert", 0x24 => "Home", 0x21 => "Page Up", 0x22 => "Page Down", 0x23 => "End", 0x2E => "Delete", 0x6B => "Num +", 0x6D => "Num −",
        0x08 => "Backspace", 0x09 => "Tab", 0x0D => "Enter", 0x20 => "Space", 0xBA => ";", 0xBB => "=", 0xBC => ",", 0xBD => "-", 0xBE => ".", 0xBF => "/", 0xC0 => "`", 0xDB => "[", 0xDC => "\\", 0xDD => "]", 0xDE => "'",
        _ => "Key " + vk,
    };

    void Refresh()
    {
        // only your own chests: live detection can only see yours, so the panel stays about you
        var done = tracker.History.Sum(m => m.Opens.Count(o => Tracker.IsChest(o.Type) && o.By == m.Me));
        var live = tracker.LiveOpens.Count;
        var inMatch = tracker.LiveSince != null;
        var s = settings();
        total.Text = (done + live).ToString("N0");
        plus.Text = $"+{live}";
        bool showPlus = s.HudPlus && inMatch;
        totalCap.Visibility = s.HudLabels ? Visibility.Visible : Visibility.Collapsed;
        plus.Visibility = showPlus ? Visibility.Visible : Visibility.Collapsed;
        plusCap.Visibility = showPlus && s.HudLabels ? Visibility.Visible : Visibility.Collapsed;
        keys.Visibility = s.HudHints && inMatch ? Visibility.Visible : Visibility.Collapsed;
        if (live > shownLive && shownLive >= 0)
        {
            var a = new DoubleAnimation(1.5, 1, TimeSpan.FromMilliseconds(450)) { EasingFunction = new BackEase { Amplitude = .6, EasingMode = EasingMode.EaseOut } };
            pop.BeginAnimation(ScaleTransform.ScaleXProperty, a);
            pop.BeginAnimation(ScaleTransform.ScaleYProperty, a);
        }
        shownLive = live;
        RecordLine(s, inMatch, live);
    }

    /// Near your best match: "3 to beat your record"; past it: "New record!" with a gold flash, once per match.
    /// Only the hotkey count is known during a match (the replay is encrypted until it ends).
    void RecordLine(AppSettings s, bool inMatch, int live)
    {
        if (!inMatch) recordShown = false;
        var best = tracker.History.Select(m => m.Opens.Count(o => Tracker.IsChest(o.Type) && o.By == m.Me)).DefaultIfEmpty(0).Max();
        var tr = s.Lang == "tr";
        string text = null;
        var gold = Color.FromRgb(0xFF, 0xC8, 0x3D);
        if (s.HudRecord && inMatch && best > 0)
        {
            if (live > best) text = tr ? $"★ YENİ REKOR! (önceki {best})" : $"★ NEW RECORD! (was {best})";
            else if (best + 1 - live <= Math.Max(3, best / 8)) text = tr ? $"Rekora {best + 1 - live} kaldı" : $"{best + 1 - live} to beat your record";
        }
        rec.Text = text ?? "";
        rec.Visibility = text == null ? Visibility.Collapsed : Visibility.Visible;
        rec.Foreground = new SolidColorBrush(live > best ? gold : Color.FromArgb(220, 255, 255, 255));
        if (live > best && best > 0 && inMatch && s.HudRecord && !recordShown)
        {
            recordShown = true;
            var a = new DoubleAnimation(1.8, 1, TimeSpan.FromMilliseconds(700)) { EasingFunction = new ElasticEase { Oscillations = 2, Springiness = 5, EasingMode = EasingMode.EaseOut } };
            recPop.BeginAnimation(ScaleTransform.ScaleXProperty, a);
            recPop.BeginAnimation(ScaleTransform.ScaleYProperty, a);
            // the card's border flashes gold three times
            var flash = new ColorAnimation(gold, Color.FromArgb(50, 255, 255, 255), TimeSpan.FromMilliseconds(500)) { RepeatBehavior = new RepeatBehavior(3) };
            var brush = new SolidColorBrush(gold);
            (card.BorderBrush, card.BorderThickness) = (brush, new Thickness(2));
            brush.BeginAnimation(SolidColorBrush.ColorProperty, flash);
        }
    }

    /// Show only over the active Fortnite window, pinned to the chosen corner.
    void Follow()
    {
        var s = settings();
        if (!s.Hud || !FortniteInFront(out var r)) { if (IsVisible) Hide(); return; }
        if (!IsVisible) Show();
        var dpi = VisualTreeHelper.GetDpi(this);
        double w = ActualWidth * dpi.DpiScaleX, h = ActualHeight * dpi.DpiScaleY; // device pixels
        double x = s.HudCorner is "tr" or "br" ? r.Right - w - s.HudX : r.Left + s.HudX;
        double y = s.HudCorner is "bl" or "br" ? r.Bottom - h - s.HudY : r.Top + s.HudY;
        (Left, Top) = (x / dpi.DpiScaleX, y / dpi.DpiScaleY);
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        var h = new WindowInteropHelper(this).Handle;
        // click-through (TRANSPARENT), never activated (NOACTIVATE), no taskbar/alt-tab entry (TOOLWINDOW)
        SetWindowLong(h, -20, GetWindowLong(h, -20) | 0x20 | 0x80000 | 0x08000000 | 0x80);
    }

    static uint lastPid;
    static bool lastIsFn;

    internal static bool FortniteInFront(out System.Drawing.Rectangle r)
    {
        r = default;
        var h = GetForegroundWindow();
        GetWindowThreadProcessId(h, out var pid);
        // several timers ask this a few times a second: look the process name up only when the front window changes
        if (pid != lastPid)
        {
            lastPid = pid;
            try { using var proc = Process.GetProcessById((int)pid); lastIsFn = proc.ProcessName == "FortniteClient-Win64-Shipping"; }
            catch (ArgumentException) { lastIsFn = false; }
        }
        if (!lastIsFn) return false;
        if (!GetClientRect(h, out var c)) return false;
        var p = new POINT();
        ClientToScreen(h, ref p);
        r = new System.Drawing.Rectangle(p.X, p.Y, c.Right, c.Bottom);
        return r.Width > 200;
    }

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hWnd, int index, int value);
}
