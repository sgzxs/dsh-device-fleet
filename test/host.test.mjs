import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { accountFingerprint, createFleet, generateIdentity } from '../src/net/identity.js'
import { createRevocationRecord, createRotationRecord, rotateIdentityKeys, rotationRecordHash, verifyRotationCheckpoint } from '../src/net/rotation.js'
import { accountMatches, compactRotationChain, createInvite, enrollFromInvite, isKnownDevice, loadIssuedInvites, loadKnownDevices, loadPeerRotations, loadRotationState, loadState, redeemIssuedInvite, rememberKnownDevice, resetDeviceIdentity, saveIssuedInvites, savePeerHint, savePeerRotations, saveRoster, saveRotationState, writePendingEnrollment } from '../src/host/store.js'
import { existsSync } from 'node:fs'
import { ToolPolicy, pathWithinRoots } from '../src/host/tool-policy.js'
import { ExecutionSlot } from '../src/host/execution-slot.js'
import { createLazyExecutionHost } from '../src/host/lazy-execution-host.js'
import { DelegationHost } from '../src/host/delegation.js'
import { ApprovalInbox } from '../src/host/approval-inbox.js'
import { ScopeRevocationQueue } from '../src/host/pending-revocations.js'
import { CallLedger } from '../src/host/call-ledger.js'
import { Outbox } from '../src/host/outbox.js'
import { TrajectoryStore } from '../src/host/trajectory.js'
import { isUnsafeBrowserRequest } from '../src/host/http-guard.js'
import { RoomService } from '../src/host/room-service.js'
import { RoomReplicaStore } from '../src/host/room-replica.js'
import { friendlyName } from '../src/host/human-names.js'
import { RoomReplicaSync } from '../src/host/room-sync.js'
import { signRoster, verifyRoster } from '../src/host/roster-signing.js'
import { remapReplicaEventsForSync } from '../src/host/sync-remap.js'
import { RemoteRoomBridge } from '../src/host/remote-room.js'
import { RemoteRoomPeer } from '../src/host/remote-room-peer.js'
import { signRoomEvent, verifyRoomEvent, signJsonValue, verifyJsonValue } from '../src/host/room-signing.js'
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { createApprovalApi, registerApprovalRoutes } from '../src/host/approval-web.js'
import { registerUiRoutes } from '../src/host/ui-web.js'
import { NotificationCenter } from '../src/host/notifications.js'
import { registerAvatarRoutes } from '../src/host/avatar-web.js'
import { registerConfigRoutes } from '../src/host/config-web.js'
import { RuntimeConfig, sanitizeConfigPatch } from '../src/host/runtime-config.js'
import { DirectCallHost, DirectCallClient } from '../src/host/direct-call.js'
import { createFleetHandlers, createFleetToolDefinitions, textOutput } from '../src/host/tools.js'
import { deleteTransferPath, listTransferTree, readTransferChunk, sha256File, statTransferPath, writeTransferChunk } from '../src/host/file-transfer.js'

const TMP_ROOT = path.join(process.cwd(), 'test', '.tmp')
function tempDir() {
  fs.mkdirSync(TMP_ROOT, { recursive: true })
  return fs.mkdtempSync(path.join(TMP_ROOT, 'case-'))
}
process.on('exit', () => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

test('store: identity/fleet persist, invite enrollment binds the fleet and account', () => {
  const homeA = tempDir()
  const a = loadState({ dshHome: homeA, name: 'desktop' })
  assert.equal(a.identity.name, 'desktop')
  assert.ok(a.fleet.fleetId)
  assert.equal(a.createdFleet, true)

  const reloaded = loadState({ dshHome: homeA, name: 'desktop' })
  assert.equal(reloaded.identity.deviceId, a.identity.deviceId)
  assert.equal(reloaded.fleet.fleetId, a.fleet.fleetId)

  const fingerprint = accountFingerprint(a.fleet.fleetKey, 'account-user')
  const invite = createInvite(a, {
    accountFingerprint: fingerprint,
    endpoints: [{ deviceId: a.identity.deviceId, host: '192.168.137.1', port: 61318 }],
    creator: {
      deviceId: a.identity.deviceId,
      name: 'desktop',
      edPublic: a.identity.edPublic,
      xPublic: a.identity.xPublic,
      rotationSeq: 1,
      rotationHead: 'creator-head',
    },
    roster: [{
      deviceId: 'device-c',
      name: 'laptop-c',
      edPublic: 'c-ed',
      xPublic: 'c-x',
    }],
    rotations: [{
      v: 1,
      type: 'device.rotation',
      deviceId: a.identity.deviceId,
      seq: 0,
      prevHash: null,
      oldEdPublic: a.identity.edPublic,
      oldXPublic: a.identity.xPublic,
      newEdPublic: a.identity.edPublic,
      newXPublic: a.identity.xPublic,
      rotatedAt: 1,
      signature: 'invite-chain-signature',
    }],
  }).code
  const homeB = tempDir()
  const b = loadState({ dshHome: homeB, name: 'laptop' })
  const enrollment = enrollFromInvite(b, invite)
  assert.equal(b.fleet.fleetId, a.fleet.fleetId)
  assert.equal(enrollment.accountFingerprint, fingerprint)
  assert.deepEqual(enrollment.endpoints, [{ deviceId: a.identity.deviceId, host: '192.168.137.1', port: 61318 }])
  assert.equal(b.roster.length, 2)
  assert.equal(b.roster.find((entry) => entry.deviceId === a.identity.deviceId).rotationSeq, 1)
  assert.equal(b.roster.find((entry) => entry.deviceId === 'device-c').edPublic, 'c-ed')
  assert.equal(loadPeerRotations(b)[a.identity.deviceId].records.length, 1)
  // Re-joining with a newer creator head refreshes rotation metadata only.
  enrollFromInvite(b, createInvite(a, {
    accountFingerprint: fingerprint,
    creator: {
      deviceId: a.identity.deviceId,
      name: 'desktop',
      edPublic: a.identity.edPublic,
      xPublic: a.identity.xPublic,
      rotationSeq: 3,
      rotationHead: 'creator-head-3',
    },
  }).code)
  const creatorEntry = b.roster.find((entry) => entry.deviceId === a.identity.deviceId)
  assert.equal(creatorEntry.rotationSeq, 3)
  assert.equal(creatorEntry.rotationHead, 'creator-head-3')
  assert.equal(creatorEntry.edPublic, a.identity.edPublic)
  assert.equal(accountMatches(b, fingerprint), true)
  assert.equal(accountMatches(b, 'other-fingerprint'), false)

  saveRoster(a, [{ deviceId: b.identity.deviceId, name: 'laptop' }])
  assert.equal(loadState({ dshHome: homeA }).roster.length, 1)

  savePeerHint(a, { host: '192.168.137.1', port: 60580 })
  savePeerHint(a, { host: '192.168.137.1', port: 60580 })
  const hinted = loadState({ dshHome: homeA })
  assert.equal(hinted.peerHints.length, 1)
  assert.equal(hinted.peerHints[0].port, 60580)

  // Pending enrollment applies on the next load and imports the bootstrap
  // roster (including a signed revocation for a device that never connected).
  const homeC = tempDir()
  const c = loadState({ dshHome: homeC, name: 'third' })
  const recruiter = generateIdentity({ name: 'third' })
  const revokedPeer = generateIdentity({ name: 'revoked-peer' })
  const revocation = createRevocationRecord(recruiter, { deviceId: revokedPeer.deviceId, reason: 'stolen' })
  const pendingInvite = createInvite(a, {
    accountFingerprint: fingerprint,
    creator: {
      deviceId: a.identity.deviceId,
      name: 'desktop',
      edPublic: a.identity.edPublic,
      xPublic: a.identity.xPublic,
    },
    roster: [
      { deviceId: recruiter.deviceId, name: 'third', edPublic: recruiter.edPublic, xPublic: recruiter.xPublic },
      {
        deviceId: revokedPeer.deviceId,
        name: 'revoked-peer',
        edPublic: revokedPeer.edPublic,
        xPublic: revokedPeer.xPublic,
        revokedAt: revocation.revokedAt,
        revokedBy: recruiter.deviceId,
        revocationReason: 'stolen',
      },
    ],
    revocations: [revocation],
  }).code
  writePendingEnrollment(c, pendingInvite)
  const reloadedC = loadState({ dshHome: homeC, name: 'third' })
  assert.equal(reloadedC.fleet.fleetId, a.fleet.fleetId)
  assert.equal(reloadedC.enrollment.accountFingerprint, fingerprint)
  const revokedEntry = reloadedC.roster.find((entry) => entry.deviceId === revokedPeer.deviceId)
  assert.ok(revokedEntry.revokedAt > 0)
  assert.equal(revokedEntry.revocationReason, 'stolen')
  assert.ok(reloadedC.roster.some((entry) => entry.deviceId === recruiter.deviceId))
  assert.equal(fs.existsSync(path.join(homeC, 'device-fleet', 'enrollment.pending.json')), false)
})

test('store: invites are single-use/expiring and known devices can be re-admitted', () => {
  const home = tempDir()
  const state = loadState({ dshHome: home, name: 'inviter' })
  const created = createInvite(state, { ttlMs: 60_000 })
  assert.ok(created.jti)
  assert.ok(Number.isFinite(created.expiresAt))
  assert.ok(loadIssuedInvites(state)[created.jti])

  assert.deepEqual(redeemIssuedInvite(state, { jti: created.jti, deviceId: 'device-b' }), {
    ok: true,
    usedAt: loadIssuedInvites(state)[created.jti].usedAt,
  })
  const reused = redeemIssuedInvite(state, { jti: created.jti, deviceId: 'device-c' })
  assert.equal(reused.ok, false)
  assert.equal(reused.reason, 'invite-consumed')
  assert.equal(redeemIssuedInvite(state, { jti: 'missing-jti' }).reason, 'unknown-invite')

  const expiring = createInvite(state, { ttlMs: 60_000 })
  const ledger = loadIssuedInvites(state)
  ledger[expiring.jti].expiresAt = Date.now() - 1
  saveIssuedInvites(state, ledger)
  assert.equal(redeemIssuedInvite(state, { jti: expiring.jti }).reason, 'invite-expired')

  assert.equal(isKnownDevice(state, 'device-b'), false)
  rememberKnownDevice(state, 'device-b')
  assert.equal(isKnownDevice(state, 'device-b'), true)
  assert.ok(loadKnownDevices(state)['device-b'].firstSeenAt > 0)
})

test('store: peer rotation chains persist and identity reset archives the old keys', () => {
  const home = tempDir()
  const state = loadState({ dshHome: home, name: 'desktop' })
  assert.deepEqual(loadPeerRotations(state), {})
  const chains = {
    'device-b': {
      genesisEdPublic: 'genesis-ed',
      genesisXPublic: 'genesis-x',
      records: [{ seq: 0 }, { seq: 1 }],
    },
  }
  savePeerRotations(state, chains)
  assert.deepEqual(loadPeerRotations(state), chains)
  const peerRotationsFile = path.join(home, 'device-fleet', 'peer-rotations.json')
  assert.equal(fs.existsSync(peerRotationsFile), true)

  fs.writeFileSync(path.join(home, 'device-fleet', 'identity-rotations.json'), JSON.stringify([{ seq: 0 }]))
  const previousId = state.identity.deviceId
  const previousEdPublic = state.identity.edPublic
  const summary = resetDeviceIdentity(state, { name: 'desktop' })
  assert.equal(summary.previousDeviceId, previousId)
  assert.notEqual(summary.deviceId, previousId)
  assert.equal(state.identity.deviceId, summary.deviceId)
  assert.ok(summary.archived.some((file) => file.startsWith('identity.json.bak-reset-')))
  assert.equal(fs.existsSync(path.join(home, 'device-fleet', 'identity-rotations.json')), false)
  const backups = fs.readdirSync(path.join(home, 'device-fleet')).filter((file) => file.startsWith('identity.json.bak-reset-'))
  assert.equal(backups.length, 1)

  const reloaded = loadState({ dshHome: home, name: 'desktop' })
  assert.equal(reloaded.identity.deviceId, summary.deviceId)
  assert.notEqual(reloaded.identity.edPublic, previousEdPublic)
})

test('store: rotation chain compaction archives a verified prefix', () => {
  const home = tempDir()
  const state = loadState({ dshHome: home, name: 'rotating' })
  let identity = state.identity
  const records = []
  for (let index = 0; index < 12; index += 1) {
    const next = rotateIdentityKeys(identity)
    records.push(createRotationRecord(identity, next, { previous: records[records.length - 1] ?? null }))
    identity = next
  }
  state.identity = identity
  saveRotationState(state, { records, checkpoint: null })

  const result = compactRotationChain(state, { keep: 8 })
  assert.equal(result.compacted, true)
  assert.equal(result.archived, 4)
  assert.equal(result.kept, 8)
  assert.equal(result.from, 4)
  assert.equal(verifyRotationCheckpoint(result.checkpoint, identity.edPublic), true)
  const loaded = loadRotationState(state)
  assert.equal(loaded.records.length, 8)
  assert.equal(loaded.records[0].seq, 4)
  assert.equal(loaded.checkpoint.head, rotationRecordHash(records[3]))
  assert.equal(fs.existsSync(path.join(home, 'device-fleet', result.archive)), true)
  const archived = JSON.parse(fs.readFileSync(path.join(home, 'device-fleet', result.archive), 'utf8'))
  assert.equal(archived.records.length, 4)

  // Compacting below the retained window again is a no-op.
  assert.equal(compactRotationChain(state, { keep: 8 }).compacted, false)
  // A fresh rotation record still chains onto the retained tail.
  const next = rotateIdentityKeys(state.identity)
  const record = createRotationRecord(state.identity, next, { previous: loaded.records[loaded.records.length - 1] })
  assert.equal(record.seq, 12)
})

test('tool policy: roots, capability modes, allowlist and TTL grants', async () => {
  const root = tempDir()
  const outside = tempDir()
  assert.equal(pathWithinRoots([root], path.join(root, 'a', 'b.txt')), true)
  assert.equal(pathWithinRoots([root], path.join(outside, 'b.txt')), false)
  assert.equal(pathWithinRoots([root], path.join(root, 'new', 'b.txt')), true)
  try {
    const link = path.join(root, 'escape')
    fs.symlinkSync(outside, link, 'junction')
    assert.equal(pathWithinRoots([root], path.join(link, 'b.txt')), false)
  } catch {
    /* symlink creation can be denied on Windows; the lexical cases still run */
  }

  const noRoots = new ToolPolicy({})
  assert.equal(noRoots.decide({ capability: 'read', args: { path: path.join(root, 'a.txt') } }).decision, 'deny')

  const policy = new ToolPolicy({
    allowedRoots: [root],
    capabilities: { read: 'auto', run: 'ask', tool: 'auto' },
  })
  assert.equal(policy.decide({ capability: 'read', args: { path: path.join(root, 'a.txt') } }).decision, 'allow')
  assert.equal(policy.decide({ capability: 'read', args: { path: path.join(outside, 'a.txt') } }).decision, 'deny')
  assert.equal(policy.decide({ capability: 'run', args: { command: 'echo hi' } }).decision, 'ask')
  assert.equal(policy.decide({ capability: 'delegate', args: {} }).decision, 'ask')
  // Raw tools follow the DSH pipeline by default; only an explicit deny blocks them.
  assert.equal(policy.decide({ capability: 'tool', tool: 'write', args: {} }).decision, 'allow')
  assert.equal(policy.decide({ capability: 'tool', tool: 'read', args: {} }).decision, 'allow')
  const rawDenied = new ToolPolicy({ capabilities: { tool: 'deny' } })
  assert.equal(rawDenied.decide({ capability: 'tool', tool: 'read', args: {} }).decision, 'deny')
  const defaults = new ToolPolicy({})
  assert.equal(defaults.decide({ capability: 'tool', tool: 'read', args: {} }).decision, 'ask')
  const allowlisted = new ToolPolicy({ allowedTools: ['read'] })
  assert.equal(allowlisted.decide({ capability: 'tool', tool: 'read', args: {} }).decision, 'ask')
  assert.equal(allowlisted.decide({ capability: 'tool', tool: 'pwsh', args: {} }).decision, 'deny')
  assert.equal(policy.decide({ capability: 'read', tool: 'fleet.session.trajectory', args: { sessionId: 's1' } }).decision, 'allow')

  policy.grant('read:*', { scope: 'once' })
  assert.equal(policy.decide({ capability: 'read', args: { path: path.join(root, 'a.txt') } }).decision, 'allow')
  assert.equal(policy.decide({ capability: 'read', args: { path: path.join(root, 'a.txt') } }).decision, 'allow', 'auto mode still allows')
  policy.grant('run:*', { scope: 'once', ttlMs: 1 })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(policy.decide({ capability: 'run', args: {} }).decision, 'ask', 'expired grant falls back to ask')
})

test('execution slot lazily creates one agent and normalizes tool results', async () => {
  let created = 0
  const sessionController = {
    async create(request) {
      created += 1
      assert.equal(request.cwd, 'C:/work')
      return { sessionId: 'slot-session' }
    },
    async resolveAgent(sessionId) {
      assert.equal(sessionId, 'slot-session')
      return { agent: { id: 'slot-session', session: { id: 'slot-session' } } }
    },
  }
  const tools = {
    schemas(agent) {
      assert.equal(agent.id, 'slot-session')
      return [{ name: 'read', description: 'read', parameters: {} }]
    },
    async execute(input) {
      assert.equal(input.calls.length, 1)
      return {
        results: [{ callId: input.calls[0].id, result: { content: [{ type: 'text', text: `ran ${input.calls[0].name}` }], isError: false } }],
      }
    },
  }
  const slot = new ExecutionSlot({ sessionController, tools, config: { cwd: 'C:/work' } })
  assert.equal((await slot.listTools())[0].name, 'read')
  assert.equal((await slot.executeTool({ name: 'read', args: { file_path: 'x' } })).text, 'ran read')
  assert.equal(created, 1)
})

test('delegation host runs a caller-delivery subagent and returns its final text', async () => {
  const policy = new ToolPolicy({ capabilities: { delegate: 'auto' } })
  let spec
  let disposed = false
  const subagents = {
    async startActivation(input) {
      spec = input
      return {
        childId: 'child-1',
        result: Promise.resolve({ output: [{ type: 'text', text: 'B finished the task' }], stopReason: 'completed' }),
        async dispose() {
          disposed = true
        },
      }
    },
  }
  const slot = { async ensureAgent() { return { id: 'slot-agent' } } }
  const host = new DelegationHost({
    subagents,
    slot,
    policy,
    deviceId: 'device-b',
    defaultCwd: 'E:/Dsh_test',
    defaultAgentPreset: 'standard',
  })
  const result = await host.delegate({ fromDeviceId: 'device-a', request: { task: 'read hello-from-B.txt' } })
  assert.equal(result.text, 'B finished the task')
  assert.equal(result.childId, 'child-1')
  assert.equal(disposed, true)
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.parent.id, 'slot-agent')
  assert.equal(spec.cwd, 'E:/Dsh_test')
  assert.equal(spec.agentPreset, 'standard')
  assert.equal(spec.prompt[0].text, 'read hello-from-B.txt')
  assert.equal(spec.request, undefined)

  const denied = new DelegationHost({ subagents, slot, policy: new ToolPolicy({}), deviceId: 'device-b' })
  await assert.rejects(denied.delegate({ fromDeviceId: 'device-a', request: { task: 'x' } }), /approval was not granted|no approval channel/)
})

