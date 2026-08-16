/** Command-line ownership and supervisor discovery for the dsh-host profile. */

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Marks the detached process that is allowed to publish the Host service. */
export const DSH_HOST_SUPERVISOR_ENV = 'DSH_HOST_SUPERVISOR'

/** Stable Cordis service key for resolved Host startup values. */
export const HOST_STARTUP_SERVICE = 'hostStartup'

/** Stable Cordis plugin name. */
export const name = 'dsh-host-startup'

/** Command line must exist before this profile resolves its runtime paths. */
export const inject = ['cmdlineArgs']

/** Values consumed by the authenticated server and endpoint publisher. */
export interface HostStartupValues {
  host: '127.0.0.1'
  port: number
  instanceId: string
  dataDir: string
  tokenFile: string
  tokenMode: 'managed' | 'external'
  preferredToken?: string
  endpointFile: string
  /** Global per-user registry entry used to discover every running instance. */
  registryFile: string
  identityFile: string
  supervisorLogFile: string
  startupFile: string
  startupTimeoutMs: number
  foreground: boolean
}

/** A discoverable running supervisor. */
export interface EndpointRecord {
  protocol: 'dsh-host'
  protocolVersion: number
  hostVersion: string
  instanceId: string
  generationId: string
  identity: string
  pid: number
  host: '127.0.0.1'
  port: number
  tokenFile: string
  startedAt: string
  capabilities: readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Resolved dsh-host invocation values. */
    hostStartup: HostStartupValues
  }
}

interface HostOptions {
  host?: string
  port?: string
  instance?: string
  dataDir?: string
  connectionToken?: string
  connectionTokenFile?: string
  endpointFile?: string
  foreground?: boolean
  replace?: boolean
  status?: boolean
  kill?: boolean
  list?: boolean
  startupTimeout?: string
}

const INSTANCE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/

/** Build a fresh command parser for one profile invocation. */
export function hostCommand(): Command {
  return new Command()
    .name('dsh --profile host')
    .description('Run a persistent headless DeepSeek Harness Backend.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host; only 127.0.0.1 is accepted', '127.0.0.1')
    .option('--port <port>', 'listen port; pass 0 to select a free port', '0')
    .option('--instance <id>', 'stable Host instance name', 'default')
    .option('--data-dir <path>', 'private Host state directory')
    .option('--connection-token <token>', 'set and persist the connection token')
    .option('--connection-token-file <path>', 'read the connection token from an external file')
    .option('--endpoint-file <path>', 'endpoint discovery document')
    .option('--startup-timeout <seconds>', 'seconds to wait for a detached Host to become ready', '180')
    .option('--foreground', 'stay attached to the invoking terminal', false)
    .option('--replace', 'replace an existing supervisor for this instance', false)
    .option('--status', 'print the current supervisor endpoint and exit', false)
    .option('--kill', 'stop the current supervisor and exit', false)
    .option('--list', 'list every live Host instance for this user', false)
    .addHelpText('after', `
Examples:
  dsh --profile host
  dsh --profile host --foreground --port 0
  dsh --profile host --instance research --replace
`)
}

function explicitPath(program: Command, flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!isAbsolute(value)) program.error(`error: ${flag} must be an absolute path, got ${JSON.stringify(value)}`)
  return resolve(value)
}

/** Convert parsed command options into immutable startup values. */
export function resolveHostStartup(program: Command, options: HostOptions): HostStartupValues {
  if (options.host !== '127.0.0.1') {
    program.error('error: --host must be 127.0.0.1; remote access belongs behind an authenticated SSH tunnel')
  }
  if (options.port === undefined || !/^\d+$/.test(options.port)) {
    program.error(`error: --port must be an integer, got ${JSON.stringify(options.port)}`)
  }
  const port = Number(options.port)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    program.error(`error: --port must be between 0 and 65535, got ${JSON.stringify(options.port)}`)
  }
  const startupTimeout = options.startupTimeout ?? '180'
  if (!/^\d+$/.test(startupTimeout)) {
    program.error(`error: --startup-timeout must be an integer, got ${JSON.stringify(startupTimeout)}`)
  }
  const startupTimeoutSeconds = Number(startupTimeout)
  if (!Number.isSafeInteger(startupTimeoutSeconds) || startupTimeoutSeconds < 1 || startupTimeoutSeconds > 3600) {
    program.error(`error: --startup-timeout must be between 1 and 3600 seconds, got ${JSON.stringify(startupTimeout)}`)
  }
  const instanceId = options.instance ?? 'default'
  if (!INSTANCE_PATTERN.test(instanceId)) {
    program.error(`error: --instance must match ${INSTANCE_PATTERN.source}, got ${JSON.stringify(instanceId)}`)
  }
  if (options.connectionToken !== undefined && options.connectionTokenFile !== undefined) {
    program.error('error: --connection-token and --connection-token-file are mutually exclusive')
  }
  if (options.connectionToken !== undefined && options.connectionToken.trim() === '') {
    program.error('error: --connection-token must not be empty')
  }

  const dshHome = resolveDshHome()
  const dataDir = explicitPath(program, '--data-dir', options.dataDir)
    ?? join(dshHome, 'host', instanceId)
  const externalTokenFile = explicitPath(program, '--connection-token-file', options.connectionTokenFile)
  const endpointFile = explicitPath(program, '--endpoint-file', options.endpointFile)
    ?? join(dataDir, 'endpoint.json')
  return Object.freeze({
    host: '127.0.0.1' as const,
    port,
    instanceId,
    dataDir,
    tokenFile: externalTokenFile ?? join(dataDir, 'connection-token'),
    tokenMode: externalTokenFile === undefined ? 'managed' as const : 'external' as const,
    ...(options.connectionToken === undefined ? {} : { preferredToken: options.connectionToken }),
    endpointFile,
    registryFile: join(dshHome, 'host', 'registry', `${instanceId}.json`),
    identityFile: join(dataDir, 'identity'),
    supervisorLogFile: join(dataDir, 'supervisor.log'),
    startupFile: join(dataDir, 'startup.json'),
    startupTimeoutMs: startupTimeoutSeconds * 1000,
    foreground: options.foreground === true,
  })
}

