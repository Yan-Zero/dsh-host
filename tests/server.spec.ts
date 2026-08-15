import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import DshHostServer, { loadConnectionToken } from '../src/server.js'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-test-'))
  roots.push(root)
  return root
}

describe('connection token', () => {
  it('persists the generated token and reuses it', () => {
    const tokenFile = join(temporaryRoot(), 'connection-token')
    const first = loadConnectionToken({ tokenFile, tokenMode: 'managed' })
    const second = loadConnectionToken({ tokenFile, tokenMode: 'managed' })
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(second).toBe(first)
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe(first)
  })

  it('overwrites managed state only when an explicit token is supplied', () => {
    const tokenFile = join(temporaryRoot(), 'connection-token')
    writeFileSync(tokenFile, 'old\n')
    expect(loadConnectionToken({ tokenFile, tokenMode: 'managed', preferredToken: 'new' })).toBe('new')
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe('new')
  })

  it('reads but never rewrites an external token file', () => {
    const tokenFile = join(temporaryRoot(), 'external-token')
    writeFileSync(tokenFile, 'managed-elsewhere\n')
    expect(loadConnectionToken({ tokenFile, tokenMode: 'external' })).toBe('managed-elsewhere')
    expect(readFileSync(tokenFile, 'utf8')).toBe('managed-elsewhere\n')
  })
})
describe('authenticated web server', () => {
  it('authenticates before routing using header, bearer, or query token', async () => {
    const root = temporaryRoot()
    const context = new Context()
    contexts.push(context)
    await context.plugin(DshHostServer, {
      host: '127.0.0.1',
      port: 0,
      tokenFile: join(root, 'token'),
      tokenMode: 'managed',
      preferredToken: 'secret',
    })
    context.webServer.register({
      kind: 'exact',
      path: '/probe',
      handler: (_req, res) => { res.writeHead(200); res.end('ready') },
    })
    const base = `http://127.0.0.1:${String(context.webServer.port)}/probe`
    expect((await fetch(base)).status).toBe(401)
    expect((await fetch(base, { headers: { 'x-dsh-host-token': 'wrong' } })).status).toBe(401)
    expect(await (await fetch(base, { headers: { 'x-dsh-host-token': 'secret' } })).text()).toBe('ready')
    expect(await (await fetch(base, { headers: { authorization: 'Bearer secret' } })).text()).toBe('ready')
    expect(await (await fetch(`${base}?tkn=secret`)).text()).toBe('ready')
  })
})
