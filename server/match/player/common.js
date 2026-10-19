import { GEO } from "../../../shared/constants.js";

const HAND_SIZE = GEO.HAND_SIZE;
const TEMP_SIZE = GEO.TEMP_SIZE;
const MAX_OFFER_SLOTS = 6;
const OK = Object.freeze({ ok: true });
const fail = (error, detail) => (detail ? { error, detail } : { error });
export { HAND_SIZE, TEMP_SIZE, MAX_OFFER_SLOTS, OK, fail };
