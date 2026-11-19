// Local Room Replica store (ADR-0025, Phase 1).
//
// One writable replica per device per Room:
//   <dataDir>/rooms/<roomId>/events.jsonl  append-only, signed envelope reserved
//   <dataDir>/rooms/<roomId>/snapshot.json compacted state (written on demand)
//   <dataDir>/room-index.json              account-level Room metadata
//   <dataDir>/session-members.json         sessionId -> Room member mapping
//
// The legacy rooms.json is still the in-memory authority during Phase 1; this
// store is a write-through event log plus a migration target so Phase 2 can
// switch reads to the replica without another data migration.
import { randomUUID } from 'node:crypto'
import { friendlyName, memberDisplayName } from './human-names.js'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const REPLICA_VERSION = 1
const INDEX_FILE = 'room-index.json'
const SESSIONS_FILE = 'session-members.json'

function readJson(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    /* Windows ACLs ignore POSIX modes */
  }
}

function roomTitle(roomId) {
  return friendlyName(roomId)
}

function memberSummary(member) {
  return {
    memberId: member.memberId,
    role: member.role,
    kind: member.kind,
    sessionId: member.sessionId,
    deviceId: member.deviceId,
    remoteSessionId: member.remoteSessionId,
    name: member.name,
    displayName: memberDisplayName(member),
    avatarKey: member.avatarKey,
  }
}

function compareFieldVersion(left, right) {
  const leftAt = Number(left?.at ?? 0)
  const rightAt = Number(right?.at ?? 0)
  if (leftAt !== rightAt) return leftAt - rightAt
  return String(left?.by ?? '').localeCompare(String(right?.by ?? ''))
}

function mergeTaskState(current, remote) {
  if (!current) return remote
  const fields = ['title', 'description', 'owner', 'status', 'note']
  const merged = { ...current, fieldVersions: { ...(current.fieldVersions ?? {}) } }
  let changed = false
  for (const field of fields) {
    if (!(field in remote)) continue
    const remoteVersion = remote.fieldVersions?.[field] ?? { at: remote.updatedAt ?? 0, by: null }
    const localVersion = current.fieldVersions?.[field] ?? { at: current.updatedAt ?? 0, by: null }
    if (compareFieldVersion(remoteVersion, localVersion) > 0) {
      merged[field] = remote[field]
      merged.fieldVersions[field] = remoteVersion
      changed = true
    }
  }
  // dependsOn is an add-only OR-Set: merge by union instead of LWW.
  const dependencies = [...new Set([...(current.dependsOn ?? []), ...(remote.dependsOn ?? [])])]
  if (dependencies.length !== (current.dependsOn ?? []).length) {
    merged.dependsOn = dependencies
    changed = true
  }
  if (changed) merged.updatedAt = Math.max(Number(current.updatedAt ?? 0), Number(remote.updatedAt ?? 0))
  return changed ? merged : current
}

function emptyRoom(roomId) {
  return {
    roomId,
    createdAt: null,
    title: null,
    policy: null,
    creatorMemberId: null,
    hostSessionId: null,
    mirror: null,
    closed: false,
    members: new Map(),
    messages: [],
    tasks: new Map(),
    creatorMemberId: null,
    creatorDeviceId: null,
    coordinatorDeviceId: null,
    coordinatorUpdatedAt: 0,
    authorityDeviceId: null,
    authorityRoomId: null,
    authorityEpoch: 0,
    baseClock: {},
    lastSeq: 0,
  }
}

