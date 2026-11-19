// Read/action HTTP surface for the Fleet console: device overview, room list and
// detail, room user actions, pairing actions, and approval history.
import { isUnsafeBrowserRequest } from './http-guard.js'

const MAX_BODY_BYTES = 128 * 1024

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

function statusFor(error) {
  if (error?.code === 'unknown-room' || error?.code === 'no-session') return 404
  if (error?.code === 'unauthorized') return 403
  return ['bad-request', 'bad-json', 'body-too-large', 'readonly', 'unknown-member', 'unknown-task'].includes(error?.code)
    ? 400
    : 500
}

function actionRoute(webServer, path, method, run) {
  return webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (isUnsafeBrowserRequest(req)) return json(res, 403, { error: 'cross-origin request is not allowed', code: 'cross-origin' })
      if (req.method !== method) return json(res, 405, { error: 'method not allowed' })
      try {
        const body = method === 'POST' ? await readJsonBody(req) : {}
        json(res, 200, (await run(body, req)) ?? { ok: true })
      } catch (error) {
        json(res, statusFor(error), { error: String(error?.message ?? error), code: error?.code ?? 'error' })
      }
    },
  })
}

/**
 * @param {object} options
 * @param {object} options.webServer ctx.webServer
 * @param {object} options.inbox ApprovalInbox
 * @param {object} options.rooms RoomService
 * @param {() => object} options.getOverview
 * @param {object} [options.actions] UI actions (room send/task/close, pairing)
 */
