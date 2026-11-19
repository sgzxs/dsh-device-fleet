// Target-device tool policy (ADR-0004, ADR-0019, ADR-0020).
// The policy owns: allowed roots, per-capability mode (auto/ask/deny),
// the raw-tool allowlist, and short-lived grants created by approvals.
import fs from 'node:fs'
import path from 'node:path'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export const CAPABILITIES = ['read', 'list', 'grep', 'fetch', 'run', 'tool', 'delegate', 'write']

/** Safety net: Room/task grants expire even if the revoke notification is lost. */
export const SCOPE_GRANT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export const DEFAULT_POLICY = Object.freeze({
  allowedRoots: [],
  capabilities: {
    read: 'auto',
    list: 'auto',
    grep: 'auto',
    fetch: 'auto',
    run: 'ask',
    tool: 'ask',
    delegate: 'ask',
    write: 'ask',
  },
  allowedTools: [],
  approvalTtlMs: 15 * 60 * 1000,
})

/** Resolve symlinks for both existing paths and non-existing upload targets. */
function canonicalPath(candidate) {
  const absolute = path.resolve(String(candidate))
  try {
    let probe = absolute
    const suffix = []
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe)
      if (parent === probe) return absolute
      suffix.unshift(path.basename(probe))
      probe = parent
    }
    // A dangling symlink is invisible to existsSync but a write would follow it
    // outside the root. Reject the symlink component instead of treating it as
    // a new file.
    const firstMissing = suffix.length > 0 ? path.join(probe, suffix[0]) : absolute
    try {
      if (fs.lstatSync(firstMissing).isSymbolicLink() && suffix.length > 0) return null
    } catch {
      /* not a symlink / missing */
    }
    if (suffix.length === 0) {
      try {
        if (fs.lstatSync(absolute).isSymbolicLink()) {
          try {
            return fs.realpathSync.native ? fs.realpathSync.native(absolute) : fs.realpathSync(absolute)
          } catch {
            return null
          }
        }
      } catch {
        return absolute
      }
    }
    const real = fs.realpathSync.native ? fs.realpathSync.native(probe) : fs.realpathSync(probe)
    return path.join(real, ...suffix)
  } catch {
    return null
  }
}

