// Local approval HTTP surface for the approval panel (dev.9). The page is
// served by the DSH web carrier, so browser fetch carries the session cookie.
// All decisions go through ApprovalInbox; nothing here bypasses Tool Policy.
import { isUnsafeBrowserRequest } from './http-guard.js'

const MAX_BODY_BYTES = 64 * 1024

function json(res, status, value) {
  const text = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request body is too large'), { code: 'body-too-large' })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('request body must be JSON'), { code: 'bad-json' })
  }
}

/** HTTP-free decision helper shared by the routes and unit tests. */
export function createApprovalApi({ inbox }) {
  return {
    list() {
      return { approvals: inbox.list() }
    },
    decide(body = {}) {
      const { id, action } = body
      if (typeof id !== 'string' || id === '') {
        throw Object.assign(new Error('id is required'), { code: 'bad-request' })
      }
      if (action === 'approve') {
        const scope = ['ttl', 'room', 'task'].includes(body.scope) ? body.scope : 'once'
        return { ok: true, result: inbox.approve(id, { scope }) }
      }
      if (action === 'deny') {
        return { ok: true, result: inbox.deny(id, typeof body.reason === 'string' ? body.reason : 'denied by local user') }
      }
      throw Object.assign(new Error('action must be approve or deny'), { code: 'bad-request' })
    },
  }
}

/**
 * Register the approval routes on the DSH web carrier.
 * @returns {() => void} disposer
 */
export function registerApprovalRoutes({ webServer, inbox, logger = null }) {
  if (!webServer?.register || !inbox) return () => {}
  const api = createApprovalApi({ inbox })
  const disposers = []
  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/device-fleet/approvals',
      handler: async (req, res) => {
        if (isUnsafeBrowserRequest(req)) return json(res, 403, { error: 'cross-origin request is not allowed', code: 'cross-origin' })
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        try {
          json(res, 200, api.list())
        } catch (error) {
          logger?.warn?.(`[device-fleet] approval list failed: ${String(error?.message ?? error)}`)
          json(res, 500, { error: 'internal error' })
        }
      },
    }),
  )
  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/device-fleet/approvals/decide',
      handler: async (req, res) => {
        if (isUnsafeBrowserRequest(req)) return json(res, 403, { error: 'cross-origin request is not allowed', code: 'cross-origin' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        try {
          const body = await readJsonBody(req)
          json(res, 200, api.decide(body))
        } catch (error) {
          const status = ['bad-request', 'bad-json', 'body-too-large', 'unknown-request'].includes(error?.code) ? 400 : 500
          json(res, status, { error: String(error?.message ?? error), code: error?.code ?? 'error' })
        }
      },
    }),
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
}
