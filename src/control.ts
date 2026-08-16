/** Remote-Agent control plane for terminal clients. */

import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** Public extension-RPC namespace for the Host control plane. */
export const DSH_HOST_CONTROL_NAMESPACE = 'control'

/** Public extension-RPC method for session-scoped command discovery. */
export const DSH_HOST_COMMAND_CATALOG_METHOD = 'commandCatalog'

export type HostControlOperation =
  | 'shell'
  | 'doctor'
  | 'mcp'
  | 'init'
  | 'btw'
  | 'commands'
  | 'session.mode'
  | 'session.delete'
  | 'provider.setup'

export type HostControlAvailability =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string }

export interface HostControlDescription {
  readonly authority: 'remote-host'
  readonly localFallback: 'forbidden'
  readonly operations: Readonly<Record<HostControlOperation, HostControlAvailability>>
}

export interface HostShellResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly truncated: boolean
}

export interface HostDoctorResult {
  readonly node: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly cwd: string
  readonly sessionId?: string
  readonly sessionAttached: boolean
  readonly apiKeyConfigured: boolean
  readonly home: string
}

export interface HostMcpServer {
  readonly name: string
  readonly tools: readonly string[]
}

export interface HostCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
}

export interface HostCommandCatalogRequest {
  readonly sessionId: string
}

export interface HostCommandCatalogResult {
  readonly commands: readonly HostCommandDescriptor[]
}

export type HostInitResult =
  | { readonly status: 'created'; readonly path: string }
  | { readonly status: 'exists'; readonly path: string }

export interface HostSessionModeSpec {
  readonly id: string
  readonly label?: string
  readonly plan?: boolean
  readonly sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly approval?: 'ask' | 'never'
}

export interface HostProviderSetupRequest {
  readonly route: string
  readonly profile: Record<string, unknown>
  readonly credential?: { readonly ref: string; readonly value: string }
}

export interface HostUnsupportedResult {
  readonly status: 'unsupported'
  readonly operation: 'session.delete'
  readonly reason: string
}

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024
const MAX_INIT_BYTES = 1024 * 1024
const MAX_TIMEOUT_MS = 10 * 60 * 1000
const REMOTE_INITIALIZERS: Array<(this: DshHostControl) => void> = []

const OPERATIONS: HostControlDescription['operations'] = Object.freeze({
  shell: Object.freeze({ supported: true }),
  doctor: Object.freeze({ supported: true }),
  mcp: Object.freeze({ supported: true }),
  init: Object.freeze({ supported: true }),
  btw: Object.freeze({ supported: true }),
  commands: Object.freeze({ supported: true }),
  'session.mode': Object.freeze({ supported: true }),
  'session.delete': Object.freeze({
    supported: false,
    reason: 'The Harness persistence contract does not expose safe physical session deletion.',
  }),
  'provider.setup': Object.freeze({ supported: true }),
})

/**
 * Explicit control plane used only when the Agent itself runs in dsh-host.
 * The local-Agent transparent workspace mode does not call this Service.
 */
export class DshHostControl extends TypertRemoteService {
  static inject = ['agents', 'agentPresets']

  private readonly selfCtx: Context

  constructor(ctx: Context) {
    super(ctx, 'hostControl', { namespace: DSH_HOST_CONTROL_NAMESPACE })
    this.selfCtx = ctx
    for (const initialize of REMOTE_INITIALIZERS) initialize.call(this)
  }

  describe(): HostControlDescription {
    return Object.freeze({
      authority: 'remote-host',
      localFallback: 'forbidden',
      operations: OPERATIONS,
    })
  }

