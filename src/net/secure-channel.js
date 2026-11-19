// End-to-end secure channel between two fleet devices.
//
// Handshake (newline-delimited JSON):
//   initiator -> responder : HELLO   (static keys + fleet proof + ephemeral X25519 + signature)
//   responder -> initiator : HELLO_ACK
//   both                   : encrypted READY frame
// Then every frame is AES-256-GCM with per-direction keys derived from
// X25519(ephemeral, ephemeral) + HKDF over the handshake transcript. The relay,
// if used, only splices the underlying bytes and cannot read frames.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  diffieHellman,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  FRAME,
  HANDSHAKE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  stableStringify,
} from './protocol.js'
import {
  generateEphemeral,
  importPrivateKey,
  importPublicKey,
  membershipProof,
  verifyMembershipProof,
} from './identity.js'
import {
  ROTATION_INLINE_LIMIT,
  ROTATION_MAX_PULL_ROUNDS,
  ROTATION_MAX_RECORDS,
  ROTATION_PAGE_LIMIT,
  rotationChainPage,
  rotationRecordHash,
} from './rotation.js'
import { harnessVersionsCompatible } from './version-compat.js'

const AAD = Buffer.from('dsh-device-fleet/frame/v1')
const MAX_CLOCK_SKEW_MS = 120_000
/** Hard cap for one newline-delimited handshake message (rotation pages fit easily). */
const MAX_HANDSHAKE_LINE_BYTES = 1 * 1024 * 1024

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest()
}

