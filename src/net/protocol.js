// Wire protocol constants, canonical JSON and RPC envelope helpers.

export const PROTOCOL_VERSION = 1

/** Largest accepted frame payload (ciphertext bytes, excluding the length prefix). */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024

/** Handshake messages are newline-delimited JSON; encrypted frames are length-prefixed. */
export const HANDSHAKE_TIMEOUT_MS = 10_000

export const FRAME = Object.freeze({
  READY: 'ready',
  RPC_REQUEST: 'rpc.req',
  RPC_RESULT: 'rpc.res',
  RPC_ERROR: 'rpc.err',
  EVENT: 'event',
  PING: 'ping',
  PONG: 'pong',
})

export function stableStringify(value) {
  return JSON.stringify(sortValue(value))
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key])
    return out
  }
  return value
}

export function rpcRequest({ id, method, params }) {
  return { t: FRAME.RPC_REQUEST, v: PROTOCOL_VERSION, id, method, params: params ?? null }
}

export function rpcResult({ id, result }) {
  return { t: FRAME.RPC_RESULT, v: PROTOCOL_VERSION, id, result: result ?? null }
}

export function rpcError({ id, code, message, data = null }) {
  return { t: FRAME.RPC_ERROR, v: PROTOCOL_VERSION, id, error: { code, message, data } }
}

export function eventFrame({ topic, data }) {
  return { t: FRAME.EVENT, v: PROTOCOL_VERSION, topic, data: data ?? null }
}

export function pingFrame() {
  return { t: FRAME.PING, v: PROTOCOL_VERSION }
}

export function pongFrame() {
  return { t: FRAME.PONG, v: PROTOCOL_VERSION }
}

export function serializeError(error) {
  if (!error) return { code: 'internal', message: 'unknown error', data: null }
  return {
    code: typeof error.code === 'string' ? error.code : 'internal',
    message: String(error.message ?? error),
    data: error.data ?? null,
  }
}

export function makeError(code, message, data = null) {
  const error = new Error(message)
  error.code = code
  error.data = data
  return error
}
