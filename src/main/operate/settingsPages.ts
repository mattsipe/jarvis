/**
 * Allowlisted `ms-settings:` deep links — the structured, tier-1 route
 * into Windows Settings (see PlatformControl.launchInstalledApp for the
 * general app-launch path this sits alongside). A zod enum at the tool
 * boundary (tools/operate.ts) means an arbitrary URI can never reach
 * ShellExecute here — only one of these exact, known-safe pages can.
 */
export const SETTINGS_PAGES = {
  bluetooth: 'ms-settings:bluetooth',
  wifi: 'ms-settings:network-wifi',
  network: 'ms-settings:network',
  display: 'ms-settings:display',
  sound: 'ms-settings:sound',
  notifications: 'ms-settings:notifications',
  apps: 'ms-settings:appsfeatures',
  default_apps: 'ms-settings:defaultapps',
  windows_update: 'ms-settings:windowsupdate',
  personalization: 'ms-settings:personalization',
  power: 'ms-settings:powersleep',
  storage: 'ms-settings:storagesense',
  mouse: 'ms-settings:mousetouchpad',
  keyboard: 'ms-settings:keyboard',
  privacy: 'ms-settings:privacy'
} as const

export type SettingsPageKey = keyof typeof SETTINGS_PAGES

export function settingsPageUri(page: SettingsPageKey): string {
  return SETTINGS_PAGES[page]
}
