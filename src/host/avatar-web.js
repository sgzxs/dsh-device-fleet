// Agent avatars used by the Room conversation (dev.25/26). Built-in PNG files
// ship with the package; the user can upload a library into the state dir and
// Room members cycle through it.
import { isUnsafeBrowserRequest } from './http-guard.js'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const AVATARS = {
  host: 'host.png',
  worker: 'worker.png',
  user: 'user.png',
}

const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024

function safeFileName(input, extension) {
  const base = String(input ?? 'avatar')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `${base || 'avatar'}-${Date.now().toString(36)}${extension}`
}

function listLibrary(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => EXTENSIONS.has(name.slice(name.lastIndexOf('.')).toLowerCase()))
    .sort()
    .map((name) => ({ name, url: `/device-fleet/avatar-file?name=${encodeURIComponent(name)}` }))
}

function parseDataUrl(dataUrl) {
  const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''))
  if (!match) throw Object.assign(new Error('dataUrl must be a base64 png/jpeg/webp image'), { code: 'bad-request' })
  const extension = match[1] === 'jpeg' ? '.jpg' : `.${match[1]}`
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error(`avatar must be between 1 byte and ${MAX_UPLOAD_BYTES} bytes`), { code: 'bad-request' })
  }
  return { extension, buffer }
}

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_UPLOAD_BYTES + 64 * 1024) throw Object.assign(new Error('avatar body is too large'), { code: 'body-too-large' })
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
 * @param {string} options.dir built-in avatar directory
 * @param {string} options.libraryDir user-uploaded avatar directory
 */
export function registerAvatarRoutes({ webServer, dir, libraryDir = null, logger = null }) {
  if (!webServer?.register || !dir) return () => {}
  const disposers = []
  const sendPng = (res, file, alt = null) => {
    try {
      const data = readFileSync(file)
      res.statusCode = 200
      res.setHeader('content-type', alt ?? 'image/png')
      res.setHeader('cache-control', 'public, max-age=3600')
      res.setHeader('content-length', String(data.length))
      res.end(data)
    } catch {
      logger?.warn?.(`[device-fleet] avatar missing: ${file}`)
      res.statusCode = 404
      res.end()
    }
  }
  for (const [name, file] of Object.entries(AVATARS)) {
    disposers.push(
      webServer.register({
        kind: 'exact',
        path: `/device-fleet/avatar/${name}`,
        handler: async (req, res) => {
          if (isUnsafeBrowserRequest(req)) return json(res, 403, { error: 'cross-origin request is not allowed', code: 'cross-origin' })
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.statusCode = 405
            res.end()
            return
          }
          if (req.method === 'HEAD') {
            res.statusCode = 200
            res.end()
            return
          }
          sendPng(res, join(dir, file))
        },
      }),
    )
  }
  if (libraryDir) {
    try {
      mkdirSync(libraryDir, { recursive: true })
    } catch {
      /* best effort */
    }
    disposers.push(
      webServer.register({
        kind: 'exact',
        path: '/device-fleet/avatar-library',
        handler: async (req, res) => {
          if (isUnsafeBrowserRequest(req)) return json(res, 403, { error: 'cross-origin request is not allowed', code: 'cross-origin' })
          try {
            if (req.method === 'GET') return json(res, 200, { items: listLibrary(libraryDir) })
            if (req.method === 'POST') {
              const body = await readJson(req)
              const { extension, buffer } = parseDataUrl(body.dataUrl)
              const name = safeFileName(body.name, extension)
              writeFileSync(join(libraryDir, name), buffer)
              return json(res, 200, { ok: true, item: { name, url: `/device-fleet/avatar-file?name=${encodeURIComponent(name)}` } })
            }
            return json(res, 405, { error: 'method not allowed' })
          } catch (error) {
            return json(res, 400, { error: String(error?.message ?? error), code: error?.code ?? 'bad-request' })
          }
        },
      }),
    )
    disposers.push(
      webServer.register({
        kind: 'exact',
        path: '/device-fleet/avatar-file',
        handler: async (req, res) => {
          if (isUnsafeBrowserRequest(req)) return json(res, 403, { error: 'cross-origin request is not allowed', code: 'cross-origin' })
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.end()
            return
          }
          let name = ''
          try {
            name = new URL(req.url ?? '/', 'http://local').searchParams.get('name') ?? ''
          } catch {
            name = ''
          }
          const clean = basename(name)
          if (clean === '' || clean !== name || !EXTENSIONS.has(clean.slice(clean.lastIndexOf('.')).toLowerCase())) {
            res.statusCode = 400
            res.end()
            return
          }
          sendPng(res, join(libraryDir, clean))
        },
      }),
    )
    disposers.push(
      webServer.register({
        kind: 'exact',
        path: '/device-fleet/avatar-library/remove',
        handler: async (req, res) => {
          if (isUnsafeBrowserRequest(req)) return json(res, 403, { error: 'cross-origin request is not allowed', code: 'cross-origin' })
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          try {
            const body = await readJson(req)
            const clean = basename(String(body.name ?? ''))
            if (clean === '' || clean !== body.name) throw Object.assign(new Error('invalid name'), { code: 'bad-request' })
            unlinkSync(join(libraryDir, clean))
            return json(res, 200, { ok: true })
          } catch (error) {
            return json(res, 400, { error: String(error?.message ?? error) })
          }
        },
      }),
    )
  }
  return () => {
    for (const dispose of disposers) dispose()
  }
}