export class RoomReplicaStore {
  /**
   * @param {object} options
   * @param {string} options.dataDir device-fleet state directory
   * @param {() => number} [options.now]
   * @param {(line: string) => void} [options.warn]
   */
  constructor({ dataDir, deviceId = null, now = Date.now, warn = () => {}, signEvent = null, verifyEvent = null, requireSigned = false, onTaskEvent = null } = {}) {
    if (typeof dataDir !== 'string' || dataDir === '') throw new Error('RoomReplicaStore requires dataDir')
    this.dataDir = dataDir
    this.deviceId = deviceId
    this.now = now
    this.signEvent = typeof signEvent === 'function' ? signEvent : null
    this.verifyEvent = typeof verifyEvent === 'function' ? verifyEvent : null
    this.requireSigned = requireSigned === true
    this.warn = warn
    this.onTaskEvent = typeof onTaskEvent === 'function' ? onTaskEvent : null
    this.roomsDir = join(dataDir, 'rooms')
    this.indexFile = join(dataDir, INDEX_FILE)
    this.sessionsFile = join(dataDir, SESSIONS_FILE)
    this.index = readJson(this.indexFile, { version: REPLICA_VERSION, rooms: {} })
    if (!this.index || this.index.version !== REPLICA_VERSION) this.index = { version: REPLICA_VERSION, rooms: {} }
    if (!this.index.rooms || typeof this.index.rooms !== 'object') this.index.rooms = {}
    this.sessions = readJson(this.sessionsFile, { version: REPLICA_VERSION, sessions: {} })
    if (!this.sessions || this.sessions.version !== REPLICA_VERSION) this.sessions = { version: REPLICA_VERSION, sessions: {} }
    if (!this.sessions.sessions || typeof this.sessions.sessions !== 'object') this.sessions.sessions = {}
  }

  roomDir(roomId) {
    return join(this.roomsDir, String(roomId))
  }

  eventsPath(roomId) {
    return join(this.roomDir(roomId), 'events.jsonl')
  }

  snapshotPath(roomId) {
    return join(this.roomDir(roomId), 'snapshot.json')
  }

  hasReplica(roomId) {
    return existsSync(this.eventsPath(roomId)) || existsSync(this.snapshotPath(roomId))
  }

  saveIndex() {
    writeJsonAtomic(this.indexFile, { ...this.index, savedAt: this.now() })
  }

  saveSessions() {
    writeJsonAtomic(this.sessionsFile, { ...this.sessions, savedAt: this.now() })
  }

  bindSession(sessionId, { roomId, memberId, role = null, kind = null, deviceId = null } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    this.sessions.sessions[sessionId] = { roomId, memberId, role, kind, deviceId }
    this.saveSessions()
  }

  unbindSession(sessionId) {
    if (!sessionId || !this.sessions.sessions[sessionId]) return
    delete this.sessions.sessions[sessionId]
    this.saveSessions()
  }

  memberForSession(sessionId) {
    return this.sessions.sessions[sessionId] ?? null
  }

  sessionsForRoom(roomId) {
    return Object.entries(this.sessions.sessions)
      .filter(([, entry]) => entry.roomId === roomId)
      .map(([sessionId, entry]) => ({ sessionId, ...entry }))
  }

