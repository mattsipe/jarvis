using System.Text.Json.Nodes;
using FlaUI.Core.AutomationElements;

namespace JarvisHelper.Uia;

/// <summary>Shared locator-target search used by both UiaActions (which requires exactly one match, or a ref) and UiaWait (which just polls for zero-vs-nonzero/matching matches) — kept in one place so both always resolve a `Target` identically.</summary>
internal static class TargetFinder
{
    internal static List<AutomationElement> FindCandidates(JsonNode target, int[] excludePids, int maxResults = 20)
    {
        var windowSpec = target["window"]?.GetValue<string>();
        var name = target["name"]?.GetValue<string>();
        var role = target["role"]?.GetValue<string>();
        var automationId = target["automationId"]?.GetValue<string>();

        var window = WindowResolver.ResolveWindow(windowSpec, excludePids);
        var walker = UiaSession.Automation.TreeWalkerFactory.GetControlViewWalker();
        var found = new List<AutomationElement>();

        void Walk(AutomationElement node, int depth)
        {
            if (depth > 25 || found.Count >= maxResults) return;
            try
            {
                var elName = node.Properties.Name.ValueOrDefault ?? "";
                var elAid = node.Properties.AutomationId.ValueOrDefault ?? "";
                var elRole = node.Properties.ControlType.ValueOrDefault.ToString();
                var nameOk = string.IsNullOrEmpty(name) || elName.Contains(name, StringComparison.OrdinalIgnoreCase);
                var aidOk = string.IsNullOrEmpty(automationId) || elAid == automationId;
                var roleOk = string.IsNullOrEmpty(role) || string.Equals(elRole, role, StringComparison.OrdinalIgnoreCase);
                var hasAnyCriterion = !string.IsNullOrEmpty(name) || !string.IsNullOrEmpty(automationId) || !string.IsNullOrEmpty(role);
                if (hasAnyCriterion && nameOk && aidOk && roleOk) found.Add(node);
            }
            catch { /* element disappeared mid-walk */ }
            AutomationElement? child;
            try { child = walker.GetFirstChild(node); } catch { return; }
            while (child != null && found.Count < maxResults)
            {
                Walk(child, depth + 1);
                try { child = walker.GetNextSibling(child); } catch { break; }
            }
        }

        UiaSession.WithTimeout(() => { Walk(window, 0); return true; }, 4000, "target search");
        return found;
    }
}
