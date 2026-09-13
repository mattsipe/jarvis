; Overrides electron-builder's default pre-install/pre-uninstall "is the
; app already running?" check (see node_modules/app-builder-lib/templates/
; nsis/include/allowOnlyOneInstallerInstance.nsh — CHECK_APP_RUNNING /
; _CHECK_APP_RUNNING). The stock check runs `tasklist`/`findstr` for a
; matching process name, retries a few times, and if it still sees a match
; gives up with a blocking "JARVIS can't be closed. Please close it
; manually and click Retry to continue." prompt.
;
; Confirmed unreliable on a real machine: it still fired after the app was
; closed, killed in Task Manager, AND the machine was rebooted with JARVIS
; never relaunched. JARVIS is also deliberately tray-resident by design
; (see src/main/window.ts — both windows hide rather than close, and the
; process keeps running until "Quit JARVIS" from the tray), so "already
; running" is JARVIS's normal, expected state whenever the installer runs,
; not an edge case — the stock interactive retry-then-give-up flow was
; always going to be the wrong tool here, and it's actively dangerous for
; an unattended electron-updater install (see update/updater.ts): a
; MessageBox nobody is watching just hangs the update forever.
;
; Force-closing instead is safe: every file JARVIS persists (ContextManager
; store, usage/telemetry, and .env is only ever read, never written by the
; app) is written synchronously on each change — see src/main/context/
; store.ts and src/main/voice/usage.ts — not only flushed at a clean exit.
; `/T` also kills the whole process tree, catching any orphaned Electron
; helper processes (GPU/renderer/utility, which share the same image name
; on Windows) that the stock check's single-process match could miss.
!macro customCheckAppRunning
  DetailPrint "Closing any running JARVIS process..."
  nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 500

  ; Second, related fix: this is also the only hook point that runs before
  ; electron-builder's built-in uninstallOldVersion (see installSection.nsh
  ; — it runs right after this macro, unconditionally, whenever a previous
  ; version is registered). uninstallOldVersion copies the OLD version's
  ; registered uninstaller and silently executes it as part of every
  ; upgrade; if that uninstaller is the corrupted product of a macOS
  ; cross-build (exactly the NSIS integrity-check bug this app hit before
  ; moving builds to native Windows CI), that silent execution can itself
  ; fail after retrying — surfacing this SAME "can't be closed" message a
  ; second, independent way. There's no reliable way to verify a foreign
  ; NSIS binary's integrity from here, so instead we make sure it's never
  ; invoked at all: clearing the previous version's registry entries makes
  ; uninstallOldVersion's own registry read come back empty, which is
  ; already its documented no-op path (see installUtil.nsh). Nothing is
  ; lost by skipping it — the installer immediately overwrites every file
  ; in the same install directory and re-writes fresh registry entries
  ; (installSection.nsh's registryAddInstallInfo) right after, which is a
  ; complete, correct migration on its own.
  DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  DeleteRegKey SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}"
!macroend
