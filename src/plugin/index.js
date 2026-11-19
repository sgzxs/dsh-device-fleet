// Cordis Host plugin entry for the device-fleet bundle.
//
// Step 1 wires the network layer, the FleetNode, the direct-call host/client,
// the six `fleet_*` tools, and the two adoption mechanisms that are cheap to
// land now (a prompt section and a first-use manual + orchestration nudge).
// Room, Room Board, delegation and the UI land in later steps.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import { FleetNode } from '../net/fleet-node.js'
import { accountFingerprint } from '../net/identity.js'
import { createRevocationRecord, createRotationRecord, ROTATION_PAGE_LIMIT, rotateIdentityKeys, rotationChainPage } from '../net/rotation.js'
import { DirectCallClient, DirectCallHost } from '../host/direct-call.js'
import { DelegationHost } from '../host/delegation.js'
import { ApprovalInbox } from '../host/approval-inbox.js'
import { ScopeRevocationQueue } from '../host/pending-revocations.js'
import { CallLedger } from '../host/call-ledger.js'
import { Outbox } from '../host/outbox.js'
import { TrajectoryStore } from '../host/trajectory.js'
import { friendlyName } from '../host/human-names.js'
import { NotificationCenter } from '../host/notifications.js'
import { RoomService } from '../host/room-service.js'
import { RoomReplicaStore } from '../host/room-replica.js'
import { RoomReplicaSync } from '../host/room-sync.js'
import { remapReplicaEventsForSync } from '../host/sync-remap.js'
import { decodeRoomInvite } from '../host/room-invite.js'
import { signJsonValue, verifyJsonValue, signRoomEvent, verifyRoomEvent } from '../host/room-signing.js'
import { RemoteRoomBridge } from '../host/remote-room.js'
import { RemoteRoomPeer } from '../host/remote-room-peer.js'
import { registerApprovalRoutes } from '../host/approval-web.js'
import { registerUiRoutes } from '../host/ui-web.js'
import { detectOverlay, overlayAddresses } from '../host/overlay.js'
import { registerConfigRoutes } from '../host/config-web.js'
import { registerAvatarRoutes } from '../host/avatar-web.js'
import { RuntimeConfig, deepMerge } from '../host/runtime-config.js'
import { ExecutionSlot, DEFAULT_SHELL_TOOL } from '../host/execution-slot.js'
import { deleteTransferPath, listTransferTree, readTransferChunk, statTransferPath, writeTransferChunk } from '../host/file-transfer.js'
import { createLazyExecutionHost } from '../host/lazy-execution-host.js'
import { ToolPolicy } from '../host/tool-policy.js'
import { createFleetHandlers, createFleetToolDefinitions } from '../host/tools.js'
import { accountMatches, compactRotationChain, createInvite, isKnownDevice, loadPeerRotations, loadRotationState, loadState, redeemIssuedInvite, rememberKnownDevice, removePeerHintsForDevice, resetDeviceIdentity, saveAccountBinding, savePeerHint, savePeerRotations, saveRoster, saveRotationState, writePendingEnrollment } from '../host/store.js'

export const name = 'device-fleet'

/** Only the tool registry is mandatory; everything else degrades. */
export const inject = ['tools']

const CAPABILITIES = ['direct-call', 'room', 'delegation']
const PROMPT_SECTION_ORDER = 9000

const FLEET_MANUAL = `# Fleet 使用手册

你是设备联邦（Fleet）中的一个设备成员。其他设备通过 fleet 工具暴露能力，规则如下：

- **先看图再动手**：调用任何 fleet 工具前先 \`fleet_list\` 拿到 device id；不认识的工具用 \`fleet_tools\` 查。
- **直调 vs 协作**：只是借用另一台设备的工具（看文件、取文件、跑命令、取日志）用 \`fleet_read\` / \`fleet_fetch\` / \`fleet_run\` / \`fleet_call\`；需要对方 agent 持续参与、共享任务状态时用 Room（room_* 工具）；只要一次结果时用 fleet_delegate。
- **离线快速失败**：目标设备离线时直调立即报错，不要等待；改为稍后再试或换设备。
- **审批在对方设备上**：需要本机审批的调用会等待对方用户；超时/被拒绝时按错误码处理，换方案或请用户处理，不要绕过。审批 scope 可为 once/ttl/room/task；Room/任务级授权随 Room 关闭或任务 done 失效。
- **直调/委派/Room 的选择**：直调无状态、不带本会话历史；委派的任务描述必须自包含；只有需要持续协作/共享任务板时才用 Room。
- **保密**：邀请码含 Fleet key，私钥/证书私钥不得出现在回复、日志或 Room 消息中；不要用 deviceId 当人类可读名称。
- **设备密钥与吊销**：轮换、吊销与分叉状态用 \`fleet_rotation_status\`；吊销、身份重置和分叉选择都必须先让用户确认，再带 \`confirm: true\` 调用。
- **权限由对方决定**：你只能请求，能否执行、能访问哪些目录由目标设备配置决定。`

/** Session ids already handed the fleet manual. */
const manualDelivered = new Set()

export const Config = Schema.object({
  deviceName: Schema.string().default('device').description('Display name of this device in the Fleet.'),
  dataDir: Schema.string().description('Override the device-fleet state directory (defaults to $DSH_HOME/device-fleet).'),
  direct: Schema.object({
    host: Schema.string().default('0.0.0.0'),
    port: Schema.number().default(0),
  })
    .default({ host: '0.0.0.0', port: 0 })
    .description('Direct LAN/VPN listener. Set port 0 to let the OS pick one; discovery announces it.'),
  discovery: Schema.boolean().default(true).description('Advertise this device on the local network over UDP multicast.'),
  relay: Schema.object({
    host: Schema.string(),
    port: Schema.number(),
    dataPort: Schema.number(),
    tls: Schema.object({
      ca: Schema.string(),
      cert: Schema.string(),
      key: Schema.string(),
      servername: Schema.string(),
      rejectUnauthorized: Schema.boolean(),
    }),
  })
    .description('Self-hosted relay (v2). `tls.ca` enables TLS; `tls.cert/key` add a client certificate (mTLS).'),
  relays: Schema.array(Schema.object({
    host: Schema.string(),
    port: Schema.number(),
    dataPort: Schema.number(),
    tls: Schema.object({
      ca: Schema.string(),
      servername: Schema.string(),
      rejectUnauthorized: Schema.boolean(),
    }),
  }))
    .description('Multiple self-hosted relays; clients try them in order and fail over automatically.'),
  execution: Schema.object({
    cwd: Schema.string(),
    agentPreset: Schema.string(),
    shellTool: Schema.string().default(DEFAULT_SHELL_TOOL),
    approvalTimeoutMs: Schema.number().default(60000),
    delegateTimeoutMs: Schema.number().default(180000),
    subagentProvider: Schema.string().default('spawn'),
  })
    .default({ shellTool: DEFAULT_SHELL_TOOL, approvalTimeoutMs: 60000, delegateTimeoutMs: 180000, subagentProvider: 'spawn' })
    .description('Execution Slot and delegation settings for direct calls and one-shot delegation.'),
  policy: Schema.object({
    allowedRoots: Schema.array(Schema.string()).default([]),
    capabilities: Schema.any().default({}),
    allowedTools: Schema.array(Schema.string()).default([]),
    approvalTtlMs: Schema.number().default(15 * 60 * 1000),
  })
    .default({ allowedRoots: [], capabilities: {}, allowedTools: [], approvalTtlMs: 15 * 60 * 1000 })
    .description('Direct-call Tool Policy owned by this device (ADR-0004/ADR-0019).'),
  promptSection: Schema.boolean().default(true).description('Render the one-sentence Fleet nudge when the Fleet has members.'),
  autoApproveAsk: Schema.boolean().default(false).description('Testing only: auto-approve every local approval request.'),
  approvals: Schema.object({
    ttlMs: Schema.number().default(60000),
    maxPending: Schema.number().default(50),
    simulation: Schema.boolean().default(false),
  })
    .default({ ttlMs: 60000, maxPending: 50, simulation: false })
    .description('Local approval inbox (ADR-0020). `simulation` exposes fleet_simulate_request for local testing.'),
  invite: Schema.object({
    ttlMs: Schema.number().default(24 * 60 * 60 * 1000),
  })
    .default({ ttlMs: 24 * 60 * 60 * 1000 })
    .description('Fleet invites expire after this TTL and are single-use.'),
  rotation: Schema.object({
    checkpointQuorum: Schema.number().default(1),
  })
    .default({ checkpointQuorum: 1 })
    .description('How many independent confirmations a pruned checkpoint needs (local + endorsements before trust).'),
  notifications: Schema.object({
    webhook: Schema.string(),
    timeoutMs: Schema.number().default(5000),
  })
    .default({ timeoutMs: 5000 })
    .description('Optional external notification webhook (POST JSON for approvals, revocations and forks).'),
  replica: Schema.object({
    autoCompactMinEvents: Schema.number().default(800),
  })
    .default({ autoCompactMinEvents: 800 })
    .description('Room replica maintenance: automatically compact event logs above this size.'),
  room: Schema.object({
    rotationSeqMode: Schema.string().default('audit'),
  })
    .default({ rotationSeqMode: 'audit' })
    .description('Room event signing epoch: `audit` accepts historical events; `strict` requires rotationSeq == origin current seq.'),
})