test('approval inbox queues, approves, denies, expires and scopes', async () => {
  const inbox = new ApprovalInbox({ ttlMs: 40, maxPending: 2 })
  const first = inbox.request({ fromDeviceId: 'device-a', capability: 'run', tool: 'pwsh', reason: 'needs shell' })
  const second = inbox.request({ fromDeviceId: 'device-a', capability: 'read' })
  assert.equal(inbox.list().length, 2)
  const approved = inbox.approve(inbox.list()[0].id, { scope: 'ttl' })
  assert.deepEqual(await first, { approved: true, scope: 'ttl' })
  assert.equal(approved.scope, 'ttl')
  inbox.deny(inbox.list()[0].id, 'not now')
  assert.equal((await second).approved, false)

  const expiring = inbox.request({ fromDeviceId: 'device-b', capability: 'run' })
  assert.equal(inbox.list().length, 1)
  const expired = await expiring
  assert.equal(expired.approved, false)
  assert.equal(expired.reason, 'approval-timeout')
  assert.equal(inbox.list().length, 0)
  inbox.close()
  assert.equal((await inbox.request({ fromDeviceId: 'x', capability: 'read' })).reason, 'inbox-closed')
})

test('call ledger and outbox survive reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ledger-'))
  const ledger = new CallLedger({ file: path.join(dir, 'calls.jsonl'), now: () => 1000 })
  ledger.record({ direction: 'outbound', deviceId: 'b', capability: 'run', tool: 'pwsh', status: 'ok', durationMs: 12, args: { command: 'x' }, resultText: 'ok' })
  const reloadedLedger = new CallLedger({ file: path.join(dir, 'calls.jsonl') })
  assert.equal(reloadedLedger.list().length, 1)
  assert.equal(reloadedLedger.list()[0].deviceId, 'b')

  const outbox = new Outbox({ file: path.join(dir, 'outbox.json'), now: () => 1000 })
  const entry = outbox.add({ deviceId: 'b', kind: 'delegate', request: { task: 'x' }, label: 'later' })
  outbox.update(entry.id, { status: 'done', resultText: 'result' })
  const reloadedOutbox = new Outbox({ file: path.join(dir, 'outbox.json') })
  assert.equal(reloadedOutbox.get(entry.id).status, 'done')
  assert.equal(reloadedOutbox.get(entry.id).resultText, 'result')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('approval inbox and tool grants persist across reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-approval-'))
  const inboxFile = path.join(dir, 'approvals.json')
  const inbox = new ApprovalInbox({ ttlMs: 60_000, stateFile: inboxFile })
  const promise = inbox.request({ fromDeviceId: 'b', capability: 'run', roomId: 'room-1' })
  const reloaded = new ApprovalInbox({ ttlMs: 60_000, stateFile: inboxFile })
  assert.equal(reloaded.list().length, 1)
  assert.equal(reloaded.list()[0].resumed, true)
  reloaded.approve(reloaded.list()[0].id, { scope: 'room' })
  assert.equal(reloaded.list().length, 0)
  inbox.close()
  void promise

  const grantsFile = path.join(dir, 'grants.json')
  const policy = new ToolPolicy({ capabilities: { run: 'ask' } }, { stateFile: grantsFile })
  policy.grant('run:*', { scope: 'task', taskId: 'task-1' })
  const reloadedPolicy = new ToolPolicy({ capabilities: { run: 'ask' } }, { stateFile: grantsFile })
  assert.equal(reloadedPolicy.decide({ capability: 'run', taskId: 'task-1' }).decision, 'allow')
  assert.equal(reloadedPolicy.decide({ capability: 'run', taskId: 'task-2' }).decision, 'ask')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('browser origin guard rejects cross-site and rebinding requests', () => {
  assert.equal(isUnsafeBrowserRequest({ headers: {} }), false)
  assert.equal(isUnsafeBrowserRequest({ headers: { origin: 'http://127.0.0.1:50827', host: '127.0.0.1:50827' } }), false)
  assert.equal(isUnsafeBrowserRequest({ headers: { origin: 'http://evil.example', host: '127.0.0.1:50827' } }), true)
  assert.equal(isUnsafeBrowserRequest({ headers: { origin: 'http://127.0.0.1:50827', host: 'evil.example' } }), true)
  assert.equal(isUnsafeBrowserRequest({ headers: { origin: 'http://127.0.0.1:50827', host: '127.0.0.1:50827', 'sec-fetch-site': 'cross-site' } }), true)
})

test('trajectory store persists, redacts secrets and survives reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-trajectory-'))
  const file = path.join(dir, 'trajectory.jsonl')
  const store = new TrajectoryStore({ file, maxEvents: 5, maxSessions: 2 })
  const now = Date.now()
  store.record('s1', { type: 'tool/call', createdAt: now - 2_000, data: { command: 'x', apiKey: 'secret-value', nested: { password: 'p' } } })
  store.record('s1', { type: 'assistant/message', createdAt: now - 1_000, data: { text: 'ok' } })
  store.setOwner('s1', 'device-a')
  const first = store.get('s1')
  assert.equal(first.events[0].data.apiKey, '[redacted]')
  assert.equal(first.events[0].data.nested.password, '[redacted]')
  const reloaded = new TrajectoryStore({ file })
  assert.equal(reloaded.get('s1').events.length, 2)
  assert.equal(reloaded.get('s1').events[1].type, 'assistant/message')
  assert.equal(reloaded.ownerOf('s1'), 'device-a')
  assert.equal(reloaded.ownerOf('other'), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('trajectory store keeps bounded per-session DSH events', () => {
  const store = new TrajectoryStore({ maxEvents: 3, maxSessions: 2 })
  store.record('s1', { type: 'user/message', createdAt: 1, data: { text: 'hi' } })
  store.record('s1', { type: 'assistant/message', createdAt: 2, data: { text: 'hello' } })
  store.record('s1', { type: 'tool/call', createdAt: 3, data: { name: 'x' } })
  store.record('s1', { type: 'tool/result', createdAt: 4, data: { ok: true } })
  const trajectory = store.get('s1')
  assert.equal(trajectory.events.length, 3)
  assert.equal(trajectory.events[0].type, 'assistant/message')
  assert.equal(trajectory.events[2].type, 'tool/result')
  assert.equal(store.get('missing'), null)
  store.record('s2', { type: 'user/message', data: {} })
  store.record('s3', { type: 'user/message', data: {} })
  assert.equal(store.list().length, 2)
})

test('scope revocation queue persists, deduplicates and prunes offline targets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-revoke-'))
  const file = path.join(dir, 'pending-scope-revocations.json')
  let now = 1_000
  const queue = new ScopeRevocationQueue({ file, now: () => now, maxAgeMs: 100 })
  const taskKey = queue.add({ deviceId: 'device-b', kind: 'task', roomId: 'room-1', taskId: 'task-1' })
  queue.add({ deviceId: 'device-b', kind: 'task', roomId: 'room-1', taskId: 'task-1' })
  queue.add({ deviceId: 'device-b', kind: 'room', roomId: 'room-1' })
  assert.equal(queue.all().length, 2)
  assert.equal(queue.listFor('device-b').length, 2)
  const reloaded = new ScopeRevocationQueue({ file, now: () => now, maxAgeMs: 100 })
  assert.equal(reloaded.all().length, 2)
  reloaded.remove(taskKey)
  assert.equal(reloaded.all().length, 1)
  now += 101
  assert.equal(reloaded.prune(), true)
  assert.equal(reloaded.all().length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('approval scopes bind to Room and task context and survive one call', async () => {
  const inbox = new ApprovalInbox({ ttlMs: 1_000 })
  const roomRequest = inbox.request({ fromDeviceId: 'device-a', capability: 'run', roomId: 'room-1' })
  const roomDecision = inbox.approve(inbox.list()[0].id, { scope: 'room' })
  assert.equal(roomDecision.scope, 'room')
  assert.equal(roomDecision.roomId, 'room-1')
  assert.deepEqual(await roomRequest, { approved: true, scope: 'room', roomId: 'room-1' })

  const taskRequest = inbox.request({ fromDeviceId: 'device-a', capability: 'run', roomId: 'room-1', taskId: 'task-1' })
  const taskDecision = inbox.approve(inbox.list()[0].id, { scope: 'task' })
  assert.equal(taskDecision.taskId, 'task-1')
  assert.deepEqual(await taskRequest, { approved: true, scope: 'task', taskId: 'task-1' })

  const noContext = inbox.request({ fromDeviceId: 'device-a', capability: 'run' })
  assert.throws(() => inbox.approve(inbox.list()[0].id, { scope: 'room' }), /Room context/)
  inbox.approve(inbox.list()[0].id, { scope: 'once' })
  assert.equal((await noContext).scope, 'once')
})

test('tool policy consumes Room/task grants only with matching context', () => {
  const policy = new ToolPolicy({ capabilities: { run: 'ask' } })
  assert.equal(policy.decide({ capability: 'run' }).decision, 'ask')
  policy.grant('run:*', { scope: 'room', roomId: 'room-1' })
  assert.equal(policy.decide({ capability: 'run' }).decision, 'ask')
  assert.equal(policy.decide({ capability: 'run', roomId: 'room-2' }).decision, 'ask')
  assert.equal(policy.decide({ capability: 'run', roomId: 'room-1' }).decision, 'allow')
  assert.equal(policy.decide({ capability: 'run', roomId: 'room-1' }).decision, 'allow')
  policy.revokeRoom('room-1')
  assert.equal(policy.decide({ capability: 'run', roomId: 'room-1' }).decision, 'ask')

  policy.grant('run:*', { scope: 'task', taskId: 'task-1' })
  assert.equal(policy.decide({ capability: 'run', taskId: 'task-1' }).decision, 'allow')
  assert.equal(policy.decide({ capability: 'run', taskId: 'task-1' }).decision, 'allow')
  policy.revokeTask('task-1')
  assert.equal(policy.decide({ capability: 'run', taskId: 'task-1' }).decision, 'ask')
})

test('direct-call host waits for inbox approval before executing', async () => {
  const root = tempDir()
  const inbox = new ApprovalInbox({ ttlMs: 1_000 })
  const calls = []
  const slot = {
    async listTools() {
      return []
    },
    async executeTool({ name, args }) {
      calls.push({ name, args })
      return { isError: false, text: 'ran', content: [], meta: null }
    },
  }
  const policy = new ToolPolicy({ capabilities: { run: 'ask' }, allowedRoots: [root] })
  const host = new DirectCallHost({
    slot,
    policy,
    fs: null,
    deviceId: 'device-b',
    requestApproval: (request) => inbox.request(request),
  })
  const pendingCall = host.handleRequest({
    deviceId: 'device-a',
    method: 'fleet.call',
    params: { capability: 'run', args: { command: 'echo hi' } },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(inbox.list().length, 1)
  inbox.approve(inbox.list()[0].id, { scope: 'once' })
  const result = await pendingCall
  assert.equal(result.text, 'ran')
  assert.equal(calls.length, 1)

  inbox.close()
})

test('read/grep capabilities cannot spoof a tool name and grants cannot bypass roots', async () => {
  const root = tempDir()
  const outside = tempDir()
  const calls = []
  const slot = {
    async executeTool({ name, args }) {
      calls.push({ name, args })
      return { isError: false, text: `ran ${name}`, content: [], meta: null }
    },
  }
  const policy = new ToolPolicy({ allowedRoots: [root], capabilities: { read: 'auto', tool: 'ask' }, allowedTools: ['pwsh'] })
  const host = new DirectCallHost({ slot, policy, fs: null, deviceId: 'device-b' })
  const result = await host.handleRequest({
    deviceId: 'device-a',
    method: 'fleet.call',
    params: { capability: 'read', tool: 'fleet_reset_identity', args: { path: path.join(root, 'a.txt') } },
  })
  assert.equal(result.text, 'ran read')
  assert.equal(calls[0].name, 'read')
  await assert.rejects(
    host.handleRequest({ deviceId: 'device-a', method: 'fleet.call', params: { capability: 'tool', tool: 'fleet_reset_identity', args: {} } }),
    /may not invoke management tool|not in the allowlist/,
  )
  policy.grant('read:*', { scope: 'once' })
  await assert.rejects(
    host.handleRequest({ deviceId: 'device-a', method: 'fleet.call', params: { capability: 'read', tool: 'read', args: { path: path.join(outside, 'a.txt') } } }),
    /outside the allowed roots|outside the allowed roots/,
  )
})

test('avatar routes serve the three Room avatars and the uploaded library', async () => {
  const dir = tempDir()
  const libraryDir = `${tempDir()}/library`
  const { writeFileSync } = await import('node:fs')
  writeFileSync(`${dir}/host.png`, Buffer.from([1, 2, 3]))
  writeFileSync(`${dir}/worker.png`, Buffer.from([4, 5, 6]))
  writeFileSync(`${dir}/user.png`, Buffer.from([7, 8, 9]))
  const routes = []
  const webServer = { register(route) { routes.push(route); return () => {} } }
  const dispose = registerAvatarRoutes({ webServer, dir, libraryDir })
  assert.equal(routes.length, 6)
  const response = { statusCode: 0, headers: {}, setHeader(name, value) { this.headers[name] = value }, end(value) { this.body = value } }
  await routes[0].handler({ method: 'GET' }, response)
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'image/png')
  assert.equal(response.body.length, 3)

  const libraryRoute = routes.find((route) => route.path === '/device-fleet/avatar-library')
  const upload = async (route, body) => {
    let text = ''
    const res = { statusCode: 0, setHeader() {}, end(value) { text = String(value ?? '') } }
    const req = {
      method: 'POST',
      url: route.path,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(body))
      },
    }
    await route.handler(req, res)
    return { status: res.statusCode, json: JSON.parse(text) }
  }
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
  const saved = await upload(libraryRoute, { name: 'cat', dataUrl: `data:image/png;base64,${png}` })
  assert.equal(saved.status, 200)
  assert.match(saved.json.item.url, /avatar-file/)
  let listed = ''
  const listRes = { statusCode: 0, setHeader() {}, end(value) { listed = String(value ?? '') } }
  await libraryRoute.handler({ method: 'GET', url: libraryRoute.path }, listRes)
  assert.equal(JSON.parse(listed).items.length, 1)
  dispose()
})

