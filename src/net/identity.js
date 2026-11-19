// Device identity, fleet invites and membership proofs.
//
// Every device owns an Ed25519 keypair (authentication) and an X25519 keypair
// (key agreement). A Fleet is identified by `fleetId` and a shared 32-byte
// `fleetKey` carried by invites; the key proves membership and bootstraps trust
// on first contact (TOFU), after which peer public keys are pinned in the roster.
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { stableStringify } from './protocol.js'

const INVITE_PREFIX = 'DSHF1.'
const INVITE_VERSION = 3
const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_INVITE_ROTATION_RECORDS = 1024
const INVITE_CHUNK_CHARS = 1800
const PROOF_PREFIX = 'member'
const RELAY_PREFIX = 'relay-register'
const ACCOUNT_PREFIX = 'account'

export function exportKey(key) {
  return key.export({ type: key.type === 'private' ? 'pkcs8' : 'spki', format: 'pem' }).toString()
}

export function importPrivateKey(pem) {
  return createPrivateKey(pem)
}

export function importPublicKey(pem) {
  return createPublicKey(pem)
}

function randomBase64Url(bytes) {
  return randomBytes(bytes).toString('base64url')
}

/** A fresh device identity. Caller persists it (e.g. `$DSH_HOME/device-fleet/identity.json`). */
export function generateIdentity({ name = 'device' } = {}) {
  const ed = generateKeyPairSync('ed25519')
  const x = generateKeyPairSync('x25519')
  return {
    deviceId: randomUUID(),
    name,
    createdAt: Date.now(),
    edPrivate: exportKey(ed.privateKey),
    edPublic: exportKey(ed.publicKey),
    xPrivate: exportKey(x.privateKey),
    xPublic: exportKey(x.publicKey),
  }
}

/** Public half of an identity, safe to put in a roster/invite. */
export function publicIdentity(identity) {
  return {
    deviceId: identity.deviceId,
    name: identity.name,
    edPublic: identity.edPublic,
    xPublic: identity.xPublic,
  }
}

/** A new fleet. `fleetKey` is the fleet-wide membership secret carried by invites. */
export function createFleet({ name = 'fleet' } = {}) {
  return {
    fleetId: randomUUID(),
    fleetKey: randomBase64Url(32),
    name,
    createdAt: Date.now(),
  }
}

function sanitizeInviteRotations(value) {
  if (!Array.isArray(value)) return []
  const records = []
  for (const record of value) {
    if (!record || typeof record !== 'object') continue
    if (!Number.isInteger(Number(record.seq)) || typeof record.newEdPublic !== 'string' || typeof record.newXPublic !== 'string') continue
    records.push({
      v: 1,
      type: 'device.rotation',
      deviceId: record.deviceId,
      seq: Number(record.seq),
      prevHash: record.prevHash ?? null,
      oldEdPublic: record.oldEdPublic,
      oldXPublic: record.oldXPublic,
      newEdPublic: record.newEdPublic,
      newXPublic: record.newXPublic,
      rotatedAt: record.rotatedAt,
      signature: record.signature,
    })
    if (records.length >= MAX_INVITE_ROTATION_RECORDS) break
  }
  return records
}

function normalizeRelayTls(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const tls = {}
  if (typeof value.ca === 'string' && value.ca.trim() !== '') tls.ca = value.ca
  if (typeof value.servername === 'string' && value.servername.trim() !== '') tls.servername = value.servername.trim()
  if (value.rejectUnauthorized === false) tls.rejectUnauthorized = false
  return Object.keys(tls).length > 0 ? tls : null
}
function normalizeRelayList(relays) {
  if (!Array.isArray(relays)) return []
  return relays.filter(
    (entry) =>
      entry &&
      typeof entry.host === 'string' &&
      entry.host !== '' &&
      Number.isInteger(entry.port) &&
      entry.port > 0 &&
      Number.isInteger(entry.dataPort) &&
      entry.dataPort > 0,
  ).map((entry) => ({
    host: entry.host,
    port: entry.port,
    dataPort: entry.dataPort,
    ...(normalizeRelayTls(entry.tls) ? { tls: normalizeRelayTls(entry.tls) } : {}),
  }))
}

function sanitizeInviteRelay(relay) {
  if (!relay || typeof relay !== 'object') return null
  if (typeof relay.host !== 'string' || relay.host === '') return null
  if (!Number.isInteger(Number(relay.port)) || Number(relay.port) <= 0) return null
  if (!Number.isInteger(Number(relay.dataPort)) || Number(relay.dataPort) <= 0) return null
  const tls = normalizeRelayTls(relay.tls)
  return {
    host: relay.host,
    port: Number(relay.port),
    dataPort: Number(relay.dataPort),
    ...(tls ? { tls } : {}),
  }
}

