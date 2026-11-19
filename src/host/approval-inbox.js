// Local approval inbox (ADR-0020): a target device asks its own user before a
// remote call/delegation with the `ask` policy can run. Agents may list pending
// requests read-only (`fleet_approvals`); approve/deny decisions are made by the
// local UI (HTTP routes). `fleet_simulate_request` exercises the flow.
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const APPROVAL_SCOPES = ['once', 'ttl', 'room', 'task']

const SUMMARY_ARG_LENGTH = 160

function summarizeArgs(args) {
  try {
    const text = JSON.stringify(args ?? {})
    return text.length > SUMMARY_ARG_LENGTH ? `${text.slice(0, SUMMARY_ARG_LENGTH)}…` : text
  } catch {
    return '[unserializable arguments]'
  }
}

export class ApprovalInbox extends EventEmitter {
  constructor({ ttlMs = 60_000, maxPending = 50, historyLimit = 50, now = Date.now, onAudit = null, stateFile = null } = {}) {
    super()
    this.ttlMs = ttlMs
    this.maxPending = maxPending
    this.historyLimit = historyLimit
    this.now = now
    this.onAudit = onAudit
    this.stateFile = typeof stateFile === 'string' && stateFile !== '' ? stateFile : null
    this.closed = false
    /** @type {Map<string, any>} */
    this.pending = new Map()
    /** @type {any[]} */
    this.historyEntries = []
    this.loadState()
  }

