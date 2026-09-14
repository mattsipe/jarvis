#!/usr/bin/env node
/**
 * Regression check for the exact class of bug that broke v0.6.3-test.1:
 * a packaging-config change silently deleted files a production dependency
 * needs at runtime (a recursive "exclude any dist folder" pattern meant
 * for the project's own build-output directory also matched node_modules/onnxruntime-node/dist/
 * and node_modules/zod-to-json-schema/dist/ — each package's own compiled
 * output, an unrelated "dist" by the same name). That shipped a Windows
 * installer that crashed on startup with "Cannot find module
 * .../onnxruntime-node/dist/index.js" — nothing before this caught it
 * because typecheck/tests/build all run against the SOURCE tree, never
 * the actual packaged output.
 *
 * This script extracts a built app's asar and requires every one of
 * package.json's production dependencies from inside it, exactly the way
 * Node resolves modules for our own bundled main process — the same
 * check that actually caught the bug when done by hand. It also checks
 * the handful of files placed outside the asar (extraResources) that the
 * app can't start without.
 *
 * Usage: node scripts/verify-packaged-app.mjs <path-to-*-unpacked-dir>
 *   e.g. node scripts/verify-packaged-app.mjs dist/win-unpacked
 *
 * Exit code 0 = every required module/file resolved. Non-zero = at least
 * one hard failure (see output for which, and why).
 */
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'fs'
import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { extractAll } from '@electron/asar'

const unpackedDir = process.argv[2]
if (!unpackedDir) {
  console.error('Usage: node scripts/verify-packaged-app.mjs <path-to-*-unpacked-dir>')
  process.exit(2)
}

// On Windows CI, jarvis-helper.exe is expected to exist (the workflow
// builds it before packaging) — a local macOS dev run can't produce it
// (no .NET toolchain reliably available there), so that one specific
// check is a warning, not a failure, unless this env var says otherwise.
const REQUIRE_JARVIS_HELPER = process.env.REQUIRE_JARVIS_HELPER === '1'

let hardFailures = 0
function pass(label) {
  console.log(`  ok    ${label}`)
}
function fail(label, detail) {
  hardFailures++
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}
function warn(label, detail) {
  console.log(`  warn  ${label}${detail ? ` — ${detail}` : ''}`)
}

/**
 * electron-builder's unpacked output layout differs by platform: Windows
 * and Linux put `resources/` directly under the appOutDir, while macOS
 * nests everything inside a `<ProductName>.app/Contents/` bundle instead.
 * Only the Windows layout ever actually ships, but this script also runs
 * during local macOS dev builds (via the afterPack hook, on every build,
 * not just Windows ones) — so both need to resolve correctly.
 */
function resolveResourcesDir(baseDir) {
  const direct = join(baseDir, 'resources')
  if (existsSync(join(direct, 'app.asar'))) return direct
  const appBundle = readdirSync(baseDir).find((f) => f.endsWith('.app'))
  if (appBundle) {
    const nested = join(baseDir, appBundle, 'Contents', 'Resources')
    if (existsSync(join(nested, 'app.asar'))) return nested
  }
  return direct // let the caller's existsSync check produce the real error message
}

