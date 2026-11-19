// Durable queue for Room/task grant revocations that could not be delivered
// because the target device was offline. The owner retries on peer connect and
// periodically; entries older than maxAgeMs are dropped (the target's grant
// also has a maximum lifetime as a backstop).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const VERSION = 1

export class ScopeRevocationQueue {
  constructor({ file, now = Date.now, maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    if (typeof file !== 'string' || file === '') throw new Error('ScopeRevocationQueue requires a file path')
    this.file = file
    this.now = now
    this.maxAgeMs = maxAgeMs
    /** @type {Map<string, any>} */
    this.entries = new Map()
    this.load()
  }

  load() {
    this.entries.clear()
    try {
      if (!existsSync(this.file)) return
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      for (const [key, entry] of Object.entries(parsed?.entries ?? {})) {
        if (entry && typeof entry.deviceId === 'string' && typeof entry.kind === 'string') {
          this.entries.set(key, entry)
        }
      }
    } catch {
      /* a corrupt queue must not prevent the plugin from starting */
    }
  }

  save() {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: VERSION, entries: Object.fromEntries(this.entries) }, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.file)
  }

  keyFor({ deviceId, kind, roomId = null, taskId = null }) {
    return `${deviceId}|${kind}|${kind === 'room' ? roomId : taskId}`
  }

  add({ deviceId, kind, roomId = null, taskId = null } = {}) {
    if (typeof deviceId !== 'string' || deviceId === '') return null
    if (kind !== 'room' && kind !== 'task') return null
    if (kind === 'room' && (typeof roomId !== 'string' || roomId === '')) return null
    if (kind === 'task' && (typeof taskId !== 'string' || taskId === '')) return null
    const key = this.keyFor({ deviceId, kind, roomId, taskId })
    this.entries.set(key, { key, deviceId, kind, roomId, taskId, at: this.now() })
    this.prune()
    this.save()
    return key
  }

  remove(key) {
    if (this.entries.delete(key)) this.save()
  }

  listFor(deviceId) {
    return [...this.entries.values()].filter((entry) => entry.deviceId === deviceId)
  }

  all() {
    return [...this.entries.values()]
  }

  prune(now = this.now()) {
    let changed = false
    for (const [key, entry] of this.entries) {
      if (now - Number(entry.at ?? 0) > this.maxAgeMs) {
        this.entries.delete(key)
        changed = true
      }
    }
    return changed
  }
}
