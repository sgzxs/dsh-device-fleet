#!/usr/bin/env node
// Rotate the Relay server certificate signed by the existing mTLS CA.
// The Relay reloads cert/key on SIGHUP (no listener restart):
//   node scripts/relay-server-cert.mjs rotate --out relay-mtls --install
//   kill -HUP <relay-pid>          # Windows: taskkill /PID <pid> (no SIGHUP) or restart relay
//
// On Windows SIGHUP is not portable; restart the relay process there.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const command = args[0] && !args[0].startsWith('--') ? args[0] : 'rotate'
function option(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const out = path.resolve(option('--out', 'relay-mtls'))
const name = option('--name', `relay-${Date.now()}`)
if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) fail('name may only contain letters, digits, dot, underscore and dash')
const days = String(Number(option('--days', '3650')) || 3650)
const caCert = path.join(out, 'ca-cert.pem')
const caKey = path.join(out, 'ca-key.pem')
const config = path.join(out, 'openssl.cnf')

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }))
  process.exit(1)
}
function run(argv) {
  const result = spawnSync('openssl', argv, { cwd: out, encoding: 'utf8' })
  if (result.status !== 0) fail(`openssl ${argv.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`)
}

if (command !== 'rotate') fail(`unknown command: ${command}; expected rotate`)
for (const file of [caCert, caKey]) if (!fs.existsSync(file)) fail(`missing CA file: ${file}`)
fs.mkdirSync(path.join(out, 'servers'), { recursive: true })
const keyFile = path.join(out, 'servers', `${name}-key.pem`)
const csrFile = path.join(out, 'servers', `${name}.csr`)
const certFile = path.join(out, 'servers', `${name}-cert.pem`)
const reqArgs = ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', csrFile, '-subj', `/CN=${name}`]
if (fs.existsSync(config)) reqArgs.push('-config', config)
run(reqArgs)
const signArgs = ['x509', '-req', '-in', csrFile, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-days', days, '-out', certFile]
if (fs.existsSync(config)) signArgs.push('-extfile', config, '-extensions', 'server')
run(signArgs)
fs.rmSync(csrFile, { force: true })
if (args.includes('--install')) {
  fs.copyFileSync(certFile, path.join(out, 'server-cert.pem'))
  fs.copyFileSync(keyFile, path.join(out, 'server-key.pem'))
}
console.log(JSON.stringify({
  ok: true,
  command,
  name,
  cert: certFile,
  key: keyFile,
  installed: args.includes('--install'),
  note: 'Reload the Relay with SIGHUP after installing; on Windows restart the relay process.',
}))
