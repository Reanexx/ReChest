using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace ChestCounter;

/// The big map over Fortnite (full-screen key, F5 by default): the game dims behind a dark see-through veil and the
/// Map page itself (ui/map-full.html) opens in the middle, so you can scroll to zoom, drag to move, switch layers and
/// look at or edit the route. It takes focus while open, so the mouse works; the same key, Esc or a click on the veil
/// closes it and hands focus back to the game. The browser view is made on first use and kept, so later opens are
/// instant. (A browser view can't be see-through over another app, hence the separate veil window under it.)
public sealed class MapFull : Window
{
    const double Wide = 0.8, Tall = 0.86; // share of the game window the map takes
    readonly WebView2 web = new() { DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 9, 13, 40) };
    readonly StatsWindow app;
    readonly Window veil = new()
    {
        WindowStyle = WindowStyle.None, AllowsTransparency = true, Background = new SolidColorBrush(Color.FromArgb(165, 2, 4, 18)),
        Topmost = true, ShowInTaskbar = false, ResizeMode = ResizeMode.NoResize, Title = "ReChest map veil", Opacity = 0,
    };
    IntPtr game;
    bool ready;
    (double X, double Y, double H)? last; // your last position: shown the moment the map opens

    public MapFull(StatsWindow app)
    {
        this.app = app;
        (WindowStyle, ResizeMode, Topmost, ShowInTaskbar, Background, Title) = (WindowStyle.None, ResizeMode.NoResize, true, false, new SolidColorBrush(Color.FromRgb(9, 13, 40)), "ReChest map");
        Content = web;
        veil.MouseDown += (_, _) => Close2(); // a click outside the map closes it
        SourceInitialized += (_, _) =>
        {
            var round = 2; // DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND: soft corners (Windows 11)
            DwmSetWindowAttribute(new WindowInteropHelper(this).Handle, 33, ref round, sizeof(int));
        };
        Loaded += async (_, _) =>
        {
            // started in the background, the app window may never have made its browser: same profile folder, own start
            var env = app.WebEnv ?? await CoreWebView2Environment.CreateAsync(null, System.IO.Path.Combine(Replays.Dir, "WebView2"));
            await web.EnsureCoreWebView2Async(env);
            var cw = web.CoreWebView2;
            cw.SetVirtualHostNameToFolderMapping("rechest.local", System.IO.Path.Combine(AppContext.BaseDirectory, "ui"), CoreWebView2HostResourceAccessKind.DenyCors);
            cw.SetVirtualHostNameToFolderMapping("img.rechest.local", Replays.ImgDir, CoreWebView2HostResourceAccessKind.Allow);
            cw.Settings.AreDefaultContextMenusEnabled = false;
            cw.Settings.IsZoomControlEnabled = false;
            cw.NewWindowRequested += (_, e) => e.Handled = true;
            cw.WebMessageReceived += (_, e) =>
            {
                if (!e.Source.StartsWith("https://rechest.local/", StringComparison.Ordinal)) return; // only our own page
                var json = e.WebMessageAsJson;
                using var doc = JsonDocument.Parse(json);
                switch (doc.RootElement.TryGetProperty("type", out var t) ? t.GetString() : null)
                {
                    case "ready": ready = true; Send(); Open(); break;
                    case "mapFullClose": Close2(); break;
                    default: app.Receive(json); break; // route, layers, settings: same as the Map page
                }
            };
            cw.Navigate("https://rechest.local/map-full.html");
        };
    }

    /// Opens it over the game, or closes it if it's open.
    public void Toggle()
    {
        if (IsVisible) { Close2(); return; }
        if (!Hud.FortniteInFront(out var r)) return; // only over the game
        game = GetForegroundWindow();
        var dpi = VisualTreeHelper.GetDpi(Application.Current.MainWindow);
        double x = r.Left / dpi.DpiScaleX, y = r.Top / dpi.DpiScaleY, w = r.Width / dpi.DpiScaleX, h = r.Height / dpi.DpiScaleY;
        (veil.Left, veil.Top, veil.Width, veil.Height) = (x, y, w, h);
        (Left, Top, Width, Height) = (x + w * (1 - Wide) / 2, y + h * (1 - Tall) / 2, w * Wide, h * Tall);
        veil.Show();
        veil.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(200)));
        Show();
        Activate();
        web.Focus();
        if (ready) { Send(); Open(); }
    }

    void Close2()
    {
        Hide();
        var fade = new DoubleAnimation(0, TimeSpan.FromMilliseconds(160));
        fade.Completed += (_, _) => { if (!IsVisible) veil.Hide(); };
        veil.BeginAnimation(OpacityProperty, fade);
        if (game != IntPtr.Zero) SetForegroundWindow(game); // straight back into the game
    }

    /// The same map state the Map page gets.
    public void Send()
    {
        if (ready && IsVisible) web.CoreWebView2?.PostWebMessageAsJson(Replays.ToJson(new { Type = "map", State = app.MapState() }));
    }

    void Open()
    {
        if (last is var (x, y, h)) web.CoreWebView2?.ExecuteScriptAsync(StatsWindow.PosScript(x, y, h)); // your arrow right away
        web.CoreWebView2?.ExecuteScriptAsync("window.mfOpen && mfOpen()"); // then centre on it
    }

    public void SetHeading(double h)
    {
        if (last is var (x, y, _)) last = (x, y, h);
        if (ready && IsVisible) web.CoreWebView2?.ExecuteScriptAsync(StatsWindow.HeadingScript(h));
    }

    public void SetPos(double x, double y, double heading)
    {
        last = (x, y, heading);
        if (ready && IsVisible) web.CoreWebView2?.ExecuteScriptAsync(StatsWindow.PosScript(x, y, heading));
    }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
}