/** Read a registry document; malformed and missing files are stale. */
export function readEndpoint(path: string): EndpointRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<EndpointRecord>
    if (value.protocol !== 'dsh-host' || !Number.isInteger(value.pid) || typeof value.generationId !== 'string') {
      return undefined
    }
    return value as EndpointRecord
  } catch {
    return undefined
  }
}

/** Enumerate the live per-user Host registry and prune dead generations. */
export function listRegisteredHosts(registryDir = join(resolveDshHome(), 'host', 'registry')): EndpointRecord[] {
  let names: string[]
  try { names = readdirSync(registryDir) } catch { return [] }
  const endpoints: EndpointRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(registryDir, name)
    const endpoint = readEndpoint(path)
    if (endpoint !== undefined && processExists(endpoint.pid)) endpoints.push(endpoint)
    else rmSync(path, { force: true })
  }
  return endpoints.sort((left, right) => left.instanceId.localeCompare(right.instanceId))
}

/** Process existence is the conservative registry liveness check. */
export function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
  // A detached child that exits while this process is in the synchronous
  // readiness loop remains a zombie until Node can service SIGCHLD. kill(0)
  // reports that PID as alive, which used to hide immediate boot failures
  // until the full startup timeout elapsed.
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      if (close !== -1 && stat.slice(close + 2, close + 3) === 'Z') return false
    } catch {}
  } else if (process.platform === 'darwin') {
    const result = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1_000, windowsHide: true,
    })
    const state = result.stdout.trim()
    if (result.status === 1 && state === '') return false
    if (state.startsWith('Z')) return false
  }
  return true
}