function b64(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

export class SecureChannel extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('node:net').Socket} options.socket connected socket
   * @param {object} options.identity local identity ({deviceId, edPrivate, edPublic, xPublic, name})
   * @param {{fleetId: string, fleetKey: string}} options.fleet
   * @param {'initiator'|'responder'} options.role
   * @param {object|null} [options.expectedPeer] pinned peer ({deviceId, edPublic, xPublic})
   * @param {string|null} [options.accountFingerprint] expected account fingerprint
   * @param {(peer: object) => boolean|Promise<boolean>} [options.verifyPeer] trust decision after protocol checks
   * @param {string} [options.pluginVersion] strict plugin version (ADR-0024)
   * @param {string} [options.dshVersion] strict harness version line (ADR-0024)
   * @param {string[]} [options.capabilities] reserved capability declarations
   */
  constructor({
    socket,
    identity,
    fleet,
    role,
    expectedPeer = null,
    accountFingerprint = null,
    verifyPeer = null,
    pluginVersion = '0.0.0',
    dshVersion = 'unknown',
    capabilities = [],
    relayCandidates = [],
    onPeerAccountFingerprint = null,
    rotationChain = [],
    onPeerRotations = null,
    inviteId = null,
    rotationCheckpoint = null,
    onPeerCheckpoint = null,
  }) {
    super()
    if (role !== 'initiator' && role !== 'responder') throw new Error('invalid channel role')
    this.socket = socket
    this.identity = identity
    this.fleet = fleet
    this.role = role
    this.expectedPeer = expectedPeer
    this.accountFingerprint = accountFingerprint
    this.verifyPeer = verifyPeer
    this.pluginVersion = pluginVersion
    this.dshVersion = dshVersion
    this.capabilities = [...capabilities].sort()
    this.relayCandidates = Array.isArray(relayCandidates) ? relayCandidates : []
    this.onPeerAccountFingerprint = onPeerAccountFingerprint
    this.rotationChain = Array.isArray(rotationChain) ? rotationChain : []
    this.onPeerRotations = onPeerRotations
    this.inviteId = typeof inviteId === 'string' && inviteId !== '' ? inviteId : null
    this.rotationCheckpoint = rotationCheckpoint && typeof rotationCheckpoint === 'object' ? rotationCheckpoint : null
    this.onPeerCheckpoint = typeof onPeerCheckpoint === 'function' ? onPeerCheckpoint : null
    /** Handshake-scoped rotation catch-up state (one identity message at a time). */
    this.identityMessage = null

    this.phase = 'handshake'
    this.recvBuffer = Buffer.alloc(0)
    this.readySent = false
    this.readyReceived = false
    this.authenticated = false
    this.closed = false
    this.peer = null
    this.failure = null

    this.sendKey = null
    this.recvKey = null
    this.sendPrefix = null
    this.recvPrefix = null
    this.sendCounter = 0n
    this.recvCounter = 0n

    this.handshakeTimer = setTimeout(() => {
      this.fail('handshake-timeout', 'secure channel handshake timed out')
    }, HANDSHAKE_TIMEOUT_MS)
    this.handshakeTimer.unref?.()

    socket.setNoDelay?.(true)
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('error', (error) => this.onSocketError(error))
    socket.on('close', () => this.onSocketClose())

    if (socket.connecting) socket.once('connect', () => this.start())
    else this.start()
  }

  start() {
    if (this.phase !== 'handshake' || this.closed) return
    if (this.role === 'initiator') this.sendHello()
    // responder waits for HELLO
  }

  // ---------------------------------------------------------------- handshake

  sendHello() {
    this.ephemeral = generateEphemeral()
    const nonce = randomBytes(32)
    const fields = {
      t: 'hello',
      v: PROTOCOL_VERSION,
      fleetId: this.fleet.fleetId,
      deviceId: this.identity.deviceId,
      name: this.identity.name ?? 'device',
      edPublic: this.identity.edPublic,
      xPublic: this.identity.xPublic,
      ephX: this.ephemeral.publicKey,
      nonce: b64(nonce),
      ts: Date.now(),
      accountFingerprint: this.accountFingerprint ?? null,
      pluginVersion: this.pluginVersion,
      dshVersion: this.dshVersion,
      capabilities: this.capabilities,
      relayCandidates: this.relayCandidates,
      ...(this.inviteId ? { inviteId: this.inviteId } : {}),
      ...(this.rotationCheckpoint ? { rotationCheckpoint: this.rotationCheckpoint } : {}),
      ...this.localRotationMetadata(),
      ...(this.rotationChain.length > 0 ? { rotations: this.inlineRotations() } : {}),
    }
    const proof = membershipProof({
      fleetKey: this.fleet.fleetKey,
      fleetId: this.fleet.fleetId,
      deviceId: this.identity.deviceId,
      edPublic: this.identity.edPublic,
      xPublic: this.identity.xPublic,
      accountFingerprint: this.accountFingerprint ?? null,
    })
    const signed = { ...fields, proof }
    const sig = sign(null, Buffer.from(stableStringify(signed)), importPrivateKey(this.identity.edPrivate)).toString('base64url')
    this.localFields = fields
    this.writeLine({ ...signed, sig })
  }

  async onHello(message) {
    const fields = this.validateIdentityMessage(message, 'hello')
    if (fields === null) return
    await this.beginIdentity('hello', fields, message.rotations)
  }

  async onHelloAck(message) {
    const fields = this.validateIdentityMessage(message, 'hello.ack')
    if (fields === null) return
    await this.beginIdentity('hello.ack', fields, message.rotations)
  }

  /** Rotation head this device advertises in hello/ack (seq -1 = never rotated). */
  localRotationMetadata() {
    const chain = Array.isArray(this.rotationChain) ? this.rotationChain : []
    const last = chain[chain.length - 1]
    const first = chain[0]
    return {
      rotationSeq: last ? Number(last.seq) : -1,
      rotationHead: last ? rotationRecordHash(last) : null,
      // Oldest record still available locally; peers pinned below it cannot be
      // caught up automatically and must re-pair (rotation-history-pruned).
      rotationFrom: first ? Number(first.seq) : -1,
    }
  }

  inlineRotations() {
    return Array.isArray(this.rotationChain) ? this.rotationChain.slice(0, ROTATION_INLINE_LIMIT) : []
  }

  async beginIdentity(kind, fields, rotations) {
    if (this.identityMessage) {
      this.fail('handshake-rejected', 'duplicate identity message')
      return
    }
    this.peer = this.peerFrom(fields)
    this.identityMessage = {
      kind,
      fields,
      records: Array.isArray(rotations) ? rotations : [],
      rounds: 0,
      chunks: 0,
      expectedChunks: Number.isInteger(Number(fields.rotationChunks)) ? Number(fields.rotationChunks) : 0,
    }
    await this.advanceIdentity()
  }

  /**
   * Hand the accumulated rotation records to the trust callback and decide what
   * happens next: finish the handshake, wait for pushed pages, or pull a page.
   * The callback contract is either a boolean (legacy) or
   * `{ status, entry, need?, reason? }` where status is one of
   * ok|unpinned|gap|fork|invalid|revoked|key-changed.
   */
  async advanceIdentity() {
    const state = this.identityMessage
    if (!state || this.closed) return
    const incoming = state.records
    state.records = []
    let outcome = { status: 'ok' }
    if (typeof this.onPeerRotations === 'function') {
      try {
        outcome = await this.onPeerRotations(this.peer, Array.isArray(incoming) ? incoming : [])
      } catch (error) {
        this.fail('rotation-error', `rotation verification failed: ${String(error?.message ?? error)}`)
        return
      }
    }
    if (typeof this.onPeerRotations !== 'function') {
      await this.finishIdentity(state)
      return
    }
    if (outcome === true) outcome = { status: 'ok' }
    if (outcome === false) outcome = { status: 'key-changed', reason: 'peer key is not pinned in the roster' }
    const status = outcome?.status ?? 'ok'
    if (status === 'fork') {
      this.fail('rotation-fork', 'rotation chain fork detected; resolve it on this device with fleet_rotation_fork_resolve before reconnecting')
      return
    }
    if (status !== 'ok' && status !== 'unpinned' && status !== 'gap') {
      this.fail(`rotation-${String(status)}`, `rotation chain rejected: ${String(outcome?.reason ?? status)}`)
      return
    }
    const entry = outcome?.entry ?? null
    const keysMatch = Boolean(entry) && entry.edPublic === this.peer.edPublic && entry.xPublic === this.peer.xPublic
    const peerFrom = Number.isInteger(Number(this.peer?.rotationFrom)) ? Number(this.peer.rotationFrom) : -1
    if (
      status !== 'unpinned' &&
      !keysMatch &&
      peerFrom > Number(entry?.rotationSeq ?? -1) + 1
    ) {
      const checkpoint = this.peer?.rotationCheckpoint
      if (checkpoint && this.onPeerCheckpoint) {
        try {
          await this.onPeerCheckpoint(this.peer, checkpoint)
        } catch {
          /* the offer is advisory; the user still has to confirm it */
        }
        this.fail(
          'rotation-checkpoint-required',
          `peer rotation history was pruned before seq ${peerFrom}; confirm its checkpoint with fleet_rotation_trust_checkpoint before reconnecting`,
        )
        return
      }
      this.fail(
        'rotation-history-pruned',
        `peer rotation history starts at seq ${peerFrom}, this device is pinned at seq ${String(entry?.rotationSeq ?? -1)}; re-pair the device`,
      )
      return
    }
    // Pages pushed right after the ack must be consumed before the channel
    // switches to binary frames; an unpinned (first-contact) peer ignores their
    // contents but still reads them.
    if (state.expectedChunks > state.chunks) return
    if (status === 'unpinned' || keysMatch) {
      await this.finishIdentity(state)
      return
    }
    const fromSeq = Number.isInteger(Number(outcome?.need?.fromSeq))
      ? Number(outcome.need.fromSeq)
      : Number(entry?.rotationSeq ?? -1) + 1
    if (state.rounds >= ROTATION_MAX_PULL_ROUNDS) {
      this.fail('rotation-chain-too-long', 'rotation chain needs too many pages; connect both devices and re-pair, or shrink the chain')
      return
    }
    state.rounds += 1
    this.writeLine({ t: 'rotation.pull', v: PROTOCOL_VERSION, fromSeq: Math.max(0, fromSeq), limit: ROTATION_PAGE_LIMIT })
  }

  async onRotationPage(message) {
    const state = this.identityMessage
    if (!state) {
      this.fail('handshake-rejected', 'rotation page before the peer identity')
      return
    }
    const records = Array.isArray(message.records) ? message.records : []
    if (records.length > ROTATION_PAGE_LIMIT) {
      this.fail('handshake-rejected', 'rotation page is too large')
      return
    }
    state.chunks += 1
    const expected = Number.isInteger(Number(message.total)) ? Number(message.total) : state.expectedChunks
    if (Number.isInteger(expected) && expected > 0 && state.chunks > expected) {
      this.fail('handshake-rejected', 'too many rotation pages')
      return
    }
    if (state.expectedChunks === 0 && Number.isInteger(expected) && expected > 0) state.expectedChunks = expected
    state.records = records
    await this.advanceIdentity()
  }

  /** Answer a peer's page request from our own persisted rotation chain. */
  onRotationPull(message) {
    const fromSeq = Number.isInteger(Number(message.fromSeq)) && Number(message.fromSeq) > 0 ? Number(message.fromSeq) : 0
    const limit = Math.min(ROTATION_PAGE_LIMIT, Math.max(1, Number(message.limit) || ROTATION_PAGE_LIMIT))
    const page = rotationChainPage(this.rotationChain, { fromSeq, limit })
    this.writeLine({ t: 'rotation.page', v: PROTOCOL_VERSION, fromSeq, limit, records: page.records, final: page.complete })
  }

  async finishIdentity(state) {
    const fields = state.fields
    this.identityMessage = null
    if (!(await this.authorizePeer())) return
    if (state.kind === 'hello') {
      // An unbound creator has no persisted account fingerprint. Bind to the
      // first authenticated peer's non-null fingerprint before signing the ack,
      // so the peer's account check sees a consistent value.
      if (!this.accountFingerprint && typeof this.onPeerAccountFingerprint === 'function') {
        try {
          const bound = await this.onPeerAccountFingerprint(this.peer)
          if (typeof bound === 'string' && bound !== '') this.accountFingerprint = bound
        } catch {
          /* binding is best effort; the normal account check still applies */
        }
      }

      this.ephemeral = generateEphemeral()
      const shared = diffieHellman({
        privateKey: importPrivateKey(this.ephemeral.privateKeyPem),
        publicKey: importPublicKey(fields.ephX),
      })
      const nonce = randomBytes(32)
      const peerSeq = Number.isInteger(Number(fields.rotationSeq)) ? Number(fields.rotationSeq) : -1
      const ownChain = Array.isArray(this.rotationChain) ? this.rotationChain : []
      // The peer's advertised rotationSeq is its own chain position, not its pin
      // of us; it is only a lower bound for how much of our chain to push. The
      // receiver knows its real pin and reports rotation-history-pruned itself
      // if our retained window no longer covers it.
      const needed = ownChain.filter((record) => Number(record?.seq) > peerSeq)
      if (needed.length > ROTATION_MAX_RECORDS) {
        this.fail('rotation-chain-too-long', 'rotation chain is too long to transfer; re-pair the device instead')
        return
      }
      const inline = needed.slice(0, ROTATION_INLINE_LIMIT)
      const pages = []
      for (let index = ROTATION_INLINE_LIMIT; index < needed.length; index += ROTATION_PAGE_LIMIT) {
        pages.push(needed.slice(index, index + ROTATION_PAGE_LIMIT))
      }
      const ackFields = {
        t: 'hello.ack',
        v: PROTOCOL_VERSION,
        fleetId: this.fleet.fleetId,
        deviceId: this.identity.deviceId,
        name: this.identity.name ?? 'device',
        edPublic: this.identity.edPublic,
        xPublic: this.identity.xPublic,
        ephX: this.ephemeral.publicKey,
        nonce: b64(nonce),
        ts: Date.now(),
        accountFingerprint: this.accountFingerprint ?? null,
        pluginVersion: this.pluginVersion,
        dshVersion: this.dshVersion,
        capabilities: this.capabilities,
        relayCandidates: this.relayCandidates,
        ...this.localRotationMetadata(),
        ...(inline.length > 0 ? { rotations: inline } : {}),
        ...(this.rotationCheckpoint ? { rotationCheckpoint: this.rotationCheckpoint } : {}),
        ...(pages.length > 0 ? { rotationChunks: pages.length } : {}),
      }
      const proof = membershipProof({
        fleetKey: this.fleet.fleetKey,
        fleetId: this.fleet.fleetId,
        deviceId: this.identity.deviceId,
        edPublic: this.identity.edPublic,
        xPublic: this.identity.xPublic,
        accountFingerprint: this.accountFingerprint ?? null,
      })
      const signed = { ...ackFields, proof }
      const sig = sign(null, Buffer.from(stableStringify(signed)), importPrivateKey(this.identity.edPrivate)).toString('base64url')
      this.localFields = ackFields
      this.writeLine({ ...signed, sig })
      for (const [index, page] of pages.entries()) {
        this.writeLine({
          t: 'rotation.page',
          v: PROTOCOL_VERSION,
          index,
          total: pages.length,
          records: page,
          final: index === pages.length - 1,
        })
      }

      const transcript = sha256(stableStringify({ hello: this.stripRotations(fields), ack: this.stripRotations(ackFields) }))
      this.deriveKeys(shared, transcript, 'responder')
      this.enterFrames()
      this.sendReady()
      return
    }

    const shared = diffieHellman({
      privateKey: importPrivateKey(this.ephemeral.privateKeyPem),
      publicKey: importPublicKey(fields.ephX),
    })
    const transcript = sha256(stableStringify({ hello: this.stripRotations(this.localFields), ack: this.stripRotations(fields) }))
    this.deriveKeys(shared, transcript, 'initiator')
    this.enterFrames()
    this.sendReady()
  }

  validateIdentityMessage(message, kind) {
    const fail = (reason) => {
      this.fail('handshake-rejected', reason)
      return null
    }
    if (!message || typeof message !== 'object') return fail(`${kind} is not an object`)
    if (message.t !== kind) return fail(`expected ${kind}`)
    if (message.v !== PROTOCOL_VERSION) return fail('protocol version mismatch')
    if (message.pluginVersion !== this.pluginVersion) {
      return fail(`plugin version mismatch: peer ${String(message.pluginVersion)} vs local ${this.pluginVersion}`)
    }
    if (message.dshVersion !== this.dshVersion) {
      if (!harnessVersionsCompatible(this.dshVersion, message.dshVersion)) {
        return fail(`harness version mismatch: peer ${String(message.dshVersion)} vs local ${this.dshVersion}; upgrade both devices to the same DSH release line`)
      }
    }
    if (message.fleetId !== this.fleet.fleetId) return fail('fleet mismatch')
    if (!isNonEmptyString(message.deviceId)) return fail('missing device id')
    if (message.deviceId === this.identity.deviceId) return fail('peer is this device')
    for (const key of ['edPublic', 'xPublic', 'ephX', 'nonce', 'proof', 'sig']) {
      if (!isNonEmptyString(message[key])) return fail(`missing ${key}`)
    }
    if (Array.isArray(message.rotations) && message.rotations.length > ROTATION_INLINE_LIMIT) {
      return fail('too many inline rotation records')
    }
    if (Number.isFinite(Number(message.rotationChunks)) && Number(message.rotationChunks) > Math.ceil(ROTATION_MAX_RECORDS / ROTATION_PAGE_LIMIT)) {
      return fail('rotation page count is too large')
    }
    if (typeof message.ts !== 'number' || Math.abs(Date.now() - message.ts) > MAX_CLOCK_SKEW_MS) {
      return fail('clock skew too large')
    }
    if (this.expectedPeer?.deviceId !== undefined && message.deviceId !== this.expectedPeer.deviceId) {
      return fail('unexpected device id')
    }
    // Device keys are validated after the rotation chain has been applied
    // (onPeerRotations/authorizePeer); pinned keys may legitimately change.
    if (this.accountFingerprint !== null && this.accountFingerprint !== undefined) {
      if ((message.accountFingerprint ?? null) !== this.accountFingerprint) return fail('account mismatch')
    }

    const { sig, ...signed } = message
    let signatureOk = false
    try {
      signatureOk = verify(null, Buffer.from(stableStringify(signed)), importPublicKey(message.edPublic), Buffer.from(sig, 'base64url'))
    } catch {
      signatureOk = false
    }
    if (!signatureOk) return fail('invalid signature')

    const proofOk = verifyMembershipProof(message.proof, {
      fleetKey: this.fleet.fleetKey,
      fleetId: this.fleet.fleetId,
      deviceId: message.deviceId,
      edPublic: message.edPublic,
      xPublic: message.xPublic,
      accountFingerprint: message.accountFingerprint ?? null,
    })
    if (!proofOk) return fail('invalid fleet membership proof')

    return {
      t: kind,
      v: message.v,
      fleetId: message.fleetId,
      deviceId: message.deviceId,
      name: message.name ?? 'device',
      edPublic: message.edPublic,
      xPublic: message.xPublic,
      ephX: message.ephX,
      nonce: message.nonce,
      ts: message.ts,
      accountFingerprint: message.accountFingerprint ?? null,
      pluginVersion: message.pluginVersion,
      dshVersion: message.dshVersion,
      capabilities: Array.isArray(message.capabilities) ? message.capabilities : [],
      relayCandidates: Array.isArray(message.relayCandidates) ? message.relayCandidates : [],
      rotationSeq: Number.isInteger(Number(message.rotationSeq)) ? Number(message.rotationSeq) : null,
      rotationHead: isNonEmptyString(message.rotationHead) ? message.rotationHead : null,
      rotationFrom: Number.isInteger(Number(message.rotationFrom)) ? Number(message.rotationFrom) : null,
      rotationChunks: Number.isInteger(Number(message.rotationChunks)) ? Number(message.rotationChunks) : 0,
      inviteId: isNonEmptyString(message.inviteId) ? message.inviteId : null,
      rotationCheckpoint: message.rotationCheckpoint && typeof message.rotationCheckpoint === 'object' ? message.rotationCheckpoint : null,
    }
  }

  stripRotations(fields) {
    if (!fields || typeof fields !== 'object') return fields
    const { rotations, rotationSeq, rotationHead, rotationFrom, rotationChunks, inviteId, rotationCheckpoint, ...rest } = fields
    return rest
  }

  peerFrom(fields) {
    return {
      deviceId: fields.deviceId,
      name: fields.name,
      edPublic: fields.edPublic,
      xPublic: fields.xPublic,
      accountFingerprint: fields.accountFingerprint ?? null,
      pluginVersion: fields.pluginVersion,
      dshVersion: fields.dshVersion,
      capabilities: fields.capabilities ?? [],
      relayCandidates: Array.isArray(fields.relayCandidates) ? fields.relayCandidates : [],
      rotationSeq: Number.isInteger(Number(fields.rotationSeq)) ? Number(fields.rotationSeq) : null,
      rotationHead: isNonEmptyString(fields.rotationHead) ? fields.rotationHead : null,
      rotationFrom: Number.isInteger(Number(fields.rotationFrom)) ? Number(fields.rotationFrom) : null,
      inviteId: isNonEmptyString(fields.inviteId) ? fields.inviteId : null,
      rotationCheckpoint: fields.rotationCheckpoint && typeof fields.rotationCheckpoint === 'object' ? fields.rotationCheckpoint : null,
    }
  }

  async authorizePeer() {
    if (typeof this.verifyPeer !== 'function') return true
    try {
      const allowed = await this.verifyPeer(this.peer)
      if (!allowed) {
        this.fail('peer-rejected', 'peer rejected by local policy')
        return false
      }
      return true
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'peer-rejected'
      this.fail(code, `peer verification failed: ${String(error?.message ?? error)}`)
      return false
    }
  }

  deriveKeys(shared, transcript, role) {
    const okm = Buffer.from(
      hkdfSync('sha256', shared, transcript, Buffer.from('dsh-device-fleet/channel/v1'), 72),
    )
    const initiatorToResponderKey = okm.subarray(0, 32)
    const initiatorToResponderPrefix = okm.subarray(32, 36)
    const responderToInitiatorKey = okm.subarray(36, 68)
    const responderToInitiatorPrefix = okm.subarray(68, 72)
    if (role === 'initiator') {
      this.sendKey = initiatorToResponderKey
      this.sendPrefix = initiatorToResponderPrefix
      this.recvKey = responderToInitiatorKey
      this.recvPrefix = responderToInitiatorPrefix
    } else {
      this.sendKey = responderToInitiatorKey
      this.sendPrefix = responderToInitiatorPrefix
      this.recvKey = initiatorToResponderKey
      this.recvPrefix = initiatorToResponderPrefix
    }
  }

  enterFrames() {
    this.phase = 'frames'
    if (this.recvBuffer.length > 0) this.processFrames()
  }

  sendReady() {
    if (this.readySent || this.closed) return
    this.readySent = true
    this.sendFrame({ t: FRAME.READY, v: PROTOCOL_VERSION, deviceId: this.identity.deviceId })
    this.maybeAuthenticate()
  }

  onReadyFrame() {
    this.readyReceived = true
    this.maybeAuthenticate()
  }

  maybeAuthenticate() {
    if (this.authenticated || !this.readySent || !this.readyReceived) return
    this.authenticated = true
    clearTimeout(this.handshakeTimer)
    this.emit('ready', this.peer)
  }

  // ------------------------------------------------------------------- frames

  writeLine(message) {
    if (this.closed) return
    this.socket.write(JSON.stringify(message) + '\n')
  }

  sendFrame(message) {
    if (this.closed) throw new Error('secure channel is closed')
    if (this.phase !== 'frames' || !this.sendKey) throw new Error('secure channel is not ready')
    const plaintext = Buffer.from(JSON.stringify(message))
    this.sendCounter += 1n
    const nonce = Buffer.alloc(12)
    this.sendPrefix.copy(nonce, 0)
    nonce.writeBigUInt64BE(this.sendCounter, 4)
    const cipher = createCipheriv('aes-256-gcm', this.sendKey, nonce)
    cipher.setAAD(AAD)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    const payload = Buffer.concat([ciphertext, tag])
    const header = Buffer.alloc(4)
    header.writeUInt32BE(payload.length)
    this.socket.write(Buffer.concat([header, payload]))
  }

  onData(chunk) {
    if (this.closed) return
    this.recvBuffer = Buffer.concat([this.recvBuffer, chunk])
    if (this.phase === 'handshake') this.processHandshake()
    if (this.phase === 'frames') this.processFrames()
  }

  processHandshake() {
    if (this.handshakeBusy) return
    this.handshakeBusy = true
    this.drainHandshake().finally(() => {
      this.handshakeBusy = false
      if (this.phase === 'frames' && !this.closed) this.processFrames()
    })
  }

  async drainHandshake() {
    while (this.phase === 'handshake' && !this.closed) {
      const newline = this.recvBuffer.indexOf(0x0a)
      if (newline < 0) {
        if (this.recvBuffer.length > MAX_HANDSHAKE_LINE_BYTES) {
          this.fail('handshake-rejected', 'handshake message is too large')
        }
        return
      }
      if (newline > MAX_HANDSHAKE_LINE_BYTES) {
        this.fail('handshake-rejected', 'handshake message is too large')
        return
      }
      const line = this.recvBuffer.subarray(0, newline).toString('utf8')
      this.recvBuffer = this.recvBuffer.subarray(newline + 1)
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.fail('handshake-rejected', 'invalid handshake JSON')
        return
      }
      if (message.t === 'rotation.pull') {
        this.onRotationPull(message)
      } else if (message.t === 'rotation.page') {
        try {
          await this.onRotationPage(message)
        } catch (error) {
          this.fail('handshake-error', `rotation page handling failed: ${String(error?.stack ?? error)}`)
          return
        }
      } else if (message.t === 'hello' && this.role === 'responder') {
        try {
          await this.onHello(message)
        } catch (error) {
          this.fail('handshake-error', `hello handling failed: ${String(error?.stack ?? error)}`)
          return
        }
      } else if (message.t === 'hello.ack' && this.role === 'initiator') {
        try {
          await this.onHelloAck(message)
        } catch (error) {
          this.fail('handshake-error', `ack handling failed: ${String(error?.stack ?? error)}`)
          return
        }
      } else {
        this.fail('handshake-rejected', `unexpected handshake message ${String(message.t)}`)
        return
      }
    }
  }

  processFrames() {
    while (this.phase === 'frames' && !this.closed) {
      if (this.recvBuffer.length < 4) return
      const length = this.recvBuffer.readUInt32BE(0)
      if (length <= 16 || length > MAX_FRAME_BYTES) {
        this.fail('frame-invalid', `invalid frame length ${String(length)}`)
        return
      }
      if (this.recvBuffer.length < 4 + length) return
      const payload = this.recvBuffer.subarray(4, 4 + length)
      this.recvBuffer = this.recvBuffer.subarray(4 + length)
      let message
      try {
        message = this.openFrame(payload)
      } catch {
        this.fail('frame-invalid', 'frame authentication failed')
        return
      }
      this.dispatch(message)
    }
  }

  openFrame(payload) {
    const tag = payload.subarray(payload.length - 16)
    const ciphertext = payload.subarray(0, payload.length - 16)
    this.recvCounter += 1n
    const nonce = Buffer.alloc(12)
    this.recvPrefix.copy(nonce, 0)
    nonce.writeBigUInt64BE(this.recvCounter, 4)
    const decipher = createDecipheriv('aes-256-gcm', this.recvKey, nonce)
    decipher.setAAD(AAD)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return JSON.parse(plaintext.toString('utf8'))
  }

  dispatch(message) {
    if (!message || typeof message !== 'object') return
    if (message.t === FRAME.READY) {
      this.onReadyFrame()
      return
    }
    if (message.t === FRAME.PING) {
      try {
        this.sendFrame({ t: FRAME.PONG, v: PROTOCOL_VERSION })
      } catch {
        /* closing */
      }
      return
    }
    if (message.t === FRAME.PONG) return
    if (!this.authenticated) {
      this.fail('frame-before-ready', 'frame received before channel was ready')
      return
    }
    this.emit('frame', message)
  }

  // ----------------------------------------------------------------- lifecycle

  onSocketError(error) {
    if (this.closed) return
    this.emit('error', error)
  }

  onSocketClose() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.handshakeTimer)
    this.emit('close', this.failure)
  }

  fail(code, message) {
    if (this.closed) return
    const error = new Error(message)
    error.code = code
    this.failure = error
    this.emit('error', error)
    this.destroy()
  }

  destroy() {
    if (this.closed) return
    try {
      this.socket.destroy()
    } catch {
      /* ignore */
    }
  }

  close() {
    this.destroy()
  }
}
