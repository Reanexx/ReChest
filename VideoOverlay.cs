using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using WF = System.Windows.Forms;

namespace ChestCounter;

/// Plays a green-screen/black-background video over the game with the background keyed out: fullscreen on the given
/// monitor, always on top, click-through, never takes focus, closes itself when the video ends.
/// overlay/player.html does the keying on the GPU (see the notes there). A WinForms window because WPF's WebView2 host
/// can't be per-pixel transparent.
public sealed class VideoOverlay : WF.Form
{

    const string Origin = "https://overlay.local"; // page and video share this origin, so WebGL may read the video's pixels
    readonly Microsoft.Web.WebView2.WinForms.WebView2 wv = new() { Dock = WF.DockStyle.Fill, DefaultBackgroundColor = System.Drawing.Color.Transparent };

    public VideoOverlay(System.Drawing.Rectangle screen)
    {
        Text = "ReChest video";
        FormBorderStyle = WF.FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = WF.FormStartPosition.Manual;
        TopMost = true;
        BackColor = System.Drawing.Color.Black; // GDI black has alpha 0: transparent under blur-behind
        Bounds = screen;
        Controls.Add(wv);
        _ = InitAsync();
    }

    protected override WF.CreateParams CreateParams
    {
        get
        {
            var p = base.CreateParams;
            // layered + transparent = clicks fall through to the game; toolwindow/noactivate = no taskbar entry, no focus steal
            p.ExStyle |= 0x80000 /* LAYERED */ | 0x20 /* TRANSPARENT */ | 0x80 /* TOOLWINDOW */ | 0x08000000 /* NOACTIVATE */;
            return p;
        }
    }

    protected override bool ShowWithoutActivation => true;

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        SetLayeredWindowAttributes(Handle, 0, 255, 2 /* LWA_ALPHA */);
        // per-pixel alpha without any tint: blur-behind with an empty region (the GLFW/Tauri trick; no blur since Win8).
        // The accent-policy route tints the "transparent" area with the Windows accent colour.
        var bb = new BlurBehind { Flags = 1 | 2 /* DWM_BB_ENABLE | DWM_BB_BLURREGION */, Enable = true, Region = CreateRectRgn(0, 0, -1, -1) };
        DwmEnableBlurBehindWindow(Handle, ref bb);
    }

    async Task InitAsync()
    {
        try
        {
            // own data folder: the stats window's WebView2 runs with different browser arguments
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Replays.Dir, "WebView2Overlay"),
                new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required"));
            await wv.EnsureCoreWebView2Async(env);
        }
        catch (Exception) { Close(); return; } // no WebView2 runtime or closed early: nothing to show, and no dialog over the game
        var core = wv.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.AddWebResourceRequestedFilter(Origin + "/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (_, e) => e.Response = Serve(core.Environment, e.Request);
        core.NavigationCompleted += (_, e) => { if (!e.IsSuccess) Close(); };
        core.WebMessageReceived += OnMessage;
        core.Navigate(Origin + "/player.html");
    }

    // The fake origin has no server: answer the page and the video ourselves. Range support lets the video seek.
    CoreWebView2WebResourceResponse Serve(CoreWebView2Environment env, CoreWebView2WebResourceRequest req)
    {
        string p = new Uri(req.Uri).AbsolutePath;
        if (p == "/player.html")
            return env.CreateWebResourceResponse(new MemoryStream(File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "overlay", "player.html"))), 200, "OK",
                "Content-Type: text/html; charset=utf-8");
        if (p != "/video") return env.CreateWebResourceResponse(null, 404, "Not Found", "");

        var fs = typeof(VideoOverlay).Assembly.GetManifestResourceStream("overlay.mp4"); // overlay\1116.mp4, built into the exe
        long len = fs.Length, start = 0;
        string range = req.Headers.Contains("Range") ? req.Headers.GetHeader("Range") : null;
        if (range != null && range.StartsWith("bytes=")) long.TryParse(range[6..].Split('-')[0], out start);
        if (start >= len) { fs.Dispose(); return env.CreateWebResourceResponse(null, 416, "Range Not Satisfiable", $"Content-Range: bytes */{len}"); }
        fs.Position = start;
        string headers = $"Content-Type: video/mp4\r\nAccept-Ranges: bytes\r\nContent-Length: {len - start}";
        return range == null
            ? env.CreateWebResourceResponse(fs, 200, "OK", headers)
            : env.CreateWebResourceResponse(new OffsetStream(fs, start), 206, "Partial Content", headers + $"\r\nContent-Range: bytes {start}-{len - 1}/{len}");
    }

    // A range must look like its own stream starting at 0: WebView2 may rewind what it is given (it read from byte 0 and broke decoding).
    sealed class OffsetStream(Stream s, long off) : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;
        public override long Length => s.Length - off;
        public override long Position { get => s.Position - off; set => s.Position = value + off; }
        public override int Read(byte[] b, int o, int n) => s.Read(b, o, n);
        public override long Seek(long o, SeekOrigin from) => from switch
        {
            SeekOrigin.Begin => s.Seek(o + off, SeekOrigin.Begin),
            SeekOrigin.Current => s.Seek(o, SeekOrigin.Current),
            _ => s.Seek(o, SeekOrigin.End),
        } - off;
        public override void Flush() { }
        public override void SetLength(long v) => throw new NotSupportedException();
        public override void Write(byte[] b, int o, int n) => throw new NotSupportedException();
        protected override void Dispose(bool d) { if (d) s.Dispose(); base.Dispose(d); }
    }

    void OnMessage(object s, CoreWebView2WebMessageReceivedEventArgs e)
    {
        using var doc = JsonDocument.Parse(e.WebMessageAsJson);
        if (doc.RootElement.GetProperty("t").GetString() is "close" or "error") Close(); // video ended or can't play
    }

    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
    [DllImport("dwmapi.dll")] static extern int DwmEnableBlurBehindWindow(IntPtr h, ref BlurBehind b);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
    [StructLayout(LayoutKind.Sequential)] struct BlurBehind { public int Flags; public bool Enable; public IntPtr Region; public bool TransitionOnMaximized; }
}
