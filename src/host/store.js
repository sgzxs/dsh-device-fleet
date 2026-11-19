// Persistent device state for the fleet plugin: identity, fleet, roster, config.
// Everything lives under `$DSH_HOME/device-fleet/` (or DEVICE_FLEET_DATA_DIR).
import fs from 'node:fs'
import path from 'node:path'
import { createFleet, decodeInvite, encodeInvite, generateIdentity } from '../net/identity.js'
import { applyRevocation, createRotationCheckpoint, rotationRecordHash } from '../net/rotation.js'
import { signRoster, verifyRoster } from './roster-signing.js'

export function resolveDataDir({ dshHome, override } = {}) {
  if (override) return path.resolve(override)
  if (process.env.DEVICE_FLEET_DATA_DIR) return path.resolve(process.env.DEVICE_FLEET_DATA_DIR)
  const home = dshHome ?? process.env.DSH_HOME ?? process.cwd()
  return path.join(home, 'device-fleet')
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* Windows ACLs ignore POSIX modes */
  }
}

/**
 * Merge the bootstrap roster carried by a signed v2 invite into local state.
 * Existing pinned keys always win; only missing devices are added, and
 * revocations are applied only when their signature verifies against the
 * snapshot keys (the invite HMAC already authenticates the snapshot itself).
 */
function importInviteBootstrap(dir, fleetKey, currentRoster, decoded) {
  const byId = new Map((Array.isArray(currentRoster) ? currentRoster : []).map((entry) => [entry.deviceId, entry]))
  let imported = 0
  let changed = 0
  const upsert = (entry) => {
    if (!entry || typeof entry.deviceId !== 'string' || typeof entry.edPublic !== 'string' || typeof entry.xPublic !== 'string') return
    const existing = byId.get(entry.deviceId)
    if (existing) {
      if (!existing.revokedAt && existing.edPublic === entry.edPublic && Number(entry.rotationSeq ?? -1) > Number(existing.rotationSeq ?? -1)) {
        byId.set(entry.deviceId, { ...existing, rotationSeq: entry.rotationSeq, rotationHead: entry.rotationHead ?? existing.rotationHead ?? null })
        changed += 1
      }
      return
    }
    byId.set(entry.deviceId, {
      deviceId: entry.deviceId,
      name: entry.name ?? 'device',
      edPublic: entry.edPublic,
      xPublic: entry.xPublic,
      addedAt: Date.now(),
      ...(Number.isInteger(Number(entry.rotationSeq)) ? { rotationSeq: Number(entry.rotationSeq) } : {}),
      ...(typeof entry.rotationHead === 'string' ? { rotationHead: entry.rotationHead } : {}),
      ...(Number.isFinite(Number(entry.revokedAt))
        ? {
            revokedAt: Number(entry.revokedAt),
            revokedBy: entry.revokedBy ?? null,
            revocationReason: entry.revocationReason ?? '',
            revocationSource: 'invite',
            ...(Number.isInteger(Number(entry.revokedSeq)) ? { revokedSeq: Number(entry.revokedSeq) } : {}),
          }
        : {}),
    })
    imported += 1
    changed += 1
  }
  upsert(decoded.creator)
  for (const entry of Array.isArray(decoded.roster) ? decoded.roster : []) upsert(entry)

  let revoked = 0
  for (const record of Array.isArray(decoded.revocations) ? decoded.revocations : []) {
    if (!record || typeof record.deviceId !== 'string') continue
    const target = byId.get(record.deviceId)
    if (!target) continue
    const self = record.revokedBy === record.deviceId
    const revoker = self ? target : byId.get(record.revokedBy)
    if (!revoker) continue
    const updated = applyRevocation(target, record, { revokerEdPublic: revoker.edPublic, confirmed: true })
    if (!updated) continue
    byId.set(record.deviceId, { ...updated, revocationRecord: record })
    revoked += 1
    changed += 1
  }

  const roster = [...byId.values()]
  if (Array.isArray(decoded.rotations) && decoded.rotations.length > 0 && decoded.creator?.deviceId) {
    try {
      const chains = readJson(path.join(dir, 'peer-rotations.json'), {})
      const first = decoded.rotations[0]
      if (first?.oldEdPublic && first?.oldXPublic) {
        const next = chains && typeof chains === 'object' && !Array.isArray(chains) ? chains : {}
        next[decoded.creator.deviceId] = {
          genesisEdPublic: first.oldEdPublic,
          genesisXPublic: first.oldXPublic,
          records: decoded.rotations,
        }
        writeJsonAtomic(path.join(dir, 'peer-rotations.json'), next)
      }
    } catch {
      /* an invalid bootstrap chain is ignored; the handshake can still catch up */
    }
  }
  if (changed > 0 || revoked > 0) {
    writeJsonAtomic(path.join(dir, 'roster.json'), roster)
    try {
      const signature = signRoster(roster, fleetKey)
      if (signature) writeJsonAtomic(path.join(dir, 'roster.sig'), { signature, signedAt: Date.now() })
    } catch {
      /* signature is best effort */
    }
  }
  return { roster, imported, revoked }
}

