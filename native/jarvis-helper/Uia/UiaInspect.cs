using System.Text.Json.Nodes;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;

namespace JarvisHelper.Uia;

/// <summary>
/// Reads compact, semantic descriptions of UI elements — never a raw
/// accessibility tree. A single bounded tree walk (node/depth/time capped)
/// backs both "list what's here" and "find the thing named X", filtered to
/// interactable roles (or anything matching a query) and kept in document
/// order, which is what makes "the second result" a meaningful phrase.
/// </summary>
internal static class UiaInspect
{
    private const int DefaultMaxElements = 40;
    private const int HardMaxElements = 80;
    private const int MaxNodes = 3000;
    private const int MaxDepth = 25;
    private const int WalkTimeoutMs = 4000;

    private static readonly ControlType[] InteractableTypes =
    {
        ControlType.Button, ControlType.CheckBox, ControlType.ComboBox, ControlType.Edit,
        ControlType.RadioButton, ControlType.Slider, ControlType.Tab, ControlType.TabItem,
        ControlType.TreeItem, ControlType.ListItem, ControlType.MenuItem, ControlType.Hyperlink,
        ControlType.SplitButton, ControlType.List, ControlType.Tree, ControlType.Menu,
        ControlType.DataItem, ControlType.Custom
    };

    internal static JsonObject Inspect(JsonNode? p)
    {
        var excludePids = ParseExcludePids(p);

        var refId = p?["ref"]?.GetValue<string>();
        if (!string.IsNullOrEmpty(refId))
        {
            var element = ElementRegistry.Resolve(refId) ?? throw new StaleRefException(refId);
            return DescribeDetail(element, refId);
        }

        var at = p?["at"];
        if (at != null)
        {
            var x = (int)at["x"]!.GetValue<long>();
            var y = (int)at["y"]!.GetValue<long>();
            var element = UiaSession.WithTimeout(
                () => UiaSession.Automation.FromPoint(new System.Drawing.Point(x, y)),
                2000, "ElementFromPoint");
            var elements = new JsonArray();
            nint hwnd = 0;
            if (element != null)
            {
                var id = ElementRegistry.Register(element);
                elements.Add(Summarize(element, id));
                hwnd = TryGetHwnd(element);
            }
            return new JsonObject { ["elements"] = elements, ["window"] = DescribeWindow(hwnd), ["truncated"] = false };
        }

        var windowSpec = p?["window"]?.GetValue<string>();
        var query = p?["query"]?.GetValue<string>();
        var maxElements = Math.Min((int)(p?["maxElements"]?.GetValue<long>() ?? DefaultMaxElements), HardMaxElements);

        var window = WindowResolver.ResolveWindow(windowSpec, excludePids);
        var hwndValue = TryGetHwnd(window);

        var (all, truncated) = UiaSession.WithTimeout(() => WalkBounded(window), WalkTimeoutMs, "UI tree walk");

        var tokens = Tokenize(query);
        var matches = new List<JsonObject>();
        foreach (var element in all)
        {
            if (matches.Count >= maxElements) { truncated = true; break; }
            if (!IsCandidate(element, tokens)) continue;
            var id = ElementRegistry.Register(element);
            matches.Add(Summarize(element, id));
        }

        return new JsonObject
        {
            ["elements"] = new JsonArray(matches.Cast<JsonNode?>().ToArray()),
            ["window"] = DescribeWindow(hwndValue),
            ["truncated"] = truncated
        };
    }

    private static (List<AutomationElement> elements, bool truncated) WalkBounded(AutomationElement root)
    {
        var walker = UiaSession.Automation.TreeWalkerFactory.GetControlViewWalker();
        var results = new List<AutomationElement>();
        var truncated = false;
        void Walk(AutomationElement node, int depth)
        {
            if (truncated) return;
            if (results.Count >= MaxNodes) { truncated = true; return; }
            if (depth > MaxDepth) return;
            results.Add(node);
            AutomationElement? child;
            try { child = walker.GetFirstChild(node); }
            catch { return; }
            while (child != null)
            {
                Walk(child, depth + 1);
                if (truncated) return;
                try { child = walker.GetNextSibling(child); }
                catch { break; }
            }
        }
        Walk(root, 0);
        return (results, truncated);
    }

