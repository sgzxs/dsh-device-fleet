import { test } from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate, sign } from 'node:crypto'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  accountFingerprint,
  applyRevocation,
  applyRotationChain,
  createFleet,
  createRelayServer,
  createRevocationRecord,
  decodeInvite,
  encodeInvite,
  FleetNode,
  generateIdentity,
  harnessVersionsCompatible,
  RelayClient,
  createRotationRecord,
  createRotationCheckpoint,
  refreshRotationCheckpoint,
  splitInviteCode,
  joinInviteCode,
  resolveRotationFork,
  rotateIdentityKeys,
  rotationChainPage,
  rotationRecordHash,
  verifyRevocationRecord,
  verifyRotationCheckpoint,
  verifyRotationRecord,
  applyRotationRecord,
  verifyRotationChain,
} from '../src/net/index.js'
import { importPrivateKey } from '../src/net/identity.js'
import { stableStringify } from '../src/net/protocol.js'

function echoServer(label) {
  return async ({ method, params }) => {
    if (method === 'echo') return { from: label, params }
    throw Object.assign(new Error(`unknown method ${method}`), { code: 'unknown-method' })
  }
}

const tlsFixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/tls/${name}`, import.meta.url)), 'utf8')

function once(emitter, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for ${event}`))
    }, timeoutMs)
    timer.unref?.()
    const onEvent = (value) => {
      cleanup()
      resolve(value)
    }
    const cleanup = () => {
      clearTimeout(timer)
      emitter.off(event, onEvent)
    }
    emitter.once(event, onEvent)
  })
}

test('invite can carry the creator rotation chain and split into copyable parts', () => {
  const fleet = createFleet()
  const seed = generateIdentity({ name: 'chain-creator' })
  const { records, finalIdentity } = buildRotationChain(seed, 3)
  const invite = encodeInvite({
    fleet,
    creator: {
      deviceId: finalIdentity.deviceId,
      name: 'chain-creator',
      edPublic: finalIdentity.edPublic,
      xPublic: finalIdentity.xPublic,
      rotationSeq: 2,
      rotationHead: rotationRecordHash(records[2]),
    },
    rotations: records,
  })
  const decoded = decodeInvite(invite)
  assert.equal(decoded.rotations.length, 3)
  assert.equal(decoded.rotations[2].newEdPublic, finalIdentity.edPublic)
  const parts = splitInviteCode(invite, 300)
  assert.ok(parts.length > 1)
  assert.equal(joinInviteCode(parts), invite)
  assert.equal(decodeInvite(joinInviteCode(parts)).creator.deviceId, finalIdentity.deviceId)
})

test('invite v3 carries a signed bootstrap roster, expiry and single-use id', () => {
  const fleet = createFleet({ name: 'home' })
  const creator = generateIdentity({ name: 'creator' })
  const member = generateIdentity({ name: 'member' })
  const revocation = createRevocationRecord(creator, { deviceId: member.deviceId, revokedSeq: 0, reason: 'lost key' })
  const invite = encodeInvite({
    fleet,
    accountFingerprint: 'fp-1',
    relay: { host: 'relay.local', port: 7000, dataPort: 7002, tls: { ca: 'CA-PEM', servername: 'relay.local' } },
    relays: [{ host: 'relay-b.local', port: 7001, dataPort: 7002, tls: { ca: 'CA-PEM', rejectUnauthorized: false } }],
    endpoints: [{ deviceId: creator.deviceId, host: '192.168.137.1', port: 61318 }],
    creator: {
      deviceId: creator.deviceId,
      name: 'creator',
      edPublic: creator.edPublic,
      xPublic: creator.xPublic,
      rotationSeq: 1,
      rotationHead: 'head-1',
    },
    roster: [{
      deviceId: member.deviceId,
      name: 'member',
      edPublic: member.edPublic,
      xPublic: member.xPublic,
      revokedAt: revocation.revokedAt,
      revokedBy: creator.deviceId,
      revocationReason: 'lost key',
    }],
    revocations: [revocation],
  })
  const decoded = decodeInvite(invite)
  assert.equal(decoded.fleet.fleetId, fleet.fleetId)
  assert.equal(decoded.fleet.fleetKey, fleet.fleetKey)
  assert.equal(decoded.accountFingerprint, 'fp-1')
  assert.deepEqual(decoded.relay.tls, { ca: 'CA-PEM', servername: 'relay.local' })
  assert.deepEqual(decoded.relays[0].tls, { ca: 'CA-PEM', rejectUnauthorized: false })
  assert.deepEqual(decoded.endpoints, [{ deviceId: creator.deviceId, host: '192.168.137.1', port: 61318 }])
  assert.equal(decoded.creator.deviceId, creator.deviceId)
  assert.equal(decoded.creator.rotationSeq, 1)
  assert.equal(decoded.roster.length, 1)
  assert.equal(decoded.roster[0].revokedAt, revocation.revokedAt)
  assert.equal(decoded.revocations.length, 1)
  assert.equal(verifyRevocationRecord(decoded.revocations[0]), true)
  assert.ok(decoded.jti)
  assert.ok(Number.isFinite(decoded.expiresAt))
  assert.equal(decoded.singleUse, true)

  // Rewriting the bootstrap roster without the fleet key invalidates the HMAC.
  const payload = JSON.parse(Buffer.from(invite.slice('DSHF1.'.length), 'base64url').toString('utf8'))
  payload.roster[0].edPublic = generateIdentity({ name: 'attacker' }).edPublic
  const tampered = 'DSHF1.' + Buffer.from(JSON.stringify(payload)).toString('base64url')
  assert.throws(() => decodeInvite(tampered), /signature/)

  // Expiry is enforced at decode time.
  const shortLived = encodeInvite({ fleet, ttlMs: 20 })
  const expiredPayload = JSON.parse(Buffer.from(shortLived.slice('DSHF1.'.length), 'base64url').toString('utf8'))
  assert.throws(() => decodeInvite(shortLived, { now: expiredPayload.expiresAt + 1 }), /expired/)

  // v1 invites from older releases still decode (no bootstrap data, no HMAC).
  const legacy = 'DSHF1.' + Buffer.from(JSON.stringify({ v: 1, fleetId: 'fleet-1', fleetKey: 'key-1' })).toString('base64url')
  const legacyDecoded = decodeInvite(legacy)
  assert.deepEqual(legacyDecoded.roster, [])
  assert.deepEqual(legacyDecoded.revocations, [])
  assert.equal(legacyDecoded.creator, null)
  assert.throws(() => decodeInvite('not-an-invite'))
})

