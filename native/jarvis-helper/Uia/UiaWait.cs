using System.Text.Json.Nodes;

namespace JarvisHelper.Uia;

/// <summary>Replaces a Claude-side inspect-poll loop with one bounded native wait — see the plan's ui_wait tool. Never throws on "condition never met"; it just reports met:false, since that's a normal (if disappointing) outcome, not an error.</summary>
internal static class UiaWait
{
    internal static JsonObject Wait(JsonNode? p)
    {
        var excludePids = UiaInspect.ParseExcludePids(p);
        var condition = p?["condition"]?.GetValue<string>() ?? throw new ArgumentException("Missing required param: condition");
        var timeoutMs = Math.Min((int)(p?["timeoutMs"]?.GetValue<long>() ?? 5000), 10000);
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);

        switch (condition)
        {
            case "window_title":
            {
                var titleContains = p?["titleContains"]?.GetValue<string>() ?? throw new ArgumentException("Missing required param: titleContains");
                while (DateTime.UtcNow < deadline)
                {
                    try
                    {
                        var hwnd = WindowResolver.ResolveHwnd("active", excludePids);
                        var info = WindowInfo.DescribePublic(hwnd);
                        var title = info["title"]?.GetValue<string>() ?? "";
                        if (title.Contains(titleContains, StringComparison.OrdinalIgnoreCase))
                            return new JsonObject { ["met"] = true, ["window"] = info };
                    }
                    catch { /* keep polling — window may not exist yet */ }
                    Thread.Sleep(250);
                }
                return new JsonObject { ["met"] = false };
            }
            case "appears":
            case "disappears":
            {
                var target = p?["target"] ?? throw new ArgumentException("Missing required param: target");
                while (DateTime.UtcNow < deadline)
                {
                    var found = TargetFinder.FindCandidates(target, excludePids, maxResults: 1);
                    if (condition == "appears" && found.Count > 0)
                        return new JsonObject { ["met"] = true, ["element"] = UiaActions.UiaInspectSummaryFor(found[0]) };
                    if (condition == "disappears" && found.Count == 0)
                        return new JsonObject { ["met"] = true };
                    Thread.Sleep(250);
                }
                return new JsonObject { ["met"] = false };
            }
            case "state":
            {
                var target = p?["target"] ?? throw new ArgumentException("Missing required param: target");
                var state = p?["state"]?.GetValue<string>() ?? throw new ArgumentException("Missing required param: state");
                while (DateTime.UtcNow < deadline)
                {
                    var found = TargetFinder.FindCandidates(target, excludePids, maxResults: 1);
                    if (found.Count > 0)
                    {
                        var current = UiaActions.DescribeStateSafe(found[0]);
                        if (string.Equals(current, state, StringComparison.OrdinalIgnoreCase))
                            return new JsonObject { ["met"] = true, ["element"] = UiaActions.UiaInspectSummaryFor(found[0]) };
                    }
                    Thread.Sleep(250);
                }
                return new JsonObject { ["met"] = false };
            }
            default:
                throw new ArgumentException($"Unknown condition: {condition}");
        }
    }
}
