# Host plugin contract

A Host plugin is an ordinary DeepSeek Harness plugin installed and composed in
the remote `host` profile. `dsh-host` does not load client plugins and does not
mirror a client's plugin inventory.

## Install into the execution profile

```bash
dsh plugin --profile host add <package>
dsh plugin --profile host install
```

The profile owns dependency resolution, bundle order, configuration, and hot
reload through `$DSH_HOME/profiles/host/`. At runtime the Loader anchors
`ctx.baseUrl` at that profile directory. Plugins should use:

- their own `import.meta.url` for package-owned assets;
- Harness home-path services for shared Harness state;
- the receiving agent/session for the active project workspace.

`process.cwd()` is not a workspace contract. A client path is never meaningful
inside a remote Host unless a protocol explicitly defines it.

## Register commands once

Executable slash commands must register with `@deepseek-ai/dsh-commands`.
Registration must not require `tuiWorkspaces`, a command tree, a browser, or any
other frontend service:

```ts
import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context): void {
  ctx.inject(['commands'], commandCtx => commandCtx.commands.register({
    name: 'example',
    description: 'Run the example',
    input: { hint: '[value]' },
    handler: async ({ agent, rawInput, signal }) => {
      signal.throwIfAborted()
      // Resolve the project from this remote agent/session, not process.cwd().
      return { kind: 'success', text: `Received:${rawInput}` }
    },
  }))
}
```

Frontend-specific completion trees may be registered separately when their
frontend service exists. They may enrich completion, but must not determine
whether the command exists.

## Scope and authority

The catalog is resolved for an attached remote agent. Agent-scoped command
registrations may shadow global registrations using the normal Harness scope
rules. The remote catalog is authoritative for remote sessions:

- clients keep their own built-in navigation commands;
- clients show plugin commands returned by the Host;
- clients do not merge locally installed plugin commands into a remote session;
- absent capability means no remote plugin command support, never local
  execution as a fallback.

Command handlers execute on the Host with the remote profile's configuration,
credentials, filesystem, tools, and process environment. Interactive behavior
that needs a client action requires an explicit protocol capability; it must
not silently run on the client.