  runShell(command: string, cwd: string, timeoutMs: number | undefined, signal: AbortSignal): Promise<HostShellResult> {
    assertNonEmpty(command, 'command')
    assertAbsoluteDirectory(cwd)
    const timeout = timeoutMs ?? 30_000
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
      throw new Error(`timeoutMs must be an integer from 1 through ${String(MAX_TIMEOUT_MS)}`)
    }
    return runShellCommand(command, cwd, timeout, signal)
  }

  doctor(sessionId: string | undefined, cwd: string | undefined): HostDoctorResult {
    if (sessionId !== undefined) assertNonEmpty(sessionId, 'sessionId')
    if (cwd !== undefined) assertAbsoluteDirectory(cwd)
    const agents = this.selfCtx.get('agents') as unknown as {
      get(id: string): { session: { header?: { cwd?: string } } } | undefined
    }
    const agent = sessionId === undefined ? undefined : agents.get(sessionId)
    return {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: cwd ?? agent?.session.header?.cwd ?? process.cwd(),
      ...(sessionId === undefined ? {} : { sessionId }),
      sessionAttached: agent !== undefined,
      apiKeyConfigured: typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY !== '',
      home: homedir(),
    }
  }

  mcp(sessionId: string): { readonly servers: readonly HostMcpServer[] } {
    assertNonEmpty(sessionId, 'sessionId')
    const agents = this.selfCtx.get('agents') as unknown as {
      get(id: string): { ctx: Context } | undefined
    }
    const agent = agents.get(sessionId)
    if (agent === undefined) throw new Error(`session ${JSON.stringify(sessionId)} is not attached to this Host`)
    const presets = this.selfCtx.get('agentPresets') as unknown as {
      serviceFor(subject: { ctx: Context }, name: 'tools'): unknown
    }
    const tools = (presets.serviceFor(agent, 'tools') ?? this.selfCtx.get('tools')) as {
      schemas(scope?: unknown): readonly { name: string }[]
    } | undefined
    const grouped = new Map<string, string[]>()
    for (const schema of tools?.schemas() ?? []) {
      const match = /^mcp__([a-z0-9-]+)__(.+)$/.exec(schema.name)
      if (match?.[1] === undefined || match[2] === undefined) continue
      const names = grouped.get(match[1]) ?? []
      names.push(match[2])
      grouped.set(match[1], names)
    }
    return {
      servers: [...grouped].map(([name, names]) => ({ name, tools: names.sort() })),
    }
  }

  commandCatalog(sessionId: string): HostCommandCatalogResult {
    assertNonEmpty(sessionId, 'sessionId')
    const agents = this.selfCtx.get('agents') as unknown as {
      get(id: string): { ctx: Context } | undefined
    }
    const agent = agents.get(sessionId)
    if (agent === undefined) throw new Error(`session ${JSON.stringify(sessionId)} is not attached to this Host`)
    const commands = agent.ctx.get('commands') as unknown as {
      list(target: unknown): readonly HostCommandDescriptor[]
    } | undefined
    if (commands === undefined) return { commands: [] }
    return {
      commands: commands.list(agent).map(command => Object.freeze({
        name: command.name,
        description: command.description,
        ...(command.input === undefined ? {} : { input: Object.freeze({ hint: command.input.hint }) }),
      })),
    }
  }

  async init(cwd: string, content: string): Promise<HostInitResult> {
    assertAbsoluteDirectory(cwd)
    if (Buffer.byteLength(content, 'utf8') > MAX_INIT_BYTES) {
      throw new Error(`AGENTS.md content exceeds ${String(MAX_INIT_BYTES)} bytes`)
    }
    const path = join(cwd, 'AGENTS.md')
    try {
      await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
      return { status: 'created', path }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { status: 'exists', path }
      throw error
    }
  }

  async btw(sessionId: string, question: string, signal: AbortSignal): Promise<{ answer: string | null; error?: string }> {
    assertNonEmpty(sessionId, 'sessionId')
    assertNonEmpty(question, 'question')
    const agents = this.selfCtx.get('agents') as unknown as {
      get(id: string): SideQuestionAgent | undefined
    }
    const agent = agents.get(sessionId)
    if (agent === undefined) throw new Error(`session ${JSON.stringify(sessionId)} is not attached to this Host`)
    const llm = this.selfCtx.get('llm') as unknown as {
      stream(options: object): AsyncIterable<StreamChunk>
    } | undefined
    if (llm === undefined) return { answer: null, error: 'The remote Host has no LLM runtime.' }
    const header = agent.session.requestHeader()
    const config = header?.config
    const provider = config?.provider ?? agent.options.provider
    const model = config?.model ?? agent.options.model
    if (provider === undefined || model === undefined) {
      return { answer: null, error: 'The remote session has no model route.' }
    }
    const messages: Message[] = [
      ...agent.session.deriveMessages(),
      createUserMessage({
        content: [{ type: 'text', text: wrapSideQuestion(question) }],
        source: { kind: 'plugin', plugin: 'dsh-host/btw' },
      }),
    ]
    const options: Record<string, unknown> = {
      provider,
      model,
      messages,
      sessionId: agent.id,
      signal,
      ...(header?.system === undefined ? {} : { system: header.system }),
      ...(config?.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
      ...(config?.temperature === undefined ? {} : { temperature: config.temperature }),
      ...(config?.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
      ...(config?.stop === undefined ? {} : { stop: [...config.stop] }),
    }
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of llm.stream(options)) assembler.push(chunk)
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted()
      return { answer: null, error: error instanceof Error ? error.message : String(error) }
    }
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      return { answer: null, error: finish.failure.message }
    }
    const answer = assembler.blocks()
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()
    return answer === '' ? { answer: null, error: 'No response received' } : { answer }
  }

  async setSessionMode(sessionId: string, spec: HostSessionModeSpec, signal: AbortSignal): Promise<HostSessionModeSpec> {
    assertNonEmpty(sessionId, 'sessionId')
    const normalized = normalizeSessionMode(spec)
    const agents = this.selfCtx.get('agents') as unknown as { get(id: string): ModeAgent | undefined }
    const agent = agents.get(sessionId)
    if (agent === undefined) throw new Error(`session ${JSON.stringify(sessionId)} is not attached to this Host`)
    signal.throwIfAborted()

    if (normalized.plan !== undefined && foldBooleanEvent(agent.session.events, 'plan/mode', 'active', false) !== normalized.plan) {
      const commands = this.selfCtx.get('commands') as unknown as {
        execute(target: ModeAgent, line: string, requestSignal: AbortSignal): Promise<{
          result: { kind: 'success' | 'error'; text?: string }
        } | undefined>
      } | undefined
      if (commands === undefined) throw new Error('the remote Host has no command runtime for plan mode')
      const execution = await commands.execute(agent, normalized.plan ? '/plan' : '/plan off', signal)
      if (execution === undefined) throw new Error('the active remote preset does not provide /plan')
      if (execution.result.kind === 'error') throw new Error(execution.result.text ?? 'remote /plan failed')
    }
    signal.throwIfAborted()

    if (normalized.sandbox !== undefined
      && foldStringEvent(agent.session.events, 'sandbox/mode', 'mode') !== normalized.sandbox) {
      agent.session.append('sandbox/mode', { mode: normalized.sandbox })
    }
    if (normalized.approval !== undefined
      && foldStringEvent(agent.session.events, 'approval/policy', 'policy') !== normalized.approval) {
      const approval = agent.ctx.get('approval') as unknown as {
        setPolicy(target: ModeAgent, policy: 'ask' | 'never'): void
      } | undefined
      if (approval === undefined) agent.session.append('approval/policy', { policy: normalized.approval })
      else approval.setPolicy(agent, normalized.approval)
    }
    return normalized
  }

  async setupProvider(request: HostProviderSetupRequest): Promise<{ readonly route: string }> {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(request.route)) throw new TypeError('provider route is invalid')
    if (!isPlainRecord(request.profile)) throw new TypeError('provider profile must be an object')
    const settings = this.selfCtx.get('settings') as unknown as {
      describe(): readonly { ns: string; revision: number }[]
      mutate(
        ns: string,
        ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
        expectedRevision?: number,
      ): Promise<void>
    } | undefined
    const credentials = this.selfCtx.get('credentials') as unknown as {
      resolve(ref: string): Promise<{ value: string; source: string } | undefined>
      set(ref: string, value: string): Promise<void>
      unset(ref: string): Promise<void>
    } | undefined
    if (settings === undefined || credentials === undefined) {
      throw new Error('the remote Host does not expose writable settings and credentials')
    }
    const revision = (): number | undefined =>
      settings.describe().find(descriptor => descriptor.ns === 'llm-pi-ai')?.revision
    if (revision() === undefined) throw new Error('the remote Host has no llm-pi-ai settings namespace')

    const credential = request.credential
    const previous = credential === undefined ? undefined : await credentials.resolve(credential.ref)
    let wroteCredential = false
    try {
      if (credential !== undefined) {
        assertCredentialRef(credential.ref)
        assertNonEmpty(credential.value, 'credential.value')
        await credentials.set(credential.ref, credential.value)
        wroteCredential = true
      }
      const ops = [{ op: 'set' as const, path: ['providers', request.route], value: request.profile }]
      try {
        await settings.mutate('llm-pi-ai', ops, revision())
      } catch (error) {
        if ((error as { code?: unknown })?.code !== 'SETTINGS_CONFLICT') throw error
        await settings.mutate('llm-pi-ai', ops, revision())
      }
      return { route: request.route }
    } catch (error) {
      if (wroteCredential && credential !== undefined) {
        try {
          if (previous === undefined) await credentials.unset(credential.ref)
          else await credentials.set(credential.ref, previous.value)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'provider setup failed and credential rollback also failed')
        }
      }
      throw error
    }
  }

  deleteSession(_sessionId: string): HostUnsupportedResult {
    return unsupported('session.delete')
  }

}

