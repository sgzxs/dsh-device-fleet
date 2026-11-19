// Execution Slot: a hidden DSH session/agent that gives remote direct calls a
// legal tool-execution context (cwd, sandbox policy, approval routing) without
// running any model turn. See ADR-0003 and ADR-0019.
import { randomUUID } from 'node:crypto'

export const DEFAULT_SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'

export class ExecutionSlot {
  /**
   * @param {{sessionController: object, tools: object, config?: {cwd?: string, agentPreset?: string}}} options
   */
  constructor({ sessionController, tools, config = {} }) {
    this.sessionController = sessionController
    this.tools = tools
    this.config = config
    this.agent = null
    this.sessionId = null
    this.initializing = null
  }

  /** Replace the slot's creation config; the next call lazily recreates the agent. */
  setConfig(next = {}) {
    this.config = { ...this.config, ...(next ?? {}) }
    this.agent = null
    this.sessionId = null
    this.initializing = null
  }

  async ensureAgent() {
    if (this.agent) return this.agent
    if (this.initializing) return this.initializing
    this.initializing = (async () => {
      const created = await this.sessionController.create({
        cwd: this.config.cwd,
        agentPreset: this.config.agentPreset,
      })
      const sessionId = created?.sessionId
      if (!sessionId) throw Object.assign(new Error('execution slot could not create a session'), { code: 'slot-unavailable' })
      const resolved = await this.sessionController.resolveAgent(sessionId)
      if (!resolved?.agent) {
        const reason = resolved?.error?.code ?? 'session/agent-busy'
        throw Object.assign(new Error(`execution slot agent unavailable: ${String(reason)}`), { code: 'slot-unavailable' })
      }
      this.sessionId = sessionId
      this.agent = resolved.agent
      return this.agent
    })().finally(() => {
      this.initializing = null
    })
    return this.initializing
  }

  /** Model-facing tool schemas visible to the execution slot agent. */
  async listTools() {
    const agent = await this.ensureAgent()
    const schemas = this.tools.schemas?.(agent) ?? this.tools.schemas?.() ?? []
    return schemas
  }

  /**
   * Execute one tool inside the slot context and normalize the result.
   * @param {{name: string, args: object, signal?: AbortSignal}} call
   */
  async executeTool({ name, args = {}, signal }) {
    const agent = await this.ensureAgent()
    // execToolBatch requires a real AbortSignal: without one the pipeline
    // throws before dispatch, which surfaces as "Tool batch execution failed".
    const effectiveSignal = signal ?? new AbortController().signal
    let batch
    try {
      batch = await this.tools.execute({
        calls: [{ id: randomUUID(), name, arguments: JSON.stringify(args ?? {}) }],
        agent,
        signal: effectiveSignal,
      })
    } catch (error) {
      const cause = error?.cause
      const detail = cause?.message ?? error?.message ?? String(error)
      throw Object.assign(new Error(`tool ${name} failed: ${String(detail)}`), {
        code: 'tool-failed',
        cause,
        data: { causeCode: cause?.code ?? null, causeMessage: cause?.message ?? null },
      })
    }
    const first = batch?.results?.[0]?.result
    if (!first) throw Object.assign(new Error(`tool ${name} returned no result`), { code: 'tool-no-result' })
    const text = (first.content ?? [])
      .map((block) => (block?.type === 'text' ? block.text : `[${String(block?.type ?? 'block')}]`))
      .join('\n')
    return {
      isError: first.isError === true,
      text,
      content: first.content ?? [],
      error: first.error ?? null,
      meta: first.meta ?? null,
    }
  }

  /** Tool names currently visible to the slot agent. */
  async toolNames() {
    const tools = await this.listTools()
    return tools.map((tool) => tool.name).filter((name) => typeof name === 'string')
  }
}