  loadState() {
    if (!this.stateFile) return
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      for (const saved of Array.isArray(parsed?.pending) ? parsed.pending : []) {
        if (!saved || typeof saved.id !== 'string') continue
        if (Number(saved.expiresAt ?? 0) <= this.now()) {
          this.record({ ...saved, status: 'expired' }, 'expired')
          continue
        }
        const entry = {
          ...saved,
          status: 'pending',
          resumed: true,
          promise: null,
          resolve: null,
          timer: null,
        }
        entry.timer = setTimeout(() => this.expire(entry.id), Math.max(0, entry.expiresAt - this.now()))
        entry.timer.unref?.()
        this.pending.set(entry.id, entry)
      }
    } catch {
      /* a corrupt approval file must not block startup */
    }
  }

  saveState() {
    if (!this.stateFile) return
    try {
      mkdirSync(path.dirname(this.stateFile), { recursive: true })
      const pending = [...this.pending.values()]
        .filter((entry) => entry.status === 'pending')
        .map(({ promise, resolve, timer, ...entry }) => entry)
      const tmp = `${this.stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, pending }, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.stateFile)
    } catch {
      /* persistence is best effort */
    }
  }

  record(entry, outcome, extra = {}) {
    const recorded = {
      id: entry.id,
      fromDeviceId: entry.fromDeviceId,
      capability: entry.capability,
      tool: entry.tool,
      reason: entry.reason,
      argsSummary: entry.argsSummary,
      roomId: entry.roomId ?? null,
      taskId: entry.taskId ?? null,
      createdAt: entry.createdAt,
      resolvedAt: this.now(),
      outcome,
      ...extra,
    }
    this.historyEntries.unshift(recorded)
    if (this.historyEntries.length > this.historyLimit) this.historyEntries.length = this.historyLimit
    if (typeof this.onAudit === 'function') {
      try {
        this.onAudit({ ...recorded })
      } catch {
        /* audit is best effort */
      }
    }
  }

  /** Recently resolved requests (newest first). */
  history() {
    return this.historyEntries.map((entry) => ({ ...entry }))
  }

  /**
   * Ask the local user. Resolves `{ approved, scope?, reason? }` when approved,
   * denied, expired or closed.
   */
  request(request) {
    if (this.closed) return Promise.resolve({ approved: false, reason: 'inbox-closed' })
    if (this.pending.size >= this.maxPending) {
      return Promise.resolve({ approved: false, reason: 'inbox-full' })
    }
    const id = randomUUID()
    const createdAt = this.now()
    const entry = {
      id,
      fromDeviceId: request.fromDeviceId ?? 'unknown',
      capability: request.capability ?? 'tool',
      tool: request.tool ?? null,
      reason: request.reason ?? '',
      argsSummary: summarizeArgs(request.args),
      roomId: typeof request.roomId === 'string' && request.roomId !== '' ? request.roomId : null,
      taskId: typeof request.taskId === 'string' && request.taskId !== '' ? request.taskId : null,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      status: 'pending',
    }
    entry.promise = new Promise((resolve) => {
      entry.resolve = resolve
    })
    entry.timer = setTimeout(() => this.expire(id), this.ttlMs)
    entry.timer.unref?.()
    this.pending.set(id, entry)
    this.saveState()
    this.emit('request', this.summary(entry))
    return entry.promise
  }

  summary(entry) {
    return {
      id: entry.id,
      fromDeviceId: entry.fromDeviceId,
      capability: entry.capability,
      tool: entry.tool,
      reason: entry.reason,
      argsSummary: entry.argsSummary,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      expiresInMs: Math.max(0, entry.expiresAt - this.now()),
      roomId: entry.roomId ?? null,
      taskId: entry.taskId ?? null,
      status: entry.status,
      resumed: entry.resumed === true,
    }
  }

  list() {
    return [...this.pending.values()]
      .filter((entry) => entry.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((entry) => this.summary(entry))
  }

  approve(id, { scope = 'once' } = {}) {
    const pending = this.pending.get(id)
    if (!pending || pending.status !== 'pending') {
      throw Object.assign(new Error(`unknown approval request: ${String(id)}`), { code: 'unknown-request' })
    }
    const chosen = APPROVAL_SCOPES.includes(scope) ? scope : 'once'
    if (chosen === 'room' && !pending.roomId) {
      throw Object.assign(new Error('room scope needs a Room context'), { code: 'bad-request' })
    }
    if (chosen === 'task' && !pending.taskId) {
      throw Object.assign(new Error('task scope needs a task context'), { code: 'bad-request' })
    }
    const entry = this.settle(id, 'approved')
    if (!entry) throw Object.assign(new Error(`unknown approval request: ${String(id)}`), { code: 'unknown-request' })
    const grantContext = {
      scope: chosen,
      ...(chosen === 'room' ? { roomId: entry.roomId } : {}),
      ...(chosen === 'task' ? { taskId: entry.taskId } : {}),
    }
    entry.resolve?.({ approved: true, ...grantContext })
    this.record(entry, 'approved', grantContext)
    this.saveState()
    this.emit('approved', { ...this.summary(entry), ...grantContext })
    return { ...this.summary(entry), ...grantContext }
  }

  deny(id, reason = 'denied by local user') {
    const entry = this.settle(id, 'denied')
    if (!entry) throw Object.assign(new Error(`unknown approval request: ${String(id)}`), { code: 'unknown-request' })
    entry.resolve?.({ approved: false, reason })
    this.record(entry, 'denied', { reason })
    this.saveState()
    this.emit('denied', { ...this.summary(entry), reason })
    return { ...this.summary(entry), reason }
  }

  expire(id) {
    const entry = this.pending.get(id)
    if (!entry || entry.status !== 'pending') return
    entry.status = 'expired'
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve?.({ approved: false, reason: 'approval-timeout' })
    this.record(entry, 'expired')
    this.saveState()
    this.emit('expired', this.summary(entry))
  }

  settle(id, status) {
    const entry = this.pending.get(id)
    if (!entry || entry.status !== 'pending') return undefined
    entry.status = status
    this.pending.delete(id)
    clearTimeout(entry.timer)
    return entry
  }

  /** Close the inbox: every pending request fails closed. */
  close() {
    if (this.closed) return
    this.closed = true
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.status = 'closed'
      entry.resolve?.({ approved: false, reason: 'inbox-closed' })
      this.record(entry, 'closed')
    }
    this.pending.clear()
    this.saveState()
    this.emit('closed')
  }
}