// tsdown intentionally preserves standard decorator syntax at the current
// Node target. Register the exact same Typert initializers explicitly so the
// published Host contains no runtime-unsupported `@Remote` syntax.
for (const method of ['describe', 'runShell', 'doctor', 'mcp', DSH_HOST_COMMAND_CATALOG_METHOD, 'init', 'btw', 'setSessionMode', 'setupProvider', 'deleteSession'] as const) {
  const implementation = DshHostControl.prototype[method]
  const applyRemote = Remote as unknown as (
    value: (...args: never[]) => unknown,
    context: {
      name: string
      private: boolean
      static: boolean
      addInitializer(initializer: (this: DshHostControl) => void): void
    },
  ) => void
  applyRemote(implementation as (...args: never[]) => unknown, {
    name: method,
    private: false,
    static: false,
    addInitializer: initializer => { REMOTE_INITIALIZERS.push(initializer) },
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    hostControl: DshHostControl
  }
}

function unsupported(operation: 'session.delete'): HostUnsupportedResult {
  const availability = OPERATIONS[operation]
  return {
    status: 'unsupported',
    operation,
    reason: availability.supported ? 'unsupported' : availability.reason,
  }
}

interface SideQuestionAgent {
  readonly id: string
  readonly options: { readonly provider?: string; readonly model?: string }
  readonly session: {
    requestHeader(): {
      readonly system?: string
      readonly config?: {
        readonly provider?: string
        readonly model?: string
        readonly reasoningEffort?: string
        readonly temperature?: number
        readonly maxTokens?: number
        readonly stop?: readonly string[]
      }
    } | undefined
    deriveMessages(): Message[]
  }
}

interface ModeAgent {
  readonly ctx: Context
  readonly session: {
    readonly events: ReadonlyArray<{ type: string; data: Record<string, unknown> }>
    append(type: string, data: Record<string, unknown>): unknown
  }
}

function normalizeSessionMode(value: HostSessionModeSpec): HostSessionModeSpec {
  if (typeof value !== 'object' || value === null) throw new TypeError('session mode must be an object')
  assertNonEmpty(value.id, 'mode.id')
  if (value.label !== undefined && typeof value.label !== 'string') throw new TypeError('mode.label must be a string')
  if (value.plan !== undefined && typeof value.plan !== 'boolean') throw new TypeError('mode.plan must be a boolean')
  if (value.sandbox !== undefined && !['read-only', 'workspace-write', 'danger-full-access'].includes(value.sandbox)) {
    throw new TypeError(`unknown sandbox mode ${JSON.stringify(value.sandbox)}`)
  }
  if (value.approval !== undefined && value.approval !== 'ask' && value.approval !== 'never') {
    throw new TypeError(`unknown approval policy ${JSON.stringify(value.approval)}`)
  }
  if (value.plan === undefined && value.sandbox === undefined && value.approval === undefined) {
    throw new TypeError('session mode must declare at least one control atom')
  }
  return Object.freeze({
    id: value.id,
    ...(value.label === undefined ? {} : { label: value.label }),
    ...(value.plan === undefined ? {} : { plan: value.plan }),
    ...(value.sandbox === undefined ? {} : { sandbox: value.sandbox }),
    ...(value.approval === undefined ? {} : { approval: value.approval }),
  })
}

function foldBooleanEvent(
  events: ModeAgent['session']['events'],
  type: string,
  field: string,
  fallback: boolean,
): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === type && typeof event.data[field] === 'boolean') return event.data[field] as boolean
  }
  return fallback
}

