using System.Text.Json.Nodes;

namespace JarvisHelper;

/// <summary>
/// Long-lived Windows-only companion process for JARVIS. Started once by
/// Electron main and kept alive for the app's lifetime (see
/// src/main/platform/helper.ts, which restarts it if it exits). Speaks
/// line-delimited JSON-RPC over stdin/stdout: one JSON object per line in
/// ({"id","method","params"}), one JSON object per line out
/// ({"id","ok":true,"result"} or {"id","ok":false,"error"}).
///
/// Exists specifically for calls PowerShell is either too slow for
/// (foreground window/cursor — needed on every conversational turn; audio,
/// which previously paid an inline Add-Type C# compile on every single
/// call) or has no natural affinity for (Steam's registry + VDF catalog).
/// Start Menu/packaged-app enumeration deliberately stays on the existing
/// Get-StartApps PowerShell path (windows.ts) — it's already correct and
/// only runs at startup plus daily, so its latency doesn't matter.
///
/// Each request is now dispatched onto its own thread-pool task rather
/// than handled inline in the read loop — a real-PC regression found that
/// a slow/blocked launch call (see AppLauncher.cs's class doc comment)
/// held up every other pending request behind it on the same pipe,
/// including the next launch call and the live foreground-window/cursor
/// query the conversational turn was waiting on. Output is still only
/// ever written under `OutputLock`, since interleaved partial JSON lines
/// from two threads writing at once would corrupt the protocol.
/// </summary>
public static class Program
{
    private static readonly object OutputLock = new();

    public static void Main()
    {
        string? line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            var capturedLine = line;
            _ = Task.Run(() => HandleLine(capturedLine));
        }
    }

    private static void HandleLine(string line)
    {
        long id = 0;
        try
        {
            var request = JsonNode.Parse(line);
            id = request?["id"]?.GetValue<long>() ?? 0;
            var method = request?["method"]?.GetValue<string>() ?? "";
            var result = Dispatch(method, request?["params"]);
            Respond(id, true, result, null);
        }
        catch (Exception ex)
        {
            Respond(id, false, null, ex.Message);
        }
    }

    private static JsonNode? Dispatch(string method, JsonNode? p) => method switch
    {
        "ping" => new JsonObject { ["pong"] = true },
        "foregroundWindow" => WindowInfo.GetForeground(),
        "listWindows" => WindowInfo.ListVisible(),
        "focusWindow" => WindowInfo.Focus(RequireLong(p, "hwnd")),
        "audioGet" => Audio.Get(),
        "audioSetVolume" => Audio.SetVolume(RequireDouble(p, "percent")),
        "audioSetMute" => Audio.SetMute(RequireBool(p, "muted")),
        "steamCatalog" => SteamCatalog.Get(),
        "launchInstalledApp" => AppLauncher.LaunchInstalledApp(
            RequireString(p, "target"),
            RequireBool(p, "isPath"),
            OptionalString(p, "arguments"),
            (int)(p?["observeTimeoutMs"]?.GetValue<long>() ?? 8000)),
        _ => throw new InvalidOperationException($"Unknown method: {method}")
    };

    private static string RequireString(JsonNode? p, string field) =>
        p?[field]?.GetValue<string>() ?? throw new ArgumentException($"Missing required param: {field}");

    private static string? OptionalString(JsonNode? p, string field) =>
        p?[field]?.GetValue<string>();

    private static long RequireLong(JsonNode? p, string field) =>
        p?[field]?.GetValue<long>() ?? throw new ArgumentException($"Missing required param: {field}");

    private static double RequireDouble(JsonNode? p, string field) =>
        p?[field]?.GetValue<double>() ?? throw new ArgumentException($"Missing required param: {field}");

    private static bool RequireBool(JsonNode? p, string field) =>
        p?[field]?.GetValue<bool>() ?? throw new ArgumentException($"Missing required param: {field}");

    private static void Respond(long id, bool ok, JsonNode? result, string? error)
    {
        var obj = new JsonObject { ["id"] = id, ["ok"] = ok };
        if (ok) obj["result"] = result;
        else obj["error"] = error;
        var text = obj.ToJsonString();
        lock (OutputLock)
        {
            Console.Out.WriteLine(text);
            Console.Out.Flush();
        }
    }
}
