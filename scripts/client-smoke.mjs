import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')
let captured = null
let hostFetch = null
const sandbox = {
  window: {
    __FLEET_SMOKE__: true,
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
  },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL,
  JSON,
  Date,
  Math,
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: (...args) => {
    if (!hostFetch) return Promise.reject(new Error('fetch not ready'))
    return hostFetch(...args)
  },
}
sandbox.globalThis = sandbox
const context = vm.createContext(sandbox)
vm.runInContext(source, context, { filename: 'client.js' })
if (!captured) throw new Error('module loader was not called')

// ---- minimal hooks renderer -------------------------------------------------
const hooks = []
let cursor = 0
let dirty = true
let effects = []
let mounted = false
const setValue = (index, next) => {
  const value = typeof next === 'function' ? next(hooks[index].value) : next
  if (Object.is(value, hooks[index].value)) return
  hooks[index].value = value
  dirty = true
}
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity) }
  },
  Fragment: 'Fragment',
  Component: class {
    constructor(props) {
      this.props = props ?? {}
      this.state = {}
    }
    setState(update) {
      this.state = { ...this.state, ...(typeof update === 'function' ? update(this.state) : update) }
    }
  },
  useState(initial) {
    const index = cursor++
    if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    return [hooks[index].value, (next) => setValue(index, next)]
  },
  useEffect(effect) {
    effects.push(effect)
  },
  useRef(initial) {
    return { current: initial }
  },
}
const requireStub = (id) => {
  if (id === 'react') return React
  if (id === 'react-dom') return { createPortal: (children) => children }
  throw new Error('unexpected require ' + id)
}

const module = captured.factory(requireStub)
const registrations = []
// Model the real slot registry: a slot only exists after its declaring entry
// registers it, `register` on an undeclared slot throws, and `inject` defers
// until the declaration arrives. Client entries are all created concurrently,
// so the plugin's apply must never assume another UI package already ran.
const declared = new Set()
const pendingInjects = []
const flushInjects = () => {
  let progressed = true
  while (progressed) {
    progressed = false
    for (let index = 0; index < pendingInjects.length; index += 1) {
      const [name, callback] = pendingInjects[index]
      if (!declared.has(name)) continue
      pendingInjects.splice(index, 1)
      callback()
      progressed = true
      index -= 1
    }
  }
}
const slots = {
  inject(name, callback) {
    if (!declared.has(name)) {
      pendingInjects.push([name, callback])
      return () => {}
    }
    return callback()
  },
  register(options, component) {
    if (!declared.has(options.name)) {
      throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
    }
    registrations.push({ options, component })
    return () => {}
  },
  declare(...names) {
    for (const name of names) declared.add(name)
    flushInjects()
  },
}
const ctx = {
  slots,
  effect(fn) {
    try {
      return fn()
    } catch {
      return () => {}
    }
  },
}
// Activation must succeed before any slot is declared; otherwise the client
// entry fails and the whole page reports "dsh-device-fleet: failed".
module.apply(ctx)
if (registrations.length !== 0) throw new Error('registered into undeclared slots')
console.log('activation before slot declarations ok')
// dsh-client-ui-layout declares main/shell.overlay; ui-chat/ui-conversation and
// the plugin manager declare the rest.
slots.declare('main', 'shell.overlay', 'sidebar.footer.action', 'sidebar.panellist')
slots.declare('conversation.composer.dock', 'conversation.view', 'conversation.input.overlay')
slots.declare('plugins.row.config', 'plugins.bundle.config')
if (pendingInjects.length !== 0) throw new Error(`deferred injects never ran: ${pendingInjects.map(([name]) => name).join(', ')}`)
console.log('all deferred slot registrations ran:', registrations.length)