test('runtime config merges overrides, persists and live-applies', async () => {
  const overridesFile = `${tempDir()}/config-overrides.json`
  const runtime = new RuntimeConfig({
    base: { deviceName: 'base', policy: { allowedRoots: ['/base'], capabilities: { read: 'auto' } }, approvals: { ttlMs: 1000 } },
    overridesFile,
  })
  const applied = []
  runtime.onChange((next, previous) => applied.push({ next, previous }))
  const next = await runtime.update({
    deviceName: 'ui-name',
    policy: { allowedRoots: ['/a', '/b'], capabilities: { run: 'deny' } },
    approvals: { ttlMs: 5000 },
  })
  assert.equal(next.deviceName, 'ui-name')
  assert.deepEqual(next.policy.allowedRoots, ['/a', '/b'])
  assert.equal(next.policy.capabilities.read, 'auto')
  assert.equal(next.policy.capabilities.run, 'deny')
  assert.equal(next.approvals.ttlMs, 5000)
  assert.equal(applied.length, 1)
  assert.equal(applied[0].previous.deviceName, 'base')
  assert.equal(existsSync(overridesFile), true)
  const reloaded = new RuntimeConfig({ base: { deviceName: 'base' }, overridesFile })
  assert.equal(reloaded.current.deviceName, 'ui-name')
  assert.equal(reloaded.current.approvals.ttlMs, 5000)
  assert.throws(() => sanitizeConfigPatch({ dataDir: '/elsewhere' }), /cannot be changed/)
  assert.throws(() => sanitizeConfigPatch({ policy: { capabilities: { read: 'nope' } } }), /auto\|ask\|deny/)
  assert.throws(() => sanitizeConfigPatch({ policy: { allowedRoots: 'x' } }), /array of strings/)

  runtime.onChange((candidate) => {
    if (candidate.deviceName === 'bad-apply') throw new Error('live apply failed')
  })
  await assert.rejects(runtime.update({ deviceName: 'bad-apply' }), /live apply failed/)
  assert.equal(runtime.current.deviceName, 'ui-name')
  assert.equal(new RuntimeConfig({ base: { deviceName: 'base' }, overridesFile }).current.deviceName, 'ui-name')

  // Relay TLS settings survive sanitizing (CA/servername, self-signed override).
  const relayClean = sanitizeConfigPatch({
    relay: { host: 'relay.local', port: 7000, dataPort: 7002, tls: { ca: 'CA-PEM', servername: 'relay.local' } },
    relays: [{ host: 'relay2.local', port: 7001, dataPort: 7003, tls: { ca: 'CA2-PEM', rejectUnauthorized: false } }],
  })
  assert.equal(relayClean.relay.tls.ca, 'CA-PEM')
  assert.equal(relayClean.relay.tls.servername, 'relay.local')
  assert.equal(relayClean.relays[0].tls.rejectUnauthorized, false)
  assert.throws(() => sanitizeConfigPatch({ relay: { host: 'relay.local', port: 1, dataPort: 2, tls: 'nope' } }), /must be an object/)
})

test('config routes read effective config and apply a patch live', async () => {
  const routes = []
  const webServer = { register(route) { routes.push(route); return () => {} } }
  const overridesFile = `${tempDir()}/overrides.json`
  const runtime = new RuntimeConfig({ base: { deviceName: 'base', approvals: { ttlMs: 1000 } }, overridesFile })
  const prepared = []
  const dispose = registerConfigRoutes({
    webServer,
    runtime,
    getOptions: () => ({ shells: ['pwsh'], presets: [] }),
    preparePatch: (patch) => {
      prepared.push(patch)
      return patch
    },
  })
  assert.equal(routes.length, 2)
  const call = async (route, method, body) => {
    let text = ''
    const res = { statusCode: 0, setHeader() {}, end(value) { text = String(value ?? '') } }
    const req = {
      method,
      url: route.path,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    }
    await route.handler(req, res)
    return { status: res.statusCode, json: JSON.parse(text) }
  }
  const options = await call(routes[0], 'GET')
  assert.deepEqual(options.json.shells, ['pwsh'])
  const read = await call(routes[1], 'GET')
  assert.equal(read.json.config.deviceName, 'base')
  assert.deepEqual(read.json.readonly, ['dataDir'])
  const saved = await call(routes[1], 'POST', { patch: { deviceName: 'ui', approvals: { ttlMs: 9000 } } })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.ok, true)
  assert.equal(saved.json.config.deviceName, 'ui')
  assert.equal(runtime.current.approvals.ttlMs, 9000)
  assert.equal(prepared.length, 1)
  const invalid = await call(routes[1], 'POST', { patch: { dataDir: '/x' } })
  assert.equal(invalid.status, 400)
  dispose()
})

test('room service rehydrates persisted rooms and resolves participant agents lazily', async () => {
  const stateFile = `${tempDir()}/rooms.json`
  const hostAgent = { session: { id: 'host-session', header: { title: 'Host' }, append: async () => ({}) } }
  const participant = { session: { id: 'participant-session' }, followup: () => {} }
  const created = []
  const controller = {
    async create() {
      return { sessionId: 'participant-session' }
    },
    async resolveAgent() {
      created.push(1)
      return { agent: participant }
    },
  }
  const first = new RoomService({ sessionController: controller, createUserMessage: (message) => message, stateFile })
  const room = await first.upgradeHost({ agent: hostAgent })
  const member = await first.addLocalParticipant({ roomId: room.roomId, name: 'worker' })
  await first.send({ roomId: room.roomId, from: { sessionId: 'host-session' }, to: [member.memberId], text: 'hello' })
  const task = await first.addTask({ roomId: room.roomId, title: 'do it', owner: member.memberId })

  const second = new RoomService({ sessionController: controller, createUserMessage: (message) => message, stateFile })
  const listed = second.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].roomId, room.roomId)
  assert.equal(listed[0].members.length, 2)
  const detail = second.detail(room.roomId)
  assert.equal(detail.messages.length, 1)
  assert.equal(detail.tasks.length, 1)
  assert.equal(detail.tasks[0].id, task.id)
  // The participant agent was not persisted; the first wake resolves it again.
  const before = created.length
  const sent = await second.send({ roomId: room.roomId, from: { sessionId: 'host-session' }, to: [member.memberId], text: 'again' })
  assert.deepEqual(sent.woken, [member.memberId])
  assert.equal(created.length, before + 1)
  await second.close({ roomId: room.roomId })
  assert.equal(new RoomService({ sessionController: controller, createUserMessage: (message) => message, stateFile }).list().length, 0)
})

test('Fleet console routes expose overview, room list and room detail', async () => {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const rooms = {
    list: () => [{ roomId: 'room-1', members: [] }],
    detail: (roomId) => {
      if (roomId !== 'room-1') throw Object.assign(new Error('unknown room'), { code: 'unknown-room' })
      return { roomId, members: [], messages: [], tasks: [] }
    },
  }
  const inbox = { list: () => [{ id: 'approval-1' }], history: () => [{ id: 'approval-0', outcome: 'approved' }] }
  const actions = {
    async sendRoomMessage(body) {
      return { messageId: 'm1', to: body.to ?? [], woken: [] }
    },
    async roomTask() {
      return { task: { id: 't1' }, handedOff: [] }
    },
    async revokeFleetDevice(body) {
      return { deviceId: body.deviceId, confirmed: body.confirm === true }
    },
    async resolveRotationFork(body) {
      return { deviceId: body.deviceId, action: body.action, confirmed: body.confirm === true }
    },
    async dismissRevocation(body) {
      return { deviceId: body.deviceId, dismissed: true }
    },
    async compactRotation(body) {
      return { compacted: true, keep: body.keep ?? 64, confirmed: body.confirm === true }
    },
    async trustRotationCheckpoint(body) {
      return { deviceId: body.deviceId, status: 'trusted', confirmed: body.confirm === true }
    },
    async restoreRoom(body) {
      return { roomId: body.roomId, restored: true }
    },
    async rotateIdentity() {
      return { deviceId: 'device-a', seq: 2, peers: ['device-b'] }
    },
    async resetIdentity(body) {
      return { deviceId: 'new-device', confirmed: body.confirm === true }
    },
    async createInvite() {
      return { code: 'invite-code-121', expiresAt: 1_234_567_890 }
    },
  }
  const notifications = new NotificationCenter()
  notifications.push({ kind: 'approval', title: 'test approval', body: 'from device-b' })
  const dispose = registerUiRoutes({
    webServer,
    inbox,
    rooms,
    notifications,
    actions,
    getOverview: () => ({ deviceId: 'device-a', connected: [] }),
  })
  assert.equal(routes.length, 35)
  const call = async (route, url) => {
    let body = ''
    const res = {
      statusCode: 0,
      setHeader() {},
      end(value) {
        body = String(value ?? '')
      },
    }
    await route.handler({ method: 'GET', url }, res)
    return { status: res.statusCode, json: JSON.parse(body) }
  }
  const overview = await call(routes[0], '/device-fleet/overview')
  assert.equal(overview.json.deviceId, 'device-a')
  assert.equal(overview.json.approvals.length, 1)
  const list = await call(routes[1], '/device-fleet/rooms')
  assert.equal(list.json.rooms.length, 1)
  const detail = await call(routes[2], '/device-fleet/room?id=room-1')
  assert.equal(detail.json.room.roomId, 'room-1')
  const missing = await call(routes[2], '/device-fleet/room?id=missing')
  assert.equal(missing.status, 404)
  const history = await call(routes[12], '/device-fleet/approvals/history')
  assert.equal(history.json.history[0].id, 'approval-0')
  const sent = await (async () => {
    let text = ''
    const res = { statusCode: 0, setHeader() {}, end(value) { text = String(value ?? '') } }
    const req = {
      method: 'POST',
      url: '/device-fleet/room/send',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ roomId: 'room-1', to: ['host:room-1'], text: 'hi' }))
      },
    }
    await routes[3].handler(req, res)
    return { status: res.statusCode, json: JSON.parse(text) }
  })()
  assert.equal(sent.json.result.messageId, 'm1')
  const post = async (index, payload) => {
    let text = ''
    const res = { statusCode: 0, setHeader() {}, end(value) { text = String(value ?? '') } }
    const req = {
      method: 'POST',
      url: '/',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(payload))
      },
    }
    await routes[index].handler(req, res)
    return { status: res.statusCode, json: JSON.parse(text) }
  }
  const revoked = await post(23, { deviceId: 'device-b', reason: 'lost key' })
  assert.equal(revoked.status, 200)
  assert.deepEqual(revoked.json.result, { deviceId: 'device-b', confirmed: true })
  const fork = await post(24, { deviceId: 'device-b', action: 'adopt-peer' })
  assert.equal(fork.json.result.action, 'adopt-peer')
  assert.equal(fork.json.result.confirmed, true)
  const dismissed = await post(25, { deviceId: 'device-b' })
  assert.equal(dismissed.json.result.dismissed, true)
  const compacted = await post(26, { keep: 32 })
  assert.equal(compacted.json.result.compacted, true)
  assert.equal(compacted.json.result.keep, 32)
  assert.equal(compacted.json.result.confirmed, true)
  const restored = await post(16, { roomId: 'room-1' })
  assert.equal(restored.json.result.restored, true)
  const notificationList = await call(routes[30], '/device-fleet/notifications')
  assert.equal(notificationList.json.unread, 1)
  assert.equal(notificationList.json.notifications[0].title, 'test approval')
  const notificationRead = await post(31, { all: true })
  assert.equal(notificationRead.json.changed, 1)
  assert.equal(notifications.unreadCount(), 0)
  const rotated = await post(28, {})
  assert.equal(rotated.json.result.seq, 2)
  const reset = await post(29, { reason: 'console' })
  assert.equal(reset.json.result.confirmed, true)
  const trusted = await post(27, { deviceId: 'device-b' })
  assert.equal(trusted.json.result.status, 'trusted')
  const invite = await post(10, {})
  assert.equal(invite.json.code, 'invite-code-121')
  assert.equal(invite.json.expiresAt, 1_234_567_890)
  dispose()
})

