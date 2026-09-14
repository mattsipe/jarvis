using System.Text.Json.Nodes;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;

namespace JarvisHelper.Uia;

internal sealed class NotActionableException(string message) : Exception(message);
internal sealed class AmbiguousTargetException(List<JsonObject> candidates) : Exception("Ambiguous target.")
{
    internal List<JsonObject> Candidates { get; } = candidates;
}
internal sealed class TargetNotFoundException() : Exception("No element matches that target.");

/// <summary>
/// Every action here separates "the UIA call went through" from "the
/// control ended up in the expected state" — see ActionResult.ts's
/// sent-vs-verification split. `desiredState` on toggle/select/expand
/// makes repeats and "turn it back off" safe: an element already in the
/// requested state is a no-op, not a re-send.
/// </summary>
internal static class UiaActions
{
    private const int VerifyTimeoutMs = 2500;
    private const int VerifyPollMs = 150;
    private const int ActionTimeoutMs = 8000;

    /// <summary>
    /// Every failure mode a caller needs to react to differently (ambiguous
    /// target, stale ref, nothing matched, unsupported action) is caught
    /// here and turned into `{sent:false, error:{code,message}}` — never a
    /// bare RPC-level error string. That keeps "the target couldn't be
    /// resolved" (nothing was ever attempted) cleanly distinct from "the
    /// action was attempted" at the JSON level the TypeScript side reads.
    /// </summary>
    internal static JsonObject Act(JsonNode? p)
    {
        var excludePids = UiaInspect.ParseExcludePids(p);
        var action = p?["action"]?.GetValue<string>() ?? throw new ArgumentException("Missing required param: action");

        AutomationElement element;
        try
        {
            element = ResolveTarget(p, excludePids);
        }
        catch (StaleRefException ex)
        {
            return NotSent("stale_ref", ex.Message);
        }
        catch (TargetNotFoundException ex)
        {
            return NotSent("not_found", ex.Message);
        }
        catch (AmbiguousTargetException ex)
        {
            var ambiguousResult = NotSent("ambiguous_target", "More than one element matches that target.");
            ambiguousResult["candidates"] = new JsonArray(ex.Candidates.Cast<JsonNode?>().ToArray());
            return ambiguousResult;
        }

        var hwnd = UiaInspect.TryGetHwnd(element);
        var before = DescribeStateSafe(element);
        (bool noop, string via) result;
        try
        {
            result = action switch
            {
                "invoke" => Invoke(element),
                "toggle" => ToggleAction(element, p?["desiredState"]?.GetValue<string>()),
                "set_value" => SetValue(element, p?["value"]?.GetValue<string>() ?? ""),
                "select" => SelectAction(element, p?["option"]?.GetValue<string>()),
                "expand" => ExpandCollapseAction(element, true),
                "collapse" => ExpandCollapseAction(element, false),
                "focus" => FocusAction(element, hwnd),
                "scroll" => ScrollAction(element, p?["direction"]?.GetValue<string>() ?? "down"),
                _ => throw new ArgumentException($"Unknown action: {action}")
            };
        }
        catch (NotActionableException ex)
        {
            var response = NotSent("not_actionable", ex.Message);
            response["element"] = UiaInspectSummaryFor(element);
            response["window"] = UiaInspect.DescribeWindow(hwnd);
            return response;
        }
        catch (UiaTimeoutException ex)
        {
            var response = NotSent("timeout", ex.Message);
            response["element"] = UiaInspectSummaryFor(element);
            response["window"] = UiaInspect.DescribeWindow(hwnd);
            return response;
        }

        var verification = result.noop
            ? new JsonObject { ["status"] = "verified", ["before"] = before, ["after"] = before }
            : Verify(element, action, before);

        return new JsonObject
        {
            ["sent"] = true,
            ["sentVia"] = result.via,
            ["noop"] = result.noop,
            ["verification"] = verification,
            ["element"] = UiaInspectSummaryFor(element),
            ["window"] = UiaInspect.DescribeWindow(hwnd)
        };
    }

