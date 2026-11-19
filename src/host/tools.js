// Model-facing fleet tools (ADR-0014, ADR-0022).
//
// fleet_list / fleet_tools / fleet_call are the fixed tool surface; fleet_read,
// fleet_fetch and fleet_run are typed shortcuts over the same fleet.call path.
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { DirectCallClient } from './direct-call.js'
import { localTransferFiles, MAX_TRANSFER_BYTES, sha256File, TRANSFER_CHUNK_BYTES } from './file-transfer.js'

/** Shared text output contract (same shape the harness's own tools use). */
export function textOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }
}

function fail(error) {
  const code = error?.code ?? 'error'
  return { text: `Error: [${String(code)}] ${String(error?.message ?? error)}` }
}

/** Pure handlers; wrapped into ToolDefinitions by `createFleetToolDefinitions`. */
export function createFleetHandlers({
  node,
  client = new DirectCallClient({ node }),
  pairing = null,
  onPeerHint = null,
  approvals = null,
  rooms = null,
  outbox = null,
  flushOutbox = null,
  remoteRoom = null,
  remotePeer = null,
  syncRoom = null,
  acceptInvite = null,
  archiveRoom = null,
  restoreRoom = null,
  deleteRoom = null,
  compactRoom = null,
  claimAuthority = null,
  promoteMirror = null,
  rotateIdentity = null,
  rotationStatus = null,
  compactRotation = null,
  trustRotationCheckpoint = null,
  revokeDevice = null,
  resolveRotationFork = null,
  resetIdentity = null,
  removeFleetDevice = null,
  isSlotAgent = null,
  onTaskDone = null,
  onRoomClose = null,
}) {
  const uploadOne = async (device, localFile, remoteFile, { resume = false } = {}) => {
    const size = fs.statSync(localFile).size
    if (size > MAX_TRANSFER_BYTES) throw Object.assign(new Error('file exceeds the transfer limit'), { code: 'file-too-large' })
    let offset = 0
    if (resume && size > 0) {
      try {
        const remote = await node.request(device, 'fleet.file.stat', { path: remoteFile }, { timeoutMs: 30_000 })
        if (remote?.isFile === true && Number(remote.size) > 0 && Number(remote.size) < size) offset = Number(remote.size)
      } catch {
        /* resume is best effort; fall back to a full upload */
      }
    }
    const sha256 = sha256File(localFile)
    const fd = fs.openSync(localFile, 'r')
    try {
      for (;;) {
        const remaining = size - offset
        const length = Math.min(TRANSFER_CHUNK_BYTES, remaining)
        const chunk = Buffer.allocUnsafe(Math.max(1, length))
        const read = length > 0 ? fs.readSync(fd, chunk, 0, length, offset) : 0
        const data = read > 0 ? chunk.subarray(0, read) : Buffer.alloc(0)
        const final = offset + data.length >= size
        await node.request(device, 'fleet.file.put', {
          path: remoteFile,
          data: data.toString('base64'),
          offset,
          final,
          sha256,
        }, { timeoutMs: 60_000 })
        offset += data.length
        if (final) break
        if (read <= 0) throw Object.assign(new Error('local file shrank during upload'), { code: 'file-changed' })
      }
    } finally {
      fs.closeSync(fd)
    }
    return { bytes: size, uploadedBytes: size, sha256, resumedFrom: offset === size ? undefined : offset }
  }
  const downloadOne = async (device, remoteFile, localFile, { resume = false } = {}) => {
    const target = path.resolve(localFile)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = `${target}.part`
    let offset = 0
    const hash = createHash('sha256')
    let expectedSha = null
    if (resume && fs.existsSync(tmp)) {
      try {
        const remote = await node.request(device, 'fleet.file.stat', { path: remoteFile }, { timeoutMs: 30_000 })
        const localSize = fs.statSync(tmp).size
        if (remote?.isFile === true && localSize > 0 && localSize <= Number(remote.size ?? 0)) {
          offset = localSize
          const fd = fs.openSync(tmp, 'r')
          try {
            const buffer = Buffer.allocUnsafe(TRANSFER_CHUNK_BYTES)
            let readOffset = 0
            for (;;) {
              const read = fs.readSync(fd, buffer, 0, buffer.length, readOffset)
              if (read <= 0) break
              hash.update(buffer.subarray(0, read))
              readOffset += read
            }
          } finally {
            fs.closeSync(fd)
          }
        } else {
          fs.rmSync(tmp, { force: true })
        }
      } catch {
        fs.rmSync(tmp, { force: true })
      }
    } else {
      fs.rmSync(tmp, { force: true })
    }
    const fd = fs.openSync(tmp, offset > 0 ? 'a' : 'w')
    try {
      for (let index = 0; index < 1_000_000; index += 1) {
        const page = await node.request(device, 'fleet.file.get', {
          path: remoteFile,
          offset,
          size: TRANSFER_CHUNK_BYTES,
        }, { timeoutMs: 60_000 })
        const buffer = Buffer.from(String(page?.data ?? ''), 'base64')
        if (buffer.length > 0) {
          fs.writeSync(fd, buffer)
          hash.update(buffer)
        }
        offset += buffer.length
        if (offset > MAX_TRANSFER_BYTES) throw Object.assign(new Error('file exceeds the transfer limit'), { code: 'file-too-large' })
        if (page?.eof === true) {
          expectedSha = page?.sha256 ?? null
          break
        }
        if (buffer.length === 0) throw Object.assign(new Error('empty chunk before end of file'), { code: 'bad-response' })
      }
    } catch (error) {
      fs.closeSync(fd)
      throw error
    }
    fs.closeSync(fd)
    const sha256 = hash.digest('base64url')
    if (typeof expectedSha === 'string' && expectedSha !== '' && expectedSha !== sha256) {
      fs.rmSync(tmp, { force: true })
      throw Object.assign(new Error('downloaded file checksum does not match'), { code: 'checksum-mismatch' })
    }
    fs.renameSync(tmp, target)
    return { bytes: offset, sha256, resumedFrom: offset > 0 ? offset : undefined }
  }
  return {
    async fleet_queue_call({ device, tool, parameters, capability = 'tool', roomId, taskId, label } = {}) {
      if (!outbox?.add) return { text: 'Error: [unsupported] the outbox is unavailable' }
      if (typeof device !== 'string' || device === '') return { text: 'Error: [bad-request] device is required' }
      if (typeof tool !== 'string' || tool === '') return { text: 'Error: [bad-request] tool is required' }
      const entry = outbox.add({
        deviceId: device,
        kind: 'call',
        label,
        request: { capability, tool, args: parameters ?? {}, ...(roomId ? { roomId } : {}), ...(taskId ? { taskId } : {}) },
      })
      if (!entry) return { text: 'Error: [bad-request] could not queue the call' }
      if (typeof flushOutbox === 'function') void flushOutbox(device)
      return { text: `queued ${entry.id} for ${device} (${entry.status})` }
    },

    async fleet_queue_delegate({ device, task, label, cwd, roomId, taskId } = {}) {
      if (!outbox?.add) return { text: 'Error: [unsupported] the outbox is unavailable' }
      if (typeof device !== 'string' || device === '') return { text: 'Error: [bad-request] device is required' }
      if (typeof task !== 'string' || task.trim() === '') return { text: 'Error: [bad-request] task is required' }
      const entry = outbox.add({
        deviceId: device,
        kind: 'delegate',
        label,
        request: { task, ...(label ? { label } : {}), ...(cwd ? { cwd } : {}), ...(roomId ? { roomId } : {}), ...(taskId ? { taskId } : {}) },
      })
      if (!entry) return { text: 'Error: [bad-request] could not queue the delegation' }
      if (typeof flushOutbox === 'function') void flushOutbox(device)
      return { text: `queued ${entry.id} for ${device} (${entry.status})` }
    },

    async fleet_outbox({ status } = {}) {
      if (!outbox?.list) return { text: 'Error: [unsupported] the outbox is unavailable' }
      const entries = outbox.list({ status: status ?? null })
      if (entries.length === 0) return { text: '(outbox is empty)' }
      return { text: entries.map((entry) => `- ${entry.id} · ${entry.deviceId} · ${entry.kind} · ${entry.status}${entry.label ? ` · ${entry.label}` : ''}${entry.error ? ` · ${entry.error}` : ''}`).join('\n') }
    },

    async fleet_outbox_result({ id } = {}) {
      if (!outbox?.get) return { text: 'Error: [unsupported] the outbox is unavailable' }
      const entry = outbox.get(id)
      if (!entry) return { text: `Error: [unknown-entry] ${String(id)}` }
      return { text: JSON.stringify(entry, null, 2) }
    },

    async fleet_outbox_cancel({ id } = {}) {
      if (!outbox?.get) return { text: 'Error: [unsupported] the outbox is unavailable' }
      const entry = outbox.get(id)
      if (!entry) return { text: `Error: [unknown-entry] ${String(id)}` }
      if (entry.status !== 'queued') return { text: `Error: [bad-request] entry is already ${entry.status}` }
      outbox.remove(id)
      return { text: `cancelled ${id}` }
    },

    async fleet_approvals() {
      if (!approvals?.list) return { text: 'Error: [unsupported] the approval inbox is unavailable' }
      const items = approvals.list()
      if (items.length === 0) return { text: '(no pending approvals)' }
      const lines = items.map(
        (item) =>
          `- ${item.id} · ${item.fromDeviceId} · ${item.capability}${item.tool ? `/${String(item.tool)}` : ''} · ${item.expiresInMs}ms left · ${item.argsSummary}`,
      )
      return { text: lines.join('\n') }
    },

    async fleet_simulate_request({ fromDeviceId, capability, tool, reason }) {
      if (!approvals?.simulate) return { text: 'Error: [unsupported] approval simulation is disabled' }
      try {
        return { text: await approvals.simulate({ fromDeviceId, capability, tool, reason }) }
      } catch (error) {
        return fail(error)
      }
    },
    async fleet_status() {
      if (typeof node.status !== 'function') return { text: 'Error: [unsupported] status is unavailable' }
      return { text: JSON.stringify(node.status(), null, 2) }
    },

    async fleet_relay_reconnect() {
      if (typeof node.reconnectRelays !== 'function') return { text: 'Error: [unsupported] relay reconnect is unavailable' }
      try {
        const results = await node.reconnectRelays()
        return { text: JSON.stringify({ results }, null, 2) }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_connect({ host, port }) {
      if (typeof node.connectAddress !== 'function') return { text: 'Error: [unsupported] manual connect is unavailable' }
      try {
        node.addPeerHint?.({ host, port })
        const peer = await node.connectAddress(host, port)
        await onPeerHint?.({ host, port })
        return { text: `connected to ${peer.deviceId} (${peer.name ?? 'device'}) at ${host}:${port}` }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_invite() {
      if (!pairing?.invite) return { text: 'Error: [unsupported] this device cannot create an invite' }
      try {
        const invite = await pairing.invite()
        const code = typeof invite === 'string' ? invite : invite?.code
        const expiresAt = typeof invite === 'object' && invite ? invite.expiresAt : null
        return {
          text: [
            'Fleet invite for another device (single use, keep it private):',
            '',
            code,
            '',
            ...(Number.isFinite(Number(expiresAt)) ? [`Expires: ${new Date(Number(expiresAt)).toISOString()}`] : []),
            'On the other device install this plugin, then ask its agent to join with this code (`fleet_join`). It takes effect after that device reloads the plugin (or restarts DSH).',
          ].join('\n'),
        }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_join({ code }) {
      if (!pairing?.join) return { text: 'Error: [unsupported] this device cannot join a fleet' }
      try {
        await pairing.join(code)
        return { text: 'Invite queued. Reload the device-fleet plugin (plugin_manager set_bundle off/on) or restart DSH; the plugin will enroll on the next load and then be able to reach the Fleet.' }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_rotate_identity() {
      if (typeof rotateIdentity !== 'function') return { text: 'Error: [unsupported] identity rotation is unavailable' }
      try {
        return { text: JSON.stringify(await rotateIdentity()) }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_rotation_status({ deviceId } = {}) {
      const status = typeof rotationStatus === 'function'
        ? await rotationStatus({ deviceId })
        : node?.status?.()
      if (!status) return { text: 'Error: [unsupported] rotation status is unavailable' }
      return { text: JSON.stringify(status, null, 2) }
    },

    async fleet_rotation_compact({ keep, confirm } = {}) {
      if (typeof compactRotation !== 'function') return { text: 'Error: [unsupported] rotation chain compaction is unavailable' }
      if (confirm !== true) {
        return { text: 'Error: [confirmation-required] pruning rotation history breaks peers pinned below the retained window: ask the user, then call again with confirm: true' }
      }
      try {
        const result = await compactRotation({ keep: Number(keep) || undefined, confirm: true })
        return { text: JSON.stringify(result) }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_rotation_trust_checkpoint({ deviceId, confirm } = {}) {
      if (typeof trustRotationCheckpoint !== 'function') return { text: 'Error: [unsupported] checkpoint trust is unavailable' }
      if (confirm !== true) {
        return { text: 'Error: [confirmation-required] trusting a checkpoint skips chain history and must be confirmed by the user: call again with confirm: true' }
      }
      try {
        return { text: JSON.stringify(await trustRotationCheckpoint({ deviceId, confirm: true })) }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_revoke_device({ deviceId, reason, confirm } = {}) {      if (typeof revokeDevice !== 'function') return { text: 'Error: [unsupported] device revocation is unavailable' }
      if (confirm !== true) {
        return { text: 'Error: [confirmation-required] revoking a device is permanent for this Fleet: ask the user, then call again with confirm: true' }
      }
      try {
        return { text: JSON.stringify(await revokeDevice({ deviceId, reason, confirm: true })) }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_rotation_fork_resolve({ deviceId, action, confirm } = {}) {
      if (typeof resolveRotationFork !== 'function') return { text: 'Error: [unsupported] rotation fork resolution is unavailable' }
      if (confirm !== true) {
        return { text: 'Error: [confirmation-required] choosing a rotation branch is a manual trust decision: inspect fleet_rotation_status, then call again with confirm: true' }
      }
      try {
        return { text: JSON.stringify(await resolveRotationFork({ deviceId, action: action ?? 'keep-local', confirm: true })) }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_reset_identity({ confirm, reason } = {}) {
      if (typeof resetIdentity !== 'function') return { text: 'Error: [unsupported] identity reset is unavailable' }
      if (confirm !== true) {
        return { text: 'Error: [confirmation-required] resetting the identity changes this device id and disconnects every peer: ask the user, then call again with confirm: true' }
      }
      try {
        return { text: JSON.stringify(await resetIdentity({ confirm: true, reason })) }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_remove_device({ deviceId }) {
      if (typeof removeFleetDevice !== 'function') return { text: 'Error: [unsupported] fleet removal is unavailable' }
      try {
        return { text: JSON.stringify(await removeFleetDevice({ deviceId })) }
      } catch (error) {
        return fail(error)
      }
    },

    async room_create(args, exec) {
      if (!rooms) return { text: 'Error: [unsupported] rooms are unavailable' }
      // A remote fleet.call executes tools through the hidden Execution Slot,
      // whose session is not a user-visible Chat. Upgrading that session creates
      // a Room the user cannot open; require a local user session instead.
      if (typeof isSlotAgent === 'function' && isSlotAgent(exec?.agent)) {
        return { text: 'Error: [room-create-local-only] remote tool calls cannot create a Room host from the hidden execution session; create the Room from a local user session (or ask the local user).' }
      }
      try {
        const room = await rooms.upgradeHost({ agent: exec?.agent, policy: args?.policy ?? {} })
        return {
          text: [
            `room created: ${room.roomId}`,
            `host: ${room.members.find((member) => member.role === 'host')?.memberId ?? '?'}`,
            'Add participants with room_add_remote (connected Fleet device) or room_add_local (simulation), then room_send.',
          ].join('\n'),
        }
      } catch (error) {
        return fail(error)
      }
    },

    async room_add_remote({ roomId, deviceId, name }) {
      if (!rooms) return { text: 'Error: [unsupported] rooms are unavailable' }
      try {
        const connected = node && typeof node.peerIds === 'function' ? node.peerIds() : []
        if (!connected.includes(deviceId)) {
          return { text: `Error: [peer-offline] device ${deviceId} is not connected; connect it with fleet_connect first` }
        }
        const member = remoteRoom
          ? await remoteRoom.addRemoteMember({ roomId, deviceId, name })
          : await rooms.addRemoteMember({ roomId, deviceId, name })
        return { text: `remote participant added: ${member.memberId} (${member.name}) device=${member.deviceId}` }
      } catch (error) {
        return fail(error)
      }
    },

    async room_add_local({ roomId, name, agentPreset, cwd }) {
      if (!rooms) return { text: 'Error: [unsupported] rooms are unavailable' }
      try {
        const member = await rooms.addLocalParticipant({ roomId, name, agentPreset, cwd })
        return { text: `participant added: ${member.memberId} (${member.name}) session=${member.sessionId}` }
      } catch (error) {
        return fail(error)
      }
    },

    async room_remove_member({ roomId, memberId, reason }) {
      if (!rooms) return { text: 'Error: [unsupported] rooms are unavailable' }
      try {
        const result = await rooms.removeMember({ roomId, memberId, reason })
        return { text: `member removed: ${result.memberId}` }
      } catch (error) {
        return fail(error)
      }
    },

    async room_send({ roomId, to, text }, exec) {
      if (!rooms) return { text: 'Error: [unsupported] rooms are unavailable' }
      try {
        const from = { sessionId: exec?.agent?.session?.id }
        const result = await rooms.send({ roomId, from, to, text })
        const woken = result.woken.length > 0 ? `, woke ${result.woken.join(', ')}` : ''
        return { text: `message ${result.messageId} sent to ${result.to.join(', ')}${woken}` }
      } catch (error) {
        return fail(error)
      }
    },

    async room_messages({ roomId, limit }, exec) {
      if (!rooms) return { text: 'Error: [unsupported] rooms are unavailable' }
      try {
        const sessionId = exec?.agent?.session?.id
        const room = rooms.rooms?.get?.(roomId)
        const member = room && sessionId
          ? [...room.members.values()].find((entry) => entry.sessionId === sessionId || entry.remoteSessionId === sessionId)
          : null
        let items = rooms.messages({ roomId, limit })
        // Room Visibility: agents only see messages addressed to them or authored
        // by them; the host/User view (no session or host member) sees the room.
        if (member && member.role !== 'host') {
          items = items.filter((message) => message.from?.memberId === member.memberId || (Array.isArray(message.to) && message.to.includes(member.memberId)))
        }
        if (items.length === 0) return { text: '(no messages)' }
        const lines = items.map(
          (message) => `- [${new Date(message.createdAt).toISOString()}] ${message.fromLabel} → ${message.to.join(', ')}: ${message.text}`,
        )
        return { text: lines.join('\n') }
      } catch (error) {
        return fail(error)
      }
    },

    async room_status({ roomId }) {
      if (!rooms) return { text: 'Error: [unsupported] rooms are unavailable' }
      try {
        return { text: JSON.stringify(rooms.status(roomId), null, 2) }
      } catch (error) {
        return fail(error)
      }
    },

    async room_members(args, exec) {
      const sessionId = exec?.agent?.session?.id
      const requested = typeof args?.roomId === 'string' && args.roomId !== '' ? args.roomId : null
      if (rooms) {
        let room = requested ? rooms.rooms.get(requested) : null
        if (!room) {
          room = [...rooms.rooms.values()].find((candidate) => [...candidate.members.values()].some((member) =>
            member.sessionId === sessionId || member.memberId === `local:${sessionId}` || member.memberId === `host:${sessionId}`))
        }
        if (room) return { text: formatMembers(room.roomId, [...room.members.values()]) }
      }
      if (remotePeer?.membersForSession) {
        const remote = await remotePeer.membersForSession({ sessionId })
        if (remote) return { text: formatMembers(remote.roomId, remote.members) }
      }
      return { text: 'Error: [no-room] this session is not a Room participant; pass roomId or join a Room first' }
    },
    async room_sync(args, exec) {
      if (typeof syncRoom !== 'function') return { text: 'Error: [unsupported] replica sync is unavailable' }
      return syncRoom({ roomId: args?.roomId, sessionId: exec?.agent?.session?.id })
    },
    async room_remove_device({ roomId, deviceId, reason } = {}) {
      if (!rooms) return { text: 'Error: [unsupported] rooms are unavailable' }
      try {
        const result = await rooms.removeDeviceMembers({ roomId, deviceId, reason })
        return { text: `removed ${result.removed.length} member(s) of ${deviceId} from ${roomId}` }
      } catch (error) {
        return fail(error)
      }
    },

    async room_coordinator_update({ roomId, deviceId } = {}) {
      if (!rooms) return { text: 'Error: [unsupported] rooms are unavailable' }
      try {
        return { text: JSON.stringify(await rooms.updateCoordinator({ roomId, deviceId }), null, 2) }
      } catch (error) {
        return fail(error)
      }
    },

    async room_archive({ roomId, archived = true } = {}) {
      if (typeof archiveRoom !== 'function') return { text: 'Error: [unsupported] room archive is unavailable' }
      try {
        return { text: JSON.stringify(await archiveRoom({ roomId, archived: archived !== false })) }
      } catch (error) {
        return fail(error)
      }
    },

    async room_restore({ roomId } = {}) {
      if (typeof restoreRoom !== 'function') return { text: 'Error: [unsupported] room restore is unavailable' }
      try {
        return { text: JSON.stringify(await restoreRoom({ roomId })) }
      } catch (error) {
        return fail(error)
      }
    },

    async room_delete({ roomId } = {}) {
      if (typeof deleteRoom !== 'function') return { text: 'Error: [unsupported] room delete is unavailable' }
      try {
        const result = await deleteRoom({ roomId })
        if (typeof onRoomClose === 'function') onRoomClose(roomId)
        return { text: JSON.stringify(result) }
      } catch (error) {
        return fail(error)
      }
    },

    async room_gc({ roomId, minEvents } = {}) {
      if (typeof compactRoom !== 'function') return { text: 'Error: [unsupported] room GC is unavailable' }
      try {
        return { text: JSON.stringify(await compactRoom({ roomId, minEvents })) }
      } catch (error) {
        return fail(error)
      }
    },

    async room_policy_update({ roomId, policy } = {}) {
      if (!rooms) return { text: 'Error: [unsupported] rooms are unavailable' }
      try {
        return { text: JSON.stringify(await rooms.updatePolicy({ roomId, policy }), null, 2) }
      } catch (error) {
        return fail(error)
      }
    },

    async room_invite_create({ roomId, ttlMs, note } = {}) {
      if (!rooms) return { text: 'Error: [unsupported] rooms are unavailable' }
      try {
        const code = rooms.createInvite({ roomId, ttlMs, note })
        return { text: `room invite (${roomId}):\n${code}` }
      } catch (error) {
        return fail(error)
      }
    },

    async room_invite_accept({ code, name } = {}) {
      if (typeof acceptInvite !== 'function') return { text: 'Error: [unsupported] invite acceptance is unavailable' }
      try {
        return await acceptInvite({ code, name })
      } catch (error) {
        return fail(error)
      }
    },

    async room_leave({ roomId } = {}, exec) {
      if (!rooms) return { text: 'Error: [unsupported] rooms are unavailable' }
      try {
        const room = rooms.rooms?.get?.(roomId)
        if (!room) return { text: 'Error: [unknown-room] Room not found' }
        const sessionId = exec?.agent?.session?.id
        const member = [...room.members.values()].find((entry) => entry.sessionId === sessionId || entry.remoteSessionId === sessionId)
        if (!member) return { text: 'Error: [unknown-member] this session is not a Room member' }
        if (member.role === 'host') {
          await rooms.close({ roomId, reason: 'host left the room' })
          return { text: `host left and closed room ${roomId}` }
        }
        await rooms.removeMember({ roomId, memberId: member.memberId, reason: 'left' })
        // This local mirror belongs to exactly one participant session; once it
        // leaves, close and clean the local mirror so the old Room is gone.
        if (room.mirror) await rooms.close({ roomId, reason: 'participant left' })
        return { text: `left room ${roomId} as ${member.memberId}` }
      } catch (error) {
        return fail(error)
      }
    },

    async room_reply(args, exec) {
      if (!remotePeer?.replyFromTool) return { text: 'Error: [unsupported] remote Room participant channel unavailable' }
      return remotePeer.replyFromTool({ sessionId: exec?.agent?.session?.id, text: args?.text })
    },
    async room_authority_promote({ roomId } = {}) {
      if (typeof promoteMirror !== 'function') return { text: 'Error: [unsupported] mirror promotion is unavailable' }
      try {
        return { text: JSON.stringify(await promoteMirror({ roomId })) }
      } catch (error) {
        return fail(error)
      }
    },

    async room_authority_claim({ roomId } = {}) {
      if (typeof claimAuthority !== 'function') return { text: 'Error: [unsupported] authority claim is unavailable' }
      try {
        return { text: JSON.stringify(await claimAuthority({ roomId })) }
      } catch (error) {
        return fail(error)
      }
    },

    async room_task_add({ roomId, title, owner, dependsOn, description }) {
      if (!rooms) return { text: 'Error: [unsupported] rooms are unavailable' }
      try {
        const task = await rooms.addTask({ roomId, title, owner, dependsOn: dependsOn ?? [], description: description ?? '' })
        return { text: `task ${task.id} added for ${task.owner}: ${task.title}` }
      } catch (error) {
        return fail(error)
      }
    },

    async room_task_update({ roomId, id, status, owner, note }) {
      if (!rooms) return { text: 'Error: [unsupported] rooms are unavailable' }
      try {
        const result = await rooms.updateTask({ roomId, id, status, owner, note })
        if (status === 'done' && typeof onTaskDone === 'function') onTaskDone(id, roomId)
        const handed = result.handedOff.length > 0 ? `; handed off to ${result.handedOff.map((item) => item.owner).join(', ')}` : ''
        return { text: `task ${result.task.id} updated (${result.task.status})${handed}` }
      } catch (error) {
        return fail(error)
      }
    },

    async room_task_list({ roomId }) {
      if (!rooms) return { text: 'Error: [unsupported] rooms are unavailable' }
      try {
        const tasks = rooms.listTasks(roomId)
        if (tasks.length === 0) return { text: '(no tasks)' }
        return {
          text: tasks
            .map((task) => `- [${task.status}] ${task.title} (${task.id}) owner=${task.owner}${task.dependsOn.length ? ` deps=${task.dependsOn.join(',')}` : ''}`)
            .join('\n'),
        }
      } catch (error) {
        return fail(error)
      }
    },

    async room_close({ roomId, reason }) {
      if (!rooms) return { text: 'Error: [unsupported] rooms are unavailable' }
      try {
        await rooms.close({ roomId, reason: reason ?? 'closed by host' })
        if (typeof onRoomClose === 'function') onRoomClose(roomId)
        return { text: `room closed: ${roomId}` }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_list() {
      const lines = []
      lines.push(`this device: ${node.identity.deviceId} (${node.name})`)
      const seen = new Set([node.identity.deviceId])
      const online = new Set(node.peerIds())
      const discovered = new Map([...node.discovered.values()].map((peer) => [peer.deviceId, peer]))
      for (const entry of node.rosterEntries()) {
        if (seen.has(entry.deviceId)) continue
        seen.add(entry.deviceId)
        lines.push(`- ${entry.deviceId} (${entry.name ?? 'device'}) ${online.has(entry.deviceId) ? 'online' : 'offline'}${online.has(entry.deviceId) ? '' : ' — direct calls fail while offline'}`)
      }
      for (const [deviceId, peer] of discovered) {
        if (seen.has(deviceId)) continue
        seen.add(deviceId)
        lines.push(`- ${deviceId} (${peer.name ?? 'device'}) discovered${online.has(deviceId) ? ', online' : ''}`)
      }
      if (lines.length === 1) lines.push('(no other devices known yet; pair/enroll one with an invite first)')
      return { text: lines.join('\n') }
    },

    async fleet_tools({ device }) {
      try {
        const result = await client.listTools(device)
        const tools = Array.isArray(result?.tools) ? result.tools : []
        if (tools.length === 0) return { text: `(no tools visible on ${device})` }
        const lines = tools.map((tool) => `- ${tool.name}${tool.description ? `: ${String(tool.description).slice(0, 160)}` : ''}`)
        return { text: lines.join('\n') }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_call({ device, tool, parameters, roomId, taskId }) {
      try {
        const result = await client.call(device, { capability: 'tool', tool, args: parameters ?? {}, ...(roomId ? { roomId } : {}), ...(taskId ? { taskId } : {}) })
        return { text: client.render(result) }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_delegate({ device, task, label, cwd, roomId, taskId }) {
      try {
        const result = await client.delegate(
          device,
          { task, ...(label ? { label } : {}), ...(cwd ? { cwd } : {}), ...(roomId ? { roomId } : {}), ...(taskId ? { taskId } : {}) },
          { timeoutMs: 200_000 },
        )
        const meta = result?.childId ? `\n[delegated on ${device} · ${String(result.durationMs ?? 0)}ms · child ${String(result.childId)}]` : ''
        return { text: `${String(result?.text ?? '')}${meta}`.trim() }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_read({ device, path, offset, limit }) {
      try {
        const args = { file_path: path }
        if (offset !== undefined) args.offset = offset
        if (limit !== undefined) args.limit = limit
        const result = await client.call(device, { capability: 'read', tool: 'read', args })
        return { text: client.render(result) }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_fetch({ device, path }) {
      try {
        const result = await client.call(device, { capability: 'fetch', args: { path } })
        return { text: client.render(result) }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_run({ device, command, roomId, taskId }) {
      try {
        const result = await client.call(device, { capability: 'run', args: { command }, ...(roomId ? { roomId } : {}), ...(taskId ? { taskId } : {}) })
        return { text: client.render(result) }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_upload({ device, localPath, remotePath, recursive = false, resume = false } = {}) {
      if (typeof device !== 'string' || device === '') return { text: 'Error: [bad-request] device is required' }
      if (typeof localPath !== 'string' || localPath === '') return { text: 'Error: [bad-request] localPath is required' }
      if (typeof remotePath !== 'string' || remotePath === '') return { text: 'Error: [bad-request] remotePath is required' }
      try {
        const info = fs.statSync(localPath)
        if (info.isDirectory()) {
          if (recursive !== true) return { text: 'Error: [bad-request] localPath is a directory; pass recursive: true' }
          const files = localTransferFiles({ root: localPath })
          let bytes = 0
          for (const file of files) {
            const remote = path.join(remotePath, file.relative)
            const result = await uploadOne(device, file.absolute, remote, { resume })
            bytes += result.bytes
          }
          return { text: `uploaded ${files.length} files (${bytes} bytes) to ${device}:${remotePath}` }
        }
        const result = await uploadOne(device, localPath, remotePath, { resume })
        return { text: `uploaded ${result.bytes} bytes to ${device}:${remotePath} (sha256 ${result.sha256})` }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_download({ device, remotePath, localPath, recursive = false, resume = false } = {}) {
      if (typeof device !== 'string' || device === '') return { text: 'Error: [bad-request] device is required' }
      if (typeof remotePath !== 'string' || remotePath === '') return { text: 'Error: [bad-request] remotePath is required' }
      if (typeof localPath !== 'string' || localPath === '') return { text: 'Error: [bad-request] localPath is required' }
      try {
        if (recursive === true) {
          const listing = await node.request(device, 'fleet.file.list', { path: remotePath, recursive: true }, { timeoutMs: 60_000 })
          const files = (listing?.entries ?? []).filter((entry) => entry.isFile === true)
          let bytes = 0
          for (const file of files) {
            const result = await downloadOne(device, file.path, path.join(localPath, file.relative), { resume })
            bytes += result.bytes
          }
          return { text: `downloaded ${files.length} files (${bytes} bytes) from ${device}:${remotePath} to ${localPath}` }
        }
        const result = await downloadOne(device, remotePath, localPath, { resume })
        return { text: `downloaded ${result.bytes} bytes from ${device}:${remotePath} to ${localPath} (sha256 ${result.sha256})` }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_file_list({ device, path: remotePath, recursive = false } = {}) {
      if (typeof device !== 'string' || device === '') return { text: 'Error: [bad-request] device is required' }
      if (typeof remotePath !== 'string' || remotePath === '') return { text: 'Error: [bad-request] path is required' }
      try {
        const listing = await node.request(device, 'fleet.file.list', { path: remotePath, recursive: recursive === true }, { timeoutMs: 60_000 })
        const lines = (listing?.entries ?? []).map((entry) =>
          `${entry.isDirectory ? 'd' : '-'} ${String(entry.size).padStart(10)} ${entry.relative}${entry.isSymbolicLink ? ' -> link' : ''}`,
        )
        return { text: [`${listing?.path ?? remotePath}${listing?.truncated ? ' (truncated)' : ''}`, ...lines].join('\n') }
      } catch (error) {
        return fail(error)
      }
    },

    async fleet_file_delete({ device, path: remotePath, recursive = false } = {}) {
      if (typeof device !== 'string' || device === '') return { text: 'Error: [bad-request] device is required' }
      if (typeof remotePath !== 'string' || remotePath === '') return { text: 'Error: [bad-request] path is required' }
      try {
        const result = await node.request(device, 'fleet.file.delete', { path: remotePath, recursive: recursive === true }, { timeoutMs: 60_000 })
        return { text: `deleted ${String(result?.path ?? remotePath)}${result?.recursive ? ' (recursive)' : ''}` }
      } catch (error) {
        return fail(error)
      }
    },
  }
}

/** Build the model-facing ToolDefinitions once `defineTool` is available. */
function formatMembers(roomId, members) {
  if (!Array.isArray(members) || members.length === 0) return `room ${roomId}: (no members)`
  const lines = members.map((member) =>
    `- ${member.name ?? member.memberId} · role=${member.role ?? '?'} · kind=${member.kind ?? '?'}${member.deviceId ? ` · device=${String(member.deviceId).slice(0, 8)}` : ''}${member.memberId ? ` · ${member.memberId}` : ''}`)
  return [`room ${roomId} (${members.length} members)`, ...lines].join('\n')
}

export function createFleetToolDefinitions({ defineTool, handlers }) {
  const output = textOutput()
  const commonDevice = { type: 'string', required: true, description: 'Target device id from `fleet_list`.' }
  return [
    defineTool({
      name: 'fleet_status',
      description:
        'Show this device\'s Fleet network status for troubleshooting: device id, direct listener address/port, discovery, connected peers, roster and invite/manual address hints. Use it when discovery does not find the other device.',
      parameters: {},
      output,
      execute: () => handlers.fleet_status(),
    }),
    defineTool({
      name: 'fleet_relay_reconnect',
      description:
        'Reconnect all Relay clients after rotating the local mTLS client certificate/key files. The Relay re-reads its client-fingerprint allowlist on every connection, so a removed/revoked fingerprint is rejected on the next reconnect.',
      parameters: {},
      output,
      execute: () => handlers.fleet_relay_reconnect(),
    }),
    defineTool({
      name: 'fleet_connect',
      description:
        'Connect to another device by explicit host and port when LAN discovery is unavailable. Use it with the port printed by that device\'s `fleet_status`; the peer id is learned from the authenticated handshake.',
      parameters: {
        host: { type: 'string', required: true, description: 'Target host/IP address on the LAN or VPN.' },
        port: { type: 'number', required: true, description: 'Target device\'s Fleet direct port (from its fleet_status).' },
      },
      output,
      execute: (args) => handlers.fleet_connect(args),
    }),
    defineTool({
      name: 'fleet_queue_call',
      description:
        'Queue a direct tool call for a target device in the durable outbox. It runs immediately if the target is connected, otherwise on reconnect/retry; inspect with fleet_outbox / fleet_outbox_result. Use this instead of fleet_call when the call must survive the target being offline.',
      parameters: {
        device: commonDevice,
        tool: { type: 'string', required: true, description: 'Tool name on the target device.' },
        parameters: { type: 'object', additionalProperties: true, description: 'Arguments object for that tool.' },
        capability: { type: 'string', description: 'Capability to request (default tool).' },
        roomId: { type: 'string', description: 'Optional Room context.' },
        taskId: { type: 'string', description: 'Optional task context.' },
        label: { type: 'string', description: 'Optional label shown in fleet_outbox.' },
      },
      output,
      execute: (args) => handlers.fleet_queue_call(args),
    }),
    defineTool({
      name: 'fleet_queue_delegate',
      description:
        'Queue a one-shot delegation in the durable outbox. It runs on reconnect/retry and stores the final text; inspect with fleet_outbox / fleet_outbox_result.',
      parameters: {
        device: commonDevice,
        task: { type: 'string', required: true, description: 'Self-contained task for the target agent.' },
        label: { type: 'string', description: 'Optional label.' },
        cwd: { type: 'string', description: 'Optional working directory on the target.' },
        roomId: { type: 'string', description: 'Optional Room context.' },
        taskId: { type: 'string', description: 'Optional task context.' },
      },
      output,
      execute: (args) => handlers.fleet_queue_delegate(args),
    }),
    defineTool({
      name: 'fleet_outbox',
      description: 'List durable queued/running/done/failed outbox entries, optionally filtered by status.',
      parameters: {
        status: { type: 'string', enum: ['queued', 'running', 'done', 'failed'], description: 'Optional status filter.' },
      },
      output,
      execute: (args) => handlers.fleet_outbox(args),
    }),
    defineTool({
      name: 'fleet_outbox_result',
      description: 'Read one outbox entry, including its stored result text or error.',
      parameters: {
        id: { type: 'string', required: true, description: 'Outbox entry id.' },
      },
      output,
      execute: (args) => handlers.fleet_outbox_result(args),
    }),
    defineTool({
      name: 'fleet_outbox_cancel',
      description: 'Cancel a still-queued outbox entry.',
      parameters: {
        id: { type: 'string', required: true, description: 'Outbox entry id.' },
      },
      output,
      execute: (args) => handlers.fleet_outbox_cancel(args),
    }),
    defineTool({
      name: 'fleet_approvals',
      description:
        'List pending approval requests waiting on this device (remote direct calls or delegations whose Tool Policy is `ask`). Approval decisions are human-only: use the Device Fleet approval panel; this agent tool cannot approve or deny. Approvals expire after the configured timeout and fail closed.',
      parameters: {},
      output,
      execute: () => handlers.fleet_approvals(),
    }),
    defineTool({
      name: 'fleet_simulate_request',
      description:
        'Development helper (only when approval simulation is enabled): create a fake pending approval request so the inbox flow can be exercised without a second device. It does not execute anything.',
      parameters: {
        fromDeviceId: { type: 'string', description: 'Pretend caller device id.' },
        capability: { type: 'string', description: 'Capability name, e.g. run.' },
        tool: { type: 'string', description: 'Optional tool name.' },
        reason: { type: 'string', description: 'Optional reason shown in the request.' },
      },
      output,
      execute: (args) => handlers.fleet_simulate_request(args),
    }),
    defineTool({
      name: 'room_create',
      description:
        'Upgrade the current session into a Room Host (local logic layer) so multiple agents can collaborate with shared messages and a shared task board. Add participants with `room_add_local` (simulation) or the future remote invite flow. Only do this when the user explicitly wants multi-agent collaboration, not for a one-off remote tool call.',
      parameters: {
        policy: { type: 'object', additionalProperties: true, description: 'Optional room policy overrides (invite/join/maxMembers/boardWrite/remove).' },
      },
      output,
      execute: (args, exec) => handlers.room_create(args, exec),
    }),
    defineTool({
      name: 'room_add_remote',
      description:
        'Add a connected Fleet device as a remote Room participant. Messages addressed to that member are delegated to the device agent over the Fleet RPC, and its reply is appended to the Room transcript.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id returned by room_create.' },
        deviceId: { type: 'string', required: true, description: 'Target device id from fleet_list; it must be connected.' },
        name: { type: 'string', description: 'Participant display name shown in the Room.' },
      },
      output,
      execute: (args) => handlers.room_add_remote(args),
    }),
    defineTool({
      name: 'room_add_local',
      description:
        'Simulation helper: add a real local DSH agent as a Room participant (its own session), for exercising addressing/wake/board logic on one DSH.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id returned by room_create.' },
        name: { type: 'string', description: 'Participant display name.' },
        agentPreset: { type: 'string', description: 'Optional agent preset id for the participant session.' },
        cwd: { type: 'string', description: 'Optional working directory for the participant session.' },
      },
      output,
      execute: (args) => handlers.room_add_local(args),
    }),
    defineTool({
      name: 'room_remove_member',
      description: 'Remove a participant from a Room (the host cannot be removed; close the room instead).',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id.' },
        memberId: { type: 'string', required: true, description: 'Member id from room_status.' },
        reason: { type: 'string', description: 'Optional reason recorded in the room log.' },
      },
      output,
      execute: (args) => handlers.room_remove_member(args),
    }),
    defineTool({
      name: 'room_send',
      description:
        'Send one addressed Room message as the calling agent. The host appends it to the canonical room log and wakes only the addressed participants; unaddressed members do not run. To say different things to different members, send separate messages.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id.' },
        to: { type: 'array', items: { type: 'string' }, required: true, description: 'Recipient member ids.' },
        text: { type: 'string', required: true, description: 'Message body.' },
      },
      output,
      execute: (args, exec) => handlers.room_send(args, exec),
    }),
    defineTool({
      name: 'room_messages',
      description: 'Read messages visible to this agent in a Room: the host/User view sees the full transcript; participant agents only see messages addressed to or authored by them.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id.' },
        limit: { type: 'number', description: 'Maximum recent messages to return (default 50).' },
      },
      output,
      execute: (args, exec) => handlers.room_messages(args, exec),
    }),
    defineTool({
      name: 'room_status',
      description: 'Show one Room\'s members, policy, message count and task count.',
      parameters: { roomId: { type: 'string', required: true, description: 'Room id.' } },
      output,
      execute: (args) => handlers.room_status(args),
    }),
    defineTool({
      name: 'room_sync',
      description:
        'Synchronize this Room replica with other Room members. Omit roomId to resolve the Room from the current session/mirror; returns imported event counts and local message/seq state.',
      parameters: {
        roomId: { type: 'string', description: 'Optional Room id; omit to resolve from the current session/mirror.' },
      },
      output: textOutput(),
      execute: (args, exec) => handlers.room_sync(args, exec),
    }),
    defineTool({
      name: 'room_members',
      description:
        'List the members of the Room this agent participates in (host, local participants, remote devices). Omit roomId to resolve the Room from the current session; useful for participants that do not know the Host room id.',
      parameters: {
        roomId: { type: 'string', description: 'Optional Room id; omit to resolve from the current session/mirror.' },
      },
      output: textOutput(),
      execute: (args, exec) => handlers.room_members(args, exec),
    }),
    defineTool({
      name: 'room_invite_create',
      description: 'Create a one-time Room Invite (roomId + room key + expiry) that can be accepted on another device.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id.' },
        ttlMs: { type: 'number', description: 'Validity in milliseconds (default 24h).' },
        note: { type: 'string', description: 'Optional note for the invitee.' },
      },
      output,
      execute: (args) => handlers.room_invite_create(args),
    }),
    defineTool({
      name: 'room_invite_accept',
      description: 'Accept a Room Invite on this device: create a local participant session/mirror and join the authority Room.',
      parameters: {
        code: { type: 'string', required: true, description: 'Invite code from room_invite_create.' },
        name: { type: 'string', description: 'Participant name (default remote).' },
      },
      output,
      execute: (args) => handlers.room_invite_accept(args),
    }),
    defineTool({
      name: 'room_leave',
      description: 'Leave a Room as the calling session. Non-host members remove themselves; the host closes the Room.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id.' },
      },
      output,
      execute: (args, exec) => handlers.room_leave(args, exec),
    }),
    defineTool({
      name: 'room_remove_device',
      description: 'Remove every Room member owned by one Fleet device (device removal cascade) and rotate the Room key.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id.' },
        deviceId: { type: 'string', required: true, description: 'Fleet device id to remove.' },
        reason: { type: 'string', description: 'Optional reason recorded in the member events.' },
      },
      output,
      execute: (args) => handlers.room_remove_device(args),
    }),
    defineTool({
      name: 'room_coordinator_update',
      description: 'Set the Room coordinator device (LWW metadata). The creator stays recorded separately; coordinator can change without changing Room contents.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id.' },
        deviceId: { type: 'string', required: true, description: 'Fleet device id to designate as coordinator.' },
      },
      output,
      execute: (args) => handlers.room_coordinator_update(args),
    }),
    defineTool({
      name: 'room_archive',
      description: 'Archive or unarchive the local Room replica index. Event data is kept; use room_delete to remove it.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id.' },
        archived: { type: 'boolean', description: 'true to archive (default), false to unarchive.' },
      },
      output,
      execute: (args) => handlers.room_archive(args),
    }),
    defineTool({
      name: 'room_restore',
      description:
        'Restore an archived Room from its local replica so it becomes an active, writable Room again without restarting DSH. If the Room is still in memory it is simply reopened; otherwise it is rehydrated from the replica state (messages/tasks/members are kept).',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Archived Room id from the Fleet console / room list.' },
      },
      output,
      execute: (args) => handlers.room_restore(args),
    }),
    defineTool({
      name: 'room_delete',
      description: 'Close (if needed) and delete the local Room replica. The authority close event also cleans remote mirrors via room.closed.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id.' },
      },
      output,
      execute: (args) => handlers.room_delete(args),
    }),
    defineTool({
      name: 'room_gc',
      description: 'Compact this Room replica event log into one snapshot (admin maintenance). Keeps state and vector clock.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id.' },
        minEvents: { type: 'number', description: 'Only compact when the log has at least this many events (default 400).' },
      },
      output,
      execute: (args) => handlers.room_gc(args),
    }),
    defineTool({
      name: 'room_policy_update',
      description: 'Update the Room policy (invite/join/maxMembers/boardWrite/remove); writes a signed policy event and syncs it. User/admin only by Room policy.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id.' },
        policy: { type: 'object', required: true, additionalProperties: true, description: 'Partial policy object to merge.' },
      },
      output,
      execute: (args) => handlers.room_policy_update(args),
    }),
    defineTool({
      name: 'room_reply',
      description:
        'Send a message as this agent into the shared Fleet Room that woke it. Use this tool to answer Room messages (remote participant channel).',
      parameters: {
        text: { type: 'string', required: true, description: 'Message text to send to the Room.' },
      },
      output: textOutput(),
      execute: (args, exec) => handlers.room_reply(args, exec),
    }),
    defineTool({
      name: 'room_authority_promote',
      description: 'Promote this local mirror Room to authority after the previous authority is gone. Preserves authorityRoomId and raises the authority epoch.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Local mirror Room id.' },
      },
      output,
      execute: (args) => handlers.room_authority_promote(args),
    }),
    defineTool({
      name: 'room_authority_claim',
      description: 'Claim Room authority after the previous authority is gone. Raises authorityEpoch; old authority writes are rejected once it observes the claim.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id.' },
      },
      output,
      execute: (args) => handlers.room_authority_claim(args),
    }),
    defineTool({
      name: 'room_task_add',
      description:
        'Add one shared Room Board task. Use dependsOn to express serial handoff: when all dependencies are done, the owner is woken with a "ready" message. Parallel tasks have no dependencies and do not block each other.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id.' },
        title: { type: 'string', required: true, description: 'Task title.' },
        owner: { type: 'string', required: true, description: 'Owner member id.' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete first.' },
        description: { type: 'string', description: 'Optional task detail.' },
      },
      output,
      execute: (args) => handlers.room_task_add(args),
    }),
    defineTool({
      name: 'room_task_update',
      description:
        'Update one Room Board task. Marking it done triggers serial handoff: owners of pending dependent tasks are woken. Keep status/steps current when starting and finishing your block.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id.' },
        id: { type: 'string', required: true, description: 'Task id.' },
        status: { type: 'string', enum: ['pending', 'running', 'done', 'blocked'], description: 'New status.' },
        owner: { type: 'string', description: 'Optional new owner memberId.' },
        note: { type: 'string', description: 'Optional progress note.' },
      },
      output,
      execute: (args) => handlers.room_task_update(args),
    }),
    defineTool({
      name: 'room_task_list',
      description: 'List the shared Room Board tasks with status, owner and dependencies.',
      parameters: { roomId: { type: 'string', required: true, description: 'Room id.' } },
      output,
      execute: (args) => handlers.room_task_list(args),
    }),
    defineTool({
      name: 'room_close',
      description: 'Close a Room (archives its canonical log); participants are no longer woken afterwards.',
      parameters: {
        roomId: { type: 'string', required: true, description: 'Room id.' },
        reason: { type: 'string', description: 'Optional close reason.' },
      },
      output,
      execute: (args) => handlers.room_close(args),
    }),
    defineTool({
      name: 'fleet_invite',
      description:
        'Create a Fleet invite code for another device. Only do this when the user asks to pair a new device. Treat the returned code as a secret; it carries the fleet key.',
      parameters: {},
      output,
      execute: () => handlers.fleet_invite(),
    }),
    defineTool({
      name: 'fleet_rotate_identity',
      description: 'Rotate this device Ed25519/X25519 keys while keeping deviceId. Requires every connected peer to acknowledge the old-key-signed rotation record; aborts if any peer fails.',
      parameters: {},
      output,
      execute: () => handlers.fleet_rotate_identity(),
    }),
    defineTool({
      name: 'fleet_rotation_status',
      description:
        'Show the signed device-key rotation state of this Fleet: each device\'s rotation seq/head, revocations, and any detected rotation fork. Use it after a rotation failure, before fleet_rotation_fork_resolve, or when a peer is rejected with rotation-* errors.',
      parameters: {
        deviceId: { type: 'string', description: 'Optional device id; omit for every roster device plus this device.' },
      },
      output,
      execute: (args) => handlers.fleet_rotation_status(args),
    }),
    defineTool({
      name: 'fleet_rotation_compact',
      description:
        'Archive old device-key rotation records and keep only the most recent ones, so handshakes stay small. Peers pinned below the retained window can no longer be verified and must re-pair; the handshake reports rotation-history-pruned. Requires confirm: true.',
      parameters: {
        keep: { type: 'number', description: 'How many recent records to keep (default 64, minimum 8).' },
        confirm: { type: 'boolean', description: 'Must be true; old records are archived and unreachable peers must re-pair.' },
      },
      output,
      execute: (args) => handlers.fleet_rotation_compact(args),
    }),
    defineTool({
      name: 'fleet_rotation_trust_checkpoint',
      description:
        'Trust a peer\'s signed rotation checkpoint when its chain history was pruned below this device\'s pin. This skips normal chain verification and must be a user-confirmed trust decision; inspect fleet_rotation_status first. Requires confirm: true.',
      parameters: {
        deviceId: { type: 'string', required: true, description: 'Fleet device id whose checkpoint was offered.' },
        confirm: { type: 'boolean', description: 'Must be true; the user has to confirm trusting the checkpoint.' },
      },
      output,
      execute: (args) => handlers.fleet_rotation_trust_checkpoint(args),
    }),
    defineTool({
      name: 'fleet_revoke_device',
      description:
        'Permanently revoke a Fleet device on this device: it is disconnected, removed from Room memberships, rejected at every future handshake, and the revocation is advertised to other connected devices (they confirm it locally). Use only after the user explicitly confirms; a leaked key cannot be repaired by rotation alone.',
      parameters: {
        deviceId: { type: 'string', required: true, description: 'Fleet device id from fleet_list.' },
        reason: { type: 'string', description: 'Why the device is revoked (kept in the local audit state).' },
        confirm: { type: 'boolean', description: 'Must be true; the user has to confirm the revocation explicitly.' },
      },
      output,
      execute: (args) => handlers.fleet_revoke_device(args),
    }),
    defineTool({
      name: 'fleet_rotation_fork_resolve',
      description:
        'Resolve a detected rotation-chain fork on this device after the user inspects fleet_rotation_status. `keep-local` keeps this device\'s verified branch; `adopt-peer` trusts the peer branch only when it connects to a verified local prefix. Requires confirm: true.',
      parameters: {
        deviceId: { type: 'string', required: true, description: 'Fleet device id whose chain forked.' },
        action: { type: 'string', enum: ['keep-local', 'adopt-peer'], description: 'Which branch to trust; defaults to keep-local.' },
        confirm: { type: 'boolean', description: 'Must be true; choosing a branch is a manual trust decision.' },
      },
      output,
      execute: (args) => handlers.fleet_rotation_fork_resolve(args),
    }),
    defineTool({
      name: 'fleet_reset_identity',
      description:
        'Leak recovery: archive this device\'s identity and rotation chain, then generate a brand-new deviceId so a compromised key can never re-authenticate. Peers must re-admit the new device; use fleet_revoke_device on the other devices first. Requires confirm: true.',
      parameters: {
        confirm: { type: 'boolean', description: 'Must be true; the device id changes and every peer disconnects.' },
        reason: { type: 'string', description: 'Optional note recorded in the local audit log.' },
      },
      output,
      execute: (args) => handlers.fleet_reset_identity(args),
    }),
    defineTool({
      name: 'fleet_remove_device',
      description: 'Remove one device from this Fleet roster, disconnect it, and remove all its Room memberships (device removal cascade).',
      parameters: {
        deviceId: { type: 'string', required: true, description: 'Fleet device id to remove.' },
      },
      output,
      execute: (args) => handlers.fleet_remove_device(args),
    }),
    defineTool({
      name: 'fleet_join',
      description:
        'Join an existing Fleet with an invite code from `fleet_invite` on another device. The enrollment is queued and takes effect after the device-fleet plugin is reloaded (or DSH restarts); a full DSH restart is not required.',
      parameters: {
        code: { type: 'string', required: true, description: 'Invite code produced by fleet_invite on another device.' },
      },
      output,
      execute: (args) => handlers.fleet_join(args),
    }),
    defineTool({
      name: 'fleet_list',
      description:
        'List the devices in this Fleet with their online status. Call it before any `fleet_*` call to learn which device id to use. Offline devices are listed too, but direct calls to them fail fast; use a Room/delegation instead of waiting.',
      parameters: {},
      output,
      execute: () => handlers.fleet_list(),
    }),
    defineTool({
      name: 'fleet_tools',
      description:
        'List the tools another device exposes to direct calls (name + description). Use it only when you need an untyped tool; the typed shortcuts `fleet_read` / `fleet_fetch` / `fleet_run` cover the common cases.',
      parameters: { device: commonDevice },
      output,
      execute: (args) => handlers.fleet_tools(args),
    }),
    defineTool({
      name: 'fleet_call',
      description:
        'Call one tool on another device directly. Direct calls are stateless: no Room, no shared conversation, no remote history. Use `fleet_tools` first to discover names/arguments, or prefer the typed shortcuts. The target device decides whether to allow, ask its user, or reject.',
      parameters: {
        device: commonDevice,
        tool: { type: 'string', required: true, description: 'Tool name on the target device.' },
        parameters: { type: 'object', additionalProperties: true, description: 'Arguments object for that tool.' },
        roomId: { type: 'string', description: 'Optional Room context, used for Room-scoped approvals.' },
        taskId: { type: 'string', description: 'Optional task context, used for task-scoped approvals.' },
      },
      output,
      execute: (args) => handlers.fleet_call(args),
    }),
    defineTool({
      name: 'fleet_delegate',
      description:
        'Delegate a one-shot task to another device\'s agent and wait for its final answer. Use it when the work needs that device\'s model and tools ("let B build/check this"), not just one tool call. The delegated agent runs on the target device; it does not join a Room and its history is not shared. The target device decides whether delegation is allowed or needs local approval.',
      parameters: {
        device: commonDevice,
        task: { type: 'string', required: true, description: 'Self-contained task instructions for the target agent.' },
        label: { type: 'string', description: 'Short label shown in the target device\'s subagent list.' },
        cwd: { type: 'string', description: 'Optional working directory on the target device.' },
        roomId: { type: 'string', description: 'Optional Room context, used for Room-scoped approvals.' },
        taskId: { type: 'string', description: 'Optional task context, used for task-scoped approvals.' },
      },
      output,
      execute: (args) => handlers.fleet_delegate(args),
    }),
    defineTool({
      name: 'fleet_read',
      description:
        'Read a file on another device (shortcut over `fleet_call` with the target `read` tool). Paths must be inside the roots that device allows. Use it to inspect logs/docs on another machine without opening a Room.',
      parameters: {
        device: commonDevice,
        path: { type: 'string', required: true, description: 'Absolute path on the target device.' },
        offset: { type: 'number', description: 'Line offset, when supported by the target read tool.' },
        limit: { type: 'number', description: 'Maximum lines to return.' },
      },
      output,
      execute: (args) => handlers.fleet_read(args),
    }),
    defineTool({
      name: 'fleet_fetch',
      description:
        'Fetch a file from another device and return its text content. Use it for "look at B\'s file and bring it over"; for large binaries prefer `fleet_run` with a transfer command.',
      parameters: {
        device: commonDevice,
        path: { type: 'string', required: true, description: 'Absolute path on the target device.' },
      },
      output,
      execute: (args) => handlers.fleet_fetch(args),
    }),
    defineTool({
      name: 'fleet_run',
      description:
        'Run a shell command on another device (shortcut over `fleet_call` with the target shell tool). The target device\'s Tool Policy decides whether the command is auto-allowed, needs its local approval, or is rejected; an offline or timed-out approval fails. Use it for builds/tests and other work that belongs on that machine.',
      parameters: {
        device: commonDevice,
        command: { type: 'string', required: true, description: 'Shell command to run on the target device.' },
        roomId: { type: 'string', description: 'Optional Room context, used for Room-scoped approvals.' },
        taskId: { type: 'string', description: 'Optional task context, used for task-scoped approvals.' },
      },
      output,
      execute: (args) => handlers.fleet_run(args),
    }),
    defineTool({
      name: 'fleet_upload',
      description:
        'Upload a local file to another device in 512 KiB chunks with a SHA-256 check. The target Tool Policy gates this with the `write` capability (default ask) and its allowed roots; use it for binaries or large files that `fleet_fetch` cannot carry.',
      parameters: {
        device: commonDevice,
        localPath: { type: 'string', required: true, description: 'Path of the file on this device.' },
        remotePath: { type: 'string', required: true, description: 'Destination path on the target device (inside its allowed roots).' },
        recursive: { type: 'boolean', description: 'Upload a local directory tree when localPath is a directory.' },
        resume: { type: 'boolean', description: 'Resume from the remote file size when it is smaller than the local file.' },
      },
      output,
      execute: (args) => handlers.fleet_upload(args),
    }),
    defineTool({
      name: 'fleet_download',
      description:
        'Download a file (or directory with recursive: true) from another device in 512 KiB chunks with a SHA-256 check and write it locally. The target Tool Policy gates this with the `fetch`/`list` capabilities and its allowed roots.',
      parameters: {
        device: commonDevice,
        remotePath: { type: 'string', required: true, description: 'Path of the file/directory on the target device.' },
        localPath: { type: 'string', required: true, description: 'Destination path on this device.' },
        recursive: { type: 'boolean', description: 'Download a directory tree when remotePath is a directory.' },
        resume: { type: 'boolean', description: 'Resume from a local .part file when possible.' },
      },
      output,
      execute: (args) => handlers.fleet_download(args),
    }),
    defineTool({
      name: 'fleet_file_list',
      description: 'List a file or directory on another device (optionally recursive). Paths must be inside the target allowed roots.',
      parameters: {
        device: commonDevice,
        path: { type: 'string', required: true, description: 'Path on the target device.' },
        recursive: { type: 'boolean', description: 'Include nested entries.' },
      },
      output,
      execute: (args) => handlers.fleet_file_list(args),
    }),
    defineTool({
      name: 'fleet_file_delete',
      description: 'Delete a file, or a directory with recursive: true, on another device. The target Tool Policy gates this with the `write` capability.',
      parameters: {
        device: commonDevice,
        path: { type: 'string', required: true, description: 'Path on the target device.' },
        recursive: { type: 'boolean', description: 'Required to delete a non-empty directory.' },
      },
      output,
      execute: (args) => handlers.fleet_file_delete(args),
    }),
  ]
}
