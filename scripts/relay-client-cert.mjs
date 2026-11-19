#!/usr/bin/env node
// Relay mTLS client-certificate lifecycle: rotate one client certificate and
// update the Relay allowlist, or revoke a fingerprint. The Relay re-reads the
// allowlist file on every new connection, so revocation needs no restart.
//
//   node scripts/relay-client-cert.mjs rotate --out relay-mtls --name phone --install
//   node scripts/relay-client-cert.mjs revoke --out relay-mtls --name phone
//   node scripts/relay-client-cert.mjs list --out relay-mtls
//
// `--install` copies the new cert/key to client-cert.pem/client-key.pem; restart
// or reconnect the device afterwards so RelayClient picks up the new files.
import { spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const command = args[0] && !args[0].startsWith('--') ? args[0] : 'list'
function option(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const out = path.resolve(option('--out', 'relay-mtls'))
const dir = out
const allowlistFile = path.join(dir, 'allowed-clients.json')
const caCert = path.join(dir, 'ca-cert.pem')
const caKey = path.join(dir, 'ca-key.pem')
const name = option('--name', `client-${Date.now()}`)
const days = String(Number(option('--days', '3650')) || 3650)

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }))
  process.exit(1)
}
function run(argv) {
  const result = spawnSync('openssl', argv, { cwd: dir, encoding: 'utf8' })
  if (result.status !== 0) fail(`openssl ${argv.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`)
}
function fingerprint(file) {
  return new X509Certificate(fs.readFileSync(file)).fingerprint256.replace(/[^a-f0-9]/gi, '').toLowerCase()
}
function readAllowlist() {
  try {
    const parsed = JSON.parse(fs.readFileSync(allowlistFile, 'utf8'))
    if (Array.isArray(parsed)) return { clients: parsed.map((entry) => (typeof entry === 'string' ? { fingerprint: entry } : entry)) }
    if (Array.isArray(parsed?.clients)) return { clients: parsed.clients }
    if (Array.isArray(parsed?.fingerprints)) return { clients: parsed.fingerprints.map((value) => ({ fingerprint: value })) }
    return { clients: [] }
  } catch {
    return { clients: [] }
  }
}
function writeAllowlist(value) {
  fs.writeFileSync(allowlistFile, `${JSON.stringify(value, null, 2)}\n`)
}
function assertCa() {
  for (const file of [caCert, caKey]) if (!fs.existsSync(file)) fail(`missing CA file: ${file}`)
}
function safeName(value) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) fail('name may only contain letters, digits, dot, underscore and dash')
  return value
}

if (command === 'rotate') {
  assertCa()
  const clientName = safeName(name)
  const clientsDir = path.join(dir, 'clients')
  fs.mkdirSync(clientsDir, { recursive: true })
  const keyFile = path.join(clientsDir, `${clientName}-key.pem`)
  const csrFile = path.join(clientsDir, `${clientName}.csr`)
  const certFile = path.join(clientsDir, `${clientName}-cert.pem`)
  const configFile = path.join(dir, 'openssl.cnf')
  const reqArgs = ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', csrFile, '-subj', `/CN=${clientName}`]
  if (fs.existsSync(configFile)) reqArgs.push('-config', configFile)
  run(reqArgs)
  run(['x509', '-req', '-in', csrFile, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-days', days, '-out', certFile])
  fs.rmSync(csrFile, { force: true })
  const fp = fingerprint(certFile)
  const allowlist = readAllowlist()
  allowlist.clients = allowlist.clients.filter((entry) => entry.name !== clientName && entry.fingerprint !== fp)
  allowlist.clients.push({ name: clientName, fingerprint: fp, cert: certFile })
  writeAllowlist(allowlist)
  if (args.includes('--install')) {
    fs.copyFileSync(certFile, path.join(dir, 'client-cert.pem'))
    fs.copyFileSync(keyFile, path.join(dir, 'client-key.pem'))
  }
  console.log(JSON.stringify({ ok: true, command, name: clientName, fingerprint: fp, cert: certFile, key: keyFile, installed: args.includes('--install'), allowlist: allowlistFile }))
} else if (command === 'revoke') {
  const byFingerprint = option('--fingerprint', '')
  const byName = option('--name', '')
  if (!byFingerprint && !byName) fail('revoke needs --fingerprint or --name')
  const normalized = byFingerprint.replace(/[^a-f0-9]/gi, '').toLowerCase()
  const allowlist = readAllowlist()
  const before = allowlist.clients.length
  allowlist.clients = allowlist.clients.filter((entry) => entry.name !== byName && entry.fingerprint !== normalized)
  if (allowlist.clients.length === before) fail('no matching client certificate in the allowlist')
  writeAllowlist(allowlist)
  console.log(JSON.stringify({ ok: true, command, revoked: before - allowlist.clients.length, allowlist: allowlistFile }))
} else if (command === 'list') {
  console.log(JSON.stringify({ ok: true, command, allowlist: allowlistFile, ...readAllowlist() }))
} else {
  fail(`unknown command: ${command}; expected rotate, revoke or list`)
}
