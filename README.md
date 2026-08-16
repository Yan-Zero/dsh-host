# dsh-host

`dsh-host` turns DeepSeek Harness into a persistent, headless backend. The AI
runtime, sessions, tools, workspaces, approvals, attachments, jobs, and storage
all stay on the Host machine. Client adapters can disconnect and later attach
again without moving execution back to the client.

Its process boundary is inspired by VS Code's remote architecture: execution
survives independently of the observing client. The wire protocol and
authentication below are dsh-host's own contract, not the VS Code protocol:

- a long-lived supervisor, detached by default;
- a loopback-only HTTP/WebSocket endpoint;
- a persistent dsh-host connection token stored outside the endpoint registry;
- an endpoint document for SSH-side discovery;
- frontend-independent APIs rather than a reduced remote-tool facade.

## Install

Build the package, then add it to a dedicated profile:

```bash
pnpm install
pnpm build
dsh plugin --profile host add /absolute/path/to/dsh-host
```

Run it:

```bash
dsh --profile host
```

The command starts a detached supervisor. Use `--foreground` while developing
or under an external service manager:

```bash
dsh --profile host --foreground
```

Inspect or stop the shared supervisor with `--status` and `--kill`. Use
`--list` to inspect every live Host instance registered for the current OS user.

Every client uses the same Host protocol: authenticated `/api/<method>` RPC,
`/api/events.mux` and `/api/events.host` event streams, and
`/dsh-host/protocol` discovery. `dsh-remote-ssh` forwards this endpoint without
changing the wire and exports a Node client for terminal and daemon consumers.
Its Web surface adds only a same-origin reverse proxy for the local static UI.

Plugins are installed into the remote `host` profile, so their configuration,
dependencies, commands, and per-agent scope remain ordinary Harness concepts.
See the [Host protocol](./docs/PROTOCOL.md) and
[plugin contract](./docs/PLUGINS.md) for client and plugin integration.

By default, private state is stored under
`$DSH_HOME/host/default/`. Each generation also publishes a per-user registry
entry under `$DSH_HOME/host/registry/`. Remote clients resolve the stable
instance there and forward its current loopback port; reconnecting does not
restart the Host.

See [INSTALL.md](./INSTALL.md) for deployment and security details.

## Status

This repository owns the Backend profile, authentication, and wire/discovery
contract. It mounts no browser, terminal, locale, theme, or other UI package.

## License

Apache-2.0
