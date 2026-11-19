// Direct-call host/client over the fleet RPC layer (ADR-0003, ADR-0004, ADR-0014).
//
// Host side runs on the resource-owner device: it applies Tool Policy, may ask
// for local approval, then executes through the Execution Slot (or a direct fs
// read for list/fetch). Client side runs on the caller device and backs the
// `fleet_*` model tools.
import { DEFAULT_SHELL_TOOL } from './execution-slot.js'

const DEFAULT_POLICY_TIMEOUT_MS = 60_000

function toolText(result) {
  if (!result) return ''
  if (result.isError) return `Error: ${result.text || 'tool failed'}`
  return result.text ?? ''
}

export class DirectCallHost {
  /**
   * @param {object} options
   * @param {object} options.slot ExecutionSlot
   * @param {import('./tool-policy.js').ToolPolicy} options.policy
   * @param {{resolve: Function, listDir: Function, stat?: Function, readText?: Function}} [options.fs]
   * @param {(request: object) => Promise<boolean>} [options.requestApproval]
   * @param {string} options.deviceId
   * @param {string} [options.name]
   * @param {string} [options.pluginVersion]
   * @param {string} [options.dshVersion]
   * @param {string[]} [options.capabilities]
   * @param {string} [options.shellTool]
   * @param {object} [options.delegation] DelegationHost for `fleet.delegate`
   */
  constructor({
    slot,
    policy,
    fs,
    requestApproval,
    deviceId,
    name = 'device',
    pluginVersion = '0.0.0',
    dshVersion = 'unknown',
    capabilities = [],
    shellTool = DEFAULT_SHELL_TOOL,
    approvalTimeoutMs = DEFAULT_POLICY_TIMEOUT_MS,
    delegation = null,
    onCall = null,
  }) {
    this.slot = slot
    this.policy = policy
    this.fs = fs
    this.requestApproval = requestApproval
    this.deviceId = deviceId
    this.name = name
    this.pluginVersion = pluginVersion
    this.dshVersion = dshVersion
    this.capabilities = capabilities
    this.shellTool = shellTool
    this.approvalTimeoutMs = approvalTimeoutMs
    this.delegation = delegation
    this.onCall = typeof onCall === 'function' ? onCall : null
  }

  info() {
    return {
      deviceId: this.deviceId,
      name: this.name,
      pluginVersion: this.pluginVersion,
      dshVersion: this.dshVersion,
      capabilities: this.capabilities,
      policy: this.policy.summarize(),
    }
  }

  async handleRequest({ deviceId, method, params }) {
    switch (method) {
      case 'fleet.ping':
        return { pong: true, deviceId: this.deviceId }
      case 'fleet.info':
        return this.info()
      case 'fleet.tools':
        return { deviceId: this.deviceId, tools: await this.slot.listTools(), policy: this.policy.summarize() }
      case 'fleet.call': {
        const startedAt = Date.now()
        try {
          const result = await this.handleCall({ fromDeviceId: deviceId, request: params ?? {} })
          this.onCall?.({
            direction: 'inbound', deviceId, at: startedAt, durationMs: Date.now() - startedAt,
            capability: params?.capability ?? 'tool', tool: params?.tool ?? null,
            roomId: params?.roomId ?? null, taskId: params?.taskId ?? null,
            args: params?.args, resultText: result?.text, status: 'ok',
          })
          return result
        } catch (error) {
          this.onCall?.({
            direction: 'inbound', deviceId, at: startedAt, durationMs: Date.now() - startedAt,
            capability: params?.capability ?? 'tool', tool: params?.tool ?? null,
            roomId: params?.roomId ?? null, taskId: params?.taskId ?? null,
            args: params?.args, status: 'error', error: String(error?.message ?? error),
          })
          throw error
        }
      }
      case 'fleet.delegate': {
        if (!this.delegation) {
          throw Object.assign(new Error('delegation is unavailable on this device'), { code: 'unsupported' })
        }
        const startedAt = Date.now()
        try {
          const result = await this.delegation.delegate({ fromDeviceId: deviceId, request: params ?? {} })
          this.onCall?.({
            direction: 'inbound', deviceId, at: startedAt, durationMs: Date.now() - startedAt,
            capability: 'delegate', tool: 'delegate', roomId: params?.roomId ?? null, taskId: params?.taskId ?? null,
            args: { task: params?.task }, resultText: result?.text, status: 'ok', sessionId: result?.childId ?? null,
          })
          return result
        } catch (error) {
          this.onCall?.({
            direction: 'inbound', deviceId, at: startedAt, durationMs: Date.now() - startedAt,
            capability: 'delegate', tool: 'delegate', roomId: params?.roomId ?? null, taskId: params?.taskId ?? null,
            args: { task: params?.task }, status: 'error', error: String(error?.message ?? error),
          })
          throw error
        }
      }
      default:
        throw Object.assign(new Error(`unknown fleet method: ${String(method)}`), { code: 'unknown-method' })
    }
  }

