// 从 A 原正文按职责拆分；保持原有行为。
import { fxForm } from '../../../../shared/protocol.js';

export const STATE_EV = new Set(['spawn', 'die', 'deploy', 'status', 'skill']);

export const keepEarly = (e) => Array.isArray(e) && (STATE_EV.has(e[0]) || fxForm(e) !== undefined);
