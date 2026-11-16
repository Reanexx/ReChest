using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace ChestCounter;

/// The ReChest app window: hosts ui/index.html in WebView2 and talks to it with JSON messages.
public sealed class StatsWindow : Window
{
    readonly WebView2 web = new();
    readonly Tracker tracker;
    readonly Func<AppSettings> settings;
    public event Action<AppSettings> SettingsChanged;
    public event Action<RouteOverlay.Base> RouteBase; // the Map page's map picture for the in-game card
    public event Action MapChanged; // the map state was pushed (the full-screen map wants it too)
    public CoreWebView2Environment WebEnv => web.CoreWebView2?.Environment;

    public StatsWindow(Tracker tracker, Func<AppSettings> settings)
    {
        (this.tracker, this.settings) = (tracker, settings);
        Title = "ReChest";
        (Width, Height, MinWidth, MinHeight) = (1240, 800, 1060, 680);
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = Brushes.Black;
        var icon = Path.Combine(AppContext.BaseDirectory, "app.ico");
        if (File.Exists(icon)) Icon = BitmapFrame.Create(new Uri(icon));
        web.DefaultBackgroundColor = System.Drawing.Color.Black;
        web.CreationProperties = new CoreWebView2CreationProperties { UserDataFolder = Path.Combine(Replays.Dir, "WebView2") };
        root.Children.Add(web);
        Content = root;
        SourceInitialized += (_, _) =>
        {
            DarkTitleBar(true);
            var round = 2; // DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND: Windows 11's soft corners (ignored on Windows 10)
            DwmSetWindowAttribute(new WindowInteropHelper(this).Handle, 33, ref round, sizeof(int));
        };
        // no Windows title bar: the page draws its own (drag area, minimise/maximise/close, resize edges);
        // the window keeps its normal style, so snapping, the taskbar and Alt+F4 still work
        System.Windows.Shell.WindowChrome.SetWindowChrome(this, new System.Windows.Shell.WindowChrome
        {
            CaptionHeight = 0, GlassFrameThickness = new Thickness(0), ResizeBorderThickness = new Thickness(0),
            CornerRadius = new CornerRadius(0), UseAeroCaptionButtons = false,
        });
        StateChanged += (_, _) =>
        {
            // a maximised chrome-less window overhangs the screen by its hidden frame; pad it back in
            var max = WindowState == WindowState.Maximized;
            root.Margin = max ? SystemParameters.WindowResizeBorderThickness : new Thickness(0);
            web.CoreWebView2?.PostWebMessageAsJson(Replays.ToJson(new { Type = "winState", Max = max }));
        };
        Loaded += async (_, _) => await Init();
        // hidden in the tray: let the page sleep and give memory back; shown again: wake it and refresh
        IsVisibleChanged += async (_, _) =>
        {
            var cw = web.CoreWebView2;
            if (cw == null) return;
            try
            {
                if (IsVisible) { cw.Resume(); cw.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Normal; Push(); }
                else { cw.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Low; await cw.TrySuspendAsync(); }
            }
            catch (Exception ex) when (ex is InvalidOperationException or COMException) { } // not suspendable right now
        };
        tracker.Changed += Push;
        Updater.Found += () => Dispatcher.BeginInvoke(Push); // a newer release: the page shows the update prompt
        Updater.Start();
    }

