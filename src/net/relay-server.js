// Self-hosted relay for fleet devices behind NAT (v2).
//
// Control plane: TCP with newline-delimited JSON.
//   register -> register.ok
//   connect(reqId,target) -> connect.pending; target gets incoming(reqId,from)
//   accept/reject on the target side -> connect.ready (both sides, with data token)
// Data plane: a second TCP listener. Each side connects with a one-line header
//   {fleetId, deviceId, reqId, token}\n
// and the relay splices the two raw sockets together. Payload bytes are the
// end-to-end encrypted frames from secure-channel.js, so the relay cannot read them.
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import * as nodeTls from 'node:tls'
import { verifyRelayAuthToken } from './identity.js'
import { peerCertificateFingerprint, readClientAllowlist, serverTlsOptions } from './tls-options.js'

const MAX_CONTROL_LINE = 64 * 1024
const MAX_CLOCK_SKEW_MS = 120_000
const ACCEPT_TIMEOUT_MS = 20_000
const PAIR_TIMEOUT_MS = 20_000

function randomToken() {
  return randomBytes(24).toString('base64url')
}

function normalizeFleets(fleets) {
  const map = new Map()
  if (fleets instanceof Map) {
    for (const [fleetId, key] of fleets) map.set(fleetId, key)
    return map
  }
  for (const [fleetId, key] of Object.entries(fleets ?? {})) map.set(fleetId, key)
  return map
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      const address = server.address()
      resolve(address?.port ?? port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/**
 * @param {{host?: string, port?: number, dataHost?: string, dataPort?: number, fleets?: Record<string,string>|Map<string,string>, tls?: {cert: string, key: string, ca?: string}|null}} [options]
 */
/**
 * Enforce an optional mTLS client-certificate allowlist. The allowlist file is
 * re-read on every connection, so revoking a fingerprint takes effect without
 * restarting the Relay; rotating a client certificate only requires updating
 * the client key/cert files and reconnecting.
 */
function guardClientCertificate(handler, getTls) {
  return (socket) => {
    const allowlist = readClientAllowlist(getTls())
    if (allowlist !== null) {
      const fingerprint = peerCertificateFingerprint(socket)
      if (!fingerprint || !allowlist.has(fingerprint)) {
        socket.destroy()
        return
      }
    }
    handler(socket)
  }
}

export function createRelayServer({
  host = '127.0.0.1',
  dataHost = host,
  port = 0,
  dataPort = 0,
  fleets = {},
  maxConnectionsPerIp = 8,
  tls = null,
} = {}) {
  const fleetKeys = normalizeFleets(fleets)
  if (fleetKeys.size === 0) throw new Error('relay needs at least one fleet key')
  const tlsOptions = serverTlsOptions(tls)
  let activeTls = tls
  const relay = new EventEmitter()
  /** @type {Map<string, {deviceId: string, fleetId: string, socket: net.Socket}>} */
  const devices = new Map()
  /** @type {Map<string, any>} */
  const pending = new Map()
  const state = { port: null, dataPort: null, secure: Boolean(tlsOptions), closed: false }
  const trackedSockets = new Set()
  const connectionsByIp = new Map()

  const send = (socket, message) => {
    if (!socket || socket.destroyed || !socket.writable) return
    try {
      socket.write(JSON.stringify(message) + '\n')
    } catch {
      /* socket is going away */
    }
  }

  const cleanupPending = (reqId, reason, notify = true) => {
    const entry = pending.get(reqId)
    if (!entry) return
    pending.delete(reqId)
    clearTimeout(entry.acceptTimer)
    clearTimeout(entry.pairTimer)
    for (const socket of Object.values(entry.sockets ?? {})) {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }
    if (!notify) return
    const fromDevice = devices.get(entry.fromDeviceId)
    const targetDevice = devices.get(entry.targetDeviceId)
    send(fromDevice?.socket, { t: 'connect.fail', reqId, reason })
    send(targetDevice?.socket, { t: 'connect.fail', reqId, reason })
  }

  const removeDevice = (deviceId, socket) => {
    const record = devices.get(deviceId)
    if (!record || record.socket !== socket) return
    devices.delete(deviceId)
    for (const [reqId, entry] of pending) {
      if (entry.fromDeviceId === deviceId || entry.targetDeviceId === deviceId) {
        cleanupPending(reqId, 'peer-offline')
      }
    }
  }

  const lastRegisterTs = new Map()
  const handleControlLine = (conn, line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      send(conn.socket, { t: 'error', code: 'bad-json' })
      return
    }
    switch (message?.t) {
      case 'register': {
        const { fleetId, deviceId, ts, token } = message
        if (typeof fleetId !== 'string' || typeof deviceId !== 'string') {
          send(conn.socket, { t: 'error', code: 'bad-register' })
          return
        }
        const fleetKey = fleetKeys.get(fleetId)
        if (!fleetKey) {
          send(conn.socket, { t: 'error', code: 'unknown-fleet' })
          conn.socket.destroy()
          return
        }
        if (typeof ts !== 'number' || Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) {
          send(conn.socket, { t: 'error', code: 'stale-token' })
          conn.socket.destroy()
          return
        }
        if (!verifyRelayAuthToken(token, { fleetKey, fleetId, deviceId, ts })) {
          send(conn.socket, { t: 'error', code: 'unauthorized' })
          conn.socket.destroy()
          return
        }
        const registerKey = `${fleetId}:${deviceId}`
        if (lastRegisterTs.has(registerKey) && ts <= lastRegisterTs.get(registerKey)) {
          send(conn.socket, { t: 'error', code: 'replay' })
          conn.socket.destroy()
          return
        }
        lastRegisterTs.set(registerKey, ts)
        while (lastRegisterTs.size > 10_000) lastRegisterTs.delete(lastRegisterTs.keys().next().value)
        const previous = devices.get(deviceId)
        if (previous && previous.socket !== conn.socket) {
          send(previous.socket, { t: 'error', code: 'replaced' })
          previous.socket.destroy()
        }
        devices.set(deviceId, { deviceId, fleetId, socket: conn.socket })
        conn.registered = { deviceId, fleetId }
        conn.socket.setTimeout?.(0)
        send(conn.socket, { t: 'register.ok', deviceId, server: 'dsh-device-fleet-relay', v: 1 })
        return
      }
      case 'ping': {
        send(conn.socket, { t: 'pong', ts: Number.isFinite(Number(message.ts)) ? Number(message.ts) : null })
        return
      }
      case 'connect': {
        if (!conn.registered) {
          send(conn.socket, { t: 'connect.fail', reqId: message.reqId, reason: 'not-registered' })
          return
        }
        const { reqId, targetDeviceId } = message
        if (typeof reqId !== 'string' || typeof targetDeviceId !== 'string') {
          send(conn.socket, { t: 'connect.fail', reqId: message.reqId, reason: 'bad-request' })
          return
        }
        const target = devices.get(targetDeviceId)
        if (!target || target.fleetId !== conn.registered.fleetId || target.socket === conn.socket) {
          send(conn.socket, { t: 'connect.fail', reqId, reason: 'offline' })
          return
        }
        if (pending.has(reqId)) {
          send(conn.socket, { t: 'connect.fail', reqId, reason: 'duplicate-request' })
          return
        }
        const entry = {
          reqId,
          fleetId: conn.registered.fleetId,
          fromDeviceId: conn.registered.deviceId,
          targetDeviceId,
          sockets: {},
          tokens: null,
          accepted: false,
          acceptTimer: setTimeout(() => cleanupPending(reqId, 'accept-timeout'), ACCEPT_TIMEOUT_MS),
          pairTimer: null,
        }
        entry.acceptTimer.unref?.()
        pending.set(reqId, entry)
        send(target.socket, { t: 'incoming', reqId, fromDeviceId: entry.fromDeviceId })
        send(conn.socket, { t: 'connect.pending', reqId })
        return
      }
      case 'accept': {
        if (!conn.registered) return
        const entry = pending.get(message.reqId)
        if (!entry || entry.targetDeviceId !== conn.registered.deviceId) {
          send(conn.socket, { t: 'error', code: 'unknown-request', reqId: message.reqId })
          return
        }
        if (entry.accepted) return
        entry.accepted = true
        clearTimeout(entry.acceptTimer)
        entry.tokens = { [entry.fromDeviceId]: randomToken(), [entry.targetDeviceId]: randomToken() }
        entry.pairTimer = setTimeout(() => cleanupPending(entry.reqId, 'data-timeout'), PAIR_TIMEOUT_MS)
        entry.pairTimer.unref?.()
        const from = devices.get(entry.fromDeviceId)
        const target = devices.get(entry.targetDeviceId)
        send(from?.socket, { t: 'connect.ready', reqId: entry.reqId, dataPort: state.dataPort, token: entry.tokens[entry.fromDeviceId] })
        send(target?.socket, { t: 'connect.ready', reqId: entry.reqId, dataPort: state.dataPort, token: entry.tokens[entry.targetDeviceId] })
        return
      }
      case 'reject': {
        const entry = pending.get(message.reqId)
        if (!entry || entry.targetDeviceId !== conn.registered?.deviceId) return
        cleanupPending(entry.reqId, 'rejected')
        return
      }
      default:
        send(conn.socket, { t: 'error', code: 'unknown-message' })
    }
  }

  const onControlSocket = (socket) => {
    const ip = socket.remoteAddress ?? 'unknown'
    const count = connectionsByIp.get(ip) ?? 0
    if (count >= maxConnectionsPerIp) {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      return
    }
    connectionsByIp.set(ip, count + 1)
    trackedSockets.add(socket)
    socket.setNoDelay?.(true)
    socket.setTimeout(15_000, () => {
      if (!conn.registered) socket.destroy()
    })
    const conn = { socket, registered: null, buffer: '' }
    socket.on('data', (chunk) => {
      conn.buffer += chunk.toString('utf8')
      if (conn.buffer.length > MAX_CONTROL_LINE * 8) {
        socket.destroy()
        return
      }
      let newline = conn.buffer.indexOf('\n')
      while (newline >= 0) {
        const line = conn.buffer.slice(0, newline)
        conn.buffer = conn.buffer.slice(newline + 1)
        if (line.trim() !== '') handleControlLine(conn, line)
        newline = conn.buffer.indexOf('\n')
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      trackedSockets.delete(socket)
      const remaining = (connectionsByIp.get(ip) ?? 1) - 1
      if (remaining > 0) connectionsByIp.set(ip, remaining)
      else connectionsByIp.delete(ip)
      if (conn.registered) removeDevice(conn.registered.deviceId, socket)
    })
  }

  const pairDataSockets = (reqId) => {
    const entry = pending.get(reqId)
    if (!entry) return
    const entries = Object.entries(entry.sockets)
    if (entries.length !== 2) return
    pending.delete(reqId)
    clearTimeout(entry.pairTimer)
    clearTimeout(entry.acceptTimer)
    const [[sideA, socketA], [sideB, socketB]] = entries
    for (const socket of [socketA, socketB]) trackedSockets.delete(socket)
    const destroyBoth = () => {
      for (const socket of [socketA, socketB]) {
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
      }
    }
    socketA.on('error', destroyBoth)
    socketB.on('error', destroyBoth)
    socketA.on('close', () => socketB.destroy())
    socketB.on('close', () => socketA.destroy())
    socketA.pipe(socketB)
    socketB.pipe(socketA)
    socketA.resume()
    socketB.resume()
    relay.emit('spliced', {
      reqId,
      fleetId: entry.fleetId,
      fromDeviceId: entry.fromDeviceId,
      targetDeviceId: entry.targetDeviceId,
      sides: [sideA, sideB],
    })
  }

  const onDataSocket = (socket) => {
    if (trackedSockets.size > 512) {
      socket.destroy()
      return
    }
    trackedSockets.add(socket)
    socket.setNoDelay?.(true)
    socket.setTimeout(5_000, () => socket.destroy())
    let headerBuffer = Buffer.alloc(0)
    const onData = (chunk) => {
      headerBuffer = Buffer.concat([headerBuffer, chunk])
      const newline = headerBuffer.indexOf(0x0a)
      if (newline < 0) {
        if (headerBuffer.length > MAX_CONTROL_LINE) socket.destroy()
        return
      }
      socket.off('data', onData)
      let header
      try {
        header = JSON.parse(headerBuffer.subarray(0, newline).toString('utf8'))
      } catch {
        socket.destroy()
        return
      }
      const leftover = headerBuffer.subarray(newline + 1)
      const entry = pending.get(header?.reqId)
      if (!entry || !entry.tokens) {
        socket.destroy()
        return
      }
      const side =
        header.deviceId === entry.fromDeviceId ? entry.fromDeviceId : header.deviceId === entry.targetDeviceId ? entry.targetDeviceId : null
      if (!side || header.fleetId !== entry.fleetId || header.token !== entry.tokens[side]) {
        socket.destroy()
        return
      }
      if (entry.sockets[side]) {
        socket.destroy()
        return
      }
      socket.pause()
      socket.setTimeout?.(0)
      entry.sockets[side] = socket
      if (leftover.length > 0) socket.unshift(leftover)
      pairDataSockets(entry.reqId)
    }
    socket.on('data', onData)
    socket.once('close', () => {
      trackedSockets.delete(socket)
      for (const [reqId, entry] of pending) {
        if (entry.sockets && Object.values(entry.sockets).includes(socket)) cleanupPending(reqId, 'data-closed')
      }
    })
    socket.on('error', () => {})
  }

  const controlServer = tlsOptions
    ? nodeTls.createServer(tlsOptions, guardClientCertificate(onControlSocket, () => activeTls))
    : net.createServer(onControlSocket)
  const dataServer = tlsOptions
    ? nodeTls.createServer(tlsOptions, guardClientCertificate(onDataSocket, () => activeTls))
    : net.createServer(onDataSocket)

  const ready = (async () => {
    state.dataPort = await listen(dataServer, dataPort, dataHost)
    state.port = await listen(controlServer, port, host)
    return { port: state.port, dataPort: state.dataPort }
  })()
  ready.catch(() => {})

  return {
    ready,
    state,
    on: relay.on.bind(relay),
    once: relay.once.bind(relay),
    /** Reload server certificate/key/CA material without dropping connections. */
    reloadTls(nextTls) {
      if (!state.secure || typeof controlServer.setSecureContext !== 'function') {
        throw Object.assign(new Error('relay was started without TLS'), { code: 'tls-not-enabled' })
      }
      const options = serverTlsOptions(nextTls)
      if (!options) throw Object.assign(new Error('TLS needs cert and key'), { code: 'bad-tls-config' })
      controlServer.setSecureContext(options)
      dataServer.setSecureContext(options)
      activeTls = nextTls
      state.tlsRotatedAt = Date.now()
      return { secure: true, tlsRotatedAt: state.tlsRotatedAt }
    },
    close: async () => {
      if (state.closed) return
      state.closed = true
      for (const [reqId] of pending) cleanupPending(reqId, 'server-closing', false)
      for (const socket of trackedSockets) {
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
      }
      await Promise.all([
        new Promise((resolve) => (controlServer.listening ? controlServer.close(() => resolve()) : resolve())),
        new Promise((resolve) => (dataServer.listening ? dataServer.close(() => resolve()) : resolve())),
      ])
    },
  }
}
