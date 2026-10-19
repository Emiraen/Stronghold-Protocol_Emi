// 从 A 原正文按职责拆分；保持原有行为。


export const CAMERA_MS = 750;

export const PEN_CAMERA_MS = 250;

export const BOARD3D_RETRY_MS = [1200, 4000, 12000];

export const BOARD3D_STABLE_MS = 10000;

export const RANGE_GROUPS = new Set(['facing', 'range', 'rangeStand', 'select', 'sel', 'selRange']);

export const LEADER_HIT_STYLE = Object.freeze({ group: 'leaderHit', color: 0xff3b30, fill: 0.3, line: 0.95 });

export const CHAIN_KINDS = new Set(['chain', 'chainHeal']);

export const DROP_PENDING_MS = 1300;

export const DRAG_HOLD_TILES = 0.45;

export const DEPLOY_REPLAY_MS = 50;
