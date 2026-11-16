using System.IO;
using System.Windows;

namespace ChestCounter;

public partial class App : Application
{
    AppSettings settings;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        switch (e.Args)
        {
            case ["--parse", var replay, var json]: // debug: parse one replay to JSON
                try { File.WriteAllText(json, Replays.ToJson(Replays.Parse(replay))); Shutdown(0); }
                catch (Exception ex) { File.WriteAllText(json, ex.ToString()); Shutdown(1); }
                return;
            case ["--dump", var replay, var txt]: // debug: raw container updates and player tables
                try { File.WriteAllText(txt, Replays.Dump(replay)); Shutdown(0); }
                catch (Exception ex) { File.WriteAllText(txt, ex.ToString()); Shutdown(1); }
                return;
            case ["--minimap", var shot, var txt]: // debug: where a game screenshot puts you on the map
                File.WriteAllText(txt, Task.Run(() => MinimapTracker.Explain(shot)).GetAwaiter().GetResult()); // off the UI thread: its awaits would deadlock here
                Shutdown();
                return;
            case ["--minimapdir", var dir, var txt]: // debug: re-match saved minimap samples
                File.WriteAllText(txt, Task.Run(() => MinimapTracker.ExplainDir(dir)).GetAwaiter().GetResult());
                Shutdown();
                return;
            case ["--selftest"]:
                try { ScreenWatcher.SelfTest(); Fgg.SelfTest(); MinimapTracker.SelfTest(Path.Combine(Replays.ImgDir, "map.png")); RouteBuilder.SelfTest(); ChestPointer.SelfTest(); Updater.SelfTest(); Shutdown(0); } catch { Shutdown(1); }
                return;
            case ["--ocr", var image, var txt]: // debug: what the screen detector sees in an image
                {
                    using var bmp = new System.Drawing.Bitmap(image);
                    File.WriteAllText(txt, Task.Run(() => new ScreenWatcher(() => true).Explain(bmp)).GetAwaiter().GetResult()); // off the UI thread: its awaits would deadlock here
                    Shutdown();
                    return;
                }
        }

        if (!Background.ClaimSingleInstance()) { Shutdown(); return; } // already running: that copy shows its window
        var hidden = e.Args.Contains("--background"); // started with Windows: stay in the tray until needed
        settings = AppSettings.Load();
        Background.SetAutostart(settings.StartWithWindows);
        var tracker = new Tracker();
        var screen = new ScreenWatcher(() => tracker.LiveSince != null);
        var input = new InputWatcher();
        var hud = new Hud(tracker, () => settings);
        var stats = new StatsWindow(tracker, () => settings);
        MainWindow = stats; // closing the app quits; the panel goes with it

        void Apply()
        {
            screen.Enabled = false; // live screen counting removed; chests are added by hotkey only
            screen.DebugDir = null;
            (input.AddKey, input.RemoveKey, input.RouteKey, input.RouteBigKey, input.RouteFullKey, input.RouteHereKey, input.PointerKey) = (settings.AddKey, settings.RemoveKey, settings.RouteKey, settings.RouteBigKey, settings.RouteFullKey, settings.RouteHereKey, settings.PointerKey);
            hud.Apply();
        }
        Apply();

        screen.Detected += type => Dispatcher.BeginInvoke(() => tracker.AddLive(type));
        screen.MouseTravel = () => input.Travel;
        input.SetKeys(KeyBinds.Interact(), KeyBinds.Attack());
        input.Pressed += screen.OnPress;
        input.Hotkey += tracker.Adjust;
        input.TriplePeriod += () => Dispatcher.BeginInvoke(ShowBroadcastWindow); // "..." : open the broadcast window
        Broadcast.Listen(() => Dispatcher.BeginInvoke(() =>                 // someone broadcast: play on this machine too
        {
            if (settings.ReceiveBroadcasts) PlayOverlay();
        }));
        var bindsTime = File.GetLastWriteTimeUtc(KeyBinds.SaveFile);
        tracker.Changed += () => // Fortnite saves its settings at match start/end: pick up changed binds
        {
            var t = File.GetLastWriteTimeUtc(KeyBinds.SaveFile);
            if (t != bindsTime) { bindsTime = t; input.SetKeys(KeyBinds.Interact(), KeyBinds.Attack()); }
        };
        stats.ImagesReady += hud.Apply;
        stats.SettingsChanged += s =>
        {
            settings = s;
            settings.Save();
            Background.SetAutostart(settings.StartWithWindows);
            Apply();
            stats.Push();
        };

