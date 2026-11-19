// LAN discovery over UDP multicast. Announcements carry only a fleet hash,
// device id, display name and the direct listening port; the real trust
// decision happens in the secure-channel handshake.
import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import { fleetHash } from './identity.js'

export const DEFAULT_DISCOVERY_GROUP = '239.255.42.99'
export const DEFAULT_DISCOVERY_PORT = 47833

export class LanDiscovery extends EventEmitter {
  constructor({
    fleetId,
    deviceId,
    name = 'device',
    directPort,
    group = DEFAULT_DISCOVERY_GROUP,
    port = DEFAULT_DISCOVERY_PORT,
    intervalMs = 3_000,
  }) {
    super()
    this.fleetId = fleetId
    this.deviceId = deviceId
    this.name = name
    this.directPort = directPort
    this.group = group
    this.port = port
    this.intervalMs = intervalMs
    this.socket = null
    this.timer = null
    this.closed = false
    this.peers = new Map()
  }

  start() {
    if (this.socket) return
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket.on('message', (buffer, rinfo) => this.onMessage(buffer, rinfo))
    this.socket.on('error', (error) => this.emit('error', error))
    this.socket.bind(this.port, () => {
      try {
        this.socket.addMembership(this.group)
        this.socket.setMulticastTTL(1)
        this.socket.setMulticastLoopback(true)
      } catch (error) {
        this.emit('error', error)
      }
      this.announce()
      this.timer = setInterval(() => this.announce(), this.intervalMs)
      this.timer.unref?.()
      this.emit('listening', { group: this.group, port: this.port })
    })
  }

  announce() {
    if (!this.socket || this.closed) return
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        fleetHash: fleetHash(this.fleetId),
        deviceId: this.deviceId,
        name: this.name,
        port: this.directPort,
        ts: Date.now(),
      }),
    )
    this.socket.send(payload, 0, payload.length, this.port, this.group, () => {})
  }

  onMessage(buffer, rinfo) {
    if (this.closed) return
    let message
    try {
      message = JSON.parse(buffer.toString('utf8'))
    } catch {
      return
    }
    if (message?.v !== 1) return
    if (message.fleetHash !== fleetHash(this.fleetId)) return
    if (typeof message.deviceId !== 'string' || message.deviceId === this.deviceId) return
    if (typeof message.port !== 'number' || message.port <= 0 || message.port > 65535) return
    const peer = {
      deviceId: message.deviceId,
      name: typeof message.name === 'string'
        ? message.name.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 64) || 'device'
        : 'device',
      host: rinfo.address,
      port: message.port,
      lastSeen: Date.now(),
    }
    const cutoff = Date.now() - 60_000
    for (const [deviceId, entry] of this.peers) {
      if (entry.lastSeen < cutoff) this.peers.delete(deviceId)
    }
    if (this.peers.size >= 100 && !this.peers.has(peer.deviceId)) return
    this.peers.set(peer.deviceId, peer)
    this.emit('peer', peer)
  }

  close() {
    this.closed = true
    clearInterval(this.timer)
    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        /* ignore */
      }
      this.socket = null
    }
  }
}
