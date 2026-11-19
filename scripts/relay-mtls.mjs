#!/usr/bin/env node
// Generate a self-signed CA, relay server certificate and client certificate for
// Relay mTLS development/testing. Requires `openssl` on PATH. This is tooling:
// production certificate lifecycle should use the organization's PKI.
import { spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const out = path.resolve(option('--out', 'relay-mtls'))
const commonName = option('--cn', 'relay.local')
const days = Number(option('--days', '3650')) || 3650
const dir = out
fs.mkdirSync(dir, { recursive: true })

function run(command, argv, input) {
  const result = spawnSync(command, argv, { cwd: dir, input, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} ${argv.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`)
  }
}
function file(name) {
  return path.join(dir, name)
}

const config = `[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
CN = ${commonName}-ca
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:${commonName},DNS:localhost,IP:127.0.0.1
[client]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = clientAuth
`
fs.writeFileSync(file('openssl.cnf'), config)

run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', String(days), '-config', file('openssl.cnf'), '-extensions', 'v3_ca', '-keyout', file('ca-key.pem'), '-out', file('ca-cert.pem'), '-subj', `/CN=${commonName}-ca`])
for (const [name, extension] of [['server', 'server'], ['client', 'client']]) {
  run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-config', file('openssl.cnf'), '-keyout', file(`${name}-key.pem`), '-out', file(`${name}.csr`), '-subj', `/CN=${commonName}-${name}`])
  run('openssl', ['x509', '-req', '-in', file(`${name}.csr`), '-CA', file('ca-cert.pem'), '-CAkey', file('ca-key.pem'), '-CAcreateserial', '-days', String(days), '-extfile', file('openssl.cnf'), '-extensions', extension, '-out', file(`${name}-cert.pem`)])
}
for (const name of ['server.csr', 'client.csr', 'ca-cert.srl']) {
  try {
    fs.rmSync(file(name), { force: true })
  } catch {
    /* ignore */
  }
}

const snippet = {
  relay: {
    host: '0.0.0.0',
    port: 60600,
    dataPort: 60601,
    tls: {
      cert: file('server-cert.pem'),
      key: file('server-key.pem'),
      ca: file('ca-cert.pem'),
      requestCert: true,
      rejectUnauthorized: true,
      allowedClientFingerprintsFile: file('allowed-clients.json'),
    },
  },
  client: { tls: { ca: file('ca-cert.pem'), servername: commonName, cert: file('client-cert.pem'), key: file('client-key.pem') } },
}
const clientFingerprint = new X509Certificate(fs.readFileSync(file('client-cert.pem'))).fingerprint256
  .replace(/[^a-f0-9]/gi, '')
  .toLowerCase()
fs.writeFileSync(file('allowed-clients.json'), JSON.stringify({ clients: [{ name: 'client', fingerprint: clientFingerprint, cert: file('client-cert.pem') }] }, null, 2))
fs.writeFileSync(file('relay-mtls.json'), JSON.stringify(snippet, null, 2))
console.log(JSON.stringify({ ok: true, out: dir, files: fs.readdirSync(dir), snippet: file('relay-mtls.json'), clientFingerprint }))
