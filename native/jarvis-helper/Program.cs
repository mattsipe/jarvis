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
/// </summary>
public static class Program
{
    [STAThread]
    public static void Main()
    {
        string? line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            HandleLine(line);
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
        _ => throw new InvalidOperationException($"Unknown method: {method}")
    };

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
        Console.Out.WriteLine(obj.ToJsonString());
        Console.Out.Flush();
    }
}