/**
 * Load or create the persistent device state.
 * @returns {{dataDir: string, identity: object, fleet: object, roster: object[], config: object, enrollment: object|null, createdFleet: boolean}}
 */
export function loadState({ dshHome, dataDir, name = 'device' } = {}) {
  const dir = resolveDataDir({ dshHome, override: dataDir })
  fs.mkdirSync(dir, { recursive: true })

  let identity = readJson(path.join(dir, 'identity.json'), null)
  if (!identity) {
    identity = generateIdentity({ name })
    writeJsonAtomic(path.join(dir, 'identity.json'), identity)
  }

  let createdFleet = false
  let fleet = readJson(path.join(dir, 'fleet.json'), null)
  if (!fleet) {
    fleet = createFleet({ name: `${name} fleet` })
    writeJsonAtomic(path.join(dir, 'fleet.json'), fleet)
    createdFleet = true
  }

  const rosterFileSignature = readJson(path.join(dir, 'roster.sig'), null)
  let roster = readJson(path.join(dir, 'roster.json'), [])
  let rosterSignatureValid = null
  if (rosterFileSignature?.signature) {
    rosterSignatureValid = verifyRoster(roster, rosterFileSignature.signature, fleet.fleetKey)
    if (!rosterSignatureValid) roster = []
  }
  const config = readJson(path.join(dir, 'config.json'), {})
  const account = readJson(path.join(dir, 'account.json'), null)
  const peerHints = readJson(path.join(dir, 'peer-hints.json'), [])
  let enrollment = readJson(path.join(dir, 'enrollment.json'), null)
  let pendingEnrollment = readJson(path.join(dir, 'enrollment.pending.json'), null)

  // A pending invite written by `fleet_join` takes effect on the next load:
  // enrolling while the network node is already running would leave the two
  // sides on different fleets.
  if (pendingEnrollment?.code) {
    try {
      const decoded = decodeInvite(pendingEnrollment.code)
      fleet = decoded.fleet
      enrollment = {
        joinedAt: Date.now(),
        accountFingerprint: decoded.accountFingerprint ?? null,
        relay: decoded.relay ?? null,
        relays: decoded.relays ?? [],
        endpoints: decoded.endpoints ?? [],
        inviteId: decoded.jti ?? null,
        inviteExpiresAt: decoded.expiresAt ?? null,
      }
      writeJsonAtomic(path.join(dir, 'fleet.json'), fleet)
      writeJsonAtomic(path.join(dir, 'enrollment.json'), enrollment)
      // Pin the creator and the current members immediately: the invite is
      // HMAC-authenticated with the fleet key, so this closes the TOFU window
      // and lets revocations/deleted devices be known before the first contact.
      roster = importInviteBootstrap(dir, fleet.fleetKey, roster, decoded).roster
      fs.unlinkSync(path.join(dir, 'enrollment.pending.json'))
      pendingEnrollment = null
    } catch (error) {
      // An expired invite can never succeed; drop it instead of retrying forever.
      if (error?.code === 'invite-expired') {
        try {
          fs.unlinkSync(path.join(dir, 'enrollment.pending.json'))
        } catch {
          /* ignore */
        }
        pendingEnrollment = null
      }
      // Otherwise keep the pending file; the user can fix the invite and restart.
    }
  }

  return {
    dataDir: dir,
    identity,
    fleet,
    roster: Array.isArray(roster) ? roster : [],
    rosterSignatureValid,
    config,
    account,
    enrollment,
    pendingEnrollment,
    peerHints: Array.isArray(peerHints) ? peerHints : [],
    createdFleet,
  }
}