    async Task Init()
    {
        try { await web.EnsureCoreWebView2Async(); }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(this, "ReChest needs the Microsoft Edge WebView2 Runtime.\nGet it from https://developer.microsoft.com/microsoft-edge/webview2", "ReChest");
            return;
        }
        var cw = web.CoreWebView2;
        cw.SetVirtualHostNameToFolderMapping("rechest.local", Path.Combine(AppContext.BaseDirectory, "ui"), CoreWebView2HostResourceAccessKind.DenyCors);
        Directory.CreateDirectory(Replays.ImgDir);
        cw.SetVirtualHostNameToFolderMapping("img.rechest.local", Replays.ImgDir, CoreWebView2HostResourceAccessKind.Allow);
        cw.Settings.AreDefaultContextMenusEnabled = false;
        cw.Settings.IsZoomControlEnabled = false;
        cw.WebMessageReceived += OnMessage;
        cw.NewWindowRequested += (_, e) => e.Handled = true; // the UI never opens pages
        web.Source = new Uri("https://rechest.local/index.html?app=1");
        await FetchImages();
        if (!File.Exists(ChestMapFile) || File.GetLastWriteTimeUtc(ChestMapFile) < DateTime.UtcNow.AddDays(-3)) await CaptureFgg();
    }

    /// The chest pictures come from the Fortnite wiki. Its image server only serves the wiki's own pages, so on
    /// first start a hidden browser view opens the wiki's Chest page and hands back the pictures that page loads.
    async Task FetchImages()
    {
        if (File.Exists(Path.Combine(Replays.ImgDir, "chest.png"))) return;
        const string script = """
            (async () => {
              const B = 'https://static.wikia.nocookie.net/fortnite/images/';
              const list = [
                ['chest', 'a/aa/Chest_%28v23.00%29_-_Container_-_Fortnite.png', 512], ['rare', 'd/db/Rare_Chest_%28v23.00%29_-_Container_-_Fortnite.png', 256],
                ['ammo', '5/50/Ammo_Box_%28v23.00%29_-_Container_-_Fortnite.png', 256], ['drop', '7/79/Supply_Drop_-_Container_-_Fortnite.png', 256],
                ['llama', 'e/ee/Supply_Llama_-_Container_-_Fortnite.png', 256], ['fishing', 'a/aa/Fishing_Barrel_-_Container_-_Fortnite.png', 256],
                ['faction', 'a/a3/Faction_Chest_-_Container_-_Fortnite.png', 256]];
              const out = {};
              for (const [name, path, w] of list) {
                try {
                  const blob = await fetch(B + path + '/revision/latest/scale-to-width-down/' + w).then(r => r.blob());
                  const bmp = await createImageBitmap(blob);
                  const c = new OffscreenCanvas(bmp.width, bmp.height);
                  c.getContext('2d').drawImage(bmp, 0, 0);
                  const png = await c.convertToBlob({ type: 'image/png' });
                  out[name] = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(png); });
                } catch (e) { /* skip this one */ }
              }
              window.chrome.webview.postMessage(JSON.stringify(out));
            })();
            """;
        CoreWebView2Controller view = null;
        try
        {
            view = await web.CoreWebView2.Environment.CreateCoreWebView2ControllerAsync(new WindowInteropHelper(this).Handle);
            view.IsVisible = false;
            var done = new TaskCompletionSource<string>();
            var ran = false;
            view.CoreWebView2.WebMessageReceived += (_, e) => done.TrySetResult(e.TryGetWebMessageAsString());
            view.CoreWebView2.NavigationCompleted += async (_, e) =>
            {
                if (!e.IsSuccess) { done.TrySetResult(null); return; }
                if (ran) return;
                ran = true;
                await view.CoreWebView2.ExecuteScriptAsync(script);
            };
            view.CoreWebView2.Navigate("https://fortnite.fandom.com/wiki/Chest");
            var json = await Task.WhenAny(done.Task, Task.Delay(TimeSpan.FromSeconds(60))) == done.Task ? done.Task.Result : null;
            if (json == null) return;
            foreach (var p in JsonDocument.Parse(json).RootElement.EnumerateObject())
            {
                var data = p.Value.GetString() ?? "";
                if (!data.StartsWith("data:image/png;base64,") || p.Name.Any(c => !char.IsAsciiLetterLower(c))) continue;
                var bytes = Convert.FromBase64String(data[22..]);
                if (bytes.Length > 8 && bytes[0] == 0x89 && bytes[1] == 'P') File.WriteAllBytes(Path.Combine(Replays.ImgDir, p.Name + ".png"), bytes);
            }
            ImagesReady?.Invoke();
            Push();
        }
        catch (Exception ex) when (ex is COMException or IOException or JsonException or FormatException or InvalidOperationException) { } // offline: drawn icons stay
        finally { view?.Close(); }
    }

    public event Action ImagesReady;

    public void Push()
    {
        if (web.CoreWebView2 == null) return;
        var backups = tracker.Backups;
        web.CoreWebView2.PostWebMessageAsJson(Replays.ToJson(new
        {
            Matches = tracker.History,
            LiveSince = tracker.LiveSince,
            Live = tracker.LiveOpens.Select(o => new { o.Type, o.AtUtc, o.Manual }),
            Settings = settings(),
            Keys = new { Interact = KeyBinds.Interact().Select(KeyBinds.Display), Attack = KeyBinds.Attack().Select(KeyBinds.Display) },
            Demos = Directory.Exists(Replays.Demos),
            Backups = new { backups.Count, backups.Bytes },
            Images = Directory.Exists(Replays.ImgDir) ? Directory.GetFiles(Replays.ImgDir, "*.png").Select(Path.GetFileNameWithoutExtension) : [],
            Version = Updater.Version,
            Update = Updater.Latest,
            ChestMap = MapState(),
        }));
        MapChanged?.Invoke();
    }

    void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!e.Source.StartsWith("https://rechest.local/", StringComparison.Ordinal)) return; // only our own page
        Receive(e.WebMessageAsJson);
    }

    /// A message from our page (this window's, or the full-screen map's).
    public void Receive(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var msg = doc.RootElement;
        switch (msg.GetProperty("type").GetString())
        {
            case "ready": Push(); break;
            case "updateCheck": // Settings > About: look now; ui/update.js shows the answer (a newer one also opens the prompt)
                _ = Updater.Check().ContinueWith(t => Dispatcher.BeginInvoke(() =>
                    web.CoreWebView2?.ExecuteScriptAsync($"ReUpdate.checked({(t.Result is { } f ? f ? "'new'" : "'none'" : "'error'")})")));
                break;
            case "updateNow": // download the installer with progress, run it, quit (it starts the new version); ui/update.js shows it
                _ = Updater.Install(p => Dispatcher.BeginInvoke(() => web.CoreWebView2?.ExecuteScriptAsync($"ReUpdate.progress({p})")))
                    .ContinueWith(t => Dispatcher.BeginInvoke(() =>
                    {
                        if (t.Result) Application.Current.Shutdown();
                        else web.CoreWebView2?.ExecuteScriptAsync("ReUpdate.error()");
                    }));
                break;
            case "settings":
                var s = msg.GetProperty("settings").Deserialize<AppSettings>(new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                if (s != null) SettingsChanged?.Invoke(s);
                break;
            case "broadcast": Broadcast.Send(); break;
            case "bcastHistory":
                _ = Task.Run(Broadcast.History).ContinueWith(t => Dispatcher.BeginInvoke(() =>
                    web.CoreWebView2?.PostWebMessageAsJson(Replays.ToJson(new { Type = "bcastHistory", Times = t.Result }))));
                break;
            case "win": Win(msg.GetProperty("act").GetString(), msg.TryGetProperty("edge", out var edge) ? edge.GetString() : null); break;
            case "openDemos": OpenFolder(Replays.Demos); break;
            case "openBackups": OpenFolder(Tracker.BackupDir); break;
            case "openDebug": OpenFolder(Path.Combine(Replays.Dir, "Debug")); break;
            case "fgg": ShowFgg(msg); break;
            case "fggUpdate": _ = CaptureFgg(); break;
            case "routeImg":
                double N(string k) => msg.TryGetProperty(k, out var v) && v.TryGetDouble(out var d) ? d : 0;
                RouteBase?.Invoke(new RouteOverlay.Base(msg.TryGetProperty("img", out var img) ? img.GetString() : null,
                    N("x0"), N("y0"), Math.Max(0.01, N("ppu")), N("cx"), N("cy"), N("span"), msg.TryGetProperty("stats", out var st) ? st.GetString() : "",
                    Points("route"), Points("stops")));
                double[][] Points(string k) => msg.TryGetProperty(k, out var a) && a.ValueKind == JsonValueKind.Array
                    ? a.EnumerateArray().Where(p => p.ValueKind == JsonValueKind.Array && p.GetArrayLength() >= 2).Select(p => new[] { p[0].GetDouble(), p[1].GetDouble() }).ToArray() : null;
                break;
            case "routePrefs": // the Map page's shown layers and stop count, for "route from here"
                var ps = settings();
                var layers = msg.TryGetProperty("on", out var lo) && lo.ValueKind == JsonValueKind.Array ? lo.EnumerateArray().Select(v => v.GetString()).Where(v => v != null).ToArray() : null;
                var stops = msg.TryGetProperty("stops", out var so) && so.TryGetInt32(out var sn) ? Math.Clamp(sn, 2, 500) : ps.RouteStops;
                if (layers == null || (ps.MapLayers != null && layers.SequenceEqual(ps.MapLayers) && stops == ps.RouteStops)) break;
                (ps.MapLayers, ps.RouteStops) = (layers, stops);
                SettingsChanged?.Invoke(ps);
                break;
            case "routeZoom": // the card zoom slider on the Map page / big map
                var zs = settings();
                zs.RouteZoom = Math.Clamp(msg.TryGetProperty("value", out var zv) && zv.TryGetInt32(out var z) ? z : 100, 50, 300);
                SettingsChanged?.Invoke(zs);
                break;
            case "mapTrack":
                var ts = settings();
                ts.MapTrack = msg.TryGetProperty("on", out var tOn) && tOn.ValueKind == JsonValueKind.True;
                SettingsChanged?.Invoke(ts);
                break;
            case "routeOverlay":
                var rs = settings();
                rs.RouteOverlay = msg.TryGetProperty("on", out var on) && on.ValueKind == JsonValueKind.True;
                SettingsChanged?.Invoke(rs);
                break;
            case "fggHide": if (fggView != null) fggView.Visibility = Visibility.Collapsed; break;
        }
    }

    public static readonly string ChestMapFile = Path.Combine(Replays.Dir, "fortnite-map.json");
    static object ChestMap()
    {
        try { return File.Exists(ChestMapFile) ? JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(ChestMapFile)) : null; }
        catch (JsonException) { return null; } // half-written or old file: the map just shows no chests
    }

    readonly System.Windows.Controls.Grid root = new();
    WebView2 fggView;
    bool fggBusy, fggNeedsCheck;
    string fggError;

    /// What the Map page gets: the saved spots plus how the fortnite.gg fetch is going.
    public object MapState() => new { File = ChestMap(), Busy = fggBusy, NeedsCheck = fggNeedsCheck, Error = fggError, IconBase = "https://img.rechest.local/icons/",
                               RouteOn = settings().RouteOverlay, RouteKey = settings().RouteKey, RouteBigKey = settings().RouteBigKey, RouteFullKey = settings().RouteFullKey, RouteDot = settings().RouteDot, RouteZoom = settings().RouteZoom, RouteHereKey = settings().RouteHereKey, Track = settings().MapTrack, NewRoute = newRoute };

    object newRoute; // the last "route from here": the Map pages take it (and keep the old route in Saved routes)
    public void SetNewRoute(List<double[]> world) { newRoute = new { Id = DateTime.UtcNow.Ticks.ToString(), Pts = world.Select(p => new { X = p[0], Y = p[1] }) }; Push(); }

    /// Your position from the minimap (2048 px map space), straight to the Map page without a full data push.
    // only while the window shows: hidden in the tray its page sleeps, and a script would wake it
    public void SetPos(double x, double y, double heading) { if (IsVisible) web.CoreWebView2?.ExecuteScriptAsync(PosScript(x, y, heading)); }
    public void SetHeading(double heading) { if (IsVisible) web.CoreWebView2?.ExecuteScriptAsync(HeadingScript(heading)); }
    public static string HeadingScript(double h) => string.Create(System.Globalization.CultureInfo.InvariantCulture, $"window.MapUI && MapUI.setHeading({h:F0})");
    public static string PosScript(double x, double y, double heading) => string.Create(System.Globalization.CultureInfo.InvariantCulture,
        $"window.MapUI && MapUI.setPos({x:F1},{y:F1},{(double.IsNaN(heading) ? "null" : heading.ToString("F0", System.Globalization.CultureInfo.InvariantCulture))})");

    /// fortnite.gg has no API, so a hidden browser view opens its map page and the page's own data is read from there
    /// (Fgg.Script). If nothing comes back in a minute (its bot check is showing), the Map page offers the visible view.
    async Task CaptureFgg()
    {
        if (fggBusy || web.CoreWebView2 == null) return;
        (fggBusy, fggError) = (true, null);
        Push();
        CoreWebView2Controller view = null;
        try
        {
            view = await web.CoreWebView2.Environment.CreateCoreWebView2ControllerAsync(new WindowInteropHelper(this).Handle);
            view.IsVisible = false;
            var done = new TaskCompletionSource<string>();
            view.CoreWebView2.WebMessageReceived += (_, e) => done.TrySetResult(e.TryGetWebMessageAsString());
            view.CoreWebView2.NavigationCompleted += async (_, e) => { if (e.IsSuccess) await view.CoreWebView2.ExecuteScriptAsync(Fgg.Script); };
            view.CoreWebView2.Navigate(FggUrl);
            var payload = await Task.WhenAny(done.Task, Task.Delay(TimeSpan.FromSeconds(60))) == done.Task ? done.Task.Result : null;
            if (payload == null) fggNeedsCheck = true;
            else await SaveFgg(payload);
        }
        catch (Exception ex) when (ex is COMException or InvalidOperationException) { fggNeedsCheck = true; }
        finally
        {
            view?.Close();
            fggBusy = false;
            Push();
        }
    }
    const string FggUrl = "https://fortnite.gg/"; // the home page is the map (/map loops /map <-> /map/, Nov 2026)

    async Task SaveFgg(string payload)
    {
        try
        {
            var (map, icons) = Fgg.Convert(payload, await Fgg.WorldPois());
            var dir = Path.Combine(Replays.ImgDir, "icons");
            Directory.CreateDirectory(dir);
            foreach (var (id, png) in icons) await File.WriteAllBytesAsync(Path.Combine(dir, id + ".png"), png);
            var tmp = ChestMapFile + ".tmp"; // write-then-move: never a half-written map file
            await File.WriteAllTextAsync(tmp, Replays.ToJson(map));
            File.Move(tmp, ChestMapFile, true);
            (fggNeedsCheck, fggError) = (false, null);
            if (fggView != null) fggView.Visibility = Visibility.Collapsed;
        }
        // offline, or the site changed its format: keep the old spots and say why
        catch (Exception ex) when (ex is IOException or HttpRequestException or TaskCanceledException or JsonException or InvalidDataException or KeyNotFoundException or FormatException or InvalidOperationException)
        {
            fggError = ex is HttpRequestException or TaskCanceledException ? "fortnite-api.com did not answer" : "fortnite.gg changed its map data";
            try { Directory.CreateDirectory(Path.Combine(Replays.Dir, "Debug")); File.WriteAllText(Path.Combine(Replays.Dir, "Debug", "fgg-error.txt"), $"{DateTime.Now:u}\n{ex}"); } catch (IOException) { }
        }
    }

    /// When fortnite.gg shows its bot check, the page lays this visible view over the slot under the Route panel (it
    /// sends the slot's box on every layout change); once the user passes the check the same script reads the data.
    async void ShowFgg(JsonElement msg)
    {
        double N(string k) => msg.TryGetProperty(k, out var v) && v.TryGetDouble(out var d) ? d : 0;
        var first = fggView == null;
        fggView ??= new WebView2 { HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top, DefaultBackgroundColor = System.Drawing.Color.Black };
        fggView.Margin = new Thickness(N("x"), N("y"), 0, 0);
        (fggView.Width, fggView.Height) = (Math.Max(1, N("w")), Math.Max(1, N("h")));
        fggView.Visibility = Visibility.Visible;
        if (!first) { OnTop(); return; }
        root.Children.Add(fggView);
        try
        {
            await fggView.EnsureCoreWebView2Async(web.CoreWebView2.Environment);
            OnTop();
            fggView.CoreWebView2.WebMessageReceived += async (_, e) => { await SaveFgg(e.TryGetWebMessageAsString()); Push(); };
            fggView.CoreWebView2.NavigationCompleted += async (_, e) => { if (e.IsSuccess) await fggView.CoreWebView2.ExecuteScriptAsync(Fgg.Script); };
            fggView.CoreWebView2.NewWindowRequested += (_, e) => e.Handled = true;
            fggView.Source = new Uri(FggUrl);
        }
        catch (Exception ex) when (ex is COMException or InvalidOperationException) { fggView.Visibility = Visibility.Collapsed; }
    }

    /// Both browser views are child windows; keep fortnite.gg's above the app page.
    void OnTop()
    {
        if (fggView?.Handle is { } h && h != IntPtr.Zero) SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x0013); // HWND_TOP; NOSIZE|NOMOVE|NOACTIVATE
    }
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
    static readonly Dictionary<string, int> Edges = new() { ["l"] = 10, ["r"] = 11, ["t"] = 12, ["tl"] = 13, ["tr"] = 14, ["b"] = 15, ["bl"] = 16, ["br"] = 17 };

    /// The page's own title bar: window buttons, dragging by the top bar, resizing from the edges.
    void Win(string act, string edge)
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        switch (act)
        {
            case "min": WindowState = WindowState.Minimized; break;
            case "max": WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized; break;
            case "close": Close(); break;
            case "drag": // hand the press to Windows as if it hit a title bar (WM_NCLBUTTONDOWN, HTCAPTION)
                ReleaseCapture();
                SendMessage(hwnd, 0xA1, 2, IntPtr.Zero);
                break;
            case "resize" when edge != null && Edges.TryGetValue(edge, out var hit) && WindowState == WindowState.Normal:
                ReleaseCapture();
                SendMessage(hwnd, 0xA1, hit, IntPtr.Zero);
                break;
        }
    }

    static void OpenFolder(string dir)
    {
        if (Directory.Exists(dir)) Process.Start(new ProcessStartInfo("explorer.exe", $"\"{dir}\"") { UseShellExecute = true });
    }

    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    void DarkTitleBar(bool dark)
    {
        var on = dark ? 1 : 0;
        DwmSetWindowAttribute(new WindowInteropHelper(this).Handle, 20, ref on, sizeof(int)); // DWMWA_USE_IMMERSIVE_DARK_MODE
    }
}
