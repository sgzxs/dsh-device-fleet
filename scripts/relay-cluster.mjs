#!/usr/bin/env node
// Supervise several self-hosted Fleet relays with one command.
//
//   node scripts/relay-cluster.mjs --fleet-state <fleet.json> --nodes 3 \
//     --host 0.0.0.0 --base-port 60600 --base-data-port 60610
//
// Cross-host leader election (optional):
//   node scripts/relay-lease.mjs --host 0.0.0.0 --port 60700 --ttl 15000
//   node scripts/relay-cluster.mjs ... --coordinator http://coordinator:60700
//
// With --coordinator, supervisors compete for a short lease; only the leader
// starts relay nodes and renews the lease. If the leader dies the lease expires
// and a standby takes over. The lease coordinator is a small dedicated service
// (documented SPOF) and should be replaced by etcd/Consul for production.
import { spawn } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const relayScript = path.join(here, 'relay-server.mjs')
const args = process.argv.slice(2)
function option(name, fallback = null) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const nodeCount = Math.max(1, Math.min(16, Number(option('nodes', '2')) || 2))
const host = option('host', '0.0.0.0')
const basePort = Number(option('base-port', '60600'))
const baseDataPort = Number(option('base-data-port', String(basePort + 10)))
const fleetState = option('fleet-state', null)
const fleets = option('fleets', null)
const tlsCert = option('tls-cert', null)
const tlsKey = option('tls-key', null)
const tlsCa = option('tls-ca', null)
const tlsClientAllowlist = option('tls-client-allowlist', null)
const restartDelayMs = Math.max(250, Number(option('restart-delay', '2000')) || 2000)
const coordinator = option('coordinator', null)
const leaseToken = option('lease-token', null)
const candidate = option('candidate', os.hostname())
const leaseTtlMs = Math.max(3_000, Number(option('lease-ttl', '15000')) || 15_000)

if (!fleetState && !fleets) {
  console.error('Pass --fleet-state <fleet.json> or --fleets <fleets.json>.')
  process.exit(2)
}
if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
  console.error('TLS needs both --tls-cert and --tls-key.')
  process.exit(2)
}

const children = new Map()
let stopping = false
let leader = !coordinator
let leaseId = null
let renewTimer = null
let acquireTimer = null

function childArgs(index) {
  const port = basePort + index
  const dataPort = baseDataPort + index
  const list = ['--host', host, '--port', String(port), '--data-port', String(dataPort)]
  if (fleetState) list.push('--fleet-state', fleetState)
  if (fleets) list.push('--fleets', fleets)
  if (tlsCert) list.push('--tls-cert', tlsCert, '--tls-key', tlsKey)
  if (tlsCa) list.push('--tls-ca', tlsCa)
  if (tlsClientAllowlist) list.push('--tls-client-allowlist', tlsClientAllowlist)
  return { port, dataPort, args: list }
}
function start(index) {
  if (stopping || !leader || children.has(index)) return
  const spec = childArgs(index)
  const child = spawn(process.execPath, [relayScript, ...spec.args], { stdio: 'inherit', windowsHide: true })
  children.set(index, child)
  child.on('exit', (code, signal) => {
    children.delete(index)
    if (stopping || !leader) return
    console.error(`[relay-cluster] node ${index} exited (${signal ?? code}); restarting in ${restartDelayMs}ms`)
    setTimeout(() => start(index), restartDelayMs).unref()
  })
  console.log(`[relay-cluster] node ${index} control=${host}:${spec.port} data=${host}:${spec.dataPort}`)
}
function startAll() {
  for (let index = 0; index < nodeCount; index += 1) start(index)
}
function stopAll() {
  for (const child of children.values()) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  children.clear()
}
async function leaseRequest(pathname, body) {
  const response = await fetch(`${coordinator.replace(/\/$/, '')}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(leaseToken ? { 'x-lease-token': leaseToken } : {}) },
    body: JSON.stringify({ owner: candidate, ...body }),
    signal: AbortSignal.timeout(3_000),
  })
  const data = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, data }
}
async function acquire() {
  if (stopping) return
  clearTimeout(acquireTimer)
  try {
    const result = await leaseRequest('/acquire', { ttlMs: leaseTtlMs })
    if (!result.ok) {
      if (leader) stopAll()
      leader = false
      console.log(`[relay-cluster] standby; leader=${result.data.leader ?? 'unknown'}`)
      acquireTimer = setTimeout(acquire, Math.max(1_000, Math.floor(leaseTtlMs / 3)))
      acquireTimer.unref?.()
      return
    }
    leaseId = result.data.leaseId
    leader = true
    console.log(`[relay-cluster] leader lease acquired (${leaseId})`)
    startAll()
    scheduleRenew()
  } catch (error) {
    if (leader) stopAll()
    leader = false
    console.error(`[relay-cluster] lease coordinator unavailable: ${String(error?.message ?? error)}`)
    acquireTimer = setTimeout(acquire, Math.max(1_000, Math.floor(leaseTtlMs / 3)))
    acquireTimer.unref?.()
  }
}
function scheduleRenew() {
  clearTimeout(renewTimer)
  renewTimer = setTimeout(async () => {
    if (stopping) return
    try {
      const result = await leaseRequest('/renew', { leaseId, ttlMs: leaseTtlMs })
      if (!result.ok) {
        console.error('[relay-cluster] lease lost; stopping local nodes')
        leader = false
        stopAll()
        void acquire()
        return
      }
      scheduleRenew()
    } catch (error) {
      console.error(`[relay-cluster] lease renew failed: ${String(error?.message ?? error)}`)
      leader = false
      stopAll()
      void acquire()
    }
  }, Math.max(1_000, Math.floor(leaseTtlMs / 3)))
  renewTimer.unref?.()
}
async function releaseLease() {
  if (!coordinator || !leaseId) return
  try {
    await leaseRequest('/release', { leaseId })
  } catch {
    /* best effort */
  }
}
function stop() {
  stopping = true
  clearTimeout(renewTimer)
  clearTimeout(acquireTimer)
  stopAll()
  void releaseLease().finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 1_000).unref()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

const healthTimer = setInterval(() => {
  if (stopping || !leader) return
  for (let index = 0; index < nodeCount; index += 1) {
    if (children.has(index)) continue
    const port = basePort + index
    const socket = net.connect({ host: host === '0.0.0.0' ? '127.0.0.1' : host, port })
    socket.setTimeout(1000)
    socket.once('connect', () => socket.destroy())
    socket.once('error', () => {
      socket.destroy()
      start(index)
    })
  }
}, 10_000)
// Keep the supervisor alive even while all children are restarting or the
// lease coordinator is unreachable.

if (coordinator) void acquire()
else startAll()
await new Promise(() => {})
