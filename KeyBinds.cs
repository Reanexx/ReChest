using System.IO;
using System.Text;

namespace ChestCounter;

/// Reads the player's key binds from Fortnite's local settings save (Enhanced Input key profile).
public static class KeyBinds
{
    public static readonly string SaveFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FortniteGame", "Saved", "Config", "ClientSettings.Sav");

    /// Unreal key names bound to Interact, e.g. ["MouseScrollDown", "O"]; Fortnite's default ["E"] when not remapped.
    public static List<string> Interact() => Read(["Interact"], "E");

    /// Keys that attack (a pickaxe swing breaks chests); the save only lists remapped actions, default is the left click.
    public static List<string> Attack() => Read(["Fire", "PrimaryFire", "Attack"], "LeftMouseButton");

    static List<string> Read(string[] actions, string fallback)
    {
        try
        {
            var bytes = File.ReadAllBytes(SaveFile);
            var keys = actions.SelectMany(a => Parse(bytes, a)).Distinct().ToList();
            if (keys.Count > 0) return keys;
        }
        catch (IOException) { } // no save yet: default bind
        catch (UnauthorizedAccessException) { }
        return [fallback];
    }

    /// In the profile, each mapping is a run of FStrings: mapping name ("Interact"), then the key name, then the device.
    internal static List<string> Parse(byte[] b, string action)
    {
        byte[] tag = [.. BitConverter.GetBytes(action.Length + 1), .. Encoding.ASCII.GetBytes(action + "\0")]; // FString: int32 length + text + NUL
        var found = new List<string>();
        for (var i = b.AsSpan().IndexOf(tag); i >= 0;)
        {
            var key = NextFString(b, i + tag.Length);
            if (key != null && Binding.Known(key) && !found.Contains(key)) found.Add(key);
            var next = b.AsSpan(i + 1).IndexOf(tag);
            i = next < 0 ? -1 : i + 1 + next;
        }
        return found;
    }

    static string NextFString(byte[] b, int from)
    {
        for (var o = from; o < Math.Min(b.Length - 5, from + 64); o++)
        {
            var len = BitConverter.ToInt32(b, o);
            if (len < 2 || len > 40 || o + 4 + len > b.Length || b[o + 4 + len - 1] != 0) continue;
            var s = b.AsSpan(o + 4, len - 1);
            if (s.ToArray().All(c => c is >= 0x20 and < 0x7F)) return Encoding.ASCII.GetString(s);
        }
        return null;
    }

    public static string Display(string key) => key switch
    {
        "MouseScrollDown" => "Mouse wheel down",
        "MouseScrollUp" => "Mouse wheel up",
        "LeftMouseButton" => "Left click",
        "RightMouseButton" => "Right click",
        "MiddleMouseButton" => "Middle click",
        "ThumbMouseButton" => "Mouse side button 1",
        "ThumbMouseButton2" => "Mouse side button 2",
        "SpaceBar" => "Space",
        _ => key,
    };
}

/// One bound input, matched against raw keyboard/mouse events.
public readonly record struct Binding(int Vk, ushort MouseFlag, int Wheel)
{
    public static bool Known(string name) => From(name) != null;

    public static Binding? From(string name) => name switch
    {
        "MouseScrollDown" => new Binding(0, 0, -1),
        "MouseScrollUp" => new Binding(0, 0, 1),
        "LeftMouseButton" => new Binding(0, 0x0001, 0),
        "RightMouseButton" => new Binding(0, 0x0004, 0),
        "MiddleMouseButton" => new Binding(0, 0x0010, 0),
        "ThumbMouseButton" => new Binding(0, 0x0040, 0),
        "ThumbMouseButton2" => new Binding(0, 0x0100, 0),
        "SpaceBar" => new Binding(0x20, 0, 0),
        "Tab" => new Binding(0x09, 0, 0),
        "Enter" => new Binding(0x0D, 0, 0),
        "CapsLock" => new Binding(0x14, 0, 0),
        "LeftShift" or "RightShift" => new Binding(0x10, 0, 0),
        "LeftControl" or "RightControl" => new Binding(0x11, 0, 0),
        "LeftAlt" or "RightAlt" => new Binding(0x12, 0, 0),
        "Zero" or "One" or "Two" or "Three" or "Four" or "Five" or "Six" or "Seven" or "Eight" or "Nine" =>
            new Binding(0x30 + Array.IndexOf(["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"], name), 0, 0),
        [var c] when c is >= 'A' and <= 'Z' => new Binding(c, 0, 0),
        ['F', .. var n] when int.TryParse(n, out var f) && f is >= 1 and <= 12 => new Binding(0x6F + f, 0, 0),
        _ => null,
    };
}
