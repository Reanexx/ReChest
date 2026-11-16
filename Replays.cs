using System.IO;
using System.Text.Json;
using FortniteReplayReader;
using FortniteReplayReader.Models.NetFieldExports;
using FortniteReplayReader.Models.NetFieldExports.Items;
using Unreal.Core;
using Unreal.Core.Contracts;
using Unreal.Core.Exceptions;
using Unreal.Core.Models;
using Unreal.Core.Models.Enums;

namespace ChestCounter;

public record Open(double T, string Type, string By, bool Broken = false);

public record Match(string Id, string File, long Size, DateTime StartUtc, double Duration, int? Placement, int? Kills,
                    string Me, string[] Squad, List<Open> Opens, bool Final, int Parser = 0, Dictionary<string, string> Skins = null);

/// Reads Fortnite replays (Saved\Demos) and keeps the squad's chest history in %APPDATA%\ChestCounter\matches.json.
public static class Replays
{
    public static readonly string Demos = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FortniteGame", "Saved", "Demos");
    public static readonly string Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ChestCounter");
    static readonly string HistoryFile = Path.Combine(Dir, "matches.json");
    /// Chest pictures fetched from the Fortnite wiki on first start (see StatsWindow.FetchImages).
    public static readonly string ImgDir = Path.Combine(Dir, "img");
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static List<Match> Load()
    {
        try { return JsonSerializer.Deserialize<List<Match>>(File.ReadAllText(HistoryFile), Json) ?? []; }
        catch { return []; } // first run or unreadable history
    }

    public static void Save(List<Match> all)
    {
        Directory.CreateDirectory(Dir);
        var tmp = HistoryFile + ".tmp"; // write-then-move so a crash never leaves half a history file
        File.WriteAllText(tmp, JsonSerializer.Serialize(all.OrderBy(m => m.StartUtc), Json));
        File.Move(tmp, HistoryFile, true);
    }

    /// Bumped when counting changes, so older history entries are re-read from their replay (or its backup).
    public const int ParserVersion = 4; // 3: outfits (skins); 4: mass-destruction bursts no longer count as broken chests

    public static string ToJson(object o) => JsonSerializer.Serialize(o, Json);

    /// Parses a finished replay. (While a match is running Fortnite keeps the decryption key in memory and writes
    /// zeros in its place, so the chest data can only be read once the match ends; see <see cref="Recording"/>.)
    public static Match Parse(string path)
    {
        byte[] bytes;
        using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            bytes = new byte[fs.Length];
            fs.ReadExactly(bytes);
        }
        var reader = new ChestReader();
        var replay = reader.ReadReplay(new MemoryStream(bytes));

        var skins = reader.Outfits();
        var owner = replay.PlayerData.FirstOrDefault(p => p.IsReplayOwner);
        if (owner == null) return null; // spectated / creative replay without an owner
        string Name(FortniteReplayReader.Models.PlayerData p) => p.PlayerName ?? p.PlayerNameCustomOverride ?? $"Oyuncu {p.Id}";
        var squad = replay.PlayerData.Where(p => p.TeamIndex == owner.TeamIndex && !p.IsBot).ToList();
        var byId = squad.Where(p => p.Id != null).ToDictionary(p => p.Id.Value, Name);
        var opens = reader.Opens().Where(o => byId.ContainsKey(o.PlayerId)).Select(o => new Open(Math.Round(o.T, 1), o.Type, byId[o.PlayerId], o.Broken)).ToList();

