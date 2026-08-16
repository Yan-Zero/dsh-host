import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import DshHostProtocol, {
  DSH_HOST_EVENTS_PATH,
  DSH_HOST_MUX_EVENTS_PATH,
  DSH_HOST_PROTOCOL_PATH,
} from '../src/protocol.js'
import { DSH_HOST_CAPABILITIES, DSH_HOST_COMMAND_CATALOG_CAPABILITY } from '../src/constants.js'
import DshHostServer from '../src/server.js'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function emptyFrames(): AsyncIterable<never> {
  return { async *[Symbol.asyncIterator]() {} }
}

async function fixture(): Promise<{ base: string; token: string }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-protocol-'))
  roots.push(root)
  const context = new Context()
  contexts.push(context)
  await context.plugin(DshHostServer, {
    host: '127.0.0.1', port: 0, tokenFile: join(root, 'token'), tokenMode: 'managed', preferredToken: 'secret',
  })
  const apiProxy = {
    host: {
      describe: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { version: 'test', cwd: '/srv/project', attachedSessions: 0, canOpenPath: false } },
      }),
    },
    events: { mux: emptyFrames, host: emptyFrames },
  } as unknown as ApiProxy
  const typertGateway: TypertGateway = {
    invoke: async request => ({ endpoint: `${request.namespace}/${request.method}`, args: request.args }),
  }
  context.provide('apiProxy', apiProxy)
  context.provide('typertGateway', typertGateway)
  context.provide('hostControl', {})
  await context.plugin(DshHostProtocol)
  return { base: `http://127.0.0.1:${String(context.webServer.port)}`, token: 'secret' }
}

describe('UI-neutral Host protocol', () => {
  it('publishes one transport description without naming a UI', async () => {
    const { base, token } = await fixture()
    const response = await fetch(`${base}${DSH_HOST_PROTOCOL_PATH}`, { headers: { authorization: `Bearer ${token}` } })
    expect(await response.json()).toMatchObject({
      protocol: 'dsh-host', protocolVersion: 1, transport: 'http+websocket',
      muxEventsPath: DSH_HOST_MUX_EVENTS_PATH, hostEventsPath: DSH_HOST_EVENTS_PATH,
      capabilities: DSH_HOST_CAPABILITIES,
    })
    expect(DSH_HOST_CAPABILITIES).toContain(DSH_HOST_COMMAND_CATALOG_CAPABILITY)
  })

  it('carries extension RPC directly through the Host gateway', async () => {
    const { base, token } = await fixture()
    const response = await fetch(`${base}/api/example/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'example/run', payload: { args: { value: 42 } },
      }),
    })
    expect(await response.json()).toEqual({
      type: 'server-response', rpcId: 'rpc-1',
      result: { ok: true, value: { endpoint: 'example/run', args: { value: 42 } } },
    })
  })

  it('carries the typed core API without a client-connection host plugin', async () => {
    const { base, token } = await fixture()
    const response = await fetch(`${base}/api/host.describe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-core', method: 'host.describe', payload: {} }),
    })
    expect(await response.json()).toEqual({
      type: 'server-response', rpcId: 'rpc-core',
      result: {
        ok: true,
        value: { version: 'test', cwd: '/srv/project', attachedSessions: 0, canOpenPath: false },
      },
    })
  })
})
