using System.Text;
using FlaUI.Core.AutomationElements;
using FlaUI.UIA3;

namespace JarvisHelper.Uia;

internal sealed class StaleRefException(string refId) : Exception($"Element ref '{refId}' is stale or unknown.");
internal sealed class UiaTimeoutException(string what, int ms) : Exception($"{what} timed out after {ms}ms.");

/// <summary>
/// One shared UIA3Automation instance for the helper's lifetime — cheap to
/// reuse, and FlaUI/UIA3 COM objects are safe to call from any thread once
/// created (no STA requirement here, unlike the removed
/// IApplicationActivationManager code). `WithTimeout` bounds a UIA call
/// from the caller's side: a single blocked COM call can't truly be
/// cancelled mid-flight, but the request this came from still gets a
/// timely error response instead of hanging the whole round-trip — and
/// since Program.cs dispatches every request on its own thread, a stuck
/// call here never blocks any other in-flight request either.
/// </summary>
internal static class UiaSession
{
    private static readonly Lazy<UIA3Automation> AutomationLazy = new(() => new UIA3Automation());
    internal static UIA3Automation Automation => AutomationLazy.Value;

    internal static T WithTimeout<T>(Func<T> fn, int timeoutMs, string what = "UI Automation call")
    {
        var task = Task.Run(fn);
        if (!task.Wait(timeoutMs)) throw new UiaTimeoutException(what, timeoutMs);
        return task.GetAwaiter().GetResult();
    }

    internal static void WithTimeout(Action fn, int timeoutMs, string what = "UI Automation call") =>
        WithTimeout<object?>(() => { fn(); return null; }, timeoutMs, what);
}

/// <summary>
/// Resolves the window/root element an Operate call should act on — never
/// guessed, always one of: an explicit hwnd, a title substring match, or
/// "active" (the real foreground window, skipping any hwnd whose owning
/// process is in `excludePids` — JARVIS's own Electron windows, so
/// Command Center being focused while you use the Operate Lab never makes
/// JARVIS try to operate on itself).
/// </summary>
internal static class WindowResolver
{
    internal static nint ResolveHwnd(string? windowSpec, int[] excludePids)
    {
        if (string.IsNullOrEmpty(windowSpec) || windowSpec == "active")
        {
            var hwnd = FindActiveHwnd(excludePids);
            if (hwnd == 0) throw new InvalidOperationException("No active window found (or only JARVIS's own windows are open).");
            return hwnd;
        }
        if (long.TryParse(windowSpec, out var hwndValue) && hwndValue != 0)
        {
            return (nint)hwndValue;
        }
        var found = FindHwndByTitle(windowSpec, excludePids);
        if (found == null) throw new InvalidOperationException($"No open window matches \"{windowSpec}\".");
        return found.Value;
    }

    internal static Window ResolveWindow(string? windowSpec, int[] excludePids)
    {
        var hwnd = ResolveHwnd(windowSpec, excludePids);
        var element = UiaSession.Automation.FromHandle(hwnd);
        return element?.AsWindow() ?? throw new InvalidOperationException("Could not attach UI Automation to that window.");
    }

    private static nint FindActiveHwnd(int[] excludePids)
    {
        var fg = NativeMethods.GetForegroundWindow();
        NativeMethods.GetWindowThreadProcessId(fg, out var pid);
        if (fg != 0 && !excludePids.Contains((int)pid)) return fg;

        nint found = 0;
        NativeMethods.EnumWindows((h, _) =>
        {
            if (!NativeMethods.IsWindowVisible(h)) return true;
            if (NativeMethods.GetWindowTextLength(h) == 0) return true;
            NativeMethods.GetWindowThreadProcessId(h, out var p2);
            if (excludePids.Contains((int)p2)) return true;
            found = h;
            return false; // EnumWindows enumerates in top-to-bottom z-order — first non-excluded match wins.
        }, 0);
        return found;
    }

    private static nint? FindHwndByTitle(string title, int[] excludePids)
    {
        nint found = 0;
        NativeMethods.EnumWindows((h, _) =>
        {
            if (!NativeMethods.IsWindowVisible(h)) return true;
            var len = NativeMethods.GetWindowTextLength(h);
            if (len == 0) return true;
            NativeMethods.GetWindowThreadProcessId(h, out var pid);
            if (excludePids.Contains((int)pid)) return true;
            var sb = new StringBuilder(len + 1);
            NativeMethods.GetWindowText(h, sb, sb.Capacity + 1);
            if (sb.ToString().Contains(title, StringComparison.OrdinalIgnoreCase))
            {
                found = h;
                return false;
            }
            return true;
        }, 0);
        return found == 0 ? null : found;
    }
}