/** Create a private file atomically when it is absent. */
export function loadOrCreateIdentity(path: string): string {
  mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 })
  for (;;) {
    try {
      const value = readFileSync(path, 'utf8').trim()
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
        throw new Error(`dsh-host: invalid identity file ${JSON.stringify(path)}`)
      }
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const value = randomUUID()
    try {
      const fd = openSync(path, 'wx', 0o600)
      try { writeFileSync(fd, `${value}\n`) } finally { closeSync(fd) }
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/** Atomically publish a generation after the authenticated API is ready. */
export function writeEndpoint(path: string, record: EndpointRecord): void {
  const directory = resolve(path, '..')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.endpoint-${process.pid}-${randomUUID()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(record, undefined, 2)}\n`, { mode: 0o600, flag: 'wx' })
  chmodSync(temporary, 0o600)
  if (existsSync(path)) rmSync(path, { force: true })
  renameSync(temporary, path)
}

/** Remove only the exact generation owned by the caller. */
export function removeEndpoint(path: string, generationId: string): void {
  if (readEndpoint(path)?.generationId !== generationId) return
  rmSync(path, { force: true })
}

function spawnSupervisor(startup: HostStartupValues): number {
  mkdirSync(startup.dataDir, { recursive: true, mode: 0o700 })
  const log = openSync(startup.supervisorLogFile, 'a', 0o600)
  // Preserve loader flags (`--import tsx/esm` in a source checkout); packaged
  // installs normally have an empty execArgv and launch the built JS directly.
  let child
  try {
    child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
      env: { ...process.env, [DSH_HOST_SUPERVISOR_ENV]: startup.instanceId },
    })
  } finally {
    closeSync(log)
  }
  child.unref()
  const pid = child.pid
  if (pid === undefined) throw new Error('dsh-host: detached supervisor did not receive a process ID')
  writeStartupClaim(startup.startupFile, pid)
  process.stdout.write(`dsh-host: starting supervisor for ${startup.instanceId} (PID ${String(pid)})\n`)
  process.stdout.write(`dsh-host: endpoint ${startup.endpointFile}\n`)
  return pid
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(milliseconds: number): void {
  Atomics.wait(sleepBuffer, 0, 0, milliseconds)
}

/**
 * Wait until the exact detached generation has published its complete API.
 * The endpoint is deliberately written by the runtime only after HTTP and
 * both event WebSockets are mounted, so file publication is the readiness
 * barrier rather than a guess based on process existence.
 */
export function waitForEndpoint(
  startup: Pick<HostStartupValues, 'endpointFile' | 'supervisorLogFile'>,
  pid: number,
  timeoutMs: number,
): EndpointRecord {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const endpoint = readEndpoint(startup.endpointFile)
    if (endpoint?.pid === pid && processExists(pid)) return endpoint
    if (!processExists(pid)) {
      throw new Error(`dsh-host: supervisor ${String(pid)} exited before publishing ${JSON.stringify(startup.endpointFile)}; see ${JSON.stringify(startup.supervisorLogFile)}`)
    }
    if (Date.now() >= deadline) {
      throw new Error(`dsh-host: supervisor ${String(pid)} did not become ready within ${String(timeoutMs)}ms; see ${JSON.stringify(startup.supervisorLogFile)}`)
    }
    sleepSync(Math.min(100, Math.max(1, deadline - Date.now())))
  }
}

function waitForProcessExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs
  while (processExists(pid) && Date.now() < deadline) sleepSync(50)
  return !processExists(pid)
}

function waitForStartingSupervisor(startup: HostStartupValues): EndpointRecord {
  const deadline = Date.now() + startup.startupTimeoutMs
  for (;;) {
    const endpoint = readEndpoint(startup.endpointFile)
    if (endpoint !== undefined && processExists(endpoint.pid)) return endpoint
    const claim = readStartupClaim(startup.startupFile)
    if (claim !== undefined && !processExists(claim.pid)) {
      throw new Error(`dsh-host: the supervisor starting for ${startup.instanceId} exited; see ${JSON.stringify(startup.supervisorLogFile)}`)
    }
    if (Date.now() >= deadline) {
      throw new Error(`dsh-host: the supervisor starting for ${startup.instanceId} did not become ready within ${String(startup.startupTimeoutMs)}ms; see ${JSON.stringify(startup.supervisorLogFile)}`)
    }
    // The claim is atomically created and then rewritten with the child PID;
    // a concurrent reader may briefly see either owner (or the rewrite gap).
    sleepSync(Math.min(100, Math.max(1, deadline - Date.now())))
  }
}

interface StartupClaim { pid: number; startedAt: string }

function readStartupClaim(path: string): StartupClaim | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<StartupClaim>
    return Number.isSafeInteger(value.pid) && typeof value.startedAt === 'string'
      ? value as StartupClaim
      : undefined
  } catch {
    return undefined
  }
}

function writeStartupClaim(path: string, pid: number): void {
  writeFileSync(path, `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Acquire the small startup window so concurrent SSH attaches spawn once. */
function claimStartup(startup: HostStartupValues): boolean {
  mkdirSync(startup.dataDir, { recursive: true, mode: 0o700 })
  const existing = readStartupClaim(startup.startupFile)
  if (existing !== undefined && processExists(existing.pid)) return false
  rmSync(startup.startupFile, { force: true })
  try {
    const fd = openSync(startup.startupFile, 'wx', 0o600)
    try { writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`) }
    finally { closeSync(fd) }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return false
  }
}

/** Clear a ready/crashed startup claim without touching another generation. */
export function removeStartupClaim(path: string, pid: number): void {
  if (readStartupClaim(path)?.pid !== pid) return
  rmSync(path, { force: true })
}

function terminateExisting(program: Command, startup: HostStartupValues, replace: boolean): boolean {
  const existing = readEndpoint(startup.endpointFile) ?? readEndpoint(startup.registryFile)
  if (existing === undefined || !processExists(existing.pid)) {
    if (existsSync(startup.endpointFile)) rmSync(startup.endpointFile, { force: true })
    if (existsSync(startup.registryFile)) rmSync(startup.registryFile, { force: true })
    return false
  }
  if (!replace) {
    if (startup.port !== 0 && startup.port !== existing.port) {
      program.error(`error: --port ${String(startup.port)} conflicts with the running supervisor on port ${String(existing.port)}; pass --replace`)
    }
    if (resolve(startup.tokenFile).toLowerCase() !== resolve(existing.tokenFile).toLowerCase()) {
      program.error('error: the requested connection-token file conflicts with the running supervisor; pass --replace')
    }
    if (startup.preferredToken !== undefined) {
      let activeToken: string
      try { activeToken = readFileSync(existing.tokenFile, 'utf8').trim() } catch {
        program.error('error: cannot verify the running supervisor connection token; pass --replace')
        return true
      }
      if (activeToken !== startup.preferredToken) {
        program.error('error: --connection-token conflicts with the running supervisor; pass --replace')
      }
    }
    // Repair either discovery copy while attaching. This keeps the stable
    // per-user registry authoritative even if a previous process stopped
    // between publishing the instance endpoint and the registry entry.
    if (readEndpoint(startup.endpointFile)?.generationId !== existing.generationId) writeEndpoint(startup.endpointFile, existing)
    if (readEndpoint(startup.registryFile)?.generationId !== existing.generationId) writeEndpoint(startup.registryFile, existing)
    process.stdout.write(`dsh-host: supervisor already running on ${existing.host}:${String(existing.port)} (PID ${String(existing.pid)})\n`)
    return true
  }
  process.kill(existing.pid, 'SIGTERM')
  if (!waitForProcessExit(existing.pid, 10_000)) {
    process.kill(existing.pid, 'SIGKILL')
    if (!waitForProcessExit(existing.pid, 5_000)) {
      program.error(`error: supervisor ${String(existing.pid)} did not stop`)
    }
  }
  removeEndpoint(startup.endpointFile, existing.generationId)
  removeEndpoint(startup.registryFile, existing.generationId)
  return false
}

function printStatus(startup: HostStartupValues): boolean {
  const endpoint = readEndpoint(startup.endpointFile) ?? readEndpoint(startup.registryFile)
  if (endpoint === undefined || !processExists(endpoint.pid)) {
    process.stdout.write(`dsh-host: no live supervisor for ${startup.instanceId}\n`)
    return false
  }
  process.stdout.write(`${JSON.stringify(endpoint, undefined, 2)}\n`)
  return true
}

function killSupervisor(startup: HostStartupValues): boolean {
  const endpoint = readEndpoint(startup.endpointFile) ?? readEndpoint(startup.registryFile)
  if (endpoint === undefined || !processExists(endpoint.pid)) {
    rmSync(startup.endpointFile, { force: true })
    rmSync(startup.registryFile, { force: true })
    process.stdout.write(`dsh-host: no live supervisor for ${startup.instanceId}\n`)
    return false
  }
  process.kill(endpoint.pid, 'SIGTERM')
  removeEndpoint(startup.endpointFile, endpoint.generationId)
  removeEndpoint(startup.registryFile, endpoint.generationId)
  process.stdout.write(`dsh-host: stopped supervisor ${String(endpoint.pid)}\n`)
  return true
}

/** Parse the invocation, detach by default, and publish values only in the supervisor. */
export function apply(ctx: Context): void {
  const program = hostCommand()
  program.action(() => {
    const options = program.opts<HostOptions>()
    const startup = resolveHostStartup(program, options)
    const supervisor = process.env[DSH_HOST_SUPERVISOR_ENV] === startup.instanceId
    if (options.status === true) {
      ctx.get('appExit')?.(printStatus(startup) ? 0 : 1)
      return
    }
    if (options.kill === true) {
      ctx.get('appExit')?.(killSupervisor(startup) ? 0 : 1)
      return
    }
    if (options.list === true) {
      process.stdout.write(`${JSON.stringify(listRegisteredHosts(), undefined, 2)}\n`)
      ctx.get('appExit')?.(0)
      return
    }
    if (startup.foreground || supervisor) {
      ctx.provide(HOST_STARTUP_SERVICE, startup)
      return
    }
    if (!terminateExisting(program, startup, options.replace === true)) {
      if (claimStartup(startup)) {
        let pid: number | undefined
        try {
          pid = spawnSupervisor(startup)
          const endpoint = waitForEndpoint(startup, pid, startup.startupTimeoutMs)
          process.stdout.write(`dsh-host: ready on ${endpoint.host}:${String(endpoint.port)} (PID ${String(endpoint.pid)})\n`)
        } catch (error) {
          if (pid !== undefined) {
            if (processExists(pid) && readEndpoint(startup.endpointFile)?.pid !== pid) {
              try { process.kill(pid, 'SIGTERM') } catch {}
            }
            removeStartupClaim(startup.startupFile, pid)
          } else {
            removeStartupClaim(startup.startupFile, process.pid)
          }
          throw error
        }
      } else {
        process.stdout.write(`dsh-host: supervisor for ${startup.instanceId} is already starting\n`)
        const endpoint = waitForStartingSupervisor(startup)
        process.stdout.write(`dsh-host: ready on ${endpoint.host}:${String(endpoint.port)} (PID ${String(endpoint.pid)})\n`)
      }
    }
    ctx.get('appExit')?.(0)
  })
  parseCmdline(ctx, program)
}
