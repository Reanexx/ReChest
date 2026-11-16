using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Win32;

namespace ReChestSetup;

/// Starts before anything else so WebView2's libraries (embedded resources) resolve from inside the exe.
static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        AppDomain.CurrentDomain.AssemblyResolve += (_, e) =>
        {
            using var s = typeof(Program).Assembly.GetManifestResourceStream(new AssemblyName(e.Name).Name + ".dll");
            if (s == null) return null;
            var b = new byte[s.Length];
            s.Read(b, 0, b.Length);
            return Assembly.Load(b);
        };
        return Run(args);
    }

    [MethodImpl(MethodImplOptions.NoInlining)] // keep WebView2 types out of Main, which runs before the resolver exists
    static int Run(string[] args) => Setup.Main(args);
}

/// The command line:  (none)  install wizard              --update [--dir D]  minimal UI, install over D, restart the app
///                    --silent  no UI (with any mode)      --uninstall [--dir D]  remove (Apps & features runs uninstall.exe --uninstall)
static class Setup
{
    public const string AppExe = "ChestCounter.exe", Uninstaller = "uninstall.exe", Manifest = "install.files";
    const string UninstKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ReChest";
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run", RunName = "ReChest";
    public static readonly string DefaultDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "ReChest");
    static readonly string DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ChestCounter");
    static readonly string StartMenuLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "ReChest.lnk");
    static readonly string DesktopLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "ReChest.lnk");
    public static readonly string Version = typeof(Setup).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0] ?? "0.0.0";
    public static readonly string Self = Process.GetCurrentProcess().MainModule.FileName;

    public static string Mode = "install";
    public static bool Silent;
    public static string Dir;

    public static int Main(string[] args)
    {
        for (var i = 0; i < args.Length; i++)
            switch (args[i].ToLowerInvariant())
            {
                case "--update": Mode = "update"; break;
                case "--uninstall": Mode = "uninstall"; break;
                case "--silent": Silent = true; break;
                case "--dir" when i + 1 < args.Length: Dir = args[++i].TrimEnd('\\'); break;
            }
        Dir ??= InstalledDir() ?? DefaultDir;
        if (Payload.Find() == null) Mode = "uninstall"; // the installed copy (uninstall.exe) carries no app

        // uninstalling from the install folder: run a copy from %TEMP% so the folder (and this exe) can be deleted
        if (Mode == "uninstall" && IsUnder(Self, Dir))
        {
            var tmp = Path.Combine(Path.GetTempPath(), "ReChestUninstall.exe");
            File.Copy(Self, tmp, true);
            Process.Start(new ProcessStartInfo(tmp, $"--uninstall --dir \"{Dir}\"" + (Silent ? " --silent" : "")) { UseShellExecute = false });
            return 0;
        }

        if (Silent)
        {
            try
            {
                if (Mode == "uninstall") Uninstall(Dir, false, (_, _) => { });
                else Install(Dir, desktop: Mode == "install", startup: Mode == "install" ? true : (bool?)null, (_, _) => { });
                if (Mode == "update") Launch(Dir);
                return 0;
            }
            catch (Exception e) { Log(e); return 1; }
            finally { if (Mode == "uninstall") DeleteSelfLater(); }
        }

        var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
        var code = app.Run(new SetupWindow());
        if (Mode == "uninstall") DeleteSelfLater();
        return code;
    }

    // ---- install ----------------------------------------------------------------------------------------------

    /// startup: on/off for "start with Windows", null = leave as it is (updates).
    public static void Install(string dir, bool desktop, bool? startup, Action<double, string> progress)
    {
        var payload = Payload.Find() ?? throw new InvalidOperationException("This installer is damaged (no app inside). Download it again.");
        progress(1, "stWait");
        CloseApp(dir, wait: TimeSpan.FromSeconds(Mode == "update" ? 20 : 5));
        Directory.CreateDirectory(dir);
        var root = Path.GetFullPath(dir + "\\");
        var oldFiles = ReadManifest(dir);
        var newFiles = new List<string>();

        progress(4, "stCopy");
        using (var fs = File.OpenRead(Self))
        using (var zip = new ZipArchive(new Slice(fs, payload.ZipOffset, payload.ZipLength), ZipArchiveMode.Read))
        {
            var total = Math.Max(1, zip.Entries.Sum(e => e.Length));
            long done = 0;
            foreach (var e in zip.Entries)
            {
                var path = Path.GetFullPath(Path.Combine(dir, e.FullName));
                if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue; // never outside the folder
                if (e.FullName.EndsWith("/")) { Directory.CreateDirectory(path); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                Retry(() => e.ExtractToFile(path, true)); // a file may still be held for a moment by the closing app
                newFiles.Add(e.FullName.Replace('/', '\\'));
                done += e.Length;
                progress(4 + 84.0 * done / total, null);
            }
        }
        // files the previous version had and this one doesn't (only ours: the old manifest lists them)
        foreach (var f in oldFiles.Except(newFiles, StringComparer.OrdinalIgnoreCase)) TryDelete(Path.Combine(dir, f));
        File.WriteAllLines(Path.Combine(dir, Manifest), newFiles);
        using (var src = File.OpenRead(Self)) using (var dst = File.Create(Path.Combine(dir, Uninstaller))) Copy(src, dst, payload.ZipOffset);

        progress(91, "stLinks");
        var exe = Path.Combine(dir, AppExe);
        Shortcut(StartMenuLink, exe, dir);
        if (desktop) Shortcut(DesktopLink, exe, dir);
        else if (File.Exists(DesktopLink) && Mode == "update") Shortcut(DesktopLink, exe, dir);

        progress(96, "stReg");
        using (var k = Registry.CurrentUser.CreateSubKey(UninstKey))
        {
            k.SetValue("DisplayName", "ReChest");
            k.SetValue("DisplayVersion", Version);
            k.SetValue("Publisher", "ReChest");
            k.SetValue("DisplayIcon", exe + ",0");
            k.SetValue("InstallLocation", dir);
            k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            k.SetValue("UninstallString", $"\"{Path.Combine(dir, Uninstaller)}\" --uninstall");
            k.SetValue("QuietUninstallString", $"\"{Path.Combine(dir, Uninstaller)}\" --uninstall --silent");
            k.SetValue("URLInfoAbout", "https://github.com/Reanexx/ReChest");
            k.SetValue("EstimatedSize", (int)(DirSize(dir) / 1024), RegistryValueKind.DWord);
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
        if (startup is bool on) SetStartup(exe, on);
        else if (Registry.CurrentUser.OpenSubKey(RunKey)?.GetValue(RunName) is string run && IsUnder(run.Trim('"').Split('"')[0], dir))
            SetStartup(exe, true); // already starting with Windows from here: keep the entry current
        progress(100, "stDone");
    }

    /// "Start with Windows": the app's own Run entry (Background.SetAutostart) and its setting, so the app keeps it.
    static void SetStartup(string exe, bool on)
    {
        using (var k = Registry.CurrentUser.CreateSubKey(RunKey))
        {
            if (on) k.SetValue(RunName, $"\"{exe}\" --background");
            else if (k.GetValue(RunName) != null) k.DeleteValue(RunName);
        }
        var file = Path.Combine(DataDir, "settings.json");
        var v = on ? "true" : "false";
        var json = File.Exists(file) ? File.ReadAllText(file) : "{}";
        var re = new Regex(@"""StartWithWindows""\s*:\s*(true|false)");
        json = re.IsMatch(json) ? re.Replace(json, $"\"StartWithWindows\":{v}") : Regex.Replace(json, @"^\s*\{\s*", m => json.Trim() == "{}" ? $"{{\"StartWithWindows\":{v}" : $"{{\"StartWithWindows\":{v},");
        Directory.CreateDirectory(DataDir);
        File.WriteAllText(file, json);
    }

    // ---- uninstall --------------------------------------------------------------------------------------------

    public static void Uninstall(string dir, bool wipeData, Action<double, string> progress)
    {
        progress(2, "stWait");
        CloseApp(dir, TimeSpan.FromSeconds(5));
        progress(10, "stRemove");
        var files = ReadManifest(dir);
        for (var i = 0; i < files.Count; i++) { TryDelete(Path.Combine(dir, files[i])); progress(10 + 70.0 * (i + 1) / Math.Max(1, files.Count), null); }
        TryDelete(Path.Combine(dir, Manifest));
        TryDelete(Path.Combine(dir, Uninstaller));
        DeleteEmptyDirs(dir); // a folder the user also keeps other things in stays, minus our files

        progress(85, "stLinks");
        foreach (var l in new[] { StartMenuLink, DesktopLink }) TryDelete(l);
        progress(90, "stReg");
        using (var k = Registry.CurrentUser.OpenSubKey(RunKey, true))
            if (k?.GetValue(RunName) is string run && IsUnder(run.Trim('"').Split('"')[0], dir)) k.DeleteValue(RunName); // only our own entry
        Registry.CurrentUser.DeleteSubKeyTree(UninstKey, false);
        if (wipeData && Directory.Exists(DataDir)) { progress(95, "stRemove"); Retry(() => Directory.Delete(DataDir, true)); }
        progress(100, "stDone");
    }

    // ---- helpers ----------------------------------------------------------------------------------------------

    public static string InstalledDir() => Registry.CurrentUser.OpenSubKey(UninstKey)?.GetValue("InstallLocation") as string;
    public static string InstalledVersion() => Registry.CurrentUser.OpenSubKey(UninstKey)?.GetValue("DisplayVersion") as string;
    public static bool StartupOn() => Registry.CurrentUser.OpenSubKey(RunKey)?.GetValue(RunName) != null;

    public static void Launch(string dir)
    {
        var exe = Path.Combine(dir, AppExe);
        if (File.Exists(exe)) Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = dir });
    }

    /// Waits for ReChest copies running from dir to quit (an updating app is closing itself), then ends them.
    static void CloseApp(string dir, TimeSpan wait)
    {
        var until = DateTime.UtcNow + wait;
        while (true)
        {
            var mine = Process.GetProcessesByName(Path.GetFileNameWithoutExtension(AppExe)).Where(p =>
            {
                try { return IsUnder(p.MainModule.FileName, dir); } catch { return false; }
            }).ToList();
            if (mine.Count == 0) return;
            if (DateTime.UtcNow > until)
            {
                foreach (var p in mine) try { p.Kill(); p.WaitForExit(5000); } catch { /* already gone */ }
                return;
            }
            Thread.Sleep(300);
        }
    }

    static bool IsUnder(string path, string dir)
    {
        try { return Path.GetFullPath(path).StartsWith(Path.GetFullPath(dir).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }

    static List<string> ReadManifest(string dir)
    {
        var f = Path.Combine(dir, Manifest);
        return File.Exists(f) ? File.ReadAllLines(f).Where(l => l.Length > 0 && !l.Contains("..") && !Path.IsPathRooted(l)).ToList() : new List<string>();
    }

    static void Shortcut(string link, string target, string dir)
    {
        var shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        try
        {
            dynamic s = ((dynamic)shell).CreateShortcut(link);
            s.TargetPath = target;
            s.WorkingDirectory = dir;
            s.IconLocation = target + ",0";
            s.Description = "ReChest";
            s.Save();
        }
        finally { Marshal.FinalReleaseComObject(shell); }
    }

    static void Retry(Action a)
    {
        for (var i = 0; ; i++)
            try { a(); return; }
            catch (Exception e) when ((e is IOException or UnauthorizedAccessException) && i < 20) { Thread.Sleep(250); }
    }

    static void TryDelete(string f) { try { if (File.Exists(f)) Retry(() => File.Delete(f)); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { } }

    static void DeleteEmptyDirs(string dir)
    {
        if (!Directory.Exists(dir)) return;
        foreach (var d in Directory.GetDirectories(dir)) DeleteEmptyDirs(d);
        try { if (!Directory.EnumerateFileSystemEntries(dir).Any()) Directory.Delete(dir); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    static long DirSize(string dir) => Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length);

    static void Copy(Stream src, Stream dst, long count)
    {
        var buf = new byte[1 << 16];
        while (count > 0)
        {
            var n = src.Read(buf, 0, (int)Math.Min(buf.Length, count));
            if (n <= 0) break;
            dst.Write(buf, 0, n);
            count -= n;
        }
    }

    /// The uninstaller copy in %TEMP% removes itself a moment after it exits.
    static void DeleteSelfLater()
    {
        if (!Self.StartsWith(Path.GetTempPath(), StringComparison.OrdinalIgnoreCase)) return;
        Process.Start(new ProcessStartInfo("cmd.exe", $"/c ping 127.0.0.1 -n 3 > nul & del /f /q \"{Self}\"") { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
    }

    public static void Log(Exception e)
    {
        try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "ReChestSetup.log"), $"{DateTime.Now:s} {Mode} {e}\r\n"); } catch { /* nowhere to log */ }
    }

    public static long PayloadSize()
    {
        var p = Payload.Find();
        if (p == null) return 0;
        using var fs = File.OpenRead(Self);
        using var zip = new ZipArchive(new Slice(fs, p.ZipOffset, p.ZipLength), ZipArchiveMode.Read);
        return zip.Entries.Sum(e => e.Length);
    }
}

/// The app rides at the end of the exe: [installer exe][payload.zip][zip length: 8 bytes][magic "RCPAYLD1"].
sealed class Payload
{
    public long ZipOffset, ZipLength;
    static readonly byte[] Magic = Encoding.ASCII.GetBytes("RCPAYLD1");

    public static Payload Find()
    {
        using var fs = File.OpenRead(Setup.Self);
        if (fs.Length < 16) return null;
        var tail = new byte[16];
        fs.Seek(-16, SeekOrigin.End);
        fs.Read(tail, 0, 16);
        if (!tail.Skip(8).SequenceEqual(Magic)) return null;
        var len = BitConverter.ToInt64(tail, 0);
        return len > 0 && len < fs.Length - 16 ? new Payload { ZipLength = len, ZipOffset = fs.Length - 16 - len } : null;
    }
}

/// A read-only window onto part of a stream (the zip inside the exe).
sealed class Slice : Stream
{
    readonly Stream s;
    readonly long start, length;
    long pos;
    public Slice(Stream s, long start, long length) { (this.s, this.start, this.length) = (s, start, length); }
    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length => length;
    public override long Position { get => pos; set => pos = value; }
    public override int Read(byte[] buffer, int offset, int count)
    {
        count = (int)Math.Min(count, length - pos);
        if (count <= 0) return 0;
        s.Position = start + pos;
        var n = s.Read(buffer, offset, count);
        pos += n;
        return n;
    }
    public override long Seek(long offset, SeekOrigin origin) => pos = origin switch { SeekOrigin.Begin => offset, SeekOrigin.Current => pos + offset, _ => length + offset };
    public override void Flush() { }
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}

/// The wizard window: chrome-less, setup.html in WebView2, talking JSON both ways.
sealed class SetupWindow : Window
{
    readonly Microsoft.Web.WebView2.Wpf.WebView2 web = new();
    readonly JavaScriptSerializer json = new();
    bool busy;

    public SetupWindow()
    {
        Title = Setup.Mode == "uninstall" ? "Uninstall ReChest" : "ReChest Setup";
        (Width, Height) = (860, 540);
        ResizeMode = ResizeMode.CanMinimize;
        WindowStyle = WindowStyle.None; // no hidden frame under the page (a fixed-size frame would clip its bottom)
        Background = new SolidColorBrush(Color.FromRgb(8, 8, 11)); // the app's black theme
        using (var ico = typeof(Setup).Assembly.GetManifestResourceStream("app.ico")) Icon = System.Windows.Media.Imaging.BitmapFrame.Create(ico, System.Windows.Media.Imaging.BitmapCreateOptions.None, System.Windows.Media.Imaging.BitmapCacheOption.OnLoad);
        // test hook: RECHEST_SETUP_AT=x,y puts the window there instead of the screen centre
        var at = Environment.GetEnvironmentVariable("RECHEST_SETUP_AT")?.Split(',');
        if (at?.Length == 2 && double.TryParse(at[0], out var x) && double.TryParse(at[1], out var y)) { WindowStartupLocation = WindowStartupLocation.Manual; (Left, Top) = (x, y); ShowActivated = false; Topmost = true; }
        else WindowStartupLocation = WindowStartupLocation.CenterScreen;
        System.Windows.Shell.WindowChrome.SetWindowChrome(this, new System.Windows.Shell.WindowChrome
        {
            CaptionHeight = 0, GlassFrameThickness = new Thickness(0), ResizeBorderThickness = new Thickness(0), CornerRadius = new CornerRadius(0), UseAeroCaptionButtons = false,
        });
        SourceInitialized += (_, _) =>
        {
            var h = new WindowInteropHelper(this).Handle;
            int round = 2, dark = 1;
            DwmSetWindowAttribute(h, 33, ref round, 4); // Windows 11 rounded corners
            DwmSetWindowAttribute(h, 20, ref dark, 4);
        };
        web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(8, 8, 11);
        Content = web;
        Loaded += async (_, _) => await Init();
        Closing += (_, e) => e.Cancel = busy; // never stop halfway through copying files
    }

    async Task Init()
    {
        var tmp = Path.Combine(Path.GetTempPath(), "ReChestSetup");
        Directory.CreateDirectory(tmp);
        using (var s = typeof(Setup).Assembly.GetManifestResourceStream("WebView2Loader.dll"))
        {
            var loader = Path.Combine(tmp, "WebView2Loader.dll");
            try { using var f = File.Create(loader); s.CopyTo(f); } catch (IOException) { } // another copy of setup has it open: same file
        }
        Microsoft.Web.WebView2.Core.CoreWebView2Environment.SetLoaderDllFolderPath(tmp);
        try
        {
            var env = await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, Path.Combine(tmp, "WebView2"));
            await web.EnsureCoreWebView2Async(env);
        }
        catch (Exception e)
        {
            Setup.Log(e);
            MessageBox.Show(this, "ReChest needs the Microsoft Edge WebView2 Runtime.\nGet it from https://developer.microsoft.com/microsoft-edge/webview2", "ReChest Setup");
            Close();
            return;
        }
        var cw = web.CoreWebView2;
        cw.Settings.AreDefaultContextMenusEnabled = false;
        cw.Settings.IsZoomControlEnabled = false;
        cw.Settings.AreBrowserAcceleratorKeysEnabled = false;
        cw.NewWindowRequested += (_, e) => e.Handled = true;
        cw.WebMessageReceived += (_, e) => OnMessage(json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson));
        using var r = new StreamReader(typeof(Setup).Assembly.GetManifestResourceStream("setup.html"), Encoding.UTF8);
        cw.NavigateToString(r.ReadToEnd());
    }

    void Post(object o) => Dispatcher.BeginInvoke(new Action(() => web.CoreWebView2?.PostWebMessageAsJson(json.Serialize(o))));

    void OnMessage(Dictionary<string, object> m)
    {
        string S(string k) => m.TryGetValue(k, out var v) ? v as string : null;
        bool B(string k) => m.TryGetValue(k, out var v) && v is bool b && b;
        switch (S("type"))
        {
            case "ready":
                Post(new
                {
                    type = "init", mode = Setup.Mode, version = Setup.Version, dir = Setup.Dir,
                    installed = Setup.InstalledVersion(), sizeMb = Setup.PayloadSize() / 1048576, freeMb = FreeMb(Setup.Dir),
                    startup = Setup.InstalledVersion() == null || Setup.StartupOn(),
                });
                break;
            case "browse":
                using (var d = new System.Windows.Forms.FolderBrowserDialog { Description = "ReChest", SelectedPath = Directory.Exists(S("dir")) ? S("dir") : Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), ShowNewFolderButton = true })
                    if (d.ShowDialog() == System.Windows.Forms.DialogResult.OK)
                    {
                        var dir = d.SelectedPath.TrimEnd('\\');
                        if (!Path.GetFileName(dir).Equals("ReChest", StringComparison.OrdinalIgnoreCase)) dir = Path.Combine(dir, "ReChest"); // its own folder inside the one picked
                        Post(new { type = "dir", dir, freeMb = FreeMb(dir) });
                    }
                break;
            case "checkDir":
                var want = S("dir");
                Post(Writable(want) ? new { type = "dirOk", dir = Path.GetFullPath(want).TrimEnd('\\') } : (object)new { type = "dirBad" });
                break;
            case "install":
                Run(() => Setup.Install(Setup.Dir = S("dir"), B("desktop"), Setup.Mode == "update" ? null : B("startup"), Progress), then: () =>
                {
                    if (Setup.Mode != "update") return;
                    Setup.Launch(Setup.Dir); // the updated app starts by itself, then this window goes
                    Task.Delay(1600).ContinueWith(_ => Dispatcher.BeginInvoke(new Action(Close)));
                });
                break;
            case "uninstall":
                Run(() => Setup.Uninstall(Setup.Dir, B("wipe"), Progress));
                break;
            case "finish":
                if (B("launch")) Setup.Launch(Setup.Dir);
                Close();
                break;
            case "min": WindowState = WindowState.Minimized; break;
            case "close": if (!busy) Close(); break;
            case "drag":
                ReleaseCapture();
                SendMessage(new WindowInteropHelper(this).Handle, 0xA1, (IntPtr)2, IntPtr.Zero); // WM_NCLBUTTONDOWN, HTCAPTION
                break;
        }
    }

    void Progress(double pct, string status) => Post(new { type = "progress", pct = Math.Round(pct, 1), status });

    void Run(Action work, Action then = null)
    {
        busy = true;
        Task.Run(work).ContinueWith(t => Dispatcher.BeginInvoke(new Action(() =>
        {
            busy = false;
            if (t.Exception is { } ex) { Setup.Log(ex); Post(new { type = "error", text = ex.InnerException?.Message ?? ex.Message }); return; }
            Post(new { type = "done" });
            then?.Invoke();
        })));
    }

    static bool Writable(string dir)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(dir) || !Path.IsPathRooted(dir)) return false;
            Directory.CreateDirectory(dir);
            var probe = Path.Combine(dir, ".rechest-write-test");
            File.WriteAllText(probe, "");
            File.Delete(probe);
            return true;
        }
        catch { return false; }
    }

    static long FreeMb(string dir)
    {
        try { return new DriveInfo(Path.GetPathRoot(Path.GetFullPath(dir))).AvailableFreeSpace / 1048576; } catch { return 0; }
    }

    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wp, IntPtr lp);
}