function sanitizeInviteIdentity(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (typeof entry.deviceId !== 'string' || entry.deviceId === '') return null
  if (typeof entry.edPublic !== 'string' || entry.edPublic === '') return null
  if (typeof entry.xPublic !== 'string' || entry.xPublic === '') return null
  const sanitized = {
    deviceId: entry.deviceId,
    name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : 'device',
    edPublic: entry.edPublic,
    xPublic: entry.xPublic,
  }
  if (Number.isInteger(Number(entry.rotationSeq))) sanitized.rotationSeq = Number(entry.rotationSeq)
  if (typeof entry.rotationHead === 'string' && entry.rotationHead !== '') sanitized.rotationHead = entry.rotationHead
  return sanitized
}

function sanitizeInviteRoster(roster) {
  if (!Array.isArray(roster)) return []
  const out = []
  for (const source of roster.slice(0, 64)) {
    const entry = sanitizeInviteIdentity(source)
    if (!entry) continue
    if (Number.isFinite(Number(source.revokedAt))) {
      entry.revokedAt = Number(source.revokedAt)
      entry.revokedBy = typeof source.revokedBy === 'string' ? source.revokedBy : null
      if (Number.isInteger(Number(source.revokedSeq))) entry.revokedSeq = Number(source.revokedSeq)
      if (typeof source.revocationReason === 'string') entry.revocationReason = source.revocationReason
    }
    out.push(entry)
  }
  return out
}

function sanitizeInviteRevocations(records) {
  if (!Array.isArray(records)) return []
  return records
    .filter((record) => record && record.type === 'device.revoke' && typeof record.signature === 'string')
    .slice(0, 64)
    .map((record) => ({
      v: record.v,
      type: 'device.revoke',
      deviceId: record.deviceId,
      revokedSeq: record.revokedSeq ?? null,
      revokedHead: record.revokedHead ?? null,
      revokedAt: record.revokedAt,
      reason: typeof record.reason === 'string' ? record.reason : '',
      revokedBy: record.revokedBy,
      revokerEdPublic: record.revokerEdPublic,
      signature: record.signature,
    }))
}

function canonicalInvite(payload) {
  return stableStringify(payload)
}

function inviteSignature(fleetKey, payload, version = payload.v) {
  return createHmac('sha256', fleetKey).update(`invite-v${version}|${canonicalInvite(payload)}`).digest('base64url')
}

/**
 * A Fleet invite is a bearer credential: it carries the fleet key, so it
 * already proves Fleet membership. v2 adds an HMAC over the whole payload so a
 * party without the fleet key cannot rewrite the bootstrap roster, revocations
 * or endpoints in transit, and lets a joiner pin the creator and current
 * members before the first handshake instead of trusting whoever answers first.
 */
