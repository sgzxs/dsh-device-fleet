// Remote Room participant bridge (ADR-0015/0016 MVP).
//
// The Room Host keeps the canonical transcript. A remote participant is a Fleet
// device registered as `{ kind: 'remote', deviceId }`; sending to it delegates
// the message text to that device's agent over the existing `fleet.delegate`
// RPC, then appends the returned text as the remote member's Room reply and
// wakes local participants. This reuses the shipped delegation transport; a
// future protocol can bind a persistent remote session instead of one-shot
// delegation.
const DEFAULT_REMOTE_TIMEOUT_MS = 120_000
const JOIN_TIMEOUT_MS = 20_000
const WAKE_TIMEOUT_MS = 120_000

export class RemoteRoomBridge {
  /**
   * @param {object} options
   * @param {object} options.node FleetNode
   * @param {object} options.rooms RoomService
   * @param {number} [options.timeoutMs]
   * @param {(line: string) => void} [options.warn]
   */
  constructor({ node, rooms, timeoutMs = DEFAULT_REMOTE_TIMEOUT_MS, warn = () => {} }) {
    this.node = node
    this.rooms = rooms
    this.timeoutMs = timeoutMs
    this.warn = warn
    /** roomId -> memberId the next remote reply should be addressed to. */
    this.pendingReplyTo = new Map()
  }

  get deviceId() {
    return this.node?.identity?.deviceId ?? null
  }

  /** Register the remote member and ask its device to create a persistent session. */
  async addRemoteMember({ roomId, deviceId, name } = {}) {
    let joined = null
    try {
      joined = await this.node.request(deviceId, 'room.join', { roomId, name, hostDeviceId: this.deviceId }, { timeoutMs: JOIN_TIMEOUT_MS })
    } catch (error) {
      this.warn(`[device-fleet] remote room join failed (${deviceId}): ${String(error?.message ?? error)}`)
    }
    const sessionId = typeof joined?.sessionId === 'string' && joined.sessionId !== '' ? joined.sessionId : null
    const member = await this.rooms.addRemoteMember({ roomId, deviceId, name, sessionId })
    if (sessionId && member.remoteSessionId !== sessionId) {
      await this.rooms.setRemoteSessionId({ roomId, memberId: member.memberId, sessionId })
      member.remoteSessionId = sessionId
    }
    if (sessionId) {
      // The join snapshot predates this member; push the now-complete room state
      // so the remote mirror shows itself in its own member list.
      try {
        const snapshot = this.rooms.detail(roomId, { limit: 200 })
        await this.node.request(deviceId, 'room.sync', { roomId, sessionId, snapshot }, { timeoutMs: JOIN_TIMEOUT_MS })
      } catch (error) {
        this.warn(`[device-fleet] remote room sync failed (${deviceId}): ${String(error?.message ?? error)}`)
      }
    }
    return member
  }

  /** Tell remote mirrors that the authority closed the Room. */
  async notifyClosed(room) {
    if (!room || room.mirror) return
    const remotes = [...room.members.values()].filter((member) => member.kind === 'remote' && member.deviceId)
    await Promise.all(remotes.map(async (member) => {
      try {
        await this.node.request(member.deviceId, 'room.closed', { roomId: room.roomId }, { timeoutMs: 10_000 })
      } catch (error) {
        this.warn(`[device-fleet] room close notification failed (${member.deviceId}): ${String(error?.message ?? error)}`)
      }
    }))
  }

  /** Push the current authoritative snapshot to every remote mirror session. */
  async syncMirrors(roomId) {
    const room = this.rooms.rooms.get(roomId)
    if (!room?.members) return
    const remotes = [...room.members.values()].filter((member) => member.kind === 'remote' && member.deviceId)
    if (remotes.length === 0) return
    let snapshot
    try {
      snapshot = this.rooms.detail(roomId, { limit: 200 })
    } catch {
      return
    }
    await Promise.all(remotes.map(async (member) => {
      try {
        await this.node.request(member.deviceId, 'room.sync', { roomId, sessionId: member.remoteSessionId ?? null, snapshot }, { timeoutMs: 10_000 })
      } catch (error) {
        this.warn(`[device-fleet] remote mirror sync failed (${member.deviceId}): ${String(error?.message ?? error)}`)
      }
    }))
  }

