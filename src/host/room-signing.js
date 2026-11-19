// Event signing for Room replicas. Each device signs its own events with the
// Ed25519 device key from the Fleet identity; peers verify with the roster key.
// Legacy unsigned events are still accepted (migration), new events are signed.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key])
    return sorted
  }
  return value
}

export function signJsonValue(value, privatePem) {
  if (!privatePem) return null
  const clean = { ...value }
  delete clean.signature
  return sign(null, Buffer.from(JSON.stringify(sortValue(clean)), 'utf8'), createPrivateKey(privatePem)).toString('base64url')
}

export function verifyJsonValue(value, publicPem) {
  if (!value?.signature || !publicPem) return false
  try {
    const clean = { ...value }
    delete clean.signature
    return verify(null, Buffer.from(JSON.stringify(sortValue(clean)), 'utf8'), createPublicKey(publicPem), Buffer.from(value.signature, 'base64url'))
  } catch {
    return false
  }
}

export function canonicalRoomEvent(event) {
  const clean = { ...event }
  // seq/prev are local-log positions and are rewritten when an event crosses a
  // mirror boundary; signedRoomId is local mapping metadata. Neither is signed.
  delete clean.signature
  delete clean.seq
  delete clean.prev
  delete clean.signedRoomId
  return JSON.stringify(sortValue(clean))
}

export function signRoomEvent(event, privatePem) {
  if (!privatePem) return null
  return sign(null, Buffer.from(canonicalRoomEvent(event), 'utf8'), createPrivateKey(privatePem)).toString('base64url')
}

export function verifyRoomEvent(event, publicPem) {
  if (!event?.signature || !publicPem) return false
  try {
    return verify(null, Buffer.from(canonicalRoomEvent(event), 'utf8'), createPublicKey(publicPem), Buffer.from(event.signature, 'base64url'))
  } catch {
    return false
  }
}