export function encodeInvite({
  fleet,
  accountFingerprint = null,
  relay = null,
  relays = [],
  endpoints = [],
  creator = null,
  roster = [],
  revocations = [],
  rotations = [],
  ttlMs = DEFAULT_INVITE_TTL_MS,
  jti = randomUUID(),
  now = Date.now(),
}) {
  const ttl = Number(ttlMs)
  const expiresAt = Number.isFinite(ttl) && ttl > 0 ? now + ttl : null
  const payload = {
    v: INVITE_VERSION,
    fleetId: fleet.fleetId,
    fleetKey: fleet.fleetKey,
    name: fleet.name,
    accountFingerprint,
    relay: sanitizeInviteRelay(relay),
    relays: normalizeRelayList(relays),
    endpoints: Array.isArray(endpoints) ? endpoints : [],
    creator: sanitizeInviteIdentity(creator),
    roster: sanitizeInviteRoster(roster),
    revocations: sanitizeInviteRevocations(revocations),
    rotations: sanitizeInviteRotations(rotations),
    jti,
    expiresAt,
    singleUse: true,
    createdAt: now,
  }
  payload.sig = inviteSignature(fleet.fleetKey, payload)
  return `${INVITE_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
}

export function decodeInvite(code, { now = Date.now() } = {}) {
  if (typeof code !== 'string' || !code.startsWith(INVITE_PREFIX)) throw new Error('invalid invite')
  const raw = code.slice(INVITE_PREFIX.length)
  let payload
  try {
    payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new Error('invalid invite payload')
  }
  if (![1, 2, INVITE_VERSION].includes(payload?.v)) throw new Error('unsupported invite')
  if (typeof payload.fleetId !== 'string' || typeof payload.fleetKey !== 'string') throw new Error('unsupported invite')
  let roster = []
  let revocations = []
  let rotations = []
  let creator = null
  if (payload.v >= 2) {
    const { sig, ...signed } = payload
    if (typeof sig !== 'string' || sig === '') throw Object.assign(new Error('invite signature is missing'), { code: 'invite-signature' })
    const expected = inviteSignature(payload.fleetKey, signed, payload.v)
    const actual = Buffer.from(sig)
    const wanted = Buffer.from(expected)
    if (actual.length !== wanted.length || !actual.equals(wanted)) {
      throw Object.assign(new Error('invite signature is invalid'), { code: 'invite-signature' })
    }
    creator = sanitizeInviteIdentity(payload.creator)
    roster = sanitizeInviteRoster(payload.roster)
    revocations = sanitizeInviteRevocations(payload.revocations)
    rotations = sanitizeInviteRotations(payload.rotations)
  }
  const expiresAt = Number.isFinite(Number(payload.expiresAt)) ? Number(payload.expiresAt) : null
  if (expiresAt !== null && now > expiresAt) {
    throw Object.assign(new Error('invite has expired'), { code: 'invite-expired' })
  }
  return {
    fleet: { fleetId: payload.fleetId, fleetKey: payload.fleetKey, name: payload.name ?? 'fleet' },
    accountFingerprint: payload.accountFingerprint ?? null,
    relay: sanitizeInviteRelay(payload.relay),
    relays: normalizeRelayList(payload.relays),
    endpoints: Array.isArray(payload.endpoints)
      ? payload.endpoints.filter(
          (entry) =>
            entry &&
            typeof entry.host === 'string' &&
            Number.isInteger(entry.port) &&
            entry.port > 0 &&
            (entry.deviceId === undefined || typeof entry.deviceId === 'string'),
        )
      : [],
    creator,
    roster,
    revocations,
    rotations,
    jti: typeof payload.jti === 'string' && payload.jti !== '' ? payload.jti : null,
    expiresAt,
    singleUse: payload.singleUse === true,
    createdAt: payload.createdAt ?? null,
  }
}

/**
 * Split a long invite into copy/paste-sized parts. Joining is lossless; callers
 * should keep the parts together (they are still one bearer credential).
 */
export function splitInviteCode(code, maxChars = INVITE_CHUNK_CHARS) {
  if (typeof code !== 'string' || code === '') throw new Error('invite code is required')
  const size = Math.max(200, Number(maxChars) || INVITE_CHUNK_CHARS)
  if (code.length <= size) return [code]
  const parts = []
  for (let index = 0; index < code.length; index += size) parts.push(code.slice(index, index + size))
  return parts
}

export function joinInviteCode(parts) {
  if (!Array.isArray(parts)) throw new Error('invite parts must be an array')
  const joined = parts.map((part) => String(part ?? '').trim()).join('')
  if (!joined.startsWith(INVITE_PREFIX)) throw new Error('joined invite is invalid')
  return joined
}

/** Account fingerprint: proves "same account" inside the fleet without exposing the account id. */
export function accountFingerprint(fleetKey, accountUserId) {
  if (!accountUserId) return null
  return createHmac('sha256', fleetKey).update(`${ACCOUNT_PREFIX}|${accountUserId}`).digest('base64url')
}

/** HMAC proof that this device belongs to the fleet (checked by peers during the handshake). */
export function membershipProof({ fleetKey, fleetId, deviceId, edPublic, xPublic, accountFingerprint = null }) {
  return createHmac('sha256', fleetKey)
    .update(`${PROOF_PREFIX}|${fleetId}|${deviceId}|${edPublic}|${xPublic}|${accountFingerprint ?? ''}`)
    .digest('base64url')
}

export function verifyMembershipProof(proof, fields) {
  const expected = membershipProof(fields)
  const a = Buffer.from(String(proof))
  const b = Buffer.from(expected)
  return a.length === b.length && a.equals(b)
}

/** `fleetId` hash advertised in LAN announcements (the full id stays off the wire). */
export function fleetHash(fleetId) {
  return createHash('sha256').update(`fleet|${fleetId}`).digest('hex').slice(0, 16)
}

export function shortFingerprint(edPublic, xPublic) {
  return createHash('sha256')
    .update(`${edPublic}|${xPublic}`)
    .digest('hex')
    .slice(0, 16)
}

/** Token proving fleet membership to a self-hosted relay. */
export function relayAuthToken({ fleetKey, fleetId, deviceId, ts }) {
  return createHmac('sha256', fleetKey)
    .update(`${RELAY_PREFIX}|${fleetId}|${deviceId}|${ts}`)
    .digest('base64url')
}

export function verifyRelayAuthToken(token, { fleetKey, fleetId, deviceId, ts }) {
  const expected = relayAuthToken({ fleetKey, fleetId, deviceId, ts })
  const a = Buffer.from(String(token))
  const b = Buffer.from(expected)
  return a.length === b.length && a.equals(b)
}

/** Ephemeral X25519 pair for one handshake. */
export function generateEphemeral() {
  const pair = generateKeyPairSync('x25519')
  return { privateKey: pair.privateKey, publicKey: exportKey(pair.publicKey), privateKeyPem: exportKey(pair.privateKey) }
}
