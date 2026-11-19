// Bounded, redacted, append-only mirror of DSH session events.
// The owning device persists events as JSONL so a trajectory survives a plugin
// reload; peers can pull one session over the authenticated Fleet RPC.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const MAX_EVENTS_PER_SESSION = 800
const MAX_SESSIONS = 200
const MAX_EVENT_BYTES = 16 * 1024
const MAX_FILE_BYTES = 16 * 1024 * 1024
const RETENTION_DAYS = 7
const SENSITIVE_KEY = /(?:secret|token|password|passwd|api[_-]?key|authorization|cookie|private[_-]?key|credential)/i

function redactValue(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (depth > 6) return '[depth-limit]'
  if (typeof value === 'string') return value.length > 2_000 ? `${value.slice(0, 2_000)}…[truncated]` : value
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1))
  const out = {}
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactValue(item, depth + 1)
  }
  return out
}

function serializeEvent(event) {
  const type = typeof event?.type === 'string' ? event.type : 'event'
  const at = Number(event?.createdAt ?? event?.at ?? Date.now()) || Date.now()
  let data = redactValue(event?.data ?? null)
  try {
    const encoded = JSON.stringify(data)
    if (typeof encoded === 'string' && encoded.length > MAX_EVENT_BYTES) {
      data = { truncated: true, preview: encoded.slice(0, MAX_EVENT_BYTES) }
    }
  } catch {
    data = { unserializable: true }
  }
  return { type, at, data }
}

export class TrajectoryStore {
  constructor({ file = null, maxEvents = MAX_EVENTS_PER_SESSION, maxSessions = MAX_SESSIONS, now = Date.now } = {}) {
    this.file = typeof file === 'string' && file !== '' ? file : null
    this.ownersFile = this.file ? `${this.file}.owners.json` : null
    this.maxEvents = Math.max(1, Number(maxEvents) || MAX_EVENTS_PER_SESSION)
    this.maxSessions = Math.max(1, Number(maxSessions) || MAX_SESSIONS)
    this.now = now
    this.sessions = new Map()
    this.owners = new Map()
    this.load()
  }

  load() {
    if (!this.file || !existsSync(this.file)) return
    try {
      if (this.ownersFile && existsSync(this.ownersFile)) {
        const owners = JSON.parse(readFileSync(this.ownersFile, 'utf8'))
        for (const [sessionId, owner] of Object.entries(owners?.owners ?? {})) {
          if (typeof owner === 'string') this.owners.set(sessionId, owner)
        }
      }
    } catch {
      /* corrupt owner map fails closed for remote reads */
    }
    let text = ''
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    const cutoff = this.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    for (const line of text.split('\n')) {
      if (line === '') continue
      try {
        const entry = JSON.parse(line)
        if (!entry || typeof entry.sessionId !== 'string' || !entry.event) continue
        if (typeof entry.owner === 'string') this.owners.set(entry.sessionId, entry.owner)
        if (Number(entry.event.at) < cutoff) continue
        this.record(entry.sessionId, entry.event, { persist: false })
      } catch {
        /* skip corrupt line */
      }
    }
    this.compact()
  }

  record(sessionId, event, { persist = true } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '' || !event) return false
    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = { sessionId, firstAt: this.now(), lastAt: 0, events: [] }
      this.sessions.set(sessionId, entry)
      while (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value)
    }
    const item = serializeEvent(event)
    entry.events.push(item)
    entry.lastAt = item.at
    if (entry.events.length > this.maxEvents) entry.events.splice(0, entry.events.length - this.maxEvents)
    if (persist) this.append({ sessionId, event: item })
    return true
  }

  append(entry) {
    if (!this.file) return
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${JSON.stringify({ ...entry, owner: this.owners.get(entry.sessionId) ?? null })}\n`, { encoding: 'utf8', mode: 0o600 })
      try {
        chmodSync(this.file, 0o600)
      } catch {
        /* Windows ACLs ignore POSIX modes */
      }
      if (statSync(this.file).size > MAX_FILE_BYTES) this.compact()
    } catch {
      /* persistence is best effort */
    }
  }

  /** Bind a delegated child session to the device that requested it. */
  setOwner(sessionId, ownerDeviceId) {
    if (typeof sessionId !== 'string' || typeof ownerDeviceId !== 'string' || ownerDeviceId === '') return false
    this.owners.set(sessionId, ownerDeviceId)
    if (this.ownersFile) {
      try {
        mkdirSync(path.dirname(this.ownersFile), { recursive: true })
        const tmp = `${this.ownersFile}.tmp`
        writeFileSync(tmp, JSON.stringify({ version: 1, owners: Object.fromEntries(this.owners) }, null, 2), { encoding: 'utf8', mode: 0o600 })
        renameSync(tmp, this.ownersFile)
        try {
          chmodSync(this.ownersFile, 0o600)
        } catch {
          /* Windows ACLs ignore POSIX modes */
        }
      } catch {
        /* best effort */
      }
    }
    return true
  }

  ownerOf(sessionId) {
    return this.owners.get(sessionId) ?? null
  }

  compact() {
    if (!this.file) return
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const lines = []
      for (const entry of this.sessions.values()) {
        for (const event of entry.events) lines.push(JSON.stringify({ sessionId: entry.sessionId, event, owner: this.owners.get(entry.sessionId) ?? null }))
      }
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, lines.length === 0 ? '' : `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.file)
      try {
        chmodSync(this.file, 0o600)
      } catch {
        /* Windows ACLs ignore POSIX modes */
      }
    } catch {
      /* best effort */
    }
  }

  get(sessionId) {
    const entry = this.sessions.get(sessionId)
    if (!entry) return null
    return { sessionId: entry.sessionId, firstAt: entry.firstAt, lastAt: entry.lastAt, events: [...entry.events] }
  }

  list() {
    return [...this.sessions.values()].map((entry) => ({
      sessionId: entry.sessionId,
      firstAt: entry.firstAt,
      lastAt: entry.lastAt,
      count: entry.events.length,
    }))
  }

  clear() {
    this.sessions.clear()
    this.owners.clear()
    this.compact()
  }
}
