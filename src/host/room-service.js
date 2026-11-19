// Room logic layer (ADR-0002/0005/0006/0011/0021), with local participants for
// simulation inside one DSH. The Host session log carries the authoritative
// room events; participant agents are real local DSH sessions woken with an
// addressed message, so addressing/wake/visibility and board handoff can be
// exercised before the remote transport and the client UI exist.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRoomKey, decodeRoomInvite, encodeRoomInvite } from './room-invite.js'
import { friendlyName, memberDisplayName } from './human-names.js'

const MAX_MESSAGE_CHARS = 20_000
const STATE_VERSION = 1
// Custom session events must be ignorable plugin records. A plain
// `session.append('room/...', ...)` writes an unknown type without the
// envelope's `ignorable` marker, and the persistence read path refuses the
// whole log then ("unknown to this harness ... not marked ignorable"), so the
// session can never be opened again. Plugin records are skipped by readers
// that do not know them and are retained by fork/resume.
const ROOM_RECORD_PREFIX = 'plugin:device-fleet/'

let sessionModulePromise = null
/**
 * Resolve `@deepseek-ai/dsh-session` lazily: the host runtime provides it, but
 * plain-Node unit tests have no runtime package tree, and the module is only
 * needed when a Room actually writes a record.
 */
function loadSessionModule() {
  if (sessionModulePromise === null) {
    sessionModulePromise = import('@deepseek-ai/dsh-session').catch(() => null)
  }
  return sessionModulePromise
}

/**
 * Default recorder: an ignorable plugin record carrying the Room event.
 * @param {object} session host agent's DSH session
 * @param {string} type `plugin:device-fleet/<name>`
 * @param {object} data JSON payload
 */
async function appendRoomRecord(session, type, data) {
  const module = await loadSessionModule()
  const append = module?.appendPluginRecord
  if (typeof append !== 'function') throw new Error('this harness cannot store ignorable plugin records')
  append(session, type, data)
}

const DEFAULT_POLICY = Object.freeze({
  invite: 'members',
  join: 'auto',
  maxMembers: 8,
  boardWrite: 'members',
  remove: 'members',
})

function hostMemberId(sessionId) {
  return `host:${sessionId}`
}

function localMemberId(sessionId) {
  return `local:${sessionId}`
}

// Avatars are a Room-level property of a member: deterministic from the stable
// member id so every device renders the same face for the same agent.
const AVATAR_KEYS = ['host', 'worker', 'user']
function avatarKeyFor(memberId) {
  const text = String(memberId ?? 'member')
  let hash = 0
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  return AVATAR_KEYS[hash % AVATAR_KEYS.length]
}

export class RoomService {
  /** Attach the local Room replica event log (Phase 1 write-through). */
  setReplicaStore(store) {
    this.replicaStore = store ?? null
  }

  /** Best-effort event emission; returns the appended replica event when available. */
  emitReplica(roomId, type, author, payload) {
    if (!this.replicaStore) return null
    try {
      return this.replicaStore.append({ roomId, type, author, payload })
    } catch (error) {
      this.warn?.(`[device-fleet] cannot append Room replica event: ${String(error?.message ?? error)}`)
      return null
    }
  }

  memberActor(member) {
    if (!member) return { kind: 'system' }
    return {
      kind: member.kind === 'remote' ? 'remote-member' : 'member',
      memberId: member.memberId,
      sessionId: member.sessionId ?? member.remoteSessionId ?? null,
      ...(member.deviceId ? { deviceId: member.deviceId } : {}),
    }
  }

  /**
   * @param {object} options
   * @param {object} options.sessionController ctx.sessionController
   * @param {(input: object) => object} [options.createUserMessage] dsh-llm helper
   * @param {(now?: number) => number} [options.now]
   * @param {string} [options.stateFile] JSON file used to rehydrate rooms after a reload
   * @param {(session: object, type: string, data: object) => Promise<void>|void} [options.appendRecord]
   *   writer for Room records; defaults to the harness's ignorable plugin-record API
   * @param {(line: string) => void} [options.warn] one-shot record-write warning sink
   */
  constructor({
    sessionController,
    createUserMessage = null,
    now = Date.now,
    stateFile = null,
    appendRecord = appendRoomRecord,
    warn = () => {},
    wakeRemote = null,
    mirrorWakeRemote = null,
    mirrorPublish = null,
    replicaStore = null,
    onClosed = null,
    signInvite = null,
    verifyInvite = null,
    encryptRoomKey = null,
    decryptRoomKey = null,
  } = {}) {
    this.sessionController = sessionController
    this.createUserMessage = createUserMessage
    this.now = now
    this.stateFile = stateFile
    this.appendRecord = appendRecord
    this.warn = warn
    this.wakeRemote = wakeRemote
    this.mirrorWakeRemote = mirrorWakeRemote
    this.mirrorPublish = mirrorPublish
    this.replicaStore = replicaStore
    this.onClosed = onClosed
    this.signInvite = typeof signInvite === 'function' ? signInvite : null
    this.verifyInvite = typeof verifyInvite === 'function' ? verifyInvite : null
    this.encryptRoomKey = typeof encryptRoomKey === 'function' ? encryptRoomKey : null
    this.decryptRoomKey = typeof decryptRoomKey === 'function' ? decryptRoomKey : null
    this.recordWarningIssued = false
    /** @type {Map<string, any>} */
    this.rooms = new Map()
    if (stateFile) this.load()
  }

  /** Rehydrate active rooms from the persisted snapshot (agents resolve lazily). */
  load() {
    if (!this.stateFile || !existsSync(this.stateFile)) return
    try {
      const data = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      if (!data || data.version !== STATE_VERSION || !Array.isArray(data.rooms)) return
      for (const stored of data.rooms) {
        if (!stored || typeof stored.roomId !== 'string' || !Array.isArray(stored.members)) continue
        const members = new Map()
        for (const member of stored.members) {
          if (!member || typeof member.memberId !== 'string') continue
          members.set(member.memberId, { ...member, agent: undefined, avatarKey: member.avatarKey ?? avatarKeyFor(member.memberId) })
        }
        if (!members.has(hostMemberId(stored.roomId)) && !stored.mirror) continue
        let roomKey = stored.key ?? null
        if (!roomKey && stored.keyEnc && this.decryptRoomKey) {
          try {
            roomKey = this.decryptRoomKey(stored.keyEnc)
          } catch {
            roomKey = null
          }
        }
        this.rooms.set(stored.roomId, {
          roomId: stored.roomId,
          title: typeof stored.title === 'string' && stored.title !== '' ? stored.title : friendlyName(stored.roomId),
          createdAt: Number.isFinite(stored.createdAt) ? stored.createdAt : this.now(),
          hostSessionId: typeof stored.hostSessionId === 'string' ? stored.hostSessionId : stored.roomId,
          policy: { ...DEFAULT_POLICY, ...(stored.policy ?? {}) },
          members,
          messages: Array.isArray(stored.messages) ? stored.messages : [],
          tasks: new Map((Array.isArray(stored.tasks) ? stored.tasks : []).map((task) => [task.id, task])),
          closed: false,
          ...(stored.mirror ? { mirror: stored.mirror } : {}),
          ...(roomKey ? { key: roomKey } : {}),
          creatorMemberId: stored.creatorMemberId ?? null,
          creatorDeviceId: stored.creatorDeviceId ?? null,
          coordinatorDeviceId: stored.coordinatorDeviceId ?? null,
          coordinatorUpdatedAt: stored.coordinatorUpdatedAt ?? 0,
          authorityDeviceId: stored.authorityDeviceId ?? (stored.mirror ? stored.mirror.deviceId : null),
          authorityRoomId: stored.authorityRoomId ?? (stored.mirror ? stored.mirror.roomId : stored.roomId),
          authorityEpoch: Number.isFinite(stored.authorityEpoch) ? stored.authorityEpoch : 0,
          authorityHeartbeatAt: Number(stored.authorityHeartbeatAt) || 0,
        })
      }
    } catch {
      /* a corrupt snapshot is ignored; the host session log stays authoritative */
    }
  }