  /** Host side of the `room.reply` RPC. */
  async recordReply({ fromDeviceId, roomId, text, remoteSessionId = null } = {}) {
    if (typeof fromDeviceId !== 'string' || fromDeviceId === '') throw Object.assign(new Error('sender device is required'), { code: 'bad-request' })
    if (typeof roomId !== 'string' || roomId === '') throw Object.assign(new Error('roomId is required'), { code: 'bad-request' })
    const room = this.rooms.rooms.get(roomId) ?? [...this.rooms.rooms.values()].find((entry) => entry.mirror?.roomId === roomId || entry.authorityRoomId === roomId)
    if (!room) throw Object.assign(new Error(`unknown or closed room: ${String(roomId)}`), { code: 'unknown-room' })
    const remotes = [...room.members.values()].filter((entry) => entry.kind === 'remote' && entry.deviceId === fromDeviceId)
    const member = (remoteSessionId ? remotes.find((entry) => entry.remoteSessionId === remoteSessionId) : null)
      ?? remotes[0]
      ?? room.members.get(`remote:${fromDeviceId}`)
    if (!member) throw Object.assign(new Error(`unknown remote member for device ${fromDeviceId}`), { code: 'unknown-member' })
    const replyTo = this.pendingReplyTo.get(room.roomId) ?? this.pendingReplyTo.get(roomId) ?? null
    this.pendingReplyTo.delete(room.roomId)
    this.pendingReplyTo.delete(roomId)
    const result = await this.rooms.recordRemoteReply({ roomId: room.roomId, memberId: member.memberId, text, to: replyTo ? [replyTo] : null })
    void this.syncMirrors(room.roomId).catch((error) => this.warn(`[device-fleet] mirror sync fan-out failed: ${String(error?.message ?? error)}`))
    return { ok: true, ...result }
  }

  async wakeRemote(room, member, message) {
    if (!member?.deviceId) return false
    // Only the original sender gets woken by the reply; without this the
    // remote reply broadcast wakes every participant and agents can loop.
    const replyTo = message.from?.memberId ?? `host:${room.hostSessionId}`
    this.pendingReplyTo.set(room.roomId, replyTo)
    // Upgrade members added before persistent sessions existed: ask the target
    // device to create/bind its persistent participant session on first wake.
    if (!member.remoteSessionId) {
      try {
        const joined = await this.node.request(member.deviceId, 'room.join', { roomId: room.roomId, name: member.name, hostDeviceId: this.deviceId, sessionId: member.remoteSessionId ?? null }, { timeoutMs: JOIN_TIMEOUT_MS })
        if (typeof joined?.sessionId === 'string' && joined.sessionId !== '') {
          await this.rooms.setRemoteSessionId({ roomId: room.roomId, memberId: member.memberId, sessionId: joined.sessionId })
          member.remoteSessionId = joined.sessionId
        }
      } catch (error) {
        this.warn(`[device-fleet] remote room join failed (${member.deviceId}): ${String(error?.message ?? error)}`)
      }
    }
    // Persistent path: the target device keeps a real participant session and
    // forwards its assistant output back through `room.reply`.
    if (member.remoteSessionId) {
      try {
        const members = [...room.members.values()].map((entry) => ({
          name: entry.name,
          role: entry.role,
          kind: entry.kind,
          ...(entry.deviceId ? { deviceId: entry.deviceId } : {}),
        }))
        const tasks = [...room.tasks.values()]
          .filter((task) => task.owner === member.memberId && task.status !== 'done')
          .map((task) => ({ title: task.title, status: task.status }))
        const result = await this.node.request(
          member.deviceId,
          'room.wake',
          { roomId: room.roomId, messageId: message.id, from: message.from, text: message.text, hostDeviceId: this.deviceId, sessionId: member.remoteSessionId ?? null, members, tasks },
          { timeoutMs: WAKE_TIMEOUT_MS },
        )
        if (typeof result?.sessionId === 'string' && result.sessionId !== member.remoteSessionId) {
          await this.rooms.setRemoteSessionId({ roomId: room.roomId, memberId: member.memberId, sessionId: result.sessionId })
        }
        return true
      } catch (error) {
        this.warn(`[device-fleet] persistent remote wake failed (${member.deviceId}): ${String(error?.message ?? error)}`)
      }
    }
    const sender = message.from?.kind === 'user' ? 'user' : (message.from?.name ?? 'agent')
    const task = [
      `[Fleet Room ${room.roomId}] Room participant "${member.name ?? 'remote'}" is addressed by ${sender}:`,
      message.text,
      '',
      'Reply as the remote Room participant. Return only the reply text; the Room Host will append it to the shared Room transcript.',
    ].join('\n')
    try {
      const result = await this.node.request(
        member.deviceId,
        'fleet.delegate',
        { task, label: `Room ${room.roomId}`, roomId: room.roomId },
        { timeoutMs: this.timeoutMs },
      )
      const text = typeof result?.text === 'string' ? result.text.trim() : ''
      if (text === '') return false
      await this.rooms.recordRemoteReply({ roomId: room.roomId, memberId: member.memberId, text })
      return true
    } catch (error) {
      this.warn(`[device-fleet] remote room wake failed (${member.deviceId}): ${String(error?.message ?? error)}`)
      return false
    }
  }
}
