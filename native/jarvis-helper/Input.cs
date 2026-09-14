using System.Runtime.InteropServices;

namespace JarvisHelper;

/// <summary>
/// Raw SendInput keyboard/mouse — the last-resort tier of the Operate
/// control ladder (native/structured → UIA → vision+pointer), used only
/// when UIA genuinely can't perform an action. Key-up is always sent from
/// a `finally` block so an exception mid-chord can never leave a modifier
/// key stuck down.
/// </summary>
internal static class Input
{
    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx, dy;
        public uint mouseData, dwFlags, time;
        public nint dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk, wScan;
        public uint dwFlags, time;
        public nint dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion u;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    private const uint InputMouse = 0;
    private const uint InputKeyboard = 1;
    private const uint KeyEventFKeyUp = 0x0002;
    private const uint KeyEventFUnicode = 0x0004;
    private const uint MouseEventFMove = 0x0001;
    private const uint MouseEventFLeftDown = 0x0002;
    private const uint MouseEventFLeftUp = 0x0004;
    private const uint MouseEventFRightDown = 0x0008;
    private const uint MouseEventFRightUp = 0x0010;
    private const uint MouseEventFWheel = 0x0800;
    private const uint MouseEventFAbsolute = 0x8000;
    private const uint MouseEventFVirtualDesk = 0x4000;
    private const int SmXVirtualScreen = 76, SmYVirtualScreen = 77, SmCxVirtualScreen = 78, SmCyVirtualScreen = 79;

