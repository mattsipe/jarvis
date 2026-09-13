using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

namespace JarvisHelper;

internal static class NativeMethods
{
    [DllImport("user32.dll")]
    internal static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    internal static extern int GetWindowTextLength(nint hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetWindowText(nint hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    internal static extern uint GetWindowThreadProcessId(nint hWnd, out uint processId);

    [DllImport("user32.dll")]
    internal static extern bool GetWindowRect(nint hWnd, out RECT rect);

    [DllImport("user32.dll")]
    internal static extern bool IsWindowVisible(nint hWnd);

    [DllImport("user32.dll")]
    internal static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, nint lParam);

    [DllImport("user32.dll")]
    internal static extern bool SetForegroundWindow(nint hWnd);

    [DllImport("user32.dll")]
    internal static extern bool ShowWindow(nint hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    internal static extern bool IsIconic(nint hWnd);

    [DllImport("user32.dll")]
    internal static extern bool GetCursorPos(out POINT lpPoint);

    internal delegate bool EnumWindowsProc(nint hWnd, nint lParam);

    [StructLayout(LayoutKind.Sequential)]
    internal struct RECT
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct POINT
    {
        public int X, Y;
    }

    internal const int SW_RESTORE = 9;
}

/// <summary>
/// Window/cursor queries backing the "look at this"/"click that" perception
/// flow (Phase 1 only exposes the read side — foregroundWindow/listWindows
/// feed live context and focusWindow replaces AppActivate's title-only
/// matching; clicking is Phase 3/"Operate").
/// </summary>
internal static class WindowInfo
{
    private static JsonObject Describe(nint hwnd)
    {
        var length = NativeMethods.GetWindowTextLength(hwnd);
        var sb = new StringBuilder(length + 1);
        NativeMethods.GetWindowText(hwnd, sb, sb.Capacity + 1);
        NativeMethods.GetWindowThreadProcessId(hwnd, out var pid);
        var processName = "";
        try
        {
            processName = Process.GetProcessById((int)pid).ProcessName;
        }
        catch
        {
            // Process may have exited between EnumWindows and this lookup — fine, just leave it blank.
        }
        NativeMethods.GetWindowRect(hwnd, out var rect);
        return new JsonObject
        {
            ["hwnd"] = (long)hwnd,
            ["title"] = sb.ToString(),
            ["processName"] = processName,
            ["processId"] = (int)pid,
            ["bounds"] = new JsonObject
            {
                ["x"] = rect.Left,
                ["y"] = rect.Top,
                ["width"] = rect.Right - rect.Left,
                ["height"] = rect.Bottom - rect.Top
            }
        };
    }

    internal static JsonObject GetForeground()
    {
        var window = Describe(NativeMethods.GetForegroundWindow());
        NativeMethods.GetCursorPos(out var cursor);
        window["cursor"] = new JsonObject { ["x"] = cursor.X, ["y"] = cursor.Y };
        return window;
    }

    internal static JsonObject ListVisible()
    {
        var windows = new JsonArray();
        NativeMethods.EnumWindows((hwnd, _) =>
        {
            if (!NativeMethods.IsWindowVisible(hwnd)) return true;
            if (NativeMethods.GetWindowTextLength(hwnd) == 0) return true;
            windows.Add(Describe(hwnd));
            return true;
        }, 0);
        return new JsonObject { ["windows"] = windows };
    }

    internal static JsonObject Focus(long hwndValue)
    {
        var hwnd = (nint)hwndValue;
        if (NativeMethods.IsIconic(hwnd)) NativeMethods.ShowWindow(hwnd, NativeMethods.SW_RESTORE);
        var focused = NativeMethods.SetForegroundWindow(hwnd);
        return new JsonObject { ["focused"] = focused };
    }
}
