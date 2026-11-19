// Room replica sync protocol (ADR-0025, Phase 2).
//
// Peers exchange a vector clock, pull missing events, and push their own events.
// Event identity/origin is preserved on import; the local replica assigns its
// own arrival seq. No Host authority is assumed: the caller supplies reachable
// Room member devices, and the most advanced peer wins.
const DEFAULT_TIMEOUT_MS = 10_000

function sumBeyond(clock, localClock) {
  let score = 0
  for (const [origin, seq] of Object.entries(clock ?? {})) {
    const known = Number(localClock?.[origin]) || 0
    if (seq > known) score += seq - known
  }
  return score
}

export class RoomReplicaSync {
  /**
   * @param {object} options
   * @param {import('./room-replica.js').RoomReplicaStore} options.replica
   * @param {object} options.node FleetNode
   * @param {(line: string) => void} [options.warn]
   * @param {number} [options.timeoutMs]
   */
  constructor({ replica, node, warn = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.replica = replica
    this.node = node
    this.warn = warn
    this.timeoutMs = timeoutMs
    this.capabilities = ['events-v1']
    // roomId:deviceId -> { attempts, nextAttemptAt, lastError }
    this.failures = new Map()
    this.backoffBaseMs = 1_000
    this.backoffMaxMs = 60_000
  }

  failureKey(roomId, deviceId) {
    return `${roomId}:${deviceId}`
  }

  retryDelay(attempts) {
    return Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.max(0, attempts - 1))
  }

  noteFailure(roomId, deviceId, error) {
    const key = this.failureKey(roomId, deviceId)
    const previous = this.failures.get(key)
    const attempts = (previous?.attempts ?? 0) + 1
    this.failures.set(key, {
      attempts,
      nextAttemptAt: Date.now() + this.retryDelay(attempts),
      lastError: String(error?.message ?? error),
    })
  }

  noteSuccess(roomId, deviceId) {
    this.failures.delete(this.failureKey(roomId, deviceId))
  }

  isBackedOff(roomId, deviceId, now = Date.now()) {
    const entry = this.failures.get(this.failureKey(roomId, deviceId))
    return Boolean(entry && entry.nextAttemptAt > now)
  }

  syncStatus(roomId, peers = []) {
    return peers.map((deviceId) => {
      const entry = this.failures.get(this.failureKey(roomId, deviceId))
      return entry
        ? { deviceId, attempts: entry.attempts, retryInMs: Math.max(0, entry.nextAttemptAt - Date.now()), lastError: entry.lastError }
        : { deviceId, attempts: 0, retryInMs: 0, lastError: null }
    })
  }

  /** Server side: describe this replica's clock. */
  hello({ roomId } = {}) {
    if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
    return {
      roomId,
      exists: this.replica.hasReplica(roomId),
      vectorClock: this.replica.vectorClock(roomId),
      capabilities: this.capabilities,
    }
  }

  /** Server side: return events the caller's clock has not seen. */
  pull({ roomId, have = {} } = {}) {
    if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
    return {
      roomId,
      events: this.replica.eventsMissingFor(roomId, have),
      vectorClock: this.replica.vectorClock(roomId),
    }
  }

  /** Server side: import events pushed by a peer. */
  push({ roomId, events = [] } = {}) {
    if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
    const imported = this.replica.importEvents(roomId, events)
    return { roomId, imported, vectorClock: this.replica.vectorClock(roomId) }
  }

  /**
   * Client side: probe reachable peers in parallel, pull from the most advanced
   * replica, then push local-only events back to every reachable peer.
   * @param {{roomId: string, peers: string[]}} options
   */
  async syncRoom({ roomId, peers = [], force = false } = {}) {
    if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
    const localClock = this.replica.vectorClock(roomId)
    const now = Date.now()
    const skipped = force ? [] : peers.filter((deviceId) => this.isBackedOff(roomId, deviceId, now))
    const activePeers = peers.filter((deviceId) => !skipped.includes(deviceId))
    const reachable = []
    await Promise.all(activePeers.map(async (deviceId) => {
      try {
        const hello = await this.node.request(deviceId, 'room.sync.hello', { roomId }, { timeoutMs: this.timeoutMs })
        this.noteSuccess(roomId, deviceId)
        reachable.push({ deviceId, hello })
      } catch (error) {
        this.noteFailure(roomId, deviceId, error)
        this.warn(`[device-fleet] room sync hello failed (${deviceId}): ${String(error?.message ?? error)}`)
      }
    }))
    if (reachable.length === 0) return { roomId, pulled: 0, pushed: 0, peers: [], skipped, status: this.syncStatus(roomId, peers) }
    const candidates = reachable.filter((entry) => entry.hello?.exists)
    candidates.sort((left, right) => sumBeyond(right.hello.vectorClock, localClock) - sumBeyond(left.hello.vectorClock, localClock))
    const best = candidates[0] ?? null
    let pulled = 0
    if (best) {
      try {
        const response = await this.node.request(best.deviceId, 'room.sync.pull', { roomId, have: localClock }, { timeoutMs: this.timeoutMs })
        pulled = this.replica.importEvents(roomId, response?.events ?? [])
        this.noteSuccess(roomId, best.deviceId)
      } catch (error) {
        this.noteFailure(roomId, best.deviceId, error)
        this.warn(`[device-fleet] room sync pull failed (${best.deviceId}): ${String(error?.message ?? error)}`)
      }
    }
    let pushed = 0
    await Promise.all(reachable.map(async ({ deviceId, hello }) => {
      const events = this.replica.eventsMissingFor(roomId, hello.vectorClock)
      if (events.length === 0) return
      try {
        const response = await this.node.request(deviceId, 'room.sync.push', { roomId, events }, { timeoutMs: this.timeoutMs })
        pushed += response?.imported ?? 0
        this.noteSuccess(roomId, deviceId)
      } catch (error) {
        this.noteFailure(roomId, deviceId, error)
        this.warn(`[device-fleet] room sync push failed (${deviceId}): ${String(error?.message ?? error)}`)
      }
    }))
    return { roomId, pulled, pushed, peers: reachable.map((entry) => entry.deviceId), skipped, status: this.syncStatus(roomId, peers) }
  }
}
