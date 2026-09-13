// electron-builder afterPack hook — runs scripts/verify-packaged-app.mjs
// against the just-packaged app directory, as part of the SAME build
// invocation, before signing/installer-creation/publish ever happen. A
// non-zero exit from that script throws here, which electron-builder
// treats as a fatal build error — a broken package (see v0.6.3-test.1's
// startup crash) can never reach `--publish always` again.
//
// CJS (not the project's usual ESM/TS) because electron-builder loads
// this file directly with `require()`, independent of the app's own
// module system. Kept as a thin wrapper — it re-runs the real, ESM
// verification script as a child process rather than reimplementing its
// logic here, so there is only one copy of the actual checks to maintain.
const { execFileSync } = require('child_process')
const path = require('path')

module.exports = async function afterPack(context) {
  const scriptPath = path.join(__dirname, 'verify-packaged-app.mjs')
  console.log(`\n[afterPack] Verifying packaged app at ${context.appOutDir}...`)
  execFileSync(process.execPath, [scriptPath, context.appOutDir], {
    stdio: 'inherit',
    env: process.env
  })
}
