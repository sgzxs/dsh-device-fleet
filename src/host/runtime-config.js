// Runtime configuration (ADR-0025): the profile patch stays the base layer,
// while `$DSH_HOME/device-fleet/config-overrides.json` holds UI edits. Applying
// a patch merges it, persists it and runs the registered live-apply handlers so
// no plugin/DSH restart is required.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const READONLY_FIELDS = ['dataDir']
const CAPABILITY_MODES = ['auto', 'ask', 'deny']

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch
  const result = isPlainObject(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (Array.isArray(value)) result[key] = value.map((item) => (isPlainObject(item) ? deepMerge({}, item) : item))
    else if (isPlainObject(value)) result[key] = deepMerge(result[key], value)
    else result[key] = value
  }
  return result
}

function readJson(file) {
  if (!file || !existsSync(file)) return null
  try {
    // Tolerate a UTF-8 BOM written by Windows editors/PowerShell; JSON.parse
    // rejects it and the whole runtime config would silently fall back to
    // defaults (this is what disabled the Fleet listener once).
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function requirePositiveInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw Object.assign(new Error(`${name} must be an integer between ${min} and ${max}`), { code: 'bad-request' })
  }
  return value
}

function stringList(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw Object.assign(new Error(`${name} must be an array of strings`), { code: 'bad-request' })
  }
  return value.map((item) => item.trim()).filter((item) => item !== '')
}

function optionalString(value, name) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw Object.assign(new Error(`${name} must be a string`), { code: 'bad-request' })
  return value.trim()
}

/** Relay client TLS settings (private keys stay on the relay host). */
function sanitizeRelayTls(value, name) {
  if (value === undefined || value === null) return null
  if (!isPlainObject(value)) throw Object.assign(new Error(`${name} must be an object`), { code: 'bad-request' })
  const tls = {}
  if (value.ca !== undefined) tls.ca = optionalString(value.ca, `${name}.ca`)
  if (value.cert !== undefined) tls.cert = optionalString(value.cert, `${name}.cert`)
  if (value.key !== undefined) tls.key = optionalString(value.key, `${name}.key`)
  if (value.servername !== undefined) tls.servername = optionalString(value.servername, `${name}.servername`)
  if (value.rejectUnauthorized !== undefined) tls.rejectUnauthorized = value.rejectUnauthorized === true
  const meaningful = (tls.ca && tls.ca !== '') || (tls.cert && tls.cert !== '') || (tls.key && tls.key !== '') ||
    (tls.servername && tls.servername !== '') || tls.rejectUnauthorized === false
  return meaningful ? tls : null
}

/**
 * Validate and clean a UI patch. Only known fields survive; unknown keys are
 * dropped instead of leaking arbitrary objects into the effective config.
 */
