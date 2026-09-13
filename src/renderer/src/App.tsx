import Core from './hud/Core'
import Rings from './hud/Rings'
import DevStateSwitcher from './hud/DevStateSwitcher'

/**
 * M1 HUD shell: the living core (Core.tsx, three.js) anchored at screen
 * center with concentric technical rings (Rings.tsx, SVG) that fade/scale
 * in around it whenever the state leaves ambient. The dev switcher lets
 * every state be inspected without the voice pipeline (that's M2+).
 */
export default function App(): React.JSX.Element {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Rings />
      <Core />
      <DevStateSwitcher />
    </div>
  )
}
