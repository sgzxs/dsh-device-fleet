// Cross-device delegation (ADR-0015): the caller asks the target device's
// agent to do a one-shot task and gets the final assistant output back.
//
// On the target device this runs through the official SubagentProvider
// contract with `delivery: 'caller'`, so the child agent's own model turn and
// tools run on that device, and the `result` promise resolves with the final
// content blocks. No Room, no shared history: delegation is a one-shot task.
const DEFAULT_DELEGATE_TIMEOUT_MS = 180_000
const DEFAULT_PROVIDER = 'spawn'
const DEFAULT_LABEL = 'fleet delegation'

function textOf(result) {
  const blocks = Array.isArray(result?.output) ? result.output : []
  return blocks
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function withTimeout(promise, timeoutMs, onTimeout) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), timeoutMs)
      timer.unref?.()
    }),
  ])
}

export class DelegationHost {
  /**
   * @param {object} options
   * @param {object} options.subagents ctx.subagents service
   * @param {object} options.slot ExecutionSlot
   * @param {import('./tool-policy.js').ToolPolicy} options.policy
   * @param {(request: object) => Promise<boolean>} [options.requestApproval]
   * @param {string} [options.deviceId]
   * @param {string} [options.defaultCwd]
   * @param {string} [options.defaultAgentPreset]
   * @param {string} [options.provider]
   * @param {number} [options.timeoutMs]
   */
  constructor({
    subagents,
    slot,
    policy,
    requestApproval,
    deviceId,
    defaultCwd,
    defaultAgentPreset,
    provider = DEFAULT_PROVIDER,
    timeoutMs = DEFAULT_DELEGATE_TIMEOUT_MS,
    onChild = null,
  }) {
    this.subagents = subagents
    this.slot = slot
    this.policy = policy
    this.requestApproval = requestApproval
    this.deviceId = deviceId
    this.defaultCwd = defaultCwd
    this.defaultAgentPreset = defaultAgentPreset
    this.provider = provider
    this.timeoutMs = timeoutMs
    this.onChild = typeof onChild === 'function' ? onChild : null
  }

  async delegate({ fromDeviceId, request = {} }) {
    const task = typeof request.task === 'string' ? request.task.trim() : ''
    if (task === '') throw Object.assign(new Error('delegate needs a non-empty task'), { code: 'bad-request' })

    const decision = this.policy.decide({ capability: 'delegate', args: {}, roomId: request.roomId ?? null, taskId: request.taskId ?? null })
    if (decision.decision === 'deny') {
      throw Object.assign(new Error(decision.reason), { code: 'denied', data: { capability: 'delegate' } })
    }
    if (decision.decision === 'ask') {
      const outcome =
        typeof this.requestApproval === 'function'
          ? await this.requestApproval({ fromDeviceId, capability: 'delegate', tool: 'delegate', args: { task }, reason: decision.reason, roomId: request.roomId ?? null, taskId: request.taskId ?? null })
          : { approved: false, reason: 'no approval channel' }
      const approved = outcome === true || outcome?.approved === true
      if (!approved) {
        throw Object.assign(new Error(outcome?.reason ?? 'local approval was not granted'), { code: 'approval_denied' })
      }
      this.policy.grant(decision.key, { scope: outcome?.scope ?? 'once', roomId: outcome?.roomId ?? request.roomId, taskId: outcome?.taskId ?? request.taskId })
    }

    const agent = await this.slot.ensureAgent()
    const controller = new AbortController()
    const startedAt = Date.now()
    const cwd = request.cwd ?? this.defaultCwd
    const agentPreset = request.agentPreset ?? this.defaultAgentPreset
    const base = {
      provider: request.provider ?? this.provider,
      label: typeof request.label === 'string' && request.label !== '' ? request.label : DEFAULT_LABEL,
      parent: agent,
      prompt: [{ type: 'text', text: task }],
      ...(cwd ? { cwd } : {}),
      ...(agentPreset ? { agentPreset } : {}),
      signal: controller.signal,
      delivery: 'caller',
    }
    // DSH rc.3 flattens the activation spec; keep a legacy request-shaped
    // fallback for older hosts that still wrap parent/prompt/cwd in `request`.
    const legacy = {
      provider: base.provider,
      label: base.label,
      request: {
        prompt: base.prompt,
        parent: agent,
        ...(cwd ? { cwd } : {}),
        ...(agentPreset ? { agentPreset } : {}),
      },
      signal: controller.signal,
      delivery: 'caller',
    }
    let activation
    try {
      try {
        activation = await this.subagents.startActivation(base)
      } catch (error) {
        const message = String(error?.message ?? error)
        if (!message.includes("reading 'id'") && !message.includes('reading "id"')) throw error
        activation = await this.subagents.startActivation(legacy)
      }
      if (activation?.childId) this.onChild?.(activation.childId, fromDeviceId)
      const result = await withTimeout(
        activation.result,
        Number.isFinite(request.timeoutMs) ? request.timeoutMs : this.timeoutMs,
        () => {
          controller.abort()
          return Object.assign(new Error('delegation timed out; the child agent was asked to stop'), { code: 'delegate-timeout' })
        },
      )
      return {
        text: textOf(result) || '(delegated agent returned no text)',
        stopReason: result?.stopReason ?? null,
        childId: activation.childId,
        durationMs: Date.now() - startedAt,
      }
    } finally {
      try {
        await activation?.dispose?.()
      } catch {
        /* best effort */
      }
    }
  }
}