    /// <summary>Same bounded walk, but stops at the first element whose identity matches a saved Locator exactly — used to re-resolve a stale ref. Populates `matches` with 0 or more hits; the caller treats anything but exactly 1 as a failed re-resolution.</summary>
    internal static void WalkForMatch(AutomationElement root, FlaUI.Core.ITreeWalker walker, Locator locator, List<AutomationElement> matches, int depth)
    {
        if (depth > MaxDepth || matches.Count > 1) return;
        try
        {
            var name = ElementRegistry.SafeGet(() => root.Properties.Name.ValueOrDefault);
            var controlType = ElementRegistry.SafeGet(() => root.Properties.ControlType.ValueOrDefault.ToString());
            var automationId = ElementRegistry.SafeGet(() => root.Properties.AutomationId.ValueOrDefault);
            var nameMatches = locator.Name != null && locator.Name == name;
            var typeMatches = locator.ControlType != null && locator.ControlType == controlType;
            var aidMatches = locator.AutomationId != null && locator.AutomationId == automationId;
            if ((nameMatches && typeMatches) || (aidMatches && typeMatches && automationId != null && automationId != ""))
            {
                matches.Add(root);
            }
        }
        catch { /* element gone mid-walk — skip it */ }

        AutomationElement? child;
        try { child = walker.GetFirstChild(root); } catch { return; }
        while (child != null && matches.Count <= 1)
        {
            WalkForMatch(child, walker, locator, matches, depth + 1);
            try { child = walker.GetNextSibling(child); } catch { break; }
        }
    }

    private static bool IsCandidate(AutomationElement element, string[] queryTokens)
    {
        try
        {
            if (!element.Properties.IsEnabled.ValueOrDefault && queryTokens.Length == 0) return false;
            var controlType = element.Properties.ControlType.ValueOrDefault;
            var isInteractableType = InteractableTypes.Contains(controlType) || HasAnyPattern(element);
            if (queryTokens.Length == 0) return isInteractableType;

            var name = element.Properties.Name.ValueOrDefault ?? "";
            var aid = element.Properties.AutomationId.ValueOrDefault ?? "";
            var haystack = (name + " " + aid).ToLowerInvariant();
            var matchesQuery = queryTokens.All(t => haystack.Contains(t));
            return matchesQuery && (isInteractableType || controlType == ControlType.Text || controlType == ControlType.Group || controlType == ControlType.Pane);
        }
        catch
        {
            return false;
        }
    }

    private static bool HasAnyPattern(AutomationElement element)
    {
        try
        {
            return element.Patterns.Invoke.IsSupported
                || element.Patterns.Toggle.IsSupported
                || element.Patterns.Value.IsSupported
                || element.Patterns.SelectionItem.IsSupported
                || element.Patterns.ExpandCollapse.IsSupported;
        }
        catch
        {
            return false;
        }
    }

    private static JsonObject Summarize(AutomationElement element, string id)
    {
        var obj = new JsonObject
        {
            ["ref"] = id,
            ["role"] = ElementRegistry.SafeGet(() => element.Properties.ControlType.ValueOrDefault.ToString()),
            ["name"] = ElementRegistry.SafeGet(() => element.Properties.Name.ValueOrDefault),
            ["automationId"] = ElementRegistry.SafeGet(() => element.Properties.AutomationId.ValueOrDefault),
            ["enabled"] = SafeBool(() => element.Properties.IsEnabled.ValueOrDefault, true),
            ["state"] = DescribeState(element),
            ["patterns"] = DescribePatterns(element)
        };
        return obj;
    }

    private static JsonObject DescribeDetail(AutomationElement element, string id)
    {
        var obj = Summarize(element, id);
        obj["className"] = ElementRegistry.SafeGet(() => element.Properties.ClassName.ValueOrDefault);
        obj["frameworkId"] = ElementRegistry.SafeGet(() => element.Properties.FrameworkId.ValueOrDefault);
        try
        {
            var rect = element.Properties.BoundingRectangle.ValueOrDefault;
            obj["boundingRect"] = new JsonObject { ["x"] = rect.X, ["y"] = rect.Y, ["width"] = rect.Width, ["height"] = rect.Height };
        }
        catch { /* not every element reports a bounding rectangle */ }
        return obj;
    }

