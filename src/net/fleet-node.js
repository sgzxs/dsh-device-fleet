// FleetNode: one device's networking facade.
//
// It owns the identity, the fleet roster, a direct listener, optional LAN
// discovery, an optional relay client, and the RPC layer that runs over
// authenticated SecureChannels.
import { EventEmitter } from 'node:events'
import { randomUUID, sign, verify } from 'node:crypto'
import { createDirectServer, connectDirect } from './direct.js'
import { LanDiscovery } from './discovery.js'
import { RelayClient } from './relay-client.js'
import { SecureChannel } from './secure-channel.js'
import { importPrivateKey, importPublicKey } from './identity.js'
import { stableStringify } from './protocol.js'
import {
  ROTATION_MAX_RECORDS,
  applyRevocation,
  applyRotationChain,
  resolveRotationFork as resolveChainFork,
  rotationRecordHash,
  verifyRotationCheckpoint,
  refreshRotationCheckpoint,
} from './rotation.js'
import {
  FRAME,
  PROTOCOL_VERSION,
  eventFrame,
  rpcError,
  rpcRequest,
  rpcResult,
  serializeError,
} from './protocol.js'

const DEFAULT_CONNECT_TIMEOUT_MS = 12_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_RELAY_CANDIDATE_TTL_MS = 7 * 24 * 60 * 60 * 1000

function normalizeRelayConfigs(relay, relays) {
  const list = []
  const seen = new Set()
  for (const candidate of [...(Array.isArray(relays) ? relays : []), ...(relay ? [relay] : [])]) {
    if (!candidate || typeof candidate.host !== 'string' || candidate.host === '') continue
    const port = Number(candidate.port) || 0
    const dataPort = Number(candidate.dataPort) || 0
    if (!port || !dataPort) continue
    const key = `${candidate.host}:${port}:${dataPort}`
    if (!seen.has(key)) {
      seen.add(key)
      list.push({ ...candidate, host: candidate.host, port, dataPort, ...(candidate.tls && typeof candidate.tls === 'object' ? { tls: candidate.tls } : {}) })
    }
  }
  return list
}