        // replay header time is local wall-clock (matches the UnsavedReplay-<date> file name)
        var start = replay.Info?.Timestamp is { Year: > 2000 } ts ? DateTime.SpecifyKind(ts, DateTimeKind.Local).ToUniversalTime() : File.GetCreationTimeUtc(path);
        return new Match(start.Ticks + "-" + Name(owner), Path.GetFileName(path), bytes.Length, start, Math.Round(reader.LastTime),
            (int?)replay.TeamStats?.Position is > 0 and var pos ? pos : null, (int?)replay.Stats?.Eliminations,
            Name(owner), squad.Select(Name).ToArray(), opens, true, ParserVersion,
            squad.Where(p => p.Id != null && skins.ContainsKey(p.Id.Value)).GroupBy(Name).ToDictionary(g => g.Key, g => skins[g.First().Id.Value]));
    }

    /// Debug: every container update with who it maps to, plus the player id tables (App --dump).
    public static string Dump(string path)
    {
        var reader = new ChestReader();
        using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            var bytes = new byte[fs.Length]; fs.ReadExactly(bytes);
            var replay = reader.ReadReplay(new MemoryStream(bytes));
            var sb = new System.Text.StringBuilder();
            foreach (var p in replay.PlayerData) sb.AppendLine($"PLAYER id={p.Id} name={p.PlayerName} team={p.TeamIndex} bot={p.IsBot} owner={p.IsReplayOwner}");
            sb.Append(reader.DumpTables());
            return sb.ToString();
        }
    }

    /// Reads only the (unencrypted) header: is Fortnite still recording this replay, and since when?
    /// Header: magic, file version, [custom versions], length ms, network version, changelist, friendly name, IsLive, timestamp.
    public static (bool Live, DateTime StartUtc, uint LengthMs) Recording(string path)
    {
        var b = new byte[4096];
        using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            b = b[..fs.Read(b)];
        if (b.Length < 64 || BitConverter.ToUInt32(b, 0) != 0x1CA2E27F) return default; // not a local Unreal replay
        var o = 4;
        var version = BitConverter.ToUInt32(b, o); o += 4;
        if (version >= 6) o += 4 + BitConverter.ToInt32(b, o) * 20; // HISTORY_CUSTOM_VERSIONS
        var lengthMs = BitConverter.ToUInt32(b, o); o += 12;
        var nameLen = BitConverter.ToInt32(b, o); o += 4;
        o += nameLen >= 0 ? nameLen : -nameLen * 2; // FString: negative length = UTF-16
        if (o + 12 > b.Length) return default;
        var live = BitConverter.ToUInt32(b, o) != 0;
        var start = DateTime.SpecifyKind(DateTime.FromBinary(BitConverter.ToInt64(b, o + 4)), DateTimeKind.Local).ToUniversalTime();
        return (live, start, lengthMs);
    }

    /// <summary>
    /// Every searchable container replicates SearchingPawn (the pawn that opened it) next to bAlreadySearched and
    /// bDestroyed; pawns replicate their PlayerState. So each container is credited to exactly the player who
    /// opened (or broke) it, with no guessing from timing or distance. Containers are keyed by their actor name, so
    /// one that leaves view and comes back is still one container. Approach from github.com/rossalv/fortnite-chest-counter.
    /// </summary>
    sealed class ChestReader : ReplayReader
    {
        public ChestReader() : base(null, ParseMode.Minimal) { }
        public float LastTime;

        readonly Dictionary<string, string> kinds = []; // group path -> container type, or null when not a container
        readonly Dictionary<uint, uint> actorToChannel = [], pawnToState = []; // pawn actor guid -> PlayerState channel
        readonly Dictionary<uint, int> stateToPlayer = [];
        readonly List<(float T, string Id, string Type, uint? Pawn, bool? Searched, bool? Destroyed)> updates = [];

        // shortcut: unknown events (e.g. the 2026 "Timecode" event) are skipped; the chunk loop re-aligns after each event.
        public override void ReadEvent(FArchive archive)
        {
            try { base.ReadEvent(archive); } catch (UnknownEventException) { }
        }

        protected override void OnChannelOpened(uint ch, NetworkGUID? actor)
        {
            base.OnChannelOpened(ch, actor);
            if (actor != null) actorToChannel[actor.Value] = ch;
        }

        protected override void OnExportRead(uint ch, INetFieldExportGroup group)
        {
            base.OnExportRead(ch, group);
            LastTime = CurrentTimeSeconds;
            switch (group)
            {
                case FortPlayerState s:
                    if ((s.PlayerId is uint u ? (int)u : s.PlayerID) is int id) stateToPlayer[ch] = id;
                    break;
                case PlayerPawn p:
                    if (p.PlayerState is uint a && actorToChannel.TryGetValue(a, out var sc) && Channels[ch]?.ActorId is uint pawn) pawnToState[pawn] = sc;
                    break;
            }
        }

        string TypeOf(string path)
        {
            if (kinds.TryGetValue(path, out var t)) return t;
            t = null;
            if (!path.Contains(':') && !path.EndsWith("ClassNetCache", StringComparison.Ordinal))
            {
                var name = path[(path.LastIndexOf('.') + 1)..];
                if (name.Contains("Llama", StringComparison.OrdinalIgnoreCase)) t = "llama";
                else if (name.Contains("SupplyDrop", StringComparison.OrdinalIgnoreCase)) t = "drop";
                else if (name.Contains("FactionChest", StringComparison.OrdinalIgnoreCase)) t = "faction";
                else if (name.Contains("Chest", StringComparison.OrdinalIgnoreCase)) t = "chest";
                else if (name.Contains("Tiered_Ammo", StringComparison.OrdinalIgnoreCase) || name.Contains("Short_Ammo", StringComparison.OrdinalIgnoreCase)) t = "ammo";
                else if (name.Contains("FishingRod", StringComparison.OrdinalIgnoreCase)) t = "fishing";
            }
            return kinds[path] = t;
        }

        /// Mirrors the base property loop (handle, bit count, payload) for container groups, decoding only the
        /// fields we need; every other group goes through the library as before.
        public override bool ReceiveProperties(FBitArchive archive, NetFieldExportGroup group, uint ch, out INetFieldExportGroup exportGroup, bool enablePropertyChecksum = true, bool netDeltaUpdate = false)
        {
            if (!netDeltaUpdate && group.PathName.EndsWith("FortPlayerStateAthena", StringComparison.Ordinal) && PeekOutfit(archive, group, enablePropertyChecksum) is { } outfit)
                outfits[ch] = outfit;
            var type = netDeltaUpdate ? null : TypeOf(group.PathName);
            if (type == null) return base.ReceiveProperties(archive, group, ch, out exportGroup, enablePropertyChecksum, netDeltaUpdate);
            exportGroup = null;
            var channel = Channels[ch];
            if (channel == null) return false;
            if (enablePropertyChecksum) archive.ReadBit();

            uint? pawn = null;
            bool? searched = null, destroyed = null;
            while (true)
            {
                var handle = archive.ReadIntPacked();
                if (handle == 0) break;
                handle--;
                if (!group.IsValidIndex(handle)) return false;
                var numBits = (int)archive.ReadIntPacked();
                if (numBits == 0) continue;
                if (archive.IsError || numBits > archive.GetBitsLeft()) return false;
                var start = archive.GetBitsLeft();
                switch (group.NetFieldExports[handle]?.Name)
                {
                    case "SearchingPawn": pawn = archive.ReadIntPacked(); break;
                    case "bAlreadySearched" or "Opened" or "Looted": searched = archive.ReadBit(); break;
                    case "bDestroyed": destroyed = archive.ReadBit(); break;
                }
                var used = start - archive.GetBitsLeft();
                if (used > numBits || archive.IsError) return false;
                if (used < numBits) archive.SkipBits(numBits - used);
            }
            if (channel.ActorId is uint actor && (pawn != null || searched != null || destroyed != null))
                updates.Add((CurrentTimeSeconds, ChestId(actor, channel.Actor?.Location, type), type, pawn, searched, destroyed));
            return true;
        }

        readonly Dictionary<uint, string> dynamicIds = [];
        readonly List<(string Type, double X, double Y, string Id)> spawned = [];

        /// Map-placed containers have a stable actor name. Spawned ones (buried, relic, ...) get a new network id each
        /// time they come back into view, so they are identified by type + spawn position (horizontal, 1.5 m).
        string ChestId(uint actor, FVector location, string type)
        {
            if (_netGuidCache.TryGetPathName(actor, out var name)) return name;
            if (dynamicIds.TryGetValue(actor, out var known)) return known;
            var id = "#" + actor;
            if (location != null)
            {
                var hit = spawned.FindIndex(c => c.Type == type && Math.Abs(c.X - location.X) < 150 && Math.Abs(c.Y - location.Y) < 150);
                if (hit >= 0) id = spawned[hit].Id;
                else spawned.Add((type, location.X, location.Y, id = $"{type}@{location.X:F0},{location.Y:F0}"));
            }
            return dynamicIds[actor] = id;
        }

        readonly Dictionary<uint, string> outfits = []; // PlayerState channel -> outfit asset name (CID_...)

        /// Outfit id per player id, e.g. "CID_A_123_Athena_Commando_F_X".
        public Dictionary<int, string> Outfits() =>
            outfits.Where(o => stateToPlayer.ContainsKey(o.Key)).GroupBy(o => stateToPlayer[o.Key]).ToDictionary(g => g.Key, g => g.Last().Value);

        /// Newer Fortnite keeps the outfit in FortPlayerStateAthena.CachedLoadoutCharacterUngated (an object reference),
        /// which the library does not know. Read just that field and rewind, so the library still parses the group.
        string PeekOutfit(FBitArchive archive, NetFieldExportGroup group, bool checksum)
        {
            archive.Mark();
            try
            {
                if (checksum) archive.ReadBit();
                while (!archive.IsError)
                {
                    var handle = archive.ReadIntPacked();
                    if (handle == 0) return null;
                    handle--;
                    if (!group.IsValidIndex(handle)) return null;
                    var numBits = (int)archive.ReadIntPacked();
                    if (numBits == 0) continue;
                    if (numBits > archive.GetBitsLeft()) return null;
                    if (group.NetFieldExports[handle]?.Name == "CachedLoadoutCharacterUngated")
                    {
                        var guid = archive.ReadIntPacked();
                        return _netGuidCache.TryGetPathName(guid, out var path) ? path[(path.LastIndexOf('.') + 1)..] : null;
                    }
                    archive.SkipBits(numBits);
                }
                return null;
            }
            finally { archive.Pop(); }
        }

        public string DumpTables()
        {
            var sb = new System.Text.StringBuilder();
            foreach (var kv in stateToPlayer) sb.AppendLine($"STATE ch={kv.Key} player={kv.Value}");
            sb.AppendLine($"PAWNS {pawnToState.Count}: " + string.Join(" ", pawnToState.Select(kv => $"{kv.Key}->{kv.Value}" + (stateToPlayer.TryGetValue(kv.Value, out var pl) ? $"({pl})" : "(?)"))));
            foreach (var box in updates.GroupBy(u => u.Id))
            {
                sb.Append($"BOX {box.First().Type} {box.Key}:");
                foreach (var u in box)
                {
                    var who = u.Pawn is uint p ? (pawnToState.TryGetValue(p, out var st) ? (stateToPlayer.TryGetValue(st, out var pl) ? $"P{pl}" : $"st{st}?") : $"pawn{p}?") : "-";
                    sb.Append($" [{u.T:F0}s {who} s={u.Searched?.ToString() ?? "."} d={u.Destroyed?.ToString() ?? "."}]");
                }
                sb.AppendLine();
            }
            return sb.ToString();
        }

        /// One entry per container opened or broken by a known player.
        public List<(float T, string Type, int PlayerId, bool Broken)> Opens()
        {
            var result = new List<(float T, string Type, int PlayerId, bool Broken)>();
            foreach (var box in updates.GroupBy(u => u.Id))
            {
                var list = box.ToList();
                var i = list.FindIndex(u => u.Pawn is uint p && pawnToState.TryGetValue(p, out var st) && stateToPlayer.ContainsKey(st));
                if (i < 0 || !list.Skip(i).Any(u => u.Searched == true || u.Destroyed == true)) continue;
                var opener = list[i];
                var broken = !list.Any(u => u.Searched == true) && list.Any(u => u.Destroyed == true);
                result.Add((opener.T, opener.Type, stateToPlayer[pawnToState[opener.Pawn.Value]], broken));
            }
            // A blast, vehicle or collapsing building destroys several containers in a moment and credits them to the
            // pawn that caused it; nobody breaks 3+ chests within 5 s by hand, so such bursts are not chests they got.
            var bursts = result.Where(r => r.Broken).GroupBy(r => r.PlayerId)
                .SelectMany(g => g.Where(r => g.Count(o => Math.Abs(o.T - r.T) <= 2.5f) >= 3)).ToHashSet();
            return result.Where(r => !bursts.Contains(r)).OrderBy(r => r.T).ToList();
        }
    }
}