function foldStringEvent(events: ModeAgent['session']['events'], type: string, field: string): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === type && typeof event.data[field] === 'string') return event.data[field] as string
  }
  return undefined
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

function assertCredentialRef(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new TypeError('credential ref is invalid')
}

function wrapSideQuestion(question: string): string {
  return `<system-reminder>This is a side question from the user. Answer it directly in one response.
You share the conversation context but are separate from the main Agent. You have no tools and cannot take actions.
Do not promise to inspect, run, search, or change anything. If the answer is not in the conversation context, say so.</system-reminder>\n\n${question}`
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim() === '') throw new Error(`${field} must not be empty`)
}

function assertAbsoluteDirectory(cwd: string): void {
  assertNonEmpty(cwd, 'cwd')
  if (!isAbsolute(cwd)) throw new Error('cwd must be an absolute Host path')
}

async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<HostShellResult> {
  signal.throwIfAborted()
  const child = spawn(command, {
    cwd,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let truncated = false
  let timedOut = false
  const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
    if (current.byteLength >= MAX_COMMAND_OUTPUT_BYTES) { truncated = true; return current }
    const remaining = MAX_COMMAND_OUTPUT_BYTES - current.byteLength
    if (chunk.byteLength > remaining) truncated = true
    return Buffer.concat([current, chunk.subarray(0, remaining)])
  }
  child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
  child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
  const stop = (): void => { child.kill() }
  signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, childSignal) => { resolve({ code, signal: childSignal }) })
    })
    signal.throwIfAborted()
    return {
      exitCode: result.code,
      signal: result.signal,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      timedOut,
      truncated,
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}

export default DshHostControl
