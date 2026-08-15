/** dsh-host runtime: publish one authenticated, discoverable Backend generation. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  DSH_HOST_CAPABILITIES,
  DSH_HOST_PROTOCOL,
  DSH_HOST_PROTOCOL_VERSION,
  DSH_HOST_VERSION,
} from './constants.js'
import {
  loadOrCreateIdentity,
  removeEndpoint,
  removeStartupClaim,
  writeEndpoint,
  type EndpointRecord,
} from './startup.js'

export * from './constants.js'
export * from './server.js'
export * from './startup.js'

export const name = 'dsh-host-runtime'
export const inject = ['hostStartup', 'webServer', 'connection', 'apiProxy']

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

/** Publish readiness only after the complete Harness API transport is mounted. */
export function apply(ctx: Context): void {
  const generationId = randomUUID()
  const identity = loadOrCreateIdentity(ctx.hostStartup.identityFile)
  const startedAt = new Date().toISOString()
  const describe = (): EndpointRecord => ({
    protocol: DSH_HOST_PROTOCOL,
    protocolVersion: DSH_HOST_PROTOCOL_VERSION,
    hostVersion: DSH_HOST_VERSION,
    instanceId: ctx.hostStartup.instanceId,
    generationId,
    identity,
    pid: process.pid,
    host: ctx.webServer.host as '127.0.0.1',
    port: ctx.webServer.port,
    tokenFile: ctx.hostStartup.tokenFile,
    startedAt,
    capabilities: DSH_HOST_CAPABILITIES,
  })
  const route: WebRoute = {
    kind: 'exact',
    path: '/dsh-host/health',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
      json(res, 200, { ok: true, endpoint: describe() })
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'dsh-host health route')
  const endpoint = describe()
  writeEndpoint(ctx.hostStartup.endpointFile, endpoint)
  removeStartupClaim(ctx.hostStartup.startupFile, process.pid)
  ctx.effect(() => () => { removeEndpoint(ctx.hostStartup.endpointFile, generationId) }, 'dsh-host endpoint registry')
  process.stdout.write(`DSH_HOST_READY ${JSON.stringify({
    instanceId: endpoint.instanceId,
    pid: endpoint.pid,
    host: endpoint.host,
    port: endpoint.port,
    endpointFile: ctx.hostStartup.endpointFile,
  })}\n`)
}

export default { name, inject, apply }