function packageVersion() {
  try {
    const file = fileURLToPath(new URL('../../package.json', import.meta.url))
    return JSON.parse(readFileSync(file, 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Wrap a handler so failures are reported as text instead of tool crashes. */
function safe(handler) {
  return async (...args) => {
    try {
      return await handler(...args)
    } catch (error) {
      const code = error?.code ?? 'error'
      return { text: `Error: [${String(code)}] ${String(error?.message ?? error)}` }
    }
  }
}

function withManual(definitions) {
  return definitions.map((definition) => ({
    ...definition,
    execute: async (...args) => {
      const result = await definition.execute(...args)
      const exec = args[1]
      const sessionId = exec?.agent?.session?.id
      if (typeof sessionId !== 'string' || manualDelivered.has(sessionId)) return result
      manualDelivered.add(sessionId)
      if (typeof result === 'object' && result !== null && 'text' in result) {
        return { ...result, text: `${String(result.text)}\n\n---\n${FLEET_MANUAL}` }
      }
      return result
    },
  }))
}

export function apply(ctx, profileConfig) {
  const pluginVersion = packageVersion()
  const dshVersion = process.env.DSH_CLIENT_VERSION ?? 'unknown'
  // Optional services: Cordis throws on direct property access for services the
  // plugin did not inject, so every optional service goes through get().
  const service = (name) => {
    try {
      return ctx.get?.(name)
    } catch {
      return undefined
    }
  }
  const logger = service('logger') ?? console

  let state
  try {
    state = loadState({ dshHome: process.env.DSH_HOME, dataDir: profileConfig?.dataDir, name: profileConfig?.deviceName })
  } catch (error) {
    logger.error?.(`[device-fleet] cannot load state: ${String(error?.message ?? error)}`)
    return
  }

  // Cold-start diagnostics live next to the state files so a failed service
  // composition can be inspected after the fact, not only in the console.
  const diagnosticsFile = join(state.dataDir, 'diagnostics.jsonl')
  const recordHostDiagnostic = (event, detail = {}, level = 'warn') => {
    const entry = { at: new Date().toISOString(), event, ...detail }
    try {
      appendFileSync(diagnosticsFile, `${JSON.stringify(entry)}\n`)
    } catch {
      /* best effort */
    }
    const line = `[device-fleet] ${event}${detail.method ? ` (${detail.method})` : ''}`
    if (level === 'info') logger.info?.(line)
    else logger.warn?.(line)
  }

  // Runtime config: profile patch is the base, UI edits are persisted in the
  // state dir and applied live (no plugin/DSH restart).
  const runtime = new RuntimeConfig({
    base: profileConfig ?? {},
    overridesFile: join(state.dataDir, 'config-overrides.json'),
  })
  // Migration: an old UI save wrote the legacy `tool: deny` + empty allowlist;
  // raw tools now follow the DSH pipeline by default.
  if (
    runtime.overrides?.policy?.capabilities?.tool === 'deny' &&
    (runtime.overrides?.policy?.allowedTools?.length ?? 0) === 0
  ) {
    runtime.overrides = deepMerge(runtime.overrides, { policy: { capabilities: { tool: 'auto' } } })
    runtime.current = deepMerge(runtime.base, runtime.overrides)
    runtime.persist()
  }
  const config = runtime.current

  const loadIdentityRotationChain = () => loadRotationState(state).records
  const node = new FleetNode({
    identity: state.identity,
    fleet: state.fleet,
    name: config.deviceName,
    accountFingerprint: state.enrollment?.accountFingerprint ?? state.account?.fingerprint ?? null,
    rotationChain: loadIdentityRotationChain(),
    rotationCheckpoint: loadRotationState(state).checkpoint,
    peerRotations: loadPeerRotations(state),
    inviteId: state.enrollment?.inviteId ?? null,
    onPeerInvite: async (peer) => {
      const jti = typeof peer?.inviteId === 'string' ? peer.inviteId : null
      // A known device was admitted before (possibly removed later); do not burn
      // the single-use invite again on re-admission.
      if (isKnownDevice(state, peer.deviceId)) return true
      // First contact must carry a redeemable invite id. An unbound TOFU join
      // would let any Fleet-key holder bypass single-use/expiry forever.
      if (!jti) return false
      const result = redeemIssuedInvite(state, { jti, deviceId: peer.deviceId })
      if (!result.ok) {
        logger.warn?.(`[device-fleet] invite rejected for ${peer.deviceId}: ${String(result.reason ?? 'unknown')}`)
        return false
      }
      return true
    },
    direct: config.direct ?? { host: '127.0.0.1', port: 0 },
    discovery: config.discovery ? true : false,
    relay: config.relay ?? state.enrollment?.relay ?? null,
    relays: [...(config.relays ?? []), ...(state.enrollment?.relays ?? [])],
    roster: state.roster,
    peerHints: [...(state.enrollment?.endpoints ?? []), ...(state.peerHints ?? [])],
    pluginVersion,
    dshVersion,
    capabilities: CAPABILITIES,
  })

  // Reassigned by the live-config handler below, so it must not be const.
  let policy = new ToolPolicy(config.policy, { stateFile: join(state.dataDir, 'tool-grants.json') })
  let sessionController = service('sessionController')
  let fsService = service('fs')
  let subagentsService = service('subagents')
  const agentPresets = service('agentPresets')
  const workingDirectory = service('workingDirectory')
  const inbox = new ApprovalInbox({
    ttlMs: config.approvals?.ttlMs ?? 60_000,
    maxPending: config.approvals?.maxPending ?? 50,
    stateFile: join(state.dataDir, 'approval-inbox.json'),
    onAudit: (entry) => {
      try {
        appendFileSync(join(state.dataDir, 'approval-history.jsonl'), `${JSON.stringify(entry)}\n`)
      } catch {
        /* best effort */
      }
    },
  })
  const deviceLabel = (deviceId) => {
    const entry = (state.roster ?? []).find((device) => device.deviceId === deviceId)
    return entry?.name ?? '另一台设备'
  }
  const notifications = new NotificationCenter({    limit: 200,
    onPush: (entry) => {
      try {
        appendFileSync(join(state.dataDir, 'notifications.jsonl'), `${JSON.stringify(entry)}\n`)
      } catch {
        /* best effort */
      }
      const webhook = runtime.current.notifications?.webhook
      if (typeof webhook === 'string' && /^https?:\/\//.test(webhook)) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), Number(runtime.current.notifications?.timeoutMs) || 5000)
        timer.unref?.()
        void fetch(webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(entry),
          signal: controller.signal,
        }).catch(() => {}).finally(() => clearTimeout(timer))
      }
    },
  })
  inbox.on('request', (request) => {
    logger.info?.(`[device-fleet] approval requested by ${request.fromDeviceId}: ${request.capability}/${String(request.tool ?? '')}`)
    notifications.push({
      kind: 'approval',
      title: '远程调用等待审批',
      body: `${deviceLabel(request.fromDeviceId)} 请求 ${String(request.tool ?? request.capability ?? 'tool')}`,
      data: { approvalId: request.id, fromDeviceId: request.fromDeviceId, capability: request.capability, tool: request.tool ?? null, roomId: request.roomId ?? null, taskId: request.taskId ?? null },
    })
  })
  try {
    const historyFile = join(state.dataDir, 'approval-history.jsonl')
    if (existsSync(historyFile)) {
      const entries = readFileSync(historyFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)
      inbox.historyEntries = entries.reverse().slice(0, inbox.historyLimit)
    }
  } catch {
    /* audit history is best effort */
  }
  const approvalsApi = {
    list: () => inbox.list(),
    approve: (id, options) => inbox.approve(id, options),
    deny: (id, reason) => inbox.deny(id, reason),
    simulate: async ({ fromDeviceId, capability, tool, reason }) => {
      if (runtime.current.approvals?.simulation !== true) {
        throw Object.assign(new Error('approval simulation is disabled'), { code: 'unsupported' })
      }
      const promise = inbox.request({
        fromDeviceId: fromDeviceId ?? 'simulated-device',
        capability: capability ?? 'run',
        tool: tool ?? null,
        reason: reason ?? 'simulated approval request',
        args: {},
      })
      const summary = inbox.list().at(-1)
      // Keep the promise from becoming an unhandled rejection when the
      // request expires without an answer; the demo only inspects the inbox.
      promise.catch(() => {})
      return `simulated approval request ${summary?.id ?? '?'} created; decide it in the Device Fleet approval panel`
    },
  }
  const requestApproval = async (request) =>
    runtime.current.autoApproveAsk === true ? { approved: true, scope: 'once' } : inbox.request(request)

  const roomKeyEncryptionKey = createHash('sha256').update(`room-key:${state.fleet.fleetKey}`).digest()
  const encryptRoomKey = (plain) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', roomKeyEncryptionKey, iv)
    const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
    return { v: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') }
  }
  const decryptRoomKey = (blob) => {
    if (!blob || typeof blob !== 'object') return null
    const decipher = createDecipheriv('aes-256-gcm', roomKeyEncryptionKey, Buffer.from(String(blob.iv), 'base64url'))
    decipher.setAuthTag(Buffer.from(String(blob.tag), 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(String(blob.data), 'base64url')), decipher.final()]).toString('utf8')
  }
  const rooms = new RoomService({
    sessionController,
    createUserMessage,
    stateFile: join(state.dataDir, 'rooms.json'),
    signInvite: (payload) => signJsonValue(payload, state.identity?.edPrivate),
    verifyInvite: (payload) => verifyJsonValue(payload, state.identity?.edPublic),
    encryptRoomKey,
    decryptRoomKey,
    // Room records go into the Host session log as ignorable plugin records;
    // surface a single warning if this harness cannot store them.
    warn: (line) => logger.warn?.(line),
    // Remote participants are woken through the Fleet RPC bridge below.
    wakeRemote: (room, member, message) => remoteRoomBridge.wakeRemote(room, member, message),
    // A mirror can wake a remote participant's local agent directly, even when
    // the authority is offline, by routing to the member's owning device.
    mirrorWakeRemote: async (room, member, message) => {
      if (!member?.deviceId || !room?.mirror) return false
      try {
        await node.request(member.deviceId, 'room.wake.member', {
          roomId: room.mirror.roomId,
          memberId: member.memberId,
          messageId: message.id,
          from: message.from,
          text: message.text,
          createdAt: message.createdAt,
        }, { timeoutMs: 8_000 })
        return true
      } catch (error) {
        logger.warn?.(`[device-fleet] mirror wake routing failed (${member.deviceId}): ${String(error?.message ?? error)}`)
        return false
      }
    },
    // Closing an authority Room notifies its remote mirrors; closing a local
    // mirror releases its binding/replica so a departed participant leaves no
    // stale Room behind.
    onClosed: async (room) => {
      await remoteRoomBridge.notifyClosed(room)
      if (room?.mirror) {
        remoteRoomPeer.releaseSession(room.roomId)
        roomReplica.removeReplica(room.roomId)
      }
    },
  })
  // Migration: older mirrors stored another device's local participant as
  // kind=local. If the session cannot resolve on this device, it belongs to the
  // mirror authority device and must be marked remote so wake routing works.
  void (async () => {
    let changed = false
    for (const room of rooms.rooms.values()) {
      if (!room.mirror) continue
      for (const member of room.members.values()) {
        if (member.kind !== 'local' || member.sessionId === room.roomId) continue
        const resolved = await sessionController.resolveAgent(member.sessionId).catch(() => null)
        if (resolved?.agent) continue
        member.kind = 'remote'
        member.deviceId = room.mirror.deviceId
        member.remoteSessionId = member.sessionId
        member.sessionId = undefined
        changed = true
      }
    }
    if (changed) rooms.persist()
  })()
  // Phase 1 (ADR-0025): every device keeps a write-through Room replica event
  // log. reads still come from the in-memory RoomService until Phase 2, but the
  // legacy rooms.json is imported once so the replica is the migration target.
  // These helpers must be initialized before the store constructs: the store
  // keeps the signEvent callback and activates it immediately (1.12.1 TDZ fix).
  const currentRotationSeq = () => {
    const chain = Array.isArray(node.rotationChain) ? node.rotationChain : []
    const last = chain[chain.length - 1]
    return last ? Number(last.seq) : -1
  }
  // Room events carry the signing device's rotation seq so a signature can be
  // matched to the key epoch that produced it (ADR-0031). Older events without
  // the field still verify; the field is inside the signed canonical payload.
  const signEventWithRotation = (event) => {
    const seq = currentRotationSeq()
    if (seq >= 0) event.rotationSeq = seq
    return signRoomEvent(event, node.identity?.edPrivate)
  }
  // In strict mode the event must carry the origin's current epoch; the default
  // audit mode accepts historical events signed before a rotation.
  const verifyRoomEventWithMode = (event) => {
    if (!event?.signature) return false
    const publicKey = event.origin === node.identity?.deviceId
      ? node.identity?.edPublic
      : node.roster.get(event.origin)?.edPublic
    if (!publicKey || !verifyRoomEvent(event, publicKey)) return false
    if ((runtime.current.room?.rotationSeqMode ?? 'audit') !== 'strict') return true
    const expected = event.origin === node.identity?.deviceId
      ? currentRotationSeq()
      : Number(node.roster.get(event.origin)?.rotationSeq)
    return Number.isInteger(event.rotationSeq) && event.rotationSeq === expected
  }
  const signRemappedEvents = (events, targetRoomId) => events.map((event) => {
    const copy = { ...event, roomId: targetRoomId, signature: null }
    copy.signature = signEventWithRotation(copy)
    return copy
  })
  const roomReplica = new RoomReplicaStore({
    dataDir: state.dataDir,
    deviceId: state.identity?.deviceId ?? null,
    warn: (line) => logger.warn?.(line),
    signEvent: signEventWithRotation,
    verifyEvent: verifyRoomEventWithMode,
    requireSigned: true,
    onTaskEvent: (event) => {
      if (event?.type === 'done' && event.task?.id) policy.revokeTask(event.task.id)
    },
  })
  const migratedRooms = roomReplica.migrateFromRooms(rooms)
  if (migratedRooms > 0) logger.info?.(`[device-fleet] imported ${migratedRooms} legacy Room(s) into room replicas`)
  rooms.setReplicaStore(roomReplica)
  const repairedCreators = rooms.backfillCreatorMetadata()
  if (repairedCreators > 0) logger.info?.(`[device-fleet] backfilled creator metadata for ${repairedCreators} Room(s)`)
  const compactedRooms = roomReplica.autoCompact({ minEvents: Number(config.replica?.autoCompactMinEvents) || Number(process.env.DSH_FLEET_AUTO_COMPACT_EVENTS) || 800 })
  if (compactedRooms.length > 0) logger.info?.(`[device-fleet] auto-compacted ${compactedRooms.length} Room replica(s)`)
  const repairedRooms = roomReplica.repairForeignBootstrapSnapshots(rooms)
  if (repairedRooms > 0) logger.warn?.(`[device-fleet] repaired ${repairedRooms} Room replica(s) after foreign bootstrap snapshot`)
  let compactedSnapshots = 0
  for (const room of rooms.rooms.values()) compactedSnapshots += roomReplica.compactSnapshots(room.roomId)
  if (compactedSnapshots > 0) logger.info?.(`[device-fleet] compacted ${compactedSnapshots} superseded Room snapshot event(s)`)
  let resignedEvents = 0
  for (const room of rooms.rooms.values()) resignedEvents += roomReplica.resignLocalEvents(room.roomId)
  if (resignedEvents > 0) logger.info?.(`[device-fleet] re-signed ${resignedEvents} local Room event(s)`)
  let compactedEvents = 0
  for (const room of rooms.rooms.values()) compactedEvents += roomReplica.compactEvents(room.roomId, { minEvents: 800 })
  if (compactedEvents > 0) logger.info?.(`[device-fleet] GC compacted ${compactedEvents} Room event(s)`)
  const roomSync = new RoomReplicaSync({
    replica: roomReplica,
    node,
    warn: (line) => logger.warn?.(line),
  })
  // Mirror replicas pull authority events while their Room view is open. This is
  // Phase 2's first live sync trigger; writes remain on the old bridge until
  // Phase 3.
  const mirrorSyncs = new Set()
  /** roomId -> last authority vector clock seen, for pending/status display. */
  const mirrorAuthorityClocks = new Map()
  // Legacy rooms were imported as `legacy` events, which vector clocks ignore.
  // A one-time snapshot bootstrap closes that old-history gap; after the mirror
  // count catches up the usual event pull keeps it fresh.
  const bootstrapMirrorSnapshot = async (localRoomId, authority) => {
    try {
      const snapshot = await node.request(authority.deviceId, 'room.snapshot', { roomId: authority.roomId }, { timeoutMs: 15_000 })
      if (!snapshot || !Array.isArray(snapshot.messages)) return 0
      const local = roomReplica.state(localRoomId)
      if (snapshot.messages.length <= local.messages.length && snapshot.members?.length === local.members.length) return 0
      roomReplica.append({
        roomId: localRoomId,
        type: 'room.snapshot',
        author: { kind: 'system', source: 'legacy-bootstrap' },
        payload: { snapshot: { ...snapshot, roomId: localRoomId } },
        localOnly: true,
      })
      return 1
    } catch (error) {
      logger.warn?.(`[device-fleet] mirror snapshot bootstrap failed: ${String(error?.message ?? error)}`)
      return 0
    }
  }
  const syncMirrorWithPeer = async (localRoomId, room, remoteDeviceId) => {
    if (!room?.mirror || !remoteDeviceId || remoteDeviceId === room.mirror.deviceId || remoteDeviceId === node.identity.deviceId) return 0
    const authorityRoomId = room.mirror.roomId
    const hello = await node.request(remoteDeviceId, 'room.sync.hello', { roomId: authorityRoomId }, { timeoutMs: 10_000 })
    if (!hello?.exists) return 0
    const localClock = roomReplica.vectorClock(localRoomId)
    const pulled = await node.request(remoteDeviceId, 'room.sync.pull', { roomId: authorityRoomId, have: localClock, roomKey: room.key }, { timeoutMs: 15_000 })
    const imported = roomReplica.importEvents(localRoomId, pulled?.events ?? [], { sourceRoomId: authorityRoomId })
    const pending = roomReplica.eventsMissingFor(localRoomId, hello.vectorClock ?? {})
    if (pending.length > 0) {
      const events = remapReplicaEventsForSync({
        events: pending,
        targetRoomId: authorityRoomId,
        localRoomId,
        localDeviceId: node.identity?.deviceId,
        signEvent: signEventWithRotation,
      })
      await node.request(remoteDeviceId, 'room.sync.push', { roomId: authorityRoomId, events, roomKey: room.key }, { timeoutMs: 15_000 })
    }
    return imported
  }
  const syncMirrorPeers = async (localRoomId, room) => {
    if (!room?.mirror) return
    const peers = [...new Set([...room.members.values()]
      .filter((member) => member.deviceId && member.deviceId !== room.mirror.deviceId && member.deviceId !== node.identity?.deviceId)
      .map((member) => member.deviceId))]
    for (const deviceId of peers) {
      if (!node.peerIds().includes(deviceId)) {
        try {
          await node.connect(deviceId)
        } catch {
          continue
        }
      }
      try {
        await syncMirrorWithPeer(localRoomId, room, deviceId)
      } catch (error) {
        logger.warn?.(`[device-fleet] peer mirror sync failed (${deviceId}): ${String(error?.message ?? error)}`)
      }
    }
  }
  const syncMirrorReplica = (roomId) => {
    const room = rooms.rooms.get(roomId)
    if (!room?.mirror || mirrorSyncs.has(roomId)) return
    mirrorSyncs.add(roomId)
    void (async () => {
      try {
        const authority = room.mirror
        const hello = await node.request(authority.deviceId, 'room.sync.hello', { roomId: authority.roomId }, { timeoutMs: 10_000 })
        if (!hello?.exists) return
        if (hello.roomKey && room.key !== hello.roomKey) {
          room.key = hello.roomKey
          rooms.persist()
        }
        mirrorAuthorityClocks.set(roomId, hello.vectorClock ?? {})
        const localClock = roomReplica.vectorClock(roomId)
        const response = await node.request(authority.deviceId, 'room.sync.pull', { roomId: authority.roomId, have: localClock, roomKey: room.key }, { timeoutMs: 15_000 })
        const remoteEvents = response?.events ?? []
        if (remoteEvents.length > 0) roomReplica.importEvents(roomId, remoteEvents, { sourceRoomId: authority.roomId })
        await bootstrapMirrorSnapshot(roomId, authority)
        await syncMirrorPeers(roomId, room)
        // Publish locally-authored mirror events to the authority.
        const pending = roomReplica.eventsMissingFor(roomId, hello.vectorClock)
        if (pending.length > 0) {
          await node.request(
            authority.deviceId,
            'room.sync.push',
            { roomId: authority.roomId, events: signRemappedEvents(pending, authority.roomId), roomKey: room.key },
            { timeoutMs: 15_000 },
          )
        }
        const state = roomReplica.state(roomId)
        if (state.createdAt) {
          rooms.applyMirrorSnapshot({
            roomId,
            snapshot: {
              createdAt: state.createdAt,
              policy: state.policy,
              members: state.members,
              messages: state.messages,
              tasks: state.tasks,
              creatorMemberId: state.creatorMemberId,
              creatorDeviceId: state.creatorDeviceId,
              coordinatorDeviceId: state.coordinatorDeviceId,
              hostSessionId: state.hostSessionId,
              closed: state.closed,
            },
          })
          const selfMember = state.members.find((member) => member.remoteSessionId === roomId || member.sessionId === roomId)
          if (selfMember) {
            await remoteRoomPeer.backfill({
              sessionId: roomId,
              roomId: authority.roomId,
              messages: state.messages,
              members: state.members,
              tasks: state.tasks,
              hostDeviceId: authority.deviceId,
            })
          }
        }
      } catch (error) {
        logger.warn?.(`[device-fleet] mirror replica sync failed: ${String(error?.message ?? error)}`)
      } finally {
        mirrorSyncs.delete(roomId)
      }
    })()
  }
  const remoteRoomBridge = new RemoteRoomBridge({
    node,
    rooms,
    timeoutMs: config.execution?.delegateTimeoutMs ?? 120_000,
    warn: (line) => logger.warn?.(line),
  })
  const remoteRoomPeer = new RemoteRoomPeer({
    sessionController,
    createUserMessage,
    node,
    rooms,
    config: config.execution ?? {},
    dataDir: state.dataDir,
    warn: (line) => logger.warn?.(line),
  })
  // Cold start: apply() may run before Cordis composes sessionController.
  // Re-resolve it on demand and keep the Room services pointed at the live one.
  const resolveSessionController = () => {
    if (!sessionController) sessionController = service('sessionController')
    if (sessionController) {
      if (rooms.sessionController !== sessionController) rooms.sessionController = sessionController
      if (remoteRoomPeer.sessionController !== sessionController) remoteRoomPeer.sessionController = sessionController
    }
    return sessionController
  }

  // Recover participant routing for mirrors persisted by this device.
  remoteRoomPeer.hydrateFromRooms(rooms)
  // Prune mirrors whose local participant no longer exists (e.g. a leave that
  // happened before the cleanup fix). This runs async after startup.
  void (async () => {
    for (const room of [...rooms.rooms.values()]) {
      if (!room.mirror) continue
      const hasSelf = [...room.members.values()].some((member) => member.sessionId === room.roomId || member.remoteSessionId === room.roomId)
      if (hasSelf) continue
      try {
        await rooms.close({ roomId: room.roomId, reason: 'orphan mirror without local participant' })
        roomReplica.removeReplica(room.roomId)
      } catch (error) {
        logger.warn?.(`[device-fleet] cannot prune orphan mirror ${room.roomId}: ${String(error?.message ?? error)}`)
      }
    }
  })()
  const acceptInvite = async ({ code, name = 'remote' } = {}) => {
    const invite = decodeRoomInvite(code)
    if (!invite.deviceId) throw Object.assign(new Error('invite does not name the authority device'), { code: 'bad-invite' })
    // Validate the key/expiry before creating any local session/mirror, so a
    // stale invite cannot leave an orphan mirror on this device.
    await node.request(invite.deviceId, 'room.invite.check', { code }, { timeoutMs: 10_000 })
    const joined = await remoteRoomPeer.join({ roomId: invite.roomId, name, hostDeviceId: invite.deviceId })
    const member = await node.request(
      invite.deviceId,
      'room.invite.accept',
      { code, sessionId: joined.sessionId, name },
      { timeoutMs: 20_000 },
    )
    return { text: `joined room ${invite.roomId} as ${member?.memberId ?? joined.sessionId}` }
  }
  // Wake participant sessions that live on this device: a mirror Room must keep
  // working for local participants even when the authority device is offline.
  const wakeLocalMirrorRecipients = async (room, message) => {
    if (!room?.mirror || !Array.isArray(message?.to)) return
    for (const recipientId of message.to) {
      const member = room.members.get(recipientId)
      const sessionId = member?.remoteSessionId ?? member?.sessionId
      if (!sessionId || !remoteRoomPeer.bindings.has(sessionId)) continue
      if (message.from?.memberId === recipientId) continue
      try {
        await remoteRoomPeer.wake({
          roomId: room.mirror.roomId,
          sessionId,
          messageId: message.id,
          from: message.from,
          text: message.text,
          hostDeviceId: room.mirror.deviceId,
          members: [...room.members.values()],
          tasks: [...room.tasks.values()],
        })
      } catch (error) {
        logger.warn?.(`[device-fleet] local mirror wake failed: ${String(error?.message ?? error)}`)
      }
    }
  }
  // Phase 3 local-first mirror publish: the message is already in the local
  // replica/UI; wake local participants and push its event to the authority in
  // the background. A missing authority is not fatal: the event stays pending
  // and the next sync retries it.
  rooms.mirrorPublish = async (room, local) => {
    if (!room?.mirror || !local?.event) return
    await wakeLocalMirrorRecipients(room, local.message)
    try {
      await node.request(
        room.mirror.deviceId,
        'room.sync.push',
        { roomId: room.mirror.roomId, events: signRemappedEvents([{ ...local.event, roomId: room.mirror.roomId }], room.mirror.roomId), roomKey: room.key },
        { timeoutMs: 15_000 },
      )
    } catch (error) {
      logger.warn?.(`[device-fleet] mirror publish failed (will retry on sync): ${String(error?.message ?? error)}`)
    }
    syncMirrorReplica(room.roomId)
  }
  const remoteRoomPeerForSync = remoteRoomPeer
  /** Manual/on-demand Phase 2 replica sync exposed as the room_sync tool. */
  const syncRoomNow = async ({ roomId = null, sessionId = null } = {}) => {
    let localRoomId = typeof roomId === 'string' && roomId !== '' ? roomId : null
    let room = localRoomId ? rooms.rooms.get(localRoomId) : null
    if (!room && sessionId) {
      const binding = remoteRoomPeerForSync.bindings.get(sessionId)
      if (binding) {
        localRoomId = binding.sessionId
        room = rooms.rooms.get(localRoomId)
      }
    }
    if (!room) throw Object.assign(new Error('this session is not attached to a local Room replica'), { code: 'bad-request' })
    if (room.mirror) {
      const localClock = roomReplica.vectorClock(localRoomId)
      const hello = await node.request(room.mirror.deviceId, 'room.sync.hello', { roomId: room.mirror.roomId }, { timeoutMs: 10_000 })
      if (hello?.roomKey && room.key !== hello.roomKey) {
        room.key = hello.roomKey
        rooms.persist()
      }
      if (hello?.vectorClock) mirrorAuthorityClocks.set(localRoomId, hello.vectorClock)
      let imported = 0
      if (hello?.exists) {
        const response = await node.request(room.mirror.deviceId, 'room.sync.pull', { roomId: room.mirror.roomId, have: localClock, roomKey: room.key }, { timeoutMs: 15_000 })
        const remoteEvents = response?.events ?? []
        imported = remoteEvents.length > 0 ? roomReplica.importEvents(localRoomId, remoteEvents, { sourceRoomId: room.mirror.roomId }) : 0
      }
      imported += await bootstrapMirrorSnapshot(localRoomId, room.mirror)
      // Retry local mirror events that the authority has not acknowledged yet.
      const pending = roomReplica.eventsMissingFor(localRoomId, hello?.vectorClock ?? {})
      if (pending.length > 0) {
        await node.request(
          room.mirror.deviceId,
          'room.sync.push',
          { roomId: room.mirror.roomId, events: signRemappedEvents(pending, room.mirror.roomId), roomKey: room.key },
          { timeoutMs: 15_000 },
        )
      }
      const state = roomReplica.state(localRoomId)
      if (state.createdAt) {
        rooms.applyMirrorSnapshot({
          roomId: localRoomId,
          snapshot: {
            createdAt: state.createdAt,
            policy: state.policy,
            members: state.members,
            messages: state.messages,
            tasks: state.tasks,
            creatorMemberId: state.creatorMemberId,
            creatorDeviceId: state.creatorDeviceId,
            coordinatorDeviceId: state.coordinatorDeviceId,
            hostSessionId: state.hostSessionId,
            closed: state.closed,
          },
        })
        const selfMember = state.members.find((member) => member.remoteSessionId === localRoomId || member.sessionId === localRoomId)
        if (selfMember) {
          await remoteRoomPeer.backfill({
            sessionId: localRoomId,
            roomId: room.mirror.roomId,
            messages: state.messages,
            members: state.members,
            tasks: state.tasks,
            hostDeviceId: room.mirror.deviceId,
          })
        }
      }
      return { text: `mirror sync room=${localRoomId}: imported=${imported} messages=${state.messages.length} seq=${state.lastSeq}` }
    }
    const members = rooms.status(localRoomId).members
    const peers = [...new Set(members.filter((member) => member.kind === 'remote' && member.deviceId).map((member) => member.deviceId))]
    const result = await roomSync.syncRoom({ roomId: localRoomId, peers, force: true })
    const state = roomReplica.state(localRoomId)
    return { text: `sync room=${localRoomId}: peers=${peers.length} pulled=${result.pulled} pushed=${result.pushed} messages=${state.messages.length} seq=${state.lastSeq}` }
  }
  // Assistant output from a bound remote participant session becomes a Room
  // reply on the Host device.
  ctx.effect(() => ctx.on?.('session/event', (session, event) => remoteRoomPeer.handleSessionEvent(session, event)))
  ctx.effect(() => ctx.on?.('session/event', (session, event) => trajectoryStore.record(session?.id, event)))
  // User input is routed to a Room only while its Conversation View is open;
  // normal Chat with the host agent must not wake participants. Focus expires so
  // a hidden/unmounted view cannot leave a stale route.
  const focusedRooms = new Map()
  const ROOM_FOCUS_TTL_MS = 20_000
  // In-memory ring buffer of network warnings for connection diagnostics
  // (`/device-fleet/overview.warnings`); not persisted.
  const recentWarnings = []
  const wakeMemberSeen = new Set()

  // Client approval panel data plane (dev.9). webServer activates independently
  // of this plugin, so wait for the service instead of sampling it at apply time
  // (sampling was why the HTTP routes silently disappeared and the Room dock
  // could not load after a restart).
  const workspaceDir = join(state.dataDir, 'workspace')
  const getOptions = async () => {
    const addresses = new Set(['0.0.0.0', '127.0.0.1', runtime.current.direct?.host ?? ''])
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) addresses.add(entry.address)
      }
    }
    addresses.delete('')
    let toolNames = []
    try {
      toolNames = (ctx.tools.definitions?.() ?? []).map((definition) => definition.name)
    } catch {
      toolNames = []
    }
    const shellCandidates = ['pwsh', 'bash', 'cmd', 'sh']
    let shells = shellCandidates.filter((name) => toolNames.includes(name))
    if (shells.length === 0) shells = [process.platform === 'win32' ? 'pwsh' : 'bash']
    let presets = []
    try {
      presets = (await agentPresets?.list?.()) ?? []
    } catch {
      presets = []
    }
    return {
      platform: process.platform,
      addresses: [...addresses],
      shells,
      subagentProviders: (() => {
        try {
          return (subagentsService ?? (subagentsService = service('subagents')))?.list?.() ?? ['spawn']
        } catch {
          return ['spawn']
        }
      })(),
      tools: [...toolNames].sort(),
      presets: presets.map((preset) => ({
        id: preset.id ?? preset.name,
        label: preset.name ?? preset.title ?? preset.id,
      })),
      cwd: {
        workspace: workspaceDir,
        dshHome: process.env.DSH_HOME ?? '',
        defaultDirectory: workingDirectory?.defaultDirectory ?? '',
        current: runtime.current.execution?.cwd ?? '',
      },
    }
  }
  let pairingRef = null
  let overlayStatus = null
  const refreshOverlay = () => {
    void detectOverlay()
      .then((value) => {
        overlayStatus = value
      })
      .catch(() => {})
  }
  refreshOverlay()
  const overlayTimer = setInterval(refreshOverlay, 60_000)
  overlayTimer.unref?.()
  ctx.effect(() => () => clearInterval(overlayTimer))
  /** Durable revocations for offline targets; retried on peer connect/idle. */
  const pendingScopeRevocations = new ScopeRevocationQueue({ file: join(state.dataDir, 'pending-scope-revocations.json') })
  const callLedger = new CallLedger({ file: join(state.dataDir, 'call-ledger.jsonl') })
  const outbox = new Outbox({ file: join(state.dataDir, 'outbox.json') })
  const trajectoryStore = new TrajectoryStore({ file: join(state.dataDir, 'trajectory.jsonl') })
  const recordCall = (entry) => {
    try {
      callLedger.record(entry)
    } catch {
      /* call history is best effort */
    }
  }
  const flushScopeRevocations = async (deviceId) => {
    for (const entry of pendingScopeRevocations.listFor(deviceId)) {
      try {
        await node.request(deviceId, 'room.grant.revoke', {
          roomId: entry.roomId ?? null,
          taskId: entry.taskId ?? null,
          kind: entry.kind,
        }, { timeoutMs: 3_000 })
        pendingScopeRevocations.remove(entry.key)
      } catch (error) {
        logger.warn?.(`[device-fleet] scope revoke retry failed on ${deviceId}: ${String(error?.message ?? error)}`)
      }
    }
  }
  const queueScopeRevocation = (deviceId, kind, payload) => {
    pendingScopeRevocations.add({ deviceId, kind, ...payload })
    void flushScopeRevocations(deviceId)
  }
  const remoteMemberTargets = (roomId) => {
    const room = rooms.rooms.get(roomId)
    if (!room) return []
    return [...new Set([...room.members.values()]
      .filter((member) => member.kind === 'remote' && typeof member.deviceId === 'string' && member.deviceId !== '' && member.deviceId !== node.identity?.deviceId)
      .map((member) => member.deviceId))]
  }
  /** Revoke a task-scoped grant locally and on every remote Room member. */
  const revokeTaskEverywhere = (roomId, taskId) => {
    if (typeof taskId !== 'string' || taskId === '') return
    policy.revokeTask(taskId)
    for (const deviceId of remoteMemberTargets(roomId)) queueScopeRevocation(deviceId, 'task', { roomId, taskId })
  }
  /** Revoke a Room-scoped grant locally and on every remote Room member. */
  const revokeRoomEverywhere = (roomId) => {
    if (typeof roomId !== 'string' || roomId === '') return
    policy.revokeRoom(roomId)
    for (const deviceId of remoteMemberTargets(roomId)) queueScopeRevocation(deviceId, 'room', { roomId })
  }

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    ctx.effect(() =>
      registerAvatarRoutes({
        webServer,
        dir: fileURLToPath(new URL('../../assets/avatars/', import.meta.url)),
        libraryDir: join(state.dataDir, 'avatars'),
        logger,
      }),
    )
    ctx.effect(() => registerApprovalRoutes({ webServer, inbox, logger }))
    ctx.effect(() =>
      registerConfigRoutes({
        webServer,
        runtime,
        getOptions,
        preparePatch: async (patch) => {
          const cwd = patch?.execution?.cwd
          if (typeof cwd === 'string' && cwd !== '') {
            try {
              mkdirSync(cwd, { recursive: true })
            } catch (error) {
              logger.warn?.(`[device-fleet] cannot create execution cwd: ${String(error?.message ?? error)}`)
            }
          }
          return patch
        },
        logger,
      }),
    )
  const uiActions = {
      async sendRoomMessage({ roomId, to, text } = {}) {
        if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
        const memberIds = rooms.status(roomId).members.map((member) => member.memberId)
        const hostMemberId = `host:${roomId}`
        const defaultRecipients = memberIds.filter((id) => id !== hostMemberId)
        const recipients = Array.isArray(to) && to.length > 0 ? to : defaultRecipients.length > 0 ? defaultRecipients : [hostMemberId]
        const result = await rooms.send({ roomId, from: { kind: 'user' }, to: recipients, text })
        void remoteRoomBridge.syncMirrors(roomId).catch((error) => logger.warn?.(`[device-fleet] mirror sync fan-out failed: ${String(error?.message ?? error)}`))
        return { roomId, ...result }
      },
      async roomTask({ roomId, action, ...rest } = {}) {
        if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
        if (action === 'add') {
          return rooms.addTask({ roomId, title: rest.title, owner: rest.owner, dependsOn: rest.dependsOn ?? [], description: rest.description ?? '' })
        }
        if (action === 'update') {
          const result = await rooms.updateTask({ roomId, id: rest.id, status: rest.status, owner: rest.owner, note: rest.note })
          if (rest.status === 'done') revokeTaskEverywhere(roomId, rest.id)
          return result
        }
        throw Object.assign(new Error('action must be add or update'), { code: 'bad-request' })
      },
      closeRoom: ({ roomId, reason } = {}) => {
        revokeRoomEverywhere(roomId)
        return rooms.close({ roomId, reason: reason ?? 'closed by user' })
      },
      async roomDetail({ roomId } = {}) {
        if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
        const room = rooms.rooms.get(roomId)
        if (room?.mirror) {
          // Phase 2: mirror replicas sync authority events in the background and
          // render from the local replica; fall back to the cached mirror snapshot
          // while the first sync is in flight.
          syncMirrorReplica(roomId)
          const mirrorState = roomReplica.state(roomId)
          if (mirrorState?.createdAt && mirrorState.lastSeq > 0) {
            const clock = mirrorAuthorityClocks.get(roomId) ?? {}
            const pending = roomReplica.eventsMissingFor(roomId, clock)
            return {
              ...mirrorState,
              title: room?.title ?? mirrorState.title ?? friendlyName(roomId),
              archived: roomReplica.index?.rooms?.[roomId]?.archived === true,
              messageCount: mirrorState.messages.length,
              sync: {
                role: 'mirror',
                pending: pending.length,
                lastSeq: mirrorState.lastSeq,
                pendingEvents: pending.slice(-20).map((event) => ({
                  id: event.id,
                  type: event.type,
                  origin: event.origin,
                  createdAt: event.createdAt,
                })),
              },
            }
          }
          return rooms.detail(roomId, { limit: 100 })
        }
        // Phase 1 read path: authority Rooms render from the local replica event
        // log; the in-memory RoomService remains the write-through source.
        const replicaState = roomReplica.state(roomId)
        if (replicaState?.createdAt && replicaState.lastSeq > 0) {
          return {
            ...replicaState,
            title: room?.title ?? replicaState.title ?? friendlyName(roomId),
            archived: roomReplica.index?.rooms?.[roomId]?.archived === true,
            messageCount: replicaState.messages.length,
            sync: { role: 'authority', pending: 0, lastSeq: replicaState.lastSeq, pendingEvents: [] },
          }
        }
        return rooms.detail(roomId, { limit: 100 })
      },
      async createRoomInvite({ roomId } = {}) {
        if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
        return { code: rooms.createInvite({ roomId }) }
      },
      async removeDevice({ roomId, deviceId } = {}) {
        if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
        if (typeof deviceId !== 'string' || deviceId === '') throw Object.assign(new Error('deviceId is required'), { code: 'bad-request' })
        return rooms.removeDeviceMembers({ roomId, deviceId })
      },
      archiveRoom: ({ roomId, archived } = {}) => {
        if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
        roomReplica.archiveReplica(roomId, archived !== false)
        return { roomId, archived: roomReplica.index?.rooms?.[roomId]?.archived === true }
      },
      async restoreRoom({ roomId } = {}) {
        return restoreRoom({ roomId })
      },
      async deleteRoom({ roomId } = {}) {
        if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
        const room = rooms.rooms.get(roomId)
        if (room) {
          try {
            await rooms.close({ roomId, reason: 'deleted by user' })
          } catch {
            /* already gone */
          }
        }
        remoteRoomPeer.releaseSession(roomId)
        roomReplica.removeReplica(roomId)
        return { roomId, deleted: true }
      },
      gcRoom: ({ roomId, minEvents } = {}) => {
        if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
        const localRoomId = rooms.rooms.get(roomId)?.roomId ?? roomId
        const removed = roomReplica.compactEvents(localRoomId, { minEvents: Number(minEvents) || 400 })
        return { roomId, removed, events: roomReplica.loadEvents(localRoomId).length }
      },
      async getCalls({ limit } = {}) {
        return { calls: await collectCalls(limit) }
      },
      async getTrajectory({ deviceId, sessionId } = {}) {
        return { trajectory: await collectTrajectory({ deviceId, sessionId }) }
      },
      joinFleet: async ({ code } = {}) => {
        if (!pairingRef?.join) throw Object.assign(new Error('pairing is unavailable'), { code: 'unsupported' })
        if (typeof code !== 'string' || code.trim() === '') throw Object.assign(new Error('invite code is required'), { code: 'bad-request' })
        await pairingRef.join(code.trim())
        return { queued: true }
      },
      setCoordinator: async ({ roomId, deviceId } = {}) => {
        if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
        if (typeof deviceId !== 'string' || deviceId === '') throw Object.assign(new Error('deviceId is required'), { code: 'bad-request' })
        return rooms.updateCoordinator({ roomId, deviceId })
      },
      updateAuthority: async ({ roomId, authorityDeviceId, authorityRoomId, epoch } = {}) => {
        if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
        if (typeof authorityDeviceId !== 'string' || authorityDeviceId === '') throw Object.assign(new Error('authorityDeviceId is required'), { code: 'bad-request' })
        return rooms.updateAuthority({ roomId, authorityDeviceId, authorityRoomId, epoch: epoch === undefined ? undefined : Number(epoch) })
      },
      async removeFleetDevice(args = {}) {
        return removeFleetDevice(args)
      },
      async revokeFleetDevice(args = {}) {
        return revokeFleetDevice(args)
      },
      async resolveRotationFork(args = {}) {
        return resolveRotationFork(args)
      },
      async trustRotationCheckpoint(args = {}) {
        return trustRotationCheckpoint(args)
      },
      async compactRotation(args = {}) {
        return compactRotation(args)
      },
      async rotateIdentity() {
        return rotateIdentity()
      },
      async resetIdentity(args = {}) {
        return resetIdentity(args)
      },
      async dismissRevocation({ deviceId } = {}) {
        if (typeof deviceId !== 'string' || deviceId === '') throw Object.assign(new Error('deviceId is required'), { code: 'bad-request' })
        return node.dismissRevocation(deviceId)
      },
      async addRemoteMember({ roomId, deviceId, name } = {}) {
        if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
        if (typeof deviceId !== 'string' || deviceId === '') throw Object.assign(new Error('deviceId is required'), { code: 'bad-request' })
        const connected = typeof node.peerIds === 'function' ? node.peerIds() : []
        if (!connected.includes(deviceId)) throw Object.assign(new Error('target device is offline; connect it first'), { code: 'peer-offline' })
        return remoteRoomBridge.addRemoteMember({ roomId, deviceId, name: typeof name === 'string' && name !== '' ? name : 'remote' })
      },
      setRoomFocus: ({ roomId, focused } = {}) => {
        if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
        if (focused === true) focusedRooms.set(roomId, Date.now())
        else focusedRooms.delete(roomId)
        return { roomId, focused: focused === true }
      },
      removeMember: ({ roomId, memberId, reason } = {}) => rooms.removeMember({ roomId, memberId, reason: reason ?? 'removed by user' }),
      async upgradeRoom({ sessionId } = {}) {
        if (typeof sessionId !== 'string' || sessionId === '') throw Object.assign(new Error('sessionId is required'), { code: 'bad-request' })
        const controller = resolveSessionController()
        if (!controller?.resolveAgent) throw Object.assign(new Error('session agent is unavailable'), { code: 'unsupported' })
        const resolved = await controller.resolveAgent(sessionId)
        if (!resolved?.agent) throw Object.assign(new Error('session agent is unavailable'), { code: 'unsupported' })
        return rooms.upgradeHost({ agent: resolved.agent })
      },
      createInvite: async () => {
        if (!pairingRef?.invite) throw Object.assign(new Error('pairing is unavailable'), { code: 'unsupported' })
        const invite = await pairingRef.invite()
        const code = typeof invite === 'string' ? invite : invite?.code
        return { code, expiresAt: typeof invite === 'object' && invite ? invite.expiresAt ?? null : null }
      },
      connectAddress: async ({ host, port } = {}) => {
        if (typeof host !== 'string' || !Number.isInteger(port) || port <= 0) {
          throw Object.assign(new Error('host and port are required'), { code: 'bad-request' })
        }
        const peer = await node.connectAddress(host, port)
        try {
          savePeerHint(state, { host, port })
        } catch {
          /* best effort */
        }
        return { deviceId: peer.deviceId, name: peer.name ?? 'device' }
      },
    }
    ctx.effect(() =>
      registerUiRoutes({
        webServer,
        inbox,
        rooms,
        notifications,
        logger,
        actions: uiActions,
        getOverview: () => ({
          ...(node.status?.() ?? {}),
          overlay: overlayStatus,
          rooms: rooms.list(),
          archivedRooms: (() => {
            const active = new Set(rooms.rooms.keys())
            return roomReplica
              .roomIndex()
              .filter((entry) => entry.archived === true)
              .map((entry) => ({
                roomId: entry.roomId,
                title: (() => {
                  try {
                    return roomReplica.state(entry.roomId)?.title ?? friendlyName(entry.roomId)
                  } catch {
                    return friendlyName(entry.roomId)
                  }
                })(),
                lastSeq: entry.lastSeq ?? 0,
                updatedAt: entry.updatedAt ?? null,
                inMemory: active.has(entry.roomId),
              }))
          })(),
          approvals: inbox.list(),
          approvalHistory: inbox.history?.() ?? [],
          notifications: notifications.list({ limit: 50 }),
          notificationsUnread: notifications.unreadCount(),
          warnings: recentWarnings,
        }),
      }),
    )
  })
  const initialSessionControllerAvailable = Boolean(sessionController)
  if (!initialSessionControllerAvailable) {
    recordHostDiagnostic('execution-host-deferred', { phase: 'apply' })
  }

  let slot = null
  let delegation = null
  let host = null
  let hostRecoveredLogged = false
  let lastHostUnavailableDiagnosticAt = 0

  const lazyExecution = createLazyExecutionHost({
    getSessionController: resolveSessionController,
    build: (controller) => {
      slot = new ExecutionSlot({
        sessionController: controller,
        tools: ctx.tools,
        config: runtime.current.execution,
      })
      const subagentsNow = subagentsService ?? (subagentsService = service('subagents'))
      if (subagentsNow) {
        delegation = new DelegationHost({
          subagents: subagentsNow,
          slot,
          policy,
          deviceId: state.identity.deviceId,
          defaultCwd: runtime.current.execution?.cwd,
          defaultAgentPreset: runtime.current.execution?.agentPreset,
          provider: runtime.current.execution?.subagentProvider ?? 'spawn',
          timeoutMs: runtime.current.execution?.delegateTimeoutMs ?? 180_000,
          requestApproval,
          onChild: (childId, fromDeviceId) => trajectoryStore.setOwner(childId, fromDeviceId),
        })
      }
      host = new DirectCallHost({
        slot,
        policy,
        fs: fsService ?? (fsService = service('fs')),
        deviceId: state.identity.deviceId,
        name: runtime.current.deviceName,
        pluginVersion,
        dshVersion,
        capabilities: CAPABILITIES,
        shellTool: runtime.current.execution?.shellTool ?? DEFAULT_SHELL_TOOL,
        approvalTimeoutMs: runtime.current.execution?.approvalTimeoutMs ?? 60_000,
        delegation,
        requestApproval,
        onCall: recordCall,
      })
      return { slot, delegation, host, sessionController: controller }
    },
  })

  const ensureExecutionHost = ({ method } = {}) => {
    const built = lazyExecution.get({ method })
    if (built) {
      if (!initialSessionControllerAvailable && !hostRecoveredLogged) {
        hostRecoveredLogged = true
        recordHostDiagnostic('execution-host-recovered', { method: method ?? 'direct-call' }, 'info')
      }
      return built.host
    }
    const now = Date.now()
    if (now - lastHostUnavailableDiagnosticAt > 30_000) {
      lastHostUnavailableDiagnosticAt = now
      recordHostDiagnostic('execution-host-unavailable', { method: method ?? 'direct-call' })
    }
    return null
  }

  if (initialSessionControllerAvailable) {
    try {
      lazyExecution.get({ method: 'apply' })
    } catch (error) {
      recordHostDiagnostic('execution-host-build-failed', { phase: 'apply', error: String(error?.message ?? error) })
    }
  }

  // Mirror the normal DSH approval behavior for tools executed in the hidden
  // Execution Slot: the tool pipeline asks here when its own pre-execute policy
  // requires approval, and this device's approval inbox answers.
  ctx.effect(() => {
    const handler = async (request, next) => {
      try {
        const activeSlot = slot
        if (!activeSlot) return next()
        if (request?.signal?.aborted) return 'cancelled'
        if (!activeSlot.sessionId || request?.agent?.session?.id !== activeSlot.sessionId) return next()
        const toolName = typeof request?.toolName === 'string' ? request.toolName : 'tool'
        const outcome = await inbox.request({
          fromDeviceId: 'local-tool-pipeline',
          capability: 'tool',
          tool: toolName,
          reason: request?.displayReason ?? request?.reason ?? `tool "${toolName}" requires approval`,
          args: {},
        })
        if (outcome.approved === true) return 'allowed-once'
        if (outcome.reason === 'inbox-closed') return 'cancelled'
        return 'rejected'
      } catch {
        return next()
      }
    }
    return ctx.on('approval/request', handler)
  })

  // A Room reuses the normal DSH composer: every user message in a Room Host
  // session is logged as a Room message. `@name` addresses specific members;
  // without mentions it goes to every participant. Host itself already has the
  // message as normal Chat input, so it is never re-woken.
  ctx.effect(() =>
    ctx.on?.('session/event', (session, event) => {
      try {
        if (!session?.id || event?.type !== 'user/message') return
        const room = rooms.rooms.get(session.id)
        if (!room) return
        if (!focusedRooms.has(session.id)) return
        if (Date.now() - focusedRooms.get(session.id) > ROOM_FOCUS_TTL_MS) {
          focusedRooms.delete(session.id)
          return
        }
        const message = event.data
        if (message?.source?.kind && message.source.kind !== 'user') return
        const text = (Array.isArray(message?.content) ? message.content : [])
          .filter((block) => block?.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim()
        if (text === '' || text.startsWith('[Room]') || text.startsWith('[Fleet Room')) return
        const members = rooms.status(session.id).members
        const hostMemberId = `host:${session.id}`
        const participants = members.filter((member) => member.role !== 'host')
        const mentioned = members.filter((member) => member.name && text.includes('@' + member.name))
        const recipients = mentioned.length > 0
          ? mentioned.map((member) => member.memberId)
          : participants.map((member) => member.memberId)
        if (recipients.length === 0) return
        let body = text
        for (const member of mentioned) body = body.split('@' + member.name).join('')
        body = body.trim() || '(点名)'
        void rooms.send({
          roomId: session.id,
          from: { kind: 'user' },
          to: recipients,
          text: body,
          skipWakeFor: [hostMemberId],
        }).then(() => remoteRoomBridge.syncMirrors(session.id)).catch((error) => {
          logger.warn?.(`[device-fleet] cannot route room message: ${String(error?.message ?? error)}`)
        })
      } catch (error) {
        logger.warn?.(`[device-fleet] room message routing failed: ${String(error?.message ?? error)}`)
      }
    }),
  )

  // The host agent's own Chat replies are mirrored into the Room transcript as
  // host speech (read-only for participants: recorded, never re-woken).
  ctx.effect(() =>
    ctx.on?.('session/event', (session, event) => {
      try {
        if (!session?.id || event?.type !== 'assistant/message') return
        const room = rooms.rooms.get(session.id)
        if (!room || room.mirror) return
        // Room is additive: host Chat replies are mirrored only while the Room
        // view is focused; normal Chat with the host agent stays private.
        if (!focusedRooms.has(session.id)) return
        const message = event.data
        const text = (Array.isArray(message?.content) ? message.content : [])
          .filter((block) => block?.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim()
        if (text === '') return
        const hostMemberId = `host:${session.id}`
        void rooms.send({
          roomId: session.id,
          from: { sessionId: session.id },
          to: [hostMemberId],
          text,
          skipWakeFor: [hostMemberId],
        }).catch(() => {})
      } catch {
        /* ignore */
      }
    }),
  )

  // Only Room members (or the authority device for a mirror) may sync a Room.
  const findSyncRoom = (roomId) => rooms.rooms.get(roomId) ?? [...rooms.rooms.values()].find((entry) => entry.mirror?.roomId === roomId || entry.authorityRoomId === roomId)
  const assertSyncPeer = (roomId, deviceId) => {
    const room = findSyncRoom(roomId)
    if (!room) throw Object.assign(new Error('unknown room'), { code: 'unknown-room' })
    // A mirror's local host member may not carry a deviceId, and the local
    // device must always be able to sync its own replica.
    if (deviceId === node.identity?.deviceId) return
    const isAuthorityDevice = room.mirror ? room.mirror.deviceId === deviceId : deviceId === node.identity.deviceId
    if (isAuthorityDevice) return
    if ([...room.members.values()].some((member) => member.deviceId === deviceId)) return
    throw Object.assign(new Error(`${String(deviceId)} is not a member of this Room`), { code: 'unauthorized' })
  }
  const assertSyncKey = (roomId, roomKey) => {
    const room = findSyncRoom(roomId)
    if (!room || room.mirror) return
    if (room.key && roomKey !== room.key) throw Object.assign(new Error('room key is invalid'), { code: 'unauthorized' })
  }

  const syncView = (wireRoomId) => {
    const room = findSyncRoom(wireRoomId)
    if (!room) throw Object.assign(new Error('unknown room'), { code: 'unknown-room' })
    return { room, localRoomId: room.roomId, targetRoomId: room.mirror?.roomId ?? room.authorityRoomId ?? room.roomId }
  }
  const remapForWire = (events, view) => remapReplicaEventsForSync({
    events,
    targetRoomId: view.targetRoomId,
    localRoomId: view.localRoomId,
    localDeviceId: node.identity?.deviceId,
    signEvent: signEventWithRotation,
    verifyEvent: (event) => {
      const publicKey = event.origin === node.identity?.deviceId
        ? node.identity?.edPublic
        : node.roster.get(event.origin)?.edPublic
      return publicKey ? verifyRoomEvent(event, publicKey) : false
    },
  })

  node.onRequest(async (request) => {
    resolveSessionController()
    if (request?.method === 'room.sync.hello') {
      const params = request.params ?? {}
      assertSyncPeer(params.roomId, request.deviceId)
      const view = syncView(params.roomId)
      const result = roomSync.hello({ roomId: view.localRoomId })
      result.roomId = params.roomId
      if (view.room.key) result.roomKey = view.room.key
      return result
    }
    if (request?.method === 'room.sync.pull' || request?.method === 'room.sync.push') {
      assertSyncPeer(request.params?.roomId, request.deviceId)
      assertSyncKey(request.params?.roomId, request.params?.roomKey)
    }
    if (request?.method === 'room.sync.pull') {
      const params = request.params ?? {}
      const view = syncView(params.roomId)
      const result = roomSync.pull({ roomId: view.localRoomId, have: params.have ?? {} })
      result.roomId = params.roomId
      result.events = remapForWire(result.events ?? [], view)
      return result
    }
    if (request?.method === 'room.sync.push') {
      const params = request.params ?? {}
      const view = syncView(params.roomId)
      const imported = roomReplica.importEvents(view.localRoomId, params.events ?? [], { sourceRoomId: params.roomId })
      await rooms.applyExternalEvents?.(view.localRoomId, params.events ?? [])
      return { roomId: params.roomId, imported, vectorClock: roomReplica.vectorClock(view.localRoomId) }
    }
    if (request?.method === 'room.authority.claim') {
      const params = request.params ?? {}
      const room = rooms.rooms.get(params.roomId)
      if (!room) throw Object.assign(new Error('unknown room'), { code: 'unknown-room' })
      if (params.authorityDeviceId !== request.deviceId) {
        throw Object.assign(new Error('claim device does not match caller'), { code: 'unauthorized' })
      }
      const isMember = [...room.members.values()].some((member) => member.deviceId === request.deviceId)
      if (!isMember) throw Object.assign(new Error('claiming device is not a Room member'), { code: 'unauthorized' })
      if (Number(params.epoch) <= Number(room.authorityEpoch ?? 0)) return { applied: false, epoch: room.authorityEpoch ?? 0 }
      await rooms.downgradeToMirror({ roomId: room.roomId, authorityDeviceId: params.authorityDeviceId, authorityRoomId: params.authorityRoomId, epoch: params.epoch })
      // The Room creator keeps host priority: a mirror may promote while the
      // host is away, but when the host is back it reclaims with a new epoch.
      // Without this the authority flip-flops on every reconnect.
      let reclaimed = false
      if (room.creatorDeviceId === node.identity.deviceId) {
        try {
          await rooms.promoteMirrorToAuthority({ roomId: room.roomId })
          const updated = rooms.rooms.get(room.roomId)
          if (updated && !updated.mirror) {
            reclaimed = true
            broadcastAuthorityClaim(updated, params.authorityDeviceId)
          }
        } catch (error) {
          logger.warn?.(`[device-fleet] host reclaim failed for ${room.roomId}: ${String(error?.message ?? error)}`)
        }
      }
      return { applied: true, epoch: reclaimed ? (rooms.rooms.get(room.roomId)?.authorityEpoch ?? params.epoch) : params.epoch, reclaimed }
    }
    if (request?.method === 'room.authority.heartbeat') {
      const params = request.params ?? {}
      if (params.deviceId !== request.deviceId) {
        throw Object.assign(new Error('heartbeat device does not match caller'), { code: 'unauthorized' })
      }
      return { accepted: rooms.noteAuthorityHeartbeat({ roomId: params.roomId, deviceId: params.deviceId, epoch: params.epoch }) }
    }
    if (request?.method === 'fleet.rotation.records') {
      const requestedDevice = request.params?.deviceId ?? request.deviceId
      if (requestedDevice !== node.identity?.deviceId) return { deviceId: requestedDevice, records: [], complete: true }
      const page = rotationChainPage(loadRotationChain(), {
        fromSeq: request.params?.fromSeq ?? 0,
        limit: request.params?.limit ?? ROTATION_PAGE_LIMIT,
      })
      return { deviceId: node.identity.deviceId, ...page }
    }
    if (request?.method === 'fleet.rotation') {
      const record = request.params?.record
      if (!record || record.deviceId !== request.deviceId) {
        throw Object.assign(new Error('rotation record is invalid'), { code: 'bad-request' })
      }
      return { applied: node.applyRotation(record) }
    }
    if (request?.method === 'fleet.device.revoke') {
      const record = request.params?.record
      if (!record || typeof record.deviceId !== 'string' || typeof record.revokedBy !== 'string') {
        throw Object.assign(new Error('revocation record is invalid'), { code: 'bad-request' })
      }
      const selfRevocation = record.deviceId === record.revokedBy
      if (selfRevocation) {
        // Only the revoked device itself may announce its own end, on its own channel.
        if (record.revokedBy !== request.deviceId) {
          throw Object.assign(new Error('a self-revocation must come from the revoked device'), { code: 'bad-request' })
        }
        // Applying it closes this very channel: answer first, then apply.
        setTimeout(() => {
          try {
            node.applyRevocation(record, { confirmed: true, source: `self:${request.deviceId}` })
          } catch (error) {
            logger.warn?.(`[device-fleet] self revocation failed: ${String(error?.message ?? error)}`)
          }
        }, 250).unref?.()
        return { status: 'accepted', self: true }
      }
      // Third-party records are relayed between devices; the signature and the
      // revoker's pinned key are checked by applyRevocation, and the result is
      // advisory until this device's user confirms it.
      return node.applyRevocation(record, { confirmed: false, source: `peer:${request.deviceId}` })
    }
    if (request?.method === 'room.invite.check') {
      const invite = rooms.validateInvite({ code: request.params?.code })
      return { roomId: invite.roomId, deviceId: invite.deviceId }
    }
    if (request?.method === 'room.invite.accept') {
      const params = request.params ?? {}
      const invite = rooms.validateInvite({ code: params.code })
      return rooms.addRemoteMember({ roomId: invite.roomId, deviceId: request.deviceId, name: params.name ?? 'remote', sessionId: params.sessionId })
    }
    if (request?.method === 'room.closed') {
      const params = request.params ?? {}
      const room = findSyncRoom(params.roomId)
      if (room) {
        const authorityDevice = room.mirror?.deviceId ?? room.authorityDeviceId ?? room.creatorDeviceId ?? null
        if (authorityDevice !== request.deviceId) {
          throw Object.assign(new Error('only the Room authority may close a replica'), { code: 'unauthorized' })
        }
      }
      const localSessionIds = remoteRoomPeer.handleRoomClosed({ roomId: params.roomId })
      for (const localRoomId of localSessionIds) {
        try {
          await rooms.close({ roomId: localRoomId, reason: 'authority closed the Room' })
        } catch {
          /* already gone */
        }
        roomReplica.removeReplica(localRoomId)
      }
      return { ok: true, cleaned: localSessionIds }
    }
    if (request?.method === 'room.wake.member') {
      const params = request.params ?? {}
      assertSyncPeer(params.roomId, request.deviceId)
      const view = syncView(params.roomId)
      const member = view.room.members.get(params.memberId)
      if (!member || member.kind !== 'local' || member.role === 'host') {
        throw Object.assign(new Error('target is not a local Room participant'), { code: 'unknown-member' })
      }
      const dedupeKey = `${request.deviceId}:${params.roomId}:${params.messageId}:${member.memberId}`
      if (params.messageId && wakeMemberSeen.has(dedupeKey)) return { woken: false, duplicate: true, memberId: member.memberId }
      if (params.messageId) {
        wakeMemberSeen.add(dedupeKey)
        if (wakeMemberSeen.size > 500) wakeMemberSeen.delete(wakeMemberSeen.values().next().value)
      }
      const message = {
        id: typeof params.messageId === 'string' ? params.messageId : `wake-${Date.now()}`,
        roomId: params.roomId,
        from: params.from ?? { kind: 'agent', name: 'fleet' },
        to: [member.memberId],
        text: typeof params.text === 'string' ? params.text : '',
        createdAt: Number.isFinite(params.createdAt) ? params.createdAt : Date.now(),
      }
      const woken = await rooms.wake(view.room, member, message)
      return { woken, memberId: member.memberId }
    }
    if (request?.method === 'room.join') return remoteRoomPeer.join({ ...(request.params ?? {}), hostDeviceId: request.deviceId })
    if (request?.method === 'room.wake') {
      const result = await remoteRoomPeer.wake({ ...(request.params ?? {}), hostDeviceId: request.deviceId })
      const sessionId = result?.sessionId ?? request.params?.sessionId
      if (typeof sessionId === 'string' && sessionId !== '') syncMirrorReplica(sessionId)
      return result
    }
    if (request?.method === 'room.reply') return remoteRoomBridge.recordReply({ fromDeviceId: request.deviceId, ...(request.params ?? {}) })
    if (request?.method === 'fleet.calls.list') {
      // A ledger entry names the peer involved in the call. Only expose entries
      // involving the requesting device; never the whole local call history.
      const deviceId = typeof request.deviceId === 'string' ? request.deviceId : null
      if (!deviceId) return { calls: [] }
      return { calls: callLedger.list({ limit: Number(request.params?.limit) || 100, deviceId }) }
    }
    if (request?.method === 'room.task.done') {
      const params = request.params ?? {}
      if (typeof params.roomId !== 'string' || params.roomId === '') {
        throw Object.assign(new Error('roomId is required for task revocation'), { code: 'bad-request' })
      }
      const room = rooms.rooms.get(params.roomId)
        ?? [...rooms.rooms.values()].find((entry) => entry.mirror?.roomId === params.roomId || entry.authorityRoomId === params.roomId)
      const isMember = room && [...room.members.values()].some((member) => member.deviceId === request.deviceId)
      if (!isMember) throw Object.assign(new Error('only a Room member may revoke its task grants'), { code: 'unauthorized' })
      if (typeof params.taskId === 'string' && params.taskId !== '') policy.revokeTask(params.taskId)
      return { ok: true }
    }
    if (request?.method === 'room.grant.revoke') {
      const params = request.params ?? {}
      if (typeof params.roomId === 'string' && params.roomId !== '') {
        const room = rooms.rooms.get(params.roomId)
          ?? [...rooms.rooms.values()].find((entry) => entry.mirror?.roomId === params.roomId || entry.authorityRoomId === params.roomId)
        const isMember = room && [...room.members.values()].some((member) => member.deviceId === request.deviceId)
        if (!isMember) {
          throw Object.assign(new Error('only a Room member may revoke its grants'), { code: 'unauthorized' })
        }
      } else {
        throw Object.assign(new Error('roomId is required for grant revocation'), { code: 'bad-request' })
      }
      if (typeof params.taskId === 'string' && params.taskId !== '') policy.revokeTask(params.taskId)
      if (typeof params.roomId === 'string' && params.roomId !== '') policy.revokeRoom(params.roomId)
      return { ok: true }
    }
    if (request?.method === 'room.sync') return remoteRoomPeer.sync(request.params ?? {})
    if (request?.method === 'room.snapshot') {
      const roomId = request.params?.roomId
      if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
      assertSyncPeer(roomId, request.deviceId)
      const room = rooms.detail(roomId, { limit: 200 })
      return room
    }
    if (request?.method === 'fleet.rotation.checkpoint_trusted') {
      const params = request.params ?? {}
      if (typeof params.deviceId === 'string' && params.deviceId !== '') {
        const accepted = node.noteCheckpointTrust({ trustedBy: request.deviceId, ...params })
        if (accepted) {
          notifications.push({
            kind: 'checkpoint-trust',
            title: '对端确认了 checkpoint',
            body: `${deviceLabel(request.deviceId)} 确认了 ${deviceLabel(params.deviceId)} 的 seq ${String(params.seq ?? '?')}`,
            data: { trustedBy: request.deviceId ?? null, deviceId: params.deviceId, seq: params.seq ?? null, head: params.head ?? null },
          })
        }
      }
      return { ok: true, advisory: true, accepted: true }
    }
    if (request?.method === 'fleet.session.trajectory') {
      const params = request.params ?? {}
      if (typeof params.sessionId !== 'string' || params.sessionId === '') {
        throw Object.assign(new Error('sessionId is required'), { code: 'bad-request' })
      }
      const owner = trajectoryStore.ownerOf(params.sessionId)
      if (owner !== request.deviceId) {
        throw Object.assign(new Error('this session trajectory is not owned by the caller'), { code: 'unauthorized' })
      }
      const decision = policy.decide({
        capability: 'read',
        tool: 'fleet.session.trajectory',
        args: { sessionId: params.sessionId },
        roomId: params.roomId ?? null,
        taskId: params.taskId ?? null,
      })
      if (decision.decision === 'deny') throw Object.assign(new Error(decision.reason), { code: 'policy-denied' })
      if (decision.decision === 'ask') {
        const outcome = await requestApproval({
          fromDeviceId: request.deviceId,
          capability: 'read',
          tool: 'fleet.session.trajectory',
          args: { sessionId: params.sessionId },
          reason: decision.reason,
          roomId: params.roomId ?? null,
          taskId: params.taskId ?? null,
        })
        if (!outcome?.approved) throw Object.assign(new Error(outcome?.reason ?? 'approval denied'), { code: 'approval-denied' })
        policy.grant(decision.key, { scope: outcome.scope ?? 'once', roomId: outcome.roomId ?? params.roomId, taskId: outcome.taskId ?? params.taskId })
      }
      const trajectory = trajectoryStore.get(params.sessionId)
      if (!trajectory) throw Object.assign(new Error('no trajectory recorded for that session'), { code: 'no-session' })
      return trajectory
    }
    if (request?.method?.startsWith('fleet.file.')) {
      const params = request.params ?? {}
      const method = request.method
      const capability = method === 'fleet.file.put' || method === 'fleet.file.delete'
        ? 'write'
        : method === 'fleet.file.list' ? 'list' : 'fetch'
      const decision = policy.decide({ capability, tool: method, args: { path: params.path }, roomId: params.roomId ?? null, taskId: params.taskId ?? null })
      if (decision.decision === 'deny') throw Object.assign(new Error(decision.reason), { code: 'policy-denied' })
      if (decision.decision === 'ask') {
        const outcome = await requestApproval({
          fromDeviceId: request.deviceId,
          capability,
          tool: method,
          args: { path: params.path, offset: params.offset ?? 0, final: params.final === true, recursive: params.recursive === true },
          reason: decision.reason,
          roomId: params.roomId ?? null,
          taskId: params.taskId ?? null,
        })
        if (!outcome?.approved) throw Object.assign(new Error(outcome?.reason ?? 'approval denied'), { code: 'approval-denied' })
        policy.grant(decision.key, { scope: outcome.scope ?? 'once', roomId: outcome.roomId ?? params.roomId, taskId: outcome.taskId ?? params.taskId })
      }
      switch (method) {
        case 'fleet.file.put':
          return writeTransferChunk({
            filePath: params.path,
            data: params.data,
            offset: params.offset,
            final: params.final === true,
            expectedSha256: params.sha256 ?? null,
          })
        case 'fleet.file.get':
          return readTransferChunk({ filePath: params.path, offset: params.offset, size: params.size })
        case 'fleet.file.stat':
          return statTransferPath({ filePath: params.path })
        case 'fleet.file.list':
          return listTransferTree({ filePath: params.path, recursive: params.recursive === true, maxEntries: params.maxEntries })
        case 'fleet.file.delete':
          return deleteTransferPath({ filePath: params.path, recursive: params.recursive === true })
        default:
          throw Object.assign(new Error(`unsupported file method: ${method}`), { code: 'unsupported' })
      }
    }
    const activeHost = ensureExecutionHost({ method: request?.method })
    if (!activeHost) throw Object.assign(new Error('this device cannot serve direct calls (no execution slot)'), { code: 'unsupported' })
    return activeHost.handleRequest(request)
  })
  node.on('roster', (roster) => {
    try {
      saveRoster(state, roster)
    } catch (error) {
      logger.warn?.(`[device-fleet] cannot persist roster: ${String(error?.message ?? error)}`)
    }
  })
  node.on('peer-rotations', (rotations) => {
    try {
      savePeerRotations(state, rotations)
    } catch (error) {
      logger.warn?.(`[device-fleet] cannot persist peer rotation chains: ${String(error?.message ?? error)}`)
    }
  })
  node.on('rotation-fork', ({ deviceId, fork }) => {
    recordHostDiagnostic('rotation-fork', {
      deviceId,
      seq: fork?.seq ?? null,
      localHead: fork?.localHead ?? null,
      remoteHead: fork?.remoteHead ?? null,
    })
    notifications.push({
      kind: 'rotation-fork',
      title: '设备轮换链分叉',
      body: `${deviceLabel(deviceId)} 的 seq ${String(fork?.seq)} 与本地不一致，自动更新已暂停`,
      data: { deviceId, seq: fork?.seq ?? null },
    })
  })
  node.on('revocation-pending', ({ deviceId, record, source }) => {
    recordHostDiagnostic('revocation-pending', {
      deviceId,
      by: record?.revokedBy ?? null,
      seq: record?.revokedSeq ?? null,
      source,
    })
    notifications.push({
      kind: 'revocation-pending',
      title: '对方声明吊销一台设备',
      body: `${deviceLabel(record?.revokedBy)} 声明 ${deviceLabel(deviceId)} 已被吊销，需本机确认`,
      data: { deviceId, by: record?.revokedBy ?? null, reason: record?.reason ?? '' },
    })
  })
  node.on('device-revoked', ({ deviceId, record, source }) => {
    logger.warn?.(`[device-fleet] device ${deviceId} is revoked by the local Fleet user (${source})`)
    notifications.push({
      kind: 'revoked',
      title: '设备已吊销',
      body: `${deviceLabel(deviceId)} 已被本机吊销`,
      data: { deviceId, reason: record?.reason ?? '' },
    })
    try {
      appendFileSync(join(state.dataDir, 'revocations.jsonl'), `${JSON.stringify({
        at: new Date().toISOString(),
        deviceId,
        revokedBy: record?.revokedBy ?? null,
        revokedSeq: record?.revokedSeq ?? null,
        reason: record?.reason ?? '',
        source,
      })}\n`)
    } catch {
      /* audit is best effort */
    }
  })
  node.on('account-bound', ({ fingerprint }) => {
    try {
      saveAccountBinding(state, fingerprint, 'peer')
      logger.info?.('[device-fleet] bound creator account fingerprint from a peer')
    } catch (error) {
      logger.warn?.(`[device-fleet] cannot persist account binding: ${String(error?.message ?? error)}`)
    }
  })
  node.on('warning', (error) => {
    recentWarnings.push({ at: new Date().toISOString(), code: error?.code ?? null, message: String(error?.message ?? error) })
    if (recentWarnings.length > 20) recentWarnings.shift()
    logger.warn?.(`[device-fleet] ${String(error?.message ?? error)}`)
  })

  const ready = node.start().catch((error) => {
    logger.error?.(`[device-fleet] cannot start network layer: ${String(error?.message ?? error)}`)
  })

  // Bind the local account fingerprint when the account service is composed.
  const account = service('deepseekAccount')
  if (account && typeof account.getDeviceIdentity === 'function') {
    void account
      .getDeviceIdentity()
      .then((identity) => {
        if (!identity?.userId) return
        const fingerprint = accountFingerprint(state.fleet.fleetKey, identity.userId)
        if (!accountMatches(state, fingerprint)) {
          logger.error?.('[device-fleet] signed-in account does not match the Fleet invite; connections will be refused')
          node.accountFingerprint = 'mismatch'
          return
        }
        node.accountFingerprint = fingerprint
        if (!state.account?.fingerprint) {
          try {
            saveAccountBinding(state, fingerprint, 'account-service')
          } catch {
            /* binding is best effort */
          }
        }
      })
      .catch(() => {})
  }

  const client = new DirectCallClient({ node, onCall: recordCall })
  const flushOutbox = async (deviceId) => {
    for (const entry of outbox.pendingFor(deviceId)) {
      outbox.update(entry.id, { status: 'running', startedAt: Date.now() })
      try {
        let text = ''
        if (entry.kind === 'delegate') {
          const result = await client.delegate(deviceId, entry.request ?? {}, { timeoutMs: 200_000 })
          text = String(result?.text ?? '')
        } else {
          const result = await client.call(deviceId, entry.request ?? {}, { timeoutMs: 60_000 })
          text = client.render(result)
        }
        outbox.update(entry.id, { status: 'done', resultText: text, finishedAt: Date.now() })
      } catch (error) {
        const code = error?.code
        const offline = code === 'unreachable' || code === 'offline' || /no endpoint|cannot reach|not connected/i.test(String(error?.message ?? ''))
        outbox.update(entry.id, {
          status: offline ? 'queued' : 'failed',
          error: String(error?.message ?? error),
          finishedAt: offline ? null : Date.now(),
        })
      }
    }
  }
  const collectCalls = async (limit = 200) => {
    const bounded = Math.max(1, Math.min(500, Number(limit) || 200))
    const labelFor = (deviceId) => node.roster.get(deviceId)?.name ?? (deviceId === node.identity.deviceId ? node.name : 'device')
    const local = callLedger.list({ limit: bounded }).map((entry) => ({
      ...entry,
      reportedBy: node.identity.deviceId,
      reportedByName: labelFor(node.identity.deviceId),
    }))
    const remote = await Promise.all(node.peerIds().map(async (deviceId) => {
      try {
        const response = await node.request(deviceId, 'fleet.calls.list', { limit: bounded }, { timeoutMs: 2_000 })
        return (Array.isArray(response?.calls) ? response.calls : []).map((entry) => ({
          ...entry,
          reportedBy: deviceId,
          reportedByName: labelFor(deviceId),
        }))
      } catch {
        return []
      }
    }))
    return [...local, ...remote.flat()].sort((left, right) => Number(right.at) - Number(left.at)).slice(0, bounded)
  }
  const collectTrajectory = async ({ deviceId, sessionId } = {}) => {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw Object.assign(new Error('sessionId is required'), { code: 'bad-request' })
    }
    if (deviceId === node.identity.deviceId || !deviceId) {
      const local = trajectoryStore.get(sessionId)
      if (!local) throw Object.assign(new Error('no trajectory recorded for that session'), { code: 'no-session' })
      return local
    }
    return node.request(deviceId, 'fleet.session.trajectory', { sessionId }, { timeoutMs: 5_000 })
  }
  const localEndpoints = () => {
    const port = node.directAddress?.port
    if (!Number.isInteger(port) || port <= 0) return []
    const endpoints = []
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family !== 'IPv4' || entry.internal) continue
        endpoints.push({ deviceId: state.identity.deviceId, host: entry.address, port })
      }
    }
    for (const host of overlayAddresses(overlayStatus)) {
      endpoints.push({ deviceId: state.identity.deviceId, host, port })
    }
    return endpoints
  }
  const pairing = {
    async invite() {
      const fingerprint =
        node.accountFingerprint && node.accountFingerprint !== 'mismatch'
          ? node.accountFingerprint
          : (state.enrollment?.accountFingerprint ?? null)
      const learnedRelays = typeof node.relayCandidateList === 'function' ? node.relayCandidateList() : []
      const configuredRelays = runtime.current.relays ?? state.enrollment?.relays ?? []
      const invitedRelays = [...learnedRelays, ...configuredRelays]
      const localRotation = node.status?.()?.rotation ?? { seq: -1, head: null }
      const bootstrapRoster = node
        .rosterEntries()
        .filter((entry) => typeof entry.edPublic === 'string' && typeof entry.xPublic === 'string')
        .map((entry) => ({
          deviceId: entry.deviceId,
          name: entry.name ?? 'device',
          edPublic: entry.edPublic,
          xPublic: entry.xPublic,
          ...(Number.isInteger(Number(entry.rotationSeq)) ? { rotationSeq: Number(entry.rotationSeq) } : {}),
          ...(typeof entry.rotationHead === 'string' ? { rotationHead: entry.rotationHead } : {}),
          ...(Number.isFinite(Number(entry.revokedAt))
            ? {
                revokedAt: Number(entry.revokedAt),
                revokedBy: entry.revokedBy ?? null,
                ...(Number.isInteger(Number(entry.revokedSeq)) ? { revokedSeq: Number(entry.revokedSeq) } : {}),
                revocationReason: entry.revocationReason ?? '',
              }
            : {}),
        }))
      const revocations = node.rosterEntries().map((entry) => entry.revocationRecord).filter(Boolean)

      return createInvite(state, {
        accountFingerprint: fingerprint,
        relay: runtime.current.relay ?? state.enrollment?.relay ?? null,
        relays: invitedRelays,
        endpoints: localEndpoints(),
        rotations: Array.isArray(node.rotationChain) ? node.rotationChain : [],
        ttlMs: Number(runtime.current.invite?.ttlMs) > 0 ? Number(runtime.current.invite.ttlMs) : undefined,
        creator: {
          deviceId: node.identity.deviceId,
          name: runtime.current.deviceName ?? 'device',
          edPublic: node.identity.edPublic,
          xPublic: node.identity.xPublic,
          rotationSeq: Number(localRotation.seq ?? -1),
          rotationHead: localRotation.head ?? null,
        },
        roster: bootstrapRoster,
        revocations,
      })
    },
    async join(code) {
      writePendingEnrollment(state, code)
    },
  }
  pairingRef = pairing
  const cascadeRoomMembership = async (deviceId, reason) => {
    const affectedRooms = []
    for (const room of [...rooms.rooms.values()]) {
      if (room.mirror) continue
      try {
        const result = await rooms.removeDeviceMembers({ roomId: room.roomId, deviceId, reason })
        if (result.removed.length > 0) affectedRooms.push({ roomId: room.roomId, removed: result.removed.length })
      } catch (error) {
        logger.warn?.(`[device-fleet] cascade removal failed for ${room.roomId}: ${String(error?.message ?? error)}`)
      }
    }
    return affectedRooms
  }
  const removeFleetDevice = async ({ deviceId } = {}) => {
    if (typeof deviceId !== 'string' || deviceId === '') throw Object.assign(new Error('deviceId is required'), { code: 'bad-request' })
    if (deviceId === node.identity?.deviceId) throw Object.assign(new Error('cannot remove this device'), { code: 'forbidden' })
    if (!node.roster.has(deviceId)) throw Object.assign(new Error('device is not in the roster'), { code: 'unknown-device' })
    const affectedRooms = await cascadeRoomMembership(deviceId, 'device removed from Fleet')
    node.channels.get(deviceId)?.close()
    node.roster.delete(deviceId)
    node.peerRotations.delete(deviceId)
    savePeerRotations(state, node.exportPeerRotations())
    saveRoster(state, node.rosterEntries())
    removePeerHintsForDevice(state, deviceId)
    return { deviceId, rooms: affectedRooms }
  }
  /**
   * Local authoritative revocation (ADR-0027). The record is signed with this
   * device's current key and advertised to the other connected devices; those
   * devices keep it advisory until their own user confirms it. A revoked device
   * is refused at the handshake and cannot be silently re-pinned by TOFU.
   */
  const revokeFleetDevice = async ({ deviceId, reason, confirm } = {}) => {
    if (typeof deviceId !== 'string' || deviceId === '') throw Object.assign(new Error('deviceId is required'), { code: 'bad-request' })
    if (deviceId === node.identity?.deviceId) throw Object.assign(new Error('cannot revoke this device'), { code: 'forbidden' })
    if (confirm !== true) throw Object.assign(new Error('revoking a device requires explicit confirmation'), { code: 'confirmation-required' })
    const entry = node.roster.get(deviceId)
    if (!entry) throw Object.assign(new Error('device is not in the roster'), { code: 'unknown-device' })
    if (entry.revokedAt) {
      return { deviceId, alreadyRevoked: true, revokedAt: entry.revokedAt, rooms: [] }
    }
    const record = createRevocationRecord(state.identity, {
      deviceId,
      revokedSeq: entry.rotationSeq ?? -1,
      revokedHead: entry.rotationHead ?? null,
      reason: typeof reason === 'string' && reason !== '' ? reason : 'revoked by local user',
    })
    const applied = node.applyRevocation(record, { confirmed: true, source: 'local' })
    if (applied.status !== 'revoked') {
      throw Object.assign(new Error(`cannot revoke ${deviceId}: ${String(applied.reason ?? applied.status)}`), { code: 'revocation-failed' })
    }
    const affectedRooms = await cascadeRoomMembership(deviceId, 'device revoked from Fleet')
    node.channels.get(deviceId)?.close()
    removePeerHintsForDevice(state, deviceId)
    const advertisedTo = node.peerIds().filter((peerId) => peerId !== deviceId)
    for (const peerId of advertisedTo) {
      void node
        .request(peerId, 'fleet.device.revoke', { record }, { timeoutMs: 5_000 })
        .catch((error) => logger.warn?.(`[device-fleet] revocation fan-out to ${peerId} failed: ${String(error?.message ?? error)}`))
    }
    return {
      deviceId,
      revokedAt: applied.entry?.revokedAt ?? record.revokedAt,
      rotationSeq: entry.rotationSeq ?? -1,
      reason: record.reason,
      rooms: affectedRooms,
      advertisedTo,
    }
  }
  const trustRotationCheckpoint = async ({ deviceId, confirm } = {}) => {
    if (typeof deviceId !== 'string' || deviceId === '') throw Object.assign(new Error('deviceId is required'), { code: 'bad-request' })
    if (confirm !== true) throw Object.assign(new Error('trusting a rotation checkpoint requires explicit confirmation'), { code: 'confirmation-required' })
    const offer = node.checkpointOfferFor(deviceId)
    const quorum = Math.max(1, Number(runtime.current.rotation?.checkpointQuorum) || 1)
    if (offer && quorum > 1) {
      const confirmations = 1 + node.checkpointEndorsements(deviceId, offer.checkpoint?.seq, offer.checkpoint?.head)
      if (confirmations < quorum) {
        throw Object.assign(new Error(`checkpoint needs ${quorum} confirmations, has ${confirmations}`), { code: 'checkpoint-quorum' })
      }
    }
    const result = node.trustRotationCheckpoint(deviceId, { threshold: quorum })
    if (result.status === 'no-offer') throw Object.assign(new Error('this device has no checkpoint offer'), { code: 'no-checkpoint' })
    if (result.status === 'quorum') throw Object.assign(new Error(String(result.reason ?? 'checkpoint quorum is not met')), { code: 'checkpoint-quorum' })
    if (result.status === 'invalid' || result.status === 'unknown') {
      throw Object.assign(new Error(String(result.reason ?? result.status)), { code: result.status })
    }
    void node.broadcastCheckpointTrust({ deviceId, seq: result.entry?.rotationSeq ?? null, head: result.entry?.rotationHead ?? null })
    return {
      deviceId,
      status: result.status,
      rotationSeq: result.entry?.rotationSeq ?? null,
      rotationHead: result.entry?.rotationHead ?? null,
      checkpointCertificate: result.certificate ?? null,
    }
  }
  const resolveRotationFork = async ({ deviceId, action, confirm } = {}) => {    if (typeof deviceId !== 'string' || deviceId === '') throw Object.assign(new Error('deviceId is required'), { code: 'bad-request' })
    if (confirm !== true) throw Object.assign(new Error('resolving a rotation fork requires explicit confirmation'), { code: 'confirmation-required' })
    const entry = node.roster.get(deviceId)
    if (!entry) throw Object.assign(new Error('device is not in the roster'), { code: 'unknown-device' })
    if (!entry.rotationFork) throw Object.assign(new Error('no rotation fork is recorded for this device'), { code: 'no-fork' })
    const result = node.resolveFork(deviceId, action === 'adopt-peer' ? 'adopt-peer' : 'keep-local')
    if (result.status === 'invalid' || result.status === 'fork-not-resolvable') {
      throw Object.assign(new Error(String(result.reason ?? result.status)), { code: result.status })
    }
    return {
      deviceId,
      action: action === 'adopt-peer' ? 'adopt-peer' : 'keep-local',
      status: result.status,
      rotationSeq: result.entry?.rotationSeq ?? null,
      rotationHead: result.entry?.rotationHead ?? null,
    }
  }
  const rotationStatus = ({ deviceId } = {}) => {
    const status = node.status()
    const entries = Array.isArray(status.roster) ? status.roster : []
    const selected = typeof deviceId === 'string' && deviceId !== ''
      ? entries.filter((entry) => entry.deviceId === deviceId)
      : entries
    return {
      deviceId: status.deviceId,
      rotation: status.rotation,
      local: {
        ...(status.rotation ?? {}),
        from: Array.isArray(node.rotationChain) && node.rotationChain[0] ? Number(node.rotationChain[0].seq) : -1,
        checkpoint: loadRotationState(state).checkpoint,
      },
      account: status.account,
      devices: selected,
      ...(typeof deviceId === 'string' && deviceId !== '' && selected.length === 0
        ? { warning: `device ${deviceId} is not in the roster` }
        : {}),
    }
  }
  const resetIdentity = async ({ confirm, reason } = {}) => {
    if (confirm !== true) throw Object.assign(new Error('resetting the identity requires explicit confirmation'), { code: 'confirmation-required' })
    // Close local authority Rooms while the old identity can still notify their
    // mirrors, then archive them. Otherwise the retired identity's authority
    // metadata can compete with the replacement identity later (ADR-0030 note).
    const oldDeviceId = state.identity?.deviceId
    const closedRooms = []
    for (const room of rooms.rooms.values()) {
      if (room.mirror || room.authorityDeviceId !== oldDeviceId) continue
      try {
        await rooms.close({ roomId: room.roomId, reason: 'identity reset' })
        roomReplica.archiveReplica(room.roomId, true)
        closedRooms.push(room.roomId)
      } catch (error) {
        logger.warn?.(`[device-fleet] could not close Room ${room.roomId} before identity reset: ${String(error?.message ?? error)}`)
      }
    }
    const summary = resetDeviceIdentity(state, { name: runtime.current.deviceName ?? 'device' })
    summary.closedRooms = closedRooms
    node.identity = state.identity
    node.rotationChain = []
    // Execution/Delegation hosts captured the previous deviceId at build time.
    if (host) host.deviceId = state.identity.deviceId
    if (delegation) delegation.deviceId = state.identity.deviceId
    for (const channel of [...node.channels.values()]) channel.close()
    node.channels.clear()
    try {
      appendFileSync(
        join(state.dataDir, 'diagnostics.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), event: 'identity-reset', reason: reason ?? '', ...summary })}\n`,
      )
    } catch {
      /* audit is best effort */
    }
    return summary
  }
  const heartbeatTimer = setInterval(() => {
    const peers = node.peerIds()
    if (peers.length === 0) return
    for (const room of rooms.rooms.values()) {
      if (room.mirror || room.authorityDeviceId !== node.identity?.deviceId) continue
      const remoteSessions = [...room.members.values()].filter((member) => member.kind === 'remote' && member.deviceId && member.remoteSessionId)
      for (const peerId of peers) {
        const targets = remoteSessions.filter((member) => member.deviceId === peerId)
        // A mirror stores events under its own local session id. Sending both
        // the logical room id and each remote session id keeps older peers and
        // promoted mirrors in sync without knowing their local id.
        for (const targetRoomId of [room.roomId, ...new Set(targets.map((member) => member.remoteSessionId))]) {
          void node.request(peerId, 'room.authority.heartbeat', {
            roomId: targetRoomId,
            deviceId: node.identity.deviceId,
            epoch: room.authorityEpoch ?? 0,
          }, { timeoutMs: 2_000 }).catch(() => {})
        }
      }
    }
  }, 5_000)
  heartbeatTimer.unref?.()
  ctx.effect(() => () => clearInterval(heartbeatTimer))
  const scopeRevokeRetryTimer = setInterval(() => {
    for (const deviceId of node.peerIds()) {
      void flushScopeRevocations(deviceId)
      void flushOutbox(deviceId)
    }
  }, 30_000)
  scopeRevokeRetryTimer.unref?.()
  ctx.effect(() => () => clearInterval(scopeRevokeRetryTimer))

  const broadcastAuthorityClaim = (room, deviceId) => {
    if (!room || room.mirror || !deviceId) return
    const ids = [...new Set([room.roomId, room.authorityRoomId].filter((id) => typeof id === 'string' && id !== ''))]
    for (const roomId of ids) {
      void node.request(deviceId, 'room.authority.claim', {
        roomId,
        authorityDeviceId: node.identity.deviceId,
        authorityRoomId: room.authorityRoomId ?? room.roomId,
        epoch: room.authorityEpoch ?? 0,
      }, { timeoutMs: 5_000 }).catch(() => {})
    }
  }

  const promotionReadyAt = Date.now() + 30_000
  const promotionTimer = setInterval(() => {
    if (Date.now() < promotionReadyAt) return
    const now = Date.now()
    for (const room of rooms.rooms.values()) {
      if (!room.mirror) continue
      if (!room.authorityHeartbeatAt) continue
      if (now - Number(room.authorityHeartbeatAt) < 15_000) continue
      if (room.coordinatorDeviceId && room.coordinatorDeviceId !== node.identity?.deviceId) continue
      void rooms.promoteMirrorToAuthority({ roomId: room.roomId, automatic: true })
        .then(() => {
          for (const peerId of node.peerIds()) broadcastAuthorityClaim(room, peerId)
          logger.info?.(`[device-fleet] promoted mirror ${room.roomId} after authority heartbeat timeout`)
        })
        .catch((error) => logger.warn?.(`[device-fleet] mirror promotion failed: ${String(error?.message ?? error)}`))
    }
  }, 10_000)
  promotionTimer.unref?.()
  ctx.effect(() => () => clearInterval(promotionTimer))

  node.on('peer', ({ deviceId }) => {
    void flushScopeRevocations(deviceId)
    void flushOutbox(deviceId)
    try {
      rememberKnownDevice(state, deviceId)
    } catch (error) {
      logger.warn?.(`[device-fleet] cannot persist known device: ${String(error?.message ?? error)}`)
    }
    for (const room of rooms.rooms.values()) {
      if (room.mirror || room.authorityDeviceId !== node.identity?.deviceId) continue
      const isMember = [...room.members.values()].some((member) => member.deviceId === deviceId)
      if (!isMember) continue
      broadcastAuthorityClaim(room, deviceId)
    }
    // Re-advertise local revocations so a device that was offline when the
    // revocation happened still learns about it (advisory until its own user
    // confirms).
    for (const entry of node.rosterEntries()) {
      if (entry.deviceId === deviceId || !entry.revocationRecord) continue
      void node
        .request(deviceId, 'fleet.device.revoke', { record: entry.revocationRecord }, { timeoutMs: 4_000 })
        .catch(() => {})
    }
  })

  const loadRotationChain = loadIdentityRotationChain
  const rotateIdentity = async () => {
    const peers = node.peerIds()
    const nextIdentity = rotateIdentityKeys(state.identity)
    const rotationState = loadRotationState(state)
    const chain = rotationState.records
    const record = createRotationRecord(state.identity, nextIdentity, { previous: chain[chain.length - 1] ?? null })
    for (const peerId of peers) {
      const result = await node.request(peerId, 'fleet.rotation', { record }, { timeoutMs: 10_000 })
      if (!result?.applied) {
        throw Object.assign(new Error(`peer ${peerId} rejected identity rotation`), { code: 'rotation-rejected' })
      }
    }
    state.identity = nextIdentity
    node.identity = nextIdentity
    writeFileSync(join(state.dataDir, 'identity.json'), JSON.stringify(nextIdentity, null, 2), 'utf8')
    writeFileSync(join(state.dataDir, 'identity-rotation.json'), JSON.stringify(record, null, 2), 'utf8')
    saveRotationState(state, { records: [...chain, record], checkpoint: rotationState.checkpoint })
    node.rotationChain = [...chain, record]
    node.setRotationCheckpoint?.(rotationState.checkpoint)
    return { deviceId: nextIdentity.deviceId, rotatedAt: record.rotatedAt, seq: record.seq, peers }
  }
  /**
   * Prune old rotation records after archiving them. Peers pinned below the
   * retained window must re-pair; explicit confirmation avoids silently
   * breaking an offline device.
   */
  const compactRotation = async ({ confirm, keep } = {}) => {
    if (confirm !== true) throw Object.assign(new Error('compacting the rotation chain requires explicit confirmation'), { code: 'confirmation-required' })
    const result = compactRotationChain(state, { keep: Number(keep) || 64 })
    if (result.compacted) {
      node.rotationChain = loadRotationState(state).records
      node.setRotationCheckpoint?.(loadRotationState(state).checkpoint)
      logger.info?.(`[device-fleet] rotation chain compacted: archived ${result.archived}, kept ${result.kept} (from seq ${result.from})`)
    }
    return result
  }
  const restoreRoom = async ({ roomId } = {}) => {
    if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
    if (!roomReplica.roomIndexEntry(roomId)) throw Object.assign(new Error('unknown room'), { code: 'unknown-room' })
    const summary = rooms.restoreArchivedRoom({ roomId, snapshot: roomReplica.state(roomId) })
    roomReplica.archiveReplica(roomId, false)
    // Best effort: ask known remote members to rejoin the restored Room. A
    // persisted participant session can be rebound; otherwise the remote side
    // creates a new session and we replace the stale member.
    const reinvited = []
    const reinviteFailed = []
    if (!summary.mirror) {
      for (const member of summary.members) {
        if (member.kind !== 'remote' || !member.deviceId) continue
        try {
          const joined = await node.request(member.deviceId, 'room.join', {
            roomId,
            name: member.name ?? 'remote',
            sessionId: member.remoteSessionId ?? null,
          }, { timeoutMs: 8_000 })
          if (joined?.sessionId && joined.sessionId !== member.remoteSessionId) {
            await rooms.removeMember({ roomId, memberId: member.memberId, reason: 're-invite after restore' })
            await rooms.addRemoteMember({ roomId, deviceId: member.deviceId, name: member.name ?? 'remote', sessionId: joined.sessionId })
          }
          reinvited.push(member.deviceId)
        } catch (error) {
          reinviteFailed.push({ deviceId: member.deviceId, error: String(error?.message ?? error) })
        }
      }
    }
    logger.info?.(`[device-fleet] restored archived Room ${roomId} (authority ${String(summary.authorityDeviceId ?? '?')}, epoch ${summary.authorityEpoch ?? '?'})`)
    return { roomId, restored: true, room: summary, reinvited, reinviteFailed }
  }
  const handlers = createFleetHandlers({
    node,
    client,
    pairing,
    onPeerHint: async (hint) => {
      try {
        savePeerHint(state, hint)
      } catch (error) {
        logger.warn?.(`[device-fleet] cannot persist peer hint: ${String(error?.message ?? error)}`)
      }
    },
    approvals: approvalsApi,
    rooms,
    outbox,
    flushOutbox,
    onTaskDone: (taskId, roomId) => revokeTaskEverywhere(roomId, taskId),
    onRoomClose: (roomId) => revokeRoomEverywhere(roomId),
    remoteRoom: remoteRoomBridge,
    remotePeer: remoteRoomPeer,
    syncRoom: syncRoomNow,
    acceptInvite,
    rotateIdentity,
    rotationStatus,
    compactRotation,
    revokeDevice: revokeFleetDevice,
    resolveRotationFork,
    trustRotationCheckpoint,
    resetIdentity,
    archiveRoom: async ({ roomId, archived } = {}) => {
      if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
      return { roomId, archived: roomReplica.archiveReplica(roomId, archived !== false) }
    },
    restoreRoom,
    deleteRoom: async ({ roomId } = {}) => {
      if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
      const room = rooms.rooms.get(roomId)
      if (room) {
        try {
          await rooms.close({ roomId, reason: 'deleted by user' })
        } catch {
          /* already gone */
        }
      }
      remoteRoomPeer.releaseSession(roomId)
      roomReplica.removeReplica(roomId)
      return { roomId, deleted: true }
    },
    compactRoom: async ({ roomId, minEvents } = {}) => {
      if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
      const room = findSyncRoom(roomId)
      const localRoomId = room?.roomId ?? roomId
      const removed = roomReplica.compactEvents(localRoomId, { minEvents: Number(minEvents) || 400 })
      return { roomId, localRoomId, removed, events: roomReplica.loadEvents(localRoomId).length }
    },
    claimAuthority: async ({ roomId } = {}) => {
      if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
      return rooms.claimAuthority({ roomId, deviceId: node.identity?.deviceId })
    },
    promoteMirror: async ({ roomId } = {}) => {
      if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
      const summary = await rooms.promoteMirrorToAuthority({ roomId })
      const room = rooms.rooms.get(roomId)
      for (const peerId of node.peerIds()) broadcastAuthorityClaim(room, peerId)
      return summary
    },
    removeFleetDevice,
    isSlotAgent: (agent) =>
      Boolean(slot && agent && (slot.agent === agent || (slot.sessionId && agent.session?.id === slot.sessionId))),
  })
  const definitions = createFleetToolDefinitions({ defineTool, handlers })
  const wrapped = withManual(definitions.map((definition) => ({ ...definition, execute: safe(definition.execute) })))
  for (const definition of wrapped) ctx.tools.register(definition)

  // Adoption layer 2: one sentence, only when the Fleet has members.
  const systemPrompt = service('systemPrompt')
  if (systemPrompt) {
    const order = systemPrompt.getSectionOrder?.('TOOL_SUBAGENT') ?? PROMPT_SECTION_ORDER
    ctx.effect(() =>
      systemPrompt.section({
        name: 'device-fleet:members',
        order,
        text: () => {
          if (runtime.current.promptSection === false) return ''
          const members = node.rosterEntries().length
          if (members === 0) return ''
          return `This DSH instance is part of a device Fleet with ${members} other device(s). Use fleet_list/fleet_read/fleet_fetch/fleet_run for work that belongs on another device; direct calls fail fast when that device is offline.`
        },
      }),
    )
  }

  // Live config application: every UI save runs these handlers in-process.
  runtime.onChange(async (next, previous) => {
    if (JSON.stringify(next.policy) !== JSON.stringify(previous?.policy)) {
      policy = new ToolPolicy(next.policy, { stateFile: join(state.dataDir, 'tool-grants.json') })
      if (host) host.policy = policy
      if (delegation) delegation.policy = policy
    }
    if (JSON.stringify(next.execution) !== JSON.stringify(previous?.execution)) {
      slot?.setConfig(next.execution)
      if (host) {
        host.shellTool = next.execution?.shellTool ?? DEFAULT_SHELL_TOOL
        host.approvalTimeoutMs = next.execution?.approvalTimeoutMs ?? 60_000
      }
      if (delegation) {
        delegation.defaultCwd = next.execution?.cwd
        delegation.defaultAgentPreset = next.execution?.agentPreset
        delegation.provider = next.execution?.subagentProvider ?? 'spawn'
        delegation.timeoutMs = next.execution?.delegateTimeoutMs ?? 180_000
      }
    }
    if (JSON.stringify(next.approvals) !== JSON.stringify(previous?.approvals)) {
      if (Number.isInteger(next.approvals?.ttlMs) && next.approvals.ttlMs >= 1000) inbox.ttlMs = next.approvals.ttlMs
      if (Number.isInteger(next.approvals?.maxPending) && next.approvals.maxPending >= 1) inbox.maxPending = next.approvals.maxPending
    }
    if (next.deviceName !== previous?.deviceName) {
      node.name = next.deviceName
      if (host) host.name = next.deviceName
    }
    const networkChanged =
      JSON.stringify(next.direct) !== JSON.stringify(previous?.direct) ||
      next.discovery !== previous?.discovery ||
      JSON.stringify(next.relay) !== JSON.stringify(previous?.relay) ||
      JSON.stringify(next.relays) !== JSON.stringify(previous?.relays)
    if (networkChanged) {
      await node.reconfigure({
        name: next.deviceName,
        direct: next.direct,
        discovery: next.discovery ? true : false,
        relay: next.relay ?? null,
        relays: next.relays ?? [],
      })
    }
  })

  // Adoption layer 4: one-line nudge when the model starts orchestrating.
  ctx.on?.('tools/post-execute', async (exec, _result, next) => {
    const decision = await next()
    const signal = exec?.name
    if (signal !== 'todo_write' && !String(signal).startsWith('subagent') && signal !== 'workflow' && signal !== 'ralph') return decision
    if (node.rosterEntries().length === 0) return decision
    const sessionId = exec?.agent?.session?.id
    if (typeof sessionId !== 'string' || manualDelivered.has(sessionId)) return decision
    manualDelivered.add(sessionId)
    return {
      ...decision,
      additionalContexts: [
        ...(decision.additionalContexts ?? []),
        createUserMessage({
          content: [
            {
              type: 'text',
              text: 'You are organising multi-step work on a device Fleet. If part of it belongs on another machine (builds, logs, files, tests), use fleet_list then fleet_read/fleet_fetch/fleet_run; keep the work on this device when it is local.',
            },
          ],
          source: { kind: 'device-fleet', form: 'instructions' },
        }),
      ],
    }
  })

  ctx.effect(() => () => {
    inbox.close()
    // Rooms are intentionally left open (and persisted) so a plugin reload can
    // rehydrate them instead of destroying a running collaboration. Return the
    // close promise so the loader waits for the direct listener to be released
    // before the next activation tries to bind the configured port.
    return node.close().catch((error) => {
      logger.warn?.(`[device-fleet] network close failed: ${String(error?.message ?? error)}`)
    })
  })

  logger.info?.(`[device-fleet] v${pluginVersion} device ${state.identity.deviceId} (${config.deviceName})`)
  void ready
}
