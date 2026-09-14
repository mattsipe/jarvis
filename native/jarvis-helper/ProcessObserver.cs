using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

namespace JarvisHelper;

internal static class NativeProcessMethods
{
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern nint OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(nint handle);

    // Documented since Windows 8 — returns the AppUserModelID of a
    // running process, the one clean, simple (single P/Invoke, no custom
    // COM interfaces/vtables) way to positively identify a packaged/
    // Click-to-Run app's process by the same id used to launch it.
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetApplicationUserModelId(nint hProcess, ref uint applicationUserModelIdLength, StringBuilder applicationUserModelId);

    internal const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
}

/// <summary>
/// Confirms a launch by watching for the expected *process*, never "any
/// new window" — a real-PC regression found the old window-based check
/// couldn't tell Excel's own launch from an unrelated window appearing,
/// and reported a false failure when Excel reused an already-running
/// instance (no new window OR process appears at all in that case, which
/// is exactly the 'existing-instance' case this returns instead of
/// treating as a miss).
/// </summary>
internal static class ProcessObserver
{
    internal sealed class Snapshot
    {
        public required HashSet<int> Pids { get; init; }
        public required Dictionary<int, string> Names { get; init; }
    }

    internal static Snapshot Capture()
    {
        var pids = new HashSet<int>();
        var names = new Dictionary<int, string>();
        foreach (var p in Process.GetProcesses())
        {
            try
            {
                pids.Add(p.Id);
                names[p.Id] = p.ProcessName;
            }
            catch
            {
                // Process may have exited between enumeration and reading its name — fine, just skip it.
            }
            finally
            {
                p.Dispose();
            }
        }
        return new Snapshot { Pids = pids, Names = names };
    }

    internal static string? TryGetAumid(int pid)
    {
        var handle = NativeProcessMethods.OpenProcess(NativeProcessMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle == 0) return null;
        try
        {
            uint length = 130;
            var sb = new StringBuilder((int)length);
            var hr = NativeProcessMethods.GetApplicationUserModelId(handle, ref length, sb);
            return hr == 0 ? sb.ToString() : null;
        }
        catch
        {
            return null;
        }
        finally
        {
            NativeProcessMethods.CloseHandle(handle);
        }
    }

    /// <summary>
    /// Checks for an already-running match first (no reason to wait for
    /// that), then polls for a genuinely new process for up to
    /// `timeoutMs`. Matches by exe name (path-style targets) or by AUMID
    /// (AppsFolder targets) — whichever `expected*` argument is non-null.
    /// Never treats "nothing observed in time" as a failure; the caller
    /// (windows.ts) maps that to an honest "accepted, unverified" outcome.
    /// </summary>
    internal static JsonObject Observe(Snapshot before, string? expectedImageName, string? expectedAumid, int timeoutMs)
    {
        if (expectedImageName != null)
        {
            foreach (var kv in before.Names)
            {
                if (string.Equals(kv.Value, expectedImageName, StringComparison.OrdinalIgnoreCase))
                    return Result("existing-instance", kv.Key, kv.Value);
            }
        }
        if (expectedAumid != null)
        {
            foreach (var pid in before.Pids)
            {
                if (string.Equals(TryGetAumid(pid), expectedAumid, StringComparison.OrdinalIgnoreCase))
                    return Result("existing-instance", pid, before.Names.GetValueOrDefault(pid, ""));
            }
        }

        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            Thread.Sleep(400);
            var current = Process.GetProcesses();
            try
            {
                foreach (var p in current)
                {
                    if (before.Pids.Contains(p.Id)) continue;
                    string name;
                    try { name = p.ProcessName; }
                    catch { continue; }

                    var nameMatches = expectedImageName != null && string.Equals(name, expectedImageName, StringComparison.OrdinalIgnoreCase);
                    var aumidMatches = !nameMatches && expectedAumid != null && string.Equals(TryGetAumid(p.Id), expectedAumid, StringComparison.OrdinalIgnoreCase);
                    if (nameMatches || aumidMatches) return Result("confirmed", p.Id, name);
                }
            }
            finally
            {
                foreach (var p in current) p.Dispose();
            }
        }

        return new JsonObject { ["confidence"] = "unverified" };
    }

    private static JsonObject Result(string confidence, int pid, string name) =>
        new() { ["confidence"] = confidence, ["pid"] = pid, ["processName"] = name };
}
