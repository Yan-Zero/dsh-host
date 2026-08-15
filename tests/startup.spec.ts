import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hostCommand, loadOrCreateIdentity, readEndpoint, removeEndpoint, resolveHostStartup, waitForEndpoint, writeEndpoint } from '../src/startup.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-startup-'))
  roots.push(root)
  return root
}

describe('startup values', () => {
  it('resolves all instance-owned files below an explicit data directory', () => {
    const root = temporaryRoot()
    const resolved = resolveHostStartup(hostCommand(), {
      host: '127.0.0.1', port: '0', instance: 'research', dataDir: root,
    })
    expect(resolved).toMatchObject({
      host: '127.0.0.1', port: 0, instanceId: 'research', dataDir: root,
      tokenFile: join(root, 'connection-token'), tokenMode: 'managed',
      endpointFile: join(root, 'endpoint.json'), identityFile: join(root, 'identity'),
      supervisorLogFile: join(root, 'supervisor.log'),
      startupFile: join(root, 'startup.json'),
      startupTimeoutMs: 180_000,
    })
  })

  it('accepts a bounded detached startup timeout', () => {
    const root = temporaryRoot()
    const resolved = resolveHostStartup(hostCommand(), {
      host: '127.0.0.1', port: '0', dataDir: root, startupTimeout: '12',
    })
    expect(resolved.startupTimeoutMs).toBe(12_000)
  })
})

describe('identity and endpoint registry', () => {
  it('keeps a stable identity and removes only the owning generation', () => {
    const root = temporaryRoot()
    const identityFile = join(root, 'identity')
    const endpointFile = join(root, 'endpoint.json')
    const identity = loadOrCreateIdentity(identityFile)
    expect(loadOrCreateIdentity(identityFile)).toBe(identity)
    expect(readFileSync(identityFile, 'utf8').trim()).toBe(identity)

    const record = {
      protocol: 'dsh-host' as const,
      protocolVersion: 1,
      hostVersion: '0.1.0',
      instanceId: 'default',
      generationId: 'generation-a',
      identity,
      pid: process.pid,
      host: '127.0.0.1' as const,
      port: 43210,
      tokenFile: join(root, 'connection-token'),
      startedAt: new Date(0).toISOString(),
      capabilities: ['dsh.api.v1'],
    }
    writeEndpoint(endpointFile, record)
    expect(readEndpoint(endpointFile)).toEqual(record)
    removeEndpoint(endpointFile, 'generation-b')
    expect(readEndpoint(endpointFile)).toEqual(record)
    removeEndpoint(endpointFile, 'generation-a')
    expect(readEndpoint(endpointFile)).toBeUndefined()
  })


  it('uses endpoint publication as the detached readiness barrier', () => {
    const root = temporaryRoot()
    const endpointFile = join(root, 'endpoint.json')
    const record = {
      protocol: 'dsh-host' as const,
      protocolVersion: 1,
      hostVersion: '0.1.0',
      instanceId: 'default',
      generationId: 'generation-ready',
      identity: '00000000-0000-4000-8000-000000000000',
      pid: process.pid,
      host: '127.0.0.1' as const,
      port: 43210,
      tokenFile: join(root, 'connection-token'),
      startedAt: new Date(0).toISOString(),
      capabilities: ['dsh.api.v1'],
    }
    writeEndpoint(endpointFile, record)
    expect(waitForEndpoint({ endpointFile, supervisorLogFile: join(root, 'supervisor.log') }, process.pid, 100)).toEqual(record)
  })
})
