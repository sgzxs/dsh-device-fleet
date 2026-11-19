#!/usr/bin/env node
// Minimal lease coordinator for Relay supervisors (cross-host leader election).
//
//   node scripts/relay-lease.mjs --host 0.0.0.0 --port 60700 --ttl 15000
//
// Supervisors acquire a short lease before starting Relay nodes and renew it.
// If the leader dies, the lease expires and a standby supervisor can acquire it.
// This coordinator is intentionally small; run it on a stable host (or replace
// it with etcd/Consul in production). It is not a consensus protocol itself.
import http from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'

const args = process.argv.slice(2)
function option(name, fallback = null) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const host = option('host', '127.0.0.1')
const port = Number(option('port', '60700'))
const defaultTtl = Math.max(3_000, Math.min(300_000, Number(option('ttl', '15000')) || 15_000))
const token = option('token', null)
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && !token) {
  console.error('Refusing a non-loopback lease listener without --token.')
  process.exit(2)
}
let lease = null
let counter = 0

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 16_384) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(body === '' ? {} : JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}
function active() {
  return lease && lease.expiresAt > Date.now() ? lease : null
}
function grant(owner, ttlMs) {
  const now = Date.now()
  const ttl = Math.max(3_000, Math.min(300_000, Number(ttlMs) || defaultTtl))
  counter += 1
  lease = { leaseId: `${now}-${counter}`, owner: String(owner || 'unknown'), expiresAt: now + ttl, ttlMs: ttl }
  return lease
}

const server = http.createServer(async (req, res) => {
  try {
    // Browsers attach Origin to cross-site POSTs. The lease API is for
    // supervisors/curl, never a web page; reject browser-origin requests so a
    // malicious page cannot release/steal a localhost lease.
    const origin = String(req.headers.origin ?? '')
    if (origin !== '') {
      const allowedOrigin = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(origin)
      if (!allowedOrigin) return json(res, 403, { error: 'browser origins are not allowed' })
    }
    if (token) {
      const supplied = Buffer.from(String(req.headers['x-lease-token'] ?? ''))
      const expected = Buffer.from(token)
      const suppliedHash = createHash('sha256').update(supplied).digest()
      const expectedHash = createHash('sha256').update(expected).digest()
      if (!timingSafeEqual(suppliedHash, expectedHash)) return json(res, 401, { error: 'unauthorized' })
    }
    const url = new URL(req.url ?? '/', 'http://local')
    if (req.method === 'GET' && url.pathname === '/state') {
      const current = active()
      return json(res, 200, { leader: current?.owner ?? null, leaseId: current?.leaseId ?? null, expiresAt: current?.expiresAt ?? null, ttlMs: current?.ttlMs ?? null })
    }
    if (req.method === 'POST' && (url.pathname === '/acquire' || url.pathname === '/renew' || url.pathname === '/release')) {
      const body = await readBody(req)
      const owner = String(body.owner ?? '')
      if (owner === '') return json(res, 400, { error: 'owner is required' })
      if (url.pathname === '/release') {
        if (active()?.owner === owner) lease = null
        return json(res, 200, { ok: true, leader: active()?.owner ?? null })
      }
      if (url.pathname === '/renew') {
        const current = active()
        if (!current || current.owner !== owner || current.leaseId !== String(body.leaseId ?? '')) {
          return json(res, 409, { error: 'lease not held', leader: current?.owner ?? null })
        }
        lease = granter(current, body.ttlMs)
        return json(res, 200, lease)
      }
      const current = active()
      if (current && current.owner !== owner) return json(res, 409, { error: 'lease held', leader: current.owner, expiresAt: current.expiresAt })
      return json(res, 200, grant(owner, body.ttlMs))
    }
    json(res, 404, { error: 'not found' })
  } catch (error) {
    json(res, 400, { error: String(error?.message ?? error) })
  }
})

function granter(current, ttlMs) {
  const ttl = Math.max(3_000, Math.min(300_000, Number(ttlMs) || current.ttlMs))
  return { ...current, expiresAt: Date.now() + ttl, ttlMs: ttl }
}

server.listen(port, host, () => {
  console.log(`[relay-lease] listening http://${host}:${port} ttl=${defaultTtl}ms`)
})
const shutdown = () => server.close(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
