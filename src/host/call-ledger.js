// Persistent local call ledger used by the Fleet console's "calls" view.
// Entries contain metadata only (no full arguments/results), so peers can
// exchange them for a read-only cross-device overview.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const MAX_ENTRIES = 500
const SUMMARY_LIMIT = 240

function summarize(value) {
  if (value === null || value === undefined) return ''
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text
  } catch {
    return '[unserializable]'
  }
}

export class CallLedger {
  constructor({ file, limit = MAX_ENTRIES, now = Date.now } = {}) {
    if (typeof file !== 'string' || file === '') throw new Error('CallLedger requires a file path')
    this.file = file
    this.limit = Math.max(20, Math.min(5_000, Number(limit) || MAX_ENTRIES))
    this.now = now
    this.entries = []
    this.load()
  }

  load() {
    this.entries = []
    try {
      if (!existsSync(this.file)) return
      const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
      this.entries = lines.slice(-this.limit).map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).filter(Boolean).reverse()
    } catch {
      /* corrupt ledger must not block startup */
    }
  }

  record(entry = {}) {
    const record = {
      id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : randomUUID(),
      at: Number(entry.at) || this.now(),
      direction: entry.direction === 'inbound' ? 'inbound' : 'outbound',
      deviceId: typeof entry.deviceId === 'string' ? entry.deviceId : null,
      capability: typeof entry.capability === 'string' ? entry.capability : 'tool',
      tool: typeof entry.tool === 'string' ? entry.tool : null,
      roomId: typeof entry.roomId === 'string' ? entry.roomId : null,
      taskId: typeof entry.taskId === 'string' ? entry.taskId : null,
      sessionId: typeof entry.sessionId === 'string' && entry.sessionId !== '' ? entry.sessionId : null,
      status: entry.status === 'error' ? 'error' : 'ok',
      durationMs: Math.max(0, Number(entry.durationMs) || 0),
      argsSummary: summarize(entry.args),
      resultSummary: summarize(entry.resultText ?? entry.result),
      error: entry.error ? String(entry.error) : null,
    }
    this.entries.unshift(record)
    if (this.entries.length > this.limit) this.entries.length = this.limit
    this.save()
    return record
  }

  list({ limit = 100, deviceId = null, direction = null } = {}) {
    return this.entries
      .filter((entry) => (deviceId ? entry.deviceId === deviceId : true))
      .filter((entry) => (direction ? entry.direction === direction : true))
      .slice(0, Math.max(1, Math.min(this.limit, Number(limit) || 100)))
      .map((entry) => ({ ...entry }))
  }

  save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      const lines = [...this.entries].reverse().map((entry) => JSON.stringify(entry)).join('\n')
      writeFileSync(tmp, lines === '' ? '' : `${lines}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.file)
    } catch {
      /* ledger persistence is best effort */
    }
  }
}
