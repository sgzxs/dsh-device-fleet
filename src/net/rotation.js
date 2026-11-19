// Device key rotation and device revocation, both preserving the logical
// deviceId. The old Ed25519 key signs a rotation record naming the replacement
// keys; records form a hash chain so an offline peer can verify every step from
// its pinned roster key. A revocation record is signed by the asserting device
// and is either absolute (self-revocation) or advisory until the local user
// confirms it (ADR-0027).
import { createHash, sign, verify } from 'node:crypto'
import { generateIdentity, importPrivateKey, importPublicKey } from './identity.js'
import { stableStringify } from './protocol.js'

/** Records carried inline in hello/ack; anything longer is paged in. */
export const ROTATION_INLINE_LIMIT = 16
/** Records per rotation-pull page. */
export const ROTATION_PAGE_LIMIT = 64
/** Hard cap for one handshake chain catch-up, to bound handshake memory/CPU. */
export const ROTATION_MAX_RECORDS = 1024
/** Hard cap for rotation-pull round trips in one handshake. */
export const ROTATION_MAX_PULL_ROUNDS = 16

export function rotateIdentityKeys(current) {
  const next = generateIdentity({ name: current?.name ?? 'device' })
  next.deviceId = current.deviceId
  next.createdAt = current.createdAt ?? next.createdAt
  return next
}

function canonicalCheckpoint(record) {
  return stableStringify({
    v: 1,
    type: 'device.rotation.checkpoint',
    deviceId: record.deviceId,
    seq: record.seq,
    head: record.head,
    edPublic: record.edPublic,
    headEdPublic: record.headEdPublic ?? null,
    headXPublic: record.headXPublic ?? null,
    archivedRecords: record.archivedRecords ?? 0,
    createdAt: record.createdAt,
  })
}

/**
 * Attestation for an archived prefix of a rotation chain. It is signed by the
 * device key current at compaction time; a peer can never use it to skip
 * verification, it only documents which verified prefix was moved to the
 * archive when old records are pruned from the active chain.
 */
/**
 * Re-sign a checkpoint with the current device key. A checkpoint is created at
 * compaction time; later rotations change the advertised key, so the copy sent
 * in hello/ack must carry a signature the peer can verify against the CURRENT
 * key (otherwise the peer rejects the offer and checkpoint trust never works).
 */
export function refreshRotationCheckpoint(identity, checkpoint) {
  if (!identity?.edPrivate || !identity?.edPublic || !identity?.deviceId) throw new Error('checkpoint refresh needs a local identity')
  if (!checkpoint || typeof checkpoint !== 'object') throw new Error('checkpoint refresh needs a checkpoint')
  if (!Number.isInteger(Number(checkpoint.seq)) || Number(checkpoint.seq) < 0) throw new Error('checkpoint seq is invalid')
  if (!isNonEmptyString(checkpoint.head)) throw new Error('checkpoint head is invalid')
  const record = {
    v: 1,
    type: 'device.rotation.checkpoint',
    deviceId: identity.deviceId,
    seq: Number(checkpoint.seq),
    head: checkpoint.head,
    edPublic: identity.edPublic,
    headEdPublic: isNonEmptyString(checkpoint.headEdPublic) ? checkpoint.headEdPublic : null,
    headXPublic: isNonEmptyString(checkpoint.headXPublic) ? checkpoint.headXPublic : null,
    archivedRecords: Number(checkpoint.archivedRecords) || 0,
    createdAt: Number(checkpoint.createdAt) || Date.now(),
  }
  record.signature = sign(null, Buffer.from(canonicalCheckpoint(record)), importPrivateKey(identity.edPrivate)).toString('base64url')
  return record
}

export function createRotationCheckpoint(identity, { seq, head, headEdPublic = null, headXPublic = null, archivedRecords = 0, createdAt = Date.now() } = {}) {
  if (!identity?.edPrivate || !identity?.edPublic || !identity?.deviceId) throw new Error('checkpoint needs a local identity')
  if (!Number.isInteger(Number(seq)) || Number(seq) < 0) throw new Error('checkpoint needs a non-negative seq')
  if (!isNonEmptyString(head)) throw new Error('checkpoint needs the archived head hash')
  const record = {
    v: 1,
    type: 'device.rotation.checkpoint',
    deviceId: identity.deviceId,
    seq: Number(seq),
    head,
    edPublic: identity.edPublic,
    headEdPublic: isNonEmptyString(headEdPublic) ? headEdPublic : null,
    headXPublic: isNonEmptyString(headXPublic) ? headXPublic : null,
    archivedRecords: Number(archivedRecords) || 0,
    createdAt,
  }
  record.signature = sign(null, Buffer.from(canonicalCheckpoint(record)), importPrivateKey(identity.edPrivate)).toString('base64url')
  return record
}

