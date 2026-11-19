// Runtime config HTTP surface (dev.15): read effective config, list UI options,
// and apply a patch live. The UI posts here; no plugin or DSH restart is involved.
import { isUnsafeBrowserRequest } from './http-guard.js'

const MAX_BODY_BYTES = 256 * 1024

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
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

/**
 * @param {object} options
 * @param {object} options.webServer ctx.webServer
 * @param {object} options.runtime RuntimeConfig
 * @param {() => Promise<object>|object} [options.getOptions] UI option catalog (presets, shells, paths)
 * @param {(patch: object) => Promise<object>|object} [options.preparePatch] side effects before applying (e.g. mkdir)
 */
export function registerConfigRoutes({ webServer, runtime, getOptions = null, preparePatch = null, logger = null }) {
  if (!webServer?.register || !runtime) return () => {}
  const disposers = []
  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/device-fleet/options',
      handler: async (req, res) => {
        if (isUnsafeBrowserRequest(req)) return json(res, 403, { error: 'cross-origin request is not allowed', code: 'cross-origin' })
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        try {
          json(res, 200, (await getOptions?.()) ?? {})
        } catch (error) {
          logger?.warn?.(`[device-fleet] options failed: ${String(error?.message ?? error)}`)
          json(res, 500, { error: 'internal error' })
        }
      },
    }),
  )
  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/device-fleet/config',
      handler: async (req, res) => {
        if (isUnsafeBrowserRequest(req)) return json(res, 403, { error: 'cross-origin request is not allowed', code: 'cross-origin' })
        if (req.method === 'GET') {
          try {
            json(res, 200, runtime.snapshot())
          } catch (error) {
            json(res, 500, { error: String(error?.message ?? error) })
          }
          return
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        try {
          const body = await readJsonBody(req)
          const patch = body?.patch ?? body
          const prepared = preparePatch ? await preparePatch(patch) : patch
          const config = await runtime.update(prepared ?? patch)
          json(res, 200, { ok: true, config, appliedAt: Date.now() })
        } catch (error) {
          const status = ['bad-request', 'bad-json', 'body-too-large', 'readonly'].includes(error?.code) ? 400 : 500
          if (status === 500) logger?.warn?.(`[device-fleet] config update failed: ${String(error?.message ?? error)}`)
          json(res, status, { error: String(error?.message ?? error), code: error?.code ?? 'error' })
        }
      },
    }),
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
}
