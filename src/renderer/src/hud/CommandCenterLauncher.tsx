/**
 * Ambient Mode's persistent way to open the Command Center — a real
 * feature (not a dev tool), always present. The global hotkey
 * (JARVIS_COMMAND_CENTER_HOTKEY, default Control+Shift+Space) does the
 * same thing from anywhere.
 */
export default function CommandCenterLauncher(): React.JSX.Element {
  return (
    <button
      onMouseEnter={() => window.jarvis.setInteractive(true)}
      onMouseLeave={() => window.jarvis.setInteractive(false)}
      onClick={() => window.jarvis.toggleCommandCenter()}
      style={{
        position: 'absolute',
        right: 24,
        bottom: 24,
        fontFamily: 'inherit',
        fontSize: 9,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        padding: '8px 14px',
        background: 'rgba(5, 7, 12, 0.55)',
        border: '1px solid var(--jarvis-hairline)',
        color: 'var(--jarvis-cyan)',
        borderRadius: 3,
        cursor: 'pointer',
        pointerEvents: 'auto',
        opacity: 0.7
      }}
    >
      Command Center
    </button>
  )
}