  persist() {
    if (!this.stateFile) return
    try {
      const snapshot = {
        version: STATE_VERSION,
        savedAt: this.now(),
        rooms: [...this.rooms.values()].map((room) => {
          const encryptedKey = room.key && this.encryptRoomKey ? this.encryptRoomKey(room.key) : null
          return {
            roomId: room.roomId,
            title: room.title ?? friendlyName(room.roomId),
            createdAt: room.createdAt,
            hostSessionId: room.hostSessionId,
            policy: room.policy,
            members: [...room.members.values()].map(({ agent, ...rest }) => rest),
            messages: room.messages,
            tasks: [...room.tasks.values()],
            ...(room.mirror ? { mirror: room.mirror } : {}),
            ...(encryptedKey ? { keyEnc: encryptedKey } : room.key ? { key: room.key } : {}),
            creatorMemberId: room.creatorMemberId ?? null,
            creatorDeviceId: room.creatorDeviceId ?? null,
            coordinatorDeviceId: room.coordinatorDeviceId ?? null,
            coordinatorUpdatedAt: room.coordinatorUpdatedAt ?? 0,
            authorityDeviceId: room.authorityDeviceId ?? null,
            authorityRoomId: room.authorityRoomId ?? null,
            authorityEpoch: room.authorityEpoch ?? 0,
            authorityHeartbeatAt: room.authorityHeartbeatAt ?? 0,
          }
        }),
      }
      mkdirSync(dirname(this.stateFile), { recursive: true })
      const temporary = `${this.stateFile}.tmp`
      writeFileSync(temporary, JSON.stringify(snapshot, null, 2), 'utf8')
      renameSync(temporary, this.stateFile)
    } catch {
      /* persistence is best effort; the session log remains authoritative */
    }
  }

  /** Resolve a live agent for a persisted member on demand. */
  async ensureAgent(member) {
    if (member?.agent) return true
    if (!member?.sessionId || !this.sessionController?.resolveAgent) return false
    try {
      const resolved = await this.sessionController.resolveAgent(member.sessionId)
      if (!resolved?.agent) return false
      member.agent = resolved.agent
      return true
    } catch {
      return false
    }
  }

  async upgradeHost({ agent, policy = {} } = {}) {
    if (!agent?.session?.id) throw Object.assign(new Error('room upgrade needs the calling agent session'), { code: 'bad-request' })
    const sessionId = agent.session.id
    const existing = this.rooms.get(sessionId)
    if (existing) return this.summary(existing)
    const memberId = hostMemberId(sessionId)
    const room = {
      roomId: sessionId,
      title: friendlyName(sessionId),
      createdAt: this.now(),
      hostSessionId: sessionId,
      creatorMemberId: memberId,
      creatorDeviceId: this.replicaStore?.deviceId ?? null,
      coordinatorDeviceId: this.replicaStore?.deviceId ?? null,
      coordinatorUpdatedAt: this.now(),
      authorityDeviceId: this.replicaStore?.deviceId ?? null,
      authorityRoomId: sessionId,
      authorityEpoch: 0,
      authorityHeartbeatAt: 0,
      policy: { ...DEFAULT_POLICY, ...policy },
      members: new Map(),
      messages: [],
      tasks: new Map(),
      closed: false,
      key: createRoomKey(),
    }
    room.members.set(memberId, {
      memberId,
      role: 'host',      kind: 'local',
      sessionId,
      name: agent.session.header?.title ?? 'host',
      avatarKey: avatarKeyFor(memberId),
      agent,
    })
    this.rooms.set(sessionId, room)
    await this.append(room, 'room-created', { roomId: room.roomId, policy: room.policy, hostMemberId: memberId })
    this.emitReplica(room.roomId, 'room.created', { kind: 'system', memberId }, {
      title: room.title ?? friendlyName(sessionId),
      policy: room.policy,
      hostSessionId: sessionId,
      creatorMemberId: memberId,
      creatorDeviceId: room.creatorDeviceId,
      coordinatorDeviceId: room.coordinatorDeviceId,
      members: [this.memberSummary(room.members.get(memberId))],
    })
    return this.summary(room)
  }

  async addLocalParticipant({ roomId, name = 'worker', agentPreset, cwd } = {}) {
    const room = this.requireRoom(roomId)
    if (room.members.size >= room.policy.maxMembers) {
      throw Object.assign(new Error(`room member limit reached (${room.policy.maxMembers})`), { code: 'room-full' })
    }
    if (!this.sessionController?.create) {
      throw Object.assign(new Error('participant sessions are unavailable'), { code: 'unsupported' })
    }
    const created = await this.sessionController.create({
      ...(cwd ? { cwd } : {}),
      ...(agentPreset ? { agentPreset } : {}),
    })
    const sessionId = created?.sessionId
    if (!sessionId) throw Object.assign(new Error('could not create the participant session'), { code: 'room-participant-failed' })
    const resolved = await this.sessionController.resolveAgent(sessionId)
    if (!resolved?.agent) throw Object.assign(new Error('participant agent could not be resolved'), { code: 'room-participant-failed' })
    if (typeof this.sessionController.rename === 'function') {
      await this.sessionController.rename({ sessionId, title: `${room.title ?? friendlyName(roomId)} · ${name}` }).catch(() => {})
    }
    const memberId = localMemberId(sessionId)
    const member = { memberId, role: 'participant', kind: 'local', sessionId, name, avatarKey: avatarKeyFor(memberId), agent: resolved.agent }
    room.members.set(memberId, member)
    await this.append(room, 'room-member', {
      roomId: room.roomId,
      action: 'added',
      memberId,
      role: 'participant',
      name,
      sessionId,
    })
    const emitted = this.emitReplica(room.roomId, 'member.joined', this.memberActor(member), { member: this.memberSummary(member) })
    this.publishMirrorEvent(room, emitted)
    return this.memberSummary(member)
  }

  async removeMember({ roomId, memberId, reason = 'removed' } = {}) {    const room = this.requireRoom(roomId)
    const member = room.members.get(memberId)
    if (!member) throw Object.assign(new Error(`unknown member: ${String(memberId)}`), { code: 'unknown-member' })
    if (member.role === 'host') throw Object.assign(new Error('the host cannot be removed; close the room instead'), { code: 'forbidden' })
    room.members.delete(memberId)
    if (member.kind === 'remote' && room.key) room.key = createRoomKey()
    await this.append(room, 'room-member', { roomId: room.roomId, action: 'removed', memberId, reason })
    const emitted = this.emitReplica(room.roomId, 'member.left', { kind: 'system' }, { memberId, member: this.memberSummary(member), reason })
    this.publishMirrorEvent(room, emitted)
    return { roomId: room.roomId, memberId }
  }