    private static JsonObject NotSent(string code, string message) =>
        new() { ["sent"] = false, ["error"] = new JsonObject { ["code"] = code, ["message"] = message } };

    private static AutomationElement ResolveTarget(JsonNode? p, int[] excludePids)
    {
        var target = p?["target"] ?? throw new ArgumentException("Missing required param: target");
        var refId = target["ref"]?.GetValue<string>();
        if (!string.IsNullOrEmpty(refId))
        {
            return ElementRegistry.Resolve(refId) ?? throw new StaleRefException(refId);
        }

        var nth = target["nth"] != null ? (int)target["nth"]!.GetValue<long>() : (int?)null;
        var found = TargetFinder.FindCandidates(target, excludePids);

        if (found.Count == 0) throw new TargetNotFoundException();
        if (nth.HasValue)
        {
            if (nth.Value < 0 || nth.Value >= found.Count) throw new TargetNotFoundException();
            return found[nth.Value];
        }
        if (found.Count > 1)
        {
            throw new AmbiguousTargetException(found.Take(6).Select(UiaInspectSummaryFor).ToList());
        }
        return found[0];
    }

    private static (bool noop, string via) Invoke(AutomationElement element)
    {
        try
        {
            if (element.Patterns.Invoke.IsSupported)
            {
                UiaSession.WithTimeout(() => { element.Patterns.Invoke.Pattern.Invoke(); return true; }, ActionTimeoutMs, "Invoke");
                return (false, "uia:Invoke");
            }
            if (element.Patterns.Toggle.IsSupported)
            {
                element.Patterns.Toggle.Pattern.Toggle();
                return (false, "uia:Toggle");
            }
            if (element.Patterns.SelectionItem.IsSupported)
            {
                element.Patterns.SelectionItem.Pattern.Select();
                return (false, "uia:SelectionItem");
            }
            if (element.Patterns.LegacyIAccessible.IsSupported)
            {
                element.Patterns.LegacyIAccessible.Pattern.DoDefaultAction();
                return (false, "uia:LegacyIAccessible");
            }
            if (element.Patterns.ExpandCollapse.IsSupported)
            {
                var state = element.Patterns.ExpandCollapse.Pattern.ExpandCollapseState.ValueOrDefault;
                if (state == ExpandCollapseState.Collapsed) element.Patterns.ExpandCollapse.Pattern.Expand();
                else element.Patterns.ExpandCollapse.Pattern.Collapse();
                return (false, "uia:ExpandCollapse");
            }
        }
        catch (Exception ex) when (ex is not UiaTimeoutException)
        {
            throw new NotActionableException($"Element doesn't support invoke: {ex.Message}");
        }
        throw new NotActionableException("Element supports no invoke-like pattern (Invoke/Toggle/SelectionItem/LegacyIAccessible/ExpandCollapse).");
    }

    private static (bool noop, string via) ToggleAction(AutomationElement element, string? desiredState)
    {
        if (!element.Patterns.Toggle.IsSupported) throw new NotActionableException("Element doesn't support Toggle.");
        var pattern = element.Patterns.Toggle.Pattern;
        var current = pattern.ToggleState.ValueOrDefault;
        var wantsOn = desiredState == "on";
        var wantsOff = desiredState == "off";
        if (wantsOn && current == ToggleState.On) return (true, "uia:Toggle");
        if (wantsOff && current == ToggleState.Off) return (true, "uia:Toggle");
        UiaSession.WithTimeout(() => { pattern.Toggle(); return true; }, ActionTimeoutMs, "Toggle");
        return (false, "uia:Toggle");
    }

