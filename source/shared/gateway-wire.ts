export const GATEWAY_API_PREFIX = "/api";
export const GATEWAY_EVENTS_PATH = "/events";
export const GATEWAY_HEALTH_PATH = "/health";
export const GATEWAY_AUTH_SCHEME = "Bearer";
export const GATEWAY_SLIM_AVATARS_HEADER = "x-sand-slim-avatars";
export const GATEWAY_MINT_DEDUPE_HEADER = "x-sand-mint-dedupe";
export const GATEWAY_TRACEPARENT_HEADER = "traceparent";
export const GATEWAY_AVATARS_PATH = "/avatars";
export const GATEWAY_NETWORK_TOKEN_HEADER = "x-anyrun-network-token";
/** Reconstructed-host extension: raw, bounded attachment uploads. */
export const GATEWAY_ATTACHMENT_UPLOAD_STREAM_CAPABILITY = "attachmentUploadStreamV1";
export const GATEWAY_ATTACHMENT_UPLOAD_STREAM_PATH = `${GATEWAY_API_PREFIX}/uploadAttachmentStream`;
export const GATEWAY_ATTACHMENT_FILENAME_HEADER = "x-sand-attachment-filename";
export const GATEWAY_ATTACHMENT_AGENT_ID_HEADER = "x-sand-attachment-agent-id";
export const GATEWAY_ATTACHMENT_FILENAME_MAX_BYTES = 4_096;
export const GATEWAY_ATTACHMENT_AGENT_ID_MAX_BYTES = 512;
