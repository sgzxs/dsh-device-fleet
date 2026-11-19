// Remote Room participant peer (target-device side, ADR-0015/0016).
//
// A Room Host on device A calls `room.join` over Fleet RPC for each agent/session
// that should participate. This device creates a real persistent DSH session per
// participant, keeps it alive, injects Host messages with `room.wake`, and
// forwards that session's assistant output back with `room.reply`.
//
// Multiple participants per Room are supported: one session == one member, so a
// device agent can spawn subagents/teams and each can join the same Room.
const REPLY_TIMEOUT_MS = 15_000
const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
const { dirname, join: joinPath } = await import('node:path')
import { friendlyName } from './human-names.js'

function textOfMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

export class RemoteRoomPeer {
  /**
   * @param {object} options
   * @param {object} options.sessionController ctx.sessionController
   * @param {(input: object) => object} options.createUserMessage dsh-llm helper
   * @param {object} options.node FleetNode
   * @param {object} [options.config] execution config ({cwd, agentPreset})
   * @param {(line: string) => void} [options.warn]
   */
  constructor({ sessionController, createUserMessage, node, rooms = null, config = {}, warn = () => {}, dataDir = null }) {
    this.sessionController = sessionController
    this.createUserMessage = createUserMessage
    this.node = node
    this.rooms = rooms
    this.config = config
    this.dataDir = dataDir
    this.wakeCursorsFile = dataDir ? joinPath(dataDir, 'peer-wake.json') : null
    this.warn = warn
    /** sessionId -> { hostDeviceId, roomId, name, agent } */
    this.bindings = new Map()
    /** roomId -> Set<sessionId> */
    this.roomSessions = new Map()
    /** sessionId -> roomId */
    this.sessionRooms = new Map()
    /** sessionId -> AbortController for optional observers */
    this.observers = new Map()
    /** messageId keys already delivered to a participant */
    this.consumed = new Set()
    /** sessionId -> last message createdAt backfilled, so missed wakes are retried once. */
    this.wakeCursors = new Map()
    if (this.wakeCursorsFile && existsSync(this.wakeCursorsFile)) {
      try {
        const stored = JSON.parse(readFileSync(this.wakeCursorsFile, 'utf8'))
        for (const [sessionId, value] of Object.entries(stored.cursors ?? {})) this.wakeCursors.set(sessionId, Number(value) || 0)
      } catch {
        /* ignore corrupt cursor file */
      }
    }
  }

  saveWakeCursors() {
    if (!this.wakeCursorsFile) return
    try {
      mkdirSync(dirname(this.wakeCursorsFile), { recursive: true })
      writeFileSync(this.wakeCursorsFile, JSON.stringify({ cursors: Object.fromEntries(this.wakeCursors) }), 'utf8')
    } catch {
      /* best effort */
    }
  }

  get localDeviceId() {
    return this.node?.identity?.deviceId ?? null
  }

  /**
   * Rebuild the in-memory routing table from this device's persisted mirror
   * Rooms after a restart. Mirrors store the authority address, so bindings are
   * recovered without waiting for the next wake.
   */
  hydrateFromRooms(rooms) {
    if (!rooms?.rooms?.values) return
    for (const room of rooms.rooms.values()) {
      if (!room?.mirror || typeof room.roomId !== 'string') continue
      const sessionId = room.roomId
      if (this.bindings.has(sessionId)) continue
      this.bindings.set(sessionId, {
        hostDeviceId: room.mirror.deviceId,
        roomId: room.mirror.roomId,
        name: 'remote',
        sessionId,
        agent: null,
        pendingReplies: 0,
      })
      this.sessionRooms.set(sessionId, room.mirror.roomId)
      if (!this.roomSessions.has(room.mirror.roomId)) this.roomSessions.set(room.mirror.roomId, new Set())
      this.roomSessions.get(room.mirror.roomId).add(sessionId)
    }
  }

  async resolveBindingAgent(binding) {
    if (binding.agent) return binding.agent
    const resolved = await this.sessionController.resolveAgent(binding.sessionId).catch(() => null)
    if (resolved?.agent) binding.agent = resolved.agent
    return binding.agent ?? null
  }

