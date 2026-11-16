using System.Runtime.InteropServices;
using System.Windows.Interop;

namespace ChestCounter;

/// Background keyboard/mouse listener using Windows Raw Input (RIDEV_INPUTSINK), the same mechanism hotkey and
/// push-to-talk apps use: it only receives input events, it does not hook or touch the game.
public sealed class InputWatcher
{
    public event Action<bool> Pressed; // true = attack click, false = interact
    public event Action<int> Hotkey;   // +1 / -1: manual correction of the live count
    public event Action RouteToggle;   // the route key: show or hide the route over the game
    public event Action RouteSize;     // the route size key: bigger or normal route card
    public event Action RouteFull;     // the full-screen map key: open or close the map over the game
    public event Action RouteHere;     // the route-here key: a new route from where you stand
    public event Action PointerToggle; // the chests-in-view key: marks on screen on/off
    public event Action TriplePeriod;   // "." pressed three times within 800 ms: opens the broadcast window
    DateTime lastPeriod;
    int periodRun;

    long travel;
    /// Raw mouse movement so far, in device counts (|dx| + |dy|): tells when the camera turned.
    public long Travel => Interlocked.Read(ref travel);

    /// One flick of the wheel sends several notches; notches closer together than this are one press.
    public static readonly TimeSpan WheelGap = TimeSpan.FromMilliseconds(350);

    List<Binding> binds = [], attack = [];
    public int AddKey = 0x77, RemoveKey = 0x78, RouteKey = 0x76, RouteBigKey = 0x75, RouteFullKey = 0x74, RouteHereKey = 0x73, PointerKey = 0x72; // F8, F9, F7, F6, F5, F4, F3 (virtual-key codes, set from the app settings)
    readonly HashSet<int> held = [];
    DateTime lastWheel;
    HwndSource sink;

    public void SetKeys(IEnumerable<string> interact, IEnumerable<string> attackKeys)
    {
        binds = interact.Select(Binding.From).OfType<Binding>().ToList();
        attack = attackKeys.Select(Binding.From).OfType<Binding>().ToList();
    }

    public void Start()
    {
        // message-only window (parent HWND_MESSAGE) to receive WM_INPUT
        sink = new HwndSource(new HwndSourceParameters("ReChest input") { ParentWindow = new IntPtr(-3), WindowStyle = 0 });
        sink.AddHook(Hook);
        var devices = new[]
        {
            new RAWINPUTDEVICE { UsagePage = 1, Usage = 6, Flags = RIDEV_INPUTSINK, Target = sink.Handle }, // keyboard
            new RAWINPUTDEVICE { UsagePage = 1, Usage = 2, Flags = RIDEV_INPUTSINK, Target = sink.Handle }, // mouse
        };
        RegisterRawInputDevices(devices, (uint)devices.Length, (uint)Marshal.SizeOf<RAWINPUTDEVICE>());
    }

    /// Pure wheel-burst rule, kept separate so it can be tested.
    internal static bool NewWheelPress(DateTime last, DateTime now) => now - last > WheelGap;

    IntPtr Hook(IntPtr hwnd, int msg, IntPtr w, IntPtr l, ref bool handled)
    {
        if (msg != WM_INPUT) return IntPtr.Zero;
        uint size = 0;
        var header = (uint)(8 + 2 * IntPtr.Size);
        GetRawInputData(l, RID_INPUT, IntPtr.Zero, ref size, header);
        if (size == 0 || size > 256) return IntPtr.Zero;
        var buf = Marshal.AllocHGlobal((int)size);
        try
        {
            if (GetRawInputData(l, RID_INPUT, buf, ref size, header) != size) return IntPtr.Zero;
            var type = Marshal.ReadInt32(buf);
            var o = (int)header;
            if (type == RIM_TYPEKEYBOARD)
            {
                var flags = (ushort)Marshal.ReadInt16(buf, o + 2);
                var vk = (ushort)Marshal.ReadInt16(buf, o + 6);
                if ((flags & 1) != 0) { held.Remove(vk); return IntPtr.Zero; } // RI_KEY_BREAK: key up
                if (!held.Add(vk)) return IntPtr.Zero; // auto-repeat while held
                if (vk == AddKey) Hotkey?.Invoke(1);
                else if (vk == RemoveKey) Hotkey?.Invoke(-1);
                else if (vk == RouteKey) RouteToggle?.Invoke();
                else if (vk == RouteBigKey) RouteSize?.Invoke();
                else if (vk == RouteFullKey) RouteFull?.Invoke();
                else if (vk == RouteHereKey) RouteHere?.Invoke();
                else if (vk == PointerKey) PointerToggle?.Invoke();
                else if ((MapVirtualKey(vk, 2 /* MAPVK_VK_TO_CHAR */) & 0xFFFF) == '.') // "." sits on different keys per layout (US vs Turkish Q)
                {
                    var now = DateTime.UtcNow;
                    periodRun = now - lastPeriod < TimeSpan.FromMilliseconds(800) ? periodRun + 1 : 1;
                    lastPeriod = now;
                    if (periodRun >= 3) { periodRun = 0; TriplePeriod?.Invoke(); }
                }
                else if (binds.Any(b => b.Vk == vk)) Pressed?.Invoke(false);
                else if (attack.Any(b => b.Vk == vk)) Pressed?.Invoke(true);
            }
            else if (type == RIM_TYPEMOUSE)
            {
                var buttons = (ushort)Marshal.ReadInt16(buf, o + 4);
                var data = Marshal.ReadInt16(buf, o + 6);
                if ((Marshal.ReadInt16(buf, o) & 1) == 0) // relative movement (not MOUSE_MOVE_ABSOLUTE)
                    Interlocked.Add(ref travel, Math.Abs(Marshal.ReadInt32(buf, o + 12)) + Math.Abs(Marshal.ReadInt32(buf, o + 16)));
                if ((buttons & RI_MOUSE_WHEEL) != 0 && data != 0)
                {
                    var now = DateTime.UtcNow;
                    var fresh = NewWheelPress(lastWheel, now);
                    lastWheel = now;
                    if (fresh && binds.Any(b => b.Wheel != 0 && Math.Sign(data) == b.Wheel)) Pressed?.Invoke(false);
                }
                if (binds.Any(b => b.MouseFlag != 0 && (buttons & b.MouseFlag) != 0)) Pressed?.Invoke(false);
                else if (attack.Any(b => b.MouseFlag != 0 && (buttons & b.MouseFlag) != 0)) Pressed?.Invoke(true);
            }
        }
        finally { Marshal.FreeHGlobal(buf); }
        return IntPtr.Zero;
    }

    const int WM_INPUT = 0x00FF, RIM_TYPEMOUSE = 0, RIM_TYPEKEYBOARD = 1;
    const uint RID_INPUT = 0x10000003, RIDEV_INPUTSINK = 0x100;
    const ushort RI_MOUSE_WHEEL = 0x0400;

    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTDEVICE { public ushort UsagePage, Usage; public uint Flags; public IntPtr Target; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);
    [DllImport("user32.dll")]
    static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")]
    static extern uint GetRawInputData(IntPtr input, uint command, IntPtr data, ref uint size, uint headerSize);
}