    private static readonly Dictionary<string, ushort> NamedKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        ["enter"] = 0x0D, ["return"] = 0x0D, ["tab"] = 0x09, ["escape"] = 0x1B, ["esc"] = 0x1B,
        ["space"] = 0x20, ["backspace"] = 0x08, ["delete"] = 0x2E, ["del"] = 0x2E,
        ["up"] = 0x26, ["down"] = 0x28, ["left"] = 0x25, ["right"] = 0x27,
        ["home"] = 0x24, ["end"] = 0x23, ["pageup"] = 0x21, ["pagedown"] = 0x22,
        ["f1"] = 0x70, ["f2"] = 0x71, ["f3"] = 0x72, ["f4"] = 0x73, ["f5"] = 0x74, ["f6"] = 0x75,
        ["f7"] = 0x76, ["f8"] = 0x77, ["f9"] = 0x78, ["f10"] = 0x79, ["f11"] = 0x7A, ["f12"] = 0x7B
    };

    private static readonly Dictionary<string, ushort> ModifierKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        ["ctrl"] = 0x11, ["control"] = 0x11, ["alt"] = 0x12, ["shift"] = 0x10, ["win"] = 0x5B, ["windows"] = 0x5B
    };

    /// <summary>Parses e.g. "Ctrl+Shift+S" into modifier VKs (pressed down first, released last) plus one final key VK. Throws for an unrecognized key name rather than silently sending nothing.</summary>
    internal static void SendKeyChord(string chord)
    {
        var parts = chord.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0) throw new ArgumentException("Empty key chord.");
        var modifiers = new List<ushort>();
        ushort? finalKey = null;
        foreach (var part in parts)
        {
            if (ModifierKeys.TryGetValue(part, out var modVk)) { modifiers.Add(modVk); continue; }
            finalKey = ResolveKey(part);
        }
        if (finalKey == null) throw new ArgumentException($"No resolvable key in chord: {chord}");

        var pressed = new List<ushort>();
        try
        {
            foreach (var vk in modifiers) { SendKeyEvent(vk, false); pressed.Add(vk); }
            SendKeyEvent(finalKey.Value, false);
            SendKeyEvent(finalKey.Value, true);
        }
        finally
        {
            for (var i = pressed.Count - 1; i >= 0; i--) SendKeyEvent(pressed[i], true);
        }
    }

    private static ushort ResolveKey(string key)
    {
        if (NamedKeys.TryGetValue(key, out var named)) return named;
        if (key.Length == 1)
        {
            var c = char.ToUpperInvariant(key[0]);
            if (c is >= 'A' and <= 'Z' or >= '0' and <= '9') return c;
        }
        throw new ArgumentException($"Unrecognized key name: {key}");
    }

    private static void SendKeyEvent(ushort vk, bool keyUp)
    {
        var input = new INPUT
        {
            type = InputKeyboard,
            u = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = keyUp ? KeyEventFKeyUp : 0, time = 0, dwExtraInfo = 0 } }
        };
        Send(input);
    }

    /// <summary>Types literal text via KEYEVENTF_UNICODE (one keydown+keyup per UTF-16 code unit) — works for any character regardless of keyboard layout, unlike VK-code-based typing.</summary>
    internal static void SendUnicodeText(string text)
    {
        foreach (var ch in text)
        {
            SendUnicodeChar(ch, false);
            SendUnicodeChar(ch, true);
        }
    }

    private static void SendUnicodeChar(char ch, bool keyUp)
    {
        var input = new INPUT
        {
            type = InputKeyboard,
            u = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = KeyEventFUnicode | (keyUp ? KeyEventFKeyUp : 0), time = 0, dwExtraInfo = 0 } }
        };
        Send(input);
    }

    /// <summary>Physical-pixel virtual-desktop coordinates in, absolute 0-65535 normalized coordinates out — the form MOUSEEVENTF_ABSOLUTE|VIRTUALDESK requires. Correct across multiple monitors, including ones at negative offsets.</summary>
    private static (int x, int y) NormalizeToVirtualDesktop(int physicalX, int physicalY)
    {
        var vLeft = GetSystemMetrics(SmXVirtualScreen);
        var vTop = GetSystemMetrics(SmYVirtualScreen);
        var vWidth = GetSystemMetrics(SmCxVirtualScreen);
        var vHeight = GetSystemMetrics(SmCyVirtualScreen);
        var nx = (int)Math.Round((physicalX - vLeft) * 65535.0 / Math.Max(1, vWidth - 1));
        var ny = (int)Math.Round((physicalY - vTop) * 65535.0 / Math.Max(1, vHeight - 1));
        return (nx, ny);
    }

    internal static void MoveTo(int physicalX, int physicalY)
    {
        var (nx, ny) = NormalizeToVirtualDesktop(physicalX, physicalY);
        Send(new INPUT
        {
            type = InputMouse,
            u = new InputUnion { mi = new MOUSEINPUT { dx = nx, dy = ny, mouseData = 0, dwFlags = MouseEventFMove | MouseEventFAbsolute | MouseEventFVirtualDesk, time = 0, dwExtraInfo = 0 } }
        });
    }

    internal static void Click(int physicalX, int physicalY, string button = "left", bool doubleClick = false)
    {
        MoveTo(physicalX, physicalY);
        var (down, up) = button == "right" ? (MouseEventFRightDown, MouseEventFRightUp) : (MouseEventFLeftDown, MouseEventFLeftUp);
        var clicks = doubleClick ? 2 : 1;
        for (var i = 0; i < clicks; i++)
        {
            SendMouseButton(down);
            SendMouseButton(up);
            if (doubleClick && i == 0) System.Threading.Thread.Sleep(50);
        }
    }

    internal static void Scroll(int physicalX, int physicalY, int delta)
    {
        MoveTo(physicalX, physicalY);
        Send(new INPUT
        {
            type = InputMouse,
            u = new InputUnion { mi = new MOUSEINPUT { dx = 0, dy = 0, mouseData = unchecked((uint)(delta * 120)), dwFlags = MouseEventFWheel, time = 0, dwExtraInfo = 0 } }
        });
    }

    private static void SendMouseButton(uint flag)
    {
        Send(new INPUT { type = InputMouse, u = new InputUnion { mi = new MOUSEINPUT { dx = 0, dy = 0, mouseData = 0, dwFlags = flag, time = 0, dwExtraInfo = 0 } } });
    }

    private static void Send(INPUT input)
    {
        var arr = new[] { input };
        var sent = SendInput(1, arr, Marshal.SizeOf<INPUT>());
        if (sent != 1) throw new InvalidOperationException($"SendInput failed (GetLastError={Marshal.GetLastWin32Error()}).");
    }
}