export function sanitizeConfigPatch(patch) {
  if (!isPlainObject(patch)) throw Object.assign(new Error('config patch must be an object'), { code: 'bad-request' })
  const clean = {}
  if (patch.deviceName !== undefined) {
    const name = optionalString(patch.deviceName, 'deviceName')
    if (name !== '') clean.deviceName = name.slice(0, 80)
  }
  if (patch.promptSection !== undefined) clean.promptSection = patch.promptSection === true
  if (patch.autoApproveAsk !== undefined) clean.autoApproveAsk = patch.autoApproveAsk === true
  if (patch.discovery !== undefined) clean.discovery = patch.discovery === true
  if (patch.dataDir !== undefined) {
    throw Object.assign(new Error('dataDir cannot be changed at runtime'), { code: 'readonly' })
  }
  if (patch.direct !== undefined) {
    if (!isPlainObject(patch.direct)) throw Object.assign(new Error('direct must be an object'), { code: 'bad-request' })
    clean.direct = {
      host: optionalString(patch.direct.host, 'direct.host') || '0.0.0.0',
      port: requirePositiveInteger(Number(patch.direct.port ?? 0), 'direct.port', { min: 0, max: 65535 }),
    }
  }
  if (patch.relay !== undefined) {
    if (patch.relay === null) clean.relay = null
    else if (isPlainObject(patch.relay)) {
      const tls = sanitizeRelayTls(patch.relay.tls, 'relay.tls')
      clean.relay = {
        host: optionalString(patch.relay.host, 'relay.host'),
        port: requirePositiveInteger(Number(patch.relay.port ?? 0), 'relay.port', { min: 0, max: 65535 }),
        dataPort: requirePositiveInteger(Number(patch.relay.dataPort ?? 0), 'relay.dataPort', { min: 0, max: 65535 }),
        reconnect: patch.relay.reconnect !== false,
        ...(tls ? { tls } : {}),
      }
      if (clean.relay.host === '' || clean.relay.port === 0) clean.relay = null
    } else {
      throw Object.assign(new Error('relay must be an object or null'), { code: 'bad-request' })
    }
  }
  if (patch.relays !== undefined) {
    if (!Array.isArray(patch.relays)) throw Object.assign(new Error('relays must be an array'), { code: 'bad-request' })
    clean.relays = patch.relays.map((entry) => {
      const tls = sanitizeRelayTls(entry?.tls, 'relays.tls')
      return {
        host: optionalString(entry?.host, 'relays.host'),
        port: requirePositiveInteger(Number(entry?.port ?? 0), 'relays.port', { min: 0, max: 65535 }),
        dataPort: requirePositiveInteger(Number(entry?.dataPort ?? 0), 'relays.dataPort', { min: 0, max: 65535 }),
        reconnect: entry?.reconnect !== false,
        ...(tls ? { tls } : {}),
      }
    }).filter((entry) => entry.host !== '' && entry.port !== 0 && entry.dataPort !== 0)
  }
  if (patch.execution !== undefined) {
    if (!isPlainObject(patch.execution)) throw Object.assign(new Error('execution must be an object'), { code: 'bad-request' })
    const execution = {}
    if (patch.execution.cwd !== undefined) execution.cwd = optionalString(patch.execution.cwd, 'execution.cwd')
    if (patch.execution.agentPreset !== undefined) execution.agentPreset = optionalString(patch.execution.agentPreset, 'execution.agentPreset')
    if (patch.execution.shellTool !== undefined) execution.shellTool = optionalString(patch.execution.shellTool, 'execution.shellTool')
    if (patch.execution.subagentProvider !== undefined) execution.subagentProvider = optionalString(patch.execution.subagentProvider, 'execution.subagentProvider')
    if (patch.execution.approvalTimeoutMs !== undefined) {
      execution.approvalTimeoutMs = requirePositiveInteger(Number(patch.execution.approvalTimeoutMs), 'execution.approvalTimeoutMs', { min: 1000 })
    }
    if (patch.execution.delegateTimeoutMs !== undefined) {
      execution.delegateTimeoutMs = requirePositiveInteger(Number(patch.execution.delegateTimeoutMs), 'execution.delegateTimeoutMs', { min: 1000 })
    }
    clean.execution = execution
  }
  if (patch.policy !== undefined) {
    if (!isPlainObject(patch.policy)) throw Object.assign(new Error('policy must be an object'), { code: 'bad-request' })
    const policy = {}
    if (patch.policy.allowedRoots !== undefined) policy.allowedRoots = stringList(patch.policy.allowedRoots, 'policy.allowedRoots')
    if (patch.policy.allowedTools !== undefined) policy.allowedTools = stringList(patch.policy.allowedTools, 'policy.allowedTools')
    if (patch.policy.approvalTtlMs !== undefined) {
      policy.approvalTtlMs = requirePositiveInteger(Number(patch.policy.approvalTtlMs), 'policy.approvalTtlMs', { min: 1000 })
    }
    if (patch.policy.capabilities !== undefined) {
      if (!isPlainObject(patch.policy.capabilities)) throw Object.assign(new Error('policy.capabilities must be an object'), { code: 'bad-request' })
      const capabilities = {}
      for (const [key, value] of Object.entries(patch.policy.capabilities)) {
        if (!CAPABILITY_MODES.includes(value)) {
          throw Object.assign(new Error(`policy.capabilities.${key} must be auto|ask|deny`), { code: 'bad-request' })
        }
        capabilities[key] = value
      }
      policy.capabilities = capabilities
    }
    clean.policy = policy
  }
  if (patch.replica !== undefined) {
    if (!isPlainObject(patch.replica)) throw Object.assign(new Error('replica must be an object'), { code: 'bad-request' })
    const replica = {}
    if (patch.replica.autoCompactMinEvents !== undefined) {
      replica.autoCompactMinEvents = requirePositiveInteger(Number(patch.replica.autoCompactMinEvents), 'replica.autoCompactMinEvents', { min: 10 })
    }
    clean.replica = replica
  }
  if (patch.approvals !== undefined) {
    if (!isPlainObject(patch.approvals)) throw Object.assign(new Error('approvals must be an object'), { code: 'bad-request' })
    const approvals = {}
    if (patch.approvals.ttlMs !== undefined) approvals.ttlMs = requirePositiveInteger(Number(patch.approvals.ttlMs), 'approvals.ttlMs', { min: 1000 })
    if (patch.approvals.maxPending !== undefined) approvals.maxPending = requirePositiveInteger(Number(patch.approvals.maxPending), 'approvals.maxPending', { min: 1 })
    if (patch.approvals.simulation !== undefined) approvals.simulation = patch.approvals.simulation === true
    clean.approvals = approvals
  }
  if (patch.rotation !== undefined) {
    if (!isPlainObject(patch.rotation)) throw Object.assign(new Error('rotation must be an object'), { code: 'bad-request' })
    const rotation = {}
    if (patch.rotation.checkpointQuorum !== undefined) {
      rotation.checkpointQuorum = requirePositiveInteger(Number(patch.rotation.checkpointQuorum), 'rotation.checkpointQuorum', { min: 1 })
    }
    clean.rotation = rotation
  }
  if (patch.notifications !== undefined) {
    if (!isPlainObject(patch.notifications)) throw Object.assign(new Error('notifications must be an object'), { code: 'bad-request' })
    const notifications = {}
    if (patch.notifications.webhook !== undefined) {
      const webhook = optionalString(patch.notifications.webhook, 'notifications.webhook')
      if (webhook && !/^https?:\/\//.test(webhook)) throw Object.assign(new Error('notifications.webhook must be an http(s) URL'), { code: 'bad-request' })
      notifications.webhook = webhook
    }
    if (patch.notifications.timeoutMs !== undefined) {
      notifications.timeoutMs = requirePositiveInteger(Number(patch.notifications.timeoutMs), 'notifications.timeoutMs', { min: 1000 })
    }
    clean.notifications = notifications
  }
  if (patch.room !== undefined) {    if (!isPlainObject(patch.room)) throw Object.assign(new Error('room must be an object'), { code: 'bad-request' })
    const room = {}
    if (patch.room.rotationSeqMode !== undefined) {
      const mode = String(patch.room.rotationSeqMode)
      if (!['audit', 'strict'].includes(mode)) {
        throw Object.assign(new Error('room.rotationSeqMode must be audit or strict'), { code: 'bad-request' })
      }
      room.rotationSeqMode = mode
    }
    clean.room = room
  }
  if (patch.invite !== undefined) {
    if (!isPlainObject(patch.invite)) throw Object.assign(new Error('invite must be an object'), { code: 'bad-request' })
    const invite = {}
    if (patch.invite.ttlMs !== undefined) {
      invite.ttlMs = requirePositiveInteger(Number(patch.invite.ttlMs), 'invite.ttlMs', { min: 60_000 })
    }
    clean.invite = invite
  }
  return clean
}

export class RuntimeConfig {
  /**
   * @param {object} options
   * @param {object} options.base profile (Cordis) config
   * @param {string} [options.overridesFile] JSON file edited from the UI
   */
  constructor({ base = {}, overridesFile = null } = {}) {
    this.base = base
    this.overridesFile = overridesFile
    this.overrides = readJson(overridesFile) ?? {}
    this.current = deepMerge(this.base, this.overrides)
    this.applyHandlers = []
    this.updating = Promise.resolve()
  }

  onChange(handler) {
    this.applyHandlers.push(handler)
  }

  persist() {
    if (!this.overridesFile) return
    try {
      mkdirSync(dirname(this.overridesFile), { recursive: true })
      const temporary = `${this.overridesFile}.tmp`
      writeFileSync(temporary, JSON.stringify(this.overrides, null, 2), 'utf8')
      renameSync(temporary, this.overridesFile)
    } catch {
      /* overrides are best effort; the in-memory config is still applied */
    }
  }

  /** Merge, persist and live-apply one patch. Returns the effective config. */
  update(patch) {
    const clean = sanitizeConfigPatch(patch)
    return this.updating.then(async () => {
      const previous = this.current
      const previousOverrides = this.overrides
      this.overrides = deepMerge(this.overrides, clean)
      this.current = deepMerge(this.base, this.overrides)
      this.persist()
      try {
        for (const handler of this.applyHandlers) await handler(this.current, previous)
      } catch (error) {
        // A failed live apply must not leave a persisted config that bricks the
        // network on the next reload.
        this.overrides = previousOverrides
        this.current = previous
        this.persist()
        throw error
      }
      return this.current
    })
  }

  snapshot() {
    return {
      config: this.current,
      overrides: this.overrides,
      readonly: READONLY_FIELDS,
    }
  }
}