    private static (bool noop, string via) SetValue(AutomationElement element, string value)
    {
        if (element.Patterns.Value.IsSupported && !element.Patterns.Value.Pattern.IsReadOnly.ValueOrDefault)
        {
            if (!UiaInspect.IsPasswordSafe(element) && element.Patterns.Value.Pattern.Value.ValueOrDefault == value)
                return (true, "uia:Value");
            UiaSession.WithTimeout(() => { element.Patterns.Value.Pattern.SetValue(value); return true; }, ActionTimeoutMs, "SetValue");
            return (false, "uia:Value");
        }
        if (element.Patterns.RangeValue.IsSupported && double.TryParse(value, out var numeric))
        {
            UiaSession.WithTimeout(() => { element.Patterns.RangeValue.Pattern.SetValue(numeric); return true; }, ActionTimeoutMs, "RangeValue.SetValue");
            return (false, "uia:Value");
        }
        // Last resort within UIA's own toolkit: focus + select-all + type — still not a coordinate click.
        try
        {
            element.Focus();
            Input.SendKeyChord("Ctrl+A");
            Input.SendUnicodeText(value);
            return (false, "keyboard");
        }
        catch (Exception ex)
        {
            throw new NotActionableException($"Element doesn't support setting a value: {ex.Message}");
        }
    }

    private static (bool noop, string via) SelectAction(AutomationElement element, string? option)
    {
        if (!string.IsNullOrEmpty(option) && element.Patterns.ExpandCollapse.IsSupported)
        {
            // ComboBox-style: expand, find the option among the newly-visible items, select it, collapse.
            var pattern = element.Patterns.ExpandCollapse.Pattern;
            if (pattern.ExpandCollapseState.ValueOrDefault != ExpandCollapseState.Expanded)
                UiaSession.WithTimeout(() => { pattern.Expand(); return true; }, ActionTimeoutMs, "Expand (for select)");
            System.Threading.Thread.Sleep(200);
            var walker = UiaSession.Automation.TreeWalkerFactory.GetControlViewWalker();
            AutomationElement? match = null;
            void Find(AutomationElement node, int depth)
            {
                if (match != null || depth > 10) return;
                try
                {
                    var name = node.Properties.Name.ValueOrDefault ?? "";
                    if (node.Patterns.SelectionItem.IsSupported && name.Contains(option, StringComparison.OrdinalIgnoreCase))
                    {
                        match = node;
                        return;
                    }
                }
                catch { /* ignore */ }
                AutomationElement? child;
                try { child = walker.GetFirstChild(node); } catch { return; }
                while (child != null && match == null)
                {
                    Find(child, depth + 1);
                    try { child = walker.GetNextSibling(child); } catch { break; }
                }
            }
            Find(element, 0);
            if (match == null) { pattern.Collapse(); throw new TargetNotFoundException(); }
            match.Patterns.SelectionItem.Pattern.Select();
            if (pattern.ExpandCollapseState.ValueOrDefault == ExpandCollapseState.Expanded) pattern.Collapse();
            return (false, "uia:SelectionItem");
        }
        if (element.Patterns.SelectionItem.IsSupported)
        {
            if (element.Patterns.SelectionItem.Pattern.IsSelected.ValueOrDefault) return (true, "uia:SelectionItem");
            UiaSession.WithTimeout(() => { element.Patterns.SelectionItem.Pattern.Select(); return true; }, ActionTimeoutMs, "Select");
            return (false, "uia:SelectionItem");
        }
        throw new NotActionableException("Element doesn't support SelectionItem.");
    }

    private static (bool noop, string via) ExpandCollapseAction(AutomationElement element, bool expand)
    {
        if (!element.Patterns.ExpandCollapse.IsSupported) throw new NotActionableException("Element doesn't support ExpandCollapse.");
        var pattern = element.Patterns.ExpandCollapse.Pattern;
        var current = pattern.ExpandCollapseState.ValueOrDefault;
        if (expand && current == ExpandCollapseState.Expanded) return (true, "uia:ExpandCollapse");
        if (!expand && current == ExpandCollapseState.Collapsed) return (true, "uia:ExpandCollapse");
        UiaSession.WithTimeout(() => { if (expand) pattern.Expand(); else pattern.Collapse(); return true; }, ActionTimeoutMs, "ExpandCollapse");
        return (false, "uia:ExpandCollapse");
    }