async function main() {
  const resourcesDir = resolveResourcesDir(unpackedDir)
  const asarPath = join(resourcesDir, 'app.asar')
  if (!existsSync(asarPath)) {
    console.error(`No app.asar found at ${asarPath} — is "${unpackedDir}" really an electron-builder unpacked output directory?`)
    process.exit(2)
  }

  const extractDir = mkdtempSync(join(tmpdir(), 'jarvis-verify-'))
  // A couple of production dependencies (@electron-toolkit/preload,
  // @electron-toolkit/utils) `require('electron')` themselves at load
  // time — a real, always-true dependency once actually running inside
  // Electron (which provides it as a built-in), but unresolvable from a
  // plain `node -e` check like this one. A minimal stub on NODE_PATH lets
  // this check verify the REST of their require graph resolved correctly
  // without needing a real Electron process, without weakening the check
  // for anything else.
  const stubDir = mkdtempSync(join(tmpdir(), 'jarvis-verify-stub-'))
  try {
    console.log(`Extracting ${asarPath} -> ${extractDir}`)
    extractAll(asarPath, extractDir)

    const electronStubDir = join(stubDir, 'electron')
    mkdirSync(electronStubDir, { recursive: true })
    writeFileSync(join(electronStubDir, 'package.json'), JSON.stringify({ name: 'electron', version: '0.0.0', main: 'index.js' }))
    // Just enough for the two @electron-toolkit/* packages' top-level
    // (module-load-time) property access not to throw — is.dev reads
    // electron.app.isPackaged as soon as the module loads. Nothing here
    // needs to behave correctly, only exist, since this script only ever
    // checks "did every require() resolve", not runtime behavior.
    writeFileSync(join(electronStubDir, 'index.js'), 'module.exports = { app: { isPackaged: false } }\n')

    console.log('\n=== Main-process entry points ===')
    for (const rel of ['out/main/index.js', 'out/preload/index.js']) {
      if (existsSync(join(extractDir, rel))) pass(rel)
      else fail(rel, 'missing from the packaged app')
    }

    console.log('\n=== Production dependencies (require() resolution) ===')
    const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf-8'))
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      // zustand's default export pulls in the React bindings, which only
      // ever run inside the Vite-bundled renderer (already inlined there,
      // never resolved from node_modules at runtime) — main never
      // requires it directly, so checking it here would be a false
      // failure. Every other production dependency IS potentially
      // require()'d by our own main-process code and belongs in this check.
      if (dep === 'zustand') continue

      // onnxruntime-node's native addon is platform/arch-specific — a
      // Windows-targeted build correctly has ONLY the win32/x64 binary,
      // so requiring it from a non-Windows host (e.g. checking a Windows
      // build locally on macOS during development) fails for a reason
      // that isn't a real bug. Check that the binary for the actual
      // *build target* exists instead of relying on process.platform,
      // and only require() it for real when the two match.
      if (dep === 'onnxruntime-node') {
        const binRoot = join(extractDir, 'node_modules/onnxruntime-node/bin/napi-v6')
        const platforms = existsSync(binRoot) ? readdirSync(binRoot) : []
        if (platforms.length === 0) {
          fail(dep, 'no platform binaries found under bin/napi-v6 at all')
          continue
        }
        if (!platforms.includes(process.platform)) {
          warn(dep, `binaries present for [${platforms.join(', ')}] but not this host's platform (${process.platform}) — expected when checking a build targeting a different OS; verify on that OS's own CI run`)
          continue
        }
      }

      try {
        execFileSync(process.execPath, ['-e', `require(${JSON.stringify(dep)})`], {
          cwd: extractDir,
          env: { ...process.env, NODE_PATH: stubDir },
          stdio: 'pipe'
        })
        pass(dep)
      } catch (err) {
        const message = (err.stderr?.toString() || err.message).split('\n').find((l) => l.includes('Cannot find module')) || err.message
        fail(dep, message.trim())
      }
    }

    console.log('\n=== extraResources (files placed outside the asar) ===')
    const wakewordDir = join(resourcesDir, 'wakeword')
    for (const model of ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx']) {
      const p = join(wakewordDir, model)
      if (existsSync(p)) pass(`resources/wakeword/${model}`)
      else fail(`resources/wakeword/${model}`, 'missing — presence/wakeword.ts cannot load the engine without it')
    }

    const helperPath = join(resourcesDir, 'jarvis-helper.exe')
    if (existsSync(helperPath)) {
      pass('resources/jarvis-helper.exe')
    } else if (REQUIRE_JARVIS_HELPER) {
      fail('resources/jarvis-helper.exe', 'missing — required on Windows CI builds')
    } else {
      warn('resources/jarvis-helper.exe', 'not present (expected when building locally without the .NET toolchain — set REQUIRE_JARVIS_HELPER=1 to make this a hard failure)')
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true })
    rmSync(stubDir, { recursive: true, force: true })
  }

  console.log()
  if (hardFailures > 0) {
    console.error(`${hardFailures} check(s) failed — this package would not start correctly. See FAIL lines above.`)
    process.exit(1)
  }
  console.log('All checks passed.')
}

main()