        // the map over the game: the card (route key / size key) and the full-screen map (full key), fed by the Map page
        var route = new RouteOverlay(() => settings, () => tracker.LiveSince != null);
        MapFull full = null;
        stats.RouteBase += route.SetBase;
        stats.MapChanged += () => full?.Send();
        var minimap = new MinimapTracker { Active = () => settings.MapTrack && tracker.LiveSince != null, Quality = () => settings.TrackQuality };
        var pointer = new ChestPointer(() => settings, () => tracker.LiveSince != null);
        minimap.Found += (x, y, h, _) => Dispatcher.BeginInvoke(() => { stats.SetPos(x, y, h); route.SetPos(x, y, h); full?.SetPos(x, y, h); pointer.SetPos(x, y, h); });
        minimap.Turned += h => Dispatcher.BeginInvoke(() => { stats.SetHeading(h); route.SetHeading(h); full?.SetHeading(h); pointer.SetHeading(h); });
        void MapKey(Action change)
        {
            change();
            settings.Save();
            route.Refresh(); // animate right away, not on the next follow tick
            stats.Push();
        }
        input.RouteSize += () => Dispatcher.BeginInvoke(() => MapKey(() =>
        {
            settings.RouteBig = !settings.RouteBig;
            if (settings.RouteBig) settings.RouteOverlay = true; // asking for it bigger means showing it
        }));
        input.RouteToggle += () => Dispatcher.BeginInvoke(() => MapKey(() => settings.RouteOverlay = !settings.RouteOverlay));
        input.RouteFull += () => Dispatcher.BeginInvoke(() =>
        {
            full ??= new MapFull(stats);
            if (route.MeAll is var (x, y, h)) full.SetPos(x, y, h); // your arrow is there the moment it opens
            full.Toggle();
        });
        input.RouteHere += () => Dispatcher.BeginInvoke(() => // a new route from where you stand; the old one goes to Saved routes
        {
            if (route.Me is not var (mx, my) || RouteBuilder.FromHere(mx, my, settings) is not { } r) return; // no position or no chest spots yet
            route.SetRoute(r.Img, r.StopsImg, r.Stats);
            stats.SetNewRoute(r.World);
            if (!settings.RouteOverlay) MapKey(() => settings.RouteOverlay = true);
        });
        if (!hidden) stats.Show();
        Background.Start(stats, () => settings);
        tracker.Start();
        input.Start();
        hud.Start();
        route.Start();
        minimap.Start();
        pointer.Start();
        input.PointerToggle += () => Dispatcher.BeginInvoke(() => MapKey(() => settings.MapPointers = !settings.MapPointers));
    }

    VideoOverlay overlay;
    BroadcastWindow bcast;

    // A received broadcast: play the built-in video with the background keyed out, only over Fortnite when it is the
    // window in front (on its monitor); anyone not in the game sees nothing.
    void PlayOverlay()
    {
        if (overlay != null || !Hud.FortniteInFront(out var game)) return;
        overlay = new VideoOverlay(System.Windows.Forms.Screen.FromRectangle(game).Bounds);
        overlay.FormClosed += (_, _) => overlay = null;
        overlay.Show();
    }

    // "..." (three quick dots): the window to broadcast to everyone and to toggle receiving.
    void ShowBroadcastWindow()
    {
        if (bcast != null && !bcast.IsDisposed) { bcast.Activate(); return; }
        bcast = new BroadcastWindow(settings, () => settings.Save());
        bcast.FormClosed += (_, _) => bcast = null;
        bcast.Show();
    }
}
