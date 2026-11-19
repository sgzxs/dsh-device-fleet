// Room Invite / room key helpers (ADR-0025 Phase 4).
//
// Invite code is base64url(JSON). It intentionally carries the room key so a
// new member can bootstrap; Phase 4 still trusts Fleet transport for sync
// authorization, event signatures land in a later pass.
import { randomBytes } from 'node:crypto'

export function createRoomKey() {
  return randomBytes(24).toString('base64url')
}

export function encodeRoomInvite({ roomId, key, deviceId, ttlMs = 24 * 60 * 60 * 1000, note = '', sign = null } = {}) {
  if (typeof roomId !== 'string' || roomId === '') throw new Error('roomId is required')
  if (typeof key !== 'string' || key === '') throw new Error('room key is required')
  const payload = {
    v: 1,
    roomId,
    key,
    deviceId: deviceId ?? null,
    exp: Date.now() + Math.max(60_000, Number(ttlMs) || 0),
    note: String(note ?? ''),
  }
  if (typeof sign === 'function') {
    const signature = sign(payload)
    if (signature) payload.signature = signature
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeRoomInvite(code, { verify = null, requireSignature = false } = {}) {
  if (typeof code !== 'string' || code.trim() === '') throw Object.assign(new Error('invite code is required'), { code: 'bad-request' })
  let payload
  try {
    payload = JSON.parse(Buffer.from(code.trim(), 'base64url').toString('utf8'))
  } catch {
    throw Object.assign(new Error('invite code is malformed'), { code: 'bad-invite' })
  }
  if (!payload || payload.v !== 1 || typeof payload.roomId !== 'string' || typeof payload.key !== 'string') {
    throw Object.assign(new Error('invite code is malformed'), { code: 'bad-invite' })
  }
  if (Number(payload.exp) <= Date.now()) throw Object.assign(new Error('invite code has expired'), { code: 'invite-expired' })
  if (typeof verify === 'function') {
    if (!payload.signature) {
      if (requireSignature) throw Object.assign(new Error('invite code is not signed'), { code: 'bad-invite' })
    } else if (!verify(payload)) {
      throw Object.assign(new Error('invite signature is invalid'), { code: 'bad-invite' })
    }
  }
  return payload
}