  /**
   * Send one addressed message. The Host appends it to the canonical log and
   * wakes only the addressed local members (never the sender).
   */
  async send({ roomId, from, to, text, skipWakeFor = [] } = {}) {
    const room = this.requireRoom(roomId)
    this.assertAuthorityWritable(room)
    if (room.mirror) {
      if (typeof this.mirrorPublish === 'function') {
        // Phase 3 local-first mirror write: append locally and publish the event
        // asynchronously; the authority applies it when it receives the push.
        const local = await this.appendMirrorMessage({ roomId, from, to, text })
        void this.mirrorPublish(room, local).catch((error) => this.warn?.(`[device-fleet] mirror publish failed: ${String(error?.message ?? error)}`))
        const woken = []
        for (const memberId of local.message.to ?? []) {
          const member = room.members.get(memberId)
          if (!member) continue
          if (member.kind === 'remote') {
            if (member.role === 'host' || member.deviceId === this.replicaStore?.deviceId) continue
            if (typeof this.mirrorWakeRemote === 'function' && (await this.mirrorWakeRemote(room, member, local.message))) {
              woken.push(memberId)
            }
            continue
          }
          if (member.kind !== 'local' || member.role === 'host') continue
          if (await this.wake(room, member, local.message)) woken.push(memberId)
        }
        return { messageId: local.message.id, to: local.message.to, woken }
      }
      throw Object.assign(new Error('room mirror cannot send without replica publish'), { code: 'unsupported' })
    }
    const body = typeof text === 'string' ? text.trim() : ''
    if (body === '') throw Object.assign(new Error('room message needs text'), { code: 'bad-request' })
    if (body.length > MAX_MESSAGE_CHARS) throw Object.assign(new Error('room message is too long'), { code: 'bad-request' })
    const recipients = Array.isArray(to) ? to.filter((id) => typeof id === 'string') : []
    if (recipients.length === 0) throw Object.assign(new Error('room message needs at least one recipient'), { code: 'bad-request' })
    for (const memberId of recipients) {
      if (!room.members.has(memberId)) throw Object.assign(new Error(`unknown member: ${memberId}`), { code: 'unknown-member' })
    }
    const sender = this.resolveSender(room, from)
    const message = {
      id: randomUUID(),
      roomId: room.roomId,
      from: sender,
      to: recipients,
      text: body,
      createdAt: this.now(),
    }
    room.messages.push(message)
    await this.append(room, 'room-message', {
      roomId: room.roomId,
      messageId: message.id,
      from: sender,
      to: recipients,
      text: body,
    })
    const author = sender.kind === 'user'
      ? { kind: 'user', name: sender.name ?? 'user', ...(sender.viaDeviceId ? { viaDeviceId: sender.viaDeviceId } : {}) }
      : this.memberActor(room.members.get(sender.memberId))
    this.emitReplica(room.roomId, 'message', author, { message })
    const woken = []
    for (const memberId of recipients) {
      if (sender.memberId === memberId) continue
      if (skipWakeFor.includes(memberId)) continue
      const member = room.members.get(memberId)
      // The host is the local user-facing session; its Chat already owns user
      // input. Never inject Room messages into the host Chat.
      if (member?.role === 'host') continue
      if (member?.kind === 'remote') {
        if (typeof this.wakeRemote === 'function' && (await this.wakeRemote(room, member, message))) woken.push(memberId)
        continue
      }
      if (await this.wake(room, member, message)) woken.push(memberId)
    }
    return { messageId: message.id, to: recipients, woken }
  }

  /** Bind the persistent remote session created by the target device. */
  async setRemoteSessionId({ roomId, memberId, sessionId } = {}) {
    const room = this.requireRoom(roomId)
    const member = room.members.get(memberId)
    if (!member || member.kind !== 'remote') throw Object.assign(new Error(`unknown remote member: ${String(memberId)}`), { code: 'unknown-member' })
    if (typeof sessionId !== 'string' || sessionId === '') throw Object.assign(new Error('sessionId is required'), { code: 'bad-request' })
    member.remoteSessionId = sessionId
    this.persist()
    this.emitReplica(room.roomId, 'member.updated', this.memberActor(member), { member: this.memberSummary(member) })
    return this.memberSummary(member)
  }

  /** Create a local participant session that mirrors an authoritative Room on another device. */
  createMirror({ localSessionId, authority, snapshot = {} } = {}) {
    if (typeof localSessionId !== 'string' || localSessionId === '') throw Object.assign(new Error('localSessionId is required'), { code: 'bad-request' })
    if (!authority || typeof authority.deviceId !== 'string' || typeof authority.roomId !== 'string') {
      throw Object.assign(new Error('mirror authority is required'), { code: 'bad-request' })
    }
    const existing = this.rooms.get(localSessionId)
    if (existing) {
      if (existing.mirror) this.applyMirrorSnapshot({ roomId: localSessionId, snapshot })
      return this.summary(existing)
    }
    const members = new Map((Array.isArray(snapshot.members) ? snapshot.members : []).map((member) => [member.memberId, { ...member, agent: undefined }]))
    const room = {
      roomId: localSessionId,
      title: typeof snapshot.title === 'string' && snapshot.title !== '' ? snapshot.title : friendlyName(localSessionId),
      createdAt: Number.isFinite(snapshot.createdAt) ? snapshot.createdAt : this.now(),
      hostSessionId: localSessionId,
      policy: { ...DEFAULT_POLICY, ...(snapshot.policy ?? {}) },
      members,
      messages: Array.isArray(snapshot.messages) ? snapshot.messages : [],
      tasks: new Map((Array.isArray(snapshot.tasks) ? snapshot.tasks : []).map((task) => [task.id, task])),
      closed: false,
      creatorMemberId: snapshot.creatorMemberId ?? null,
      creatorDeviceId: snapshot.creatorDeviceId ?? null,
      coordinatorDeviceId: snapshot.coordinatorDeviceId ?? null,
      authorityDeviceId: snapshot.authorityDeviceId ?? authority.deviceId,
      authorityRoomId: snapshot.authorityRoomId ?? authority.roomId,
      authorityEpoch: Number.isFinite(snapshot.authorityEpoch) ? snapshot.authorityEpoch : 0,
      authorityHeartbeatAt: Number(snapshot.authorityHeartbeatAt) || 0,
      mirror: { deviceId: authority.deviceId, roomId: authority.roomId },
    }
    this.rooms.set(localSessionId, room)
    this.persist()
    this.emitReplica(localSessionId, 'room.created', { kind: 'system' }, {
      title: room.title ?? friendlyName(localSessionId),
      policy: room.policy,
      hostSessionId: localSessionId,
      mirror: room.mirror,
      members: [...room.members.values()].map((member) => this.memberSummary(member)),
    })
    if (Array.isArray(snapshot.messages) || Array.isArray(snapshot.tasks)) {
      this.emitReplica(localSessionId, 'room.snapshot', { kind: 'system' }, { snapshot })
    }
    const selfMember = Array.isArray(snapshot.members)
      ? snapshot.members.find((member) => member.remoteSessionId === localSessionId)
      : null
    this.replicaStore?.bindSession(localSessionId, {
      roomId: authority.roomId,
      memberId: selfMember?.memberId ?? `remote:${authority.deviceId}:${localSessionId}`,
      role: 'participant',
      kind: 'remote',
      deviceId: authority.deviceId,
    })
    return this.summary(room)
  }

  /** Replace a mirror's replicated state with the authority snapshot. */
  applyMirrorSnapshot({ roomId, snapshot } = {}) {
    const room = this.requireRoom(roomId)
    if (!room.mirror) throw Object.assign(new Error('not a mirror room'), { code: 'bad-request' })
    if (!snapshot || typeof snapshot !== 'object') return this.summary(room)
    if (Array.isArray(snapshot.members)) {
      room.members = new Map(snapshot.members.map((member) => [member.memberId, { ...member, agent: undefined }]))
    }
    if (snapshot.creatorMemberId !== undefined) room.creatorMemberId = snapshot.creatorMemberId
    if (snapshot.creatorDeviceId !== undefined) room.creatorDeviceId = snapshot.creatorDeviceId
    if (snapshot.coordinatorDeviceId !== undefined) room.coordinatorDeviceId = snapshot.coordinatorDeviceId
    if (Array.isArray(snapshot.messages)) room.messages = snapshot.messages
    if (Array.isArray(snapshot.tasks)) room.tasks = new Map(snapshot.tasks.map((task) => [task.id, task]))
    if (snapshot.policy) room.policy = { ...DEFAULT_POLICY, ...snapshot.policy }
    this.persist()
    return this.summary(room)
  }

