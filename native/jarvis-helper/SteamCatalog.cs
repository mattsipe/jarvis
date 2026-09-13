using System.Linq;
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
///
/// Client resolution deliberately doesn't trust the registry blindly:
/// HKCU\...\Steam is only populated once Steam has actually run for that
/// user (a fresh install/profile can be missing it, or it can point at a
/// stale/moved path), so every candidate is verified with File.Exists
/// before being accepted, with standard install locations as a further
/// fallback. Confirmed against a real install: SteamPath's steam.exe
/// existing at C:\Program Files (x86)\Steam\steam.exe.
/// </summary>
internal static class SteamCatalog
{
    internal static JsonObject Get()
    {
        var steamExePath = ResolveSteamExe();
        var games = new JsonArray();
        if (steamExePath != null)
        {
            var steamDir = Path.GetDirectoryName(steamExePath)!;
            foreach (var libraryPath in ReadLibraryFolders(steamDir))
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
            ["steamExePath"] = steamExePath,
            ["games"] = games
        };
    }

    /// <summary>
    /// In priority order: HKCU SteamExe (a full path Steam itself writes,
    /// when present) and SteamPath+steam.exe; then HKLM's 32-bit-view
    /// InstallPath (set at install time, independent of any user profile);
    /// then the two standard install directories. The first candidate that
    /// actually exists on disk wins — never returns an unverified path.
    /// </summary>
    private static string? ResolveSteamExe()
    {
        foreach (var candidate in RegistryCandidates().Concat(StandardLocations()))
        {
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static List<string> RegistryCandidates()
    {
        var results = new List<string>();
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam");
            if (key != null)
            {
                if (key.GetValue("SteamExe") is string exe && !string.IsNullOrWhiteSpace(exe))
                    results.Add(exe.Replace('/', '\\'));
                if (key.GetValue("SteamPath") is string path && !string.IsNullOrWhiteSpace(path))
                    results.Add(Path.Combine(path.Replace('/', '\\'), "steam.exe"));
            }
        }
        catch
        {
            // Best-effort — fall through to the next candidate source.
        }

        try
        {
            using var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry32);
            using var key = hklm.OpenSubKey(@"SOFTWARE\Valve\Steam");
            if (key?.GetValue("InstallPath") is string installPath && !string.IsNullOrWhiteSpace(installPath))
                results.Add(Path.Combine(installPath, "steam.exe"));
        }
        catch
        {
            // Best-effort — fall through to the standard-location fallback.
        }

        return results;
    }

    private static List<string> StandardLocations() =>
        new()
        {
            @"C:\Program Files (x86)\Steam\steam.exe",
            @"C:\Program Files\Steam\steam.exe"
        };

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
