/** UI-neutral HTTP/WebSocket carrier for the persistent dsh-host runtime. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import {
  RpcId,
  toFetchHandler,
  type ApiProxy,
  type HostFrame,
  type MuxFrame,
  type RpcRequest,
  type ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import WebSocket, { WebSocketServer } from 'ws'
import { DSH_HOST_CAPABILITIES, DSH_HOST_PROTOCOL, DSH_HOST_PROTOCOL_VERSION } from './constants.js'

export const DSH_HOST_API_PATH = '/api'
export const DSH_HOST_MUX_EVENTS_PATH = '/api/events.mux'
export const DSH_HOST_EVENTS_PATH = '/api/events.host'
export const DSH_HOST_PROTOCOL_PATH = '/dsh-host/protocol'
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 160 * 1024 * 1024

type Frame = MuxFrame | HostFrame

export interface HostProtocolDescription {
  protocol: typeof DSH_HOST_PROTOCOL
  protocolVersion: number
  transport: 'http+websocket'
  rpcPath: string
  muxEventsPath: string
  hostEventsPath: string
  authentication: readonly ['bearer', 'x-dsh-host-token']
  capabilities: readonly string[]
}

/** Stable readiness dependency proving every Host carrier route is mounted. */
export class DshHostProtocol extends Service {
  static inject = ['webServer', 'apiProxy', 'typertGateway', 'hostControl']

  readonly description: HostProtocolDescription = Object.freeze({
    protocol: DSH_HOST_PROTOCOL,
    protocolVersion: DSH_HOST_PROTOCOL_VERSION,
    transport: 'http+websocket',
    rpcPath: `${DSH_HOST_API_PATH}/{method}`,
    muxEventsPath: DSH_HOST_MUX_EVENTS_PATH,
    hostEventsPath: DSH_HOST_EVENTS_PATH,
    authentication: ['bearer', 'x-dsh-host-token'] as const,
    capabilities: DSH_HOST_CAPABILITIES,
  })

  private readonly sockets: HostWebSocketDownlinks

  constructor(ctx: Context) {
    super(ctx, 'hostProtocol')
    const core = toFetchHandler(ctx.apiProxy)
    this.sockets = new HostWebSocketDownlinks(ctx.apiProxy)
    const api: WebRoute = {
      kind: 'prefix',
      path: DSH_HOST_API_PATH,
      handler: (req, res) => bridge(req, res, {
        fetch: request => extensionEndpoint(request) === undefined
          ? core.fetch(request)
          : invokeExtension(ctx.typertGateway, request),
      }),
    }
    const descriptor: WebRoute = {
      kind: 'exact',
      path: DSH_HOST_PROTOCOL_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(this.description))
      },
    }
    const mux: WebUpgradeRoute = {
      path: DSH_HOST_MUX_EVENTS_PATH,
      handler: (req, socket, head) => { this.sockets.handleMux(req, socket, head) },
    }
    const host: WebUpgradeRoute = {
      path: DSH_HOST_EVENTS_PATH,
      handler: (req, socket, head) => { this.sockets.handleHost(req, socket, head) },
    }
    ctx.effect(() => ctx.webServer.register(api), 'dsh-host protocol: RPC and SSE')
    ctx.effect(() => ctx.webServer.register(descriptor), 'dsh-host protocol: descriptor')
    ctx.effect(() => ctx.webServer.registerUpgrade(mux), 'dsh-host protocol: mux WebSocket')
    ctx.effect(() => ctx.webServer.registerUpgrade(host), 'dsh-host protocol: host WebSocket')
    ctx.effect(() => () => this.sockets.close(), 'dsh-host protocol: close WebSockets')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** UI-neutral dsh-host wire carrier. */
    hostProtocol: DshHostProtocol
  }
}

interface FetchHandler { fetch(request: Request): Promise<Response> }

/** Bridge node:http to the fetch-shaped, transport-neutral Harness API. */
export async function bridge(
  req: IncomingMessage,
  res: ServerResponse,
  handler: FetchHandler,
  maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<void> {
  const abort = new AbortController()
  res.on('close', () => { if (!res.writableEnded) abort.abort() })
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined && Number(declaredLength) > maxRequestBodyBytes) {
    res.writeHead(413, { connection: 'close' }); res.end(); req.destroy(); return
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += buffer.byteLength
    if (received > maxRequestBodyBytes) {
      res.writeHead(413, { connection: 'close' }); res.end(); req.destroy(); return
    }
    chunks.push(buffer)
  }
  const request = new Request(new URL(req.url ?? '/', 'http://dsh-host.internal'), {
    method: req.method ?? 'GET',
    headers: requestHeaders(req),
    ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
    signal: abort.signal,
  })
  const response = await handler.fetch(request)
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (response.body === null) { res.end(); return }
  for await (const chunk of response.body) {
    if (res.write(chunk)) continue
    await new Promise<void>(resolve => {
      const done = (): void => {
        res.off('drain', done); res.off('close', done); resolve()
      }
      res.once('drain', done); res.once('close', done)
    })
  }
  res.end()
}