test('invite id is advertised on first contact and the host can reject it', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const host = new FleetNode({
    identity: generateIdentity({ name: 'invite-host' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
  })
  const joiner = new FleetNode({
    identity: generateIdentity({ name: 'invite-joiner' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
    inviteId: 'jti-first-contact',
  })
  const rejected = new FleetNode({
    identity: generateIdentity({ name: 'invite-rejected' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
    inviteId: 'jti-rejected',
  })
  const seen = []
  host.onPeerInvite = async (peer) => {
    seen.push(peer.inviteId)
    return peer.inviteId !== 'jti-rejected'
  }
  try {
    await host.start()
    await joiner.start()
    await rejected.start()
    await joiner.connectAddress('127.0.0.1', host.directAddress.port)
    assert.equal(seen[0], 'jti-first-contact')
    await assert.rejects(rejected.connectAddress('127.0.0.1', host.directAddress.port))
    assert.equal(host.roster.has(rejected.identity.deviceId), false)
  } finally {
    await host.close()
    await joiner.close()
    await rejected.close()
  }
})

test('direct transport: authenticated RPC and roster pinning', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const identityA = generateIdentity({ name: 'A' })
  const identityB = generateIdentity({ name: 'B' })
  const a = new FleetNode({
    identity: identityA,
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
  })
  const b = new FleetNode({
    identity: identityB,
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
  })
  a.onRequest(echoServer('A'))
  try {
    await a.start()
    await b.start()
    await b.connect(identityA.deviceId, { host: '127.0.0.1', port: a.directAddress.port })
    const result = await b.request(identityA.deviceId, 'echo', { hello: 'world' })
    assert.deepEqual(result, { from: 'A', params: { hello: 'world' } })
    await assert.rejects(b.request(identityA.deviceId, 'nope', {}), /unknown method/)
    assert.equal(a.roster.has(identityB.deviceId), true)
    assert.equal(b.roster.has(identityA.deviceId), true)
  } finally {
    await a.close()
    await b.close()
  }
})

test('three devices form a direct mesh and all rosters converge', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const identities = ['A-mesh', 'B-mesh', 'C-mesh'].map((name) => generateIdentity({ name }))
  const nodes = identities.map((identity) => new FleetNode({
    identity,
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
  }))
  const [a, b, c] = nodes
  a.onRequest(echoServer('A-mesh'))
  b.onRequest(echoServer('B-mesh'))
  try {
    for (const node of nodes) await node.start()
    await b.connect(identities[0].deviceId, { host: '127.0.0.1', port: a.directAddress.port })
    await b.connect(identities[2].deviceId, { host: '127.0.0.1', port: c.directAddress.port })
    await c.connect(identities[0].deviceId, { host: '127.0.0.1', port: a.directAddress.port })
    await c.connect(identities[1].deviceId, { host: '127.0.0.1', port: b.directAddress.port })
    assert.deepEqual(await c.request(identities[1].deviceId, 'echo', { hop: 2 }), { from: 'B-mesh', params: { hop: 2 } })
    for (const node of nodes) {
      assert.equal(node.roster.size, 2)
      assert.equal(node.peerIds().length >= 2, true)
    }
  } finally {
    for (const node of nodes) await node.close()
  }
})

test('manual address connect learns the peer id and works without discovery', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const identityA = generateIdentity({ name: 'A' })
  const identityB = generateIdentity({ name: 'B' })
  const a = new FleetNode({
    identity: identityA,
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
  })
  const b = new FleetNode({
    identity: identityB,
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
  })
  a.onRequest(echoServer('A-manual'))
  try {
    await a.start()
    await b.start()
    const peer = await b.connectAddress('127.0.0.1', a.directAddress.port)
    assert.equal(peer.deviceId, identityA.deviceId)
    assert.equal(peer.name, 'A')
    const result = await b.request(identityA.deviceId, 'echo', { manual: true })
    assert.deepEqual(result, { from: 'A-manual', params: { manual: true } })
    const status = b.status()
    assert.equal(status.direct.port, b.directAddress.port)
  } finally {
    await a.close()
    await b.close()
  }
})

test('reconfigure rolls back to the previous direct listener when the new bind fails', async () => {
  const fleet = createFleet()
  const blocker = net.createServer()
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const blockedPort = blocker.address().port
  const node = new FleetNode({
    identity: generateIdentity({ name: 'reconfigure-rollback' }),
    fleet,
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
  })
  try {
    await node.start()
    await assert.rejects(node.reconfigure({ direct: { host: '127.0.0.1', port: blockedPort } }))
    assert.equal(node.started, true)
    assert.ok(node.directAddress?.port > 0)
  } finally {
    await node.close()
    await new Promise((resolve) => blocker.close(resolve))
  }
})

test('reconfigure restarts the direct listener without recreating the node', async () => {
  const fleet = createFleet()
  const identity = generateIdentity({ name: 'A' })
  const node = new FleetNode({
    identity,
    fleet,
    accountFingerprint: accountFingerprint(fleet.fleetKey, 'user-1'),
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
  })
  try {
    await node.start()
    assert.ok(node.directAddress.port > 0)
    await node.reconfigure({ direct: { host: '127.0.0.1', port: 0 }, discovery: false })
    assert.ok(node.directAddress.port > 0)
    assert.equal(node.started, true)
  } finally {
    await node.close()
  }
})

test('handshake rejects a different fleet and a different account', async () => {
  const fleet = createFleet()
  const otherFleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const identityA = generateIdentity({ name: 'A' })
  const a = new FleetNode({
    identity: identityA,
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
  })
  const foreign = new FleetNode({
    identity: generateIdentity({ name: 'foreign' }),
    fleet: otherFleet,
    direct: { host: '127.0.0.1', port: 0 },
  })
  const sameFleetOtherAccount = new FleetNode({
    identity: generateIdentity({ name: 'other-account' }),
    fleet,
    accountFingerprint: accountFingerprint(fleet.fleetKey, 'user-2'),
    direct: { host: '127.0.0.1', port: 0 },
  })
  try {
    await a.start()
    await foreign.start()
    await sameFleetOtherAccount.start()
    await assert.rejects(
      foreign.connect(identityA.deviceId, { host: '127.0.0.1', port: a.directAddress.port }),
      /cannot reach/,
    )
    await assert.rejects(
      sameFleetOtherAccount.connect(identityA.deviceId, { host: '127.0.0.1', port: a.directAddress.port }),
      /cannot reach/,
    )
    assert.equal(a.roster.has(sameFleetOtherAccount.identity.deviceId), false)
  } finally {
    await a.close()
    await foreign.close()
    await sameFleetOtherAccount.close()
  }
})

test('pinned roster keys reject a changed device key', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const identityA = generateIdentity({ name: 'A' })
  const a = new FleetNode({
    identity: identityA,
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
  })
  const impostorKeys = generateIdentity({ name: 'fake-A' })
  const pinned = new FleetNode({
    identity: generateIdentity({ name: 'B' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
    roster: [
      {
        deviceId: identityA.deviceId,
        edPublic: impostorKeys.edPublic,
        xPublic: impostorKeys.xPublic,
      },
    ],
  })
  try {
    await a.start()
    await pinned.start()
    await assert.rejects(
      pinned.connect(identityA.deviceId, { host: '127.0.0.1', port: a.directAddress.port }),
      /cannot reach/,
    )
  } finally {
    await a.close()
    await pinned.close()
  }
})

test('relay v2: two devices behind relay exchange encrypted RPC', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const relay = createRelayServer({ host: '127.0.0.1', fleets: { [fleet.fleetId]: fleet.fleetKey } })
  let spliced = 0
  relay.on('spliced', () => {
    spliced += 1
  })
  const { port, dataPort } = await relay.ready
  const identityA = generateIdentity({ name: 'A' })
  const identityB = generateIdentity({ name: 'B' })
  const a = new FleetNode({
    identity: identityA,
    fleet,
    accountFingerprint: fingerprint,
    direct: false,
    relay: { host: '127.0.0.1', port, dataPort },
  })
  const b = new FleetNode({
    identity: identityB,
    fleet,
    accountFingerprint: fingerprint,
    direct: false,
    relay: { host: '127.0.0.1', port, dataPort },
  })
  a.onRequest(echoServer('A-via-relay'))
  try {
    await a.start()
    await b.start()
    const result = await b.request(identityA.deviceId, 'echo', { path: '/tmp/doc.md' })
    assert.deepEqual(result, { from: 'A-via-relay', params: { path: '/tmp/doc.md' } })
    assert.ok(spliced >= 1, 'relay should splice at least one data path')
  } finally {
    await a.close()
    await b.close()
    await relay.close()
  }
})

test('relay v2: multiple relays fail over to the reachable one', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const relay = createRelayServer({ host: '127.0.0.1', fleets: { [fleet.fleetId]: fleet.fleetKey } })
  let spliced = 0
  relay.on('spliced', () => { spliced += 1 })
  const { port, dataPort } = await relay.ready
  const dead = { host: '127.0.0.1', port: 1, dataPort: 2 }
  const live = { host: '127.0.0.1', port, dataPort }
  const a = new FleetNode({
    identity: generateIdentity({ name: 'A-multi-relay' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: false,
    relays: [dead, live],
  })
  const b = new FleetNode({
    identity: generateIdentity({ name: 'B-multi-relay' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: false,
    relays: [live],
  })
  a.onRequest(echoServer('A-via-failover-relay'))
  try {
    await a.start()
    await b.start()
    const result = await b.request(a.identity.deviceId, 'echo', { path: '/tmp/multi.md' })
    assert.deepEqual(result, { from: 'A-via-failover-relay', params: { path: '/tmp/multi.md' } })
    assert.equal(a.status().relay.endpoints, 2)
    assert.ok(a.status().relay.onlineCount >= 1)
    assert.ok(spliced >= 1)
  } finally {
    await a.close()
    await b.close()
    await relay.close()
  }
})

test('advertised relay candidates never include client certificate/private key', () => {
  const node = new FleetNode({
    identity: generateIdentity({ name: 'relay-tls-advertiser' }),
    fleet: createFleet(),
    direct: false,
    relay: {
      host: '127.0.0.1',
      port: 65400,
      dataPort: 65401,
      tls: { cert: 'CLIENT-CERT-PEM', key: 'CLIENT-KEY-PEM', ca: 'CA-PEM', servername: 'relay.test' },
    },
  })
  const candidate = node.relayCandidateList()[0]
  assert.equal(candidate.tls.ca, 'CA-PEM')
  assert.equal(candidate.tls.servername, 'relay.test')
  assert.equal('cert' in candidate.tls, false)
  assert.equal('key' in candidate.tls, false)
  node.close?.()
})

test('relay candidates are advertised during handshake and learned by peers', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const relay = createRelayServer({ host: '127.0.0.1', fleets: { [fleet.fleetId]: fleet.fleetKey } })
  const { port, dataPort } = await relay.ready
  const live = { host: '127.0.0.1', port, dataPort }
  const extra = { host: '127.0.0.1', port: 1, dataPort: 2 }
  const a = new FleetNode({
    identity: generateIdentity({ name: 'A-advertise' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: false,
    relays: [live],
  })
  const b = new FleetNode({
    identity: generateIdentity({ name: 'B-advertise' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: false,
    relays: [live, extra],
  })
  a.onRequest(echoServer('A-advertise'))
  try {
    await a.start()
    await b.start()
    await b.request(a.identity.deviceId, 'echo', { path: '/tmp/advertise.md' })
    const learned = a.relayCandidateList()
    assert.ok(learned.some((candidate) => candidate.host === '127.0.0.1' && candidate.port === 1 && candidate.dataPort === 2))
    assert.ok(a.status().relay.candidates >= 2)
  } finally {
    await a.close()
    await b.close()
    await relay.close()
  }
})

test('relay TLS: both control and data planes work and plain clients are rejected', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const cert = tlsFixture('relay-cert.pem')
  const key = tlsFixture('relay-key.pem')
  const relay = createRelayServer({
    host: '127.0.0.1',
    fleets: { [fleet.fleetId]: fleet.fleetKey },
    tls: { cert, key },
  })
  let spliced = 0
  relay.on('spliced', () => {
    spliced += 1
  })
  const { port, dataPort } = await relay.ready
  assert.equal(relay.state.secure, true)
  const relayTls = { ca: cert, servername: 'localhost' }
  const a = new FleetNode({
    identity: generateIdentity({ name: 'A-tls' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: false,
    relay: { host: '127.0.0.1', port, dataPort, tls: relayTls },
  })
  const b = new FleetNode({
    identity: generateIdentity({ name: 'B-tls' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: false,
    relay: { host: '127.0.0.1', port, dataPort, tls: relayTls },
  })
  a.onRequest(echoServer('A-via-tls'))
  const plain = new RelayClient({
    host: '127.0.0.1',
    port,
    dataPort,
    fleetId: fleet.fleetId,
    deviceId: 'plain-client',
    fleetKey: fleet.fleetKey,
  })
  try {
    await a.start()
    await b.start()
    assert.equal(b.status().relay.list[0].tls.hasCa, true)
    const result = await b.request(a.identity.deviceId, 'echo', { secure: true })
    assert.deepEqual(result, { from: 'A-via-tls', params: { secure: true } })
    assert.ok(spliced >= 1)
    await assert.rejects(plain.start(1_200))
  } finally {
    plain.close()
    await a.close()
    await b.close()
    await relay.close()
  }
})

test('relay candidates expire, keep configured entries and sort online first', () => {
  const fleet = createFleet()
  const node = new FleetNode({
    identity: generateIdentity({ name: 'candidates' }),
    fleet,
    direct: false,
    relayCandidateTtlMs: 1_000,
  })
  node.relayCandidates.set('peer:1', {
    host: '10.0.0.1',
    port: 1,
    dataPort: 2,
    source: 'peer',
    learnedAt: Date.now() - 60_000,
  })
  node.relayCandidates.set('peer:2', {
    host: '10.0.0.3',
    port: 3,
    dataPort: 4,
    source: 'peer',
    learnedAt: Date.now(),
  })
  node.relayCandidates.set('config:1', {
    host: '10.0.0.2',
    port: 5,
    dataPort: 6,
    source: 'config',
    persistent: true,
    learnedAt: 0,
  })
  const removed = node.pruneRelayCandidates(Date.now())
  assert.deepEqual(removed, ['peer:1'])
  assert.equal(node.relayCandidates.has('config:1'), true)
  assert.equal(node.relayCandidates.has('peer:2'), true)

  const before = node.status().relay.list
  assert.equal(before.length, 2)
  assert.equal(before[0].persistent, true)
  assert.equal(before[0].source, 'config')

  // An online client is promoted to the front of the list.
  node.relayClients.push({ host: '10.0.0.3', port: 3, dataPort: 4, online: true, failures: 0, lastError: null, lastReadyAt: Date.now() })
  const after = node.status().relay.list
  assert.equal(after[0].host, '10.0.0.3')
  assert.equal(after[0].online, true)
  assert.equal(after[0].ageMs >= 0, true)
})

test('relay mTLS: the relay requires a client certificate', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const ca = tlsFixture('relay-cert.pem')
  const cert = tlsFixture('relay-cert.pem')
  const key = tlsFixture('relay-key.pem')
  const clientCert = tlsFixture('client-cert.pem')
  const clientKey = tlsFixture('client-key.pem')
  const relay = createRelayServer({
    host: '127.0.0.1',
    fleets: { [fleet.fleetId]: fleet.fleetKey },
    tls: { cert, key, ca, requestCert: true, rejectUnauthorized: true },
  })
  const { port, dataPort } = await relay.ready
  const deviceTls = { ca, servername: 'localhost', cert: clientCert, key: clientKey }
  const a = new FleetNode({
    identity: generateIdentity({ name: 'mtls-a' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: false,
    relay: { host: '127.0.0.1', port, dataPort, tls: deviceTls },
  })
  const b = new FleetNode({
    identity: generateIdentity({ name: 'mtls-b' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: false,
    relay: { host: '127.0.0.1', port, dataPort, tls: deviceTls },
  })
  const withoutCert = new RelayClient({
    host: '127.0.0.1',
    port,
    dataPort,
    fleetId: fleet.fleetId,
    deviceId: 'no-cert',
    fleetKey: fleet.fleetKey,
    tls: { ca, servername: 'localhost' },
  })
  a.onRequest(echoServer('mtls'))
  try {
    await a.start()
    await b.start()
    const result = await b.request(a.identity.deviceId, 'echo', { mtls: true })
    assert.deepEqual(result, { from: 'mtls', params: { mtls: true } })
    await assert.rejects(withoutCert.start(1_200))
  } finally {
    withoutCert.close()
    await a.close()
    await b.close()
    await relay.close()
  }
})

test('relay TLS: server certificate material can be reloaded without a listener restart', async () => {
  const fleet = createFleet()
  const ca = tlsFixture('relay-cert.pem')
  const cert = tlsFixture('relay-cert.pem')
  const key = tlsFixture('relay-key.pem')
  const relay = createRelayServer({
    host: '127.0.0.1',
    fleets: { [fleet.fleetId]: fleet.fleetKey },
    tls: { cert, key, ca, requestCert: true, rejectUnauthorized: true },
  })
  await relay.ready
  try {
    const result = relay.reloadTls({ cert, key, ca, requestCert: true, rejectUnauthorized: true })
    assert.equal(result.secure, true)
    assert.equal(typeof result.tlsRotatedAt, 'number')
    assert.equal(relay.state.tlsRotatedAt, result.tlsRotatedAt)
  } finally {
    await relay.close()
  }
})

test('relay mTLS: client-certificate allowlist rejects a revoked fingerprint', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const ca = tlsFixture('relay-cert.pem')
  const cert = tlsFixture('relay-cert.pem')
  const key = tlsFixture('relay-key.pem')
  const clientCert = tlsFixture('client-cert.pem')
  const clientKey = tlsFixture('client-key.pem')
  const clientFingerprint = new X509Certificate(clientCert).fingerprint256.replace(/[^a-f0-9]/gi, '').toLowerCase()
  const allowed = [clientFingerprint]
  const relay = createRelayServer({
    host: '127.0.0.1',
    fleets: { [fleet.fleetId]: fleet.fleetKey },
    tls: { cert, key, ca, requestCert: true, rejectUnauthorized: true, allowedClientFingerprints: allowed },
  })
  const { port, dataPort } = await relay.ready
  const deviceTls = { ca, servername: 'localhost', cert: clientCert, key: clientKey }
  const a = new FleetNode({
    identity: generateIdentity({ name: 'allow-a' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: false,
    relay: { host: '127.0.0.1', port, dataPort, tls: deviceTls },
  })
  const b = new FleetNode({
    identity: generateIdentity({ name: 'allow-b' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: false,
    relay: { host: '127.0.0.1', port, dataPort, tls: deviceTls },
  })
  a.onRequest(echoServer('allowlist'))
  try {
    await a.start()
    await b.start()
    assert.deepEqual(await b.request(a.identity.deviceId, 'echo', { allowlist: true }), { from: 'allowlist', params: { allowlist: true } })
    allowed.length = 0
    const revoked = new RelayClient({
      host: '127.0.0.1',
      port,
      dataPort,
      fleetId: fleet.fleetId,
      deviceId: 'revoked-client',
      fleetKey: fleet.fleetKey,
      tls: deviceTls,
    })
    try {
      await assert.rejects(revoked.start(1_200))
    } finally {
      revoked.close()
    }
  } finally {
    await a.close()
    await b.close()
    await relay.close()
  }
})

test('relay latency probe measures control-plane RTT', async () => {
  const fleet = createFleet()
  const relay = createRelayServer({ host: '127.0.0.1', fleets: { [fleet.fleetId]: fleet.fleetKey } })
  const { port, dataPort } = await relay.ready
  const client = new RelayClient({
    host: '127.0.0.1',
    port,
    dataPort,
    fleetId: fleet.fleetId,
    deviceId: 'latency-probe',
    fleetKey: fleet.fleetKey,
  })
  try {
    await client.start()
    assert.equal(client.probe(), true)
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.ok(Number.isFinite(client.latencyMs))
    assert.ok(client.latencyMs >= 0)
  } finally {
    client.close()
    await relay.close()
  }
})

test('relay rejects a client that does not know the fleet key', async () => {
  const fleet = createFleet()
  const relay = createRelayServer({ host: '127.0.0.1', fleets: { [fleet.fleetId]: fleet.fleetKey } })
  const { port, dataPort } = await relay.ready
  const client = new RelayClient({
    host: '127.0.0.1',
    port,
    dataPort,
    fleetId: fleet.fleetId,
    deviceId: 'intruder',
    fleetKey: createFleet().fleetKey,
  })
  try {
    await assert.rejects(client.start(1_500), /timed out/)
  } finally {
    client.close()
    await relay.close()
  }
})

test('LAN discovery finds a peer (best effort)', async (t) => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const identityA = generateIdentity({ name: 'A' })
  const identityB = generateIdentity({ name: 'B' })
  const a = new FleetNode({
    identity: identityA,
    fleet,
    accountFingerprint: fingerprint,
    // Discovery reports the packet source address, so the direct listener must
    // accept connections on the machine's real interfaces rather than loopback.
    direct: { host: '0.0.0.0', port: 0 },
    discovery: true,
  })
  const b = new FleetNode({
    identity: identityB,
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '0.0.0.0', port: 0 },
    discovery: true,
  })
  a.onRequest(echoServer('A-discovered'))
  b.onRequest(echoServer('B'))
  try {
    await a.start()
    await b.start()
    let discovered = null
    try {
      discovered = await once(a, 'discovered', 4_000)
    } catch {
      t.skip('UDP multicast unavailable on this machine; discovery is best-effort in v1')
      return
    }
    assert.equal(discovered.deviceId, identityB.deviceId)
    const result = await a.request(identityB.deviceId, 'echo', { via: 'discovery' })
    assert.equal(result.from, 'B')
    assert.deepEqual(result.params, { via: 'discovery' })
  } finally {
    await a.close()
    await b.close()
  }
})

test('rotation records form a verifiable hash chain', () => {
  const identity = generateIdentity({ name: 'chain-device' })
  const second = rotateIdentityKeys(identity)
  const first = createRotationRecord(identity, second)
  const third = rotateIdentityKeys(second)
  const next = createRotationRecord(second, third, { previous: first })
  assert.equal(first.seq, 0)
  assert.equal(next.seq, 1)
  assert.equal(verifyRotationChain({ deviceId: identity.deviceId, edPublic: identity.edPublic }, [first, next]).edPublic, third.edPublic)
  assert.equal(verifyRotationChain({ deviceId: identity.deviceId, edPublic: identity.edPublic }, [next, first]), null)
  assert.equal(verifyRotationChain({ deviceId: identity.deviceId, edPublic: identity.edPublic }, [{ ...first, prevHash: 'tampered' }]), null)
})

test('device key rotation keeps deviceId and is authorized by the old key', () => {
  const identity = generateIdentity({ name: 'rotating-device' })
  const next = rotateIdentityKeys(identity)
  assert.equal(next.deviceId, identity.deviceId)
  assert.notEqual(next.edPublic, identity.edPublic)
  const record = createRotationRecord(identity, next)
  assert.equal(verifyRotationRecord(record, identity.edPublic), true)
  assert.equal(verifyRotationRecord({ ...record, newEdPublic: 'tampered' }, identity.edPublic), false)
  const updated = applyRotationRecord({ deviceId: identity.deviceId, edPublic: identity.edPublic, xPublic: identity.xPublic }, record)
  assert.equal(updated.deviceId, identity.deviceId)
  assert.equal(updated.edPublic, next.edPublic)
  assert.equal(updated.xPublic, next.xPublic)
  assert.equal(applyRotationRecord({ deviceId: identity.deviceId, edPublic: 'other-key' }, record), null)
})

test('FleetNode applies a verified rotation to the pinned roster entry', () => {
  const fleet = createFleet()
  const oldIdentity = generateIdentity({ name: 'old-key-device' })
  const nextIdentity = rotateIdentityKeys(oldIdentity)
  const record = createRotationRecord(oldIdentity, nextIdentity)
  const node = new FleetNode({
    identity: generateIdentity({ name: 'observer' }),
    fleet,
    direct: false,
    roster: [{ deviceId: oldIdentity.deviceId, edPublic: oldIdentity.edPublic, xPublic: oldIdentity.xPublic }],
  })
  assert.equal(node.applyRotation(record), true)
  assert.equal(node.roster.get(oldIdentity.deviceId).edPublic, nextIdentity.edPublic)
  assert.equal(node.applyRotation({ ...record, newEdPublic: 'tampered' }), false)
})

test('offline peer catches up a rotation chain during handshake', async () => {
  const fleet = createFleet()
  const oldA = generateIdentity({ name: 'A-old' })
  const newA = rotateIdentityKeys(oldA)
  const record = createRotationRecord(oldA, newA)
  const a = new FleetNode({
    identity: newA,
    fleet,
    rotationChain: [record],
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
    roster: [],
  })
  const b = new FleetNode({
    identity: generateIdentity({ name: 'B' }),
    fleet,
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
    roster: [{ deviceId: oldA.deviceId, edPublic: oldA.edPublic, xPublic: oldA.xPublic }],
  })
  try {
    await a.start()
    await b.start()
    await b.connectAddress(a.directAddress.host, a.directAddress.port)
    const pinned = b.roster.get(oldA.deviceId)
    assert.equal(pinned.edPublic, newA.edPublic)
    assert.equal(pinned.rotationSeq, 0)
  } finally {
    await a.close()
    await b.close()
  }
})

test('unbound creator binds the peer account fingerprint before the ack', async () => {
  const fleet = createFleet()
  const a = new FleetNode({
    identity: generateIdentity({ name: 'A-unbound' }),
    fleet,
    accountFingerprint: null,
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
  })
  const b = new FleetNode({
    identity: generateIdentity({ name: 'B-bound' }),
    fleet,
    accountFingerprint: 'afqo-test-fingerprint',
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
  })
  a.onRequest(echoServer('A-unbound'))
  try {
    await a.start()
    await b.start()
    const peer = await b.connectAddress(a.directAddress.host, a.directAddress.port)
    assert.equal(peer.deviceId, a.identity.deviceId)
    assert.equal(a.accountFingerprint, 'afqo-test-fingerprint')
  } finally {
    await a.close()
    await b.close()
  }
})

test('harness prerelease builds on the same release line are compatible', () => {
  assert.equal(harnessVersionsCompatible('0.2.2-rc.1', '0.2.2-rc.2'), true)
  assert.equal(harnessVersionsCompatible('0.2.2-rc.1', '0.2.2'), true)
  assert.equal(harnessVersionsCompatible('0.2.2-rc.1', '0.2.3-rc.1'), false)
  assert.equal(harnessVersionsCompatible('0.2.2-rc.1', '0.3.0-rc.1'), false)
  assert.equal(harnessVersionsCompatible('0.2.2-rc.1', 'not-a-version'), false)
})

test('direct transport works across DSH prerelease skew', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const a = new FleetNode({
    identity: generateIdentity({ name: 'A-rc1' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
    pluginVersion: '1.7.1',
    dshVersion: '0.2.2-rc.1',
  })
  const b = new FleetNode({
    identity: generateIdentity({ name: 'B-rc2' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
    pluginVersion: '1.7.1',
    dshVersion: '0.2.2-rc.2',
  })
  a.onRequest(echoServer('A-rc1'))
  try {
    await a.start()
    await b.start()
    const peer = await b.connectAddress(a.directAddress.host, a.directAddress.port)
    assert.equal(peer.deviceId, a.identity.deviceId)
    const result = await b.request(a.identity.deviceId, 'echo', { path: '/tmp/skew.md' })
    assert.deepEqual(result, { from: 'A-rc1', params: { path: '/tmp/skew.md' } })
  } finally {
    await a.close()
    await b.close()
  }
})

test('strict plugin version mismatch is rejected (ADR-0024)', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const identityA = generateIdentity({ name: 'A' })
  const a = new FleetNode({
    identity: identityA,
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
    pluginVersion: '0.1.0',
    dshVersion: '0.2.2-rc.1',
  })
  const b = new FleetNode({
    identity: generateIdentity({ name: 'B' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
    pluginVersion: '0.2.0',
    dshVersion: '0.2.2-rc.1',
  })
  try {
    await a.start()
    await b.start()
    await assert.rejects(b.connect(identityA.deviceId, { host: '127.0.0.1', port: a.directAddress.port }), /cannot reach/)
    assert.equal(a.roster.has(b.identity.deviceId), false)
  } finally {
    await a.close()
    await b.close()
  }
})

// ------------------------------------------------------- rotation chain core

function buildRotationChain(seed, count = 3) {
  let identity = seed
  const records = []
  for (let index = 0; index < count; index += 1) {
    const next = rotateIdentityKeys(identity)
    records.push(createRotationRecord(identity, next, { previous: records[records.length - 1] ?? null }))
    identity = next
  }
  return { records, finalIdentity: identity }
}

function buildRotationChainWithIdentities(seed, count = 3) {
  let identity = seed
  const records = []
  const identities = [seed]
  for (let index = 0; index < count; index += 1) {
    const next = rotateIdentityKeys(identity)
    records.push(createRotationRecord(identity, next, { previous: records[records.length - 1] ?? null }))
    identity = next
    identities.push(identity)
  }
  return { records, identities, finalIdentity: identity }
}

function pinnedEntry(identity, extra = {}) {
  return {
    deviceId: identity.deviceId,
    name: identity.name ?? 'device',
    edPublic: identity.edPublic,
    xPublic: identity.xPublic,
    addedAt: 1,
    ...extra,
  }
}

test('rotation chain applies forward and remembers the verified history', () => {
  const seed = generateIdentity({ name: 'chain-seed' })
  const { records, finalIdentity } = buildRotationChain(seed, 3)
  const result = applyRotationChain({ rosterEntry: pinnedEntry(seed), storedChain: null, records })
  assert.equal(result.status, 'applied')
  assert.equal(result.entry.edPublic, finalIdentity.edPublic)
  assert.equal(result.entry.xPublic, finalIdentity.xPublic)
  assert.equal(result.entry.rotationSeq, 2)
  assert.equal(result.entry.rotationHead, rotationRecordHash(records[2]))
  assert.equal(result.chain.records.length, 3)
  assert.equal(result.chain.genesisEdPublic, seed.edPublic)

  // Replaying the same chain is a no-op, not a fork.
  const replay = applyRotationChain({ rosterEntry: result.entry, storedChain: result.chain, records })
  assert.equal(replay.status, 'noop')
})

test('rotation chain reports the missing seq instead of guessing (gap)', () => {
  const seed = generateIdentity({ name: 'gap-seed' })
  const { records } = buildRotationChain(seed, 3)
  const result = applyRotationChain({ rosterEntry: pinnedEntry(seed), records: [records[2]] })
  assert.equal(result.status, 'gap')
  assert.deepEqual(result.need, { fromSeq: 0 })
})

test('same seq with a different hash is reported as a fork', () => {
  const seed = generateIdentity({ name: 'fork-seed' })
  const { records } = buildRotationChain(seed, 3)
  const applied = applyRotationChain({ rosterEntry: pinnedEntry(seed), records })
  assert.equal(applied.status, 'applied')
  // A competing first rotation: same seq 0, same old key, different new key.
  const branchKey = rotateIdentityKeys(seed)
  const sameSeq = createRotationRecord(seed, branchKey, { previous: null })
  const fork = applyRotationChain({ rosterEntry: applied.entry, storedChain: applied.chain, records: [sameSeq] })
  assert.equal(fork.status, 'fork')
  assert.equal(fork.fork.seq, 0)
  assert.equal(fork.fork.localHash, rotationRecordHash(records[0]))
  assert.equal(fork.fork.remoteHash, rotationRecordHash(sameSeq))
})

test('a branch that diverges before the head is reported as a fork', () => {
  const seed = generateIdentity({ name: 'diverge-seed' })
  const { records, identities } = buildRotationChainWithIdentities(seed, 3)
  const applied = applyRotationChain({ rosterEntry: pinnedEntry(seed), records })
  assert.equal(applied.status, 'applied')
  // Sibling at seq 2 (signed by the seq-1 key) plus its child at seq 3: the
  // child follows a head this device never accepted.
  const sibling = rotateIdentityKeys(identities[2])
  const siblingRecord = createRotationRecord(identities[2], sibling, { previous: records[1] })
  const child = rotateIdentityKeys(sibling)
  const childRecord = createRotationRecord(sibling, child, { previous: siblingRecord })
  const forked = applyRotationChain({ rosterEntry: applied.entry, storedChain: applied.chain, records: [childRecord] })
  assert.equal(forked.status, 'fork')
  assert.equal(forked.fork.seq, 2)
  assert.equal(forked.fork.localHash, rotationRecordHash(records[2]))
  assert.equal(forked.fork.remoteHash, rotationRecordHash(siblingRecord))
})

test('adopting the peer branch replaces the conflicting tail; keep-local clears the fork', () => {
  const seed = generateIdentity({ name: 'adopt-seed' })
  const { records, identities } = buildRotationChainWithIdentities(seed, 3)
  const applied = applyRotationChain({ rosterEntry: pinnedEntry(seed), records })
  assert.equal(applied.status, 'applied')

  // Peer branch: a sibling at seq 1, then its own child at seq 2.
  const sibling = rotateIdentityKeys(identities[1])
  const siblingRecord = createRotationRecord(identities[1], sibling, { previous: records[0] })
  const child = rotateIdentityKeys(sibling)
  const childRecord = createRotationRecord(sibling, child, { previous: siblingRecord })
  const marked = { ...applied.entry, rotationFork: { seq: 1, detectedAt: Date.now(), records: [siblingRecord, childRecord] } }

  const adopted = resolveRotationFork({
    rosterEntry: marked,
    storedChain: applied.chain,
    records: [siblingRecord, childRecord],
    action: 'adopt-peer',
  })
  assert.equal(adopted.status, 'adopted')
  assert.equal(adopted.entry.edPublic, child.edPublic)
  assert.equal(adopted.entry.rotationSeq, 2)
  assert.equal(adopted.entry.rotationFork, undefined)
  assert.equal(adopted.chain.records.length, 3)
  assert.equal(adopted.chain.records[0], records[0])
  assert.equal(adopted.chain.records[1], siblingRecord)

  const kept = resolveRotationFork({ rosterEntry: marked, storedChain: applied.chain, action: 'keep-local' })
  assert.equal(kept.status, 'kept')
  assert.equal(kept.entry.rotationFork, undefined)
  assert.equal(kept.entry.edPublic, applied.entry.edPublic)

  // A branch that does not connect to any verified local prefix is refused.
  const unrelated = buildRotationChainWithIdentities(generateIdentity({ name: 'unrelated' }), 1)
  const refused = resolveRotationFork({
    rosterEntry: marked,
    storedChain: applied.chain,
    records: unrelated.records,
    action: 'adopt-peer',
  })
  assert.ok(['invalid', 'fork-not-resolvable'].includes(refused.status))
})

test('M-of-N checkpoint certificate reaches threshold and is stored on trust', () => {
  const node = new FleetNode({ identity: generateIdentity({ name: 'local' }), fleet: createFleet(), direct: false })
  const target = generateIdentity({ name: 'target' })
  const a = generateIdentity({ name: 'signer-a' })
  const c = generateIdentity({ name: 'signer-c' })
  const checkpoint = createRotationCheckpoint(target, { seq: 0, head: 'head-0' })
  node.roster.set(target.deviceId, {
    deviceId: target.deviceId,
    name: 'target',
    edPublic: target.edPublic,
    xPublic: target.xPublic,
    rotationSeq: 0,
    rotationHead: 'head-0',
    rotationCheckpointOffer: {
      checkpoint,
      edPublic: target.edPublic,
      xPublic: target.xPublic,
      rotationSeq: 0,
      rotationHead: 'head-0',
    },
  })
  for (const signer of [a, c]) node.roster.set(signer.deviceId, { deviceId: signer.deviceId, edPublic: signer.edPublic })
  const signedTrust = (identity) => {
    const payload = { type: 'checkpoint-trust', trustedBy: identity.deviceId, deviceId: target.deviceId, seq: 0, head: 'head-0', at: 1_000 }
    return { ...payload, signature: sign(null, Buffer.from(stableStringify(payload), 'utf8'), importPrivateKey(identity.edPrivate)).toString('base64url') }
  }
  assert.equal(node.noteCheckpointTrust(signedTrust(a)), true)
  assert.equal(node.noteCheckpointTrust(signedTrust(c)), true)
  const trusted = node.trustRotationCheckpoint(target.deviceId, { threshold: 3 })
  assert.equal(trusted.status, 'trusted')
  assert.equal(trusted.certificate.count, 3)
  assert.equal(trusted.certificate.threshold, 3)
  assert.equal(trusted.certificate.signatures.length, 2)
  assert.equal(node.roster.get(target.deviceId).checkpointCertificate.count, 3)
  node.roster.set(c.deviceId, { ...node.roster.get(c.deviceId), revoked: true })
  assert.equal(node.checkpointCertificate(target.deviceId, 0, 'head-0', 3).count, 2)
  assert.equal(node.noteCheckpointTrust(signedTrust(c)), false)
})

test('rotation chain pages are bounded and report completeness', () => {
  const seed = generateIdentity({ name: 'page-seed' })
  const { records } = buildRotationChain(seed, 70)
  const first = rotationChainPage(records, { fromSeq: 0, limit: 64 })
  assert.equal(first.records.length, 64)
  assert.equal(first.complete, false)
  assert.equal(first.records[0].seq, 0)
  const second = rotationChainPage(records, { fromSeq: 64, limit: 64 })
  assert.equal(second.records.length, 6)
  assert.equal(second.complete, true)
  assert.equal(second.records[0].seq, 64)
  const huge = rotationChainPage(records, { fromSeq: 0, limit: 10_000 })
  assert.equal(huge.records.length, 64)
})

test('checkpoint confirmations require a valid device signature', () => {
  const node = new FleetNode({ identity: generateIdentity({ name: 'quorum-node' }), fleet: createFleet(), direct: false })
  const a = generateIdentity({ name: 'quorum-a' })
  const c = generateIdentity({ name: 'quorum-c' })
  node.roster.set(a.deviceId, { deviceId: a.deviceId, edPublic: a.edPublic })
  node.roster.set(c.deviceId, { deviceId: c.deviceId, edPublic: c.edPublic })
  const signedTrust = (identity) => {
    const payload = {
      type: 'checkpoint-trust',
      trustedBy: identity.deviceId,
      deviceId: 'device-b',
      seq: 4,
      head: 'head-4',
      at: 1_000,
    }
    return {
      ...payload,
      signature: sign(null, Buffer.from(stableStringify(payload), 'utf8'), importPrivateKey(identity.edPrivate)).toString('base64url'),
    }
  }
  assert.equal(node.noteCheckpointTrust(signedTrust(a)), true)
  assert.equal(node.noteCheckpointTrust(signedTrust(c)), true)
  assert.equal(node.noteCheckpointTrust(signedTrust(a)), true)
  assert.equal(node.checkpointEndorsements('device-b', 4), 2)
  assert.equal(node.checkpointEndorsements('device-b', 5), 0)
  const certificate = node.checkpointCertificate('device-b', 4, 'head-4', 3)
  assert.equal(certificate.count, 3)
  assert.equal(certificate.threshold, 3)
  assert.equal(certificate.signatures.length, 2)
  assert.equal(certificate.head, 'head-4')
  assert.equal(node.noteCheckpointTrust({ trust: 'unsigned' }), false)
  assert.equal(node.noteCheckpointTrust({ ...signedTrust(a), signature: 'invalid' }), false)
})

test('checkpoint signatures are refreshed with the current key for advertisement', () => {
  const identity = generateIdentity({ name: 'checkpoint-refresher' })
  const next = rotateIdentityKeys(identity)
  const checkpoint = createRotationCheckpoint(identity, { seq: 0, head: 'head-0' })
  assert.equal(verifyRotationCheckpoint(checkpoint, identity.edPublic), true)
  assert.equal(verifyRotationCheckpoint(checkpoint, next.edPublic), false)

  const refreshed = refreshRotationCheckpoint(next, checkpoint)
  assert.equal(refreshed.deviceId, identity.deviceId)
  assert.equal(refreshed.edPublic, next.edPublic)
  assert.equal(refreshed.seq, 0)
  assert.equal(refreshed.head, 'head-0')
  assert.equal(verifyRotationCheckpoint(refreshed, next.edPublic), true)

  // FleetNode refreshes a persisted checkpoint before advertising it, so a
  // checkpoint created before later rotations is still verifiable by peers.
  const node = new FleetNode({
    identity: next,
    fleet: createFleet(),
    direct: false,
    rotationCheckpoint: checkpoint,
  })
  assert.equal(verifyRotationCheckpoint(node.rotationCheckpoint, next.edPublic), true)
})

test('trusting a legacy checkpoint without head keys pins the peer current head', () => {
  const fleet = createFleet()
  const peerIdentity = generateIdentity({ name: 'legacy-peer' })
  const checkpoint = createRotationCheckpoint(peerIdentity, { seq: 0, head: 'legacy-head' })
  const observer = new FleetNode({
    identity: generateIdentity({ name: 'legacy-observer' }),
    fleet,
    direct: false,
    roster: [{
      deviceId: peerIdentity.deviceId,
      name: 'legacy-peer',
      edPublic: peerIdentity.edPublic,
      xPublic: peerIdentity.xPublic,
      rotationSeq: 0,
      rotationHead: 'legacy-head',
    }],
  })
  const peer = {
    deviceId: peerIdentity.deviceId,
    edPublic: peerIdentity.edPublic,
    xPublic: peerIdentity.xPublic,
    rotationSeq: 12,
    rotationHead: 'current-head',
  }
  assert.equal(observer.recordRotationCheckpointOffer(peer, checkpoint), true)
  const trusted = observer.trustRotationCheckpoint(peerIdentity.deviceId)
  assert.equal(trusted.status, 'trusted')
  const entry = observer.roster.get(peerIdentity.deviceId)
  assert.equal(entry.rotationSeq, 12)
  assert.equal(entry.rotationHead, 'current-head')
  assert.equal(entry.edPublic, peerIdentity.edPublic)
})

test('rotation checkpoint attests an archived prefix and is tamper-evident', () => {
  const identity = generateIdentity({ name: 'checkpoint-seed' })
  const { records } = buildRotationChain(identity, 2)
  const checkpoint = createRotationCheckpoint(identity, {
    seq: 1,
    head: rotationRecordHash(records[1]),
    archivedRecords: 2,
  })
  assert.equal(verifyRotationCheckpoint(checkpoint, identity.edPublic), true)
  assert.equal(verifyRotationCheckpoint({ ...checkpoint, head: 'tampered' }, identity.edPublic), false)
  assert.equal(verifyRotationCheckpoint(checkpoint, generateIdentity({ name: 'other' }).edPublic), false)
  assert.throws(() => createRotationCheckpoint(identity, { seq: -1, head: 'x' }), /non-negative/)
})

test('a pruned rotation history fails the handshake with rotation-history-pruned', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const seed = generateIdentity({ name: 'pruned-chain' })
  const { records, finalIdentity } = buildRotationChain(seed, 20)
  const makeNode = (options) =>
    new FleetNode({
      fleet,
      accountFingerprint: fingerprint,
      direct: { host: '127.0.0.1', port: 0 },
      discovery: false,
      ...options,
    })

  // The responder only keeps seq 18..19 while the initiator is pinned at seq 0.
  // The initiator detects the pruned window from the ack's rotationFrom.
  {
    const pruned = makeNode({ identity: finalIdentity, rotationChain: records.slice(18) })
    const pinned = makeNode({ identity: generateIdentity({ name: 'pinned-old' }), roster: [pinnedEntry(seed)] })
    const warnings = []
    pinned.on('warning', (error) => warnings.push(error))
    try {
      await pruned.start()
      await pinned.start()
      await assert.rejects(pinned.connectAddress('127.0.0.1', pruned.directAddress.port))
      assert.ok(warnings.some((error) => error.code === 'rotation-history-pruned'), JSON.stringify(warnings.map((error) => error.code)))
    } finally {
      await pruned.close()
      await pinned.close()
    }
  }

  // The initiator is pruned; the responder detects it from the advertised
  // rotationFrom before wasting pull rounds.
  {
    const pruned = makeNode({ identity: finalIdentity, rotationChain: records.slice(18) })
    const pinned = makeNode({ identity: generateIdentity({ name: 'pinned-old-2' }), roster: [pinnedEntry(seed)] })
    const warnings = []
    pinned.on('warning', (error) => warnings.push(error))
    pinned.onRequest(echoServer('pinned'))
    try {
      await pruned.start()
      await pinned.start()
      await assert.rejects(pruned.connectAddress('127.0.0.1', pinned.directAddress.port))
      assert.ok(warnings.some((error) => error.code === 'rotation-history-pruned'), JSON.stringify(warnings.map((error) => error.code)))
    } finally {
      await pruned.close()
      await pinned.close()
    }
  }
})

// ----------------------------------------------------------------- revocation

test('revocation: self-signed record is absolute, third-party record is advisory until confirmed', () => {
  const fleet = createFleet()
  const deviceA = generateIdentity({ name: 'A' })
  const deviceB = generateIdentity({ name: 'B' })
  const deviceC = generateIdentity({ name: 'C' })
  const target = pinnedEntry(deviceB, { rotationSeq: 4, rotationHead: 'head-4' })

  const selfRecord = createRevocationRecord(deviceB, { deviceId: deviceB.deviceId, revokedSeq: 4, revokedHead: 'head-4', reason: 'retiring' })
  assert.equal(verifyRevocationRecord(selfRecord), true)
  const absolute = applyRevocation(target, selfRecord)
  assert.equal(absolute.revokedAt, selfRecord.revokedAt)
  assert.equal(absolute.revocationSource, 'self')

  const thirdParty = createRevocationRecord(deviceC, { deviceId: deviceB.deviceId, revokedSeq: 4, reason: 'key leaked' })
  const advisory = applyRevocation(target, thirdParty, { revokerEdPublic: deviceC.edPublic })
  assert.equal(advisory.revokedAt, undefined)
  assert.equal(advisory.revocationPending.by, deviceC.deviceId)
  const confirmed = applyRevocation(target, thirdParty, { revokerEdPublic: deviceC.edPublic, confirmed: true })
  assert.equal(confirmed.revocationSource, 'confirmed')

  // A forged third-party record (wrong asserting key) is rejected.
  assert.equal(applyRevocation(target, thirdParty, { revokerEdPublic: deviceA.edPublic }), null)
  assert.equal(applyRevocation(target, { ...thirdParty, reason: 'tampered' }, { revokerEdPublic: deviceC.edPublic, confirmed: true }), null)
  // A third-party record can never claim to be a self-revocation: the signature
  // is bound to the asserting key and the entry's own key must sign it.
  assert.equal(applyRevocation(target, { ...selfRecord, revokerEdPublic: deviceC.edPublic }), null)
  // Without an attributed revoker the record stays advisory at this layer; the
  // FleetNode layer refuses unknown revokers.
  const unattributed = applyRevocation(target, thirdParty)
  assert.equal(unattributed.revocationPending.by, deviceC.deviceId)
  // Unknown devices return no entry update.
  assert.equal(applyRevocation(pinnedEntry(deviceA), thirdParty), null)
})

test('revocation cannot be undone by a rotation or by TOFU re-pinning', async () => {
  const fleet = createFleet()
  const seed = generateIdentity({ name: 'revoked-seed' })
  const { records } = buildRotationChain(seed, 1)
  const revoked = {
    ...pinnedEntry(seed),
    revokedAt: Date.now(),
    revokedBy: seed.deviceId,
    revocationSource: 'self',
  }
  const result = applyRotationChain({ rosterEntry: revoked, records })
  assert.equal(result.status, 'revoked')

  const node = new FleetNode({
    identity: generateIdentity({ name: 'observer' }),
    fleet,
    direct: false,
    roster: [revoked],
  })
  await assert.rejects(
    node.authorizePeer({ deviceId: seed.deviceId, edPublic: seed.edPublic, xPublic: seed.xPublic }),
    /revoked/,
  )
})

test('revocation blocks the handshake and keeps the tombstone', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const a = new FleetNode({
    identity: generateIdentity({ name: 'A-revoke' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
  })
  const b = new FleetNode({
    identity: generateIdentity({ name: 'B-revoke' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
  })
  a.onRequest(echoServer('A-revoke'))
  try {
    await a.start()
    await b.start()
    await b.connectAddress('127.0.0.1', a.directAddress.port)
    const record = createRevocationRecord(a.identity, {
      deviceId: b.identity.deviceId,
      revokedSeq: 0,
      reason: 'unit test',
    })
    const applied = a.applyRevocation(record, { confirmed: true, source: 'local' })
    assert.equal(applied.status, 'revoked')
    assert.ok(a.roster.get(b.identity.deviceId).revokedAt > 0)
    await assert.rejects(b.connectAddress('127.0.0.1', a.directAddress.port))
    // The tombstone survives and keeps reporting the revocation.
    assert.equal(a.roster.get(b.identity.deviceId).revocationReason, 'unit test')
    assert.equal(a.status().roster[0].revoked, true)
  } finally {
    await a.close()
    await b.close()
  }
})

// ------------------------------------------------------- paged chain catch-up

test('long rotation chains are paged during the handshake in both directions', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const seed = generateIdentity({ name: 'long-chain' })
  const { records, finalIdentity } = buildRotationChain(seed, 20)
  const makeNode = (options) =>
    new FleetNode({
      fleet,
      accountFingerprint: fingerprint,
      direct: { host: '127.0.0.1', port: 0 },
      discovery: false,
      ...options,
    })

  // Direction 1: the peer with the long chain is the responder; its ack carries
  // inline records plus paged chunks.
  {
    const long = makeNode({ identity: finalIdentity, rotationChain: records })
    const behind = makeNode({ identity: generateIdentity({ name: 'behind-1' }), roster: [pinnedEntry(seed)] })
    long.onRequest(echoServer('long'))
    try {
      await long.start()
      await behind.start()
      await behind.connectAddress('127.0.0.1', long.directAddress.port)
      const pinned = behind.roster.get(seed.deviceId)
      assert.equal(pinned.rotationSeq, 19)
      assert.equal(pinned.edPublic, finalIdentity.edPublic)
      assert.equal(behind.peerRotations.get(seed.deviceId).records.length, 20)
    } finally {
      await long.close()
      await behind.close()
    }
  }

  // Direction 2: the long chain is on the initiator; the responder must pull
  // the pages it did not receive inline.
  {
    const long = makeNode({ identity: finalIdentity, rotationChain: records })
    const behind = makeNode({ identity: generateIdentity({ name: 'behind-2' }), roster: [pinnedEntry(seed)] })
    behind.onRequest(echoServer('behind'))
    try {
      await long.start()
      await behind.start()
      await long.connectAddress('127.0.0.1', behind.directAddress.port)
      const pinned = behind.roster.get(seed.deviceId)
      assert.equal(pinned.rotationSeq, 19)
      assert.equal(pinned.edPublic, finalIdentity.edPublic)
    } finally {
      await long.close()
      await behind.close()
    }
  }
})

test('a peer pinned at the responder head is not treated as pruned when its own chain is empty', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const seed = generateIdentity({ name: 'reset-chain' })
  const { records, finalIdentity } = buildRotationChain(seed, 20)
  // The responder pruned seq 0..17 but the initiator already pins its seq-19 key
  // (e.g. it was reset, so its own chain is empty). This must connect: the
  // sender-side check must not mistake "peer has no own chain" for "peer is
  // pinned below our retained window".
  const responder = new FleetNode({
    identity: finalIdentity,
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
    rotationChain: records.slice(18),
  })
  const resetPeer = new FleetNode({
    identity: generateIdentity({ name: 'reset-peer' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
    roster: [{
      deviceId: finalIdentity.deviceId,
      name: 'reset-chain',
      edPublic: finalIdentity.edPublic,
      xPublic: finalIdentity.xPublic,
      rotationSeq: 19,
      rotationHead: rotationRecordHash(records[19]),
    }],
  })
  responder.onRequest(echoServer('pruned-responder'))
  try {
    await responder.start()
    await resetPeer.start()
    const peer = await resetPeer.connectAddress('127.0.0.1', responder.directAddress.port)
    assert.equal(peer.deviceId, finalIdentity.deviceId)
    const result = await resetPeer.request(finalIdentity.deviceId, 'echo', { afterReset: true })
    assert.deepEqual(result, { from: 'pruned-responder', params: { afterReset: true } })
  } finally {
    await responder.close()
    await resetPeer.close()
  }
})

test('a pruned chain still admits a fresh (unpinned) peer', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const seed = generateIdentity({ name: 'fresh-chain' })
  const { records, finalIdentity } = buildRotationChain(seed, 20)
  const responder = new FleetNode({
    identity: finalIdentity,
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
    rotationChain: records.slice(18),
  })
  const fresh = new FleetNode({
    identity: generateIdentity({ name: 'fresh-peer' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
  })
  responder.onRequest(echoServer('fresh-responder'))
  try {
    await responder.start()
    await fresh.start()
    await fresh.connectAddress('127.0.0.1', responder.directAddress.port)
    assert.equal(fresh.roster.get(finalIdentity.deviceId).edPublic, finalIdentity.edPublic)
    const result = await fresh.request(finalIdentity.deviceId, 'echo', { fresh: true })
    assert.deepEqual(result, { from: 'fresh-responder', params: { fresh: true } })
  } finally {
    await responder.close()
    await fresh.close()
  }
})

test('a pruned peer can offer a checkpoint that the user explicitly trusts', async () => {
  const fleet = createFleet()
  const fingerprint = accountFingerprint(fleet.fleetKey, 'user-1')
  const seed = generateIdentity({ name: 'checkpoint-peer' })
  const { records, finalIdentity } = buildRotationChain(seed, 20)
  const checkpoint = createRotationCheckpoint(finalIdentity, {
    seq: 17,
    head: rotationRecordHash(records[17]),
    headEdPublic: records[17].newEdPublic,
    headXPublic: records[17].newXPublic,
    archivedRecords: 18,
  })
  const responder = new FleetNode({
    identity: finalIdentity,
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
    rotationChain: records.slice(18),
    rotationCheckpoint: checkpoint,
  })
  const pinned = new FleetNode({
    identity: generateIdentity({ name: 'checkpoint-observer' }),
    fleet,
    accountFingerprint: fingerprint,
    direct: { host: '127.0.0.1', port: 0 },
    discovery: false,
    roster: [pinnedEntry(seed)],
  })
  const warnings = []
  pinned.on('warning', (error) => warnings.push(error))
  responder.onRequest(echoServer('checkpoint'))
  try {
    await responder.start()
    await pinned.start()
    await assert.rejects(pinned.connectAddress('127.0.0.1', responder.directAddress.port))
    assert.ok(warnings.some((error) => error.code === 'rotation-checkpoint-required'), JSON.stringify(warnings.map((error) => error.code)))
    const offer = pinned.roster.get(finalIdentity.deviceId).rotationCheckpointOffer
    assert.ok(offer)
    assert.equal(offer.checkpoint.seq, 17)

    const trusted = pinned.trustRotationCheckpoint(finalIdentity.deviceId)
    assert.equal(trusted.status, 'trusted')
    assert.equal(pinned.roster.get(finalIdentity.deviceId).rotationSeq, 17)

    await pinned.connectAddress('127.0.0.1', responder.directAddress.port)
    assert.equal(pinned.roster.get(finalIdentity.deviceId).edPublic, finalIdentity.edPublic)
    assert.equal(pinned.roster.get(finalIdentity.deviceId).rotationSeq, 19)
    const result = await pinned.request(finalIdentity.deviceId, 'echo', { trusted: true })
    assert.deepEqual(result, { from: 'checkpoint', params: { trusted: true } })
  } finally {
    await responder.close()
    await pinned.close()
  }
})

test('FleetNode records a fork instead of accepting a different head at the same seq', async () => {
  const fleet = createFleet()
  const seed = generateIdentity({ name: 'fork-node' })
  const { records, finalIdentity } = buildRotationChain(seed, 3)
  const node = new FleetNode({
    identity: generateIdentity({ name: 'fork-observer' }),
    fleet,
    direct: false,
    roster: [pinnedEntry(seed, { rotationSeq: 2, rotationHead: rotationRecordHash(records[2]), edPublic: finalIdentity.edPublic, xPublic: finalIdentity.xPublic })],
    peerRotations: {
      [seed.deviceId]: {
        genesisEdPublic: seed.edPublic,
        genesisXPublic: seed.xPublic,
        records,
      },
    },
  })
  const peer = { deviceId: seed.deviceId, edPublic: seed.edPublic, xPublic: seed.xPublic, rotationSeq: 2, rotationHead: 'different-head' }
  const result = await node.applyPeerRotations(peer, [])
  assert.equal(result.status, 'fork')
  assert.ok(node.roster.get(seed.deviceId).rotationFork)
  assert.equal(node.roster.get(seed.deviceId).rotationFork.seq, 2)

  const kept = node.resolveFork(seed.deviceId, 'keep-local')
  assert.equal(kept.status, 'kept')
  assert.equal(node.roster.get(seed.deviceId).rotationFork, undefined)
  assert.equal(node.roster.get(seed.deviceId).edPublic, finalIdentity.edPublic)

  // Same key but a different advertised head is still a divergent chain.
  const sameKeyNode = new FleetNode({
    identity: generateIdentity({ name: 'head-observer' }),
    fleet,
    direct: false,
    roster: [{
      ...pinnedEntry(seed),
      edPublic: finalIdentity.edPublic,
      xPublic: finalIdentity.xPublic,
      rotationSeq: 2,
      rotationHead: rotationRecordHash(records[2]),
    }],
    peerRotations: {
      [seed.deviceId]: { genesisEdPublic: seed.edPublic, genesisXPublic: seed.xPublic, records },
    },
  })
  const sameKeyFork = await sameKeyNode.applyPeerRotations({
    deviceId: seed.deviceId,
    edPublic: finalIdentity.edPublic,
    xPublic: finalIdentity.xPublic,
    rotationSeq: 2,
    rotationHead: 'another-head',
  }, [])
  assert.equal(sameKeyFork.status, 'fork')
})

