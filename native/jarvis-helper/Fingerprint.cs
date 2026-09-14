using System.Text.Json.Nodes;
using JarvisHelper.Uia;

namespace JarvisHelper;

/// <summary>
/// A cheap "has anything about the target window changed" snapshot — used
/// by pointer_act's stale-capture guard (main/operate/coords.ts +
/// tools/operate.ts) to refuse a coordinate click if the window has moved,
/// closed, or been replaced by something else since the screenshot the
/// coordinates came from. Deliberately not a full UIA tree diff (out of
/// scope for this first pass) — hwnd/title/rect is enough to catch the
/// realistic failure mode (window moved or a different window is now
/// frontmost) without the cost of walking the tree on every pointer call.
/// </summary>
internal static class Fingerprint
{
    internal static JsonObject Get(int[] excludePids)
    {
        var hwnd = WindowResolver.ResolveHwnd("active", excludePids);
        var info = WindowInfo.DescribePublic(hwnd);
        info["capturedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return info;
    }
}
