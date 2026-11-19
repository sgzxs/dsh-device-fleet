// Durable outbox for direct calls/delegations that should run when a target
// device reconnects. This is opt-in (`fleet_queue_*`): ordinary fleet_* calls
// keep the documented fail-fast semantics.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const MAX_ENTRIES = 200

export class Outbox {
  constructor({ file, maxEntries = MAX_ENTRIES, now = Date.now } = {}) {
    if (typeof file !== 'string' || file === '') throw new Error('Outbox requires a file path')
    this.file = file
    this.maxEntries = Math.max(20, Math.min(2_000, Number(maxEntries) || MAX_ENTRIES))
    this.now = now
    this.entries = []
    this.load()
  }

  load() {
    try {
      this.entries = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8'))?.entries ?? [] : []
    } catch {
      this.entries = []
    }
    this.entries = this.entries.filter((entry) => entry && typeof entry.id === 'string')
    // A process restart can leave an entry marked running with no worker.
    for (const entry of this.entries) {
      if (entry.status === 'running') {
        entry.status = 'queued'
        entry.startedAt = null
        entry.error = 'process restart'
      }
    }
    this.prune()
  }

  save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.file)
    } catch {
      /* outbox persistence is best effort */
    }
  }

  add({ deviceId, kind, request, label = '' } = {}) {
    if (typeof deviceId !== 'string' || deviceId === '') return null
    if (kind !== 'call' && kind !== 'delegate') return null
    const entry = {
      id: randomUUID(),
      deviceId,
      kind,
      request,
      label: typeof label === 'string' ? label : '',
      status: 'queued',
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
      resultText: null,
      error: null,
    }
    this.entries.unshift(entry)
    this.entries = this.entries.slice(0, this.maxEntries)
    this.save()
    return entry
  }

  list({ status = null } = {}) {
    return this.entries
      .filter((entry) => (status ? entry.status === status : true))
      .map((entry) => ({ ...entry }))
  }

  pendingFor(deviceId) {
    return this.entries.filter((entry) => entry.deviceId === deviceId && entry.status === 'queued')
  }

  get(id) {
    return this.entries.find((entry) => entry.id === id) ?? null
  }

  update(id, patch = {}) {
    const entry = this.get(id)
    if (!entry) return null
    Object.assign(entry, patch)
    this.save()
    return { ...entry }
  }

  remove(id) {
    const before = this.entries.length
    this.entries = this.entries.filter((entry) => entry.id !== id)
    if (this.entries.length !== before) this.save()
    return this.entries.length !== before
  }

  prune(now = this.now()) {
    // Keep failures for inspection, but cap the queue size.
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(0, this.maxEntries)
      this.save()
    }
    return this.entries.length
  }
}