test('approval HTTP API lists and decides requests, and registers two routes', async () => {
  const inbox = new ApprovalInbox({ ttlMs: 5_000 })
  const api = createApprovalApi({ inbox })
  const pending = inbox.request({ fromDeviceId: 'device-b', capability: 'run', tool: 'pwsh', args: { command: 'echo hi' } })
  assert.equal(api.list().approvals.length, 1)
  const decided = api.decide({ id: api.list().approvals[0].id, action: 'approve', scope: 'ttl' })
  assert.equal(decided.ok, true)
  assert.equal((await pending).scope, 'ttl')
  assert.deepEqual(api.list().approvals, [])
  assert.throws(() => api.decide({ id: api.list()[0]?.id, action: 'nope' }), /id is required/)
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const dispose = registerApprovalRoutes({ webServer, inbox })
  assert.equal(routes.length, 2)
  assert.equal(routes[0].path, '/device-fleet/approvals')
  assert.equal(routes[1].path, '/device-fleet/approvals/decide')
  // Exercise the GET route with a minimal Node response double.
  const headers = {}
  let body = ''
  const res = {
    statusCode: 0,
    setHeader(name, value) {
      headers[name] = value
    },
    end(value) {
      body = String(value ?? '')
    },
  }
  await routes[0].handler({ method: 'GET' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(body).approvals.length, 0)
  dispose()
  inbox.close()
})

test('room service: an archived Room restores from its replica into a writable Room', () => {
  const rooms = new RoomService({ sessionController: null, now: () => 1_000 })
  const snapshot = {
    roomId: 'room-restore',
    createdAt: 500,
    policy: { invite: 'members', join: 'auto', maxMembers: 9, boardWrite: 'members', remove: 'members' },
    members: [
      { memberId: 'host:room-restore', role: 'host', kind: 'local', sessionId: 'room-restore', name: 'host' },
      { memberId: 'remote:device-b:session-x', role: 'participant', kind: 'remote', deviceId: 'device-b', name: 'B' },
    ],
    messages: [{ id: 'm1', roomId: 'room-restore', from: { kind: 'user' }, to: ['host:room-restore'], text: 'hi', createdAt: 600 }],
    tasks: [{ id: 't1', title: 'task', owner: 'host:room-restore', status: 'pending', dependsOn: [] }],
    authorityEpoch: 3,
  }
  const summary = rooms.restoreArchivedRoom({ roomId: 'room-restore', snapshot })
  assert.equal(summary.roomId, 'room-restore')
  assert.equal(summary.closed, false)
  assert.equal(summary.members.length, 2)
  assert.equal(summary.messageCount, 1)
  assert.equal(summary.tasks, 1)
  assert.equal(summary.authorityEpoch, 4)
  assert.equal(rooms.list().length, 1)

  // Restoring again reopens the in-memory Room instead of duplicating it.
  const reopened = rooms.restoreArchivedRoom({ roomId: 'room-restore' })
  assert.equal(reopened.roomId, 'room-restore')
  assert.equal(rooms.list().length, 1)

  assert.throws(() => rooms.restoreArchivedRoom({ roomId: 'missing', snapshot: null }), /no local replica/)
})

test('human-readable Room and member names replace raw ids in summaries', async () => {
  assert.equal(friendlyName('same-seed'), friendlyName('same-seed'))
  assert.ok(!friendlyName('session-1234').startsWith('Room '))
  const rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    appendRecord: async () => {},
    replicaStore: { deviceId: 'device-a', append: (event) => event, bindSession() {} },
  })
  const summary = await rooms.upgradeHost({ agent: { session: { id: 'friendly-host', header: { title: 'host' }, append: async () => ({}) } } })
  assert.ok(summary.title && !summary.title.startsWith('Room '))
  assert.equal(summary.members[0].displayName, '主持人')
  assert.equal(rooms.status('friendly-host').title, summary.title)
})

test('room service: upgrade, add local participants, addressed wake and transcript', async () => {
  const events = []
  const followups = []
  const hostAgent = {
    session: {
      id: 'host-session',
      header: { title: 'Host' },
      append: async (type, data) => events.push({ type, data }),
    },
  }
  const participantA = { session: { id: 'pa-session' }, followup: (message) => followups.push({ session: participantA.session.id, message }) }
  const participantB = { session: { id: 'pb-session' }, followup: (message) => followups.push({ session: participantB.session.id, message }) }
  const agents = [participantA, participantB]
  const agentsBySession = new Map()
  let created = 0
  const sessionController = {
    async create() {
      const sessionId = `pa-session-${created}`
      const agent = agents[created]
      created += 1
      agent.session.id = sessionId
      agentsBySession.set(sessionId, agent)
      return { sessionId }
    },
    async resolveAgent(sessionId) {
      return { agent: agentsBySession.get(sessionId) }
    },
  }
  const rooms = new RoomService({
    sessionController,
    createUserMessage: (message) => message,
    appendRecord: (session, type, data) => events.push({ session, type, data }),
  })
  const room = await rooms.upgradeHost({ agent: hostAgent })
  assert.equal(room.roomId, 'host-session')
  const memberA = await rooms.addLocalParticipant({ roomId: room.roomId, name: 'worker-a' })
  const memberB = await rooms.addLocalParticipant({ roomId: room.roomId, name: 'worker-b' })
  assert.equal(rooms.status(room.roomId).members.length, 3)

  const sent = await rooms.send({ roomId: room.roomId, from: { sessionId: 'host-session' }, to: [memberA.memberId], text: 'read the log' })
  assert.deepEqual(sent.woken, [memberA.memberId])
  assert.equal(followups.length, 1)
  assert.equal(followups[0].session, participantA.session.id)
  assert.match(followups[0].message.content[0].text, /read the log/)
  assert.equal(events.filter((event) => event.type === 'plugin:device-fleet/room-message').length, 1)
  // Room records must be ignorable plugin records; a plain `room/...` type
  // makes the persisted session unreadable for this harness.
  for (const event of events) assert.match(event.type, /^plugin:device-fleet\/room-/)

  const reply = await rooms.send({ roomId: room.roomId, from: { sessionId: participantA.session.id }, to: ['host:host-session', memberB.memberId], text: 'done' })
  assert.deepEqual(reply.woken, [memberB.memberId])
  // A user message without a member id must still guide participants to reply to the Host member.
  followups.length = 0
  await rooms.send({ roomId: room.roomId, from: { kind: 'user' }, to: [memberA.memberId], text: 'are you there?' })
  assert.match(followups.at(-1).message.content[0].text, /to=\["host:host-session"\]/)
  const transcript = rooms.messages({ roomId: room.roomId })
  assert.equal(transcript.length, 3)
  assert.match(transcript[1].fromLabel, /worker-a/)
  assert.equal(transcript[2].fromLabel, '用户')
  await assert.rejects(rooms.send({ roomId: room.roomId, from: { sessionId: 'host-session' }, to: ['nobody'], text: 'x' }), /unknown member/)
})

test('room service: remote participant delegates over RPC and records its reply', async () => {
  const events = []
  let wakeCalls = 0
  const hostAgent = { session: { id: 'host-session', header: { title: 'Host' }, append: async () => ({}) } }
  const remoteReplies = []
  let rooms
  rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    createUserMessage: (message) => message,
    appendRecord: async (session, type, data) => events.push({ type, data }),
    wakeRemote: async (room, member, message) => {
      wakeCalls += 1
      assert.equal(member.kind, 'remote')
      assert.match(message.text, /hello remote/)
      remoteReplies.push(await rooms.recordRemoteReply({ roomId: room.roomId, memberId: member.memberId, text: 'remote answer' }))
      return true
    },
    now: () => 1000,
  })
  const room = await rooms.upgradeHost({ agent: hostAgent })
  const remote = await rooms.addRemoteMember({ roomId: room.roomId, deviceId: 'device-b', name: 'device-b' })
  assert.equal(remote.kind, 'remote')
  assert.equal(remote.deviceId, 'device-b')
  const sent = await rooms.send({ roomId: room.roomId, from: { sessionId: 'host-session' }, to: [remote.memberId], text: 'hello remote' })
  assert.deepEqual(sent.woken, [remote.memberId])
  assert.equal(wakeCalls, 1)
  assert.equal(remoteReplies.length, 1)
  const transcript = rooms.messages({ roomId: room.roomId })
  assert.equal(transcript.length, 2)
  assert.match(transcript[0].text, /hello remote/)
  assert.equal(transcript[1].text, 'remote answer')
  assert.match(transcript[1].fromLabel, /device-b/)
  assert.equal(rooms.status(room.roomId).members.filter((member) => member.kind === 'remote').length, 1)
})

test('room tool handlers reject remote room_create from the hidden execution slot', async () => {
  const handlers = createFleetHandlers({
    node: { peerIds: () => [] },
    rooms: {
      async upgradeHost() {
        throw new Error('should not be called')
      },
    },
    isSlotAgent: () => true,
  })
  const result = await handlers.room_create({}, { agent: { session: { id: 'slot-session' } } })
  assert.match(result.text, /room-create-local-only/)
})

test('remote room peer joins, wakes a persistent session and forwards replies', async () => {
  const followups = []
  const rpc = []
  const peer = new RemoteRoomPeer({
    sessionController: {
      async create() {
        return { sessionId: 'remote-session' }
      },
      async resolveAgent() {
        return { agent: { followup: (message) => followups.push(message) } }
      },
    },
    createUserMessage: (message) => message,
    node: {
      identity: { deviceId: 'device-b' },
      async request(deviceId, method, params) {
        rpc.push({ deviceId, method, params })
        return { ok: true }
      },
    },
    config: {},
  })
  const joined = await peer.join({ roomId: 'room-a', name: 'B', hostDeviceId: 'device-a' })
  assert.equal(joined.sessionId, 'remote-session')
  await peer.wake({ roomId: 'room-a', from: { kind: 'user', name: 'user' }, text: 'hello remote' })
  assert.equal(followups.length, 1)
  assert.match(followups[0].content[0].text, /hello remote/)
  peer.handleSessionEvent({ id: 'remote-session' }, { type: 'assistant/message', data: { content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'persistent reply' }] } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(rpc.length, 1)
  assert.equal(rpc[0].method, 'room.reply')
  assert.equal(rpc[0].params.text, 'persistent reply')
})

test('remote room bridge binds a persistent session and wakes it instead of delegating', async () => {
  const calls = []
  let rooms
  rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    createUserMessage: (message) => message,
    appendRecord: async () => {},
  })
  const bridge = new RemoteRoomBridge({
    node: {
      identity: { deviceId: 'device-a' },
      async request(deviceId, method, params) {
        calls.push({ deviceId, method, params })
        if (method === 'room.join') return { sessionId: 'session-b-1' }
        return { accepted: true }
      },
    },
    rooms,
  })
  rooms.wakeRemote = (room, member, message) => bridge.wakeRemote(room, member, message)
  const hostAgent = { session: { id: 'host-session', header: { title: 'Host' }, append: async () => ({}) } }
  const room = await rooms.upgradeHost({ agent: hostAgent })
  const member = await bridge.addRemoteMember({ roomId: room.roomId, deviceId: 'device-b', name: 'B' })
  assert.equal(member.remoteSessionId, 'session-b-1')
  assert.equal(rooms.status(room.roomId).members.find((entry) => entry.kind === 'remote').remoteSessionId, 'session-b-1')
  await rooms.send({ roomId: room.roomId, from: { sessionId: 'host-session' }, to: [member.memberId], text: 'hello persistent' })
  assert.equal(calls.filter((call) => call.method === 'room.join').length, 1)
  assert.equal(calls.filter((call) => call.method === 'room.wake').length, 1)
  assert.equal(calls.filter((call) => call.method === 'fleet.delegate').length, 0)
})

test('runtime config tolerates a UTF-8 BOM written by Windows editors', () => {
  const dir = tempDir()
  const file = path.join(dir, 'config-overrides.json')
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ deviceName: 'bom-ui', direct: { host: '0.0.0.0', port: 60582 } }), 'utf8')
  const config = new RuntimeConfig({ base: {}, overridesFile: file })
  assert.equal(config.current.deviceName, 'bom-ui')
  assert.equal(config.current.direct.port, 60582)
})

test('room replica: events replay into state and session bindings survive reopen', () => {
  const dir = tempDir()
  const store = new RoomReplicaStore({ dataDir: dir, now: () => 1000 })
  store.append({
    roomId: 'room-replica-1',
    type: 'room.created',
    payload: {
      title: 'Replica',
      policy: { maxMembers: 8 },
      creatorMemberId: 'host:room-replica-1',
      hostSessionId: 'room-replica-1',
      members: [{ memberId: 'host:room-replica-1', role: 'host', kind: 'local', sessionId: 'room-replica-1', name: 'host', avatarKey: 'host' }],
    },
  })
  store.append({
    roomId: 'room-replica-1',
    type: 'member.joined',
    payload: { member: { memberId: 'local:worker-replica', role: 'participant', kind: 'local', sessionId: 'worker-replica', name: 'worker', avatarKey: 'worker' } },
  })
  store.append({
    roomId: 'room-replica-1',
    type: 'message',
    payload: { message: { id: 'm1', roomId: 'room-replica-1', from: { kind: 'user', name: 'user' }, to: ['host:room-replica-1'], text: 'hello', createdAt: 1 } },
  })
  const state = store.state('room-replica-1')
  assert.equal(state.members.length, 2)
  assert.equal(state.messages.length, 1)
  assert.equal(store.memberForSession('worker-replica').memberId, 'local:worker-replica')
  assert.ok(existsSync(store.eventsPath('room-replica-1')))
  const reopened = new RoomReplicaStore({ dataDir: dir })
  const reopenedState = reopened.state('room-replica-1')
  assert.equal(reopenedState.members.length, 2)
  assert.equal(reopenedState.messages[0].text, 'hello')
  reopened.snapshot('room-replica-1')
  assert.ok(existsSync(reopened.snapshotPath('room-replica-1')))
})

test('room replica: legacy rooms.json import is idempotent and binds sessions', () => {
  const dir = tempDir()
  const legacy = {
    rooms: new Map([
      ['legacy-room', {
        roomId: 'legacy-room',
        createdAt: 5,
        hostSessionId: 'legacy-room',
        policy: { maxMembers: 8 },
        members: new Map([
          ['host:legacy-room', { memberId: 'host:legacy-room', role: 'host', kind: 'local', sessionId: 'legacy-room', name: 'host', avatarKey: 'host' }],
          ['local:legacy-worker', { memberId: 'local:legacy-worker', role: 'participant', kind: 'local', sessionId: 'legacy-worker', name: 'worker', avatarKey: 'worker' }],
        ]),
        messages: [{ id: 'old-message', roomId: 'legacy-room', from: { kind: 'user', name: 'user' }, to: ['host:legacy-room'], text: 'legacy', createdAt: 2 }],
        tasks: new Map(),
        closed: false,
      }],
    ]),
  }
  const store = new RoomReplicaStore({ dataDir: dir })
  assert.equal(store.migrateFromRooms(legacy), 1)
  assert.equal(store.migrateFromRooms(legacy), 0)
  const state = store.state('legacy-room')
  assert.equal(state.members.length, 2)
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].text, 'legacy')
  assert.equal(store.memberForSession('legacy-worker').roomId, 'legacy-room')
})

