import type { CSSProperties, ReactNode } from 'react'

/**
 * Shared panel chrome for the Command Center — hairline border, letterspaced
 * caps title, small monospace body. Deliberately plain (no rounded cards,
 * no drop shadows, no big empty padding) per the plan's "controlled
 * complexity, not a SaaS dashboard" mandate.
 */
export function Panel({
  title,
  children,
  style
}: {
  title: string
  children: ReactNode
  style?: CSSProperties
}): React.JSX.Element {
  return (
    <div
      style={{
        border: '1px solid var(--jarvis-hairline)',
        background: 'rgba(8, 12, 20, 0.5)',
        borderRadius: 2,
        padding: '10px 14px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 0,
        ...style
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--jarvis-cyan)',
          opacity: 0.75,
          flexShrink: 0
        }}
      >
        {title}
      </div>
      <div style={{ flex: 1, overflow: 'auto', fontSize: 12, color: '#c9d8e6', minHeight: 0 }}>{children}</div>
    </div>
  )
}

export function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0' }}>
      <span style={{ opacity: 0.6 }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{value}</span>
    </div>
  )
}

export function EmptyState({ text }: { text: string }): React.JSX.Element {
  return <div style={{ opacity: 0.4, fontStyle: 'italic' }}>{text}</div>
}
