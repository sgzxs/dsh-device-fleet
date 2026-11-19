// Tamper-evident Fleet roster persistence. The Fleet key is shared by every
// member, so an HMAC detects accidental corruption or a roster file edited
// without the Fleet secret. It is deliberately not a replacement for the
// future old-key-authorized device-key rotation protocol.
import { createHmac, timingSafeEqual } from 'node:crypto'

function canonical(entries = []) {
  return JSON.stringify(
    [...entries]
      .filter((entry) => entry && typeof entry.deviceId === 'string')
      .map((entry) => ({
        deviceId: entry.deviceId,
        name: entry.name ?? 'device',
        edPublic: entry.edPublic,
        xPublic: entry.xPublic,
        addedAt: entry.addedAt ?? null,
      }))
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId)),
  )
}

export function signRoster(entries, fleetKey) {
  if (typeof fleetKey !== 'string' || fleetKey === '') return null
  return createHmac('sha256', Buffer.from(fleetKey, 'utf8')).update(canonical(entries)).digest('base64url')
}

export function verifyRoster(entries, signature, fleetKey) {
  if (typeof signature !== 'string' || signature === '') return false
  const expected = signRoster(entries, fleetKey)
  if (!expected) return false
  try {
    const left = Buffer.from(expected)
    const right = Buffer.from(signature)
    return left.length === right.length && timingSafeEqual(left, right)
  } catch {
    return false
  }
}