test('mirror room writes locally first and emits a message event for publish', async () => {
  const events = []
  const published = []
  const rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    appendRecord: async () => {},
    replicaStore: {
      deviceId: 'device-b',
      append(event) {
        events.push(event)
        return event
      },
      bindSession() {},
    },
    mirrorPublish: async (room, local) => {
      published.push({ roomId: room.roomId, event: local.event })
    },
  })
  await rooms.createMirror({
    localSessionId: 'mirror-local',
    authority: { deviceId: 'device-a', roomId: 'authority-room' },
    snapshot: { members: [{ memberId: 'host:authority-room', role: 'host', kind: 'local', name: 'host' }], messages: [], tasks: [] },
  })
  const result = await rooms.send({ roomId: 'mirror-local', from: { kind: 'user' }, to: ['host:authority-room'], text: 'local first' })
  assert.ok(result.messageId)
  assert.equal(rooms.rooms.get('mirror-local').messages.length, 1)
  assert.equal(events.filter((event) => event.type === 'message').length, 1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(published.length, 1)
  assert.equal(published[0].event.payload.message.text, 'local first')
})

test('task dependsOn merges as an add-only OR-Set', async () => {
  const rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    appendRecord: async () => {},
    replicaStore: { deviceId: 'device-a', append: (event) => event, bindSession() {} },
  })
  await rooms.upgradeHost({ agent: { session: { id: 'orset-host', header: { title: 'Host' }, append: async () => ({}) } } })
  await rooms.applyExternalEvents('orset-host', [
    { type: 'task.added', payload: { task: { id: 'task-or', title: 't', owner: 'host:orset-host', status: 'pending', dependsOn: ['dep-a'], updatedAt: 10, fieldVersions: {} } } },
    { type: 'task.updated', payload: { task: { id: 'task-or', title: 't', owner: 'host:orset-host', status: 'pending', dependsOn: ['dep-b'], updatedAt: 5, fieldVersions: {} } } },
  ])
  assert.deepEqual(rooms.rooms.get('orset-host').tasks.get('task-or').dependsOn.sort(), ['dep-a', 'dep-b'])
})

test('remote room peer backfills missed wakes once and advances its cursor', async () => {
  const followups = []
  const peer = new RemoteRoomPeer({
    sessionController: {
      async resolveAgent() { return { agent: { followup: async (message) => followups.push(message) } } },
    },
    createUserMessage: (message) => message,
    node: { identity: { deviceId: 'device-b' }, async request() { return { ok: true } } },
    config: {},
    dataDir: tempDir(),
  })
  await peer.bindSession({ sessionId: 'backfill-session', roomId: 'room-a', name: 'B', hostDeviceId: 'device-a' })
  const memberId = 'remote:device-b:backfill-session'
  const messages = [{ id: 'missed-1', createdAt: Date.now() + 5_000, to: [memberId], from: { kind: 'user', name: 'host' }, text: 'missed while offline' }]
  assert.equal(await peer.backfill({ sessionId: 'backfill-session', roomId: 'room-a', messages, hostDeviceId: 'device-a' }), 1)
  assert.equal(followups.length, 1)
  assert.equal(await peer.backfill({ sessionId: 'backfill-session', roomId: 'room-a', messages, hostDeviceId: 'device-a' }), 0)
  assert.equal(followups.length, 1)
})

test('removing a device cascades all its Room members and rotates the key', async () => {
  const rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    appendRecord: async () => {},
    replicaStore: { deviceId: 'device-a', append: (event) => event, bindSession() {} },
  })
  await rooms.upgradeHost({ agent: { session: { id: 'cascade-host', header: { title: 'Host' }, append: async () => ({}) } } })
  await rooms.addRemoteMember({ roomId: 'cascade-host', deviceId: 'device-b', name: 'B1', sessionId: 'session-b1' })
  await rooms.addRemoteMember({ roomId: 'cascade-host', deviceId: 'device-b', name: 'B2', sessionId: 'session-b2' })
  const code = rooms.createInvite({ roomId: 'cascade-host', ttlMs: 60_000 })
  const result = await rooms.removeDeviceMembers({ roomId: 'cascade-host', deviceId: 'device-b' })
  assert.equal(result.removed.length, 2)
  assert.equal(rooms.rooms.get('cascade-host').members.size, 1)
  assert.throws(() => rooms.validateInvite({ code }), /invite key does not match/)
})

test('room close notification is sent to remote mirrors', async () => {
  const calls = []
  const bridge = new RemoteRoomBridge({
    node: { identity: { deviceId: 'device-a' }, async request(deviceId, method, params) { calls.push({ deviceId, method, params }); return { ok: true } } },
    rooms: {},
    timeoutMs: 1_000,
  })
  await bridge.notifyClosed({
    roomId: 'room-close',
    mirror: null,
    members: new Map([['remote:device-b:session-b', { kind: 'remote', deviceId: 'device-b', memberId: 'remote:device-b:session-b' }]]),
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].deviceId, 'device-b')
  assert.equal(calls[0].method, 'room.closed')
  assert.equal(calls[0].params.roomId, 'room-close')
})

test('room replica store signs appended events and rejects bad incoming signatures', () => {
  const dataDir = tempDir()
  const signed = []
  const store = new RoomReplicaStore({
    dataDir,
    deviceId: 'device-a',
    signEvent: (event) => { signed.push(event.type); return 'signature-for-test' },
    verifyEvent: (event) => event.signature === 'good',
  })
  const local = store.append({ roomId: 'signed-room', type: 'message', author: { kind: 'user' }, payload: {} })
  assert.equal(local.signature, 'signature-for-test')
  assert.deepEqual(signed, ['message'])
  const imported = store.importEvents('signed-room', [
    { v: 1, id: 'good-event', roomId: 'signed-room', seq: 9, origin: 'device-b', originSeq: 1, type: 'message', author: { kind: 'user' }, payload: {}, createdAt: 1, signature: 'good' },
    { v: 1, id: 'bad-event', roomId: 'signed-room', seq: 10, origin: 'device-b', originSeq: 2, type: 'message', author: { kind: 'user' }, payload: {}, createdAt: 2, signature: 'bad' },
  ])
  assert.equal(imported, 1)
  const remapped = store.importEvents('local-room', [
    { v: 1, id: 'remapped-event', roomId: 'authority-room', seq: 1, origin: 'device-b', originSeq: 3, type: 'message', author: { kind: 'user' }, payload: {}, createdAt: 3, signature: 'good' },
  ], { sourceRoomId: 'authority-room' })
  assert.equal(remapped, 1)
  assert.equal(store.state('local-room').lastSeq, 1)

  const strictDir = tempDir()
  const strict = new RoomReplicaStore({ dataDir: strictDir, deviceId: 'device-a', verifyEvent: (event) => event.signature === 'good', requireSigned: true })
  assert.equal(strict.importEvents('strict-room', [{ v: 1, id: 'unsigned', roomId: 'strict-room', seq: 1, origin: 'device-b', originSeq: 1, type: 'message', author: { kind: 'user' }, payload: {}, createdAt: 1 }]), 0)
  assert.equal(strict.importEvents('strict-room', [{ v: 1, id: 'signed', roomId: 'strict-room', seq: 1, origin: 'device-b', originSeq: 2, type: 'message', author: { kind: 'user' }, payload: {}, createdAt: 2, signature: 'good' }]), 1)
})

test('superseded snapshot events are compacted without changing state', () => {
  const dataDir = tempDir()
  const store = new RoomReplicaStore({ dataDir, deviceId: 'device-a' })
  store.append({ roomId: 'compact-room', type: 'message', author: { kind: 'user' }, payload: { message: { id: 'm1', text: 'hello' } } })
  for (const marker of [1, 2]) {
    store.append({ roomId: 'compact-room', type: 'room.snapshot', author: { kind: 'system', source: 'test' }, payload: { snapshot: { messages: [{ id: 'm1', text: `snapshot-${marker}` }] } }, localOnly: true })
  }
  assert.equal(store.loadEvents('compact-room').filter((event) => event.type === 'room.snapshot').length, 2)
  const before = store.state('compact-room').messages[0].text
  assert.equal(store.compactSnapshots('compact-room'), 1)
  assert.equal(store.loadEvents('compact-room').filter((event) => event.type === 'room.snapshot').length, 1)
  assert.equal(store.state('compact-room').messages[0].text, before)
})

test('room events are signed with the device key and tampering is rejected', () => {  const keys = generateKeyPairSync('ed25519')
  const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const event = { v: 1, id: 'e1', roomId: 'r1', seq: 1, origin: 'device-a', originSeq: 1, type: 'message', author: { kind: 'user' }, payload: { message: { id: 'm1', text: 'hi' } }, createdAt: 1, prev: null }
  const signature = signRoomEvent(event, privatePem)
  assert.ok(signature)
  assert.equal(verifyRoomEvent({ ...event, signature }, publicPem), true)
  // seq/prev are rewritten when an event crosses a mirror boundary; the
  // signature must stay valid after that remap.
  assert.equal(verifyRoomEvent({ ...event, seq: 99, prev: 'rewritten', signature }, publicPem), true)
  assert.equal(verifyRoomEvent({ ...event, type: 'task.removed', signature }, publicPem), false)
  assert.equal(verifyRoomEvent({ ...event, payload: { message: { id: 'm1', text: 'tampered' } }, signature }, publicPem), false)

  // New events bind the signing key epoch; older events without it still verify.
  const bound = { ...event, rotationSeq: 4 }
  const boundSignature = signRoomEvent(bound, privatePem)
  assert.equal(verifyRoomEvent({ ...bound, signature: boundSignature }, publicPem), true)
  assert.equal(verifyRoomEvent({ ...bound, rotationSeq: 5, signature: boundSignature }, publicPem), false)
})

test('room invite: create/validate and key rotation after member removal', async () => {
  const rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    appendRecord: async () => {},
    replicaStore: { deviceId: 'device-a', append: (event) => event, bindSession() {} },
  })
  const hostAgent = { session: { id: 'invite-host', header: { title: 'Host' }, append: async () => ({}) } }
  await rooms.upgradeHost({ agent: hostAgent })
  const code = rooms.createInvite({ roomId: 'invite-host', ttlMs: 60_000, note: 'test' })
  const invite = rooms.validateInvite({ code })
  assert.equal(invite.roomId, 'invite-host')
  assert.equal(invite.deviceId, 'device-a')
  const member = await rooms.addRemoteMember({ roomId: 'invite-host', deviceId: 'device-b', name: 'B', sessionId: 'remote-session-b' })
  await rooms.removeMember({ roomId: 'invite-host', memberId: member.memberId, reason: 'test' })
  assert.throws(() => rooms.validateInvite({ code }), /invite key does not match/)
  // Removals arriving from a mirror must rotate the key too.
  const member2 = await rooms.addRemoteMember({ roomId: 'invite-host', deviceId: 'device-c', name: 'C', sessionId: 'remote-session-c' })
  const code2 = rooms.createInvite({ roomId: 'invite-host', ttlMs: 60_000 })
  await rooms.applyExternalEvents('invite-host', [{ type: 'member.left', payload: { memberId: member2.memberId } }])
  assert.throws(() => rooms.validateInvite({ code: code2 }), /invite key does not match/)
})

test('remote room peer dedupes the same Room message id', async () => {
  const followups = []
  const peer = new RemoteRoomPeer({
    sessionController: {
      async create() { return { sessionId: 'dedupe-session' } },
      async resolveAgent() { return { agent: { followup: (message) => followups.push(message) } } },
    },
    createUserMessage: (message) => message,
    node: { identity: { deviceId: 'device-b' }, async request() { return { ok: true } } },
    config: {},
  })
  await peer.join({ roomId: 'room-dedupe', name: 'B', hostDeviceId: 'device-a' })
  const first = await peer.wake({ roomId: 'room-dedupe', messageId: 'same-event', from: { kind: 'user' }, text: 'hello' })
  const second = await peer.wake({ roomId: 'room-dedupe', messageId: 'same-event', from: { kind: 'user' }, text: 'hello' })
  assert.equal(first.duplicate, undefined)
  assert.equal(second.duplicate, true)
  assert.equal(followups.length, 1)
})

test('room external events apply task/member/policy with LWW', async () => {
  const rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    appendRecord: async () => {},
    replicaStore: { append: (event) => event, bindSession() {}, deviceId: 'device-a' },
  })
  const hostAgent = { session: { id: 'external-host', header: { title: 'Host' }, append: async () => ({}) } }
  await rooms.upgradeHost({ agent: hostAgent })
  const roomId = 'external-host'
  await rooms.applyExternalEvents(roomId, [
    { type: 'task.added', payload: { task: { id: 'task-x', title: 'from B', owner: 'host:external-host', status: 'pending', dependsOn: [], updatedAt: 10 } } },
    { type: 'task.updated', payload: { task: { id: 'task-x', title: 'newer', owner: 'host:external-host', status: 'running', dependsOn: [], updatedAt: 20 } } },
    { type: 'member.joined', payload: { member: { memberId: 'remote:device-b:session-b', role: 'participant', kind: 'remote', deviceId: 'device-b', name: 'B', avatarKey: 'worker' } } },
    { type: 'policy.updated', payload: { policy: { maxMembers: 9 }, updatedAt: 30 } },
  ])
  assert.equal(rooms.rooms.get(roomId).tasks.get('task-x').title, 'newer')
  assert.equal(rooms.rooms.get(roomId).tasks.get('task-x').status, 'running')
  assert.ok(rooms.rooms.get(roomId).members.has('remote:device-b:session-b'))
  assert.equal(rooms.rooms.get(roomId).policy.maxMembers, 9)
  await rooms.applyExternalEvents(roomId, [
    { type: 'task.updated', payload: { task: { id: 'task-x', title: 'stale', owner: 'host:external-host', status: 'done', dependsOn: [], updatedAt: 5 } } },
  ])
  assert.equal(rooms.rooms.get(roomId).tasks.get('task-x').title, 'newer')
})

test('room service writes mutations into the replica event log', async () => {
  const events = []
  const replica = {
    append(event) {
      events.push(event)
      return event
    },
    bindSession() {},
  }
  const rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    createUserMessage: (message) => message,
    appendRecord: async () => {},
    replicaStore: replica,
  })
  const hostAgent = { session: { id: 'replica-host', header: { title: 'Host' }, append: async () => ({}) } }
  await rooms.upgradeHost({ agent: hostAgent })
  const member = await rooms.addRemoteMember({ roomId: 'replica-host', deviceId: 'device-x', name: 'X', sessionId: 'remote-session-x' })
  await rooms.send({ roomId: 'replica-host', from: { kind: 'user' }, to: [member.memberId], text: 'replica hello' })
  await rooms.addTask({ roomId: 'replica-host', title: 'replica task', owner: member.memberId })
  const types = events.map((event) => event.type)
  assert.deepEqual(types, ['room.created', 'member.joined', 'message', 'task.added'])
  assert.equal(events.find((event) => event.type === 'message').payload.message.text, 'replica hello')
})

