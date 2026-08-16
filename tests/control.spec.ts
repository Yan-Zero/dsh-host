import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import DshHostControl from '../src/control.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): DshHostControl {
  const context = new Context()
  const events: Array<{ type: string; data: Record<string, unknown> }> = []
  const agent = {
    id: 'session-1',
    ctx: context,
    options: { provider: 'test', model: 'test-model' },
    session: {
      header: { cwd: '/srv/project' },
      events,
      append: (type: string, data: Record<string, unknown>) => { events.push({ type, data }) },
      requestHeader: () => undefined,
      deriveMessages: () => [],
    },
  }
  context.provide('agents', { get: (id: string) => id === 'session-1' ? agent : undefined } as never)
  context.provide('agentPresets', {
    serviceFor: () => ({
      schemas: () => [
        { name: 'mcp__context7__search' },
        { name: 'mcp__context7__resolve' },
        { name: 'read' },
      ],
    }),
  } as never)
  context.provide('llm', {
    async *stream() {
      yield { type: 'text-delta', index: 0, text: 'Remote answer' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  } as never)
  context.provide('commands', {
    list: () => [
      { name: 'plan', description: 'Manage plan mode', input: { hint: 'off' } },
      { name: 'remote-only', description: 'Run a remote-only command' },
    ],
    execute: (_agent: unknown, line: string) => {
      events.push({ type: 'plan/mode', data: { active: line !== '/plan off' } })
      return Promise.resolve({ result: { kind: 'success' as const } })
    },
  } as never)
  context.provide('approval', {
    setPolicy: (_agent: unknown, policy: 'ask' | 'never') => {
      events.push({ type: 'approval/policy', data: { policy } })
    },
  } as never)
  return new DshHostControl(context)
}

describe('remote-Agent Host control plane', () => {
  it('declares remote authority and forbids local fallback', () => {
    const control = fixture()
    expect(control.describe()).toMatchObject({
      authority: 'remote-host',
      localFallback: 'forbidden',
      operations: {
        shell: { supported: true },
        btw: { supported: true },
        commands: { supported: true },
        'session.delete': { supported: false },
      },
    })
    expect(remoteMethods(control).map(method => method.method)).toEqual([
      'describe', 'runShell', 'doctor', 'mcp', 'commandCatalog', 'init', 'btw', 'setSessionMode', 'setupProvider', 'deleteSession',
    ])
  })

  it('runs shell commands in the Host cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-host-control-'))
    roots.push(root)
    const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.cwd())"`
    const result = await fixture().runShell(command, root, 30_000, new AbortController().signal)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(root)
    expect(result.timedOut).toBe(false)
  })

  it('creates AGENTS.md exclusively on the Host filesystem', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-host-init-'))
    roots.push(root)
    const control = fixture()
    await expect(control.init(root, '# Remote\n')).resolves.toEqual({
      status: 'created', path: join(root, 'AGENTS.md'),
    })
    await expect(control.init(root, '# Replaced\n')).resolves.toEqual({
      status: 'exists', path: join(root, 'AGENTS.md'),
    })
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('# Remote\n')
  })

  it('reads MCP tools from the remote session scope', () => {
    expect(fixture().mcp('session-1')).toEqual({
      servers: [{ name: 'context7', tools: ['resolve', 'search'] }],
    })
    expect(() => fixture().mcp('cold-session')).toThrow(/not attached/)
  })

  it('lists only commands registered for the remote session', () => {
    expect(fixture().commandCatalog('session-1')).toEqual({
      commands: [
        { name: 'plan', description: 'Manage plan mode', input: { hint: 'off' } },
        { name: 'remote-only', description: 'Run a remote-only command' },
      ],
    })
    expect(() => fixture().commandCatalog('cold-session')).toThrow(/not attached/)
  })

  it('runs side questions against the remote session LLM without tools', async () => {
    await expect(fixture().btw('session-1', 'why?', new AbortController().signal)).resolves.toEqual({
      answer: 'Remote answer',
    })
  })

  it('applies a session mode beside the remote Agent', async () => {
    const control = fixture()
    await expect(control.setSessionMode('session-1', {
      id: 'plan', plan: true, sandbox: 'read-only', approval: 'ask',
    }, new AbortController().signal)).resolves.toMatchObject({ id: 'plan', plan: true })
  })

  it('reports physical deletion as explicitly unsupported', () => {
    const control = fixture()
    expect(control.deleteSession('session-1')).toMatchObject({ status: 'unsupported', operation: 'session.delete' })
  })

  it('commits provider settings and credentials on the Host', async () => {
    const context = new Context()
    let credential: string | undefined = 'old-key'
    const mutations: unknown[] = []
    context.provide('agents', { get: () => undefined } as never)
    context.provide('agentPresets', {} as never)
    context.provide('settings', {
      describe: () => [{ ns: 'llm-pi-ai', revision: 4 }],
      mutate: (_ns: string, ops: unknown) => { mutations.push(ops); return Promise.resolve() },
    } as never)
    context.provide('credentials', {
      resolve: () => Promise.resolve(credential === undefined ? undefined : { value: credential, source: 'file' }),
      set: (_ref: string, value: string) => { credential = value; return Promise.resolve() },
      unset: () => { credential = undefined; return Promise.resolve() },
    } as never)
    const control = new DshHostControl(context)

    await expect(control.setupProvider({
      route: 'custom-openai',
      profile: { api: 'openai-responses', models: [{ id: 'model-1' }] },
      credential: { ref: 'CUSTOM_OPENAI_API_KEY', value: 'new-key' },
    })).resolves.toEqual({ route: 'custom-openai' })
    expect(credential).toBe('new-key')
    expect(mutations).toHaveLength(1)
  })

  it('restores the previous Host credential when provider settings fail', async () => {
    const context = new Context()
    let credential: string | undefined = 'old-key'
    const writes: string[] = []
    context.provide('agents', { get: () => undefined } as never)
    context.provide('agentPresets', {} as never)
    context.provide('settings', {
      describe: () => [{ ns: 'llm-pi-ai', revision: 4 }],
      mutate: () => Promise.reject(new Error('settings rejected')),
    } as never)
    context.provide('credentials', {
      resolve: () => Promise.resolve({ value: credential, source: 'file' }),
      set: (_ref: string, value: string) => {
        credential = value
        writes.push(value)
        return Promise.resolve()
      },
      unset: () => { credential = undefined; return Promise.resolve() },
    } as never)

    await expect(new DshHostControl(context).setupProvider({
      route: 'custom-openai',
      profile: { api: 'openai-responses' },
      credential: { ref: 'CUSTOM_OPENAI_API_KEY', value: 'new-key' },
    })).rejects.toThrow('settings rejected')
    expect(credential).toBe('old-key')
    expect(writes).toEqual(['new-key', 'old-key'])
  })
})
