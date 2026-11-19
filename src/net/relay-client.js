// Relay client: keeps a control connection to the self-hosted relay and opens
// spliced data connections to other fleet devices. Both connections can use TLS
// (the data path is already end-to-end encrypted; TLS hides relay metadata).
import { EventEmitter } from 'node:events'
import net from 'node:net'
import * as nodeTls from 'node:tls'
import { randomUUID } from 'node:crypto'
import { relayAuthToken } from './identity.js'
import { clientTlsOptions } from './tls-options.js'

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

export class RelayClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.host relay host
   * @param {number} options.port relay control port
   * @param {number} options.dataPort relay data port
   * @param {string} options.fleetId
   * @param {string} options.deviceId
   * @param {string} options.fleetKey
   * @param {{initialDelayMs?: number, maxDelayMs?: number}} [options.reconnect]
   * @param {{ca?: string, servername?: string, rejectUnauthorized?: boolean}|null} [options.tls]
   */
  constructor({ host, port, dataPort, fleetId, deviceId, fleetKey, reconnect = {}, tls = null }) {
    super()
    this.host = host
    this.port = port
    this.dataPort = dataPort
    this.fleetId = fleetId
    this.deviceId = deviceId
    this.fleetKey = fleetKey
    this.reconnect = { initialDelayMs: 500, maxDelayMs: 10_000, ...reconnect }
    this.tls = tls ?? null
    this.failures = 0
    this.lastError = null
    this.lastReadyAt = 0
    this.latencyMs = null
    this.lastProbeAt = 0

    this.socket = null
    this.buffer = ''
    this.online = false
    this.closed = false
    this.attempt = 0
    this.reconnectTimer = null
    this.waiters = new Set()
    this.readyWaiters = new Map()
    this.controllers = new Map()
  }

  /** Start connecting; resolves once registered (or rejects on timeout). */
  async start(timeoutMs = 5_000) {
    if (this.socket) return
    this.connect()
    await this.whenOnline(timeoutMs)
  }

  whenOnline(timeoutMs = 5_000) {
    if (this.online) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject }
      this.waiters.add(waiter)
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error('relay connection timed out'))
      }, timeoutMs)
      timer.unref?.()
      waiter.timer = timer
    })
  }

  connect() {
    if (this.closed) return
    let tlsOptions
    try {
      tlsOptions = clientTlsOptions(this.tls)
    } catch (error) {
      // A bad certificate path is a configuration error, not a transient one.
      this.emit('relay-error', { code: error?.code ?? 'bad-tls-config', message: String(error?.message ?? error) })
      this.closed = true
      return
    }
    const socket = tlsOptions
      ? nodeTls.connect({ host: this.host, port: this.port, ...tlsOptions })
      : net.connect({ host: this.host, port: this.port })
    this.socket = socket
    this.buffer = ''
    socket.setNoDelay?.(true)
    socket.once(tlsOptions ? 'secureConnect' : 'connect', () => {
      const ts = Date.now()
      this.send({
        t: 'register',
        fleetId: this.fleetId,
        deviceId: this.deviceId,
        ts,
        token: relayAuthToken({ fleetKey: this.fleetKey, fleetId: this.fleetId, deviceId: this.deviceId, ts }),
      })
    })
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('error', (error) => {
      this.lastError = String(error?.message ?? error)
    })
    socket.once('close', () => this.onClose(socket))
  }

  send(message) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return false
    this.socket.write(JSON.stringify(message) + '\n')
    return true
  }

  /** Measure control-plane RTT through the relay (sets latencyMs on pong). */
  probe() {
    if (!this.online) return false
    this.lastProbeAt = Date.now()
    return this.send({ t: 'ping', ts: this.lastProbeAt })
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8')
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim() !== '') this.onMessage(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  onMessage(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    switch (message?.t) {
      case 'register.ok': {
        this.online = true
        this.attempt = 0
        this.failures = 0
        this.lastError = null
        this.lastReadyAt = Date.now()
        for (const waiter of this.waiters) {
          this.waiters.delete(waiter)
          clearTimeout(waiter.timer)
          waiter.resolve()
        }
        this.emit('online', { deviceId: this.deviceId })
        return
      }
      case 'pong': {
        const sentAt = Number(message.ts)
        if (Number.isFinite(sentAt) && sentAt > 0) {
          this.latencyMs = Math.max(0, Date.now() - sentAt)
          this.emit('latency', this.latencyMs)
        }
        return
      }
      case 'error': {
        this.lastError = String(message.message ?? message.code ?? 'relay error')
        this.emit('relay-error', message)
        if (message.code === 'unauthorized' || message.code === 'unknown-fleet') {
          this.closed = true
          this.socket?.destroy()
        } else if (message.code === 'replaced') {
          // A duplicate/rogue registration can kick us; reconnect with backoff
          // instead of permanently disabling the relay path.
          this.socket?.destroy()
        }
        return
      }
      case 'incoming': {
        const { reqId, fromDeviceId } = message
        const controller = {
          reqId,
          fromDeviceId,
          decided: false,
          accept: () => this.acceptIncoming(controller),
          reject: () => {
            controller.decided = true
            this.controllers.delete(reqId)
            this.send({ t: 'reject', reqId })
          },
        }
        this.controllers.set(reqId, controller)
        this.emit('incoming', controller)
        return
      }
      case 'connect.pending':
        return
      case 'connect.ready': {
        const waiter = this.readyWaiters.get(message.reqId)
        if (!waiter) return
        this.readyWaiters.delete(message.reqId)
        clearTimeout(waiter.timer)
        waiter.resolve({ dataPort: message.dataPort, token: message.token })
        return
      }
      case 'connect.fail': {
        const waiter = this.readyWaiters.get(message.reqId)
        if (waiter) {
          this.readyWaiters.delete(message.reqId)
          clearTimeout(waiter.timer)
          waiter.reject(Object.assign(new Error(`relay connect failed: ${message.reason}`), { code: message.reason }))
        }
        const connectWaiter = this.connectWaiters?.get(message.reqId)
        if (connectWaiter) {
          this.connectWaiters.delete(message.reqId)
          clearTimeout(connectWaiter.timer)
          connectWaiter.reject(Object.assign(new Error(`relay connect failed: ${message.reason}`), { code: message.reason }))
        }
        return
      }
      default:
        return
    }
  }

  waitReady(reqId, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters.delete(reqId)
        reject(Object.assign(new Error('relay data path timed out'), { code: 'data-timeout' }))
      }, timeoutMs)
      timer.unref?.()
      this.readyWaiters.set(reqId, { resolve, reject, timer })
    })
  }

  async acceptIncoming(controller) {
    if (controller.decided) throw new Error('incoming request already settled')
    controller.decided = true
    this.controllers.delete(controller.reqId)
    const ready = this.waitReady(controller.reqId)
    this.send({ t: 'accept', reqId: controller.reqId })
    const { dataPort, token } = await ready
    return this.openDataSocket(controller.reqId, token, dataPort)
  }

  async requestConnect(targetDeviceId, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
    if (!this.online) await this.whenOnline(Math.min(timeoutMs, 5_000))
    const reqId = randomUUID()
    const ready = this.waitReady(reqId, timeoutMs)
    this.send({ t: 'connect', reqId, targetDeviceId })
    const { dataPort, token } = await ready
    return this.openDataSocket(reqId, token, dataPort)
  }

  openDataSocket(reqId, token, dataPort = this.dataPort) {
    return new Promise((resolve, reject) => {
      let tlsOptions
      try {
        tlsOptions = clientTlsOptions(this.tls)
      } catch (error) {
        reject(error)
        return
      }
      const socket = tlsOptions
        ? nodeTls.connect({ host: this.host, port: dataPort, ...tlsOptions })
        : net.connect({ host: this.host, port: dataPort })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(Object.assign(new Error('relay data connection timed out'), { code: 'data-timeout' }))
      }, DEFAULT_CONNECT_TIMEOUT_MS)
      timer.unref?.()
      socket.setNoDelay?.(true)
      socket.once(tlsOptions ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer)
        socket.write(
          JSON.stringify({ fleetId: this.fleetId, deviceId: this.deviceId, reqId, token }) + '\n',
        )
        resolve(socket)
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  onClose(socket) {
    if (this.socket !== socket) return
    this.socket = null
    const wasOnline = this.online
    this.online = false
    if (wasOnline) this.emit('offline')
    for (const [reqId, waiter] of this.readyWaiters) {
      this.readyWaiters.delete(reqId)
      clearTimeout(waiter.timer)
      waiter.reject(Object.assign(new Error('relay connection lost'), { code: 'relay-offline' }))
    }
    if (this.closed) return
    const delay = Math.min(
      this.reconnect.maxDelayMs,
      this.reconnect.initialDelayMs * 2 ** Math.min(this.attempt++, 5),
    )
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
    this.reconnectTimer.unref?.()
  }

  /** Drop the current connection and reconnect, re-reading cert/key files. */
  async reconnect(timeoutMs = 5_000) {
    this.closed = false
    clearTimeout(this.reconnectTimer)
    this.attempt = 0
    const previous = this.socket
    this.socket = null
    this.online = false
    try {
      previous?.destroy()
    } catch {
      /* ignore */
    }
    this.connect()
    await this.whenOnline(timeoutMs)
  }

  close() {
    this.closed = true
    clearTimeout(this.reconnectTimer)
    try {
      this.socket?.destroy()
    } catch {
      /* ignore */
    }
    this.socket = null
  }
}
