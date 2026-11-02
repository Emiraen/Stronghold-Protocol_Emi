// Up to four doctors explore together; approved parties may split and reunite.
export const MIZUKI_VARIANT = 'entertainment_mizuki';
export const MIZUKI_MODE_ID = 'mode_mizuki';
export const MIZUKI_CAPACITIES = Object.freeze([1, 2, 3, 4]);
export const MIZUKI_DEFAULT_SEATS = 4;
export const MIZUKI_MAX_SEATS = 4;
export const MIZUKI_TITLE = '水月与深蓝之树 · 联合探索';
export const MIZUKI_PHASES = Object.freeze({
  SQUAD: 'MIZUKI_SQUAD', STRATEGY: 'MIZUKI_STRATEGY', INITIAL_SUPPLY: 'MIZUKI_INITIAL_SUPPLY', RECRUIT_GROUP: 'MIZUKI_RECRUIT_GROUP',
  ROUTE: 'MIZUKI_ROUTE', EVENT: 'MIZUKI_EVENT', RECRUIT: 'MIZUKI_RECRUIT',
  SHOP: 'MIZUKI_SHOP', PREP: 'PREP', COMBAT: 'COMBAT',
  REWARD: 'MIZUKI_REWARD', RESULT: 'RESULT',
});
export const MIZUKI_PHASE = MIZUKI_PHASES;
export const mizukiFieldId = (seat) => Number(seat) < 2 ? 'mizuki_a' : 'mizuki_b';
