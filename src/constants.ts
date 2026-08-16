/** dsh-host package version. */
export const DSH_HOST_VERSION = '0.1.0'

/** First public dsh-host transport contract. */
export const DSH_HOST_PROTOCOL_VERSION = 1

/** Stable name written into endpoint discovery documents. */
export const DSH_HOST_PROTOCOL = 'dsh-host'

/** Session-scoped plugin command discovery through the Host control plane. */
export const DSH_HOST_COMMAND_CATALOG_CAPABILITY = 'dsh.commands.catalog.v1'

/** Capabilities provided by the initial Host profile. */
export const DSH_HOST_CAPABILITIES = Object.freeze([
  'dsh.host.rpc.v1',
  'dsh.host.events.sse.v1',
  'dsh.host.events.websocket.v1',
  'dsh.host.extensions.v1',
  DSH_HOST_COMMAND_CATALOG_CAPABILITY,
  'dsh.workspaces.v1',
  'dsh.attachments.v1',
])