  /** Re-sign every local-origin event with the current device key. */
  resignLocalEvents(roomId) {
    if (!this.signEvent || !this.deviceId) return 0
    const events = this.loadEvents(roomId)
    let resigned = 0
    for (const event of events) {
      if (event.origin !== this.deviceId) continue
      const signature = this.signEvent(event)
      if (!signature) continue
      event.signature = signature
      resigned += 1
    }
    if (resigned === 0) return 0
    const target = this.eventsPath(roomId)
    const temporary = `${target}.resign`
    writeFileSync(temporary, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')
    renameSync(temporary, target)
    return resigned
  }

  /**
   * Replace the event log with one state snapshot (generic GC). The snapshot
   * carries the pre-GC vector clock so peers do not re-pull already-seen events.
   */
  compactEvents(roomId, { minEvents = 400 } = {}) {
    const events = this.loadEvents(roomId)
    if (events.length < Math.max(2, Number(minEvents) || 400)) return 0
    const baseClock = this.vectorClock(roomId)
    const state = this.state(roomId)
    const snapshot = {
      roomId,
      createdAt: state.createdAt,
      title: state.title,
      policy: state.policy,
      members: state.members,
      messages: state.messages.map(({ fromLabel, ...message }) => message),
      tasks: state.tasks,
      closed: state.closed,
      creatorMemberId: state.creatorMemberId,
      creatorDeviceId: state.creatorDeviceId,
      coordinatorDeviceId: state.coordinatorDeviceId,
      hostSessionId: state.hostSessionId,
      baseClock,
    }
    const event = this.append({ roomId, type: 'room.snapshot', author: { kind: 'system', source: 'gc' }, payload: { snapshot }, localOnly: true })
    event.seq = 1
    event.prev = null
    const target = this.eventsPath(roomId)
    const temporary = `${target}.gc`
    writeFileSync(temporary, `${JSON.stringify(event)}\n`, 'utf8')
    renameSync(temporary, target)
    this.index.rooms[roomId] = { roomId, lastSeq: 1, lastEventId: event.id, updatedAt: this.now() }
    this.saveIndex()
    return Math.max(0, events.length - 1)
  }

  /** Compact replicas whose event log crossed the automatic threshold. */
  autoCompact({ minEvents = 800 } = {}) {
    const compacted = []
    for (const roomId of Object.keys(this.index.rooms ?? {})) {
      try {
        const events = this.loadEvents(roomId)
        if (events.length < minEvents) continue
        const removed = this.compactEvents(roomId, { minEvents })
        compacted.push({ roomId, removed })
      } catch {
        /* one bad replica must not block startup */
      }
    }
    return compacted
  }

  /** Mark a replica archived without deleting its event log. */
  archiveReplica(roomId, archived = true) {
    if (!this.index.rooms[roomId]) return false
    this.index.rooms[roomId] = { ...this.index.rooms[roomId], archived: archived === true, updatedAt: this.now() }
    this.saveIndex()
    return true
  }

  /** Drop superseded local-only snapshot events, renumbering local log positions. */
  compactSnapshots(roomId) {
    const events = this.loadEvents(roomId)
    const snapshots = events.filter((event) => event.type === 'room.snapshot')
    if (snapshots.length <= 1) return 0
    const keepId = snapshots[snapshots.length - 1].id
    const kept = events.filter((event) => event.type !== 'room.snapshot' || event.id === keepId)
    let seq = 0
    let prev = null
    for (const event of kept) {
      seq += 1
      event.seq = seq
      event.prev = prev
      prev = event.id
    }
    const target = this.eventsPath(roomId)
    const temporary = `${target}.compact`
    writeFileSync(temporary, kept.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')
    renameSync(temporary, target)
    this.index.rooms[roomId] = {
      ...(this.index.rooms[roomId] ?? { roomId }),
      roomId,
      lastSeq: seq,
      lastEventId: prev,
      updatedAt: this.now(),
    }
    this.saveIndex()
    return snapshots.length - 1
  }

  /** Delete a local Room replica and its session mappings. */
  removeReplica(roomId) {
    try {
      rmSync(this.roomDir(roomId), { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    delete this.index.rooms[roomId]
    this.saveIndex()
    for (const [sessionId, entry] of Object.entries(this.sessions.sessions)) {
      if (sessionId === roomId || entry.roomId === roomId) delete this.sessions.sessions[sessionId]
    }
    this.saveSessions()
  }

  roomIndex() {
    return Object.values(this.index.rooms)
  }

  roomIndexEntry(roomId) {
    return this.index.rooms[roomId] ?? null
  }

  loadEvents(roomId) {
    const file = this.eventsPath(roomId)
    if (!existsSync(file)) return []
    const events = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const text = line.trim()
      if (text === '') continue
      try {
        const event = JSON.parse(text)
        if (event && event.v === REPLICA_VERSION && event.roomId === roomId && typeof event.seq === 'number') {
          // Legacy/migrated events predate origin counters. Treat them as
          // non-syncable legacy history rather than importing duplicates.
          events.push({
            ...event,
            origin: event.origin ?? event.author?.deviceId ?? 'legacy',
            originSeq: Number.isFinite(event.originSeq) ? event.originSeq : event.seq,
          })
        }
      } catch {
        this.warn(`[device-fleet] cannot parse a replica event line in ${file}`)
      }
    }
    events.sort((left, right) => left.seq - right.seq)
    return events
  }

  nextOriginSeq(roomId, origin) {
    let highest = 0
    for (const event of this.loadEvents(roomId)) {
      if (event.origin === origin && Number.isFinite(event.originSeq)) highest = Math.max(highest, event.originSeq)
    }
    return highest + 1
  }

  append({ roomId, type, author = { kind: 'system' }, payload = {}, createdAt = null, origin = null, originSeq = null, localOnly = false } = {}) {
    if (typeof roomId !== 'string' || roomId === '') throw new Error('roomId is required')
    if (typeof type !== 'string' || type === '') throw new Error('event type is required')
    const previous = this.index.rooms[roomId] ?? null
    const lastSeq = Number.isFinite(previous?.lastSeq) ? previous.lastSeq : this.lastSeqFromDisk(roomId)
    const lastEventId = previous?.lastEventId ?? this.lastEventIdFromDisk(roomId)
    const eventOrigin = origin ?? this.deviceId ?? 'local'
    const event = {
      v: REPLICA_VERSION,
      id: randomUUID(),
      roomId,
      seq: lastSeq + 1,
      origin: eventOrigin,
      originSeq: Number.isFinite(originSeq) ? originSeq : this.nextOriginSeq(roomId, eventOrigin),
      ...(localOnly ? { localOnly: true } : {}),
      type,
      author,
      payload,
      createdAt: Number.isFinite(createdAt) ? createdAt : this.now(),
      prev: lastEventId ?? null,
      signedRoomId: roomId,
      signature: null,
    }
    if (this.signEvent) {
      try {
        event.signature = this.signEvent(event)
      } catch {
        event.signature = null
      }
    }
    this.writeEvent(event, previous)
    this.applySessionEffects(event)
    this.saveIndex()
    return event
  }

  writeEvent(event, previous = this.index.rooms[event.roomId] ?? null) {
    mkdirSync(this.roomDir(event.roomId), { recursive: true })
    appendFileSync(this.eventsPath(event.roomId), `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(this.eventsPath(event.roomId), 0o600)
    } catch {
      /* Windows ACLs ignore POSIX modes */
    }
    this.index.rooms[event.roomId] = {
      ...(previous ?? { roomId: event.roomId }),
      roomId: event.roomId,
      lastSeq: event.seq,
      lastEventId: event.id,
      updatedAt: event.createdAt,
    }
  }

  /** Vector clock: highest originSeq seen per author device. */
  vectorClock(roomId) {
    const clock = {}
    for (const event of this.loadEvents(roomId)) {
      if (event.type === 'room.snapshot') {
        const baseClock = event.payload?.baseClock ?? event.payload?.snapshot?.baseClock
        if (baseClock) {
          for (const [origin, seq] of Object.entries(baseClock)) clock[origin] = Math.max(clock[origin] ?? 0, Number(seq) || 0)
          continue
        }
      }
      if (!event.origin || event.origin === 'legacy') continue
      clock[event.origin] = Math.max(clock[event.origin] ?? 0, event.originSeq ?? 0)
    }
    return clock
  }

  /** Events this replica has that the remote vector clock has not seen. */
  eventsMissingFor(roomId, remoteClock = {}) {
    const clock = remoteClock && typeof remoteClock === 'object' ? remoteClock : {}
    return this.loadEvents(roomId).filter((event) =>
      !event.localOnly && event.type !== 'room.snapshot' && event.origin !== 'legacy' && event.origin !== 'local' && (event.originSeq ?? 0) > (Number(clock[event.origin]) || 0),
    )
  }

  /** Import events fetched from another replica; preserve identity/origin, assign local seq. */
  importEvents(roomId, events = [], { sourceRoomId = roomId } = {}) {
    if (!Array.isArray(events) || events.length === 0) return 0
    const existing = new Set(this.loadEvents(roomId).map((event) => event.id))
    let imported = 0
    for (const remote of events) {
      if (!remote || remote.v !== REPLICA_VERSION || remote.roomId !== sourceRoomId || typeof remote.id !== 'string' || typeof remote.type !== 'string') continue
      // Snapshot/bootstrap events are local-only repair state, never synced.
      if (remote.localOnly || remote.type === 'room.snapshot') continue
      if (existing.has(remote.id)) continue
      if (this.requireSigned && !remote.signature) continue
      if (remote.signature && this.verifyEvent) {
        let valid = false
        try {
          valid = this.verifyEvent(remote)
        } catch {
          valid = false
        }
        if (!valid) continue
      }
      const previous = this.index.rooms[roomId] ?? { roomId }
      const lastSeq = Number.isFinite(previous.lastSeq) ? previous.lastSeq : this.lastSeqFromDisk(roomId)
      const lastEventId = previous.lastEventId ?? this.lastEventIdFromDisk(roomId)
      const event = {
        ...remote,
        roomId,
        signedRoomId: remote.signedRoomId ?? sourceRoomId,
        seq: lastSeq + 1,
        prev: lastEventId ?? null,
      }
      this.writeEvent(event, previous)
      existing.add(event.id)
      imported += 1
    }
    if (imported > 0) this.saveIndex()
    return imported
  }

  lastSeqFromDisk(roomId) {
    const events = this.loadEvents(roomId)
    return events.length === 0 ? 0 : events[events.length - 1].seq
  }

  lastEventIdFromDisk(roomId) {
    const events = this.loadEvents(roomId)
    return events.length === 0 ? null : events[events.length - 1].id
  }

  applySessionEffects(event) {
    if (event.type === 'member.joined' && event.payload?.member?.sessionId) {
      const member = event.payload.member
      this.bindSession(member.sessionId, {
        roomId: event.roomId,
        memberId: member.memberId,
        role: member.role,
        kind: member.kind,
        deviceId: member.deviceId ?? null,
      })
    }
    if ((event.type === 'member.left' || event.type === 'member.removed') && event.payload?.member?.sessionId) {
      this.unbindSession(event.payload.member.sessionId)
    }
  }

  /** Replay the event log into a UI/detail-compatible Room state. */
  state(roomId) {
    const room = emptyRoom(roomId)
    const messageIds = new Set()
    for (const event of this.loadEvents(roomId)) {
      room.lastSeq = event.seq
      const payload = event.payload ?? {}
      switch (event.type) {
        case 'room.created': {
          room.createdAt = event.createdAt
          room.title = payload.title ?? room.title
          room.policy = payload.policy ?? room.policy
          room.creatorMemberId = payload.creatorMemberId ?? room.creatorMemberId
          room.creatorDeviceId = payload.creatorDeviceId ?? room.creatorDeviceId
          room.coordinatorDeviceId = payload.coordinatorDeviceId ?? room.coordinatorDeviceId
          room.hostSessionId = payload.hostSessionId ?? room.hostSessionId
          room.mirror = payload.mirror ?? room.mirror
          for (const member of Array.isArray(payload.members) ? payload.members : []) room.members.set(member.memberId, member)
          break
        }
        case 'member.joined':
        case 'member.updated': {
          if (payload.member?.memberId) room.members.set(payload.member.memberId, { ...(room.members.get(payload.member.memberId) ?? {}), ...payload.member })
          break
        }
        case 'member.left':
        case 'member.removed': {
          if (payload.memberId) room.members.delete(payload.memberId)
          break
        }
        case 'message': {
          if (payload.message && !messageIds.has(payload.message.id)) {
            messageIds.add(payload.message.id)
            room.messages.push(payload.message)
          }
          break
        }
        case 'task.added':
        case 'task.updated': {
          if (payload.task?.id) {
            room.tasks.set(payload.task.id, mergeTaskState(room.tasks.get(payload.task.id), payload.task))
            if (payload.task.status === 'done' && this.onTaskEvent) {
              try {
                this.onTaskEvent({ type: 'done', task: payload.task })
              } catch {
                /* grant revocation is best effort */
              }
            }
          }
          break
        }
        case 'task.removed': {
          if (payload.taskId) room.tasks.delete(payload.taskId)
          break
        }
        case 'policy.updated': {
          if (payload.policy) room.policy = payload.policy
          break
        }
        case 'room.coordinator': {
          const remoteAt = Number(payload.updatedAt ?? event.createdAt ?? 0)
          if (remoteAt > Number(room.coordinatorUpdatedAt ?? 0)) {
            room.coordinatorDeviceId = payload.coordinatorDeviceId ?? room.coordinatorDeviceId
            room.coordinatorUpdatedAt = remoteAt
          }
          break
        }
        case 'room.authority': {
          const epoch = Number(payload.epoch ?? 0)
          const current = Number(room.authorityEpoch ?? 0)
          const deviceId = typeof payload.authorityDeviceId === 'string' ? payload.authorityDeviceId : null
          if (!deviceId) break
          if (epoch < current) break
          if (epoch === current && deviceId <= String(room.authorityDeviceId ?? '')) break
          room.authorityDeviceId = deviceId
          room.authorityRoomId = typeof payload.authorityRoomId === 'string' ? payload.authorityRoomId : room.authorityRoomId
          room.authorityEpoch = epoch
          break
        }
        case 'room.creator': {
          room.creatorMemberId = payload.creatorMemberId ?? room.creatorMemberId
          room.creatorDeviceId = payload.creatorDeviceId ?? room.creatorDeviceId
          room.coordinatorDeviceId = payload.coordinatorDeviceId ?? room.coordinatorDeviceId
          break
        }
        case 'room.closed': {
          room.closed = true
          break
        }
        case 'room.snapshot': {
          const snapshot = payload.snapshot ?? {}
          room.createdAt = snapshot.createdAt ?? room.createdAt
          room.title = snapshot.title ?? room.title
          room.creatorMemberId = snapshot.creatorMemberId ?? room.creatorMemberId
          room.creatorDeviceId = snapshot.creatorDeviceId ?? room.creatorDeviceId
          room.coordinatorDeviceId = snapshot.coordinatorDeviceId ?? room.coordinatorDeviceId
          room.hostSessionId = snapshot.hostSessionId ?? room.hostSessionId
          room.closed = snapshot.closed ?? room.closed
          if (Array.isArray(snapshot.members)) room.members = new Map(snapshot.members.map((member) => [member.memberId, member]))
          if (Array.isArray(snapshot.messages)) {
            room.messages = [...snapshot.messages]
            // Seed dedupe from the snapshot so events replayed after it cannot
            // append messages the snapshot already contains.
            messageIds.clear()
            for (const message of room.messages) if (message?.id) messageIds.add(message.id)
          }
          if (Array.isArray(snapshot.tasks)) room.tasks = new Map(snapshot.tasks.map((task) => [task.id, task]))
          if (snapshot.policy) room.policy = snapshot.policy
          if (snapshot.baseClock || payload.baseClock) room.baseClock = { ...(snapshot.baseClock ?? payload.baseClock) }
          break
        }
        default:
          break
      }
    }
    return {
      roomId,
      createdAt: room.createdAt,
      title: room.title,
      policy: room.policy,
      creatorMemberId: room.creatorMemberId,
      hostSessionId: room.hostSessionId,
      creatorMemberId: room.creatorMemberId,
      creatorDeviceId: room.creatorDeviceId,
      coordinatorDeviceId: room.coordinatorDeviceId,
      authorityDeviceId: room.authorityDeviceId ?? null,
      authorityRoomId: room.authorityRoomId ?? null,
      authorityEpoch: room.authorityEpoch ?? 0,
      mirror: room.mirror,
      closed: room.closed,
      members: [...room.members.values()].map(memberSummary),
      messages: room.messages.map((message) => {
        const member = message.from?.memberId ? room.members.get(message.from.memberId) : null
        return {
          ...message,
          fromLabel: message.from?.kind === 'user'
            ? '用户'
            : member ? memberDisplayName(member) : (message.from?.name ?? '成员'),
        }
      }),
      tasks: [...room.tasks.values()],
      lastSeq: room.lastSeq,
    }
  }

  /** Persist a compacted snapshot (event history is retained). */
  snapshot(roomId) {
    const state = this.state(roomId)
    mkdirSync(this.roomDir(roomId), { recursive: true })
    writeJsonAtomic(this.snapshotPath(roomId), {
      version: REPLICA_VERSION,
      roomId,
      savedAt: this.now(),
      lastSeq: state.lastSeq,
      state,
    })
    const previous = this.index.rooms[roomId] ?? { roomId }
    this.index.rooms[roomId] = { ...previous, roomId, snapshotSeq: state.lastSeq, updatedAt: this.now() }
    this.saveIndex()
    return state
  }

  /** Repair an authority replica that imported a foreign bootstrap snapshot. */
  repairForeignBootstrapSnapshots(rooms) {
    if (!rooms?.rooms || typeof rooms.rooms.values !== 'function') return 0
    let repaired = 0
    for (const room of rooms.rooms.values()) {
      if (room.mirror) continue
      const events = this.loadEvents(room.roomId)
      const lastSnapshot = [...events].reverse().find((event) => event.type === 'room.snapshot')
      if (!lastSnapshot || lastSnapshot.author?.source !== 'legacy-bootstrap') continue
      if (lastSnapshot.origin === this.deviceId) continue
      try {
        const detail = rooms.detail(room.roomId, { limit: 1000 })
        this.append({
          roomId: room.roomId,
          type: 'room.snapshot',
          author: { kind: 'system', source: 'authority-repair' },
          payload: { snapshot: detail },
          localOnly: true,
        })
        repaired += 1
      } catch (error) {
        this.warn(`[device-fleet] cannot repair Room replica ${room.roomId}: ${String(error?.message ?? error)}`)
      }
    }
    return repaired
  }

  /**
   * One-time idempotent import from the legacy RoomService rooms.json state.
   * @param {{rooms: Map<string, object>}} rooms RoomService instance
   */
  migrateFromRooms(rooms) {
    if (!rooms?.rooms || typeof rooms.rooms.values !== 'function') return 0
    let migrated = 0
    for (const room of rooms.rooms.values()) {
      const existing = this.index.rooms[room.roomId]
      if (existing?.migratedAt || this.loadEvents(room.roomId).length > 0) continue
      try {
        this.append({
          roomId: room.roomId,
          type: 'room.created',
          author: { kind: 'system', source: 'legacy-import' },
          createdAt: room.createdAt,
          payload: {
            title: roomTitle(room.roomId),
            policy: room.policy,
            hostSessionId: room.hostSessionId,
            creatorMemberId: room.hostSessionId ? `host:${room.hostSessionId}` : null,
            mirror: room.mirror ?? null,
            members: [...room.members.values()].map(memberSummary),
          },
        })
        for (const member of room.members.values()) {
          this.append({ roomId: room.roomId, type: 'member.joined', author: { kind: 'system', source: 'legacy-import' }, payload: { member: memberSummary(member) } })
        }
        for (const message of room.messages ?? []) {
          this.append({ roomId: room.roomId, type: 'message', author: { kind: 'system', source: 'legacy-import' }, payload: { message } })
        }
        for (const task of room.tasks?.values?.() ?? []) {
          this.append({ roomId: room.roomId, type: 'task.added', author: { kind: 'system', source: 'legacy-import' }, payload: { task } })
        }
        if (room.closed) this.append({ roomId: room.roomId, type: 'room.closed', author: { kind: 'system', source: 'legacy-import' }, payload: {} })
        this.index.rooms[room.roomId] = {
          ...(this.index.rooms[room.roomId] ?? { roomId: room.roomId }),
          roomId: room.roomId,
          title: roomTitle(room.roomId),
          hostSessionId: room.hostSessionId ?? null,
          mirror: room.mirror ?? null,
          members: [...room.members.values()].map(memberSummary),
          migratedAt: this.now(),
          origin: 'legacy-import',
        }
        this.saveIndex()
        this.snapshot(room.roomId)
        migrated += 1
      } catch (error) {
        this.warn(`[device-fleet] cannot migrate room ${String(room.roomId)}: ${String(error?.message ?? error)}`)
      }
    }
    return migrated
  }
}