/** True when `candidate` resolves inside one of `roots`, after symlink resolution. */
export function pathWithinRoots(roots, candidate) {
  const resolved = canonicalPath(candidate)
  if (resolved === null) return false
  return roots.some((root) => {
    const base = canonicalPath(root)
    if (base === null) return false
    const relative = path.relative(base, resolved)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
}

export class ToolPolicy {
  constructor(config = {}, { stateFile = null } = {}) {
    this.config = normalizeConfig(config)
    this.stateFile = typeof stateFile === 'string' && stateFile !== '' ? stateFile : null
    /** @type {Map<string, {expiresAt: number, remaining: number}>} */
    this.grants = new Map()
    this.loadGrants()
  }

  loadGrants() {
    if (!this.stateFile) return
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      const now = Date.now()
      for (const [key, grant] of Object.entries(parsed?.grants ?? {})) {
        if (!grant || !Number.isFinite(Number(grant.expiresAt)) || Number(grant.expiresAt) <= now) continue
        this.grants.set(key, {
          expiresAt: Number(grant.expiresAt),
          remaining: grant.remaining === null ? Infinity : Number(grant.remaining),
          ...(grant.scope ? { scope: grant.scope } : {}),
          ...(grant.roomId ? { roomId: grant.roomId } : {}),
          ...(grant.taskId ? { taskId: grant.taskId } : {}),
        })
      }
    } catch {
      /* missing/corrupt grants must fail closed */
    }
  }

  saveGrants() {
    if (!this.stateFile) return
    try {
      mkdirSync(path.dirname(this.stateFile), { recursive: true })
      const tmp = `${this.stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, grants: Object.fromEntries(this.grants) }, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.stateFile)
    } catch {
      /* persistence is best effort */
    }
  }

  get roots() {
    return this.config.allowedRoots
  }

  summarize() {
    return {
      allowedRoots: this.roots,
      capabilities: { ...this.config.capabilities },
      allowedTools: [...this.config.allowedTools],
    }
  }

  /** Decide one call: { decision: 'allow' | 'ask' | 'deny', reason, key } */
  decide({ capability, tool = null, args = {}, roomId = null, taskId = null } = {}) {
    const capabilityName = CAPABILITIES.includes(capability) ? capability : 'tool'
    const mode = this.config.capabilities[capabilityName] ?? 'deny'
    const grantKey = `${capabilityName}:${capabilityName === 'tool' ? String(tool) : '*'}`
    // The raw-tool allowlist is a hard gate: not even a previously approved
    // grant may widen it.
    if (capabilityName === 'tool' && this.config.allowedTools.length > 0 && !this.config.allowedTools.includes(String(tool))) {
      return { decision: 'deny', reason: `tool is not in the allowlist: ${String(tool)}`, key: grantKey, capability: capabilityName }
    }
    // Allowed roots are a hard boundary too. Check them before grants so an
    // approval for one in-root path can never unlock an out-of-root path.
    const paths = collectPaths(args)
    const isTrajectoryRead = capabilityName === 'read' && tool === 'fleet.session.trajectory'
    const needsRoots = !isTrajectoryRead && ['read', 'list', 'grep', 'fetch', 'write'].includes(capabilityName)
    if (needsRoots) {
      if (paths.length === 0) {
        return { decision: 'deny', reason: 'path is required for this capability', key: grantKey, capability: capabilityName }
      }
      if (this.roots.length === 0) {
        return { decision: 'deny', reason: 'no allowed roots configured on this device', key: grantKey, capability: capabilityName }
      }
      for (const candidate of paths) {
        if (!pathWithinRoots(this.roots, candidate)) {
          return {
            decision: 'deny',
            reason: `path is outside the allowed roots: ${String(candidate)}`,
            key: grantKey,
            capability: capabilityName,
          }
        }
      }
    }
    if (taskId && this.consumeGrant(scopedGrantKey(grantKey, 'task', taskId))) {
      return { decision: 'allow', reason: 'approved task grant', key: grantKey, capability: capabilityName }
    }
    if (roomId && this.consumeGrant(scopedGrantKey(grantKey, 'room', roomId))) {
      return { decision: 'allow', reason: 'approved room grant', key: grantKey, capability: capabilityName }
    }
    if (this.consumeGrant(grantKey)) return { decision: 'allow', reason: 'approved grant', key: grantKey, capability: capabilityName }

    if (capabilityName === 'run' && this.config.capabilities.run === 'allow') {
      return { decision: 'allow', reason: 'run is allowed by policy', key: grantKey, capability: capabilityName }
    }
    if (capabilityName === 'tool') {
      // Raw tools follow the normal DSH tool pipeline on this device: the
      // target Session's tool pre-execute policy and approval seam decide
      // whether a call runs, asks, or is rejected. `deny` disables raw tools
      // entirely; `ask` adds the plugin-level approval in front of DSH.
      if (mode === 'deny') {
        return { decision: 'deny', reason: 'raw tool calls are disabled by policy', key: grantKey, capability: capabilityName }
      }
      if (mode === 'ask') {
        return { decision: 'ask', reason: 'raw tool call requires local approval', key: grantKey, capability: capabilityName }
      }
      return { decision: 'allow', reason: 'raw tool call follows the DSH tool pipeline', key: grantKey, capability: capabilityName }
    }
    if (mode === 'allow') return { decision: 'allow', reason: 'capability is allowed by policy', key: grantKey, capability: capabilityName }
    if (mode === 'auto') return { decision: 'allow', reason: 'capability is auto-approved', key: grantKey, capability: capabilityName }
    if (mode === 'ask') return { decision: 'ask', reason: 'capability requires local approval', key: grantKey, capability: capabilityName }
    return { decision: 'deny', reason: 'capability is disabled by policy', key: grantKey, capability: capabilityName }
  }

  /** Remember an approval as a expiring grant, a Room-lifetime grant, or a task-lifetime grant. */
  grant(key, { scope = 'once', ttlMs = this.config.approvalTtlMs, now = Date.now(), roomId = null, taskId = null } = {}) {
    if (typeof key !== 'string' || key === '') return
    if (scope === 'room') {
      if (typeof roomId !== 'string' || roomId === '') return
      this.grants.set(scopedGrantKey(key, 'room', roomId), { expiresAt: now + SCOPE_GRANT_MAX_AGE_MS, remaining: Infinity, scope: 'room', roomId })
      this.saveGrants()
      return
    }
    if (scope === 'task') {
      if (typeof taskId !== 'string' || taskId === '') return
      this.grants.set(scopedGrantKey(key, 'task', taskId), { expiresAt: now + SCOPE_GRANT_MAX_AGE_MS, remaining: Infinity, scope: 'task', taskId })
      this.saveGrants()
      return
    }
    const current = this.grants.get(key)
    if (scope === 'once') {
      this.grants.set(key, { expiresAt: now + ttlMs, remaining: (current?.remaining ?? 0) + 1 })
      this.saveGrants()
      return
    }
    this.grants.set(key, { expiresAt: now + ttlMs, remaining: Infinity })
    this.saveGrants()
  }

  /** Revoke every Room-scoped grant when that Room closes. */
  revokeRoom(roomId) {
    if (typeof roomId !== 'string' || roomId === '') return
    const suffix = `@room:${roomId}`
    let changed = false
    for (const key of this.grants.keys()) {
      if (key.endsWith(suffix)) {
        this.grants.delete(key)
        changed = true
      }
    }
    if (changed) this.saveGrants()
  }

  /** Revoke every task-scoped grant when the task completes. */
  revokeTask(taskId) {
    if (typeof taskId !== 'string' || taskId === '') return
    const suffix = `@task:${taskId}`
    let changed = false
    for (const key of this.grants.keys()) {
      if (key.endsWith(suffix)) {
        this.grants.delete(key)
        changed = true
      }
    }
    if (changed) this.saveGrants()
  }

  consumeGrant(key) {
    const grant = this.grants.get(key)
    if (!grant) return false
    if (grant.expiresAt <= Date.now()) {
      this.grants.delete(key)
      this.saveGrants()
      return false
    }
    if (Number.isFinite(grant.remaining)) {
      grant.remaining -= 1
      if (grant.remaining <= 0) this.grants.delete(key)
      this.saveGrants()
    }
    return true
  }

  revokeAll() {
    this.grants.clear()
    this.saveGrants()
  }
}

function normalizeConfig(config) {
  const capabilities = { ...DEFAULT_POLICY.capabilities }
  for (const [key, value] of Object.entries(config.capabilities ?? {})) {
    if (CAPABILITIES.includes(key) && ['auto', 'ask', 'deny', 'allow'].includes(value)) capabilities[key] = value
  }
  return {
    allowedRoots: Array.isArray(config.allowedRoots) ? config.allowedRoots.map(String) : [],
    capabilities,
    allowedTools: Array.isArray(config.allowedTools) ? config.allowedTools.map(String) : [],
    approvalTtlMs:
      Number.isFinite(config.approvalTtlMs) && config.approvalTtlMs > 0
        ? config.approvalTtlMs
        : DEFAULT_POLICY.approvalTtlMs,
  }
}

function scopedGrantKey(key, kind, id) {
  return `${key}@${kind}:${id}`
}

function collectPaths(args) {  const paths = []
  for (const key of ['path', 'file_path', 'cwd', 'dir', 'directory']) {
    if (typeof args?.[key] === 'string' && args[key] !== '') paths.push(args[key])
  }
  if (Array.isArray(args?.paths)) {
    for (const value of args.paths) if (typeof value === 'string' && value !== '') paths.push(value)
  }
  return paths
}
