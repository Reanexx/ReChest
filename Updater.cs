using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;

namespace ChestCounter;

/// Updates through GitHub Releases: an anonymous look at the latest release at start and every 6 hours
/// (one small request, silent when offline), and on "Update now" the release's installer is downloaded and run
/// in update mode (it waits for this app to close, installs over it and starts it again).
public static class Updater
{
    public const string Repo = "Reanexx/ReChest";
    /// The app's version, from ChestCounter.csproj &lt;Version&gt;. RECHEST_VERSION overrides it (testing the prompt).
    public static readonly string Version = Environment.GetEnvironmentVariable("RECHEST_VERSION")
        ?? Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0] ?? "0.0.0";

    public sealed record Release(string Version, string Name, string Notes, string Url, long Size);
    /// The newer release, once one is found (null: up to date or not checked yet).
    public static Release Latest { get; private set; }
    public static event Action Found;

    static readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(20) };
    static Timer timer;

    public static void Start()
    {
        http.DefaultRequestHeaders.UserAgent.ParseAdd($"ReChest/{Version}"); // GitHub's API refuses requests without one
        timer = new Timer(_ => _ = Check(), null, TimeSpan.FromSeconds(15), TimeSpan.FromHours(6));
    }

    static async Task Check()
    {
        try
        {
            using var doc = JsonDocument.Parse(await http.GetStringAsync($"https://api.github.com/repos/{Repo}/releases/latest"));
            var r = doc.RootElement;
            var tag = r.GetProperty("tag_name").GetString() ?? "";
            if (!IsNewer(tag, Version)) return;
            foreach (var a in r.GetProperty("assets").EnumerateArray())
            {
                var name = a.GetProperty("name").GetString() ?? "";
                if (!name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) continue;
                Latest = new(tag.TrimStart('v', 'V'), r.GetProperty("name").GetString() ?? tag, r.GetProperty("body").GetString() ?? "",
                    a.GetProperty("browser_download_url").GetString(), a.GetProperty("size").GetInt64());
                Found?.Invoke();
                return;
            }
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException or KeyNotFoundException or InvalidOperationException) { } // offline, rate-limited or no release yet
    }

    public static bool IsNewer(string tag, string current) =>
        System.Version.TryParse(tag.TrimStart('v', 'V'), out var a) && System.Version.TryParse(current, out var b) && a > b;

    /// Downloads the installer (progress 0-100) and starts it in update mode. True when it started; the caller quits.
    public static async Task<bool> Install(Action<int> progress)
    {
        if (Latest is not { } rel) return false;
        var file = Path.Combine(Path.GetTempPath(), $"ReChestSetup-{rel.Version}.exe");
        try
        {
            using (var res = await http.GetAsync(rel.Url, HttpCompletionOption.ResponseHeadersRead))
            {
                res.EnsureSuccessStatusCode();
                var total = res.Content.Headers.ContentLength ?? rel.Size;
                await using var src = await res.Content.ReadAsStreamAsync();
                await using var dst = File.Create(file);
                var buf = new byte[81920];
                long done = 0;
                int n, last = -1;
                while ((n = await src.ReadAsync(buf)) > 0)
                {
                    await dst.WriteAsync(buf.AsMemory(0, n));
                    done += n;
                    var pct = total > 0 ? (int)(done * 100 / total) : 0;
                    if (pct != last) progress(last = pct);
                }
            }
            Process.Start(new ProcessStartInfo(file, "--update") { UseShellExecute = true }); // installs where setup put ReChest (its registry entry)
            return true;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    public static void SelfTest()
    {
        if (!IsNewer("v2.0.1", "2.0.0") || !IsNewer("2.1", "2.0.0") || IsNewer("v2.0.0", "2.0.0") || IsNewer("v1.9.9", "2.0.0") || IsNewer("beta", "2.0.0"))
            throw new Exception("Updater.IsNewer");
    }
}
