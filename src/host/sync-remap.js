// Remap Room replica events between a mirror's local roomId and the authority
// roomId used on the sync wire. Signatures cover the logical roomId (canonical
// signing excludes seq/prev/signedRoomId), so local-origin events are re-signed
// after remapping while already-authority-signed remote events keep their sig.
export function remapReplicaEventsForSync({
  events = [],
  targetRoomId,
  localRoomId,
  localDeviceId,
  signEvent = null,
  verifyEvent = null,
} = {}) {
  if (!Array.isArray(events)) return []
  const remapped = []
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.roomId === targetRoomId) {
      remapped.push(event)
      continue
    }
    const copy = { ...event, roomId: targetRoomId, signedRoomId: targetRoomId, signature: null }
    const signedRoomId = event.signedRoomId ?? event.roomId
    if (event.origin === localDeviceId || signedRoomId === localRoomId) {
      if (typeof signEvent === 'function') {
        const signature = signEvent(copy)
        if (!signature) continue
        copy.signature = signature
      }
    } else if (event.signature) {
      copy.signature = event.signature
      if (typeof verifyEvent === 'function' && !verifyEvent(copy)) continue
    }
    remapped.push(copy)
  }
  return remapped
}