  async handleCall({ fromDeviceId, request }) {
    const capability = request.capability ?? 'tool'
    const tool = request.tool ?? null
    const args = request.args ?? {}
    const roomId = typeof request.roomId === 'string' ? request.roomId : null
    const taskId = typeof request.taskId === 'string' ? request.taskId : null
    const decision = this.policy.decide({ capability, tool, args, roomId, taskId })
    if (decision.decision === 'deny') {
      throw Object.assign(new Error(decision.reason), { code: 'denied', data: { capability, tool } })
    }
    if (decision.decision === 'ask') {
      const outcome = await this.askApproval({ fromDeviceId, capability, tool, args, reason: decision.reason, roomId, taskId })
      if (outcome.approved !== true) {
        throw Object.assign(new Error(outcome.reason ?? 'local approval was not granted'), { code: 'approval_denied' })
      }
      this.policy.grant(decision.key, { scope: outcome.scope ?? 'once', roomId: outcome.roomId ?? roomId, taskId: outcome.taskId ?? taskId })
    }
    const startedAt = Date.now()
    // DSH's shell tools require `description`; fleet_run historically sent only
    // `command`, so the target rejected the call before executing it.
    const executeArgs = capability === 'run'
      ? { ...(args ?? {}), description: args?.description ?? `remote command from ${fromDeviceId ?? 'fleet'}` }
      : args
    const result = await this.execute({ capability, tool, args: executeArgs })
    return {
      ...result,
      meta: {
        ...(result.meta ?? {}),
        capability,
        tool,
        deviceId: this.deviceId,
        durationMs: Date.now() - startedAt,
      },
    }
  }

  async askApproval({ fromDeviceId, capability, tool, args, reason, roomId = null, taskId = null }) {
    if (typeof this.requestApproval !== 'function') return { approved: false, reason: 'no approval channel' }
    try {
      const outcome = await this.requestApproval({ fromDeviceId, capability, tool, args, reason, roomId, taskId })
      if (outcome === true) return { approved: true, scope: 'once' }
      if (outcome && typeof outcome === 'object') {
        return { approved: outcome.approved === true, scope: outcome.scope ?? 'once', roomId: outcome.roomId ?? roomId, taskId: outcome.taskId ?? taskId, reason: outcome.reason }
      }
      return { approved: false, reason: 'approval not granted' }
    } catch (error) {
      return { approved: false, reason: String(error?.message ?? error) }
    }
  }

  async execute({ capability, tool, args }) {
    switch (capability) {
      case 'read':
      case 'grep':
      case 'run':
      case 'tool': {
        // Never let a caller-supplied tool name borrow the auto-approved
        // read/grep/run capability to reach an unrelated (possibly admin) tool.
        let name
        if (capability === 'run') name = this.shellTool
        else if (capability === 'read' || capability === 'grep') name = capability
        else name = tool
        if (typeof name !== 'string' || name === '') {
          throw Object.assign(new Error(`capability ${capability} needs a tool name`), { code: 'bad-request' })
        }
        if (capability === 'tool' && /^(?:fleet_|room_|plugin_)/.test(name)) {
          const allowedReadOnly = new Set(['fleet_status', 'fleet_list', 'fleet_tools', 'fleet_rotation_status'])
          if (!allowedReadOnly.has(name)) {
            throw Object.assign(new Error(`raw remote calls may not invoke management tool ${name}`), { code: 'denied' })
          }
        }
        return this.slot.executeTool({ name, args })
      }
      case 'list':
        return this.readDirectory(args)
      case 'fetch':
        return this.fetchFile(args)
      default:
        throw Object.assign(new Error(`unsupported capability: ${String(capability)}`), { code: 'unsupported' })
    }
  }