export function verifyRotationCheckpoint(record, expectedEdPublic = null) {
  if (!record || record.type !== 'device.rotation.checkpoint' || record.v !== 1) return false
  if (!isNonEmptyString(record.deviceId) || !isNonEmptyString(record.head) || !isNonEmptyString(record.edPublic)) return false
  if (!Number.isInteger(Number(record.seq)) || Number(record.seq) < 0) return false
  if (typeof expectedEdPublic === 'string' && expectedEdPublic !== '' && record.edPublic !== expectedEdPublic) return false
  try {
    return verify(
      null,
      Buffer.from(canonicalCheckpoint(record)),
      importPublicKey(record.edPublic),
      Buffer.from(record.signature, 'base64url'),
    )
  } catch {
    return false
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

function canonicalRotation(record) {
  return stableStringify({
    v: 1,
    type: 'device.rotation',
    deviceId: record.deviceId,
    seq: record.seq ?? 0,
    prevHash: record.prevHash ?? null,
    oldEdPublic: record.oldEdPublic,
    newEdPublic: record.newEdPublic,
    newXPublic: record.newXPublic,
    rotatedAt: record.rotatedAt,
  })
}

export function rotationRecordHash(record) {
  return createHash('sha256').update(canonicalRotation(record)).digest('base64url')
}

export function createRotationRecord(currentIdentity, nextIdentity, { previous = null } = {}) {
  if (!currentIdentity?.edPrivate || !nextIdentity?.edPublic || !nextIdentity?.xPublic) {
    throw new Error('rotation needs old private key and new public keys')
  }
  const record = {
    v: 1,
    type: 'device.rotation',
    deviceId: currentIdentity.deviceId,
    seq: previous ? Number(previous.seq ?? 0) + 1 : 0,
    prevHash: previous ? rotationRecordHash(previous) : null,
    oldEdPublic: currentIdentity.edPublic,
    newEdPublic: nextIdentity.edPublic,
    newXPublic: nextIdentity.xPublic,
    rotatedAt: Date.now(),
  }
  record.signature = sign(null, Buffer.from(canonicalRotation(record)), importPrivateKey(currentIdentity.edPrivate)).toString('base64url')
  return record
}

export function verifyRotationRecord(record, expectedOldEdPublic) {
  if (!record || record.type !== 'device.rotation' || record.v !== 1) return false
  if (!Number.isInteger(Number(record.seq)) || Number(record.seq) < 0) return false
  if (!isNonEmptyString(record.deviceId) || !isNonEmptyString(record.newEdPublic) || !isNonEmptyString(record.newXPublic)) return false
  if (typeof expectedOldEdPublic === 'string' && expectedOldEdPublic !== '' && record.oldEdPublic !== expectedOldEdPublic) return false
  try {
    return verify(
      null,
      Buffer.from(canonicalRotation(record)),
      importPublicKey(record.oldEdPublic),
      Buffer.from(record.signature, 'base64url'),
    )
  } catch {
    return false
  }
}

export function applyRotationRecord(rosterEntry, record) {
  if (!rosterEntry || rosterEntry.deviceId !== record.deviceId) return null
  if (!verifyRotationRecord(record, rosterEntry.edPublic)) return null
  return {
    ...rosterEntry,
    edPublic: record.newEdPublic,
    xPublic: record.newXPublic,
    rotatedAt: record.rotatedAt,
    rotationSeq: Number(record.seq ?? 0),
    rotationHead: rotationRecordHash(record),
  }
}

/**
 * Verify an ordered chain starting from a pinned roster entry.
 * Returns the updated entry, or null for a gap/replay/tamper.
 * Kept for the original single-shot RPC path; `applyRotationChain` adds fork
 * detection, paging needs and stored-history checks.
 */
export function verifyRotationChain(rosterEntry, records = []) {
  if (!rosterEntry || !Array.isArray(records)) return null
  let expectedKey = rosterEntry.edPublic
  let previousHash = rosterEntry.rotationHead ?? null
  let expectedSeq = rosterEntry.rotationSeq === undefined ? -1 : Number(rosterEntry.rotationSeq)
  let entry = { ...rosterEntry }
  for (const record of records) {
    if (!record || record.deviceId !== rosterEntry.deviceId) return null
    if (Number(record.seq) !== expectedSeq + 1) return null
    if ((record.prevHash ?? null) !== previousHash) return null
    if (!verifyRotationRecord(record, expectedKey)) return null
    expectedKey = record.newEdPublic
    previousHash = rotationRecordHash(record)
    expectedSeq += 1
    entry = {
      ...entry,
      edPublic: record.newEdPublic,
      xPublic: record.newXPublic,
      rotatedAt: record.rotatedAt,
      rotationSeq: expectedSeq,
      rotationHead: previousHash,
    }
  }
  return entry
}

function rotationSeqOf(entry) {
  const value = entry?.rotationSeq
  return value === undefined || value === null ? -1 : Number(value)
}

/**
 * Chain state kept per peer:
 * `{ genesisEdPublic, genesisXPublic, records: [...] }`.
 * `records[0]` is seq 0 and its `oldEdPublic` is the genesis key.
 */
function normalizeChain(rosterEntry, stored = null) {
  const seq = rotationSeqOf(rosterEntry)
  const head = rosterEntry.rotationHead ?? null
  const storedRecords = Array.isArray(stored?.records)
    ? stored.records.filter((record) => record && Number.isInteger(Number(record.seq))).slice().sort((left, right) => Number(left.seq) - Number(right.seq))
    : []
  const genesisEdPublic = isNonEmptyString(stored?.genesisEdPublic) ? stored.genesisEdPublic : null
  const genesisXPublic = isNonEmptyString(stored?.genesisXPublic) ? stored.genesisXPublic : null
  if (storedRecords.length > 0 && genesisEdPublic) {
    let key = genesisEdPublic
    let previousHash = null
    let expectedSeq = 0
    let consistent = true
    for (const record of storedRecords) {
      if (Number(record.seq) !== expectedSeq || (record.prevHash ?? null) !== previousHash || record.deviceId !== rosterEntry.deviceId) {
        consistent = false
        break
      }
      if (!verifyRotationRecord(record, key)) {
        consistent = false
        break
      }
      key = record.newEdPublic
      previousHash = rotationRecordHash(record)
      expectedSeq += 1
    }
    if (consistent && expectedSeq - 1 === seq && previousHash === head && key === rosterEntry.edPublic) {
      return { genesisEdPublic, genesisXPublic, records: storedRecords, seq, head, key, verified: true }
    }
    return {
      genesisEdPublic: rosterEntry.edPublic,
      genesisXPublic: rosterEntry.xPublic,
      records: [],
      seq,
      head,
      key: rosterEntry.edPublic,
      verified: false,
      warning: 'stored rotation chain does not match the roster entry; fork detection is limited to the current head',
    }
  }
  // No stored history (legacy state or a quiet device): anchor the chain at the
  // currently pinned key so verification can continue forward.
  return {
    genesisEdPublic: rosterEntry.edPublic,
    genesisXPublic: rosterEntry.xPublic,
    records: [],
    seq,
    head,
    key: rosterEntry.edPublic,
    verified: storedRecords.length === 0,
    warning: storedRecords.length > 0 ? 'stored rotation chain has no genesis key; fork detection is limited to the current head' : null,
  }
}

function forkResult(seq, localHash, remoteHash, chain, reason = 'rotation chain fork') {
  return {
    status: 'fork',
    reason,
    fork: {
      seq: Number(seq),
      localSeq: chain.seq,
      localHead: chain.head ?? null,
      localHash: localHash ?? null,
      remoteHead: remoteHash ?? null,
      remoteHash: remoteHash ?? null,
    },
  }
}

/**
 * Append incoming rotation records to a peer's known chain.
 *
 * Returns one of:
 *   { status: 'applied', entry, chain }
 *   { status: 'noop', entry, chain }
 *   { status: 'gap', need: { fromSeq }, chain }        caller must fetch more
 *   { status: 'fork', fork }                           manual resolution needed
 *   { status: 'invalid', reason }
 *   { status: 'revoked' }                              roster entry is revoked
 */
export function applyRotationChain({ rosterEntry, storedChain = null, records = [] } = {}) {
  if (!rosterEntry || !Array.isArray(records)) return { status: 'invalid', reason: 'bad rotation input' }
  if (rosterEntry.revokedAt) return { status: 'revoked' }
  const chain = normalizeChain(rosterEntry, storedChain)
  const incoming = records
    .filter((record) => record && Number.isInteger(Number(record.seq)))
    .slice()
    .sort((left, right) => Number(left.seq) - Number(right.seq))

  // Same (deviceId, seq) with a different hash is a fork. Check every known
  // position first so a peer replaying an older branch cannot slip past.
  const localHashes = new Map()
  for (const record of chain.records) localHashes.set(Number(record.seq), rotationRecordHash(record))
  if (chain.seq >= 0 && chain.head) localHashes.set(chain.seq, chain.head)
  for (const record of incoming) {
    const seq = Number(record.seq)
    if (seq > chain.seq) continue
    const localHash = localHashes.get(seq)
    if (!localHash) continue
    const remoteHash = rotationRecordHash(record)
    if (remoteHash !== localHash) return forkResult(seq, localHash, remoteHash, chain)
  }

  const pending = incoming.filter((record) => Number(record.seq) > chain.seq)
  if (pending.length === 0) return { status: 'noop', entry: rosterEntry, chain }
  if (pending.length > ROTATION_MAX_RECORDS) return { status: 'invalid', reason: 'rotation chain export is too large' }
  const expectedStart = chain.seq + 1
  if (Number(pending[0].seq) > expectedStart) return { status: 'gap', need: { fromSeq: expectedStart }, chain }
  if ((pending[0].prevHash ?? null) !== (chain.head ?? null)) {
    // The first new record claims to follow a head we do not have: the peer's
    // branch diverged at (or before) the seq we already accepted.
    return forkResult(chain.seq, chain.head ?? null, pending[0].prevHash ?? null, chain)
  }

  let expectedSeq = expectedStart
  let previousHash = chain.head ?? null
  let key = chain.key
  for (const record of pending) {
    if (Number(record.seq) !== expectedSeq) return { status: 'gap', need: { fromSeq: expectedSeq }, chain }
    if ((record.prevHash ?? null) !== previousHash) {
      return forkResult(expectedSeq - 1, previousHash, record.prevHash ?? null, chain)
    }
    if (record.deviceId !== rosterEntry.deviceId) return { status: 'invalid', reason: 'rotation record belongs to another device' }
    if (!verifyRotationRecord(record, key)) return { status: 'invalid', reason: `rotation record ${expectedSeq} is not signed by the previous key` }
    key = record.newEdPublic
    previousHash = rotationRecordHash(record)
    expectedSeq += 1
  }
  const last = pending[pending.length - 1]
  const nextChain = {
    genesisEdPublic: chain.genesisEdPublic,
    genesisXPublic: chain.genesisXPublic,
    records: [...chain.records, ...pending],
  }
  const entry = {
    ...rosterEntry,
    edPublic: key,
    xPublic: last.newXPublic,
    rotatedAt: last.rotatedAt,
    rotationSeq: Number(last.seq),
    rotationHead: previousHash,
  }
  delete entry.rotationFork
  const result = { status: 'applied', entry, chain: nextChain }
  if (chain.warning) result.warning = chain.warning
  return result
}

/**
 * Resolve a detected fork either by keeping the local branch or by adopting the
 * peer branch supplied in `records` (usually the records that triggered the
 * fork). Adoption is only accepted when the peer branch connects to a locally
 * verified chain prefix; the caller must have explicit user confirmation.
 */
export function resolveRotationFork({ rosterEntry, storedChain = null, records = [], action = 'keep-local' } = {}) {
  if (!rosterEntry) return { status: 'invalid', reason: 'unknown roster entry' }
  if (action === 'keep-local') {
    if (!rosterEntry.rotationFork) return { status: 'noop', entry: rosterEntry }
    const entry = { ...rosterEntry }
    delete entry.rotationFork
    return { status: 'kept', entry }
  }
  if (action !== 'adopt-peer') return { status: 'invalid', reason: 'action must be keep-local or adopt-peer' }
  const chain = normalizeChain(rosterEntry, storedChain)
  const incoming = (Array.isArray(records) ? records : [])
    .filter((record) => record && Number.isInteger(Number(record.seq)))
    .slice()
    .sort((left, right) => Number(left.seq) - Number(right.seq))
  if (incoming.length === 0) return { status: 'fork-not-resolvable', reason: 'no peer branch records were captured for this fork' }
  if (incoming.length > ROTATION_MAX_RECORDS) return { status: 'invalid', reason: 'peer branch is too large' }

  const candidates = chain.records.map((record, index) => ({
    seq: Number(record.seq),
    key: record.newEdPublic,
    hash: rotationRecordHash(record),
    index,
  }))
  // The pinned genesis key is a valid branch point: a peer may present a branch
  // that starts again at seq 0.
  candidates.push({ seq: -1, key: chain.genesisEdPublic, hash: null, index: -1, genesis: true })
  // The current head is a valid branch point even when no history was stored
  // (legacy entry): the peer may simply be one record ahead on a sibling branch.
  candidates.push({ seq: chain.seq, key: chain.key, hash: chain.head ?? null, index: chain.records.length - 1, virtual: true })
  candidates.sort((left, right) => right.seq - left.seq)

  let chosen = null
  for (const candidate of candidates) {
    const at = incoming.findIndex((record) => Number(record.seq) === candidate.seq + 1 && (record.prevHash ?? null) === candidate.hash)
    if (at >= 0) {
      chosen = { candidate, at }
      break
    }
  }
  if (!chosen) return { status: 'fork-not-resolvable', reason: 'the peer branch does not connect to any verified local chain prefix' }

  const branch = incoming.slice(chosen.at)
  let key = chosen.candidate.key
  let previousHash = chosen.candidate.hash
  let expectedSeq = chosen.candidate.seq + 1
  for (const record of branch) {
    if (Number(record.seq) !== expectedSeq) return { status: 'invalid', reason: 'peer branch has a gap' }
    if ((record.prevHash ?? null) !== previousHash) return { status: 'invalid', reason: 'peer branch is not contiguous' }
    if (record.deviceId !== rosterEntry.deviceId) return { status: 'invalid', reason: 'peer branch belongs to another device' }
    if (!verifyRotationRecord(record, key)) return { status: 'invalid', reason: `peer branch record ${expectedSeq} has an invalid signature` }
    key = record.newEdPublic
    previousHash = rotationRecordHash(record)
    expectedSeq += 1
  }
  const last = branch[branch.length - 1]
  const kept = chain.records.slice(0, chosen.candidate.index + 1)
  const nextChain = {
    genesisEdPublic: chain.genesisEdPublic,
    genesisXPublic: chain.genesisXPublic,
    records: [...kept, ...branch],
  }
  const entry = {
    ...rosterEntry,
    edPublic: key,
    xPublic: last.newXPublic,
    rotatedAt: last.rotatedAt,
    rotationSeq: Number(last.seq),
    rotationHead: previousHash,
  }
  delete entry.rotationFork
  return { status: 'adopted', entry, chain: nextChain }
}

/** Slice a persisted chain for the wire: records at or after `fromSeq`. */
export function rotationChainPage(records = [], { fromSeq = 0, limit = ROTATION_PAGE_LIMIT } = {}) {
  const list = (Array.isArray(records) ? records : [])
    .filter((record) => record && Number.isInteger(Number(record.seq)))
    .slice()
    .sort((left, right) => Number(left.seq) - Number(right.seq))
  const start = Number.isInteger(Number(fromSeq)) && Number(fromSeq) > 0 ? Number(fromSeq) : 0
  const size = Math.min(ROTATION_PAGE_LIMIT, Math.max(1, Number(limit) || ROTATION_PAGE_LIMIT))
  const page = list.filter((record) => Number(record.seq) >= start).slice(0, size)
  const lastSeq = page.length > 0 ? Number(page[page.length - 1].seq) : start - 1
  const complete = !list.some((record) => Number(record.seq) > lastSeq)
  return { records: page, fromSeq: start, complete }
}

// ------------------------------------------------------------------ revocation

function canonicalRevocation(record) {
  return stableStringify({
    v: 1,
    type: 'device.revoke',
    deviceId: record.deviceId,
    revokedSeq: record.revokedSeq ?? null,
    revokedHead: record.revokedHead ?? null,
    revokedAt: record.revokedAt,
    reason: record.reason ?? '',
    revokedBy: record.revokedBy,
    revokerEdPublic: record.revokerEdPublic,
  })
}

/**
 * A revocation record is signed by the asserting device's current key.
 * Self-revocation (`revokedBy === deviceId`) is absolute; a third-party
 * revocation stays advisory until the local user confirms it.
 */
export function createRevocationRecord(identity, { deviceId, revokedSeq = null, revokedHead = null, reason = '', revokedAt = Date.now() } = {}) {
  if (!identity?.edPrivate || !identity?.edPublic || !identity?.deviceId) throw new Error('revocation needs a local identity')
  if (!isNonEmptyString(deviceId)) throw new Error('revocation needs a target deviceId')
  const record = {
    v: 1,
    type: 'device.revoke',
    deviceId,
    revokedSeq: Number.isInteger(Number(revokedSeq)) ? Number(revokedSeq) : null,
    revokedHead: isNonEmptyString(revokedHead) ? revokedHead : null,
    revokedAt,
    reason: String(reason ?? ''),
    revokedBy: identity.deviceId,
    revokerEdPublic: identity.edPublic,
  }
  record.signature = sign(null, Buffer.from(canonicalRevocation(record)), importPrivateKey(identity.edPrivate)).toString('base64url')
  return record
}

export function verifyRevocationRecord(record) {
  if (!record || record.type !== 'device.revoke' || record.v !== 1) return false
  if (!isNonEmptyString(record.deviceId) || !isNonEmptyString(record.revokedBy) || !isNonEmptyString(record.revokerEdPublic)) return false
  if (!Number.isFinite(Number(record.revokedAt))) return false
  try {
    return verify(
      null,
      Buffer.from(canonicalRevocation(record)),
      importPublicKey(record.revokerEdPublic),
      Buffer.from(record.signature, 'base64url'),
    )
  } catch {
    return false
  }
}

/**
 * Apply a verified revocation to a roster entry.
 * `revokerEdPublic` must be the key the roster currently pins for the asserting
 * device; for self-revocation the asserting key must be the entry's own key.
 * Returns the updated entry, or null when the record does not apply.
 */
export function applyRevocation(rosterEntry, record, { revokerEdPublic = null, confirmed = false } = {}) {
  if (!rosterEntry || !record || rosterEntry.deviceId !== record.deviceId) return null
  if (!verifyRevocationRecord(record)) return null
  const self = record.revokedBy === record.deviceId
  if (self) {
    if (record.revokerEdPublic !== rosterEntry.edPublic) return null
    const revoked = {
      ...rosterEntry,
      revokedAt: Number(record.revokedAt),
      revokedBy: record.revokedBy,
      revokedSeq: Number.isInteger(Number(record.revokedSeq)) ? Number(record.revokedSeq) : (rotationSeqOf(rosterEntry) >= 0 ? rotationSeqOf(rosterEntry) : null),
      revocationReason: record.reason ?? '',
      revocationSource: 'self',
    }
    delete revoked.revocationPending
    return revoked
  }
  if (typeof revokerEdPublic === 'string' && revokerEdPublic !== '' && record.revokerEdPublic !== revokerEdPublic) return null
  const summary = {
    by: record.revokedBy,
    at: Number(record.revokedAt),
    seq: Number.isInteger(Number(record.revokedSeq)) ? Number(record.revokedSeq) : null,
    reason: record.reason ?? '',
    signature: record.signature,
  }
  if (confirmed) {
    const revoked = {
      ...rosterEntry,
      revokedAt: Number(record.revokedAt),
      revokedBy: record.revokedBy,
      revokedSeq: summary.seq,
      revocationReason: summary.reason,
      revocationSource: 'confirmed',
    }
    delete revoked.revocationPending
    return revoked
  }
  return { ...rosterEntry, revocationPending: summary }
}