function requestHeaders(req: IncomingMessage): HeadersInit {
  const rows: [string, string][] = []
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') rows.push([name, value])
    else if (value !== undefined) for (const item of value) rows.push([name, item])
  }
  return rows
}

function extensionEndpoint(request: Request): [namespace: string, method: string] | undefined {
  const pathname = new URL(request.url).pathname
  if (!pathname.startsWith(`${DSH_HOST_API_PATH}/`)) return undefined
  const endpoint = pathname.slice(DSH_HOST_API_PATH.length + 1)
  const segments = endpoint.split('/')
  if (segments.length !== 2 || segments.some(segment => !/^[A-Za-z0-9_$.-]+$/.test(segment))) return undefined
  return segments as [string, string]
}

async function invokeExtension(gateway: TypertGateway, request: Request): Promise<Response> {
  const endpoint = extensionEndpoint(request)
  if (request.method !== 'POST' || endpoint === undefined) return new Response('not found', { status: 404 })
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return new Response('content type must be application/json', { status: 415 })
  }
  let body: unknown
  try { body = await request.json() } catch { return new Response('body is not JSON', { status: 400 }) }
  const record = isPlainRecord(body) ? body : undefined
  const rpcId = typeof record?.rpcId === 'string' ? record.rpcId : 'invalid-request'
  const payload = isPlainRecord(record?.payload) ? record.payload : undefined
  const args = isPlainRecord(payload?.args) ? payload.args : undefined
  const expectedMethod = endpoint.join('/')
  if (record?.type !== 'client-request' || record.method !== expectedMethod || args === undefined) {
    return rpcResponse(rpcId, false, undefined, 'invalid extension RPC envelope')
  }
  try {
    const value = await gateway.invoke({ namespace: endpoint[0], method: endpoint[1], args, signal: request.signal })
    return rpcResponse(rpcId, true, value)
  } catch (error) {
    const cancelled = request.signal.aborted
    return rpcResponse(
      rpcId,
      false,
      undefined,
      error instanceof Error ? error.message : String(error),
      cancelled ? 'cancelled' : 'internal',
    )
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

function rpcResponse(
  rpcId: string,
  ok: boolean,
  value?: unknown,
  message?: string,
  code: 'bad-request' | 'cancelled' | 'internal' = 'bad-request',
): Response {
  return Response.json({
    type: 'server-response',
    rpcId,
    result: ok
      ? { ok: true, ...(value === undefined ? {} : { value }) }
      : { ok: false, error: { code, message: message ?? 'request failed', details: code === 'bad-request' ? { issues: [] } : {} } },
  })
}

function serverRequest(frame: RpcRequest<Frame>): ServerRequest {
  return { type: 'server-request', rpcId: frame.rpcId, method: frame.payload.type, payload: frame.payload }
}

class HostWebSocketDownlinks {
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly pumps = new Set<Promise<void>>()

  constructor(private readonly api: ApiProxy) {}

  handleMux(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.upgrade(req, socket, head, signal => this.api.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, signal))
  }

  handleHost(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.upgrade(req, socket, head, signal => this.api.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, signal))
  }

  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => this.server.close(error => { if (error === undefined) resolve(); else reject(error) }))
    await Promise.all(this.pumps)
  }

  private upgrade<F extends Frame>(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    open: (signal: AbortSignal) => AsyncIterable<RpcRequest<F>>,
  ): void {
    this.server.handleUpgrade(req, socket, head, websocket => {
      const abort = new AbortController()
      websocket.once('close', () => { abort.abort() })
      websocket.once('error', () => { abort.abort() })
      websocket.once('message', () => { websocket.close(1008, 'downlink only') })
      const pump = this.pump(websocket, open(abort.signal), abort)
      this.pumps.add(pump)
      void pump.finally(() => { this.pumps.delete(pump) })
    })
  }

  private async pump<F extends Frame>(
    socket: WebSocket,
    frames: AsyncIterable<RpcRequest<F>>,
    abort: AbortController,
  ): Promise<void> {
    try {
      for await (const frame of frames) {
        if (socket.readyState !== WebSocket.OPEN) break
        await new Promise<void>((resolve, reject) => socket.send(JSON.stringify(serverRequest(frame)), error => {
          if (error === undefined) resolve(); else reject(error)
        }))
      }
    } catch (error) {
      if (!abort.signal.aborted && socket.readyState === WebSocket.OPEN) {
        const failure: RpcRequest<Frame> = {
          rpcId: RpcId(randomUUID()),
          payload: { type: 'stream/error', error: { code: 'internal', message: String(error), details: {} } },
        }
        try { socket.send(JSON.stringify(serverRequest(failure))) } catch {}
      }
    } finally {
      abort.abort()
      if (socket.readyState === WebSocket.OPEN) socket.close()
    }
  }
}

export default DshHostProtocol