export class FleetNode extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.identity device identity (generateIdentity)
   * @param {{fleetId: string, fleetKey: string, name?: string}} options.fleet
   * @param {string} [options.name]
   * @param {string|null} [options.accountFingerprint]
   * @param {{host?: string, port?: number}|false} [options.direct] direct listener (false disables)
   * @param {false|{group?: string, port?: number, intervalMs?: number}} [options.discovery]
   * @param {null|{host: string, port: number, dataPort: number, reconnect?: object}} [options.relay]
   * @param {Array<{deviceId: string, edPublic: string, xPublic: string, name?: string}>} [options.roster]
   * @param {boolean} [options.trustOnFirstUse]
   * @param {boolean} [options.acceptRelayConnections]
   */
  constructor({
    identity,
    fleet,
    name = identity?.name ?? 'device',
    accountFingerprint = null,
    onPeerAccountFingerprint = null,
    rotationChain = [],
    onPeerRotations = null,
    peerRotations = null,
    inviteId = null,
    onPeerInvite = null,
    rotationCheckpoint = null,
    direct = { host: '127.0.0.1', port: 0 },
    discovery = false,
    relay = null,
    relays = null,
    roster = [],
    peerHints = [],
    trustOnFirstUse = true,
    acceptRelayConnections = true,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    pluginVersion = '0.1.0',
    dshVersion = 'unknown',
    capabilities = [],
    relayCandidateTtlMs = DEFAULT_RELAY_CANDIDATE_TTL_MS,
  } = {}) {
    super()
    if (!identity?.deviceId || !identity.edPrivate || !identity.edPublic) throw new Error('FleetNode needs an identity')
    if (!fleet?.fleetId || !fleet?.fleetKey) throw new Error('FleetNode needs a fleet')
    this.identity = identity
    this.fleet = fleet
    this.name = name
    this.accountFingerprint = accountFingerprint
    this.onPeerAccountFingerprint = onPeerAccountFingerprint
    this.rotationChain = Array.isArray(rotationChain) ? rotationChain : []
    this.onPeerRotations = onPeerRotations
    this.inviteId = typeof inviteId === 'string' && inviteId !== '' ? inviteId : null
    this.onPeerInvite = typeof onPeerInvite === 'function' ? onPeerInvite : null
    this.rotationCheckpoint = rotationCheckpoint && typeof rotationCheckpoint === 'object' ? rotationCheckpoint : null
    this.checkpointTrusts = new Map()
    if (this.rotationCheckpoint) {
      try {
        // The persisted checkpoint may have been signed before later rotations;
        // advertise a copy signed by the current key so peers can verify it.
        this.rotationCheckpoint = refreshRotationCheckpoint(this.identity, this.rotationCheckpoint)
      } catch {
        /* keep the stored checkpoint; it is still shown in rotation status */
      }
    }
    this.peerRotations = new Map(
      Object.entries(peerRotations && typeof peerRotations === 'object' ? peerRotations : {})
        .filter(([deviceId, chain]) => typeof deviceId === 'string' && chain && Array.isArray(chain.records)),
    )
    this.directConfig = direct
    this.discoveryConfig = discovery
    this.relayConfigs = normalizeRelayConfigs(relay, relays)
    this.relayConfig = this.relayConfigs[0] ?? null
    this.relayCandidateTtlMs = Number(relayCandidateTtlMs) > 0 ? Number(relayCandidateTtlMs) : DEFAULT_RELAY_CANDIDATE_TTL_MS
    this.relayCandidates = new Map()
    for (const config of this.relayConfigs) {
      this.relayCandidates.set(`${config.host}:${config.port}:${config.dataPort}`, {
        ...config,
        source: 'config',
        persistent: true,
        learnedAt: 0,
      })
    }
    this.relayPruneTimer = null
    this.relayProbeTimer = null
    this.trustOnFirstUse = trustOnFirstUse
    this.acceptRelayConnections = acceptRelayConnections
    this.connectTimeoutMs = connectTimeoutMs
    this.requestTimeoutMs = requestTimeoutMs
    this.pluginVersion = pluginVersion
    this.dshVersion = dshVersion
    this.capabilities = capabilities

    this.roster = new Map()
    for (const entry of roster) this.roster.set(entry.deviceId, { name: 'device', ...entry })
    this.discovered = new Map()
    this.peerHints = []
    for (const hint of peerHints) this.addPeerHint(hint)
    this.hintTimer = null
    this.hintAttempt = 0
    this.channels = new Map()
    this.pendingRpc = new Map()
    this.requestHandler = null
    this.eventHandler = null

    this.directServer = null
    this.pendingSockets = new Set()
    this.maxPendingSockets = 256
    this.discovery = null
    this.relayClient = null
    this.relayClients = []
    this.started = false
    this.closed = false
  }

  get directPort() {
    return this.directAddress?.port ?? null
  }

  rosterEntries() {
    return [...this.roster.values()]
  }

  upsertRoster(entry) {
    const existing = this.roster.get(entry.deviceId)
    this.roster.set(entry.deviceId, { ...existing, name: 'device', ...entry })
    this.emit('roster', this.rosterEntries())
  }

  exportPeerRotations() {
    const out = {}
    for (const [deviceId, chain] of this.peerRotations) {
      if (!chain || !Array.isArray(chain.records)) continue
      out[deviceId] = {
        genesisEdPublic: chain.genesisEdPublic,
        genesisXPublic: chain.genesisXPublic,
        records: chain.records,
      }
    }
    return out
  }

  _recordRotationFork(deviceId, fork, source, records = []) {
    const entry = this.roster.get(deviceId)
    if (!entry) return null
    const captured = (Array.isArray(records) ? records : [])
      .filter((record) => record && Number(record.seq) >= Number(fork.seq ?? 0))
      .slice(0, ROTATION_MAX_RECORDS)
    const marked = {
      ...entry,
      rotationFork: {
        seq: Number(fork.seq ?? -1),
        localHead: fork.localHead ?? null,
        localHash: fork.localHash ?? null,
        remoteHead: fork.remoteHead ?? null,
        remoteHash: fork.remoteHash ?? null,
        detectedAt: Date.now(),
        source,
        records: captured,
      },
    }
    this.roster.set(deviceId, marked)
    this.emit('roster', this.rosterEntries())
    this.emit('rotation-fork', { deviceId, fork: marked.rotationFork })
    this.emit('warning', Object.assign(
      new Error(`rotation fork detected for ${deviceId} at seq ${String(fork.seq)}; updates are blocked until resolved`),
      { code: 'rotation-fork' },
    ))
    return marked
  }

  /**
   * Verify and apply rotation records for a peer from the handshake (or the
   * rotation RPC). Returns a status object consumed by SecureChannel:
   * `{ status: ok|unpinned|gap|fork|invalid|revoked|key-changed, entry?, need? }`.
   */
  async applyPeerRotations(peer, records) {
    const deviceId = peer?.deviceId
    if (typeof deviceId !== 'string' || deviceId === '') return { status: 'invalid', reason: 'missing peer device id' }
    const entry = this.roster.get(deviceId)
    if (!entry) return { status: 'unpinned' }
    if (entry.revokedAt) return { status: 'revoked', reason: 'this device was revoked by the local user' }
    const result = applyRotationChain({
      rosterEntry: entry,
      storedChain: this.peerRotations.get(deviceId) ?? null,
      records: Array.isArray(records) ? records : [],
    })
    if (result.status === 'fork') {
      this._recordRotationFork(deviceId, result.fork, 'handshake', records)
      return { status: 'fork', fork: result.fork }
    }
    if (result.status === 'invalid') return result
    if (result.status === 'revoked') return { status: 'revoked', reason: 'this device was revoked by the local user' }
    if (result.status === 'applied') {
      this.roster.set(deviceId, result.entry)
      this.peerRotations.set(deviceId, result.chain)
      this.emit('roster', this.rosterEntries())
      this.emit('peer-rotations', this.exportPeerRotations())
      if (result.warning) this.emit('warning', Object.assign(new Error(result.warning), { code: 'rotation-history' }))
    }
    const current = this.roster.get(deviceId)
    if (current.edPublic === peer.edPublic && current.xPublic === peer.xPublic) {
      // Same keys but a different advertised chain head means the peer's chain
      // diverged and re-converged; keep the verified local branch and surface it.
      if (
        typeof peer.rotationSeq === 'number' &&
        Number(peer.rotationSeq) === Number(current.rotationSeq ?? -1) &&
        typeof peer.rotationHead === 'string' &&
        typeof current.rotationHead === 'string' &&
        peer.rotationHead !== current.rotationHead
      ) {
        const fork = {
          seq: Number(current.rotationSeq ?? -1),
          localSeq: Number(current.rotationSeq ?? -1),
          localHead: current.rotationHead,
          localHash: current.rotationHead,
          remoteHead: peer.rotationHead,
          remoteHash: peer.rotationHead,
        }
        this._recordRotationFork(deviceId, fork, 'handshake-head', records)
        return { status: 'fork', fork }
      }
      return { status: 'ok', entry: current }
    }
    if (typeof peer.rotationSeq !== 'number') {
      return { status: 'key-changed', reason: 'the peer key is not the pinned key and no rotation chain was advertised' }
    }
    if (Number(peer.rotationSeq) <= Number(current.rotationSeq ?? -1)) {
      const fork = {
        seq: Number(current.rotationSeq ?? -1),
        localSeq: Number(current.rotationSeq ?? -1),
        localHead: current.rotationHead ?? null,
        localHash: current.rotationHead ?? null,
        remoteHead: peer.rotationHead ?? null,
        remoteHash: peer.rotationHead ?? null,
      }
      this._recordRotationFork(deviceId, fork, 'handshake-head', records)
      return { status: 'fork', fork }
    }
    return { status: 'gap', need: { fromSeq: Number(current.rotationSeq ?? -1) + 1 }, entry: current }
  }

  /** Apply an old-key-signed device key rotation pushed by a connected peer. */
  applyRotation(record) {
    if (!record || typeof record.deviceId !== 'string') return false
    const entry = this.roster.get(record.deviceId)
    if (!entry || entry.revokedAt) return false
    const result = applyRotationChain({
      rosterEntry: entry,
      storedChain: this.peerRotations.get(record.deviceId) ?? null,
      records: [record],
    })
    if (result.status !== 'applied') return false
    this.roster.set(record.deviceId, result.entry)
    this.peerRotations.set(record.deviceId, result.chain)
    this.emit('roster', this.rosterEntries())
    this.emit('peer-rotations', this.exportPeerRotations())
    return true
  }

  /** Resolve a recorded rotation fork (explicit local user decision). */
  resolveFork(deviceId, action = 'keep-local') {
    const entry = this.roster.get(deviceId)
    if (!entry) return { status: 'unknown' }
    if (!entry.rotationFork) return { status: 'noop' }
    const result = resolveChainFork({
      rosterEntry: entry,
      storedChain: this.peerRotations.get(deviceId) ?? null,
      records: entry.rotationFork.records ?? [],
      action,
    })
    if (result.status === 'kept' || result.status === 'adopted') {
      this.roster.set(deviceId, result.entry)
      if (result.chain) this.peerRotations.set(deviceId, result.chain)
      this.emit('roster', this.rosterEntries())
      this.emit('peer-rotations', this.exportPeerRotations())
    }
    return result
  }

  /** Re-sign and install the checkpoint advertised in future handshakes. */
  setRotationCheckpoint(checkpoint) {
    if (!checkpoint || typeof checkpoint !== 'object') {
      this.rotationCheckpoint = null
      return null
    }
    this.rotationCheckpoint = refreshRotationCheckpoint(this.identity, checkpoint)
    return this.rotationCheckpoint
  }

  /** Record a peer's cryptographically signed checkpoint confirmation. */
  noteCheckpointTrust({ trustedBy, deviceId, seq, head, at, signature } = {}) {
    if (typeof trustedBy !== 'string' || typeof deviceId !== 'string' || !Number.isInteger(Number(seq))) return false
    if (trustedBy === deviceId) return false
    if (typeof head !== 'string' || head === '') return false
    if (typeof signature !== 'string' || signature === '') return false
    const entry = this.roster.get(trustedBy)
    if (!entry?.edPublic) return false
    if (entry.revoked || entry.revocationPending) return false
    const payload = {
      type: 'checkpoint-trust',
      trustedBy,
      deviceId,
      seq: Number(seq),
      head: typeof head === 'string' ? head : null,
      at: Number(at) || 0,
    }
    let valid = false
    try {
      valid = verify(
        null,
        Buffer.from(stableStringify(payload), 'utf8'),
        importPublicKey(entry.edPublic),
        Buffer.from(signature, 'base64url'),
      )
    } catch {
      valid = false
    }
    if (!valid) return false
    const key = `${deviceId}:${Number(seq)}:${head}`
    const set = this.checkpointTrusts.get(key) ?? new Map()
    set.set(trustedBy, { ...payload, signature })
    this.checkpointTrusts.set(key, set)
    // A peer can legitimately advertise many heads; cap the advisory map so a
    // malicious member cannot grow it without bound.
    while (this.checkpointTrusts.size > 2_000) {
      this.checkpointTrusts.delete(this.checkpointTrusts.keys().next().value)
    }
    this.emit('checkpoint-trust', payload)
    return true
  }

  checkpointEndorsements(deviceId, seq, head = null) {
    if (typeof head === 'string' && head !== '') {
      return this.checkpointTrusts.get(`${deviceId}:${Number(seq)}:${head}`)?.size ?? 0
    }
    let total = 0
    for (const [key, set] of this.checkpointTrusts) {
      if (key.startsWith(`${deviceId}:${Number(seq)}:`)) total += set.size
    }
    return total
  }

  /** Build a verifiable M-of-N certificate for one exact checkpoint head. */
  checkpointCertificate(deviceId, seq, head, threshold = 1) {
    const signatures = [...(this.checkpointTrusts.get(`${deviceId}:${Number(seq)}:${head}`)?.values() ?? [])]
      .filter((endorsement) => {
        if (endorsement.trustedBy === deviceId) return false
        const peer = this.roster.get(endorsement.trustedBy)
        return peer && !peer.revoked && !peer.revocationPending
      })
      .map((endorsement) => ({
        trustedBy: endorsement.trustedBy,
        at: endorsement.at,
        signature: endorsement.signature,
      }))
    return {
      deviceId,
      seq: Number(seq),
      head,
      threshold: Math.max(1, Number(threshold) || 1),
      localConfirmation: true,
      signatures,
      count: signatures.length + 1,
    }
  }

  checkpointOfferFor(deviceId) {
    return this.roster.get(deviceId)?.rotationCheckpointOffer ?? null
  }

  /** Tell connected peers that this device confirmed a checkpoint (signed). */
  async broadcastCheckpointTrust({ deviceId, seq, head } = {}) {
    if (typeof deviceId !== 'string' || deviceId === '') return []
    const payload = {
      type: 'checkpoint-trust',
      trustedBy: this.identity?.deviceId,
      deviceId,
      seq: Number(seq) || null,
      head: typeof head === 'string' ? head : null,
      at: Date.now(),
    }
    if (!payload.trustedBy || !this.identity?.edPrivate) return []
    payload.signature = sign(
      null,
      Buffer.from(stableStringify(payload), 'utf8'),
      importPrivateKey(this.identity.edPrivate),
    ).toString('base64url')
    const delivered = []
    for (const peerId of this.peerIds()) {
      try {
        await this.request(peerId, 'fleet.rotation.checkpoint_trusted', payload, { timeoutMs: 3_000 })
        delivered.push(peerId)
      } catch {
        /* advisory only; a peer may be offline or older */
      }
    }
    return delivered
  }

  /**
   * Remember a peer's signed checkpoint when it cannot supply the records we
   * need (its history was pruned). This is only an offer: the keys are not
   * trusted until the local user confirms with `trustRotationCheckpoint`.
   */
  recordRotationCheckpointOffer(peer, checkpoint) {
    const entry = this.roster.get(peer?.deviceId)
    if (!entry || !checkpoint) return false
    if (checkpoint.deviceId !== peer.deviceId) return false
    if (!verifyRotationCheckpoint(checkpoint, peer.edPublic)) return false
    if (Number(checkpoint.seq) < Number(entry.rotationSeq ?? -1)) return false
    this.roster.set(peer.deviceId, {
      ...entry,
      rotationCheckpointOffer: {
        checkpoint,
        edPublic: peer.edPublic,
        xPublic: peer.xPublic,
        rotationSeq: Number.isInteger(Number(peer.rotationSeq)) ? Number(peer.rotationSeq) : null,
        rotationHead: typeof peer.rotationHead === 'string' ? peer.rotationHead : null,
        receivedAt: Date.now(),
      },
    })
    this.emit('roster', this.rosterEntries())
    this.emit('rotation-checkpoint-offer', { deviceId: peer.deviceId, seq: Number(checkpoint.seq) })
    return true
  }

  /** User-confirmed trust of a peer's checkpoint (a manual trust decision). */
  trustRotationCheckpoint(deviceId, { threshold = 1 } = {}) {
    const entry = this.roster.get(deviceId)
    if (!entry) return { status: 'unknown' }
    if (entry.revoked || entry.revocationPending) return { status: 'invalid', reason: 'device is revoked' }
    const offer = entry.rotationCheckpointOffer
    if (!offer?.checkpoint) return { status: 'no-offer' }
    const checkpoint = offer.checkpoint
    if (checkpoint.deviceId !== deviceId) {
      return { status: 'invalid', reason: 'checkpoint deviceId does not match the roster entry' }
    }
    if (Number(checkpoint.seq) < Number(entry.rotationSeq ?? -1)) {
      return { status: 'invalid', reason: 'checkpoint would roll back the pinned rotation sequence' }
    }
    if (!verifyRotationCheckpoint(checkpoint, offer.edPublic)) {
      return { status: 'invalid', reason: 'checkpoint signature is not valid for the offered key' }
    }
    if (checkpoint.edPublic !== offer.edPublic) {
      return { status: 'invalid', reason: 'checkpoint does not commit to the offered key' }
    }
    const certificate = this.checkpointCertificate(deviceId, checkpoint.seq, checkpoint.head, threshold)
    if (certificate.count < certificate.threshold) {
      return { status: 'quorum', reason: `checkpoint needs ${certificate.threshold} confirmations, has ${certificate.count}`, certificate }
    }
    // Newer checkpoints commit to the key at the archived prefix, so the records
    // above it stay verifiable. Legacy checkpoints (created before 1.12.3) only
    // carry the signer's key; after explicit confirmation, pin the peer's
    // CURRENT advertised head instead (no record replay) so trust still works.
    const hasHeadKeys = typeof checkpoint.headEdPublic === 'string' && checkpoint.headEdPublic !== ''
      && typeof checkpoint.headXPublic === 'string' && checkpoint.headXPublic !== ''
    const pinnedSeq = hasHeadKeys
      ? Number(checkpoint.seq)
      : (Number.isInteger(offer.rotationSeq) ? Number(offer.rotationSeq) : Number(checkpoint.seq))
    const pinnedHead = hasHeadKeys ? checkpoint.head : (offer.rotationHead ?? checkpoint.head)
    const updated = {
      ...entry,
      edPublic: hasHeadKeys ? checkpoint.headEdPublic : offer.edPublic,
      xPublic: hasHeadKeys ? checkpoint.headXPublic : offer.xPublic,
      rotationSeq: pinnedSeq,
      rotationHead: pinnedHead,
      checkpointTrustedAt: Date.now(),
      checkpointCertificate: certificate,
    }
    delete updated.rotationCheckpointOffer
    delete updated.rotationFork
    this.roster.set(deviceId, updated)
    // Drop the old chain: it no longer reaches the trusted head.
    this.peerRotations.delete(deviceId)
    this.emit('roster', this.rosterEntries())
    this.emit('peer-rotations', this.exportPeerRotations())
    return { status: 'trusted', entry: updated, certificate }
  }

  /**
   * Apply a revocation record. Self-revocations are absolute; third-party
   * assertions stay advisory (`revocationPending`) until the local user
   * confirms them. `confirmed` is the local user's decision.
   */
  applyRevocation(record, { confirmed = false, source = 'peer' } = {}) {
    if (!record || typeof record.deviceId !== 'string') return { status: 'invalid', reason: 'malformed revocation record' }
    const target = this.roster.get(record.deviceId)
    if (!target) return { status: 'unknown-device' }
    const self = record.revokedBy === record.deviceId
    const revoker = self
      ? target
      : record.revokedBy === this.identity.deviceId
        ? { edPublic: this.identity.edPublic }
        : this.roster.get(record.revokedBy)
    if (!revoker) return { status: 'unknown-revoker' }
    const updated = applyRevocation(target, record, {
      revokerEdPublic: revoker.edPublic,
      confirmed: confirmed === true,
    })
    if (!updated) return { status: 'invalid', reason: 'revocation signature is not valid for the asserting device' }
    // Keep the signed record on the tombstone so it can be re-advertised to
    // devices that were offline when the revocation was made.
    const stored = updated.revokedAt ? { ...updated, revocationRecord: record } : updated
    this.roster.set(record.deviceId, stored)
    this.emit('roster', this.rosterEntries())
    if (stored.revokedAt) {
      this.channels.get(record.deviceId)?.close()
      this.emit('device-revoked', { deviceId: record.deviceId, record, source, revokedAt: stored.revokedAt })
      return { status: 'revoked', entry: stored }
    }
    this.emit('revocation-pending', { deviceId: record.deviceId, record, source })
    return { status: 'pending', entry: stored }
  }

  /** Clear an unconfirmed third-party revocation advisory (local choice). */
  dismissRevocation(deviceId) {
    const entry = this.roster.get(deviceId)
    if (!entry || !entry.revocationPending) return { status: 'noop' }
    const updated = { ...entry }
    delete updated.revocationPending
    this.roster.set(deviceId, updated)
    this.emit('roster', this.rosterEntries())
    return { status: 'dismissed', entry: updated }
  }

  onRequest(handler) {
    this.requestHandler = handler
  }

  onEvent(handler) {
    this.eventHandler = handler
  }

  async start() {
    if (this.started) return this
    this.started = true

    if (this.directConfig !== false) {
      this.directServer = createDirectServer({
        host: this.directConfig.host ?? '0.0.0.0',
        port: this.directConfig.port ?? 0,
      })
      try {
        this.directAddress = await this.directServer.ready
      } catch (error) {
        // A failed rebind must not leave `started=true`, otherwise a rollback
        // reconfigure would silently return without retrying.
        this.started = false
        this.directServer = null
        this.directAddress = null
        throw error
      }
      this.directServer.server.maxConnections = 256
      this.directServer.server.on('connection', (socket) => this.acceptInbound(socket, 'direct'))
    }

    if (this.discoveryConfig !== false && this.discoveryConfig !== undefined) {
      if (!this.directAddress) throw new Error('discovery needs the direct listener')
      const config = this.discoveryConfig === true ? {} : this.discoveryConfig
      this.discovery = new LanDiscovery({
        fleetId: this.fleet.fleetId,
        deviceId: this.identity.deviceId,
        name: this.name,
        directPort: this.directAddress.port,
        group: config.group,
        port: config.port,
        intervalMs: config.intervalMs,
      })
      this.discovery.on('peer', (peer) => {
        this.discovered.set(peer.deviceId, peer)
        this.emit('discovered', peer)
      })
      this.discovery.on('error', (error) => this.emit('warning', error))
      this.discovery.start()
    }

    for (const relayConfig of this.relayConfigs) {
      const client = new RelayClient({
        host: relayConfig.host,
        port: relayConfig.port,
        dataPort: relayConfig.dataPort,
        fleetId: this.fleet.fleetId,
        deviceId: this.identity.deviceId,
        fleetKey: this.fleet.fleetKey,
        reconnect: relayConfig.reconnect,
        tls: relayConfig.tls ?? null,
      })
      this.relayClients.push(client)
      if (!this.relayClient) this.relayClient = client
      client.on('online', () => this.emit('relay-online', { host: relayConfig.host }))
      client.on('offline', () => this.emit('relay-offline', { host: relayConfig.host }))
      client.on('relay-error', (error) => this.emit('warning', error))
      client.on('incoming', (controller) => this.acceptIncomingRelay(controller))
      try {
        await client.start(5_000)
      } catch (error) {
        this.emit('warning', error)
      }
    }

    // Learned (peer-advertised) relay candidates expire; configured ones do not.
    const pruneEvery = Math.max(60_000, Math.min(this.relayCandidateTtlMs, 3_600_000))
    this.relayPruneTimer = setInterval(() => this.pruneRelayCandidates(), pruneEvery)
    this.relayPruneTimer.unref?.()
    this.relayProbeTimer = setInterval(() => this.probeRelays(), 60_000)
    this.relayProbeTimer.unref?.()

    this.emit('started', { direct: this.directAddress ?? null })
    this.scheduleHintConnects()
    return this
  }

  /** Remember an address hint for a peer (from an invite or a manual `fleet_connect`). */
  addPeerHint(hint) {
    if (!hint || typeof hint.host !== 'string' || !Number.isInteger(hint.port) || hint.port <= 0) return
    const entry = {
      deviceId: typeof hint.deviceId === 'string' ? hint.deviceId : undefined,
      host: hint.host,
      port: hint.port,
    }
    if (entry.deviceId === this.identity.deviceId) return
    const exists = this.peerHints.some(
      (item) => item.host === entry.host && item.port === entry.port && item.deviceId === entry.deviceId,
    )
    if (!exists) this.peerHints.push(entry)
  }

  /** Connect to a raw address; learns the peer id from the handshake. */
  async connectAddress(host, port, { expectedDeviceId = null, timeoutMs = this.connectTimeoutMs } = {}) {
    if (!host || !Number.isInteger(port) || port <= 0) throw new Error('connectAddress needs host and port')
    const expected = expectedDeviceId ? { deviceId: expectedDeviceId } : null
    const socket = await connectDirect({ host, port, timeoutMs })
    const channel = this.createInitiator(socket, expected)
    await this.waitReady(channel, timeoutMs)
    return channel.peer
  }

  /** Retry the invite/manual hints in the background until one peer connects. */
  scheduleHintConnects() {
    if (this.hintTimer || this.closed) return
    const attempt = async () => {
      this.hintTimer = null
      if (this.closed) return
      if (this.peerHints.length === 0 || this.channels.size > 0) return
      try {
        for (const hint of this.peerHints) {
          if (this.closed || this.channels.size > 0) return
          try {
            const peer = await this.connectAddress(hint.host, hint.port, { expectedDeviceId: hint.deviceId })
            this.emit('hint-connected', { hint, peer })
            return
          } catch {
            // try the next hint; the timer below retries
          }
        }
      } finally {
        if (!this.closed && this.channels.size === 0) {
          this.hintAttempt += 1
          const delay = Math.min(10_000, 1000 * 2 ** Math.min(this.hintAttempt, 4))
          this.hintTimer = setTimeout(() => void attempt(), delay)
          this.hintTimer.unref?.()
        }
      }
    }
    this.hintTimer = setTimeout(() => void attempt(), 1500)
    this.hintTimer.unref?.()
  }

  /** Reconnect every Relay client, re-reading TLS cert/key files (rotation). */
  async reconnectRelays(timeoutMs = 5_000) {
    const results = []
    for (const client of this.relayClients) {
      try {
        await client.reconnect(timeoutMs)
        results.push({ host: client.host, port: client.port, online: true })
      } catch (error) {
        results.push({ host: client.host, port: client.port, online: false, error: String(error?.message ?? error) })
      }
    }
    return results
  }

  /** Relay endpoints this node can advertise to peers/invites. */
  relayCandidateList() {
    return this.sortedRelayCandidates().slice(0, 8).map((candidate) => ({
      host: candidate.host,
      port: candidate.port,
      dataPort: candidate.dataPort,
      ...(candidate.tls
        ? {
            tls: {
              ...(typeof candidate.tls.ca === 'string' && candidate.tls.ca !== '' ? { ca: candidate.tls.ca } : {}),
              ...(typeof candidate.tls.servername === 'string' && candidate.tls.servername !== '' ? { servername: candidate.tls.servername } : {}),
              ...(candidate.tls.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
            },
          }
        : {}),
    }))
  }

  /** Probe online relays for control-plane latency (also refreshes health). */
  probeRelays() {
    let probed = 0
    for (const client of this.relayClients) {
      if (client.online === true && typeof client.probe === 'function') {
        if (client.probe()) probed += 1
      }
    }
    return probed
  }

  /** Candidates ordered for display/connect: configured and online first. */
  sortedRelayCandidates() {
    return [...this.relayCandidates.values()]
      .map((candidate) => {
        const client = this.relayClients.find(
          (entry) => entry.host === candidate.host && entry.port === candidate.port && entry.dataPort === candidate.dataPort,
        )
        return {
          ...candidate,
          online: client?.online === true,
          failures: Number(client?.failures ?? 0),
          lastError: client?.lastError ?? null,
          latencyMs: client?.latencyMs !== null && client?.latencyMs !== undefined && Number.isFinite(Number(client.latencyMs)) ? Number(client.latencyMs) : null,
          ageMs: candidate.learnedAt ? Math.max(0, Date.now() - Number(candidate.learnedAt)) : 0,
        }
      })
      .sort((left, right) => {
        if (left.online !== right.online) return left.online ? -1 : 1
        if (left.persistent !== right.persistent) return left.persistent ? -1 : 1
        const leftLatency = left.latencyMs === null ? Number.POSITIVE_INFINITY : left.latencyMs
        const rightLatency = right.latencyMs === null ? Number.POSITIVE_INFINITY : right.latencyMs
        if (leftLatency !== rightLatency) return leftLatency - rightLatency
        if (left.failures !== right.failures) return left.failures - right.failures
        return String(left.host).localeCompare(String(right.host))
      })
  }

  /**
   * Drop expired peer-learned candidates (never configured ones) and close their
   * clients. Returns the removed candidate keys.
   */
  pruneRelayCandidates(now = Date.now()) {
    const removed = []
    for (const [key, candidate] of this.relayCandidates) {
      if (candidate.persistent) continue
      const learnedAt = Number(candidate.learnedAt ?? 0)
      if (learnedAt > 0 && now - learnedAt <= this.relayCandidateTtlMs) continue
      this.relayCandidates.delete(key)
      removed.push(key)
      const index = this.relayClients.findIndex(
        (client) => client.host === candidate.host && client.port === candidate.port && client.dataPort === candidate.dataPort,
      )
      if (index >= 0) {
        const [client] = this.relayClients.splice(index, 1)
        client.close()
        if (this.relayClient === client) this.relayClient = this.relayClients[0] ?? null
      }
    }
    if (removed.length > 0) this.emit('relay-candidates', this.sortedRelayCandidates())
    return removed
  }

  /** Learn Relay candidates advertised by a peer and probe them asynchronously. */
  learnRelayCandidates(candidates, source = 'peer') {
    if (!Array.isArray(candidates) || candidates.length === 0) return 0
    let learned = 0
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.host !== 'string' || candidate.host === '') continue
      const port = Number(candidate.port) || 0
      const dataPort = Number(candidate.dataPort) || 0
      if (!port || !dataPort) continue
      const key = `${candidate.host}:${port}:${dataPort}`
      if (this.relayCandidates.has(key)) {
        const existing = this.relayCandidates.get(key)
        existing.learnedAt = Date.now()
        if (candidate.tls && !existing.tls) existing.tls = candidate.tls
        continue
      }
      if (this.relayCandidates.size >= 8) break
      // Peers may pin a relay CA/servername, but never disable certificate
      // verification on our behalf (only local config/invites may do that).
      const learnedTls = candidate.tls && typeof candidate.tls === 'object'
        ? {
            ...(typeof candidate.tls.ca === 'string' && candidate.tls.ca !== '' ? { ca: candidate.tls.ca } : {}),
            ...(typeof candidate.tls.servername === 'string' && candidate.tls.servername !== '' ? { servername: candidate.tls.servername } : {}),
          }
        : null
      const config = {
        host: candidate.host,
        port,
        dataPort,
        source,
        learnedAt: Date.now(),
        ...(learnedTls && Object.keys(learnedTls).length > 0 ? { tls: learnedTls } : {}),
      }
      this.relayCandidates.set(key, config)
      learned += 1
      void this.startLearnedRelayClient(config)
    }
    return learned
  }

  async startLearnedRelayClient(config) {
    if (this.closed) return
    if (this.relayClients.some((client) => client.host === config.host && client.port === config.port && client.dataPort === config.dataPort)) return
    const client = new RelayClient({
      host: config.host,
      port: config.port,
      dataPort: config.dataPort,
      fleetId: this.fleet.fleetId,
      deviceId: this.identity.deviceId,
      fleetKey: this.fleet.fleetKey,
      reconnect: true,
      tls: config.tls ?? null,
    })
    this.relayClients.push(client)
    client.on('online', () => this.emit('relay-online', { host: config.host }))
    client.on('offline', () => this.emit('relay-offline', { host: config.host }))
    client.on('relay-error', (error) => this.emit('warning', error))
    client.on('incoming', (controller) => this.acceptIncomingRelay(controller))
    try {
      await client.start(4_000)
    } catch (error) {
      this.emit('warning', error)
    }
  }

  status() {
    const onlineRelays = this.relayClients.filter((client) => client.online === true)
    return {
      deviceId: this.identity.deviceId,
      name: this.name,
      pluginVersion: this.pluginVersion,
      dshVersion: this.dshVersion,
      direct: this.directAddress ? { host: this.directAddress.host, port: this.directAddress.port } : null,
      relay: this.relayCandidates.size > 0
        ? {
            online: onlineRelays.length > 0,
            onlineCount: onlineRelays.length,
            endpoints: this.relayClients.length,
            candidates: this.relayCandidates.size,
            list: this.sortedRelayCandidates().slice(0, 8).map((candidate) => ({
              host: candidate.host,
              port: candidate.port,
              dataPort: candidate.dataPort,
              source: candidate.source ?? 'peer',
              persistent: candidate.persistent === true,
              online: candidate.online === true,
              failures: candidate.failures ?? 0,
              latencyMs: candidate.latencyMs ?? null,
              ageMs: candidate.ageMs ?? 0,
              tls: candidate.tls ? { servername: candidate.tls.servername ?? null, hasCa: Boolean(candidate.tls.ca), hasCert: Boolean(candidate.tls.cert) } : null,
            })),
          }
        : null,
      discovery: this.discovery ? { enabled: true, peers: [...this.discovered.keys()] } : { enabled: false, peers: [] },
      account: {
        bound: typeof this.accountFingerprint === 'string' && this.accountFingerprint !== '' && this.accountFingerprint !== 'mismatch',
        mismatch: this.accountFingerprint === 'mismatch',
        fingerprint: typeof this.accountFingerprint === 'string' && this.accountFingerprint.length > 8
          ? this.accountFingerprint.slice(0, 8)
          : null,
      },
      rotation: (() => {
        const chain = Array.isArray(this.rotationChain) ? this.rotationChain : []
        const last = chain[chain.length - 1]
        return {
          seq: last ? Number(last.seq) : -1,
          head: last ? rotationRecordHash(last) : null,
          records: chain.length,
          from: chain[0] ? Number(chain[0].seq) : -1,
        }
      })(),
      roster: this.rosterEntries().map((entry) => ({
        deviceId: entry.deviceId,
        name: entry.name ?? 'device',
        revoked: Boolean(entry.revokedAt),
        revokedAt: entry.revokedAt ?? null,
        revokedBy: entry.revokedBy ?? null,
        revocationReason: entry.revocationReason ?? null,
        revocationPending: entry.revocationPending ?? null,
        rotationSeq: entry.rotationSeq ?? null,
        rotationHead: entry.rotationHead ?? null,
        rotationCheckpointOffer: entry.rotationCheckpointOffer
          ? {
              seq: entry.rotationCheckpointOffer.checkpoint?.seq ?? null,
              head: entry.rotationCheckpointOffer.checkpoint?.head ?? null,
              receivedAt: entry.rotationCheckpointOffer.receivedAt ?? null,
            }
          : null,
        rotationFork: entry.rotationFork
          ? {
              seq: entry.rotationFork.seq,
              localHead: entry.rotationFork.localHead ?? null,
              remoteHead: entry.rotationFork.remoteHead ?? null,
              detectedAt: entry.rotationFork.detectedAt ?? null,
              source: entry.rotationFork.source ?? null,
            }
          : null,
      })),
      connected: this.peerIds(),
      peerHints: [...this.peerHints],
    }
  }

  async acceptIncomingRelay(controller) {
    if (!this.acceptRelayConnections) {
      controller.reject()
      return
    }
    try {
      const socket = await controller.accept()
      this.acceptInbound(socket, 'relay')
    } catch (error) {
      this.emit('warning', error)
    }
  }

  acceptInbound(socket, via) {
    // A peer stuck in a reconnect storm can open thousands of half-handshaken
    // sockets. Track them, cap the in-flight set, and always destroy them on
    // close so a failed handshake cannot pin fds until the process exits.
    if (this.pendingSockets.size >= this.maxPendingSockets) {
      socket.destroy()
      return
    }
    this.pendingSockets.add(socket)
    socket.once('close', () => this.pendingSockets.delete(socket))
    const channel = new SecureChannel({
      socket,
      identity: this.identity,
      fleet: this.fleet,
      role: 'responder',
      accountFingerprint: this.accountFingerprint,
      onPeerAccountFingerprint: (peer) => this.bindPeerAccountFingerprint(peer),
      rotationChain: this.rotationChain,
      onPeerRotations: (peer, records) => this.applyPeerRotations(peer, records),
      inviteId: this.inviteId,
      rotationCheckpoint: this.rotationCheckpoint,
      onPeerCheckpoint: (peer, checkpoint) => this.recordRotationCheckpointOffer(peer, checkpoint),
      verifyPeer: (peer) => this.authorizePeer(peer),
      pluginVersion: this.pluginVersion,
      dshVersion: this.dshVersion,
      capabilities: this.capabilities,
      relayCandidates: this.relayCandidateList(),
    })
    this.attachChannel(channel, via)
  }

  attachChannel(channel, via) {
    channel.on('error', (error) => this.emit('warning', error))
    channel.on('ready', (peer) => {
      this.registerChannel(peer, channel, via)
    })
    channel.on('close', () => {
      const current = this.channels.get(channel.peer?.deviceId)
      if (current === channel) this.channels.delete(channel.peer.deviceId)
      this.rejectPendingForChannel(channel, Object.assign(new Error('peer connection closed'), { code: 'peer-offline' }))
      this.emit('peer-disconnected', { deviceId: channel.peer?.deviceId, via })
      // Recover automatically: the peer may have restarted or moved; retry the
      // known addresses instead of waiting for the next process start.
      if (!this.closed && this.channels.size === 0 && this.peerHints.length > 0) {
        clearTimeout(this.hintTimer)
        this.hintTimer = null
        this.hintAttempt = 0
        this.scheduleHintConnects()
      }
    })
  }

  registerChannel(peer, channel, via) {
    this.channels.set(peer.deviceId, channel)
    this.learnRelayCandidates(peer.relayCandidates, peer.deviceId)
    channel.on('frame', (message) => this.onFrame(peer.deviceId, message, channel))
    this.emit('peer', { deviceId: peer.deviceId, name: peer.name, via, channel })
  }

  /** Bind an unbound account fingerprint from the first authenticated peer. */
  async bindPeerAccountFingerprint(peer) {
    const fingerprint = typeof peer?.accountFingerprint === 'string' ? peer.accountFingerprint : null
    if (!fingerprint || this.accountFingerprint) return this.accountFingerprint ?? null
    this.accountFingerprint = fingerprint
    try {
      if (typeof this.onPeerAccountFingerprint === 'function') await this.onPeerAccountFingerprint({ ...peer, fingerprint })
    } catch {
      /* persistence callback is best effort */
    }
    this.emit('account-bound', { fingerprint, deviceId: peer?.deviceId ?? null })
    return fingerprint
  }

  async authorizePeer(peer) {
    const existing = this.roster.get(peer.deviceId)
    if (existing) {
      if (existing.revokedAt) {
        throw Object.assign(new Error('this device was revoked on this Fleet device; remove the revocation only with an explicit re-pair'), {
          code: 'device-revoked',
        })
      }
      return existing.edPublic === peer.edPublic && existing.xPublic === peer.xPublic
    }
    if (!this.trustOnFirstUse) return false
    // First contact: a single-use invite must be redeemed exactly once. Devices
    // that were admitted before (known-devices history) are exempt so a removed
    // device can be re-admitted without burning a new invite.
    if (this.onPeerInvite) {
      let allowed = false
      try {
        allowed = await this.onPeerInvite(peer)
      } catch {
        allowed = false
      }
      if (!allowed) return false
    }
    this.roster.set(peer.deviceId, {
      deviceId: peer.deviceId,
      name: peer.name ?? 'device',
      edPublic: peer.edPublic,
      xPublic: peer.xPublic,
      addedAt: Date.now(),
    })
    this.emit('roster', this.rosterEntries())
    return true
  }

  async connect(deviceId, { host, port, timeoutMs = this.connectTimeoutMs } = {}) {
    if (typeof deviceId !== 'string' || deviceId === '') throw new Error('connect needs a device id')
    if (deviceId === this.identity.deviceId) throw new Error('cannot connect to self')
    const existing = this.channels.get(deviceId)
    if (existing && !existing.closed) return existing

    const expected = this.roster.get(deviceId) ?? { deviceId }
    const discovered = this.discovered.get(deviceId)
    const hinted = this.peerHints.find((entry) => entry.deviceId === deviceId)
    const endpoint =
      host && port
        ? { host, port }
        : discovered
          ? { host: discovered.host, port: discovered.port }
          : hinted
            ? { host: hinted.host, port: hinted.port }
            : null
    let directError = null
    if (endpoint) {
      try {
        const socket = await connectDirect({ host: endpoint.host, port: endpoint.port, timeoutMs })
        const channel = this.createInitiator(socket, expected)
        await this.waitReady(channel, timeoutMs)
        return channel
      } catch (error) {
        directError = error
      }
    }
    if (this.relayClients.length > 0) {
      let lastError = null
      const ordered = [...this.relayClients].sort((left, right) => {
        if (left.online !== right.online) return left.online ? -1 : 1
        if (Number(left.failures ?? 0) !== Number(right.failures ?? 0)) return Number(left.failures ?? 0) - Number(right.failures ?? 0)
        return Number(right.lastReadyAt ?? 0) - Number(left.lastReadyAt ?? 0)
      })
      for (const client of ordered) {
        try {
          const socket = await client.requestConnect(deviceId, timeoutMs)
          const channel = this.createInitiator(socket, expected)
          await this.waitReady(channel, timeoutMs)
          client.failures = 0
          client.lastError = null
          client.lastReadyAt = Date.now()
          return channel
        } catch (error) {
          client.failures = Number(client.failures ?? 0) + 1
          client.lastError = String(error?.message ?? error)
          lastError = error
        }
      }
      throw Object.assign(new Error(`cannot reach ${deviceId} via relay: ${String(lastError?.message ?? 'all relays failed')}`), {
        code: 'unreachable',
        cause: lastError ?? undefined,
      })
    }
    throw Object.assign(
      new Error(`cannot reach ${deviceId}${directError ? `: ${String(directError.message)}` : ' (no endpoint)'}`),
      { code: 'unreachable', cause: directError ?? undefined },
    )
  }

  createInitiator(socket, expectedPeer) {
    const channel = new SecureChannel({
      socket,
      identity: this.identity,
      fleet: this.fleet,
      role: 'initiator',
      expectedPeer,
      accountFingerprint: this.accountFingerprint,
      onPeerAccountFingerprint: (peer) => this.bindPeerAccountFingerprint(peer),
      rotationChain: this.rotationChain,
      onPeerRotations: (peer, records) => this.applyPeerRotations(peer, records),
      inviteId: this.inviteId,
      rotationCheckpoint: this.rotationCheckpoint,
      onPeerCheckpoint: (peer, checkpoint) => this.recordRotationCheckpointOffer(peer, checkpoint),
      verifyPeer: (peer) => this.authorizePeer(peer),
      pluginVersion: this.pluginVersion,
      dshVersion: this.dshVersion,
      capabilities: this.capabilities,
      relayCandidates: this.relayCandidateList(),
    })
    this.attachChannel(channel, 'outbound')
    return channel
  }

  waitReady(channel, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (channel.authenticated) return resolve(channel)
      const timer = setTimeout(() => {
        cleanup()
        reject(Object.assign(new Error('secure channel handshake timed out'), { code: 'handshake-timeout' }))
        channel.destroy()
      }, timeoutMs)
      timer.unref?.()
      const onReady = () => {
        cleanup()
        resolve(channel)
      }
      const onClose = () => {
        cleanup()
        reject(Object.assign(new Error('secure channel closed during handshake'), { code: 'handshake-closed' }))
      }
      const cleanup = () => {
        clearTimeout(timer)
        channel.off('ready', onReady)
        channel.off('close', onClose)
      }
      channel.once('ready', onReady)
      channel.once('close', onClose)
    })
  }

  onFrame(deviceId, message, channel) {
    switch (message.t) {
      case FRAME.RPC_REQUEST: {
        const handler = this.requestHandler
        if (typeof handler !== 'function') {
          channel.sendFrame(rpcError({ id: message.id, code: 'no-handler', message: 'no request handler' }))
          return
        }
        Promise.resolve()
          .then(() => handler({ deviceId, method: message.method, params: message.params }))
          .then((result) => channel.sendFrame(rpcResult({ id: message.id, result })))
          .catch((error) => {
            channel.sendFrame(rpcError({ id: message.id, ...serializeError(error) }))
          })
        return
      }
      case FRAME.RPC_RESULT: {
        const pending = this.pendingRpc.get(message.id)
        if (!pending) return
        this.pendingRpc.delete(message.id)
        clearTimeout(pending.timer)
        pending.resolve(message.result)
        return
      }
      case FRAME.RPC_ERROR: {
        const pending = this.pendingRpc.get(message.id)
        if (!pending) return
        this.pendingRpc.delete(message.id)
        clearTimeout(pending.timer)
        const error = new Error(message.error?.message ?? 'remote error')
        error.code = message.error?.code ?? 'remote-error'
        error.data = message.error?.data ?? null
        pending.reject(error)
        return
      }
      case FRAME.EVENT: {
        this.emit('event', { deviceId, topic: message.topic, data: message.data })
        return
      }
      default:
        return
    }
  }

  rejectPendingForChannel(channel, error) {
    for (const [id, pending] of this.pendingRpc) {
      if (pending.channel === channel) {
        this.pendingRpc.delete(id)
        clearTimeout(pending.timer)
        pending.reject(error)
      }
    }
  }

  async request(deviceId, method, params, { timeoutMs = this.requestTimeoutMs } = {}) {
    const channel = await this.connect(deviceId)
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id)
        reject(Object.assign(new Error(`request ${method} to ${deviceId} timed out`), { code: 'timeout' }))
      }, timeoutMs)
      timer.unref?.()
      this.pendingRpc.set(id, { resolve, reject, timer, channel })
      try {
        channel.sendFrame(rpcRequest({ id, method, params }))
      } catch (error) {
        this.pendingRpc.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  async sendEvent(deviceId, topic, data) {
    const channel = await this.connect(deviceId)
    channel.sendFrame(eventFrame({ topic, data }))
  }

  peerIds() {
    return [...this.channels.keys()]
  }

  /** Apply live network changes without recreating the node or its identity. */
  async reconfigure({ name, direct, discovery, relay, relays } = {}) {
    if (this.closed) return
    if (typeof name === 'string' && name !== '') this.name = name
    const networkChanged = direct !== undefined || discovery !== undefined || relay !== undefined || relays !== undefined
    if (!networkChanged) return
    const wasStarted = this.started
    const previous = {
      directConfig: this.directConfig,
      discoveryConfig: this.discoveryConfig,
      relayConfig: this.relayConfig,
      relayConfigs: this.relayConfigs,
    }
    // Validate relay material before tearing down the live network.
    const nextRelayConfigs = relay !== undefined || relays !== undefined
      ? normalizeRelayConfigs(relay !== undefined ? relay : null, relays !== undefined ? relays : this.relayConfigs)
      : null
    await this.close()
    this.closed = false
    this.started = false
    this.hintAttempt = 0
    this.discovered.clear()
    if (direct !== undefined) this.directConfig = direct
    if (discovery !== undefined) this.discoveryConfig = discovery
    if (nextRelayConfigs) {
      this.relayConfigs = nextRelayConfigs
      this.relayConfig = this.relayConfigs[0] ?? null
      // Learned candidates are re-learned from peers; configured ones persist.
      for (const [key, candidate] of [...this.relayCandidates]) {
        if (!candidate.persistent) this.relayCandidates.delete(key)
      }
      for (const config of this.relayConfigs) {
        this.relayCandidates.set(`${config.host}:${config.port}:${config.dataPort}`, {
          ...config,
          source: 'config',
          persistent: true,
          learnedAt: 0,
        })
      }
    }
    this.directServer = null
    this.discovery = null
    this.relayClient = null
    this.relayClients = []
    this.directAddress = null
    if (!wasStarted) return
    try {
      await this.start()
    } catch (error) {
      // Restore the last working config rather than leaving the device offline.
      this.directConfig = previous.directConfig
      this.discoveryConfig = previous.discoveryConfig
      this.relayConfig = previous.relayConfig
      this.relayConfigs = previous.relayConfigs
      this.directServer = null
      this.discovery = null
      this.relayClient = null
      this.relayClients = []
      this.directAddress = null
      this.started = false
      this.closed = false
      try {
        await this.start()
      } catch {
        /* keep the original error; the caller gets the failed new config */
      }
      throw error
    }
  }

  async close() {
    this.closed = true
    clearTimeout(this.hintTimer)
    this.hintTimer = null
    clearInterval(this.relayPruneTimer)
    this.relayPruneTimer = null
    clearInterval(this.relayProbeTimer)
    this.relayProbeTimer = null
    for (const channel of this.channels.values()) channel.close()
    for (const socket of this.pendingSockets) {
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
    }
    this.pendingSockets.clear()
    this.channels.clear()
    for (const [id, pending] of this.pendingRpc) {
      this.pendingRpc.delete(id)
      clearTimeout(pending.timer)
      pending.reject(Object.assign(new Error('node closed'), { code: 'closed' }))
    }
    for (const client of this.relayClients) client.close()
    this.relayClients = []
    this.relayClient = null
    this.discovery?.close()
    if (this.directServer) await this.directServer.close()
  }
}

export { PROTOCOL_VERSION }