test('room replica sync: hello/pull/push converge two stores in both directions', async () => {
  const rootA = tempDir()
  const rootB = tempDir()
  const storeA = new RoomReplicaStore({ dataDir: rootA, deviceId: 'device-a' })
  const storeB = new RoomReplicaStore({ dataDir: rootB, deviceId: 'device-b' })
  storeA.append({
    roomId: 'sync-room',
    type: 'room.created',
    payload: { title: 'Sync', policy: { maxMembers: 8 }, hostSessionId: 'sync-room', creatorMemberId: 'host:sync-room', members: [{ memberId: 'host:sync-room', role: 'host', kind: 'local', sessionId: 'sync-room', name: 'host' }] },
  })
  storeA.append({ roomId: 'sync-room', type: 'message', payload: { message: { id: 'a-message', roomId: 'sync-room', from: { kind: 'user', name: 'user' }, to: ['host:sync-room'], text: 'from A', createdAt: 1 } } })
  let syncA
  let syncB
  const node = {
    async request(deviceId, method, params) {
      const target = deviceId === 'device-b' ? syncB : syncA
      return target[method.replace('room.sync.', '')](params)
    },
  }
  syncA = new RoomReplicaSync({ replica: storeA, node })
  syncB = new RoomReplicaSync({ replica: storeB, node })
  const first = await syncA.syncRoom({ roomId: 'sync-room', peers: ['device-b'] })
  assert.equal(first.pulled, 0)
  assert.equal(first.pushed, 2)
  assert.equal(storeB.state('sync-room').messages.length, 1)
  storeB.append({ roomId: 'sync-room', type: 'message', payload: { message: { id: 'b-message', roomId: 'sync-room', from: { kind: 'user', name: 'user' }, to: ['host:sync-room'], text: 'from B', createdAt: 2 } } })
  const second = await syncB.syncRoom({ roomId: 'sync-room', peers: ['device-a'] })
  assert.equal(second.pushed, 1)
  assert.equal(storeA.state('sync-room').messages.length, 2)
  assert.equal(storeB.state('sync-room').messages.length, 2)
  assert.deepEqual(storeA.vectorClock('sync-room'), storeB.vectorClock('sync-room'))
})

test('room sync backs off failed peers and force bypasses the backoff', async () => {
  const store = new RoomReplicaStore({ dataDir: tempDir(), deviceId: 'device-a' })
  store.append({ roomId: 'backoff-room', type: 'message', author: { kind: 'user' }, payload: { message: { id: 'm1', text: 'hi' } } })
  let calls = 0
  const sync = new RoomReplicaSync({
    replica: store,
    node: { async request() { calls += 1; throw new Error('peer offline') } },
    warn: () => {},
  })
  const first = await sync.syncRoom({ roomId: 'backoff-room', peers: ['device-b'] })
  assert.equal(first.skipped.length, 0)
  assert.equal(calls, 1)
  const second = await sync.syncRoom({ roomId: 'backoff-room', peers: ['device-b'] })
  assert.deepEqual(second.skipped, ['device-b'])
  assert.equal(calls, 1)
  const forced = await sync.syncRoom({ roomId: 'backoff-room', peers: ['device-b'], force: true })
  assert.equal(calls, 2)
  assert.ok(forced.status[0].attempts >= 1)
})

test('three replicas converge through peer sync without a dedicated host path', async () => {
  const dirs = [tempDir(), tempDir(), tempDir()]
  const stores = dirs.map((dataDir, index) => new RoomReplicaStore({ dataDir, deviceId: `device-${index + 1}` }))
  const syncs = {}
  for (let index = 0; index < stores.length; index += 1) {
    const deviceId = `device-${index + 1}`
    const node = {
      identity: { deviceId },
      async request(target, method, params) {
        return syncs[target][String(method).split('.').at(-1)](params)
      },
    }
    syncs[deviceId] = new RoomReplicaSync({ replica: stores[index], node, warn: () => {} })
  }
  stores[0].append({ roomId: 'multi-room', type: 'message', author: { kind: 'user' }, payload: { message: { id: 'm-a', text: 'from A', from: { kind: 'user' }, to: ['host:multi-room'], createdAt: 1 } } })
  for (let round = 0; round < 3; round += 1) {
    await syncs['device-2'].syncRoom({ roomId: 'multi-room', peers: ['device-1', 'device-3'] })
    await syncs['device-3'].syncRoom({ roomId: 'multi-room', peers: ['device-1', 'device-2'] })
    await syncs['device-1'].syncRoom({ roomId: 'multi-room', peers: ['device-2', 'device-3'] })
  }
  assert.deepEqual(stores[1].vectorClock('multi-room'), stores[0].vectorClock('multi-room'))
  assert.deepEqual(stores[2].vectorClock('multi-room'), stores[0].vectorClock('multi-room'))
  assert.equal(stores[2].state('multi-room').messages.length, 1)
  stores[1].append({ roomId: 'multi-room', type: 'message', author: { kind: 'user' }, payload: { message: { id: 'm-b', text: 'from B', from: { kind: 'user' }, to: ['host:multi-room'], createdAt: 2 } } })
  await syncs['device-2'].syncRoom({ roomId: 'multi-room', peers: ['device-3'] })
  await syncs['device-3'].syncRoom({ roomId: 'multi-room', peers: ['device-2'] })
  assert.equal(stores[2].state('multi-room').messages.length, 2)
})

test('room key is encrypted at rest and invites are signed', async () => {
  const keys = generateKeyPairSync('ed25519')
  const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const dataDir = tempDir()
  const stateFile = path.join(dataDir, 'rooms.json')
  const encrypt = (plain) => `enc:${Buffer.from(String(plain)).toString('base64url')}`
  const decrypt = (blob) => Buffer.from(String(blob).slice(4), 'base64url').toString()
  const rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    appendRecord: async () => {},
    stateFile,
    replicaStore: { deviceId: 'device-a', append: (event) => event, bindSession() {} },
    signInvite: (payload) => signJsonValue(payload, privatePem),
    verifyInvite: (payload) => verifyJsonValue(payload, publicPem),
    encryptRoomKey: encrypt,
    decryptRoomKey: decrypt,
  })
  await rooms.upgradeHost({ agent: { session: { id: 'secure-host', header: { title: 'Host' }, append: async () => ({}) } } })
  const code = rooms.createInvite({ roomId: 'secure-host', ttlMs: 60_000 })
  const invite = rooms.validateInvite({ code })
  assert.equal(invite.roomId, 'secure-host')
  assert.ok(invite.signature)
  const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(code, 'base64url').toString()), note: 'changed' })).toString('base64url')
  assert.throws(() => rooms.validateInvite({ code: tampered }), /signature is invalid/)
  const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.ok(stored.rooms[0].keyEnc)
  assert.equal(stored.rooms[0].key, undefined)
  assert.equal(decrypt(stored.rooms[0].keyEnc), rooms.rooms.get('secure-host').key)
})

test('generic event GC keeps state and vector-clock coverage', () => {
  const dataDir = tempDir()
  const store = new RoomReplicaStore({ dataDir, deviceId: 'device-a' })
  for (let index = 0; index < 8; index += 1) {
    store.append({ roomId: 'gc-room', type: 'message', author: { kind: 'user' }, payload: { message: { id: `m${index}`, text: `msg-${index}`, from: { kind: 'user' }, to: ['host:gc-room'], createdAt: index } } })
  }
  const before = store.state('gc-room')
  const clockBefore = store.vectorClock('gc-room')
  assert.ok(store.compactEvents('gc-room', { minEvents: 5 }) > 0)
  const after = store.state('gc-room')
  assert.equal(after.messages.length, before.messages.length)
  assert.equal(store.loadEvents('gc-room').length, 1)
  assert.deepEqual(store.vectorClock('gc-room'), clockBefore)
})

test('sync remap re-signs local events and preserves authority-signed remote events', () => {
  const localKeys = generateKeyPairSync('ed25519')
  const remoteKeys = generateKeyPairSync('ed25519')
  const localPrivate = localKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const localPublic = localKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const remotePrivate = remoteKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const remotePublic = remoteKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const base = { v: 1, id: 'e-local', seq: 1, origin: 'device-local', originSeq: 1, type: 'message', author: { kind: 'user' }, payload: {}, createdAt: 1, prev: null }
  const localEvent = { ...base, roomId: 'local-room', signedRoomId: 'local-room' }
  localEvent.signature = signRoomEvent(localEvent, localPrivate)
  const remoteBase = { ...base, id: 'e-remote', origin: 'device-remote', roomId: 'authority-room', signedRoomId: 'authority-room', seq: 2 }
  remoteBase.signature = signRoomEvent(remoteBase, remotePrivate)
  const remapped = remapReplicaEventsForSync({
    events: [localEvent, { ...remoteBase, roomId: 'local-room' }],
    targetRoomId: 'authority-room',
    localRoomId: 'local-room',
    localDeviceId: 'device-local',
    signEvent: (event) => signRoomEvent(event, localPrivate),
  })
  assert.equal(remapped.length, 2)
  assert.equal(verifyRoomEvent(remapped[0], localPublic), true)
  assert.equal(remapped[0].roomId, 'authority-room')
  assert.equal(verifyRoomEvent(remapped[1], remotePublic), true)
  assert.equal(remapped[1].signature, remoteBase.signature)
})

test('creator metadata backfills for legacy authority rooms', async () => {
  const rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    appendRecord: async () => {},
    replicaStore: { deviceId: 'device-a', append: (event) => event, bindSession() {} },
  })
  await rooms.upgradeHost({ agent: { session: { id: 'legacy-host', header: { title: 'Host' }, append: async () => ({}) } } })
  const room = rooms.rooms.get('legacy-host')
  room.creatorMemberId = null
  room.creatorDeviceId = null
  assert.equal(rooms.backfillCreatorMetadata(), 1)
  assert.equal(room.creatorMemberId, 'host:legacy-host')
  assert.equal(room.creatorDeviceId, 'device-a')
  assert.equal(room.authorityDeviceId, 'device-a')
  assert.equal(room.authorityRoomId, 'legacy-host')
})

test('approval inbox persists every resolution through onAudit', async () => {
  const audits = []
  const inbox = new ApprovalInbox({ ttlMs: 1_000, onAudit: (entry) => audits.push(entry) })
  const waiting = inbox.request({ fromDeviceId: 'dev-a', capability: 'run', tool: 'pwsh' })
  const [pending] = inbox.list()
  inbox.deny(pending.id, 'not now')
  await waiting
  assert.equal(audits.length, 1)
  assert.equal(audits[0].outcome, 'denied')
  assert.equal(audits[0].fromDeviceId, 'dev-a')
})

test('room replica auto-compacts logs above the threshold', () => {
  const dir = tempDir()
  const replica = new RoomReplicaStore({
    dataDir: dir,
    deviceId: 'dev-auto',
    now: () => 1,
  })
  for (let index = 0; index < 4; index += 1) {
    replica.append({ roomId: 'room-auto', type: 'task.add', author: { kind: 'user' }, payload: { title: `t${index}` } })
  }
  const compacted = replica.autoCompact({ minEvents: 4 })
  assert.equal(compacted.length, 1)
  assert.ok(replica.loadEvents('room-auto').length < 4)
})

test('replica state converges on the highest authority epoch', () => {
  const dir = tempDir()
  const replica = new RoomReplicaStore({ dataDir: dir, deviceId: 'device-a', now: () => 1 })
  replica.append({ roomId: 'room-auth', type: 'room.created', author: { kind: 'system' }, payload: { hostSessionId: 'room-auth', policy: {}, members: [] } })
  replica.append({ roomId: 'room-auth', type: 'room.authority', author: { kind: 'system' }, payload: { authorityDeviceId: 'device-b', authorityRoomId: 'room-auth', epoch: 2 } })
  replica.append({ roomId: 'room-auth', type: 'room.authority', author: { kind: 'system' }, payload: { authorityDeviceId: 'device-c', authorityRoomId: 'room-auth', epoch: 1 } })
  const state = replica.state('room-auth')
  assert.equal(state.authorityDeviceId, 'device-b')
  assert.equal(state.authorityEpoch, 2)
})

test('roster signing detects tampering and load rejects it', () => {
  const entries = [{ deviceId: 'device-a', name: 'A', edPublic: 'ed-a', xPublic: 'x-a', addedAt: 1 }]
  const signature = signRoster(entries, 'fleet-secret')
  assert.equal(verifyRoster(entries, signature, 'fleet-secret'), true)
  assert.equal(verifyRoster([{ ...entries[0], edPublic: 'tampered' }], signature, 'fleet-secret'), false)
  assert.equal(verifyRoster(entries, signature, 'wrong-fleet'), false)
})

test('authority Room downgrades to mirror on a higher-epoch claim', async () => {
  const rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    appendRecord: async () => {},
    replicaStore: { deviceId: 'device-a', append: (event) => event, bindSession() {} },
  })
  await rooms.upgradeHost({ agent: { session: { id: 'downgrade-host', header: { title: 'Host' }, append: async () => ({}) } } })
  await rooms.claimAuthority({ roomId: 'downgrade-host' })
  const summary = await rooms.downgradeToMirror({ roomId: 'downgrade-host', authorityDeviceId: 'device-b', authorityRoomId: 'authority-room', epoch: 2 })
  assert.equal(summary.authorityDeviceId, 'device-b')
  assert.equal(summary.authorityRoomId, 'authority-room')
  assert.equal(summary.authorityEpoch, 2)
  assert.equal(rooms.rooms.get('downgrade-host').mirror.deviceId, 'device-b')
  const again = await rooms.downgradeToMirror({ roomId: 'downgrade-host', authorityDeviceId: 'device-c', authorityRoomId: 'authority-room-2', epoch: 3 })
  assert.equal(again.authorityDeviceId, 'device-c')
  assert.equal(again.authorityRoomId, 'authority-room-2')
  assert.equal(again.authorityEpoch, 3)
})

test('mirror promotion preserves authorityRoomId and makes the local session host', async () => {
  const rooms = new RoomService({
    sessionController: { resolveAgent: async (sessionId) => ({ agent: { session: { id: sessionId, header: { title: 'promoted-host' } } } }) },
    appendRecord: async () => {},
    replicaStore: { deviceId: 'device-b', append: (event) => event, bindSession() {} },
  })
  await rooms.createMirror({
    localSessionId: 'mirror-host',
    authority: { deviceId: 'device-a', roomId: 'authority-room' },
    snapshot: {
      members: [
        { memberId: 'host:authority-room', role: 'host', kind: 'local', name: 'old-host' },
        { memberId: 'remote:device-b:mirror-host', role: 'participant', kind: 'remote', deviceId: 'device-b', remoteSessionId: 'mirror-host', name: 'B' },
      ],
      messages: [],
      tasks: [],
    },
  })
  const promoted = await rooms.promoteMirrorToAuthority({ roomId: 'mirror-host' })
  assert.equal(promoted.authorityDeviceId, 'device-b')
  assert.equal(promoted.authorityRoomId, 'authority-room')
  assert.equal(promoted.authorityEpoch, 1)
  const room = rooms.rooms.get('mirror-host')
  assert.equal(room.mirror, null)
  assert.equal(room.members.get('host:mirror-host').role, 'host')
  assert.equal(room.members.get('host:authority-room').kind, 'remote')
  const message = await rooms.send({ roomId: 'mirror-host', from: { kind: 'user' }, to: ['host:mirror-host'], text: 'promoted write' })
  assert.ok(message.messageId)
})

