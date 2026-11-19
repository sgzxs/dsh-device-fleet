#!/usr/bin/env node
// Release preflight: version consistency, package contents and syntax.
// Does not publish and does not require npm authentication.
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const problems = []
const checks = []

function check(name, fn) {
  try {
    fn()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, error: String(error?.message ?? error) })
    problems.push(`${name}: ${String(error?.message ?? error)}`)
  }
}
function includes(file, text) {
  if (!existsSync(path.join(root, file))) throw new Error('missing file')
  const body = readFileSync(path.join(root, file), 'utf8')
  if (!body.includes(text)) throw new Error(`does not contain ${text}`)
}

check('package version is semver', () => {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`bad version ${version}`)
})
check('STATUS/README/HANDOFF mention version', () => {
  includes('docs/STATUS.md', version)
  includes('README.md', version)
  includes('docs/HANDOFF.md', version)
})
check('release features present', () => {
  for (const file of [
    'src/host/trajectory.js',
    'src/host/call-ledger.js',
    'src/host/outbox.js',
    'scripts/relay-lease.mjs',
    'scripts/relay-cluster.mjs',
    'scripts/relay-server-cert.mjs',
  ]) {
    if (!existsSync(path.join(root, file))) throw new Error(`missing ${file}`)
  }
})
check('syntax of entrypoints', () => {
  for (const file of ['client.js', 'src/plugin/index.js', 'src/net/fleet-node.js', 'scripts/relay-lease.mjs', 'scripts/relay-cluster.mjs']) {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' })
  }
})
check('npm pack includes host/client/scripts', () => {
  const out = execSync('npm pack --dry-run --json', {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? path.join(process.env.TEMP ?? '.', 'npm-cache') },
  })
  const files = JSON.parse(out)[0]?.files?.map((entry) => entry.path) ?? []
  for (const wanted of ['src/plugin/index.js', 'client.js', 'scripts/relay-lease.mjs', 'docs/STATUS.md']) {
    if (!files.includes(wanted)) throw new Error(`pack missing ${wanted}`)
  }
  checks.push({ name: 'pack file count', value: files.length })
})

const result = { version, ok: problems.length === 0, checks, problems }
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exit(1)
