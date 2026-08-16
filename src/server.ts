/** Authenticated loopback HTTP route provider for the dsh-host profile. */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'

export const DSH_HOST_TOKEN_HEADER = 'x-dsh-host-token'

export interface Config {
  host: '127.0.0.1'
  port: number
  tokenFile: string
  tokenMode: 'managed' | 'external'
  preferredToken?: string
}

/** Persist an automatically minted dsh-host connection token. */
export function loadConnectionToken(config: Pick<Config, 'tokenFile' | 'tokenMode' | 'preferredToken'>): string {
  if (config.tokenMode === 'external') {
    const token = readFileSync(config.tokenFile, 'utf8').trim()
    if (token === '') throw new Error(`dsh-host: connection token file ${JSON.stringify(config.tokenFile)} is empty`)
    return token
  }
  mkdirSync(dirname(config.tokenFile), { recursive: true, mode: 0o700 })
  if (config.preferredToken !== undefined) {
    writeFileSync(config.tokenFile, `${config.preferredToken}\n`, { mode: 0o600 })
    chmodSync(config.tokenFile, 0o600)
    return config.preferredToken
  }
  try {
    const existing = readFileSync(config.tokenFile, 'utf8').trim()
    if (existing === '') throw new Error(`dsh-host: connection token file ${JSON.stringify(config.tokenFile)} is empty`)
    return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const generated = randomBytes(32).toString('hex')
  try {
    const fd = openSync(config.tokenFile, 'wx', 0o600)
    try { writeFileSync(fd, `${generated}\n`) } finally { closeSync(fd) }
    return generated
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const raced = readFileSync(config.tokenFile, 'utf8').trim()
    if (raced === '') throw new Error(`dsh-host: connection token file ${JSON.stringify(config.tokenFile)} is empty`)
    return raced
  }
}

export function tokenMatches(expected: string, supplied: string | undefined): boolean {
  if (supplied === undefined) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(supplied)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Accept the dsh-host query token, proxy header, or Authorization bearer. */
export function requestToken(req: IncomingMessage): string | undefined {
  const dedicated = req.headers[DSH_HOST_TOKEN_HEADER]
  if (typeof dedicated === 'string') return dedicated
  const authorization = req.headers.authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer (.+)$/.exec(authorization)
    if (match?.[1] !== undefined) return match[1]
  }
  try {
    return new URL(req.url ?? '/', 'http://dsh-host.invalid').searchParams.get('tkn') ?? undefined
  } catch {
    return undefined
  }
}

function rejectHttp(res: ServerResponse): void {
  res.writeHead(401, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'www-authenticate': 'Bearer realm="dsh-host"',
  })
  res.end('unauthorized')
}

function rejectUpgrade(socket: Duplex): void {
  socket.end([
    'HTTP/1.1 401 Unauthorized',
    'Connection: close',
    'Cache-Control: no-store',
    'WWW-Authenticate: Bearer realm="dsh-host"',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n'))
}

/** Harness route-service implementation that authenticates before dispatch. */
export class DshHostServer extends Service {
  static Config: z<Config> = z.object({
    host: z.const('127.0.0.1').required(),
    port: z.natural().max(65535).required(),
    tokenFile: z.string().required(),
    tokenMode: z.union([z.const('managed'), z.const('external')]).required(),
    preferredToken: z.string(),
  })

  private readonly exact = new Map<string, WebRoute>()
  private readonly prefixes = new Map<string, WebRoute>()
  private readonly upgrades = new Map<string, WebUpgradeRoute>()
  private readonly upgradedSockets = new Set<Duplex>()
  private readonly indexTaps: ((html: string) => string)[] = []
  private fallback: WebRoute['handler'] | undefined
  private server!: Server
  private listenedPort!: number
  private token!: string

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'webServer')
  }

  get port(): number { return this.listenedPort }
  get host(): '127.0.0.1' { return this.config.host }

  register(route: WebRoute): () => void {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) throw new Error(`dsh-host: duplicate ${route.kind} route ${JSON.stringify(route.path)}`)
    table.set(route.path, route)
    return () => { table.delete(route.path) }
  }

  registerUpgrade(route: WebUpgradeRoute): () => void {
    if (this.upgrades.has(route.path)) throw new Error(`dsh-host: duplicate upgrade route ${JSON.stringify(route.path)}`)
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }

  registerFallback(handler: WebRoute['handler']): () => void {
    if (this.fallback !== undefined) throw new Error('dsh-host: fallback already registered')
    this.fallback = handler
    return () => { this.fallback = undefined }
  }

  tapIndex(transform: (html: string) => string): () => void {
    this.indexTaps.push(transform)
    return () => {
      const index = this.indexTaps.indexOf(transform)
      if (index !== -1) this.indexTaps.splice(index, 1)
    }
  }

  applyIndexTaps(html: string): string {
    return this.indexTaps.reduce((value, transform) => transform(value), html)
  }

  async [Service.init](): Promise<void> {
    this.token = loadConnectionToken(this.config)
    this.server = createServer((req, res) => {
      if (!tokenMatches(this.token, requestToken(req))) {
        rejectHttp(res)
        return
      }
      this.handle(req, res).catch((error: unknown) => {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        if (res.headersSent) res.destroy()
        else { res.writeHead(400); res.end() }
      })
    })
    this.server.on('upgrade', (req, socket, head) => {
      if (!tokenMatches(this.token, requestToken(req))) {
        rejectUpgrade(socket)
        return
      }
      this.handleUpgrade(req, socket, head)
    })
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', reject)
        this.server.on('error', error => { this.ctx.logger.error(error) })
        this.listenedPort = (this.server.address() as AddressInfo).port
        resolve()
      })
    })
    this.ctx.effect(() => () => this.close(), 'dsh-host authenticated listener')
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://dsh-host.invalid').pathname
    const route = this.match(pathname)
    if (route !== undefined) { await route.handler(req, res); return }
    if (this.fallback !== undefined) { await this.fallback(req, res); return }
    res.writeHead(404); res.end()
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let route: WebUpgradeRoute | undefined
    try { route = this.upgrades.get(new URL(req.url ?? '/', 'http://dsh-host.invalid').pathname) } catch (error) {
      this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      socket.destroy()
      return
    }
    if (route === undefined) { socket.destroy(); return }
    const onError = (error: Error): void => { this.ctx.logger.warn(error); socket.destroy() }
    socket.on('error', onError)
    socket.once('close', () => { socket.off('error', onError); this.upgradedSockets.delete(socket) })
    this.upgradedSockets.add(socket)
    try { Promise.resolve(route.handler(req, socket, head)).catch(onError) } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private match(pathname: string): WebRoute | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best: WebRoute | undefined
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }

  private async close(): Promise<void> {
    const closed = new Promise<void>(resolve => { this.server.close(() => { resolve() }) })
    this.server.closeAllConnections()
    const upgraded = [...this.upgradedSockets].map(socket => new Promise<void>(resolve => {
      socket.once('close', () => { resolve() })
      socket.destroy()
    }))
    await Promise.all([closed, ...upgraded])
  }
}

export default DshHostServer
