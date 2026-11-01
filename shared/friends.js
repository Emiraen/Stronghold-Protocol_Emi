export const FRIEND_ACTIONS = Object.freeze(['list', 'search', 'recommend', 'request', 'accept', 'reject', 'remove', 'profile', 'history', 'invite', 'respond', 'message.list', 'message.send', 'message.read']);
export const publicPlayerId = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
export const heavyFriendAction = message => message?.t === 'friends.action' && ['search', 'recommend', 'profile', 'history', 'message.list', 'message.send'].includes(message.action);
export function socialModeName(room) {
  if (room?.variant === 'entertainment_zhajing') return '炸惊模拟';
  if (room?.variant === 'mizuki') return '水月联合探索';
  if (room?.variant === 'entertainment_mizuki') return '水月联合探索';
  if (room?.variant === 'entertainment_annihilation') return '湮灭模拟';
  if (room?.variant === 'entertainment_endless') return '无尽模式';
  if (room?.variant === 'entertainment_cyclops') return '舟铲铲之战';
  if (room?.variant === 'entertainment_multi') return '多人模式';
  return room?.ranked ? (room.mode === 'solo' ? '独立排位' : '同盟排位') : (room?.mode === 'solo' ? '独立模拟' : '同盟模拟');
}
export function friendPresenceText(presence) {
  if (!presence || presence.state === 'offline') return '离线';
  if (presence.state === 'playing') return `${presence.modeName}（${presence.humans}/${presence.capacity}）`;
  if (presence.state === 'room') return `${presence.modeName}房间（${presence.humans}/${presence.capacity}）`;
  if (presence.state === 'spectating') return '正在观战';
  return '在线';
}
