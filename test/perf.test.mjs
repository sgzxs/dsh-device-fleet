import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { RoomReplicaStore } from '../src/host/room-replica.js'

const TMP_ROOT = path.join(process.cwd(), 'test', '.tmp')
function tempDir() {
  fs.mkdirSync(TMP_ROOT, { recursive: true })
  return fs.mkdtempSync(path.join(TMP_ROOT, 'perf-'))
}

test('perf: 2000 Room events state + GC stay within budget', () => {
  const store = new RoomReplicaStore({ dataDir: tempDir(), deviceId: 'device-a' })
  const appendStart = Date.now()
  for (let index = 0; index < 2_000; index += 1) {
    store.append({
      roomId: 'perf-room',
      type: 'message',
      author: { kind: 'user' },
      payload: { message: { id: `m${index}`, text: `message-${index}`, from: { kind: 'user' }, to: ['host:perf-room'], createdAt: index } },
    })
  }
  const appendMs = Date.now() - appendStart
  const stateStart = Date.now()
  const state = store.state('perf-room')
  const stateMs = Date.now() - stateStart
  assert.equal(state.messages.length, 2_000)
  const gcStart = Date.now()
  const removed = store.compactEvents('perf-room', { minEvents: 100 })
  const gcMs = Date.now() - gcStart
  assert.equal(removed, 1_999)
  assert.equal(store.state('perf-room').messages.length, 2_000)
  assert.equal(store.loadEvents('perf-room').length, 1)
  // Generous budget: this is a smoke check against accidental O(n²) regressions,
  // not a benchmark; CI runs the suites concurrently on a busy desktop.
  assert.ok(appendMs + stateMs + gcMs < 15_000, `too slow: append=${appendMs} state=${stateMs} gc=${gcMs}`)
  console.log(JSON.stringify({ appendMs, stateMs, gcMs, eventsAfterGc: 1 }))
})