  async readDirectory(args) {
    if (!this.fs) throw Object.assign(new Error('filesystem is unavailable'), { code: 'unsupported' })
    const path = String(args?.path ?? args?.dir ?? '')
    if (!path) throw Object.assign(new Error('list needs path'), { code: 'bad-request' })
    const target = await this.fs.resolve(path)
    const entries = await this.fs.listDir(target)
    const lines = entries.map((entry) => `${entry.type}\t${entry.name}${entry.size === undefined ? '' : `\t${entry.size}`}`)
    return { isError: false, text: lines.join('\n') || '(empty directory)', content: [], meta: { path } }
  }

  async fetchFile(args) {
    if (!this.fs) throw Object.assign(new Error('filesystem is unavailable'), { code: 'unsupported' })
    const path = String(args?.path ?? '')
    if (!path) throw Object.assign(new Error('fetch needs path'), { code: 'bad-request' })
    const target = await this.fs.resolve(path)
    if (typeof this.fs.readText !== 'function') {
      throw Object.assign(new Error('fetch is unavailable on this device'), { code: 'unsupported' })
    }
    const text = await this.fs.readText(target)
    return { isError: false, text, content: [], meta: { path, bytes: Buffer.byteLength(text) } }
  }
}

export class DirectCallClient {
  constructor({ node, onCall = null }) {
    this.node = node
    this.onCall = typeof onCall === 'function' ? onCall : null
  }

  async info(deviceId) {
    return this.node.request(deviceId, 'fleet.info', {})
  }

  async listTools(deviceId) {
    return this.node.request(deviceId, 'fleet.tools', {})
  }

  async call(deviceId, { capability, tool = null, args = {}, roomId = null, taskId = null }, options = {}) {
    const startedAt = Date.now()
    try {
      const result = await this.node.request(deviceId, 'fleet.call', { capability, tool, args, ...(roomId ? { roomId } : {}), ...(taskId ? { taskId } : {}) }, options)
      this.onCall?.({
        direction: 'outbound', deviceId, at: startedAt, durationMs: Date.now() - startedAt,
        capability, tool, roomId, taskId, args, resultText: result?.text, status: 'ok',
      })
      return result
    } catch (error) {
      this.onCall?.({
        direction: 'outbound', deviceId, at: startedAt, durationMs: Date.now() - startedAt,
        capability, tool, roomId, taskId, args, status: 'error', error: String(error?.message ?? error),
      })
      throw error
    }
  }

  /** Ask the target device's agent to do a one-shot task and return its final text. */
  async delegate(deviceId, request, options = {}) {
    const startedAt = Date.now()
    try {
      const result = await this.node.request(deviceId, 'fleet.delegate', request, options)
      this.onCall?.({
        direction: 'outbound', deviceId, at: startedAt, durationMs: Date.now() - startedAt,
        capability: 'delegate', tool: 'delegate', roomId: request?.roomId ?? null, taskId: request?.taskId ?? null,
        args: { task: request?.task }, resultText: result?.text, status: 'ok', sessionId: result?.childId ?? null,
      })
      return result
    } catch (error) {
      this.onCall?.({
        direction: 'outbound', deviceId, at: startedAt, durationMs: Date.now() - startedAt,
        capability: 'delegate', tool: 'delegate', roomId: request?.roomId ?? null, taskId: request?.taskId ?? null,
        args: { task: request?.task }, status: 'error', error: String(error?.message ?? error),
      })
      throw error
    }
  }

  /** Format a remote result for a model-facing text tool. */
  render(result) {
    if (result?.isError) return `Error: ${result.text || 'remote tool failed'}`
    const meta = result?.meta ?? {}
    const footer = meta.durationMs !== undefined ? `\n[${String(meta.capability ?? 'call')} on ${String(meta.deviceId ?? 'peer')} · ${String(meta.durationMs)}ms]` : ''
    return `${result?.text ?? ''}${footer}`.trim()
  }
}

export { toolText }
