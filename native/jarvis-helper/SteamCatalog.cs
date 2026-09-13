using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace JarvisHelper;

/// <summary>
/// Steam games rarely have Start Menu shortcuts, so the existing
/// Get-StartApps-based catalog (windows.ts) can't see them — this reads
/// Steam's own registry key and library-folder manifests directly. Steam's
/// VDF format is simple enough that a "quoted-key" "quoted-value" regex
/// covers what's needed here; a full VDF parser would be overkill.
/// </summary>
internal static class SteamCatalog
{
    internal static JsonObject Get()
    {
        var steamPath = ReadSteamPath();
        var games = new JsonArray();
        if (steamPath != null)
        {
            foreach (var libraryPath in ReadLibraryFolders(steamPath))
            {
                var appsDir = Path.Combine(libraryPath, "steamapps");
                if (!Directory.Exists(appsDir)) continue;
                foreach (var manifest in Directory.EnumerateFiles(appsDir, "appmanifest_*.acf"))
                {
                    var parsed = ParseManifest(manifest);
                    if (parsed != null) games.Add(parsed);
                }
            }
        }
        return new JsonObject
        {
            ["steamExePath"] = steamPath != null ? Path.Combine(steamPath, "steam.exe") : null,
            ["games"] = games
        };
    }

    private static string? ReadSteamPath()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam");
            return key?.GetValue("SteamPath") as string;
        }
        catch
        {
            return null;
        }
    }

    private static List<string> ReadLibraryFolders(string steamPath)
    {
        var results = new List<string> { steamPath };
        var vdfPath = Path.Combine(steamPath, "steamapps", "libraryfolders.vdf");
        if (!File.Exists(vdfPath)) return results;
        try
        {
            var text = File.ReadAllText(vdfPath);
            foreach (Match m in Regex.Matches(text, "\"path\"\\s*\"([^\"]+)\""))
            {
                var path = m.Groups[1].Value.Replace("\\\\", "\\");
                if (!results.Contains(path)) results.Add(path);
            }
        }
        catch
        {
            // Best-effort — a missing/unreadable/malformed file just means "no extra libraries found."
        }
        return results;
    }

    private static JsonObject? ParseManifest(string path)
    {
        try
        {
            var text = File.ReadAllText(path);
            var appIdMatch = Regex.Match(text, "\"appid\"\\s*\"(\\d+)\"", RegexOptions.IgnoreCase);
            var nameMatch = Regex.Match(text, "\"name\"\\s*\"([^\"]+)\"");
            var installDirMatch = Regex.Match(text, "\"installdir\"\\s*\"([^\"]+)\"");
            if (!appIdMatch.Success || !nameMatch.Success) return null;
            return new JsonObject
            {
                ["appId"] = appIdMatch.Groups[1].Value,
                ["name"] = nameMatch.Groups[1].Value,
                ["installDir"] = installDirMatch.Success ? installDirMatch.Groups[1].Value : null
            };
        }
        catch
        {
            return null;
        }
    }
}