  /** Members of the authoritative Room for this participant session. */
  async membersForSession({ sessionId } = {}) {
    const binding = this.bindings.get(sessionId)
    if (!binding) return null
    const snapshot = await this.node.request(binding.hostDeviceId, 'room.snapshot', { roomId: binding.roomId }, { timeoutMs: 10_000 }).catch(() => null)
    if (!snapshot) return null
    return { roomId: binding.roomId, members: Array.isArray(snapshot.members) ? snapshot.members : [] }
  }

  async bindSession({ sessionId, roomId, name, hostDeviceId }) {
    const resolved = await this.sessionController.resolveAgent(sessionId)
    if (!resolved?.agent) return null
    const binding = { hostDeviceId, roomId, name, sessionId, agent: resolved.agent, pendingReplies: 0 }
    this.bindings.set(sessionId, binding)
    this.sessionRooms.set(sessionId, roomId)
    if (!this.roomSessions.has(roomId)) this.roomSessions.set(roomId, new Set())
    this.roomSessions.get(roomId).add(sessionId)
    if (!this.wakeCursors.has(sessionId)) {
      this.wakeCursors.set(sessionId, Date.now())
      this.saveWakeCursors()
    }
    return binding
  }

  /**
   * Create (or reuse) one participant session for this Room.
   * Passing `sessionId` lets the Host retry/reconnect to an existing session.
   */
  async join({ roomId, name = 'remote', hostDeviceId = null, sessionId = null } = {}) {
    if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
    if (typeof hostDeviceId !== 'string' || hostDeviceId === '') {
      throw Object.assign(new Error('hostDeviceId is required (the Room Host device)'), { code: 'bad-request' })
    }
    if (hostDeviceId === this.localDeviceId) throw Object.assign(new Error('hostDeviceId cannot be this device'), { code: 'bad-request' })

    if (typeof sessionId === 'string' && sessionId !== '') {
      const existing = this.bindings.get(sessionId)
      if (existing) {
        existing.hostDeviceId = hostDeviceId
        existing.name = name
        return { roomId, sessionId, name, reused: true }
      }
      // A persisted session may still be resolvable after this process restarted.
      const rebound = await this.bindSession({ sessionId, roomId, name, hostDeviceId }).catch(() => null)
      if (rebound) {
        await this.ensureMirror(sessionId, hostDeviceId, roomId)
        return { roomId, sessionId, name, reused: true }
      }
    }

    if (!this.sessionController?.create) throw Object.assign(new Error('participant sessions are unavailable'), { code: 'unsupported' })
    const created = await this.sessionController.create({
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      ...(this.config.agentPreset ? { agentPreset: this.config.agentPreset } : {}),
    })
    const newSessionId = created?.sessionId
    if (!newSessionId) throw Object.assign(new Error('could not create the remote participant session'), { code: 'room-participant-failed' })
    const binding = await this.bindSession({ sessionId: newSessionId, roomId, name, hostDeviceId })
    if (!binding) throw Object.assign(new Error('remote participant agent unavailable'), { code: 'room-participant-failed' })
    // A real, discoverable DSH session (not a hidden Execution Slot session).
    if (typeof this.sessionController.rename === 'function') {
      await this.sessionController.rename({ sessionId: newSessionId, title: `${friendlyName(roomId)} · ${name}（远程）` }).catch(() => {})    }
    await this.ensureMirror(newSessionId, hostDeviceId, roomId)
    return { roomId, sessionId: newSessionId, name, reused: false }
  }

  /** Make the local participant session render as a Room mirror in this device's UI. */
  async ensureMirror(localSessionId, hostDeviceId, authorityRoomId) {
    if (!this.rooms || typeof this.rooms.createMirror !== 'function') return
    let snapshot = null
    try {
      snapshot = await this.node.request(hostDeviceId, 'room.snapshot', { roomId: authorityRoomId }, { timeoutMs: 20_000 })
    } catch (error) {
      this.warn(`[device-fleet] room snapshot unavailable: ${String(error?.message ?? error)}`)
    }
    this.rooms.createMirror({
      localSessionId,
      authority: { deviceId: hostDeviceId, roomId: authorityRoomId },
      snapshot: snapshot ?? {},
    })
  }

