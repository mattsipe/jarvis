using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace JarvisHelper;

/// <summary>
/// The real Windows AppUserModelID activation API
/// (IApplicationActivationManager, documented in shobjidl.h) — the same
/// mechanism Explorer itself uses internally for "shell:AppsFolder\..."
/// navigation, called directly via COM instead of shelling out to
/// explorer.exe. Well-known, stable GUIDs (unchanged since Windows 8).
/// </summary>
[Flags]
internal enum ActivateOptions
{
    None = 0x00000000,
    NoErrorUI = 0x00000002,
    NoSplashScreen = 0x00000004
}

[ComImport]
[Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IApplicationActivationManager
{
    [PreserveSig]
    int ActivateApplication(
        [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [MarshalAs(UnmanagedType.LPWStr)] string? arguments,
        ActivateOptions options,
        out uint processId);
}

[ComImport]
[Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
internal class ApplicationActivationManagerClass
{
}

/// <summary>
/// Native app launching — used by windows.ts in place of PowerShell
/// Start-Process/explorer.exe shell:AppsFolder wherever the helper is
/// running (falls back to PowerShell only if it isn't — see
/// platform/helper.ts). Both paths here give a real, synchronous
/// success/failure signal: Process.Start throws a Win32Exception with a
/// specific reason on failure, and ActivateApplication's HRESULT is
/// checked explicitly — neither depends on guessing from a shell
/// command's exit code the way Start-Process/explorer.exe did, which is
/// exactly what let "resolved but didn't actually launch" bugs (Excel,
/// and — per real-PC report — New Outlook) go unnoticed at the
/// PowerShell layer.
/// </summary>
internal static class AppLauncher
{
    /// <summary>
    /// A real filesystem target: a .exe, a .lnk shortcut, or anything
    /// else Windows has a shell association for. UseShellExecute=true
    /// gives full ShellExecute semantics (shortcut resolution, file
    /// associations, requested elevation), not just "spawn this exact
    /// binary" — the same thing Explorer does when you double-click it,
    /// unlike PowerShell's Start-Process which is close but not identical.
    /// </summary>
    internal static JsonObject LaunchExe(string path, string? arguments)
    {
        var psi = new ProcessStartInfo(path) { UseShellExecute = true };
        if (!string.IsNullOrEmpty(arguments)) psi.Arguments = arguments;
        // Throws Win32Exception (e.g. "The system cannot find the file
        // specified") on real failure — a specific, native reason, not a
        // PowerShell CLIXML dump.
        var process = Process.Start(psi);
        // A null return isn't necessarily a failure: some shell
        // associations hand off to an already-running instance via DDE
        // and never give ShellExecute a process handle at all.
        return new JsonObject { ["processId"] = process?.Id };
    }

    /// <summary>
    /// A packaged/UWP/MSIX AppUserModelID — covers true UWP apps, Windows'
    /// own built-in packaged apps (Settings, Calculator, ...), and
    /// Click-to-Run-style Office AppIDs (Microsoft.Office.EXCEL.EXE.15 and
    /// siblings), all of which activate through this same API regardless
    /// of which of those categories they fall into.
    /// </summary>
    internal static JsonObject LaunchAumid(string appUserModelId)
    {
        var manager = (IApplicationActivationManager)new ApplicationActivationManagerClass();
        var hr = manager.ActivateApplication(appUserModelId, null, ActivateOptions.None, out var processId);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        return new JsonObject { ["processId"] = (long)processId };
    }
}
