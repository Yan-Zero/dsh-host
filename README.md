# dsh-host

`dsh-host` turns DeepSeek Harness into a persistent, headless backend. The AI
runtime, sessions, tools, workspaces, approvals, attachments, jobs, and storage
all stay on the Host machine. A local TUI, Web UI, or Remote SSH client can
disconnect and later attach again without moving execution back to the client.

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
dsh plugin --profile dsh-host add /absolute/path/to/dsh-host
```

Run it:

```bash
dsh --profile dsh-host
```

The command starts a detached supervisor. Use `--foreground` while developing
or under an external service manager:

```bash
dsh --profile dsh-host --foreground
```

Inspect or stop the shared supervisor with `--status` and `--kill`.

With `dsh-remote-ssh` installed in a local Web profile, choose **Open Backend**
for a configured SSH host. The observer window is served locally while its API
and event streams stay attached to this Host through one SSH connection.

By default, private state is stored under
`$DSH_HOME/host/default/`. Remote clients read `endpoint.json` and the token
file through SSH, then forward the loopback port.

See [INSTALL.md](./INSTALL.md) for deployment and security details.

## Status

This repository owns the Backend profile and its wire/discovery contract.
Frontend adapters and deployment/profile migration can evolve as separate
plugins without changing where sessions run.

## License

Apache-2.0
