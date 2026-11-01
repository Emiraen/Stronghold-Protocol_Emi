export const FRIEND_MESSAGE_MAX_LENGTH = 500;
export const FRIEND_MESSAGE_PAGE_SIZE = 50;
export const FRIEND_MESSAGE_RETENTION_MS = 24 * 3600_000;
export const validFriendMessageText = value => typeof value === 'string' && value.length <= FRIEND_MESSAGE_MAX_LENGTH
  && value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
export const validMessageSequence = value => Number.isSafeInteger(value) && value >= 0;
