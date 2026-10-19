// Process-local transport hints. This module has no socket or Node dependencies.
const metadataByMessage = new WeakMap();
export function markSend(message, metadata) {
  metadataByMessage.set(message, metadata);
  return message;
}
export function getSendMetadata(message) { return metadataByMessage.get(message) || {}; }