test('automatic mirror promotion requires a stale heartbeat and local coordinator', async () => {
  const rooms = new RoomService({
    sessionController: { resolveAgent: async (sessionId) => ({ agent: { session: { id: sessionId, header: { title: 'auto-host' } } } }) },
    appendRecord: async () => {},
    replicaStore: { deviceId: 'device-b', append: (event) => event, bindSession() {} },
  })
  await rooms.createMirror({
    localSessionId: 'auto-mirror',
    authority: { deviceId: 'device-a', roomId: 'authority-room' },
    snapshot: {
      members: [
        { memberId: 'host:authority-room', role: 'host', kind: 'local', name: 'old-host' },
        { memberId: 'remote:device-b:auto-mirror', role: 'participant', kind: 'remote', deviceId: 'device-b', remoteSessionId: 'auto-mirror', name: 'B' },
      ],
      messages: [],
      tasks: [],
    },
  })
  await assert.rejects(
    rooms.promoteMirrorToAuthority({ roomId: 'auto-mirror', automatic: true }),
    /heartbeat has never been seen/,
  )
  const room = rooms.rooms.get('auto-mirror')
  room.authorityHeartbeatAt = rooms.now() - 20_000
  room.coordinatorDeviceId = 'device-a'
  await assert.rejects(
    rooms.promoteMirrorToAuthority({ roomId: 'auto-mirror', automatic: true }),
    /not the Room coordinator/,
  )
  room.coordinatorDeviceId = 'device-b'
  const promoted = await rooms.promoteMirrorToAuthority({ roomId: 'auto-mirror', automatic: true })
  assert.equal(promoted.authorityDeviceId, 'device-b')
})

test('authority heartbeat only advances for the current authority', async () => {
  let now = 1000
  const rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    appendRecord: async () => {},
    replicaStore: { deviceId: 'device-a', append: (event) => event, bindSession() {} },
    now: () => now,
  })
  await rooms.upgradeHost({ agent: { session: { id: 'beat-host', header: { title: 'Host' }, append: async () => ({}) } } })
  await rooms.claimAuthority({ roomId: 'beat-host' })
  assert.equal(rooms.noteAuthorityHeartbeat({ roomId: 'beat-host', deviceId: 'device-b', epoch: 1 }), false)
  assert.equal(rooms.noteAuthorityHeartbeat({ roomId: 'beat-host', deviceId: 'device-a', epoch: 1 }), true)
  now = 2000
  assert.equal(rooms.noteAuthorityHeartbeat({ roomId: 'beat-host', deviceId: 'device-a', epoch: 1 }), true)
  assert.equal(rooms.summary(rooms.rooms.get('beat-host')).authorityHeartbeatAt, 2000)
})

test('authority claim raises epoch and restores local writes', async () => {
  const rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    appendRecord: async () => {},
    replicaStore: { deviceId: 'device-a', append: (event) => event, bindSession() {} },
  })
  await rooms.upgradeHost({ agent: { session: { id: 'claim-host', header: { title: 'Host' }, append: async () => ({}) } } })
  const claimed = await rooms.claimAuthority({ roomId: 'claim-host' })
  assert.equal(claimed.authorityDeviceId, 'device-a')
  assert.equal(claimed.authorityEpoch, 1)
  await rooms.updateAuthority({ roomId: 'claim-host', authorityDeviceId: 'device-b', authorityRoomId: 'room-b' })
  await assert.rejects(
    rooms.send({ roomId: 'claim-host', from: { kind: 'user' }, to: ['host:claim-host'], text: 'blocked' }),
    /not the current Room authority/,
  )
  const reclaimed = await rooms.claimAuthority({ roomId: 'claim-host' })
  assert.equal(reclaimed.authorityDeviceId, 'device-a')
  assert.equal(reclaimed.authorityEpoch, 3)
  const message = await rooms.send({ roomId: 'claim-host', from: { kind: 'user' }, to: ['host:claim-host'], text: 'allowed' })
  assert.ok(message.messageId)
})

test('authority transfer makes the old authority reject writes', async () => {
  const rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    appendRecord: async () => {},
    replicaStore: { deviceId: 'device-a', append: (event) => event, bindSession() {} },
  })
  await rooms.upgradeHost({ agent: { session: { id: 'auth-host', header: { title: 'Host' }, append: async () => ({}) } } })
  await rooms.updateAuthority({ roomId: 'auth-host', authorityDeviceId: 'device-b', authorityRoomId: 'room-b' })
  await assert.rejects(
    rooms.send({ roomId: 'auth-host', from: { kind: 'user' }, to: ['host:auth-host'], text: 'should fail' }),
    /not the current Room authority/,
  )
})

test('mirror Room routes remote member wakes through mirrorWakeRemote', async () => {
  const routed = []
  const rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    createUserMessage: (message) => message,
    appendRecord: async () => {},
    replicaStore: { deviceId: 'device-b', append: (event) => event, bindSession() {} },
    mirrorPublish: async () => {},
    mirrorWakeRemote: async (room, member, message) => {
      routed.push({ roomId: room.mirror.roomId, memberId: member.memberId, messageId: message.id })
      return true
    },
  })
  await rooms.createMirror({
    localSessionId: 'mirror-remote',
    authority: { deviceId: 'device-a', roomId: 'authority-room' },
    snapshot: {
      members: [
        { memberId: 'host:authority-room', role: 'host', kind: 'remote', name: 'host' },
        { memberId: 'remote:device-c:session-c', role: 'participant', kind: 'remote', deviceId: 'device-c', remoteSessionId: 'session-c', name: 'C' },
      ],
      messages: [],
      tasks: [],
    },
  })
  const result = await rooms.send({ roomId: 'mirror-remote', from: { kind: 'user' }, to: ['remote:device-c:session-c'], text: 'wake C' })
  assert.deepEqual(result.woken, ['remote:device-c:session-c'])
  assert.equal(routed.length, 1)
  assert.equal(routed[0].roomId, 'authority-room')
  assert.equal(routed[0].memberId, 'remote:device-c:session-c')
})

test('mirror Room wakes local participants while the authority is offline', async () => {
  const followups = []
  const rooms = new RoomService({
    sessionController: { resolveAgent: async (sessionId) => (sessionId === 'local-p' ? { agent: { session: { id: sessionId }, followup: (message) => followups.push(message) } } : null) },
    createUserMessage: (message) => message,
    appendRecord: async () => {},
    replicaStore: { deviceId: 'device-b', append: (event) => event, bindSession() {} },
    mirrorPublish: async () => {
      throw new Error('authority offline')
    },
  })
  await rooms.createMirror({
    localSessionId: 'mirror-room',
    authority: { deviceId: 'device-a', roomId: 'authority-room' },
    snapshot: {
      members: [
        { memberId: 'host:authority-room', role: 'host', kind: 'remote', name: 'host' },
        { memberId: 'local:local-p', role: 'participant', kind: 'local', sessionId: 'local-p', name: 'worker' },
      ],
      messages: [],
      tasks: [],
    },
  })
  const member = rooms.rooms.get('mirror-room').members.get('local:local-p')
  member.agent = { session: { id: 'local-p' }, followup: (message) => followups.push(message) }
  const result = await rooms.send({ roomId: 'mirror-room', from: { kind: 'user' }, to: ['local:local-p'], text: 'offline hello' })
  assert.deepEqual(result.woken, ['local:local-p'])
  assert.equal(followups.length, 1)
})

test('room mirror: local participant session displays the authority and writes locally', async () => {
  const published = []
  const rooms = new RoomService({
    sessionController: { resolveAgent: async () => null },
    createUserMessage: (message) => message,
    appendRecord: async () => {},
    replicaStore: { deviceId: 'device-b', append: (event) => event, bindSession() {} },
    mirrorPublish: async (room, local) => {
      published.push({ room, local })
    },
  })
  await rooms.createMirror({
    localSessionId: 'local-session',
    authority: { deviceId: 'device-a', roomId: 'authority-room' },
    snapshot: {
      members: [{ memberId: 'host:authority-room', role: 'host', kind: 'local', name: 'host' }],
      messages: [{ id: 'm1', roomId: 'authority-room', from: { kind: 'user', name: 'user' }, to: ['host:authority-room'], text: 'hello', createdAt: 1 }],
      tasks: [],
    },
  })
  assert.equal(rooms.rooms.get('local-session').mirror.roomId, 'authority-room')
  assert.equal(rooms.detail('local-session').messages.length, 1)
  const result = await rooms.send({ roomId: 'local-session', from: { kind: 'user' }, to: ['host:authority-room'], text: 'via mirror' })
  assert.ok(result.messageId)
  assert.equal(rooms.detail('local-session').messages.length, 2)
  assert.equal(published.length, 1)
  assert.equal(published[0].local.message.text, 'via mirror')
  assert.equal(published[0].local.event.type, 'message')
  await rooms.applyMirrorSnapshot({
    roomId: 'local-session',
    snapshot: {
      members: [
        { memberId: 'host:authority-room', role: 'host', kind: 'local', name: 'host' },
        { memberId: 'local:participant', role: 'participant', kind: 'local', name: 'worker-c' },
      ],
      messages: [
        { id: 'm1', roomId: 'authority-room', from: { kind: 'user', name: 'user' }, to: ['host:authority-room'], text: 'hello', createdAt: 1 },
        { id: 'm2', roomId: 'authority-room', from: { kind: 'agent', memberId: 'local:participant', name: 'worker-c' }, to: ['host:authority-room'], text: 'reply', createdAt: 2 },
      ],
      tasks: [],
    },
  })
  assert.equal(rooms.detail('local-session').members.length, 2)
  assert.equal(rooms.detail('local-session').messages.length, 2)
})

test('room board: serial handoff wakes the next owner, parallel tasks do not', async () => {
  const followups = []
  const hostAgent = { session: { id: 'host-session', append: async () => ({}) } }
  const participantA = { session: { id: 'pa-session' }, followup: (message) => followups.push({ session: 'pa', message }) }
  const participantB = { session: { id: 'pb-session' }, followup: (message) => followups.push({ session: 'pb', message }) }
  const agents = [participantA, participantB]
  const agentsBySession = new Map()
  let created = 0
  const sessionController = {
    async create() {
      const sessionId = `p-session-${created}`
      const agent = agents[created]
      created += 1
      agent.session.id = sessionId
      agentsBySession.set(sessionId, agent)
      return { sessionId }
    },
    async resolveAgent(sessionId) {
      return { agent: agentsBySession.get(sessionId) }
    },
  }
  const rooms = new RoomService({ sessionController, createUserMessage: (message) => message })
  const room = await rooms.upgradeHost({ agent: hostAgent })
  const a = await rooms.addLocalParticipant({ roomId: room.roomId, name: 'a' })
  const b = await rooms.addLocalParticipant({ roomId: room.roomId, name: 'b' })
  const first = await rooms.addTask({ roomId: room.roomId, title: 'first', owner: a.memberId })
  const second = await rooms.addTask({ roomId: room.roomId, title: 'second', owner: b.memberId, dependsOn: [first.id] })
  const parallel = await rooms.addTask({ roomId: room.roomId, title: 'parallel', owner: a.memberId })
  assert.equal(rooms.listTasks(room.roomId).length, 3)

  const reassigned = await rooms.updateTask({ roomId: room.roomId, id: parallel.id, owner: b.memberId })
  assert.equal(reassigned.task.owner, b.memberId)
  await assert.rejects(rooms.updateTask({ roomId: room.roomId, id: parallel.id, owner: 'missing-member' }), /unknown task owner/)

  const doneFirst = await rooms.updateTask({ roomId: room.roomId, id: first.id, status: 'done' })
  assert.equal(doneFirst.handedOff.length, 1)
  assert.equal(doneFirst.handedOff[0].taskId, second.id)
  assert.equal(followups.length, 1)
  assert.match(followups[0].message.content[0].text, /second/)
  assert.equal(parallel.status, 'pending')
  assert.equal(rooms.listTasks(room.roomId).find((task) => task.id === parallel.id).status, 'pending')
})

test('room tool handlers route room operations', async () => {
  const room = { roomId: 'room-1', members: [{ memberId: 'host:room-1', role: 'host' }] }
  const rooms = {
    async upgradeHost() {
      return room
    },
    async addLocalParticipant() {
      return { memberId: 'local:p', name: 'p', sessionId: 'p-session' }
    },
    async removeMember() {
      return { memberId: 'local:p' }
    },
    async send() {
      return { messageId: 'm1', to: ['local:p'], woken: ['local:p'] }
    },
    messages() {
      return [{ createdAt: 1, fromLabel: 'user', to: ['host:room-1'], text: 'hi' }]
    },
    status() {
      return { roomId: 'room-1', members: [] }
    },
    async addTask() {
      return { id: 't1', owner: 'local:p', title: 'task' }
    },
    async updateTask() {
      return { task: { id: 't1', status: 'done' }, handedOff: [] }
    },
    listTasks() {
      return [{ id: 't1', status: 'pending', title: 'task', owner: 'local:p', dependsOn: [] }]
    },
    async close() {
      return { roomId: 'room-1' }
    },
  }
  const node = { identity: { deviceId: 'device-a' }, name: 'A', rosterEntries: () => [], peerIds: () => [], discovered: new Map() }
  const handlers = createFleetHandlers({ node, client: { async call() { return {} }, render: () => '' }, rooms })
  assert.match((await handlers.room_create({}, { agent: { session: { id: 'room-1' } } })).text, /room created: room-1/)
  assert.match((await handlers.room_add_local({ roomId: 'room-1' })).text, /participant added/)
  assert.match((await handlers.room_send({ roomId: 'room-1', to: ['local:p'], text: 'hi' }, { agent: { session: { id: 'room-1' } } })).text, /woke local:p/)
  assert.match((await handlers.room_messages({ roomId: 'room-1' })).text, /hi/)
  assert.match((await handlers.room_task_add({ roomId: 'room-1', title: 'task', owner: 'local:p' })).text, /t1/)
  assert.match((await handlers.room_task_update({ roomId: 'room-1', id: 't1', status: 'done' })).text, /done/)
  assert.match((await handlers.room_task_list({ roomId: 'room-1' })).text, /pending/)
  assert.match((await handlers.room_close({ roomId: 'room-1' })).text, /closed/)
})

test('fleet tool handlers expose the approval inbox and simulation', async () => {
  const node = {
    identity: { deviceId: 'device-a' },
    name: 'A',
    rosterEntries: () => [],
    peerIds: () => [],
    discovered: new Map(),
  }
  const client = { async listTools() { return { tools: [] } }, async call() { return { text: '' } }, render: (r) => r.text }
  const approvals = {
    list: () => [{ id: 'req-1', fromDeviceId: 'device-b', capability: 'run', tool: 'pwsh', expiresInMs: 500, argsSummary: '{}' }],
    approve: () => ({ id: 'req-1', scope: 'once' }),
    deny: () => ({ id: 'req-1' }),
    simulate: async () => 'simulated approval request fake created',
  }
  const handlers = createFleetHandlers({ node, client, approvals })
  assert.match((await handlers.fleet_approvals()).text, /req-1/)
  assert.equal(typeof handlers.fleet_approve, 'undefined')
  assert.equal(typeof handlers.fleet_deny, 'undefined')
  assert.match((await handlers.fleet_simulate_request({})).text, /simulated approval request/)
})