hostFetch = async (url) => {
  const target = String(url)
  if (target.includes('/device-fleet/overview')) {
    return {
      ok: true,
      json: async () => ({
        deviceId: 'device-a',
        name: 'desktop-ui',
        pluginVersion: '0.1.0-dev.18',
        direct: { host: '0.0.0.0', port: 60580 },
        discovery: { peers: [] },
        relay: null,
        roster: [
          { deviceId: 'device-b', name: 'B', rotationSeq: 1, rotationHead: 'head-b' },
          { deviceId: 'device-c', name: 'C', revoked: true, revokedAt: 1, revokedBy: 'device-a', revocationReason: 'lost key', rotationSeq: 2, rotationHead: 'head-c' },
          {
            deviceId: 'device-d',
            name: 'D',
            revocationPending: { by: 'device-c', at: 2, seq: 0, reason: 'key leaked' },
            rotationFork: { seq: 2, localHead: 'aaaaaaaaaa', remoteHead: 'bbbbbbbbbb', detectedAt: 3, source: 'handshake' },
          },
        ],
        connected: ['device-b'],
        rotation: { seq: 1, head: 'head-a', records: 2, from: 0 },
        relay: {
          online: true,
          candidates: 1,
          list: [{ host: '127.0.0.1', port: 7000, dataPort: 7001, source: 'config', persistent: true, online: true, failures: 0, ageMs: 0, tls: { servername: 'localhost', hasCa: true } }],
        },
        archivedRooms: [{ roomId: 'room-archived-1234', lastSeq: 12, updatedAt: 1, inMemory: true }],
        peerHints: [],
        rooms: [{ roomId: 'room-1', createdAt: 1, policy: {}, members: [{ memberId: 'host:room-1', role: 'host', kind: 'local', sessionId: 'room-1', name: 'host' }, { memberId: 'local:p', role: 'participant', kind: 'local', sessionId: 'p', name: 'worker' }], messageCount: 1, tasks: 1, closed: false }],
        approvals: [],
        approvalHistory: [],
        notifications: [{ id: 'n1', kind: 'approval', title: 'remote approval', body: 'from B', createdAt: 1, read: false }],
        notificationsUnread: 1,
      }),
    }
  }
  if (target.includes('/device-fleet/config')) {
    return {
      ok: true,
      json: async () => ({
        config: {
          deviceName: 'desktop-ui',
          relay: { tls: {} },
          execution: {},
          policy: { allowedRoots: [], capabilities: {}, allowedTools: [], approvalTtlMs: 900000 },
          approvals: { ttlMs: 60000, maxPending: 50, simulation: false },
          invite: { ttlMs: 86400000 },
          rotation: { checkpointQuorum: 1 },
          notifications: { timeoutMs: 5000, webhook: '' },
          replica: { autoCompactMinEvents: 800 },
          room: { rotationSeqMode: 'audit' },
        },
      }),
    }
  }
  if (target.includes('/device-fleet/room?')) {
    return {
      ok: true,
      json: async () => ({
        room: {
          roomId: 'room-1',
          members: [{ memberId: 'host:room-1', role: 'host', kind: 'local', sessionId: 'room-1', name: 'host' }, { memberId: 'local:p', role: 'participant', kind: 'local', sessionId: 'p', name: 'worker' }],
          messages: [{ id: 'm1', createdAt: 1, fromLabel: 'host', from: { kind: 'user' }, to: ['local:p'], text: 'hi' }],
          tasks: [{ id: 't1', title: 'task', owner: 'local:p', status: 'pending', dependsOn: [] }],
        },
      }),
    }
  }
  if (target.includes('/device-fleet/rooms')) return { ok: true, json: async () => ({ rooms: [] }) }
  return { ok: true, json: async () => ({}) }
}

const findComponent = (key) => registrations.find((entry) => entry.options.name === 'main' && entry.options.key === key)?.component
const FleetConsole = findComponent('fleet')
if (!FleetConsole) throw new Error('fleet main component not registered')

const queue = []
let renderedComponent = null
async function pump(component, props = {}, rounds = 20) {
  if (renderedComponent !== component) {
    hooks.length = 0
    renderedComponent = component
  }
  effects = []
  cursor = 0
  const tree = component(props)
  const pending = effects.splice(0)
  for (const effect of pending) {
    const cleanup = effect()
    if (typeof cleanup === 'function') queue.push(cleanup)
  }
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return tree
}

