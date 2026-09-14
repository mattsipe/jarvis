using System.Diagnostics;
using System.Text.Json.Nodes;

namespace JarvisHelper;

/// <summary>
/// Native app launching — used by windows.ts in place of PowerShell
/// Start-Process/explorer.exe. A real-PC regression traced two distinct
/// bugs to the previous version of this file:
///
/// 1. AppsFolder targets (packaged/UWP apps, and Click-to-Run Office
///    AppIDs like "Microsoft.Office.EXCEL.EXE.15") were activated via
///    IApplicationActivationManager::ActivateApplication — the correct
///    contract for a true packaged app's activation handshake, but the
///    WRONG one for a Click-to-Run desktop app, which never answers that
///    handshake. The call could block for the full helper timeout before
///    failing, even though Windows had already started EXCEL.EXE fine.
///    Fixed by using plain ShellExecute on the "shell:AppsFolder\&lt;id&gt;"
///    virtual shell path instead — exactly what Explorer/Start do when
///    you click an AppsFolder item, and exactly what
///    "explorer.exe shell:AppsFolder\..." did before, just done in-process
///    via ProcessStartInfo/UseShellExecute instead of shelling out to
///    explorer.exe. This removes the custom COM activation contract
///    entirely, along with its failure mode.
/// 2. That blocking call, combined with Program.cs's old one-request-at-a-
///    time read loop, could delay unrelated requests queued behind it.
///    Program.cs now dispatches every request on its own thread, so this
///    is defended in depth even though the ShellExecute-only path above
///    should no longer block noticeably at all.
///
/// Both launch kinds (a real path, or an AppsFolder id) now return
/// through the same method, which also drives process-identity
/// observation (ProcessObserver.cs) — never "any new window", which
/// can't tell one app's launch from another's and misses an app (like
/// Office) reusing an already-running instance.
/// </summary>
internal static class AppLauncher
{
    internal static JsonObject LaunchInstalledApp(string target, bool isPath, string? arguments, int observeTimeoutMs)
    {
        var before = ProcessObserver.Capture();

        var psi = isPath
            ? new ProcessStartInfo(target) { UseShellExecute = true }
            : new ProcessStartInfo("shell:AppsFolder\\" + target) { UseShellExecute = true };
        if (!string.IsNullOrEmpty(arguments)) psi.Arguments = arguments;

        // Throws (Win32Exception, a specific native reason like "The
        // system cannot find the file specified") on real failure — never
        // silently swallowed the way a shell command's exit code can be.
        Process.Start(psi);

        var expectedImageName = isPath ? Path.GetFileNameWithoutExtension(target) : null;
        var expectedAumid = isPath ? null : target;
        return ProcessObserver.Observe(before, expectedImageName, expectedAumid, observeTimeoutMs);
    }
}