  /**
   * Rebuild an archived Room from its local replica so it becomes an active,
   * writable Room again without restarting DSH (ADR-0030). An in-memory room is
   * simply reopened; a replica-only room is rehydrated from the replica state.
   * Content stays local; peers still need to join/sync through the normal paths.
   */
  restoreArchivedRoom({ roomId, snapshot = null } = {}) {
    if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
    const existing = this.rooms.get(roomId)
    const hostId = hostMemberId(roomId)
    if (existing) {
      existing.closed = false
      if (!existing.members.has(hostId)) {
        existing.members.set(hostId, {
          memberId: hostId,
          role: 'host',
          kind: 'local',
          sessionId: existing.hostSessionId ?? roomId,
          name: 'host',
          avatarKey: avatarKeyFor(hostId),
        })
      }
      this.persist()
      return this.summary(existing)
    }
    if (!snapshot || typeof snapshot !== 'object' || !Number.isFinite(Number(snapshot.createdAt))) {
      throw Object.assign(new Error('this Room has no local replica to restore'), { code: 'no-replica' })
    }
    const members = new Map(
      (Array.isArray(snapshot.members) ? snapshot.members : [])
        .filter((member) => member && typeof member.memberId === 'string')
        .map((member) => [member.memberId, { ...member, agent: undefined, avatarKey: member.avatarKey ?? avatarKeyFor(member.memberId) }]),
    )
    if (!members.has(hostId)) {
      members.set(hostId, {
        memberId: hostId,
        role: 'host',
        kind: 'local',
        sessionId: typeof snapshot.hostSessionId === 'string' ? snapshot.hostSessionId : roomId,
        name: 'host',
        avatarKey: avatarKeyFor(hostId),
      })
    }
    const mirror = snapshot.mirror && typeof snapshot.mirror === 'object' ? snapshot.mirror : null
    const room = {
      roomId,
      title: snapshot.title ?? friendlyName(roomId),
      createdAt: Number(snapshot.createdAt),
      hostSessionId: typeof snapshot.hostSessionId === 'string' ? snapshot.hostSessionId : roomId,
      policy: { ...DEFAULT_POLICY, ...(snapshot.policy ?? {}) },
      members,
      messages: (Array.isArray(snapshot.messages) ? snapshot.messages : []).map(({ fromLabel, ...message }) => message),
      tasks: new Map((Array.isArray(snapshot.tasks) ? snapshot.tasks : []).map((task) => [task.id, task])),
      closed: false,
      ...(mirror ? { mirror } : {}),
      creatorMemberId: snapshot.creatorMemberId ?? null,
      creatorDeviceId: snapshot.creatorDeviceId ?? null,
      coordinatorDeviceId: snapshot.coordinatorDeviceId ?? null,
      coordinatorUpdatedAt: Number(snapshot.coordinatorUpdatedAt) || 0,
      // A restored local Room becomes authority here (new epoch) so it can take
      // writes immediately; a mirror stays a mirror of its original authority.
      authorityDeviceId: mirror ? (snapshot.authorityDeviceId ?? mirror.deviceId) : (this.replicaStore?.deviceId ?? snapshot.authorityDeviceId ?? null),
      authorityRoomId: mirror ? (snapshot.authorityRoomId ?? mirror.roomId) : (snapshot.authorityRoomId ?? roomId),
      authorityEpoch: mirror ? Number(snapshot.authorityEpoch) || 0 : Math.max(0, Number(snapshot.authorityEpoch) || 0) + 1,
      authorityHeartbeatAt: mirror ? Number(snapshot.authorityHeartbeatAt) || 0 : this.now(),
    }
    this.rooms.set(roomId, room)
    this.persist()
    return this.summary(room)
  }

  /** Register a participant that lives on another Fleet device. */
  async addRemoteMember({ roomId, deviceId, name = 'remote', sessionId = null } = {}) {
    const room = this.requireRoom(roomId)
    if (typeof deviceId !== 'string' || deviceId === '') throw Object.assign(new Error('deviceId is required'), { code: 'bad-request' })
    if (room.members.size >= room.policy.maxMembers) {
      throw Object.assign(new Error(`room member limit reached (${room.policy.maxMembers})`), { code: 'room-full' })
    }
    // One participant session == one member; the legacy device-level id keeps
    // rooms created before this change readable.
    const memberId = typeof sessionId === 'string' && sessionId !== '' ? `remote:${deviceId}:${sessionId}` : `remote:${deviceId}`
    if (room.members.has(memberId)) return this.memberSummary(room.members.get(memberId))
    const member = { memberId, role: 'participant', kind: 'remote', deviceId, name, avatarKey: avatarKeyFor(memberId), ...(sessionId ? { remoteSessionId: sessionId } : {}) }
    room.members.set(memberId, member)
    await this.append(room, 'room-member', {
      roomId: room.roomId,
      action: 'added',
      memberId,
      role: 'participant',
      kind: 'remote',
      deviceId,
      ...(sessionId ? { remoteSessionId: sessionId } : {}),
      name,
    })
    this.persist()
    const emitted = this.emitReplica(room.roomId, 'member.joined', this.memberActor(member), { member: this.memberSummary(member) })
    this.publishMirrorEvent(room, emitted)
    return this.memberSummary(member)
  }

  /** Publish a replica event created by a local mirror write. */
  publishMirrorEvent(room, event) {
    if (!room?.mirror || !event || typeof this.mirrorPublish !== 'function') return
    void this.mirrorPublish(room, { event }).catch((error) => this.warn?.(`[device-fleet] mirror publish failed: ${String(error?.message ?? error)}`))
  }

  /**
   * Append one message to a local mirror Room and emit its replica event.
   * The authority receives the event through mirrorPublish / the next sync.
   */
  async appendMirrorMessage({ roomId, from, to, text } = {}) {
    const room = this.requireRoom(roomId)
    if (!room.mirror) throw Object.assign(new Error('not a mirror room'), { code: 'unsupported' })
    const body = typeof text === 'string' ? text.trim() : ''
    if (body === '') throw Object.assign(new Error('room message needs text'), { code: 'bad-request' })
    if (body.length > MAX_MESSAGE_CHARS) throw Object.assign(new Error('room message is too long'), { code: 'bad-request' })
    const recipients = Array.isArray(to) ? to.filter((id) => typeof id === 'string') : []
    if (recipients.length === 0) throw Object.assign(new Error('room message needs at least one recipient'), { code: 'bad-request' })
    for (const memberId of recipients) {
      if (!room.members.has(memberId)) throw Object.assign(new Error(`unknown member: ${memberId}`), { code: 'unknown-member' })
    }
    const sender = this.resolveSender(room, from)
    if (sender.kind === 'user' && !sender.viaDeviceId && this.replicaStore?.deviceId) sender.viaDeviceId = this.replicaStore.deviceId
    const message = { id: randomUUID(), roomId: room.roomId, from: sender, to: recipients, text: body, createdAt: this.now() }
    room.messages.push(message)
    this.persist()
    const author = sender.kind === 'user'
      ? { kind: 'user', name: 'user', ...(sender.viaDeviceId ? { deviceId: sender.viaDeviceId } : {}) }
      : this.memberActor(room.members.get(sender.memberId))
    const event = this.emitReplica(room.roomId, 'message', author, { message })
    return { message, event }
  }