    private static (bool noop, string via) FocusAction(AutomationElement element, nint hwnd)
    {
        if (hwnd != 0)
        {
            if (NativeMethods.IsIconic(hwnd)) NativeMethods.ShowWindow(hwnd, NativeMethods.SW_RESTORE);
            NativeMethods.SetForegroundWindow(hwnd);
        }
        element.Focus();
        return (false, "uia:Focus");
    }

    private static (bool noop, string via) ScrollAction(AutomationElement element, string direction)
    {
        if (element.Patterns.ScrollItem.IsSupported && direction == "into_view")
        {
            UiaSession.WithTimeout(() => { element.Patterns.ScrollItem.Pattern.ScrollIntoView(); return true; }, ActionTimeoutMs, "ScrollIntoView");
            return (false, "uia:Scroll");
        }
        if (element.Patterns.Scroll.IsSupported)
        {
            var amount = direction == "up" ? ScrollAmount.SmallDecrement : ScrollAmount.SmallIncrement;
            UiaSession.WithTimeout(() => { element.Patterns.Scroll.Pattern.Scroll(ScrollAmount.NoAmount, amount); return true; }, ActionTimeoutMs, "Scroll");
            return (false, "uia:Scroll");
        }
        throw new NotActionableException("Element doesn't support Scroll/ScrollItem.");
    }

    internal static string? DescribeStateSafe(AutomationElement element)
    {
        try
        {
            if (element.Patterns.Toggle.IsSupported) return element.Patterns.Toggle.Pattern.ToggleState.ValueOrDefault.ToString();
            if (element.Patterns.SelectionItem.IsSupported) return element.Patterns.SelectionItem.Pattern.IsSelected.ValueOrDefault ? "Selected" : "NotSelected";
            if (element.Patterns.ExpandCollapse.IsSupported) return element.Patterns.ExpandCollapse.Pattern.ExpandCollapseState.ValueOrDefault.ToString();
            if (element.Patterns.Value.IsSupported && !UiaInspect.IsPasswordSafe(element)) return element.Patterns.Value.Pattern.Value.ValueOrDefault;
        }
        catch { /* best effort */ }
        return null;
    }

    /// <summary>Polls state read-back for up to VerifyTimeoutMs. A miss never throws — the caller reports it as an honest verification status, not a failure. See the plan's "sent vs verified" split.</summary>
    private static JsonObject Verify(AutomationElement element, string action, string? before)
    {
        var isStateAction = action is "toggle" or "select" or "expand" or "collapse" or "set_value";
        var deadline = DateTime.UtcNow.AddMilliseconds(VerifyTimeoutMs);
        string? last = before;
        if (isStateAction)
        {
            while (DateTime.UtcNow < deadline)
            {
                last = DescribeStateSafe(element);
                if (last != before) return new JsonObject { ["status"] = "verified", ["before"] = before, ["after"] = last };
                System.Threading.Thread.Sleep(VerifyPollMs);
            }
            return new JsonObject { ["status"] = "no_effect_observed", ["before"] = before, ["after"] = last };
        }
        // invoke/focus/scroll: no inherent before/after state — a fingerprint diff is the plan's next step (not in this first pass); report not_verifiable rather than pretending.
        return new JsonObject { ["status"] = "not_verifiable", ["before"] = before, ["after"] = (string?)null };
    }

    internal static JsonObject UiaInspectSummaryFor(AutomationElement element)
    {
        var id = ElementRegistry.Register(element);
        return new JsonObject
        {
            ["ref"] = id,
            ["role"] = ElementRegistry.SafeGet(() => element.Properties.ControlType.ValueOrDefault.ToString()),
            ["name"] = ElementRegistry.SafeGet(() => element.Properties.Name.ValueOrDefault)
        };
    }
}