/** Persist one manually supplied peer address (from fleet_connect) for reconnects. */
export function savePeerHint(state, hint) {
  if (!hint || typeof hint.host !== 'string' || !Number.isInteger(hint.port) || hint.port <= 0) return
  const entry = {
    host: hint.host,
    port: hint.port,
    ...(typeof hint.deviceId === 'string' ? { deviceId: hint.deviceId } : {}),
  }
  const hints = Array.isArray(state.peerHints) ? state.peerHints : []
  const exists = hints.some((item) => item.host === entry.host && item.port === entry.port && item.deviceId === entry.deviceId)
  if (!exists) hints.push(entry)
  state.peerHints = hints
  writeJsonAtomic(path.join(state.dataDir, 'peer-hints.json'), hints)
}

/** Queue an invite for the next plugin load (the running node keeps its fleet). */
export function writePendingEnrollment(state, code) {
  decodeInvite(code) // validate before writing
  writeJsonAtomic(path.join(state.dataDir, 'enrollment.pending.json'), { code, queuedAt: Date.now() })
}

export function saveIdentity(state) {
  writeJsonAtomic(path.join(state.dataDir, 'identity.json'), state.identity)
}

export function saveFleet(state) {
  writeJsonAtomic(path.join(state.dataDir, 'fleet.json'), state.fleet)
}

export function removePeerHintsForDevice(state, deviceId) {
  const hints = Array.isArray(state.peerHints) ? state.peerHints : []
  const kept = hints.filter((hint) => hint.deviceId !== deviceId && hint.host !== deviceId)
  state.peerHints = kept
  writeJsonAtomic(path.join(state.dataDir, 'peer-hints.json'), kept)
  return hints.length - kept.length
}

export function saveAccountBinding(state, fingerprint, source = 'peer') {
  if (typeof fingerprint !== 'string' || fingerprint === '' || fingerprint === 'mismatch') return null
  const account = { fingerprint, boundAt: Date.now(), source }
  state.account = account
  writeJsonAtomic(path.join(state.dataDir, 'account.json'), account)
  return account
}

export function saveRoster(state, roster) {
  state.roster = roster
  writeJsonAtomic(path.join(state.dataDir, 'roster.json'), roster)
  try {
    const signature = signRoster(roster, state.fleet?.fleetKey)
    if (signature) writeJsonAtomic(path.join(state.dataDir, 'roster.sig'), { signature, signedAt: Date.now() })
  } catch {
    /* signature is best effort; the roster itself is already persisted */
  }
}

/**
 * Persisted peer rotation chains, used for fork detection and manual fork
 * resolution. Keyed by deviceId; each entry is
 * `{ genesisEdPublic, genesisXPublic, records }`.
 */