  /** Apply events imported from another replica (message/task/member/policy). */
  async applyExternalEvents(roomId, events = []) {
    const room = this.rooms.get(roomId)
    if (!room || !Array.isArray(events)) return 0
    const existingMessages = new Set(room.messages.map((message) => message.id))
    let applied = 0
    for (const event of events) {
      const payload = event?.payload ?? {}
      switch (event?.type) {
        case 'message': {
          const message = payload.message
          if (!message?.id || existingMessages.has(message.id)) break
          const author = event.author ?? {}
          let sender = null
          if (author.kind === 'user') sender = { kind: 'user', name: 'user', ...(author.deviceId ? { viaDeviceId: author.deviceId } : {}) }
          else if (author.memberId && room.members.has(author.memberId)) sender = { kind: 'agent', memberId: author.memberId, name: room.members.get(author.memberId).name ?? 'agent' }
          if (!sender) break
          const imported = { ...message, roomId: room.roomId, from: sender }
          room.messages.push(imported)
          existingMessages.add(imported.id)
          applied += 1
          for (const recipientId of Array.isArray(imported.to) ? imported.to : []) {
            const recipient = room.members.get(recipientId)
            if (!recipient || recipient.role === 'host' || recipient.memberId === author.memberId) continue
            if (recipient.kind === 'remote') {
              if (typeof this.wakeRemote === 'function') await this.wakeRemote(room, recipient, imported)
            } else {
              await this.wake(room, recipient, imported)
            }
          }
          break
        }
        case 'task.added':
        case 'task.updated': {
          if (payload.task?.id && this.mergeExternalTask(room, payload.task, event)) applied += 1
          break
        }
        case 'member.joined': {
          const member = payload.member
          if (!member?.memberId || room.members.has(member.memberId)) break
          const originDevice = event.origin ?? event.deviceId ?? null
          const originIsLocal = !originDevice || originDevice === this.replicaStore?.deviceId
          const normalized = member.kind === 'local' && !originIsLocal
            ? { ...member, kind: 'remote', deviceId: originDevice, sessionId: undefined, remoteSessionId: member.sessionId ?? member.remoteSessionId ?? null, agent: undefined }
            : { ...member, agent: undefined }
          room.members.set(member.memberId, normalized)
          applied += 1
          break
        }
        case 'member.left':
        case 'member.removed': {
          const memberId = payload.memberId ?? payload.member?.memberId
          if (!memberId || memberId === hostMemberId(room.hostSessionId)) break
          const removed = room.members.get(memberId)
          if (room.members.delete(memberId)) applied += 1
          // Rotate the invitation key when a remote member leaves/is removed.
          if (removed?.kind === 'remote' && room.key) room.key = createRoomKey()
          break
        }
        case 'policy.updated': {
          if (!payload.policy) break
          const remoteAt = Number(payload.updatedAt ?? event.createdAt ?? 0)
          const localAt = Number(room.policyUpdatedAt ?? 0)
          if (remoteAt <= localAt) break
          room.policy = { ...DEFAULT_POLICY, ...payload.policy }
          room.policyUpdatedAt = remoteAt
          applied += 1
          break
        }
        case 'room.coordinator': {
          const remoteAt = Number(payload.updatedAt ?? event.createdAt ?? 0)
          if (remoteAt <= Number(room.coordinatorUpdatedAt ?? 0)) break
          room.coordinatorDeviceId = payload.coordinatorDeviceId ?? room.coordinatorDeviceId
          room.coordinatorUpdatedAt = remoteAt
          applied += 1
          break
        }
        case 'room.authority': {
          const remoteEpoch = Number(payload.epoch ?? 0)
          const localEpoch = Number(room.authorityEpoch ?? 0)
          const remoteDevice = typeof payload.authorityDeviceId === 'string' ? payload.authorityDeviceId : null
          if (!remoteDevice) break
          if (remoteEpoch < localEpoch) break
          if (remoteEpoch === localEpoch && remoteDevice <= String(room.authorityDeviceId ?? '')) break
          room.authorityDeviceId = remoteDevice
          room.authorityRoomId = typeof payload.authorityRoomId === 'string' ? payload.authorityRoomId : room.authorityRoomId
          room.authorityEpoch = remoteEpoch
          const localDevice = this.replicaStore?.deviceId ?? null
          if (remoteDevice !== localDevice) {
            // A higher-epoch authority claim demotes the old authority to a
            // mirror, not merely updating the metadata fields.
            room.mirror = { deviceId: remoteDevice, roomId: room.authorityRoomId }
            room.authorityHeartbeatAt = 0
          } else if (room.mirror) {
            room.mirror = { deviceId: remoteDevice, roomId: room.authorityRoomId }
          }
          applied += 1
          break
        }
        case 'room.creator': {
          room.creatorMemberId = payload.creatorMemberId ?? room.creatorMemberId
          room.creatorDeviceId = payload.creatorDeviceId ?? room.creatorDeviceId
          room.coordinatorDeviceId = payload.coordinatorDeviceId ?? room.coordinatorDeviceId
          applied += 1
          break
        }
        default:
          break
      }
    }
    if (applied > 0) this.persist()
    return applied
  }

  /** Append a reply produced by a remote participant and wake only its addressee. */
  async recordRemoteReply({ roomId, memberId, text, to = null } = {}) {
    const room = this.requireRoom(roomId)
    const member = room.members.get(memberId)
    if (!member || member.kind !== 'remote') throw Object.assign(new Error(`unknown remote member: ${String(memberId)}`), { code: 'unknown-member' })
    const body = typeof text === 'string' ? text.trim() : ''
    if (body === '') throw Object.assign(new Error('remote reply needs text'), { code: 'bad-request' })
    if (body.length > MAX_MESSAGE_CHARS) throw Object.assign(new Error('remote reply is too long'), { code: 'bad-request' })
    const requested = Array.isArray(to) ? to.filter((id) => typeof id === 'string' && room.members.has(id) && id !== memberId) : []
    const recipients = requested.length > 0 ? requested : [hostMemberId(room.hostSessionId)]
    const message = {
      id: randomUUID(),
      roomId: room.roomId,
      from: { kind: 'agent', memberId, name: member.name },
      to: recipients,
      text: body,
      createdAt: this.now(),
    }
    room.messages.push(message)
    await this.append(room, 'room-message', { roomId: room.roomId, messageId: message.id, from: message.from, to: recipients, text: body })
    this.emitReplica(room.roomId, 'message', this.memberActor(member), { message })
    const woken = []
    for (const recipientId of recipients) {
      const recipient = room.members.get(recipientId)
      if (!recipient || recipient.kind !== 'local' || recipient.role === 'host') continue
      if (await this.wake(room, recipient, message)) woken.push(recipientId)
    }
    return { messageId: message.id, to: recipients, woken }
  }

  resolveSender(room, from) {
    if (from && typeof from === 'object') {
      if (typeof from.memberId === 'string') {
        const member = room.members.get(from.memberId)
        if (!member) throw Object.assign(new Error(`unknown sender member: ${from.memberId}`), { code: 'unknown-member' })
        return { kind: 'agent', memberId: member.memberId, name: member.name ?? 'agent' }
      }
      if (typeof from.sessionId === 'string') {
        for (const member of room.members.values()) {
          if (member.sessionId === from.sessionId || member.remoteSessionId === from.sessionId) {
            return { kind: 'agent', memberId: member.memberId, name: member.name ?? 'agent' }
          }
        }
        throw Object.assign(new Error(`sender session is not a room member: ${from.sessionId}`), { code: 'unknown-member' })
      }
      if (from.kind === 'user') return { kind: 'user', name: 'user', ...(typeof from.viaDeviceId === 'string' ? { viaDeviceId: from.viaDeviceId } : {}) }
    }
    return { kind: 'user', name: 'user' }
  }

  /** Wake one local participant by injecting the addressed message. */
  async wake(room, member, message) {
    if (!member || typeof this.createUserMessage !== 'function') return false
    if (!(await this.ensureAgent(member))) return false
    if (typeof member.agent?.followup !== 'function') return false
    // Participant replies are rendered by the Room view; do not inject them into
    // the Host's normal Chat stream (that caused the host agent to relay them).
    if (member.role === 'host' && message.from.kind !== 'user') return false
    const senderLabel = message.from.kind === 'user' ? 'user' : (message.from.name ?? 'agent')
    // A user sender has no member id; the reply target is always the Host member.
    const replyTarget = message.from.memberId ?? hostMemberId(room.hostSessionId)
    const roster = [...room.members.values()]
      .map((entry) => `${entry.name}${entry.role === 'host' ? ' (host)' : ''}${entry.kind === 'remote' ? ' [remote]' : ''}`)
      .join(', ')
    const assigned = [...room.tasks.values()]
      .filter((task) => task.owner === member.memberId && task.status !== 'done')
      .map((task) => `"${task.title}" (${task.status})`)
    // The host is the user's own session: deliver a plain attributed line into
    // the normal Chat stream instead of an agent-to-agent reply instruction.
    const text =
      member.role === 'host'
        ? `[Room] ${senderLabel}: ${message.text}`
        : [
            `[Fleet Room ${room.roomId}] ${senderLabel} → you:`,
            message.text,
            '',
            `Room members: ${roster}.`,
            ...(assigned.length > 0 ? [`Assigned tasks: ${assigned.join(', ')}.`] : []),
            `Reply with room_send (roomId="${room.roomId}", to=["${replyTarget}"]) when you have an answer.`,
          ].join('\n')
    const userMessage = this.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    try {
      member.agent.followup(userMessage)
      return true
    } catch {
      return false
    }
  }

