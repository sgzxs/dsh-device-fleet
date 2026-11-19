// Lightweight CI entry point: runs every suite and the client render smoke.
import { spawnSync } from 'node:child_process'

const steps = [
  ['net', ['test/net.test.mjs']],
  ['host', ['test/host.test.mjs']],
  ['overlay', ['test/overlay.test.mjs']],
  ['plugin-order', ['test/plugin-order.test.mjs']],
  ['perf', ['test/perf.test.mjs']],
  ['client-smoke', ['scripts/client-smoke.mjs']],
]
let failed = 0
for (const [name, args] of steps) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    failed += 1
    console.error(`[ci] ${name} failed with exit code ${result.status}`)
  }
}
if (failed > 0) process.exit(1)
console.log('[ci] all suites passed')
