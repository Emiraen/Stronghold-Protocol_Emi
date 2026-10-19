// 从 A 原正文按职责拆分；保持原有行为。


export const cx = (...p) => p.flat().filter(Boolean).join(' ');

export const HUD_HZ_MS = 200;

export const SEL_RANGE = Object.freeze({ group: 'selRange', color: 0xff9c33, fill: 0.3, line: 0.95 });

export const MERGE_HL = Object.freeze({ group: 'mergeTile', color: 0xffd45a, fill: 0.34, line: 1 });