  /**
   * Append one Room record to the Host session log as an ignorable plugin
   * record (`plugin:device-fleet/<name>`). Unknown types would otherwise make
   * the persisted session unreadable for every harness that does not declare
   * them, including the one that wrote it.
   * @param {object} room the Room
   * @param {string} name record name without the plugin prefix, e.g. `room-created`
   * @param {object} data JSON payload
   */
  async append(room, name, data) {
    const host = room.members.get(hostMemberId(room.hostSessionId))
    const session = host?.agent?.session
    if (session) {
      try {
        await this.appendRecord(session, `${ROOM_RECORD_PREFIX}${name}`, data)
      } catch (error) {
        if (!this.recordWarningIssued) {
          this.recordWarningIssued = true
          this.warn(`[device-fleet] room record not written to the session log: ${String(error?.message ?? error)}`)
        }
      }
    }
    this.persist()
  }

  createInvite({ roomId, ttlMs = 24 * 60 * 60 * 1000, note = '' } = {}) {
    const room = this.requireRoom(roomId)
    if (room.mirror) throw Object.assign(new Error('room invites must be created on the authority device'), { code: 'unsupported' })
    if (!room.key) {
      room.key = createRoomKey()
      this.persist()
    }
    return encodeRoomInvite({ roomId: room.roomId, key: room.key, deviceId: this.replicaStore?.deviceId ?? null, ttlMs, note, sign: this.signInvite })
  }

  validateInvite({ code } = {}) {
    const payload = decodeRoomInvite(code, { verify: this.verifyInvite, requireSignature: Boolean(this.verifyInvite) })
    const room = this.requireRoom(payload.roomId)
    if (room.mirror) throw Object.assign(new Error('room invites must be validated on the authority device'), { code: 'unsupported' })
    if (!room.key || room.key !== payload.key) throw Object.assign(new Error('invite key does not match this Room'), { code: 'invite-invalid' })
    return { ...payload, room }
  }

  /** Remove every remote member owned by a Fleet device (device removed cascade). */
  async removeDeviceMembers({ roomId, deviceId, reason = 'device removed from Fleet' } = {}) {
    const room = this.requireRoom(roomId)
    if (typeof deviceId !== 'string' || deviceId === '') throw Object.assign(new Error('deviceId is required'), { code: 'bad-request' })
    const removed = [...room.members.values()].filter((member) => member.deviceId === deviceId)
    for (const member of removed) {
      room.members.delete(member.memberId)
      this.emitReplica(room.roomId, 'member.left', { kind: 'system' }, { memberId: member.memberId, member: this.memberSummary(member), reason })
    }
    if (removed.length > 0) {
      if (room.key) room.key = createRoomKey()
      this.persist()
    }
    return { roomId: room.roomId, deviceId, removed: removed.map((member) => member.memberId) }
  }

  /** One-time metadata backfill for Rooms created before creator/coordinator/authority fields. */
  backfillCreatorMetadata() {
    let repaired = 0
    for (const room of this.rooms.values()) {
      if (room.mirror) continue
      let changed = false
      if (!room.creatorMemberId) {
        room.creatorMemberId = hostMemberId(room.hostSessionId)
        room.creatorDeviceId = this.replicaStore?.deviceId ?? null
        room.coordinatorDeviceId = room.coordinatorDeviceId ?? this.replicaStore?.deviceId ?? null
        room.coordinatorUpdatedAt = room.coordinatorUpdatedAt ?? this.now()
        const emitted = this.emitReplica(room.roomId, 'room.creator', { kind: 'system' }, {
          creatorMemberId: room.creatorMemberId,
          creatorDeviceId: room.creatorDeviceId,
          coordinatorDeviceId: room.coordinatorDeviceId,
          updatedAt: this.now(),
        })
        this.publishMirrorEvent(room, emitted)
        changed = true
      }
      if (!room.authorityDeviceId) {
        room.authorityDeviceId = this.replicaStore?.deviceId ?? room.creatorDeviceId ?? null
        room.authorityRoomId = room.roomId
        room.authorityEpoch = Number(room.authorityEpoch ?? 0)
        const emitted = this.emitReplica(room.roomId, 'room.authority', { kind: 'system' }, {
          authorityDeviceId: room.authorityDeviceId,
          authorityRoomId: room.authorityRoomId,
          epoch: room.authorityEpoch,
          previousDeviceId: null,
          reason: 'backfill',
          updatedAt: this.now(),
        })
        this.publishMirrorEvent(room, emitted)
        changed = true
      }
      if (changed) repaired += 1
    }
    if (repaired > 0) this.persist()
    return repaired
  }

  /** Set the Room coordinator device (LWW metadata, Phase 7). */
  async updateCoordinator({ roomId, deviceId } = {}) {
    const room = this.requireRoom(roomId)
    if (typeof deviceId !== 'string' || deviceId === '') throw Object.assign(new Error('deviceId is required'), { code: 'bad-request' })
    room.coordinatorDeviceId = deviceId
    room.coordinatorUpdatedAt = this.now()
    this.persist()
    const emitted = this.emitReplica(room.roomId, 'room.coordinator', { kind: 'system' }, { coordinatorDeviceId: deviceId, updatedAt: room.coordinatorUpdatedAt })
    this.publishMirrorEvent(room, emitted)
    return this.summary(room)
  }

  async updateAuthority({ roomId, authorityDeviceId, authorityRoomId = null, epoch = null, reason = 'authority-transfer' } = {}) {
    const room = this.requireRoom(roomId)
    if (room.mirror) throw Object.assign(new Error('authority transfer must be issued by the current authority'), { code: 'forbidden' })
    if (typeof authorityDeviceId !== 'string' || authorityDeviceId === '') throw Object.assign(new Error('authorityDeviceId is required'), { code: 'bad-request' })
    const nextEpoch = Number.isFinite(epoch) ? Number(epoch) : Number(room.authorityEpoch ?? 0) + 1
    if (nextEpoch <= Number(room.authorityEpoch ?? 0)) throw Object.assign(new Error('authority epoch must increase'), { code: 'bad-request' })
    const previousDeviceId = room.authorityDeviceId
    room.authorityDeviceId = authorityDeviceId
    room.authorityRoomId = typeof authorityRoomId === 'string' && authorityRoomId !== '' ? authorityRoomId : room.roomId
    room.authorityEpoch = nextEpoch
    this.persist()
    const emitted = this.emitReplica(room.roomId, 'room.authority', { kind: 'system' }, {
      authorityDeviceId,
      authorityRoomId: room.authorityRoomId,
      epoch: nextEpoch,
      previousDeviceId,
      reason,
      updatedAt: this.now(),
    })
    this.publishMirrorEvent(room, emitted)
    return this.summary(room)
  }

  /**
   * Claim authority after the current authority is gone. Every claim raises the
   * epoch; peers converge through the same room.authority LWW rule and the old
   * authority's writes are rejected by assertAuthorityWritable().
   */
  async claimAuthority({ roomId, deviceId = this.replicaStore?.deviceId, reason = 'authority-claim' } = {}) {
    const room = this.requireRoom(roomId)
    if (room.mirror) throw Object.assign(new Error('a mirror cannot claim authority without a promoted replica'), { code: 'unsupported' })
    if (typeof deviceId !== 'string' || deviceId === '') throw Object.assign(new Error('deviceId is required'), { code: 'bad-request' })
    const nextEpoch = Math.max(Number(room.authorityEpoch ?? 0), Number(room.mirror?.authorityEpoch ?? 0)) + 1
    const previousDeviceId = room.authorityDeviceId
    room.authorityDeviceId = deviceId
    room.authorityRoomId = room.authorityRoomId ?? room.roomId
    room.authorityEpoch = nextEpoch
    this.persist()
    const emitted = this.emitReplica(room.roomId, 'room.authority', { kind: 'system' }, {
      authorityDeviceId: deviceId,
      authorityRoomId: room.roomId,
      epoch: nextEpoch,
      previousDeviceId,
      reason,
      updatedAt: this.now(),
    })
    this.publishMirrorEvent(room, emitted)
    return this.summary(room)
  }

