import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Inbound WebSocket frame limit (DESIGN §8). */
export const WS_MAX_PAYLOAD = 64 * 1024;
export const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