export function loadPeerRotations(state) {
  const value = readJson(path.join(state.dataDir, 'peer-rotations.json'), {})
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function savePeerRotations(state, rotations = {}) {
  writeJsonAtomic(path.join(state.dataDir, 'peer-rotations.json'), rotations && typeof rotations === 'object' ? rotations : {})
}

/**
 * This device's own rotation chain. The file is either the legacy bare array or
 * `{ v: 1, checkpoint, records }` after a compaction; old records are archived
 * beside it and the checkpoint records which verified prefix was moved out.
 */
export function loadRotationState(state) {
  const parsed = readJson(path.join(state.dataDir, 'identity-rotations.json'), null)
  if (Array.isArray(parsed)) return { records: parsed, checkpoint: null }
  if (parsed && Array.isArray(parsed.records)) {
    return { records: parsed.records, checkpoint: parsed.checkpoint ?? null }
  }
  return { records: [], checkpoint: null }
}

export function saveRotationState(state, { records = [], checkpoint = null } = {}) {
  writeJsonAtomic(path.join(state.dataDir, 'identity-rotations.json'), {
    v: 1,
    checkpoint: checkpoint ?? null,
    records: Array.isArray(records) ? records : [],
  })
}

/**
 * Prune the oldest rotation records after explicitly archiving them. Peers that
 * are pinned below the retained window can no longer be verified automatically
 * and must re-pair; the handshake reports `rotation-history-pruned`.
 */
export function compactRotationChain(state, { keep = 64 } = {}) {
  const { records, checkpoint } = loadRotationState(state)
  const keepCount = Math.max(8, Math.min(512, Number(keep) || 64))
  if (records.length <= keepCount) {
    return { compacted: false, records: records.length, keep: keepCount, checkpoint }
  }
  const archived = records.slice(0, records.length - keepCount)
  const kept = records.slice(records.length - keepCount)
  const lastArchived = archived[archived.length - 1]
  const nextCheckpoint = createRotationCheckpoint(state.identity, {
    seq: Number(lastArchived.seq),
    head: rotationRecordHash(lastArchived),
    headEdPublic: lastArchived.newEdPublic,
    headXPublic: lastArchived.newXPublic,
    archivedRecords: archived.length,
  })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archiveName = `identity-rotations.archive-${stamp}.json`
  writeJsonAtomic(path.join(state.dataDir, archiveName), { v: 1, checkpoint: nextCheckpoint, records: archived })
  saveRotationState(state, { records: kept, checkpoint: nextCheckpoint })
  return {
    compacted: true,
    archived: archived.length,
    kept: kept.length,
    records: kept.length,
    from: Number(kept[0].seq),
    checkpoint: nextCheckpoint,
    archive: archiveName,
  }
}

/**
 * Leak-recovery helper: replace this device's identity with a brand-new
 * deviceId after the old key leaked. The old identity and its rotation chain
 * are archived beside the state files; the Fleet membership (fleet.json) is
 * kept so the device can be re-admitted through normal pairing.
 */
export function resetDeviceIdentity(state, { name = 'device' } = {}) {
  const dir = state.dataDir
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archived = []
  const previous = state.identity
  try {
    const backup = path.join(dir, `identity.json.bak-reset-${stamp}`)
    fs.copyFileSync(path.join(dir, 'identity.json'), backup)
    archived.push(path.basename(backup))
  } catch {
    /* identity.json may be missing on a fresh install */
  }
  for (const file of ['identity-rotations.json', 'identity-rotation.json']) {
    try {
      const target = path.join(dir, `${file}.bak-reset-${stamp}`)
      fs.renameSync(path.join(dir, file), target)
      archived.push(path.basename(target))
    } catch {
      /* nothing to archive */
    }
  }
  const identity = generateIdentity({ name })
  state.identity = identity
  writeJsonAtomic(path.join(dir, 'identity.json'), identity)
  return {
    previousDeviceId: previous?.deviceId ?? null,
    deviceId: identity.deviceId,
    archived,
    resetAt: Date.now(),
  }
}

export function saveConfig(state, config) {
  state.config = config
  writeJsonAtomic(path.join(state.dataDir, 'config.json'), config)
}

/** Create an invite for this device's fleet. */
export function createInvite(state, {
  accountFingerprint = null,
  relay = null,
  relays = [],
  endpoints = [],
  roster = [],
  creator = null,
  revocations = [],
  rotations = [],
  ttlMs = 24 * 60 * 60 * 1000,
} = {}) {
  const code = encodeInvite({ fleet: state.fleet, accountFingerprint, relay, relays, endpoints, roster, creator, revocations, rotations, ttlMs })
  let decoded = null
  try {
    decoded = decodeInvite(code)
  } catch {
    /* the code we just created must decode; keep the invite usable if not */
  }
  if (decoded?.jti) recordIssuedInvite(state, decoded)
  return { code, jti: decoded?.jti ?? null, expiresAt: decoded?.expiresAt ?? null }
}

// ------------------------------------------------------- invite ledger (single use)

function issuedInvitesFile(state) {
  return path.join(state.dataDir, 'issued-invites.json')
}

export function loadIssuedInvites(state) {
  const value = readJson(issuedInvitesFile(state), {})
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function saveIssuedInvites(state, invites = {}) {
  writeJsonAtomic(issuedInvitesFile(state), invites && typeof invites === 'object' ? invites : {})
}

export function recordIssuedInvite(state, decoded) {
  if (!decoded?.jti) return null
  const invites = loadIssuedInvites(state)
  invites[decoded.jti] = {
    createdAt: decoded.createdAt ?? Date.now(),
    expiresAt: decoded.expiresAt ?? null,
    usedAt: null,
    usedByDeviceId: null,
  }
  // Keep the ledger bounded: drop entries older than 30 days.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  for (const [id, entry] of Object.entries(invites)) {
    if (Number(entry?.createdAt) < cutoff) delete invites[id]
  }
  writeJsonAtomic(issuedInvitesFile(state), invites)
  return invites[decoded.jti]
}
/**
 * Consume an invite once. Returns `{ ok: true }` for the first redemption and a
 * stable reason otherwise. Expired invites are rejected even if the joining
 * device ignored its own expiry check.
 */
export function redeemIssuedInvite(state, { jti, deviceId = null, now = Date.now() } = {}) {
  if (typeof jti !== 'string' || jti === '') return { ok: false, reason: 'unknown-invite' }
  const invites = loadIssuedInvites(state)
  const entry = invites[jti]
  if (!entry) return { ok: false, reason: 'unknown-invite' }
  if (entry.usedAt) return { ok: false, reason: 'invite-consumed', usedAt: entry.usedAt, usedByDeviceId: entry.usedByDeviceId }
  if (Number.isFinite(Number(entry.expiresAt)) && now > Number(entry.expiresAt)) {
    return { ok: false, reason: 'invite-expired' }
  }
  entry.usedAt = now
  entry.usedByDeviceId = typeof deviceId === 'string' ? deviceId : null
  writeJsonAtomic(issuedInvitesFile(state), invites)
  return { ok: true, usedAt: entry.usedAt }
}

// ------------------------------------------------------- known devices (re-admission)

export function loadKnownDevices(state) {
  const value = readJson(path.join(state.dataDir, 'known-devices.json'), {})
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function rememberKnownDevice(state, deviceId) {
  if (typeof deviceId !== 'string' || deviceId === '') return null
  const known = loadKnownDevices(state)
  if (known[deviceId]) return known[deviceId]
  known[deviceId] = { firstSeenAt: Date.now() }
  writeJsonAtomic(path.join(state.dataDir, 'known-devices.json'), known)
  return known[deviceId]
}

export function isKnownDevice(state, deviceId) {
  return Boolean(loadKnownDevices(state)[deviceId])
}

/** Join a fleet from an invite code (overwrites fleet/enrollment, keeps identity). */
export function enrollFromInvite(state, code) {
  const decoded = decodeInvite(code)
  state.fleet = decoded.fleet
  state.enrollment = {
    joinedAt: Date.now(),
    accountFingerprint: decoded.accountFingerprint ?? null,
    relay: decoded.relay ?? null,
    relays: decoded.relays ?? [],
    endpoints: decoded.endpoints ?? [],
    inviteId: decoded.jti ?? null,
    inviteExpiresAt: decoded.expiresAt ?? null,
  }
  saveFleet(state)
  writeJsonAtomic(path.join(state.dataDir, 'enrollment.json'), state.enrollment)
  state.roster = importInviteBootstrap(
    state.dataDir,
    decoded.fleet.fleetKey,
    Array.isArray(state.roster) ? state.roster : [],
    decoded,
  ).roster
  return state.enrollment
}

/** Check a locally observed account fingerprint against the invite's binding. */
export function accountMatches(state, fingerprint) {
  const expected = state.enrollment?.accountFingerprint ?? state.account?.fingerprint ?? null
  if (!expected) return true // unbound invite/creator: accept the first account and caller may bind
  return fingerprint !== null && fingerprint === expected
}
