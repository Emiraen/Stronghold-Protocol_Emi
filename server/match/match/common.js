
import { C2S } from "../../../shared/protocol.js";

import { DataSource } from "../../sim/simdata.js";

const BOT_REHEARSAL_DEFAULT = 3;
const BOT_SLICE_MS = 8;
const FLOW_TICKER_PRIORITY = 25;
const GAME_TYPES = new Set(Object.keys(C2S).filter((t) => Object.hasOwn(C2S, t) && (t.startsWith('g.') || t.startsWith('b.'))));
const env = (k) => (typeof process !== 'undefined' && process.env ? process.env[k] : undefined);
const envClientCombat = () => String(env('SP_COMBAT') || '').toLowerCase() !== 'server';
function parseVerify(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'all' || s === 'sample' ? s : 'off';
}
const POOL_MIN_GAP_MS = 250;
const BOSS_CLOCK_MS = 250;
const BOSS_PUBLIC_MS = 1000;
const BOSS_RESULT_GRACE_MS = 6000;
const BOSS_MIN_CLEAR_GS = 5;
const BOSS_LP_BURST = 10;
const BOSS_LP_PER_GS = 1;
const OK = Object.freeze({ ok: true });
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const fail = (error, detail) => (detail ? { error, detail } : { error });
const DELAYS = Object.freeze({
  ROUND_START: 2000,
  COMBAT_END: 1500,
  SETTLE: 3000,
  BOT_ACTION: 900,
  BOT_STAGGER: 350,
  PUBLIC_THROTTLE: 100,
});
const BAND_TURN_SECONDS = 50;
const dsCache = new WeakMap();
function dataSourceFor(data) {
  if (!data || typeof data !== 'object' || !data.chess) return undefined;
  let ds = dsCache.get(data);
  if (!ds) { ds = new DataSource(data, null); dsCache.set(data, ds); }
  return ds;
}
export { BOT_REHEARSAL_DEFAULT, BOT_SLICE_MS, FLOW_TICKER_PRIORITY, GAME_TYPES, env, envClientCombat, parseVerify, POOL_MIN_GAP_MS, BOSS_CLOCK_MS, BOSS_PUBLIC_MS, BOSS_RESULT_GRACE_MS, BOSS_MIN_CLEAR_GS, BOSS_LP_BURST, BOSS_LP_PER_GS, OK, noopLog, fail, DELAYS, BAND_TURN_SECONDS, dsCache, dataSourceFor };
