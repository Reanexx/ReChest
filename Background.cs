using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Win32;

namespace ChestCounter;

/// Running quietly in the background: start with Windows (HKCU Run key, --background), one copy at a time,
/// a tray icon instead of quitting on close, and the window pops up when Fortnite starts.
/// Idle cost is one process lookup every 5 s; the window's WebView2 is created only the first time it is shown,
/// and is suspended with a low memory target while the window is hidden.
public static class Background
{
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run", RunName = "ReChest";
    const string MutexName = "ReChest.SingleInstance", ShowEventName = "ReChest.ShowWindow";
    static Mutex mutex;
    static EventWaitHandle showEvent;
    static System.Windows.Forms.NotifyIcon tray;
    public static bool Quitting { get; private set; }

    /// True when this is the only copy. A second copy asks the first one to show its window and exits.
    public static bool ClaimSingleInstance()
    {
        mutex = new Mutex(true, MutexName, out var first);
        if (first) return true;
        try { EventWaitHandle.OpenExisting(ShowEventName).Set(); } catch (WaitHandleCannotBeOpenedException) { }
        return false;
    }

    /// Adds or removes the "start with Windows" entry so it matches the setting.
    public static void SetAutostart(bool on)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true) ?? Registry.CurrentUser.CreateSubKey(RunKey);
            var exe = Environment.ProcessPath;
            if (on && exe != null) key.SetValue(RunName, $"\"{exe}\" --background");
            else if (key.GetValue(RunName) != null) key.DeleteValue(RunName);
        }
        catch (Exception e) when (e is UnauthorizedAccessException or IOException or System.Security.SecurityException) { } // policy-locked: leave it
    }

    public static bool FortniteRunning()
    {
        var ps = Process.GetProcessesByName("FortniteClient-Win64-Shipping");
        foreach (var p in ps) p.Dispose();
        return ps.Length > 0;
    }

    /// Tray icon, close-to-tray, "show me" requests from a second copy, and the Fortnite watcher.
    public static void Start(Window main, Func<AppSettings> settings)
    {
        showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        var ui = main.Dispatcher;
        new Thread(() => { while (showEvent.WaitOne()) ui.BeginInvoke(() => Reveal(main, activate: true)); }) { IsBackground = true, Name = "ReChest show" }.Start();

        var menu = new System.Windows.Forms.ContextMenuStrip();
        menu.Items.Add("Open ReChest", null, (_, _) => Reveal(main, activate: true));
        menu.Items.Add("Quit", null, (_, _) => { Quitting = true; main.Close(); });
        var ico = Path.Combine(AppContext.BaseDirectory, "app.ico");
        tray = new System.Windows.Forms.NotifyIcon
        {
            Icon = File.Exists(ico) ? new System.Drawing.Icon(ico) : System.Drawing.SystemIcons.Application,
            Text = "ReChest", Visible = true, ContextMenuStrip = menu,
        };
        tray.MouseClick += (_, e) => { if (e.Button == System.Windows.Forms.MouseButtons.Left) Reveal(main, activate: true); };

        main.Closing += (_, e) =>
        {
            if (Quitting || !settings().CloseToTray) return;
            e.Cancel = true; // keep running for the overlay and for Fortnite starts; the tray icon brings it back
            main.Hide();
        };
        main.Closed += (_, _) => { tray.Visible = false; tray.Dispose(); };

        // Fortnite starting: show the window (without stealing focus from the game's launch)
        var wasRunning = FortniteRunning();
        var watch = new DispatcherTimer(DispatcherPriority.Background, ui) { Interval = TimeSpan.FromSeconds(5) };
        watch.Tick += (_, _) =>
        {
            var running = FortniteRunning();
            if (running && !wasRunning && settings().ShowOnFortnite) Reveal(main, activate: false);
            wasRunning = running;
        };
        watch.Start();
    }

    public static void Reveal(Window w, bool activate)
    {
        w.ShowActivated = activate;
        if (!w.IsVisible) w.Show();
        if (w.WindowState == WindowState.Minimized) w.WindowState = WindowState.Normal;
        if (activate) w.Activate();
        else tray?.ShowBalloonTip(3000, "ReChest", "Fortnite started. ReChest is counting your chests.", System.Windows.Forms.ToolTipIcon.None);
    }
}
