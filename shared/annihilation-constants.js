// shared/annihilation-constants.js — 湮灭模拟自己的常量。
//
// Why this file exists: shared/constants.js is the one file every mod overwrites (同盟模拟 / 测试模拟 / 湮灭模拟 都改它).
// 重装任何一个 mod 都会把它换掉，而湮灭模拟的 gamedata / lobby / protocol / 客户端都 import EROSION_MAX，
// 少一个导出服务器就直接起不来（2026-10-18、10-19、10-20 各撞过一次）。所以蚀流常量放到这个独立模块里，
// 其他 mod 不会碰它。constants.js 里仍然保留同名导出（兼容旧代码）。
export const EROSION_MAX = 6;      // 蚀流 1~6
export const EROSION_ENDLESS = 6;  // 蚀流 6 = 无尽湮灭

export const ANNIHILATION_VARIANT = 'entertainment_annihilation';
export const ANNIHILATION_DIFFICULTY = 'ANNIHILATION';
export const ANNIHILATION_CAPACITIES = Object.freeze([1, 2, 3, 4]);
