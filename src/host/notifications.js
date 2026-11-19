// Local notification feed for the Fleet console. It is deliberately small and
// in-memory: notifications describe things the user should look at (approvals,
// revocations, rotation forks), while the durable evidence stays in the
// existing JSONL audit files.
import { randomUUID } from 'node:crypto'

export class NotificationCenter {
  constructor({ now = Date.now, limit = 100, onPush = null } = {}) {
    this.now = now
    this.limit = Number.isInteger(limit) && limit > 0 ? limit : 100
    this.onPush = typeof onPush === 'function' ? onPush : null
    /** @type {Array<{id: string, kind: string, title: string, body: string, data: object|null, createdAt: number, read: boolean}>} */
    this.items = []
  }

  push({ kind = 'info', title = '', body = '', data = null } = {}) {
    const entry = {
      id: randomUUID(),
      kind: String(kind),
      title: String(title),
      body: String(body ?? ''),
      data: data && typeof data === 'object' ? data : null,
      createdAt: this.now(),
      read: false,
    }
    this.items.unshift(entry)
    if (this.items.length > this.limit) this.items.length = this.limit
    try {
      this.onPush?.(entry)
    } catch {
      /* notification delivery is best effort */
    }
    return entry
  }

  list({ limit = 50 } = {}) {
    const size = Number.isInteger(limit) && limit > 0 ? limit : 50
    return this.items.slice(0, size).map((entry) => ({ ...entry }))
  }

  unreadCount() {
    return this.items.reduce((count, entry) => count + (entry.read ? 0 : 1), 0)
  }

  markRead({ ids = null, all = false } = {}) {
    if (all === true) {
      for (const entry of this.items) entry.read = true
      return this.items.length
    }
    const wanted = new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string'))
    let changed = 0
    for (const entry of this.items) {
      if (!wanted.has(entry.id) || entry.read) continue
      entry.read = true
      changed += 1
    }
    return changed
  }
}
