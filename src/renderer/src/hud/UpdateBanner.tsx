import { useUpdateStore } from '../state/updateStore'

/**
 * Update-state indicator for the Command Center (see the deployment-
 * reliability priority: checking / available / downloading / ready /
 * failed must all be visible, not silent). Sits top-right so it never
 * collides with ErrorBanner's centered voice errors.
 */
export default function UpdateBanner(): React.JSX.Element | null {
  const { phase, percent, version, message } = useUpdateStore()
  if (phase === 'idle' || phase === 'not-available') return null

  const label =
    phase === 'checking'
      ? 'Checking for updates…'
      : phase === 'available'
        ? `Update ${version} found — downloading…`
        : phase === 'downloading'
          ? `Downloading update — ${percent}%`
          : phase === 'ready'
            ? `Update ${version} ready`
            : `Update check failed — ${message}`

  const isError = phase === 'error'
  const isReady = phase === 'ready'

  return (
    <div
      style={{
        position: 'absolute',
        right: 18,
        top: 56,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 14px',
        border: `1px solid ${isError ? 'var(--jarvis-amber)' : 'var(--jarvis-cyan)'}`,
        background: 'rgba(8, 12, 20, 0.85)',
        backdropFilter: 'blur(8px)',
        borderRadius: 4,
        pointerEvents: 'auto',
        maxWidth: 340,
        zIndex: 50,
        fontSize: 11,
        color: isError ? '#ffd9c9' : '#c9d8e6'
      }}
    >
      <span>{label}</span>
      {isReady && (
        <button
          onClick={() => window.jarvis.installUpdate()}
          style={{
            fontFamily: 'inherit',
            fontSize: 10,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            padding: '4px 10px',
            background: 'rgba(79, 216, 255, 0.12)',
            border: '1px solid var(--jarvis-cyan)',
            color: 'var(--jarvis-cyan)',
            borderRadius: 3,
            cursor: 'pointer',
            whiteSpace: 'nowrap'
          }}
        >
          Restart JARVIS
        </button>
      )}
    </div>
  )
}