  /** Record an authority heartbeat from the current authority device. */
  noteAuthorityHeartbeat({ roomId, deviceId, epoch = null } = {}) {
    const room = this.rooms.get(roomId)
    if (!room || room.authorityDeviceId !== deviceId) return false
    const seen = Number(epoch)
    if (Number.isFinite(seen) && seen < Number(room.authorityEpoch ?? 0)) return false
    room.authorityHeartbeatAt = this.now()
    if (Number.isFinite(seen) && seen > Number(room.authorityEpoch ?? 0)) {
      room.authorityEpoch = seen
      this.persist()
    }
    return true
  }

  /**
   * Promote a mirror to authority after the old authority is unreachable.
   * The logical authorityRoomId is preserved so event signatures from the old
   * authority stay verifiable; the local host session becomes the new host.
   */
  async promoteMirrorToAuthority({ roomId, automatic = false } = {}) {
    const room = this.requireRoom(roomId)
    if (!room.mirror) throw Object.assign(new Error('only a mirror can be promoted'), { code: 'unsupported' })
    if (automatic) {
      const localDeviceId = this.replicaStore?.deviceId
      if (!room.authorityHeartbeatAt) throw Object.assign(new Error('authority heartbeat has never been seen'), { code: 'no-heartbeat' })
      if (this.now() - Number(room.authorityHeartbeatAt) < 15_000) throw Object.assign(new Error('authority heartbeat is not stale yet'), { code: 'not-stale' })
      if (room.coordinatorDeviceId && room.coordinatorDeviceId !== localDeviceId) throw Object.assign(new Error('local device is not the Room coordinator'), { code: 'not-coordinator' })
    }
    const localSessionId = room.roomId
    const localDeviceId = this.replicaStore?.deviceId
    if (!localDeviceId) throw Object.assign(new Error('local device id is unavailable'), { code: 'unsupported' })
    const oldAuthorityDeviceId = room.mirror.deviceId
    const oldAuthorityRoomId = room.mirror.roomId
    const oldHostSessionId = room.hostSessionId
    const oldHostMemberId = hostMemberId(oldHostSessionId)
    const selfMember = [...room.members.values()].find((member) => member.remoteSessionId === localSessionId)
    if (selfMember) room.members.delete(selfMember.memberId)
    const oldHost = room.members.get(oldHostMemberId)
    if (oldHost) {
      room.members.set(oldHostMemberId, {
        ...oldHost,
        kind: 'remote',
        deviceId: oldAuthorityDeviceId,
        sessionId: undefined,
        remoteSessionId: oldHostSessionId,
      })
    }
    for (const member of room.members.values()) {
      if (member.memberId === oldHostMemberId) continue
      if (member.kind === 'local' && !member.deviceId) {
        member.kind = 'remote'
        member.deviceId = oldAuthorityDeviceId
      }
    }
    const resolved = this.sessionController?.resolveAgent
      ? await this.sessionController.resolveAgent(localSessionId).catch(() => null)
      : null
    const hostId = hostMemberId(localSessionId)
    room.members.set(hostId, {
      memberId: hostId,
      role: 'host',
      kind: 'local',
      sessionId: localSessionId,
      name: resolved?.agent?.session?.header?.title ?? 'host',
      avatarKey: 'host',
      ...(resolved?.agent ? { agent: resolved.agent } : {}),
    })
    room.mirror = null
    room.hostSessionId = localSessionId
    room.authorityDeviceId = localDeviceId
    room.authorityRoomId = oldAuthorityRoomId
    room.authorityEpoch = Number(room.authorityEpoch ?? 0) + 1
    room.authorityHeartbeatAt = this.now()
    this.persist()
    this.emitReplica(room.roomId, 'room.authority', { kind: 'system' }, {
      authorityDeviceId: localDeviceId,
      authorityRoomId: oldAuthorityRoomId,
      epoch: room.authorityEpoch,
      previousDeviceId: oldAuthorityDeviceId,
      reason: 'mirror-promotion',
      updatedAt: this.now(),
    })
    return this.summary(room)
  }

  /**
   * Demote this authority Room after a higher-epoch claim from another member.
   * The local session remains bound; future sends go through the mirror path.
   */
  async downgradeToMirror({ roomId, authorityDeviceId, authorityRoomId = null, epoch } = {}) {
    const room = this.requireRoom(roomId)
    const nextEpoch = Number(epoch)
    if (!Number.isFinite(nextEpoch) || nextEpoch <= Number(room.authorityEpoch ?? 0)) {
      throw Object.assign(new Error('claim epoch must increase'), { code: 'bad-request' })
    }
    room.mirror = { deviceId: authorityDeviceId, roomId: typeof authorityRoomId === 'string' && authorityRoomId !== '' ? authorityRoomId : room.roomId }
    room.authorityDeviceId = authorityDeviceId
    room.authorityRoomId = room.mirror.roomId
    room.authorityEpoch = nextEpoch
    room.authorityHeartbeatAt = 0
    this.persist()
    this.emitReplica(room.roomId, 'room.authority', { kind: 'system' }, {
      authorityDeviceId,
      authorityRoomId: room.authorityRoomId,
      epoch: nextEpoch,
      previousDeviceId: this.replicaStore?.deviceId ?? null,
      reason: 'demoted-to-mirror',
      updatedAt: this.now(),
    })
    return this.summary(room)
  }

  async updatePolicy({ roomId, policy } = {}) {
    const room = this.requireRoom(roomId)
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw Object.assign(new Error('policy object is required'), { code: 'bad-request' })
    const merged = { ...room.policy, ...policy, maxMembers: Number(policy.maxMembers ?? room.policy.maxMembers) }
    if (!Number.isFinite(merged.maxMembers) || merged.maxMembers < 1) throw Object.assign(new Error('maxMembers must be a positive number'), { code: 'bad-request' })
    room.policy = merged
    room.policyUpdatedAt = this.now()
    this.persist()
    const emitted = this.emitReplica(room.roomId, 'policy.updated', { kind: 'system' }, { policy: merged, updatedAt: room.policyUpdatedAt })
    this.publishMirrorEvent(room, emitted)
    return this.summary(room)
  }

  fieldVersion(by = null) {
    return { at: this.now(), by }
  }

  compareFieldVersion(left, right) {
    const leftAt = Number(left?.at ?? 0)
    const rightAt = Number(right?.at ?? 0)
    if (leftAt !== rightAt) return leftAt - rightAt
    return String(left?.by ?? '').localeCompare(String(right?.by ?? ''))
  }

  /** Field-level LWW merge for one external task event. */
  mergeExternalTask(room, remote, event) {
    const current = room.tasks.get(remote.id)
    if (!current) {
      const at = Number(remote.updatedAt ?? event.createdAt ?? this.now())
      const fieldVersions = remote.fieldVersions ?? Object.fromEntries(
        ['title', 'description', 'owner', 'status', 'dependsOn'].filter((field) => field in remote).map((field) => [field, { at, by: event.author?.memberId ?? null }]),
      )
      room.tasks.set(remote.id, { ...remote, roomId: room.roomId, fieldVersions })
      return true
    }
    const fields = ['title', 'description', 'owner', 'status', 'note']
    const merged = { ...current, fieldVersions: { ...(current.fieldVersions ?? {}) } }
    let changed = false
    for (const field of fields) {
      if (!(field in remote)) continue
      const remoteVersion = remote.fieldVersions?.[field] ?? { at: remote.updatedAt ?? event.createdAt ?? 0, by: event.author?.memberId ?? null }
      const localVersion = current.fieldVersions?.[field] ?? { at: current.updatedAt ?? 0, by: null }
      if (this.compareFieldVersion(remoteVersion, localVersion) > 0) {
        merged[field] = remote[field]
        merged.fieldVersions[field] = remoteVersion
        changed = true
      }
    }
    // dependsOn is an add-only OR-Set: union, never LWW.
    const dependencies = [...new Set([...(current.dependsOn ?? []), ...(remote.dependsOn ?? [])])]
    if (dependencies.length !== (current.dependsOn ?? []).length) {
      merged.dependsOn = dependencies
      changed = true
    }
    if (changed) {
      merged.updatedAt = Math.max(Number(current.updatedAt ?? 0), Number(remote.updatedAt ?? 0))
      room.tasks.set(remote.id, merged)
    }
    return changed
  }