    private static string? DescribeState(AutomationElement element)
    {
        try
        {
            if (element.Patterns.Toggle.IsSupported)
            {
                return element.Patterns.Toggle.Pattern.ToggleState.ValueOrDefault.ToString();
            }
            if (element.Patterns.SelectionItem.IsSupported)
            {
                return element.Patterns.SelectionItem.Pattern.IsSelected.ValueOrDefault ? "Selected" : "NotSelected";
            }
            if (element.Patterns.ExpandCollapse.IsSupported)
            {
                return element.Patterns.ExpandCollapse.Pattern.ExpandCollapseState.ValueOrDefault.ToString();
            }
            if (element.Patterns.Value.IsSupported)
            {
                var isPassword = IsPasswordSafe(element);
                if (isPassword) return "(password)";
                var v = element.Patterns.Value.Pattern.Value.ValueOrDefault;
                return v == null ? null : (v.Length > 80 ? v[..80] + "…" : v);
            }
        }
        catch { /* pattern present but state unreadable right now — leave state null */ }
        return null;
    }

    internal static bool IsPasswordSafe(AutomationElement element)
    {
        try { return element.Properties.IsPassword.ValueOrDefault; }
        catch { return false; }
    }

    private static JsonArray DescribePatterns(AutomationElement element)
    {
        var list = new JsonArray();
        try
        {
            if (element.Patterns.Invoke.IsSupported) list.Add("Invoke");
            if (element.Patterns.Toggle.IsSupported) list.Add("Toggle");
            if (element.Patterns.Value.IsSupported) list.Add("Value");
            if (element.Patterns.SelectionItem.IsSupported) list.Add("SelectionItem");
            if (element.Patterns.ExpandCollapse.IsSupported) list.Add("ExpandCollapse");
            if (element.Patterns.Scroll.IsSupported) list.Add("Scroll");
            if (element.Patterns.ScrollItem.IsSupported) list.Add("ScrollItem");
            if (element.Patterns.RangeValue.IsSupported) list.Add("RangeValue");
            if (element.Patterns.LegacyIAccessible.IsSupported) list.Add("LegacyIAccessible");
        }
        catch { /* best effort */ }
        return list;
    }

    internal static JsonObject DescribeWindow(nint hwnd)
    {
        if (hwnd == 0) return new JsonObject { ["hwnd"] = 0, ["title"] = (string?)null, ["processName"] = (string?)null };
        var info = WindowInfo.DescribePublic(hwnd);
        return info;
    }

    internal static nint TryGetHwnd(AutomationElement element)
    {
        try
        {
            if (element.Properties.NativeWindowHandle.IsSupported)
            {
                var handle = element.Properties.NativeWindowHandle.Value;
                if (handle != 0) return handle;
            }
        }
        catch { /* not every element exposes one directly */ }
        try
        {
            var window = element.Automation.GetDesktop() == element ? null : element;
            var walker = element.Automation.TreeWalkerFactory.GetControlViewWalker();
            var current = window;
            for (var i = 0; i < MaxDepth && current != null; i++)
            {
                try
                {
                    if (current.Properties.NativeWindowHandle.IsSupported && current.Properties.NativeWindowHandle.Value != 0)
                        return current.Properties.NativeWindowHandle.Value;
                }
                catch { /* keep walking up */ }
                current = walker.GetParent(current);
            }
        }
        catch { /* best effort */ }
        return 0;
    }

    private static string[] Tokenize(string? query) =>
        string.IsNullOrWhiteSpace(query)
            ? Array.Empty<string>()
            : query.ToLowerInvariant().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);

    private static bool SafeBool(Func<bool> fn, bool fallback)
    {
        try { return fn(); } catch { return fallback; }
    }

    internal static int[] ParseExcludePids(JsonNode? p)
    {
        var arr = p?["excludePids"]?.AsArray();
        if (arr == null) return Array.Empty<int>();
        return arr.Select(n => (int)(n?.GetValue<long>() ?? 0)).ToArray();
    }
}