export function registerUiRoutes({ webServer, inbox, rooms, notifications = null, getOverview, actions = null, logger = null }) {
  if (!webServer?.register || !rooms) return () => {}
  const disposers = []
  disposers.push(
    actionRoute(webServer, '/device-fleet/overview', 'GET', async () => ({
      ...getOverview(),
      approvals: inbox?.list?.() ?? [],
      approvalHistory: inbox?.history?.() ?? [],
    })),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/rooms', 'GET', async () => ({ rooms: rooms.list() })),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/room', 'GET', async (_body, req) => {
      let roomId = ''
      try {
        roomId = new URL(req.url ?? '/', 'http://local').searchParams.get('id') ?? ''
      } catch {
        roomId = ''
      }
      if (roomId === '') throw Object.assign(new Error('room id is required'), { code: 'bad-request' })
      const room = typeof actions?.roomDetail === 'function'
        ? await actions.roomDetail({ roomId })
        : rooms.detail(roomId, { limit: 100 })
      return { room }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/room/send', 'POST', async (body) => {
      if (!actions?.sendRoomMessage) throw Object.assign(new Error('room actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.sendRoomMessage(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/room/task', 'POST', async (body) => {
      if (!actions?.roomTask) throw Object.assign(new Error('room actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.roomTask(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/room/close', 'POST', async (body) => {
      if (!actions?.closeRoom) throw Object.assign(new Error('room actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.closeRoom(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/room/member/remove', 'POST', async (body) => {
      if (!actions?.removeMember) throw Object.assign(new Error('room actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.removeMember(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/room/add-remote', 'POST', async (body) => {
      if (!actions?.addRemoteMember) throw Object.assign(new Error('room actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.addRemoteMember(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/room/upgrade', 'POST', async (body) => {
      if (!actions?.upgradeRoom) throw Object.assign(new Error('room actions are unavailable'), { code: 'unsupported' })
      return { ok: true, room: await actions.upgradeRoom(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/room/focus', 'POST', async (body) => {
      if (!actions?.setRoomFocus) throw Object.assign(new Error('room actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: actions.setRoomFocus(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/pair/invite', 'POST', async () => {
      if (!actions?.createInvite) throw Object.assign(new Error('pairing actions are unavailable'), { code: 'unsupported' })
      const invite = await actions.createInvite()
      return {
        ok: true,
        code: typeof invite === 'string' ? invite : invite?.code ?? null,
        expiresAt: typeof invite === 'object' && invite ? invite.expiresAt ?? null : null,
      }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/pair/connect', 'POST', async (body) => {
      if (!actions?.connectAddress) throw Object.assign(new Error('pairing actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.connectAddress(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/approvals/history', 'GET', async () => ({ history: inbox?.history?.() ?? [] })),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/room/invite', 'POST', async (body) => {
      if (!actions?.createRoomInvite) throw Object.assign(new Error('room actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.createRoomInvite(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/room/remove-device', 'POST', async (body) => {
      if (!actions?.removeDevice) throw Object.assign(new Error('room actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.removeDevice(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/room/archive', 'POST', async (body) => {
      if (!actions?.archiveRoom) throw Object.assign(new Error('room actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.archiveRoom(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/room/restore', 'POST', async (body) => {
      if (!actions?.restoreRoom) throw Object.assign(new Error('room actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.restoreRoom(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/room/authority', 'POST', async (body) => {
      if (!actions?.updateAuthority) throw Object.assign(new Error('room actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.updateAuthority(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/room/coordinator', 'POST', async (body) => {
      if (!actions?.setCoordinator) throw Object.assign(new Error('room actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.setCoordinator(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/room/delete', 'POST', async (body) => {
      if (!actions?.deleteRoom) throw Object.assign(new Error('room actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.deleteRoom(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/room/gc', 'POST', async (body) => {
      if (!actions?.gcRoom) throw Object.assign(new Error('room actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.gcRoom(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/pair/join', 'POST', async (body) => {
      if (!actions?.joinFleet) throw Object.assign(new Error('pairing actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.joinFleet(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/fleet/remove-device', 'POST', async (body) => {
      if (!actions?.removeFleetDevice) throw Object.assign(new Error('fleet actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.removeFleetDevice(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/fleet/revoke-device', 'POST', async (body) => {
      if (!actions?.revokeFleetDevice) throw Object.assign(new Error('fleet actions are unavailable'), { code: 'unsupported' })
      // The console asks the user for confirmation before calling this route.
      return { ok: true, result: await actions.revokeFleetDevice({ ...(body ?? {}), confirm: true }) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/fleet/rotation-fork-resolve', 'POST', async (body) => {
      if (!actions?.resolveRotationFork) throw Object.assign(new Error('fleet actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.resolveRotationFork({ ...(body ?? {}), confirm: true }) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/fleet/dismiss-revocation', 'POST', async (body) => {
      if (!actions?.dismissRevocation) throw Object.assign(new Error('fleet actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.dismissRevocation(body ?? {}) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/fleet/rotation-compact', 'POST', async (body) => {
      if (!actions?.compactRotation) throw Object.assign(new Error('fleet actions are unavailable'), { code: 'unsupported' })
      // The console asks the user for confirmation before calling this route.
      return { ok: true, result: await actions.compactRotation({ ...(body ?? {}), confirm: true }) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/fleet/rotation-trust-checkpoint', 'POST', async (body) => {
      if (!actions?.trustRotationCheckpoint) throw Object.assign(new Error('fleet actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.trustRotationCheckpoint({ ...(body ?? {}), confirm: true }) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/fleet/rotate-identity', 'POST', async () => {
      if (!actions?.rotateIdentity) throw Object.assign(new Error('fleet actions are unavailable'), { code: 'unsupported' })
      return { ok: true, result: await actions.rotateIdentity() }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/fleet/reset-identity', 'POST', async (body) => {
      if (!actions?.resetIdentity) throw Object.assign(new Error('fleet actions are unavailable'), { code: 'unsupported' })
      // The console requires an explicit typed confirmation before calling this route.
      return { ok: true, result: await actions.resetIdentity({ ...(body ?? {}), confirm: true }) }
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/notifications', 'GET', async () => ({
      notifications: notifications?.list?.() ?? [],
      unread: notifications?.unreadCount?.() ?? 0,
    })),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/notifications/read', 'POST', async (body) => ({
      ok: true,
      changed: notifications?.markRead?.(body ?? {}) ?? 0,
    })),
  )
  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/device-fleet/events',
      handler: (req, res) => {
        if (req.method !== 'GET') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        const send = () => {
          try {
            const payload = {
              ...getOverview(),
              approvals: inbox?.list?.() ?? [],
              approvalHistory: inbox?.history?.() ?? [],
            }
            res.write(`event: overview\ndata: ${JSON.stringify(payload)}\n\n`)
          } catch {
            /* client went away */
          }
        }
        send()
        const timer = setInterval(send, 3000)
        timer.unref?.()
        req.on('close', () => {
          clearInterval(timer)
          try {
            res.end()
          } catch {
            /* ignore */
          }
        })
      },
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/calls', 'GET', async () => {
      if (typeof actions?.getCalls !== 'function') return { calls: [] }
      return actions.getCalls({ limit: 200 })
    }),
  )
  disposers.push(
    actionRoute(webServer, '/device-fleet/trajectory', 'GET', async (_body, req) => {
      if (typeof actions?.getTrajectory !== 'function') throw Object.assign(new Error('trajectory is unavailable'), { code: 'unsupported' })
      let deviceId = ''
      let sessionId = ''
      try {
        const url = new URL(req.url ?? '/', 'http://local')
        deviceId = url.searchParams.get('device') ?? ''
        sessionId = url.searchParams.get('session') ?? ''
      } catch {
        /* handled below */
      }
      if (sessionId === '') throw Object.assign(new Error('session is required'), { code: 'bad-request' })
      return actions.getTrajectory({ deviceId, sessionId })
    }),
  )
  if (logger) logger.debug?.('[device-fleet] UI action routes registered')
  return () => {
    for (const dispose of disposers) dispose()
  }
}
