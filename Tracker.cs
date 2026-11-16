using System.IO;
using System.Windows.Threading;

namespace ChestCounter;

/// Watches Fortnite's replay folder, keeps the match history, backs replays up, and tells the windows when it changes.
/// A file change triggers a re-scan within ~2 s, so a finished match shows up right after it ends.
public sealed class Tracker
{
    /// Fortnite deletes old UnsavedReplay files (it keeps about 100); every finished replay is copied here first.
    public static readonly string BackupDir = Path.Combine(Replays.Dir, "Yedek");

    public readonly List<Match> History = Replays.Load();
    public event Action Changed;

    readonly Dispatcher ui = Dispatcher.CurrentDispatcher;
    readonly DispatcherTimer poll = new() { Interval = TimeSpan.FromSeconds(15) }; // fallback, and notices "live" ending
    readonly DispatcherTimer debounce = new() { Interval = TimeSpan.FromSeconds(2) };
    readonly Dictionary<string, (long Size, DateTime At, int Tries)> failed = []; // file name -> size, time and count of failed parses
    FileSystemWatcher watcher;
    bool busy, again;

    public Match Latest => History.LastOrDefault();

    /// Start of the match being played right now (its replay is still recording), or null.
    public DateTime? LiveSince { get; private set; }

    /// Chests counted live during the running match (screen detection + manual hotkeys); the replay replaces them at
    /// the end of the match, since only it sees everything (teammates, chests broken from below).
    public readonly List<(string Type, DateTime AtUtc, bool Manual)> LiveOpens = [];

    public void AddLive(string type, bool manual = false)
    {
        if (LiveSince == null) return;
        LiveOpens.Add((type, DateTime.UtcNow, manual));
        Changed?.Invoke();
    }

    /// Hotkey correction: +1 adds a chest, -1 removes the last one.
    public void Adjust(int delta)
    {
        if (LiveSince == null) return;
        if (delta > 0) LiveOpens.Add(("chest", DateTime.UtcNow, true));
        else if (LiveOpens.Count > 0) LiveOpens.RemoveAt(LiveOpens.Count - 1);
        else return;
        Changed?.Invoke();
    }

    /// Only real chests count toward totals; ammo boxes, supply drops, llamas and barrels are kept apart.
    public static bool IsChest(string type) => type is "chest" or "faction";


    public (int Count, long Bytes) Backups
    {
        get
        {
            if (!Directory.Exists(BackupDir)) return (0, 0);
            var files = new DirectoryInfo(BackupDir).GetFiles("*.replay");
            return (files.Length, files.Sum(f => f.Length));
        }
    }

    public void Start()
    {
        poll.Tick += async (_, _) => await Scan();
        debounce.Tick += async (_, _) => { debounce.Stop(); await Scan(); };
        poll.Start();
        Watch();
        _ = Scan();
    }

    void Watch()
    {
        if (watcher != null || !Directory.Exists(Replays.Demos)) return;
        watcher = new FileSystemWatcher(Replays.Demos, "*.replay") { NotifyFilter = NotifyFilters.Size | NotifyFilters.LastWrite | NotifyFilters.FileName };
        FileSystemEventHandler kick = (_, _) => ui.BeginInvoke(() => { debounce.Stop(); debounce.Start(); });
        watcher.Changed += kick;
        watcher.Created += kick;
        watcher.Renamed += (s, e) => kick(s, e);
        watcher.EnableRaisingEvents = true;
    }

