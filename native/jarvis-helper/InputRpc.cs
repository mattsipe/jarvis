using System.Text.Json.Nodes;

namespace JarvisHelper;

/// <summary>
/// JSON-RPC wrapper around Input.cs — kept separate from the raw SendInput
/// code so Input.cs stays a plain, reusable primitives class. Coordinates
/// here are already physical pixels; converting from a captured image's
/// coordinates into physical pixels is main's job (operate/coords.ts),
/// not this process's.
/// </summary>
internal static class InputRpc
{
    internal static JsonObject SendKeys(string keys)
    {
        Input.SendKeyChord(keys);
        return new JsonObject { ["sent"] = true };
    }

    internal static JsonObject SendText(string text)
    {
        Input.SendUnicodeText(text);
        return new JsonObject { ["sent"] = true };
    }

    internal static JsonObject Pointer(int x, int y, string action, string? button, int scrollDelta)
    {
        switch (action)
        {
            case "click":
                Input.Click(x, y, button ?? "left");
                break;
            case "double_click":
                Input.Click(x, y, button ?? "left", doubleClick: true);
                break;
            case "right_click":
                Input.Click(x, y, "right");
                break;
            case "scroll":
                Input.Scroll(x, y, scrollDelta);
                break;
            default:
                throw new ArgumentException($"Unknown pointer action: {action}");
        }
        return new JsonObject { ["sent"] = true };
    }
}
