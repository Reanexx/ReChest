using System.IO;
using System.Text.Json;

namespace ChestCounter;

/// User settings, edited in the app's Settings page and saved to %APPDATA%\ChestCounter\settings.json.
public sealed class AppSettings
{
    static readonly string FilePath = Path.Combine(Replays.Dir, "settings.json");

    // in-game panel
    public bool Hud { get; set; } = true;
    public string HudCorner { get; set; } = "tl"; // tl, tr, bl, br of the Fortnite window
    public int HudX { get; set; } = 24;
    public int HudY { get; set; } = 24;
    public int HudScale { get; set; } = 100; // percent
    public int HudOpacity { get; set; } = 95; // percent
    public string HudStyle { get; set; } = "glass"; // glass, solid, minimal
    public string HudAccent { get; set; } = "#3CCF6E";
    public bool HudHints { get; set; }             // show the "F8 +1 · F9 −1" hotkey hint on the overlay (off: don't clutter the game)
    public bool HudPlus { get; set; } = true;      // show the "+N this match" live number
    public bool HudLabels { get; set; } = true;    // show the CHESTS / THIS MATCH captions
    public bool HudRecord { get; set; } = true;    // "3 to beat your record" / "New record!" during a match
    public string Lang { get; set; } = "en";       // UI language (en, tr); the overlay follows it

    // live counting
    public bool LiveDetect { get; set; } = true;
    public bool Debug { get; set; }
    public int AddKey { get; set; } = 0x77;    // F8
    public int RemoveKey { get; set; } = 0x78; // F9

    // internet broadcast: receive others' "play everyone's video" signals (opt-out per machine)
    public bool ReceiveBroadcasts { get; set; } = true;

    // background: start with Windows (hidden), show the window when Fortnite starts, close to the tray
    public bool StartWithWindows { get; set; } = true;
    public bool ShowOnFortnite { get; set; } = true;
    public bool CloseToTray { get; set; } = true;

    // the Map page's route over the game (RouteOverlay); the route key turns it on and off
    public bool RouteOverlay { get; set; } = true;
    public int RouteKey { get; set; } = 0x76; // F7
    public bool RouteBig { get; set; }
    public int RouteBigKey { get; set; } = 0x75; // F6: bigger route card
    public int RouteFullKey { get; set; } = 0x74; // F5: full-screen map over the game
    public int RouteZoom { get; set; } = 100;     // percent: how close the card follows you
    public int RouteDot { get; set; } = 100;      // percent: size of the stops (chests) on the card
    public bool MapTrack { get; set; } = true; // read your position off the minimap during matches (MinimapTracker)
    // the map card's own place and look, like the chest panel's (default: right side, under the game's minimap)
    public string MapCorner { get; set; } = "tr";
    public int MapX { get; set; } = 24;
    public int MapY { get; set; } = 320;
    public int MapScale { get; set; } = 100;   // percent
    public int MapOpacity { get; set; } = 95;  // percent
    public string MapStyle { get; set; } = "glass"; // glass, solid, minimal
    public string MapAccent { get; set; } = "#FFC93C";
    public bool MapHeader { get; set; } = true; // the title line (ROUTE, distance, keys) above the map
    public bool MapPointers { get; set; } // "chests in view": nearby chest spots marked on screen (ChestPointer); off until turned on
    public string TrackQuality { get; set; } = "high"; // low, balanced, high: how often the minimap is read (MinimapTracker)
    public int MapPointerRange { get; set; } = 60; // metres
    public int PointerKey { get; set; } = 0x72; // F3: chests in view on/off
    // "route from here" (RouteBuilder): its key, and the Map page's layers and stop count it follows (the page reports them)
    public int RouteHereKey { get; set; } = 0x73; // F4
    public string[] MapLayers { get; set; }
    public int RouteStops { get; set; } = 10;
    public static readonly string[] DefaultLayers = ["chests", "rare_chests", "buried_chests", "sprite_chests", "key_vaults"];

    public static AppSettings Load()
    {
        try { return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath)) ?? new(); }
        catch { return new(); } // first run or unreadable file: defaults
    }

    public void Save()
    {
        Directory.CreateDirectory(Replays.Dir);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this));
    }
}
