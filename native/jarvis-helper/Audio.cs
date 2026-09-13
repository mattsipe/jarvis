using System;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace JarvisHelper;

/// <summary>
/// Core Audio (IAudioEndpointVolume) vtable, declared in the exact real
/// order (Endpointvolume.h) starting after the 3 implicit IUnknown slots.
///
/// The version of this interface previously embedded as inline PowerShell
/// C# (src/main/platform/windows.ts) was missing one placeholder slot
/// (GetChannelVolumeLevelScalar, real vtable slot 13) between
/// GetChannelVolumeLevel and SetMute. That off-by-one meant its "SetMute"
/// call actually invoked the real GetChannelVolumeLevelScalar (slot 13),
/// and its "GetMute" call actually invoked the real SetMute (slot 14) —
/// wrong methods entirely, with mismatched argument types marshaled into
/// them. Every slot is declared here (even though only the last two are
/// ever called) specifically so this can't happen again.
/// </summary>
[ComImport]
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioEndpointVolume
{
    int RegisterControlChangeNotify_NotUsed();      // slot 3
    int UnregisterControlChangeNotify_NotUsed();     // slot 4
    int GetChannelCount(out uint channelCount);      // slot 5
    int SetMasterVolumeLevel_NotUsed();              // slot 6
    int SetMasterVolumeLevelScalar(float level, Guid eventContext);  // slot 7
    int GetMasterVolumeLevel_NotUsed();              // slot 8
    int GetMasterVolumeLevelScalar(out float level); // slot 9
    int SetChannelVolumeLevel_NotUsed();             // slot 10
    int SetChannelVolumeLevelScalar_NotUsed();       // slot 11
    int GetChannelVolumeLevel_NotUsed();              // slot 12
    int GetChannelVolumeLevelScalar_NotUsed();        // slot 13 — the slot the old code was missing
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid eventContext); // slot 14
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);                // slot 15
}

[ComImport]
[Guid("D666063F-1587-4E43-81F1-B948E807363F")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDevice
{
    int Activate(ref Guid id, int clsCtx, nint activationParams, out IAudioEndpointVolume endpoint);
}

[ComImport]
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceEnumerator
{
    int NotUsed_EnumAudioEndpoints();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport]
[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
internal class MMDeviceEnumeratorComObject
{
}

internal static class Audio
{
    private static IAudioEndpointVolume GetVolumeObject()
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        enumerator.GetDefaultAudioEndpoint(/* eRender */ 0, /* eMultimedia */ 1, out var device);
        var iid = typeof(IAudioEndpointVolume).GUID;
        device.Activate(ref iid, /* CLSCTX_ALL */ 23, 0, out var endpoint);
        return endpoint;
    }

    internal static JsonObject Get()
    {
        var v = GetVolumeObject();
        v.GetMasterVolumeLevelScalar(out var level);
        v.GetMute(out var muted);
        return new JsonObject { ["volumePercent"] = Math.Round(level * 100), ["muted"] = muted };
    }

    internal static JsonObject SetVolume(double percent)
    {
        var clamped = Math.Clamp(percent, 0, 100) / 100f;
        var v = GetVolumeObject();
        v.SetMasterVolumeLevelScalar((float)clamped, Guid.Empty);
        return new JsonObject { ["volumePercent"] = Math.Round(clamped * 100) };
    }

    internal static JsonObject SetMute(bool muted)
    {
        var v = GetVolumeObject();
        v.SetMute(muted, Guid.Empty);
        return new JsonObject { ["muted"] = muted };
    }
}
