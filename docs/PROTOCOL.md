# dsh-host protocol v1

This is the public, UI-neutral connection contract for `dsh-host`. A client
may be a terminal, desktop application, daemon, or browser adapter. None is
required to mount a UI package on the Host.

## Discovery and authentication

An SSH-side installer or connector reads the Host endpoint document, forwards
its loopback port, then requests `GET /dsh-host/protocol`. Every HTTP request
and WebSocket upgrade must authenticate with one of:

- `Authorization: Bearer <connection-token>`
- `X-DSH-Host-Token: <connection-token>`

Clients must inspect `protocolVersion` and `capabilities`; package versions are
not protocol negotiation. Unknown capabilities must be ignored. A client must
not call an optional operation unless its capability is advertised.

## RPC

Core Harness methods use `POST /api/<method>` and the standard Harness RPC
envelope. Extension methods use `POST /api/<namespace>/<method>`:

```json
{
  "type": "client-request",
  "rpcId": "unique-id",
  "method": "control/commandCatalog",
  "payload": { "args": { "sessionId": "session-id" } }
}
```

The response is a standard `server-response`. Transport success does not imply
operation success; clients must inspect `result.ok`.

## Events

`/api/events.mux` and `/api/events.host` are authenticated, downlink-only
WebSockets. Each message carries a standard Harness `server-request` frame.
Clients send mutations through RPC, not through these sockets.

## Plugin commands

Capability `dsh.commands.catalog.v1` provides
`control/commandCatalog({ sessionId })`. The package exports the corresponding
constants and TypeScript request/result types from `dsh-host/control`. It
returns the effective command
descriptors for that exact remote agent:

```json
{
  "commands": [
    { "name": "example", "description": "Run the example", "input": { "hint": "[value]" } }
  ]
}
```

Execution uses the normal session prompt API with the slash-command text. The
remote command registry decides whether the input is a command; clients must
not execute a same-named local plugin command as a fallback. See
[PLUGINS.md](./PLUGINS.md).

## Compatibility

Protocol v1 additions are capability-gated. Removing or changing the meaning
of an existing field, endpoint, or capability requires a new protocol or
capability version. Error text is diagnostic and is not a stable machine API.
