import { useEffect, useRef } from 'react'
import { JarvisCore } from './core/JarvisCore'
import { useHudStore } from '../state/hudStore'
import { subscribeAmplitude } from './core/amplitudeBus'

export const CORE_BOX_PX = 900

/** Mounts the three.js core and keeps it in sync with the HUD state store. */
export default function Core(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const coreRef = useRef<JarvisCore | null>(null)
  const state = useHudStore((s) => s.state)
  const presentationMode = useHudStore((s) => s.presentationMode)

  useEffect(() => {
    if (!canvasRef.current) return
    const core = new JarvisCore(canvasRef.current, CORE_BOX_PX, CORE_BOX_PX)
    coreRef.current = core
    const unsubscribe = subscribeAmplitude((amplitude) => {
      core.setExternalAmplitude(amplitude)
    })
    return () => {
      unsubscribe()
      core.dispose()
      coreRef.current = null
    }
  }, [])

  useEffect(() => {
    coreRef.current?.setState(state)
  }, [state])

  useEffect(() => {
    coreRef.current?.setPresentationMode(presentationMode)
  }, [presentationMode])

  return (
    <canvas
      ref={canvasRef}
      width={CORE_BOX_PX}
      height={CORE_BOX_PX}
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        width: CORE_BOX_PX,
        height: CORE_BOX_PX,
        marginLeft: -CORE_BOX_PX / 2,
        marginTop: -CORE_BOX_PX / 2,
        pointerEvents: 'none'
      }}
    />
  )
}