  // --------------------------------------------------------------- room tasks

  async addTask({ roomId, title, owner, dependsOn = [], description = '' } = {}) {
    const room = this.requireRoom(roomId)
    this.assertAuthorityWritable(room)
    if (typeof title !== 'string' || title.trim() === '') throw Object.assign(new Error('task needs a title'), { code: 'bad-request' })
    const ownerMember = room.members.get(owner)
    if (!ownerMember) throw Object.assign(new Error(`unknown task owner: ${String(owner)}`), { code: 'unknown-member' })
    const id = randomUUID()
    const at = this.now()
    const version = (field) => ({ at, by: owner })
    const task = {
      id,
      roomId: room.roomId,
      title: title.trim(),
      description,
      owner,
      status: 'pending',
      dependsOn: Array.isArray(dependsOn) ? dependsOn : [],
      readyNotified: false,
      fieldVersions: { title: version('title'), description: version('description'), owner: version('owner'), status: version('status'), dependsOn: version('dependsOn') },
      createdAt: at,
      updatedAt: at,
    }
    room.tasks.set(id, task)
    await this.append(room, 'room-task', { roomId: room.roomId, action: 'added', task })
    const emitted = this.emitReplica(room.roomId, 'task.added', { kind: 'member', memberId: owner }, { task })
    this.publishMirrorEvent(room, emitted)
    return task
  }

  async updateTask({ roomId, id, status, note, owner } = {}) {
    const room = this.requireRoom(roomId)
    this.assertAuthorityWritable(room)
    const task = room.tasks.get(id)
    if (!task) throw Object.assign(new Error(`unknown task: ${String(id)}`), { code: 'unknown-task' })
    const allowed = ['pending', 'running', 'done', 'blocked']
    if (status !== undefined && !allowed.includes(status)) {
      throw Object.assign(new Error(`invalid task status: ${String(status)}`), { code: 'bad-request' })
    }
    if (owner !== undefined && !room.members.has(owner)) {
      throw Object.assign(new Error(`unknown task owner: ${String(owner)}`), { code: 'unknown-member' })
    }
    const at = this.now()
    task.fieldVersions = { ...(task.fieldVersions ?? {}) }
    if (status !== undefined) {
      task.status = status
      task.fieldVersions.status = { at, by: null }
    }
    if (owner !== undefined) {
      task.owner = owner
      task.fieldVersions.owner = { at, by: null }
    }
    if (typeof note === 'string' && note !== '') {
      task.note = note
      task.fieldVersions.note = { at, by: null }
    }
    task.updatedAt = at
    await this.append(room, 'room-task', { roomId: room.roomId, action: 'updated', task })
    const emitted = this.emitReplica(room.roomId, 'task.updated', { kind: 'system' }, { task })
    this.publishMirrorEvent(room, emitted)
    let handedOff = []
    if (status === 'done') handedOff = await this.handOffReady(room)
    return { task, handedOff }
  }

  /** Wake owners of pending tasks whose dependencies all completed. */
  async handOffReady(room) {
    const ready = []
    for (const task of room.tasks.values()) {
      if (task.status !== 'pending' || task.readyNotified) continue
      if (task.dependsOn.length === 0) continue
      const depsDone = task.dependsOn.every((dep) => room.tasks.get(dep)?.status === 'done')
      if (!depsDone) continue
      task.readyNotified = true
      task.updatedAt = this.now()
      const owner = room.members.get(task.owner)
      const message = {
        id: randomUUID(),
        roomId: room.roomId,
        from: { kind: 'user', name: 'room' },
        to: [task.owner],
        text: `任务 "${task.title}" 的前置任务已完成，现在可以开始。`,
        createdAt: this.now(),
      }
      room.messages.push(message)
      await this.append(room, 'room-message', { roomId: room.roomId, messageId: message.id, from: message.from, to: message.to, text: message.text })
      this.emitReplica(room.roomId, 'message', { kind: 'system' }, { message })
      const woken = owner ? await this.wake(room, owner, message) : false
      ready.push({ taskId: task.id, owner: task.owner, woken })
    }
    return ready
  }

  listTasks(roomId) {
    const room = this.requireRoom(roomId)
    return [...room.tasks.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  // ------------------------------------------------------------------- reads

  messages({ roomId, limit = 50 } = {}) {
    const room = this.requireRoom(roomId)
    const items = room.messages.slice(-Math.max(1, Math.min(limit, 200)))
    return items.map((message) => {
      const member = message.from?.memberId ? room.members.get(message.from.memberId) : null
      return {
        ...message,
        fromLabel: message.from?.kind === 'user'
          ? '用户'
          : member ? memberDisplayName(member) : (message.from?.name ?? '成员'),
      }
    })
  }

  summary(room) {
    return {
      roomId: room.roomId,
      title: room.title ?? friendlyName(room.roomId),
      createdAt: room.createdAt,
      closed: room.closed,
      policy: { ...room.policy },
      members: [...room.members.values()].map((member) => this.memberSummary(member)),
      messageCount: room.messages.length,
      tasks: this.listTasks(room.roomId).length,
      creatorMemberId: room.creatorMemberId ?? null,
      creatorDeviceId: room.creatorDeviceId ?? null,
      coordinatorDeviceId: room.coordinatorDeviceId ?? null,
      authorityDeviceId: room.authorityDeviceId ?? null,
      authorityRoomId: room.authorityRoomId ?? null,
      authorityEpoch: room.authorityEpoch ?? 0,
      authorityHeartbeatAt: room.authorityHeartbeatAt ?? 0,
    }
  }

  memberSummary(member) {
    return {
      memberId: member.memberId,
      displayName: memberDisplayName(member),
      role: member.role,
      kind: member.kind,
      sessionId: member.sessionId,
      deviceId: member.deviceId,
      remoteSessionId: member.remoteSessionId,
      name: member.name,
      avatarKey: member.avatarKey ?? avatarKeyFor(member.memberId),
    }
  }

  status(roomId) {
    return this.summary(this.requireRoom(roomId))
  }

  /** All active rooms (UI list). */
  list() {
    return [...this.rooms.values()].map((room) => this.summary(room))
  }

  /** One room plus its transcript and board (UI detail). */
  detail(roomId, { limit = 100 } = {}) {
    const room = this.requireRoom(roomId)
    return {
      ...this.summary(room),
      messages: this.messages({ roomId, limit }),
      tasks: this.listTasks(roomId),
    }
  }

  /** All open rooms (for cleanup and diagnostics). */
  openRooms() {
    return [...this.rooms.keys()]
  }

  async close({ roomId, reason = 'closed by host' } = {}) {
    const room = this.requireRoom(roomId)
    room.closed = true
    await this.append(room, 'room-closed', { roomId: room.roomId, reason, closedAt: this.now() })
    this.emitReplica(room.roomId, 'room.closed', { kind: 'system' }, { reason, closedAt: this.now() })
    const closedRoom = room
    this.rooms.delete(room.roomId)
    this.persist()
    if (typeof this.onClosed === 'function') {
      try {
        await this.onClosed(closedRoom)
      } catch (error) {
        this.warn?.(`[device-fleet] room close notification failed: ${String(error?.message ?? error)}`)
      }
    }
    return { roomId: room.roomId, closed: true }
    return { roomId: room.roomId, closed: true, reason }
  }

  requireRoom(roomId) {
    const room = this.rooms.get(roomId)
    if (!room) throw Object.assign(new Error(`unknown or closed room: ${String(roomId)}`), { code: 'unknown-room' })
    return room
  }

  assertAuthorityWritable(room) {
    if (room.mirror) return
    const authority = room.authorityDeviceId
    const localDevice = this.replicaStore?.deviceId
    if (authority && localDevice && authority !== localDevice) {
      throw Object.assign(new Error(`this device is not the current Room authority (authority=${authority})`), { code: 'not-authority' })
    }
  }
}