    async Task Scan()
    {
        if (busy) { again = true; return; }
        busy = true;
        try
        {
            Watch(); // the Demos folder may appear after the first replay is recorded
            var changed = false;
            DateTime? live = null;
            foreach (var f in Files())
            {
                var inDemos = f.DirectoryName == Path.GetFullPath(Replays.Demos);
                if (inDemos)
                {
                    var rec = (Live: false, StartUtc: default(DateTime), LengthMs: 0u);
                    try { rec = Replays.Recording(f.FullName); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { continue; } // being replaced right now
                    if (rec.Live)
                    {
                        // still recording: chest data is encrypted until the match ends. The folder listing's write time
                        // is stale while Fortnite holds the file open, so ask the file itself; a live header with
                        // Fortnite running is a match, an old one without it is a leftover from a crash.
                        f.Refresh();
                        var fresh = DateTime.UtcNow - f.LastWriteTimeUtc < TimeSpan.FromMinutes(3);
                        var recent = DateTime.UtcNow - rec.StartUtc < TimeSpan.FromMinutes(40); // no match lasts longer
                        if ((fresh || (recent && FortniteRunning())) && (live == null || rec.StartUtc > live)) live = rec.StartUtc;
                        continue;
                    }
                }
                var known = History.FirstOrDefault(m => m.File == f.Name);
                if (known != null && known.Size == f.Length && known.Parser >= Replays.ParserVersion)
                {
                    if (inDemos) Backup(f);
                    continue; // nothing new
                }
                // a replay that failed is retried when it changes, or after a minute (Fortnite may still have been
                // finishing it, and the folder listing does not show that while the file is open)
                // (at most twice: a replay that never parses must not be re-read every minute in the background)
                if (failed.TryGetValue(f.Name, out var fail) && fail.Size == f.Length && (fail.Tries >= 3 || DateTime.UtcNow - fail.At < TimeSpan.FromMinutes(1))) continue;

                Match m = null;
                try { m = await Task.Run(() => Replays.Parse(f.FullName)); } catch { } // unsupported/corrupt replay
                if (m == null) { failed[f.Name] = (f.Length, DateTime.UtcNow, fail.Size == f.Length ? fail.Tries + 1 : 1); continue; }
                failed.Remove(f.Name);
                History.RemoveAll(x => x.Id == m.Id || x.File == m.File);
                History.Add(m);
                History.Sort((a, b) => a.StartUtc.CompareTo(b.StartUtc));
                Replays.Save(History);
                if (inDemos) Backup(f);
                changed = true;
            }
            if (live != LiveSince) { LiveSince = live; LiveOpens.Clear(); changed = true; }
            if (changed) Changed?.Invoke();
        }
        finally { busy = false; }
        if (again) { again = false; await Scan(); }
    }

    static bool FortniteRunning()
    {
        var ps = System.Diagnostics.Process.GetProcessesByName("FortniteClient-Win64-Shipping");
        foreach (var p in ps) p.Dispose();
        return ps.Length > 0;
    }

    /// Replays in Demos, plus backed-up ones that Fortnite has already deleted (so a lost history can be rebuilt).
    static IEnumerable<FileInfo> Files()
    {
        var demos = Directory.Exists(Replays.Demos) ? new DirectoryInfo(Replays.Demos).GetFiles("*.replay") : [];
        var names = demos.Select(f => f.Name).ToHashSet();
        var backups = Directory.Exists(BackupDir) ? new DirectoryInfo(BackupDir).GetFiles("*.replay").Where(f => !names.Contains(f.Name)) : [];
        return demos.Concat(backups).OrderBy(f => f.LastWriteTimeUtc);
    }

    static void Backup(FileInfo f)
    {
        var dest = Path.Combine(BackupDir, f.Name);
        if (File.Exists(dest)) return;
        Directory.CreateDirectory(BackupDir);
        var tmp = dest + ".tmp";
        try
        {
            // Fortnite may still hold the file open, so share read/write instead of File.Copy's exclusive read
            using (var src = new FileStream(f.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var dst = File.Create(tmp)) src.CopyTo(dst);
            File.Move(tmp, dest);
            File.SetLastWriteTimeUtc(dest, f.LastWriteTimeUtc);
        }
        catch (IOException) { File.Delete(tmp); } // disk full or file vanished: retried on the next scan
    }
}
