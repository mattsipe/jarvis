import { useEffect, useState } from 'react'
import { Panel, Row } from './Panel'

interface ServicesStatus {
  anthropic: boolean
  elevenlabs: boolean
  deepgram: boolean
}

interface ConfigDiagnostics {
  configDir: string
  envPath: string
  envFound: boolean
  envFileUsed: string | null
  envLoadError: string | null
  migratedFrom: string | null
  claudeKeyLoaded: boolean
  deepgramKeyLoaded: boolean
  elevenLabsKeyLoaded: boolean
}

function statusLabel(ok: boolean): string {
  return ok ? 'CONNECTED' : 'NOT CONFIGURED'
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  fontFamily: 'inherit',
  fontSize: 11,
  background: 'rgba(0,0,0,0.35)',
  border: '1px solid var(--jarvis-hairline)',
  color: '#e6f2ff',
  borderRadius: 2,
  padding: '5px 7px'
}

/**
 * Config diagnostics + an in-app way to set the three API keys, so a
 * missing/misplaced/mis-encoded .env on a machine we can't see never has to
 * end in "go hunt through AppData by hand" — see saveApiKeys in
 * main/config.ts. Opens the editor automatically the first time any key is
 * missing; otherwise it's a click away.
 */
export default function IntegrationsPanel(): React.JSX.Element {
  const [services, setServices] = useState<ServicesStatus | null>(null)
  const [diagnostics, setDiagnostics] = useState<ConfigDiagnostics | null>(null)
  const [editing, setEditing] = useState(false)
  const [autoOpened, setAutoOpened] = useState(false)
  const [form, setForm] = useState({ anthropic: '', deepgram: '', elevenlabs: '' })
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)

  const refresh = (): void => {
    window.jarvis.getServicesStatus().then(setServices)
    window.jarvis.getConfigDiagnostics().then((d) => {
      const diag = d as ConfigDiagnostics
      setDiagnostics(diag)
      if (!autoOpened) {
        setAutoOpened(true)
        if (!diag.claudeKeyLoaded || !diag.deepgramKeyLoaded || !diag.elevenLabsKeyLoaded) setEditing(true)
      }
    })
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async (): Promise<void> => {
    setSaveState('saving')
    setSaveError(null)
    try {
      const keys: { anthropic?: string; deepgram?: string; elevenlabs?: string } = {}
      if (form.anthropic) keys.anthropic = form.anthropic
      if (form.deepgram) keys.deepgram = form.deepgram
      if (form.elevenlabs) keys.elevenlabs = form.elevenlabs
      await window.jarvis.saveApiKeys(keys)
      setForm({ anthropic: '', deepgram: '', elevenlabs: '' })
      setSaveState('saved')
      refresh()
      setTimeout(() => setSaveState('idle'), 3000)
    } catch (err) {
      setSaveState('error')
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Panel title="Integrations">
      <Row label="Claude" value={services ? statusLabel(services.anthropic) : '…'} />
      <Row label="Deepgram (STT)" value={services ? statusLabel(services.deepgram) : '…'} />
      <Row label="ElevenLabs (TTS)" value={services ? statusLabel(services.elevenlabs) : '…'} />

      {diagnostics && (
        <>
          <div style={{ height: 6 }} />
          <Row label="Config dir" value={diagnostics.configDir} />
          <Row label=".env found" value={diagnostics.envFound ? 'YES' : 'NO'} />
          {diagnostics.migratedFrom && <Row label="Migrated from" value={diagnostics.migratedFrom} />}
          {diagnostics.envLoadError && (
            <div style={{ color: 'var(--jarvis-amber)', fontSize: 11, padding: '4px 0' }}>
              .env error: {diagnostics.envLoadError}
            </div>
          )}
        </>
      )}

      <div style={{ height: 8 }} />
      <button
        onClick={() => setEditing((v) => !v)}
        style={{
          fontFamily: 'inherit',
          fontSize: 10,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          padding: '5px 10px',
          background: 'rgba(79, 216, 255, 0.1)',
          border: '1px solid var(--jarvis-hairline)',
          color: 'var(--jarvis-cyan)',
          borderRadius: 2,
          cursor: 'pointer'
        }}
      >
        {editing ? 'Hide API Keys' : 'Edit API Keys'}
      </button>

      {editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          <label style={{ fontSize: 10, opacity: 0.6 }}>
            Claude API key
            <input
              type="password"
              placeholder={diagnostics?.claudeKeyLoaded ? 'Already set — leave blank to keep' : 'sk-ant-...'}
              value={form.anthropic}
              onChange={(e) => setForm((f) => ({ ...f, anthropic: e.target.value }))}
              style={{ ...inputStyle, marginTop: 3 }}
            />
          </label>
          <label style={{ fontSize: 10, opacity: 0.6 }}>
            Deepgram API key
            <input
              type="password"
              placeholder={diagnostics?.deepgramKeyLoaded ? 'Already set — leave blank to keep' : ''}
              value={form.deepgram}
              onChange={(e) => setForm((f) => ({ ...f, deepgram: e.target.value }))}
              style={{ ...inputStyle, marginTop: 3 }}
            />
          </label>
          <label style={{ fontSize: 10, opacity: 0.6 }}>
            ElevenLabs API key
            <input
              type="password"
              placeholder={diagnostics?.elevenLabsKeyLoaded ? 'Already set — leave blank to keep' : ''}
              value={form.elevenlabs}
              onChange={(e) => setForm((f) => ({ ...f, elevenlabs: e.target.value }))}
              style={{ ...inputStyle, marginTop: 3 }}
            />
          </label>
          <button
            onClick={save}
            disabled={saveState === 'saving'}
            style={{
              fontFamily: 'inherit',
              fontSize: 10,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              padding: '6px 10px',
              marginTop: 4,
              background: 'rgba(59, 240, 192, 0.12)',
              border: '1px solid var(--jarvis-emerald)',
              color: 'var(--jarvis-emerald)',
              borderRadius: 2,
              cursor: saveState === 'saving' ? 'default' : 'pointer'
            }}
          >
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Save Keys'}
          </button>
          {saveState === 'error' && (
            <div style={{ color: 'var(--jarvis-amber)', fontSize: 11 }}>Failed to save: {saveError}</div>
          )}
        </div>
      )}
    </Panel>
  )
}
