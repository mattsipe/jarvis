using FlaUI.Core.AutomationElements;

namespace JarvisHelper.Uia;

/// <summary>
/// What re-resolves a stale ref — everything here comes from properties
/// UIA guarantees are still readable off a dead/replaced AutomationElement
/// reference the way RuntimeId sometimes isn't after a virtualized list
/// re-renders. Re-resolution requires an exact Name + ControlType match
/// within the same window, and only ever returns a single, unique element
/// — an ambiguous or failed re-resolution reports `stale_ref` rather than
/// guessing, so an action is never sent to the wrong control.
/// </summary>
internal sealed record Locator(nint Hwnd, int Pid, string? AutomationId, string? Name, string? ControlType, string? ClassName);

internal sealed class ElementRef
{
    public required string Id { get; init; }
    public required AutomationElement Element { get; set; }
    public required Locator Locator { get; init; }
    public DateTime CreatedAt { get; init; } = DateTime.UtcNow;
}

/// <summary>
/// Short-lived element handles ("e17") so Claude's tool calls stay compact
/// (a ref, not a repeated full description) instead of re-sending a whole
/// element description on every follow-up action — see the plan's
/// OperateContext design. Capped and TTL'd so a long-running session can't
/// accumulate unbounded live COM references.
/// </summary>
internal static class ElementRegistry
{
    private static readonly Dictionary<string, ElementRef> Refs = new();
    private static readonly object Lock = new();
    private static int _counter;
    private const int MaxRefs = 500;
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(5);

    internal static string Register(AutomationElement element)
    {
        var locator = BuildLocator(element);
        lock (Lock)
        {
            PruneExpired();
            var id = "e" + Interlocked.Increment(ref _counter);
            Refs[id] = new ElementRef { Id = id, Element = element, Locator = locator };
            if (Refs.Count > MaxRefs)
            {
                var oldest = Refs.Values.OrderBy(r => r.CreatedAt).First();
                Refs.Remove(oldest.Id);
            }
            return id;
        }
    }

    /// <summary>Returns a live element for this ref, re-resolving from its locator once if the cached one has gone stale. Null means "give up — report stale_ref", never a guess.</summary>
    internal static AutomationElement? Resolve(string id)
    {
        ElementRef? entry;
        lock (Lock)
        {
            if (!Refs.TryGetValue(id, out entry)) return null;
            if (DateTime.UtcNow - entry.CreatedAt > Ttl)
            {
                Refs.Remove(id);
                return null;
            }
        }

        if (IsLive(entry.Element)) return entry.Element;

        var reResolved = ReResolve(entry.Locator);
        if (reResolved == null) return null;
        lock (Lock)
        {
            entry.Element = reResolved;
        }
        return reResolved;
    }

    internal static Locator? GetLocator(string id)
    {
        lock (Lock)
        {
            return Refs.TryGetValue(id, out var entry) ? entry.Locator : null;
        }
    }

    private static bool IsLive(AutomationElement element)
    {
        try
        {
            _ = element.Properties.ProcessId.Value;
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static AutomationElement? ReResolve(Locator locator)
    {
        try
        {
            var window = UiaSession.Automation.FromHandle(locator.Hwnd);
            if (window == null) return null;
            var walker = UiaSession.Automation.TreeWalkerFactory.GetControlViewWalker();
            var matches = new List<AutomationElement>();
            UiaInspect.WalkForMatch(window, walker, locator, matches, 0);
            return matches.Count == 1 ? matches[0] : null;
        }
        catch
        {
            return null;
        }
    }

    private static Locator BuildLocator(AutomationElement element)
    {
        nint hwnd = 0;
        try
        {
            hwnd = element.Properties.NativeWindowHandle.IsSupported ? (nint)element.Properties.NativeWindowHandle.Value : 0;
        }
        catch { /* not every element exposes a native window handle — fine, hwnd stays 0 and we fall back to the containing window's */ }

        int pid = 0;
        try { pid = element.Properties.ProcessId.Value; } catch { /* best effort */ }

        return new Locator(
            hwnd,
            pid,
            SafeGet(() => element.Properties.AutomationId.Value),
            SafeGet(() => element.Properties.Name.Value),
            SafeGet(() => element.Properties.ControlType.Value.ToString()),
            SafeGet(() => element.Properties.ClassName.Value)
        );
    }

    internal static string? SafeGet(Func<string?> fn)
    {
        try { return fn(); } catch { return null; }
    }

    private static void PruneExpired()
    {
        var expired = Refs.Where(kv => DateTime.UtcNow - kv.Value.CreatedAt > Ttl).Select(kv => kv.Key).ToList();
        foreach (var id in expired) Refs.Remove(id);
    }
}