test('direct-call host applies policy, approval and slot execution', async () => {
  const root = tempDir()
  const calls = []
  const slot = {
    async listTools() {
      return [{ name: 'read', description: 'read', parameters: {} }]
    },
    async executeTool({ name, args }) {
      calls.push({ name, args })
      return { isError: false, text: `executed ${name}`, content: [], meta: null }
    },
  }
  const fsService = {
    async resolve(p) {
      return { displayPath: path.resolve(p) }
    },
    async listDir() {
      return [{ name: 'a.txt', type: 'file', size: 3 }]
    },
    async readText() {
      return 'hello'
    },
  }
  const policy = new ToolPolicy({ allowedRoots: [root], capabilities: { read: 'auto', list: 'auto', fetch: 'auto', run: 'ask' } })
  let approvals = 0
  const host = new DirectCallHost({
    slot,
    policy,
    fs: fsService,
    deviceId: 'device-b',
    name: 'B',
    requestApproval: async () => {
      approvals += 1
      return true
    },
  })
  const info = await host.handleRequest({ deviceId: 'device-a', method: 'fleet.info', params: {} })
  assert.equal(info.deviceId, 'device-b')

  const read = await host.handleRequest({
    deviceId: 'device-a',
    method: 'fleet.call',
    params: { capability: 'read', tool: 'read', args: { file_path: path.join(root, 'a.txt') } },
  })
  assert.equal(read.text, 'executed read')
  assert.equal(calls.at(-1).name, 'read')

  await assert.rejects(
    host.handleRequest({
      deviceId: 'device-a',
      method: 'fleet.call',
      params: { capability: 'read', tool: 'read', args: { file_path: path.join(tempDir(), 'a.txt') } },
    }),
    /outside the allowed roots/,
  )

  const run = await host.handleRequest({
    deviceId: 'device-a',
    method: 'fleet.call',
    params: { capability: 'run', args: { command: 'echo hi' } },
  })
  assert.equal(run.meta.capability, 'run')
  assert.equal(approvals, 1)
  assert.equal(calls.at(-1).name, process.platform === 'win32' ? 'pwsh' : 'bash')
  assert.equal(calls.at(-1).args.description, 'remote command from device-a')

  const list = await host.handleRequest({
    deviceId: 'device-a',
    method: 'fleet.call',
    params: { capability: 'list', args: { path: root } },
  })
  assert.match(list.text, /a\.txt/)

  const fetched = await host.handleRequest({
    deviceId: 'device-a',
    method: 'fleet.call',
    params: { capability: 'fetch', args: { path: path.join(root, 'a.txt') } },
  })
  assert.equal(fetched.text, 'hello')
})

test('fleet tool handlers format listings and route typed shortcuts', async () => {
  const node = {
    identity: { deviceId: 'device-a' },
    name: 'A',
    rosterEntries: () => [{ deviceId: 'device-b', name: 'B' }],
    peerIds: () => ['device-b'],
    discovered: new Map(),
    status: () => ({ deviceId: 'device-a', direct: { host: '192.168.137.1', port: 61318 } }),
    addPeerHint: () => {},
    connectAddress: async (host, port) => ({ deviceId: 'device-b', name: 'B', host, port }),
  }
  const calls = []
  const client = {
    async listTools(device) {
      return { tools: [{ name: 'read', description: 'read a file' }] }
    },
    async call(device, request) {
      calls.push({ device, request })
      return { isError: false, text: `${request.capability}:${String(request.tool ?? '')}`, meta: { capability: request.capability, tool: request.tool, deviceId: device, durationMs: 1 } }
    },
    async delegate(device, request) {
      calls.push({ device, request })
      return { text: 'delegated ok', childId: 'child-1', durationMs: 2 }
    },
    render(result) {
      return result.text
    },
  }
  const pairing = {
    async invite() {
      return 'DSHF1.test-invite'
    },
    async join(code) {
      assert.equal(code, 'DSHF1.test-invite')
      joined = true
    },
  }
  let joined = false
  const persistedHints = []
  const handlers = createFleetHandlers({ node, client, pairing, onPeerHint: async (hint) => persistedHints.push(hint) })
  assert.match((await handlers.fleet_status()).text, /61318/)
  assert.match((await handlers.fleet_connect({ host: '192.168.137.2', port: 5555 })).text, /connected to device-b/)
  assert.deepEqual(persistedHints, [{ host: '192.168.137.2', port: 5555 }])
  assert.match((await handlers.fleet_invite()).text, /DSHF1\.test-invite/)
  assert.match((await handlers.fleet_join({ code: 'DSHF1.test-invite' })).text, /Reload the device-fleet plugin/)
  assert.equal(joined, true)
  assert.match((await handlers.fleet_list()).text, /device-b/)
  assert.match((await handlers.fleet_list()).text, /online/)
  assert.match((await handlers.fleet_tools({ device: 'device-b' })).text, /read/)
  assert.match((await handlers.fleet_read({ device: 'device-b', path: 'C:/x.txt' })).text, /read/)
  assert.deepEqual(calls.at(-1).request.args, { file_path: 'C:/x.txt' })
  assert.match((await handlers.fleet_fetch({ device: 'device-b', path: 'C:/x.txt' })).text, /fetch/)
  assert.match((await handlers.fleet_run({ device: 'device-b', command: 'npm test' })).text, /run/)
  assert.equal(calls.at(-1).request.args.command, 'npm test')
  assert.match((await handlers.fleet_delegate({ device: 'device-b', task: 'check the build' })).text, /delegated ok/)
  assert.equal(calls.at(-1).request.task, 'check the build')

  const definitions = createFleetToolDefinitions({
    defineTool: (definition) => definition,
    handlers,
  })
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    [
      'fleet_status',
      'fleet_relay_reconnect',
      'fleet_connect',
      'fleet_queue_call',
      'fleet_queue_delegate',
      'fleet_outbox',
      'fleet_outbox_result',
      'fleet_outbox_cancel',
      'fleet_approvals',
      'fleet_simulate_request',
      'room_create',
      'room_add_remote',
      'room_add_local',
      'room_remove_member',
      'room_send',
      'room_messages',
      'room_status',
      'room_sync',
      'room_members',
      'room_invite_create',
      'room_invite_accept',
      'room_leave',
      'room_remove_device',
      'room_coordinator_update',
      'room_archive',
      'room_restore',
      'room_delete',
      'room_gc',
      'room_policy_update',
      'room_reply',
      'room_authority_promote',
      'room_authority_claim',
      'room_task_add',
      'room_task_update',
      'room_task_list',
      'room_close',
      'fleet_invite',
      'fleet_rotate_identity',
      'fleet_rotation_status',
      'fleet_rotation_compact',
      'fleet_rotation_trust_checkpoint',
      'fleet_revoke_device',
      'fleet_rotation_fork_resolve',
      'fleet_reset_identity',
      'fleet_remove_device',
      'fleet_join',
      'fleet_list',
      'fleet_tools',
      'fleet_call',
      'fleet_delegate',
      'fleet_read',
      'fleet_fetch',
      'fleet_run',
      'fleet_upload',
      'fleet_download',
      'fleet_file_list',
      'fleet_file_delete',
    ],
  )
  assert.equal(typeof textOutput().render, 'function')
})

test('fleet rotation and revocation tools require confirmation and delegate', async () => {
  const calls = []
  const node = {
    identity: { deviceId: 'device-a' },
    name: 'A',
    status: () => ({
      deviceId: 'device-a',
      rotation: { seq: 1, head: 'head-1', records: 2 },
      account: { bound: true, fingerprint: 'Afqo1234' },
      roster: [{ deviceId: 'device-b', revoked: true, rotationSeq: 1, rotationFork: null }],
    }),
  }
  const handlers = createFleetHandlers({
    node,
    rotationStatus: ({ deviceId } = {}) => ({ requested: deviceId ?? null, devices: node.status().roster }),
    compactRotation: async (args) => {
      calls.push(['compact', args])
      return { compacted: true, archived: 16, kept: 64, from: 16 }
    },
    trustRotationCheckpoint: async (args) => {
      calls.push(['trust', args])
      return { deviceId: args.deviceId, status: 'trusted' }
    },
    revokeDevice: async (args) => {
      calls.push(['revoke', args])
      return { deviceId: args.deviceId, revokedAt: 42, rooms: [] }
    },
    resolveRotationFork: async (args) => {
      calls.push(['fork', args])
      return { deviceId: args.deviceId, action: args.action, status: 'kept' }
    },
    resetIdentity: async (args) => {
      calls.push(['reset', args])
      return { deviceId: 'new-device' }
    },
  })

  assert.match((await handlers.fleet_rotation_status()).text, /"rotationSeq": 1/)
  assert.match((await handlers.fleet_rotation_status({ deviceId: 'device-b' })).text, /"requested": "device-b"/)

  assert.match((await handlers.fleet_rotation_compact()).text, /confirmation-required/)
  const compacted = await handlers.fleet_rotation_compact({ keep: 32, confirm: true })
  assert.match(compacted.text, /"archived":16/)
  assert.deepEqual(calls[0], ['compact', { keep: 32, confirm: true }])

  assert.match((await handlers.fleet_rotation_trust_checkpoint({ deviceId: 'device-b' })).text, /confirmation-required/)
  const trusted = await handlers.fleet_rotation_trust_checkpoint({ deviceId: 'device-b', confirm: true })
  assert.match(trusted.text, /"status":"trusted"/)
  assert.deepEqual(calls[1], ['trust', { deviceId: 'device-b', confirm: true }])

  assert.match((await handlers.fleet_revoke_device({ deviceId: 'device-b' })).text, /confirmation-required/)
  assert.equal(calls.length, 2)
  const revoked = await handlers.fleet_revoke_device({ deviceId: 'device-b', reason: 'lost', confirm: true })
  assert.match(revoked.text, /"revokedAt":42/)
  assert.deepEqual(calls[2], ['revoke', { deviceId: 'device-b', reason: 'lost', confirm: true }])

  assert.match((await handlers.fleet_rotation_fork_resolve({ deviceId: 'device-b' })).text, /confirmation-required/)
  const resolved = await handlers.fleet_rotation_fork_resolve({ deviceId: 'device-b', action: 'adopt-peer', confirm: true })
  assert.match(resolved.text, /"action":"adopt-peer"/)
  assert.deepEqual(calls[3], ['fork', { deviceId: 'device-b', action: 'adopt-peer', confirm: true }])

  assert.match((await handlers.fleet_reset_identity()).text, /confirmation-required/)
  const reset = await handlers.fleet_reset_identity({ confirm: true, reason: 'leak' })
  assert.match(reset.text, /new-device/)
  assert.deepEqual(calls[4], ['reset', { confirm: true, reason: 'leak' }])
})

test('file transfer: chunked upload/download roundtrip with checksum and policy gate', async () => {
  const dir = tempDir()
  const source = path.join(dir, 'source.bin')
  const target = path.join(dir, 'target.bin')
  const content = Buffer.from('fleet-binary-'.repeat(200))
  fs.writeFileSync(source, content)
  assert.equal(sha256File(source), sha256File(source))

  const handlers = createFleetHandlers({
    node: {
      async request(device, method, params) {
        if (method === 'fleet.file.put') return writeTransferChunk({ ...params, filePath: params.path })
        if (method === 'fleet.file.get') return readTransferChunk({ ...params, filePath: params.path })
        if (method === 'fleet.file.stat') return statTransferPath({ filePath: params.path })
        if (method === 'fleet.file.list') return listTransferTree({ filePath: params.path, recursive: params.recursive === true })
        if (method === 'fleet.file.delete') return deleteTransferPath({ filePath: params.path, recursive: params.recursive === true })
        throw new Error(`unknown method ${method}`)
      },
    },
  })
  const uploaded = await handlers.fleet_upload({ device: 'device-b', localPath: source, remotePath: target })
  assert.match(uploaded.text, /uploaded \d+ bytes/)
  assert.equal(fs.readFileSync(target).toString(), content.toString())

  // Resume: a truncated remote file is extended from its current size.
  const resumeTarget = path.join(dir, 'resume.bin')
  fs.writeFileSync(resumeTarget, content.subarray(0, 100))
  const resumed = await handlers.fleet_upload({ device: 'device-b', localPath: source, remotePath: resumeTarget, resume: true })
  assert.match(resumed.text, /uploaded/)
  assert.equal(fs.readFileSync(resumeTarget).toString(), content.toString())

  // Directory upload/download with the list RPC.
  const tree = path.join(dir, 'tree')
  fs.mkdirSync(path.join(tree, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(tree, 'a.txt'), 'A')
  fs.writeFileSync(path.join(tree, 'nested', 'b.txt'), 'B')
  const remoteTree = path.join(dir, 'remote-tree')
  const uploadedTree = await handlers.fleet_upload({ device: 'device-b', localPath: tree, remotePath: remoteTree, recursive: true })
  assert.match(uploadedTree.text, /uploaded 2 files/)
  const localTree = path.join(dir, 'local-tree')
  const downloadedTree = await handlers.fleet_download({ device: 'device-b', remotePath: remoteTree, localPath: localTree, recursive: true })
  assert.match(downloadedTree.text, /downloaded 2 files/)
  assert.equal(fs.readFileSync(path.join(localTree, 'nested', 'b.txt'), 'utf8'), 'B')

  const listed = await handlers.fleet_file_list({ device: 'device-b', path: remoteTree, recursive: true })
  assert.match(listed.text, /a\.txt/)
  const deleted = await handlers.fleet_file_delete({ device: 'device-b', path: remoteTree, recursive: true })
  assert.match(deleted.text, /deleted/)
  assert.equal(fs.existsSync(remoteTree), false)

  const copy = path.join(dir, 'copy.bin')
  const downloaded = await handlers.fleet_download({ device: 'device-b', remotePath: target, localPath: copy })
  assert.match(downloaded.text, /downloaded \d+ bytes/)
  assert.equal(fs.readFileSync(copy).toString(), content.toString())

  const corrupt = path.join(dir, 'corrupt.bin')
  assert.throws(
    () => writeTransferChunk({ filePath: corrupt, data: Buffer.from('x').toString('base64'), offset: 0, final: true, expectedSha256: 'wrong' }),
    /checksum/,
  )

  const policy = new ToolPolicy({ allowedRoots: [dir] })
  assert.equal(policy.decide({ capability: 'write', args: { path: path.join(dir, 'a.txt') } }).decision, 'ask')
  assert.equal(policy.decide({ capability: 'write', args: { path: path.join(tempDir(), 'a.txt') } }).decision, 'deny')
})

test('DirectCallClient renders errors and calls', async () => {
  const requests = []
  const node = {
    async request(deviceId, method, params) {
      requests.push({ deviceId, method, params })
      return { isError: false, text: 'ok', meta: { capability: 'read', deviceId, durationMs: 2 } }
    },
  }
  const client = new DirectCallClient({ node })
  const result = await client.call('device-b', { capability: 'read', tool: 'read', args: { file_path: 'x' } })
  assert.match(client.render(result), /ok/)
  assert.equal(requests[0].method, 'fleet.call')
  assert.equal(requests[0].params.capability, 'read')
})

test('lazy execution host retries sessionController until it is composed', () => {
  let controller = null
  let builds = 0
  const lazy = createLazyExecutionHost({
    getSessionController: () => controller,
    build: (value) => {
      builds += 1
      return { host: { controller: value }, slot: { controller: value } }
    },
  })
  assert.equal(lazy.get({ method: 'fleet.info' }), null)
  assert.equal(builds, 0)
  controller = { resolveAgent() {} }
  const first = lazy.get({ method: 'fleet.call' })
  assert.equal(first.host.controller, controller)
  assert.equal(lazy.peek(), first)
  assert.equal(lazy.get({ method: 'fleet.call' }), first)
  assert.equal(builds, 1)
  lazy.reset()
  controller = null
  assert.equal(lazy.get({ method: 'fleet.call' }), null)
  controller = { resolveAgent() {} }
  assert.equal(lazy.get({ method: 'fleet.call' }).host.controller, controller)
  assert.equal(builds, 2)
})
