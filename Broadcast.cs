using System.IO;
using System.Net.Http;
using System.Text.Json;

namespace ChestCounter;

/// Internet broadcast over ntfy.sh (free, no account). The signal is only "play"; every app plays its own bundled
/// video, so this channel can't push arbitrary or harmful content - the worst it does is start the video everyone
/// already has. Receiving is opt-out per machine (AppSettings.ReceiveBroadcasts).
public static class Broadcast
{
    // Shared by every copy of the app. Random so outsiders can't guess the topic and trigger it.
    const string Url = "https://ntfy.sh/rechest-bcast-7h3Qk9mZ2vXp4Lr";
    static readonly HttpClient http = new() { Timeout = Timeout.InfiniteTimeSpan }; // the subscribe stream is long-lived

    /// POST a play signal to everyone listening. Fire-and-forget; silent if offline.
    public static async void Send()
    {
        try { await http.PostAsync(Url, new StringContent("play")); }
        catch { }
    }

    /// Times of the broadcasts ntfy still has cached (about the last 12 hours), newest first; empty when offline.
    public static async Task<List<DateTime>> History()
    {
        var times = new List<DateTime>();
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            var text = await http.GetStringAsync(Url + "/json?poll=1&since=all", cts.Token);
            foreach (var line in text.Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    var r = doc.RootElement;
                    if (r.TryGetProperty("event", out var ev) && ev.GetString() == "message" && r.TryGetProperty("time", out var t))
                        times.Add(DateTimeOffset.FromUnixTimeSeconds(t.GetInt64()).UtcDateTime);
                }
                catch (JsonException) { }
            }
        }
        catch { } // offline or ntfy down: no history
        return times.OrderByDescending(t => t).ToList();
    }

    /// Subscribe to the topic and call onPlay for each broadcast. Runs forever, reconnecting on drop.
    public static void Listen(Action onPlay)
    {
        _ = Task.Run(async () =>
        {
            while (true)
            {
                try
                {
                    using var stream = await http.GetStreamAsync(Url + "/json"); // newline-delimited JSON, one event per line
                    using var reader = new StreamReader(stream);
                    string line;
                    while ((line = await reader.ReadLineAsync()) != null)
                    {
                        if (line.Length == 0) continue;
                        try
                        {
                            using var doc = JsonDocument.Parse(line);
                            // ntfy also streams "open"/"keepalive"; only "message" is a real broadcast
                            if (doc.RootElement.TryGetProperty("event", out var ev) && ev.GetString() == "message") onPlay();
                        }
                        catch (JsonException) { }
                    }
                }
                catch { }
                await Task.Delay(5000); // connection dropped: wait, then resubscribe
            }
        });
    }
}
