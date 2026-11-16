using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace ChestCounter;

/// The window revealed by pressing "." three times quickly: send a broadcast, and turn receiving on/off.
/// A hand-painted dark dialog so it matches the app instead of looking like a raw WinForms form.
public sealed class BroadcastWindow : Form
{
    static readonly Color Bg = Color.FromArgb(0x15, 0x16, 0x1A), Card = Color.FromArgb(0x1F, 0x21, 0x28),
        Accent = Color.FromArgb(0x1F, 0x6F, 0xFF), Green = Color.FromArgb(0x2F, 0xD3, 0x6E), Muted = Color.FromArgb(0x8A, 0x8F, 0x9A);

    public BroadcastWindow(AppSettings settings, Action save)
    {
        Text = "ReChest Yayın";
        ClientSize = new Size(384, 300);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Bg;
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 9.5f);
        TopMost = true;

        var logo = new Panel { Bounds = new Rectangle(28, 26, 48, 48), BackColor = Bg };
        logo.Paint += (_, e) =>
        {
            var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            using var br = new LinearGradientBrush(logo.ClientRectangle, Color.FromArgb(0xF2, 0xB0, 0x21), Color.FromArgb(0xFF, 0x7A, 0x1E), 55f);
            using (var tile = Round(new Rectangle(0, 0, 48, 48), 13)) g.FillPath(br, tile);
            using var pen = new Pen(Color.White, 3.4f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            g.DrawEllipse(pen, 12, 13, 15, 15);
            g.DrawLine(pen, 23, 24, 38, 39);       // shaft
            g.DrawLine(pen, 31, 32, 36, 27);       // tooth
            g.DrawLine(pen, 35, 36, 40, 31);       // tooth
        };

        var title = new Label { Text = "Yayın", Font = new Font("Segoe UI", 15f, FontStyle.Bold), AutoSize = true, Location = new Point(88, 30) };
        var sub = new Label { Text = "Bu videoyu o an Fortnite'ta olan\nherkesin ekranında oynat.", ForeColor = Muted, AutoSize = true, Location = new Point(88, 57) };

        var send = new Button
        {
            Text = "Herkese Gönder", Bounds = new Rectangle(28, 106, 328, 52),
            FlatStyle = FlatStyle.Flat, BackColor = Accent, ForeColor = Color.White,
            Font = new Font("Segoe UI", 11f, FontStyle.Bold), Cursor = Cursors.Hand,
        };
        send.FlatAppearance.BorderSize = 0;
        send.Region = new Region(Round(new Rectangle(0, 0, 328, 52), 14));
        send.Click += (_, _) => { Broadcast.Send(); send.Text = "Gönderildi ✓"; send.BackColor = Green; };

        var recvCard = new Panel { Bounds = new Rectangle(28, 178, 328, 54), BackColor = Card };
        recvCard.Region = new Region(Round(new Rectangle(0, 0, 328, 54), 12));
        var recvLabel = new Label { Text = "Başkalarının yayınlarını al", AutoSize = true, Location = new Point(16, 19) };
        var toggle = new Panel { Bounds = new Rectangle(272, 15, 42, 24), Cursor = Cursors.Hand, BackColor = Card };
        toggle.Paint += (_, e) =>
        {
            var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            bool on = settings.ReceiveBroadcasts;
            using (var br = new SolidBrush(on ? Accent : Color.FromArgb(0x3A, 0x3D, 0x45)))
            using (var pill = Round(new Rectangle(0, 0, 42, 24), 12)) g.FillPath(br, pill);
            g.FillEllipse(Brushes.White, on ? 21 : 3, 3, 18, 18);
        };
        toggle.Click += (_, _) => { settings.ReceiveBroadcasts = !settings.ReceiveBroadcasts; save(); toggle.Invalidate(); };
        recvCard.Controls.Add(recvLabel);
        recvCard.Controls.Add(toggle);

        var note = new Label { Text = "Sinyal yalnızca “oynat” der — video gönderilmez.", ForeColor = Color.FromArgb(0x6C, 0x6C, 0x72), AutoSize = true, Location = new Point(28, 246), Font = new Font("Segoe UI", 8.5f) };

        Controls.AddRange([logo, title, sub, send, recvCard, note]);
        Load += (_, _) => { int dark = 1; DwmSetWindowAttribute(Handle, 20 /* immersive dark title bar */, ref dark, 4); };
    }

    static GraphicsPath Round(Rectangle r, int rad)
    {
        var p = new GraphicsPath();
        int d = rad * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int v, int size);
}