  /** Replace a mirror's replica with the latest Host snapshot. */
  sync({ roomId, sessionId, snapshot } = {}) {
    if (!this.rooms || typeof this.rooms.applyMirrorSnapshot !== 'function') return { ok: false }
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false }
    this.rooms.applyMirrorSnapshot({ roomId: sessionId, snapshot })
    return { ok: true, roomId, sessionId }
  }

  /**
   * Explicit Room channel for a participant agent: the model calls this tool
   * from its own session; the message is sent to the authoritative Room Host as
   * that participant's speech.
   */
  async replyFromTool({ sessionId, text } = {}) {
    const binding = this.bindings.get(sessionId)
    if (!binding) return { text: 'Error: [no-room-binding] this session is not a remote Room participant' }
    // Room is additive: only a turn that originated from a Room wake may publish
    // back into the Room. A private Chat turn has no pending wake and is rejected.
    if (!(binding.pendingReplies > 0)) {
      return { text: 'Error: [not-a-room-turn] this turn did not originate from a Room message; reply in Chat instead' }
    }
    const body = typeof text === 'string' ? text.trim() : ''
    if (body === '') return { text: 'Error: [bad-request] room_reply needs text' }
    binding.pendingReplies -= 1
    await this.node.request(binding.hostDeviceId, 'room.reply', { roomId: binding.roomId, remoteSessionId: binding.sessionId, text: body }, { timeoutMs: REPLY_TIMEOUT_MS })
    return { text: `sent to Room ${binding.roomId}` }
  }

  /** Deliver wakes for messages missed while this device was offline. */
  async backfill({ sessionId, roomId, messages = [], members = null, tasks = null, hostDeviceId = null } = {}) {
    const binding = this.bindings.get(sessionId)
    if (!binding || !Array.isArray(messages)) return 0
    const memberId = `remote:${this.localDeviceId}:${sessionId}`
    const cursor = this.wakeCursors.get(sessionId) ?? Date.now()
    let delivered = 0
    let newest = cursor
    for (const message of messages) {
      const createdAt = Number(message?.createdAt ?? 0)
      if (!Number.isFinite(createdAt) || createdAt <= cursor) continue
      const recipients = Array.isArray(message.to) ? message.to : []
      if (!recipients.includes(memberId)) continue
      if (message.from?.memberId === memberId) continue
      const result = await this.wake({
        roomId,
        sessionId,
        messageId: message.id,
        from: message.from,
        text: message.text,
        hostDeviceId: hostDeviceId ?? binding.hostDeviceId,
        members,
        tasks,
      }).catch(() => null)
      if (result && !result.duplicate) delivered += 1
      newest = Math.max(newest, createdAt)
    }
    if (newest !== cursor) {
      this.wakeCursors.set(sessionId, newest)
      this.saveWakeCursors()
    }
    return delivered
  }

  /** Drop one local participant session binding (self-leave / local mirror close). */
  releaseSession(sessionId) {
    const binding = this.bindings.get(sessionId)
    if (!binding) return false
    this.bindings.delete(sessionId)
    this.sessionRooms.delete(sessionId)
    this.roomSessions.get(binding.roomId)?.delete(sessionId)
    return true
  }

  /** Drop local binding/mirror routes when the authority closes the Room. */
  handleRoomClosed({ roomId } = {}) {
    const localSessionIds = []
    for (const [sessionId, binding] of this.bindings) {
      if (binding.roomId !== roomId) continue
      localSessionIds.push(sessionId)
      this.bindings.delete(sessionId)
      this.sessionRooms.delete(sessionId)
      this.roomSessions.get(roomId)?.delete(sessionId)
    }
    return localSessionIds
  }

  async wake({ roomId, sessionId = null, messageId, from, text, hostDeviceId = null, members = null, tasks = null } = {}) {
    if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
    const body = typeof text === 'string' ? text.trim() : ''
    if (body === '') throw Object.assign(new Error('room message needs text'), { code: 'bad-request' })
    let binding = typeof sessionId === 'string' ? this.bindings.get(sessionId) : null
    // Only use the "first session in the room" fallback for legacy wake calls
    // that do not name a session. A named session must never be routed to a
    // different participant session.
    if (!binding && (typeof sessionId !== 'string' || sessionId === '')) {
      const sessions = this.roomSessions.get(roomId)
      if (sessions && sessions.size > 0) binding = this.bindings.get([...sessions][0])
    }
    if (!binding && typeof sessionId === 'string' && sessionId !== '') {
      binding = await this.bindSession({ sessionId, roomId, name: 'remote', hostDeviceId }).catch(() => null)
    }
    if (!binding) {
      const joined = await this.join({ roomId, hostDeviceId })
      binding = this.bindings.get(joined.sessionId)
    }
    if (binding && !binding.agent) {
      const agent = await this.resolveBindingAgent(binding)
      if (!agent) {
        // The persisted session no longer resolves; forget it and create a new
        // participant session instead of routing to a different one.
        this.bindings.delete(binding.sessionId)
        this.sessionRooms.delete(binding.sessionId)
        this.roomSessions.get(binding.roomId)?.delete(binding.sessionId)
        const joined = await this.join({ roomId, hostDeviceId })
        binding = this.bindings.get(joined.sessionId)
      }
    }
    if (typeof hostDeviceId === 'string' && hostDeviceId !== '') binding.hostDeviceId = hostDeviceId
    const consumeKey = messageId ? `${roomId}:${messageId}` : null
    if (consumeKey && this.consumed.has(consumeKey)) {
      return { roomId, sessionId: binding.sessionId, messageId: messageId ?? null, accepted: true, duplicate: true, replied: false }
    }
    // A wake can be the first thing after this process restarted; recreate the
    // local mirror Room for the participant session when it is missing.
    if (this.rooms && !this.rooms.rooms.get(binding.sessionId)) {
      await this.ensureMirror(binding.sessionId, binding.hostDeviceId, roomId)
    }
    const sender = from?.kind === 'user' ? 'user' : (from?.name ?? 'agent')
    const roster = Array.isArray(members) && members.length > 0
      ? members.map((member) => `${member.name}${member.role === 'host' ? ' (host)' : ''}${member.kind === 'remote' ? ' [remote]' : ''}`).join(', ')
      : ''
    const prompt = [
      `[${friendlyName(roomId)}] ${sender} → you:`,
      body,
      '',
      ...(roster ? [`Room members: ${roster}.`, ''] : []),
      ...(Array.isArray(tasks) && tasks.length > 0 ? [`Assigned tasks: ${tasks.map((task) => `"${task.title}" (${task.status})`).join(', ')}.`, ''] : []),
      'You are one remote Room participant on this device. Reply to a Room message by calling the `room_reply` tool with your answer text; that is the only way to speak into the shared Room. Private Chat stays private and must not be posted to the Room.',
    ].join('\n')
    const userMessage = this.createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
    binding.pendingReplies = (binding.pendingReplies ?? 0) + 1
    await binding.agent.followup(userMessage)
    if (consumeKey) {
      this.consumed.add(consumeKey)
      if (this.consumed.size > 2_000) this.consumed.delete(this.consumed.values().next().value)
    }
    // The reply is published explicitly by the participant calling room_reply;
    // no assistant-output capture means private Chat can never leak into Room.
    return { roomId, sessionId: binding.sessionId, messageId: messageId ?? null, accepted: true, replied: false }
  }

  /** Called from the plugin's session/event listener; forwards assistant output. */
  handleSessionEvent(session, event) {
    if (typeof this.sessionController.wait === 'function') return
    if (event?.type !== 'assistant/message') return
    const roomId = this.sessionRooms.get(session?.id)
    if (!roomId) return
    const binding = this.bindings.get(session.id)
    if (!binding || !(binding.pendingReplies > 0)) return
    const text = textOfMessage(event.data)
    if (text === '') return
    binding.pendingReplies -= 1
    void this.node
      .request(binding.hostDeviceId, 'room.reply', { roomId, remoteSessionId: session.id, text }, { timeoutMs: REPLY_TIMEOUT_MS })
      .catch((error) => this.warn(`[device-fleet] remote room reply failed: ${String(error?.message ?? error)}`))
  }
}

function lastAssistantText(records) {
  if (!Array.isArray(records)) return ''
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const entry = records[index]
    const event = entry?.type === 'event' ? entry.event : entry
    if (event?.type !== 'assistant/message') continue
    const text = textOfMessage(event.data)
    if (text !== '') return text
  }
  return ''
}
