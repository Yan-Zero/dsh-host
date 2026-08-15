/** dsh-host package version. */
export const DSH_HOST_VERSION = '0.1.0'

/** First public dsh-host transport contract. */
export const DSH_HOST_PROTOCOL_VERSION = 1

/** Stable name written into endpoint discovery documents. */
export const DSH_HOST_PROTOCOL = 'dsh-host'

/** Capabilities provided by the initial Host profile. */
export const DSH_HOST_CAPABILITIES = Object.freeze([
  'dsh.api.v1',
  'dsh.events.websocket.v1',
  'dsh.workspaces.v1',
  'dsh.attachments.v1',
])