const walk = (node, visit) => {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  if (node.children) for (const child of node.children) walk(child, visit)
  if (node.props && node.props.children) walk(node.props.children, visit)
}

let tree = await pump(FleetConsole)
console.log('initial render ok')
tree = await pump(FleetConsole)
console.log('overview render ok')

let roomsTab = null
walk(tree, (node) => {
  if (node.type === 'button' && node.children.includes('房间')) roomsTab = node
})
console.log('rooms tab found:', Boolean(roomsTab))
if (roomsTab) {
  roomsTab.props.onClick()
  tree = await pump(FleetConsole)
  const collectText = (node, out = []) => {
    if (typeof node === 'string') out.push(node)
    else if (Array.isArray(node)) node.forEach((item) => collectText(item, out))
    else if (node && typeof node === 'object') {
      node.children.forEach((item) => collectText(item, out))
      if (node.props?.children) collectText(node.props.children, out)
    }
    return out
  }
  let roomButton = null
  walk(tree, (node) => {
    const text = collectText(node)
    if (node.type === 'button' && text.some((item) => item.includes('位成员'))) roomButton = node
  })
  console.log('room button found:', Boolean(roomButton))
  if (roomButton) {
    roomButton.props.onClick()
    for (let index = 0; index < 4; index += 1) tree = await pump(FleetConsole)
    console.log('room detail render ok')
  }
}
let notificationsTab = null
walk(tree, (node) => {
  if (node.type === 'button' && node.children.some((child) => typeof child === 'string' && child.startsWith('通知'))) notificationsTab = node
})
console.log('notifications tab found:', Boolean(notificationsTab))
if (notificationsTab) {
  notificationsTab.props.onClick()
  tree = await pump(FleetConsole)
  const notificationTitle = []
  walk(tree, (node) => {
    if (node.type === 'div' && node.children.some((child) => typeof child === 'string' && child.includes('remote approval'))) notificationTitle.push(node)
  })
  console.log('notification render ok:', notificationTitle.length > 0)
}
let configTab = null
walk(tree, (node) => {
  if (node.type === 'button' && node.children.includes('配置')) configTab = node
})
console.log('config tab found:', Boolean(configTab))
if (configTab) {
  configTab.props.onClick()
  for (let index = 0; index < 3; index += 1) tree = await pump(FleetConsole)
  const configTexts = []
  walk(tree, (node) => {
    if (typeof node === 'string') configTexts.push(node)
    else if (node && typeof node === 'object' && node.children) node.children.forEach((child) => { if (typeof child === 'string') configTexts.push(child) })
  })
  console.log('config form render ok:', configTexts.some((text) => text.includes('保存配置') || text.includes('基础')))
}
const roomViewRegistration = registrations.find((entry) => entry.options.name === 'conversation.view' && entry.options.id === 'room')
if (!roomViewRegistration) throw new Error('room conversation view not registered')
let roomTree = await pump(roomViewRegistration.component, { sessionId: 'room-1' })
roomTree = await pump(roomViewRegistration.component, { sessionId: 'room-1' })
console.log('room view render ok')

const dockRegistration = registrations.find((entry) => entry.options.name === 'conversation.composer.dock' && entry.options.id === 'fleet-room')
if (!dockRegistration) throw new Error('room composer dock not registered')
await pump(dockRegistration.component, { sessionId: 'room-1' })
console.log('room dock render ok')


const mentionRegistration = registrations.find((entry) => entry.options.name === 'conversation.input.overlay' && entry.options.id === 'fleet-room-mention')
if (!mentionRegistration) throw new Error('room mention overlay not registered')
await pump(mentionRegistration.component, {
  sessionId: 'room-1',
  useInput: (selector) => selector({ draft: '@w', attachments: [] }),
  inputActions: { insertText: () => {} },
})
console.log('room mention overlay render ok')

const configRegistration = registrations.find((entry) => entry.options.name === 'plugins.row.config' || entry.options.name === 'plugins.bundle.config')
if (configRegistration) throw new Error('plugin config page should have been removed')
console.log('plugin config page removed ok')

console.log('smoke test passed')
process.exit(0)
