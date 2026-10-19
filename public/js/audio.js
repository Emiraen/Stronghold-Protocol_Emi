// Audio manager (Web Audio): BGM per phase, UI SFX, per-unit battle SFX. Never throws.
//
// Sources: data/assets.json → audio (docs/ASSETS.md):
//   bgm { lobby, prep, combat, boss: { intro?, loop } }, bossBgm { [bossId]: { intro?, loop } },
//   sfx.ui { click, buy, sell, refresh, freeze, levelup, merge, equip, ready, timer, yourTurn, … },
//   sfx.battle { deploy, tokenDeploy, charDie, tokenDie?, enemyDie, enemyHit, heal, killCoin, … },
//   sfx.units { [charId|tokenId|enemyId]: { attack?, hit?, skill?, die?, born?, mix?: { [role]: { p?, vol? } } } }.
//
// - The AudioContext is created on the first user gesture (pointerdown/keydown/touchend), so browsers
//   never block or warn; everything requested before that is remembered (BGM) or dropped (SFX).
// - Channels: master → { bgm, sfx } gains; volumes from settings (0..1) + mute. Tab hidden ⇒ suspend.
// - BGM: `intro` then `loop` (1 s crossfade); switching tracks fades out/in (0.8 s). The same loop URL
//   keeps playing across phases (prep and combat share a track).
// - Battle SFX from `b.ev` tuples (`handleBattleEvents`): at most MAX_VOICES concurrent unit sounds, at most
//   MAX_PER_URL overlapping copies of one sound (the official banks' maxSoundAllowed 2), a per-unit cooldown and a
//   per-URL minimum gap (SfxLimiter), so a 60-unit fight stays listenable.
// - Impact sounds (user playtest #4 item 6): a 'dmg' plays the `hit` sound of the unit whose hostile attack ('atk' on a
//   unit of the other side) aimed at the target — once, within IMPACT_WINDOW_MS, and only for phys / arts / true damage.
//   A heal "attack" ('atk' of a healer on an ally, chain heals) never makes the healer the author of the next damage
//   on that ally (纯烬艾雅法拉's heals made every later hit on a healed ally ring her impact sound), element gauge fills
//   and DoTs play none, and a chain bounce ('chain' / 'chainHeal': its first id is the previous target) plays no attack
//   sound of that target. An operator's attack / hit sound that is a skill-mode file of its own (official names end in
//   `_n` for the normal attack, `_d` / `_h` / `_s` for its skill modes — the manifest picked 纯烬艾雅法拉's S3 impact
//   p_imp_gtshpbrnch_s as her `hit`) never plays for a normal attack (normalAttackSfx).
// - The official bank mix of a unit's own attack / hit / die / born sound (`mix`, tools/assets/audio.mjs bankMix; community
//   report #30): it plays with chance `p` — 猎狗pro / 深池侦察犬's attack bank is 80 % silence, so they bark on about one
//   attack in five (never replaced by the generic enemy sound) — at its base gain × `vol`, capped at 1: an official volume
//   below 1 is quieter (妖怪's 0.7), none is louder than before (unitGain).
// - Deaths/deployments follow the official per-class defaults (unitSoundClass): only operators play the
//   operator-knocked-down sound; summons use the token sounds; a summon used up by its own effect (fx `consumed`,
//   香槟炸弹) plays its impact sound instead of a death sound.
// - Buffers are fetched once and cached (LRU); failed fetch/decode ⇒ silent (logged once as a warning).
//
// `bgmKeyFor(route, pub)` picks the track for the current screen/phase (main.js calls `audio.install()`,
// which follows the store).

import { PHASE } from '../../shared/constants.js';
import { mediaUrl } from './media.js';
import { cachedFetch } from './resourceCache.js';
import { voiceLangFor } from './voicePrefs.js';

const MAX_VOICES = 8;
const UNIT_COOLDOWN_MS = 160;
const URL_GAP_MS = 45;
const MAX_PER_URL = 2;
export const LAND_VOICES = 3;
const LAND_STEAL_S = 0.025;
const BUFFER_CACHE = 180;
const XFADE_S = 1;
const FADE_S = 0.8;
/** 'atk' projectile kinds whose first id is the previous bounce target (sim ai.js), not the attacker. */
const CHAIN_KINDS = new Set(['chain', 'chainHeal']);
/** 'dmg' types that are an attack's impact (element gauge fills / 元素伤害 carry the element's name instead). */
const IMPACT_TYPES = new Set(['phys', 'arts', 'true']);
/** A 'dmg' later than this (real ms) after the attack aimed at the target is not that attack's impact. */
const IMPACT_WINDOW_MS = 2500;
const PENDING_SKILL_MAX = 64;
/** Official operator sound files of a skill mode: `…_d` / `…_h` / `…_s` (+ digits) — the normal attack's end in `_n`. */
const SKILL_MODE_FILE = /_(d|h|s)\d*\.mp3$/i;

// ---- pure helpers (unit-tested) -----------------------------------------------------------------------

/**
 * BGM key for a route + match phase.
 * @param {'title'|'lobby'|'room'|'game'|string} route
 * @param {any} pub m.public (may be null)
 * @returns {string|null} 'lobby' | 'prep' | 'combat' | 'boss' | 'boss:<bossId>' | null
 */
export function bgmKeyFor(route, pub) {
  if (route !== 'game') return route === 'title' || route === 'lobby' || route === 'room' ? 'lobby' : null;
  const phase = pub?.phase;
  if (!phase) return 'lobby';
  switch (phase) {
    case PHASE.INFO_CHECK: case PHASE.BAND_DRAFT: case PHASE.BATTLE_CHECK: case PHASE.RESULT: case PHASE.LOBBY:
      return 'lobby';
    case PHASE.COMBAT: case PHASE.UNITE:
      return 'combat';
    case PHASE.FINAL_ASSAULT:
      return pub.bossId ? `boss:${pub.bossId}` : 'boss';
    case PHASE.HIDDEN_CORE:
      return pub.hiddenBossId ? `boss:${pub.hiddenBossId}` : pub.bossId ? `boss:${pub.bossId}` : 'boss';
    default:
      return 'prep';
  }
}

/**
 * Resolve a BGM key to { intro?, loop } URLs from the manifest (boss:<id> falls back to the generic boss track).
 * @param {any} manifest
 * @param {string|null} key
 * @returns {{ intro: string|null, loop: string }|null}
 */
export function resolveBgm(manifest, key) {
  const a = manifest?.audio;
  if (!a || !key) return null;
  let t = null;
  if (key.startsWith('boss:')) t = a.bossBgm?.[key.slice(5)] || a.bgm?.boss;
  else t = a.bgm?.[key];
  if (!t || typeof t.loop !== 'string') return null;
  return { intro: typeof t.intro === 'string' ? t.intro : null, loop: t.loop };
}

/**
 * Official sound class of a battle unit (audio_data `battle.ON_UNIT_DEAD|BORN.<class>` defaults):
 * 'enemy' | 'char' (operators: b_char_dead “干员被击倒” / b_char_set) | 'token' (summons: b_char_tokendead /
 * b_char_tokenset) | 'device' (stage devices: the act crate trap_1105 dies with b_char_tokendead, no born sound).
 * Band map characters (预备干员-医疗 / Touch, `char_*` ids) are characters although the sim runs them as tokens.
 * @param {{ side?: string, kind?: string, defId?: string, def?: string }|null} info tracked unit (UnitInfo subset)
 */
export function unitSoundClass(info) {
  if (!info) return 'char';
  if (info.side === 'enemy') return 'enemy';
  const id = String(info.defId ?? info.def ?? '');
  if (info.kind === 'device') return 'device';
  if (info.kind === 'token') return /^char_/.test(id) ? 'char' : 'token';
  return 'char';
}

/** URL of the generic token death sound (b_char_tokendead): sfx.battle.tokenDie, else next to charDie. */
function tokenDieUrl(manifest) {
  const b = manifest?.audio?.sfx?.battle;
  if (typeof b?.tokenDie === 'string') return b.tokenDie;
  return typeof b?.charDie === 'string' && /b_char_dead\.mp3$/.test(b.charDie) ? b.charDie.replace(/b_char_dead\.mp3$/, 'b_char_tokendead.mp3') : null;
}

/**
 * Death sound of a battle unit ('die' event): the unit's own ON_UNIT_DEAD sound, else its class default — only
 * operators play the operator-knocked-down sound (charDie). A summon that fired and was used up (香槟炸弹: its
 * explosion is the sound) is silent, and so is an operator leaving without being knocked out, when the event says so
 * (`reason` ≠ 'killed').
 * @param {any} manifest data/assets.json
 * @param {{ side?: string, kind?: string, defId?: string, def?: string, boss?: boolean }|null} info
 * @param {{ consumed?: boolean, reason?: string|null }} [o]
 * @returns {string|null} sound URL
 */
export function deathSfxUrl(manifest, info, { consumed = false, reason = null } = {}) {
  if (!info || consumed) return null;
  const cls = unitSoundClass(info);
  if (cls === 'char' && reason && reason !== 'killed') return null;
  const own = manifest?.audio?.sfx?.units?.[info.def]?.die;
  if (typeof own === 'string') return own;
  const b = manifest?.audio?.sfx?.battle ?? {};
  if (cls === 'enemy') return (info.boss ? b.enemyDieHeavy : null) ?? b.enemyDie ?? null;
  if (cls === 'char') return typeof b.charDie === 'string' ? b.charDie : null;
  return tokenDieUrl(manifest);
}

/**
 * Deployment sound of an allied unit ('deploy' event): its own ON_UNIT_BORN sound, else operators b_char_set
 * (sfx.battle.deploy), summons b_char_tokenset (tokenDeploy); stage devices have none.
 * @returns {string|null}
 */
export function deploySfxUrl(manifest, info) {
  if (!info || info.side === 'enemy') return null;
  const own = manifest?.audio?.sfx?.units?.[info.def]?.born;
  if (typeof own === 'string') return own;
  const b = manifest?.audio?.sfx?.battle ?? {};
  const cls = unitSoundClass(info);
  if (cls === 'device') return null;
  const url = cls === 'token' ? (b.tokenDeploy ?? b.deploy) : b.deploy;
  return typeof url === 'string' ? url : null;
}

/**
 * Whether a unit's manifest `attack` / `hit` sound may play for its normal attacks: an operator's (`char_*`) sound file
 * of one of its skill modes (`_d` / `_h` / `_s`, see header) may not. Enemy files use `_h` for heavy weapons (always
 * allowed), and so may summons.
 * @param {string} defId the unit's model id (sfx.units key)
 * @param {string} url
 */
export function normalAttackSfx(defId, url) {
  return typeof url === 'string' && !(typeof defId === 'string' && defId.startsWith('char_') && SKILL_MODE_FILE.test(url));
}

/**
 * Gain of a unit's own sound with its manifest mix (sfx.units[id].mix[role]: the official bank's volume): `base` × `vol`,
 * never above `base` (a bank louder than 1 plays as before — community report #30 asked for quieter, not louder).
 * @param {number} base the role's base gain (attack / hit 0.55, die / born / skill 0.8)
 * @param {{ vol?: number }|null|undefined} mix
 */
export function unitGain(base, mix) {
  const v = mix && Number(mix.vol);
  return Number.isFinite(v) && v >= 0 ? base * Math.min(1, v) : base;
}

/**
 * Whether a unit's own sound plays this time: its official bank's chance `mix.p` (sounds with a file over all the weights;
 * 猎狗pro's attack bank 20 of 100). `roll` ∈ [0, 1).
 */
export function unitSoundPlays(mix, roll) {
  const p = mix && Number(mix.p);
  return !(Number.isFinite(p) && p >= 0 && p < 1) || roll < p;
}

/** Concurrency + cooldown gate for battle SFX. Pure (time is passed in). */
/** Gestures that may unlock audio: iOS Safari only accepts touchend / click / keydown; pointerdown covers the rest. */
const UNLOCK_EVENTS = ['pointerdown', 'touchend', 'click', 'keydown'];

export class SfxLimiter {
  /** @param {{ maxVoices?: number, unitCooldownMs?: number, urlGapMs?: number, maxPerUrl?: number }} [o] */
  constructor(o = {}) {
    this.maxVoices = o.maxVoices ?? MAX_VOICES;
    this.unitCooldownMs = o.unitCooldownMs ?? UNIT_COOLDOWN_MS;
    this.urlGapMs = o.urlGapMs ?? URL_GAP_MS;
    // the official battle banks (attack, impact, heal, born, dead…) allow at most 2 overlapping copies of a sound
    // (audio_data maxSoundAllowed 2): a heal / impact heard on every tick of a crowd never piles up
    this.maxPerUrl = o.maxPerUrl ?? MAX_PER_URL;
    this.active = 0;
    this.lastByUnit = new Map();
    this.lastByUrl = new Map();
    this.activeByUrl = new Map();
  }

  /**
   * Whether a sound may start now; records it when allowed (call `release(url)` when it ends).
   * @param {number} now ms
   * @param {string|number|null} unitKey e.g. `${unitId}:atk`
   * @param {string} url
   */
  tryAcquire(now, unitKey, url) {
    if (this.active >= this.maxVoices) return false;
    if ((this.activeByUrl.get(url) || 0) >= this.maxPerUrl) return false;
    if (unitKey != null) {
      const t = this.lastByUnit.get(unitKey);
      if (t != null && now - t < this.unitCooldownMs) return false;
    }
    const u = this.lastByUrl.get(url);
    if (u != null && now - u < this.urlGapMs) return false;
    if (unitKey != null) this.lastByUnit.set(unitKey, now);
    this.lastByUrl.set(url, now);
    if (this.lastByUnit.size > 600) this.lastByUnit.clear();
    if (this.lastByUrl.size > 400) this.lastByUrl.clear();
    this.active += 1;
    this.activeByUrl.set(url, (this.activeByUrl.get(url) || 0) + 1);
    return true;
  }

  /** A repeated landing of the same piece does not consume or steal a voice. */
  cooling(now, unitKey) {
    const at = this.lastByUnit.get(unitKey);
    return at != null && now - at < this.unitCooldownMs;
  }

  /** A sound started by tryAcquire ended. */
  release(url) {
    this.active = Math.max(0, this.active - 1);
    const n = this.activeByUrl.get(url) || 0;
    if (n <= 1) this.activeByUrl.delete(url); else this.activeByUrl.set(url, n - 1);
  }
}

// ---- manager -----------------------------------------------------------------------------------------------

/**
 * Could Web Audio decode this response? A host without the `/media/` route answers 404; some static hosts answer a
 * missing path with 200 + the SPA's index.html instead, and fetching *that* would fail to decode as silently as a
 * 404 would — so the fallback looks at the declared type too.
 *
 * A response that declares no type at all is not treated as wrong: absence of a header is not evidence of an HTML
 * page, and fetch stubs / minimal hosts legitimately omit it.
 * @param {{ ok?: boolean, headers?: { get?: (n: string) => string | null } }} res
 */
function isAudioResponse(res) {
  if (!res || !res.ok) return false;
  const type = res.headers?.get?.('content-type');
  return !type || /^\s*audio\//i.test(type);
}
// 技能台词按干员而非单位/技能槽防抖；通道从开始解码到结束一直独占。
export class VoiceGate {
  constructor() { this.busy = false; this.skillUntil = new Map(); }
  acquire(charId, slot, now) {
    if (this.busy || (/^skill[1-4]$/.test(slot) && now < (this.skillUntil.get(charId) ?? -Infinity))) return false;
    this.busy = true;
    if (/^skill[1-4]$/.test(slot)) this.skillUntil.set(charId, now + 3000);
    return true;
  }
  release() { this.busy = false; }
}

// 日语台词优先读取 voiceJp，兼容 voice.cn/jp；中文回退优先匹配同名文件。
export function voiceLine(audio, charId, slot, lang = 'cn', random = Math.random) {
  const lines = (line) => (Array.isArray(line) ? line : [line]).filter((u) => typeof u === 'string' && u);
  const draw = (list) => (list.length ? list[Math.min(list.length - 1, Math.floor(random() * list.length))] : null);
  const cn = lines(audio?.voice?.cn?.[charId]?.[slot] || audio?.voice?.[charId]?.[slot]);
  const jp = lang === 'jp' ? draw(lines(audio?.voiceJp?.[charId]?.[slot] || audio?.voice?.jp?.[charId]?.[slot])) : null;
  if (jp) {
    const file = (u) => u.slice(u.lastIndexOf('/') + 1);
    return { url: jp, fallback: cn.find((u) => file(u) === file(jp)) ?? draw(cn) };
  }
  const url = draw(cn) || draw(lines(audio?.voice?.jp?.[charId]?.[slot]));
  return url ? { url, fallback: null } : null;
}

export function resultVoiceSlot(o = {}) {
  if (o.perfect) return o.hard ? 'resultFour' : 'resultThree';
  if (o.total > 0 && o.killed <= 0) return 'resultLose';
  if (o.leaked > 0) return 'resultTwo';
  return o.hard ? 'resultFour' : 'resultThree';
}

export function resultSpeaker(pp, random = Math.random, gd = null) {
  const ops = (Array.isArray(pp?.unitsEnd) ? pp.unitsEnd : [])
    .map((u) => ({ id: voiceKey(u, gd), alive: !!u?.alive })).filter((u) => u.id);
  const standing = ops.filter((u) => u.alive);
  const pool = standing.length ? standing : ops;
  return pool.length ? pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))].id : null;
}

export function voiceKey(x, gd = null) {
  if (!x) return null;
  if (typeof x === 'string') {
    if (x.startsWith('char_')) return x;
    const lookup = gd?.getChess || gd?.chess || (typeof gd === 'function' ? gd : null);
    return lookup?.(x)?.charId || null;
  }
  if (x.diy?.charId) return x.diy.charId;
  if (x.standInFor && typeof x.spine === 'string') return x.spine.replace(/_[12]$/, '');
  return x.charId || voiceKey(x.piece || x.chessId || x.defId || x.def || x.spine || x.id, gd);
}

export class AudioManager {
  /**
   * @param {{ getManifest?: () => any, win?: any }} [opts]
   */
  constructor(opts = {}) {
    this.onFailed = typeof opts.onFailed === 'function' ? opts.onFailed : null;
    this.lastBgmKey = null;
    this.getManifest = typeof opts.getManifest === 'function' ? opts.getManifest : () => null;
    this.random = typeof opts.random === 'function' ? opts.random : Math.random;   // a unit sound's chance (mix.p)
    this.win = opts.win ?? (typeof window !== 'undefined' ? window : null);
    this.ctx = null;
    this.master = null;
    this.bgmGain = null;
    this.sfxGain = null;
    this.voiceGain = null;
    this.voiceSettings = { enabled: true, lang: 'jp', volume: 0.8 };
    this.voiceGate = new VoiceGate();
    this.voiceToken = 0;
    this.voiceNode = null;
    this.startVoiceDone = false;
    this.engaged = new Set();
    this.voiceNow = opts.now || (() => globalThis.performance?.now?.() ?? Date.now());
    this.volumes = { bgm: 0.6, sfx: 0.8, muted: false };
    this.buffers = new Map(); // url → Promise<AudioBuffer|null> (insertion order = LRU)
    this.warned = new Set();
    this.limiter = new SfxLimiter();
    this.landLimiter = new SfxLimiter({ maxVoices: LAND_VOICES, maxPerUrl: LAND_VOICES, urlGapMs: 0 });
    this.landVoices = [];
    this.landStats = { started: 0, stolen: 0 };
    this.landWarm = false;
    this.uiVoices = 0;
    this.wantBgm = null;      // desired key (kept while locked)
    this.bgm = null;          // { key, loopUrl, nodes: [{src, gain}], gain }
    this.bgmToken = 0;
    this.units = new Map();   // battle unit id → defId
    this.pendingSkill = new Map();
    this.lastAttacker = new Map(); // target id → { def, at } of the hostile attack last aimed at it (its impact sound)
    this.consumed = new Set();     // summons used up by their own effect (香槟炸弹 exploded): no death sound
    this.installed = false;
    this._unlock = this._unlock.bind(this);
    this._onVis = this._onVis.bind(this);
  }

  /** Attach gesture unlock + visibility handling. Idempotent. */
  install() {
    if (this.installed || !this.win) return;
    this.installed = true;
    try {
      for (const ev of UNLOCK_EVENTS) this.win.addEventListener(ev, this._unlock, { capture: true, passive: true });
      this.win.document?.addEventListener?.('visibilitychange', this._onVis);
      // iOS / iPadOS: a phone call, Siri or another app puts the context into 'interrupted'; coming back to the page
      // (pageshow / focus) resumes it (plus the next gesture, below)
      this.win.addEventListener?.('pageshow', this._onVis);
      this.win.addEventListener?.('focus', this._onVis);
    } catch { /* ignore */ }
  }

  get unlocked() { return !!this.ctx; }

  /**
   * First user gesture: create the context. The gesture listeners stay until the context actually runs — iOS Safari
   * only counts touchend / click (not pointerdown / touchstart) as activation, so a context created on pointerdown can
   * stay 'suspended' until the finger lifts. A 1-sample silent buffer is played inside the gesture (older WebKit only
   * unlocks output after something was started in a gesture).
   */
  _unlock() {
    if (this.ctx) {
      const st = this.ctx.state;
      if (st === 'running') { this._dropUnlock(); return; }
      if (!this.win?.document?.hidden) {
        this._primeOutput();
        const p = this.ctx.resume?.();
        if (p && typeof p.then === 'function') p.then(() => { if (this.ctx?.state === 'running') this._dropUnlock(); }, () => {});
      }
      return;
    }
    try {
      const AC = this.win?.AudioContext || this.win?.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.bgmGain = this.ctx.createGain();
      this.sfxGain = this.ctx.createGain();
      this.bgmGain.connect(this.master);
      this.sfxGain.connect(this.master);
      this.voiceGain = this.ctx.createGain();
      this.voiceGain.connect(this.master);
      this.master.connect(this.ctx.destination);
      // iOS / iPadOS: a call, Siri or another app's audio moves a running context to 'interrupted' (or 'suspended');
      // a resume without a gesture may then be refused — listen for the next gesture again (dropped once it runs)
      try {
        this.ctx.addEventListener?.('statechange', () => {
          const s = this.ctx?.state;
          if (s && s !== 'running' && s !== 'closed' && !this.win?.document?.hidden) this._armUnlock();
        });
      } catch { /* ignore */ }
      this._applyVolumes();
      if (this.landWarm) this.warmLandings();
      this._primeOutput();
      if (this.ctx.state === 'running') this._dropUnlock();
      else {
        const p = this.ctx.resume?.();
        if (p && typeof p.then === 'function') p.then(() => { if (this.ctx?.state === 'running') this._dropUnlock(); }, () => {});
      }
      if (this.wantBgm) { const k = this.wantBgm; this.wantBgm = null; this.playBgm(k); }
    } catch (err) {
      this._warn('ctx', err);
      this.ctx = null;
    }
  }

  /** (Re-)attach the gesture listeners after the context stopped running while visible (see _unlock / _onVis). */
  _armUnlock() {
    if (!this._unlockDropped || !this.win) return;
    this._unlockDropped = false;
    try { for (const ev of UNLOCK_EVENTS) this.win.addEventListener(ev, this._unlock, { capture: true, passive: true }); } catch { /* ignore */ }
  }

  /** Remove the first-gesture listeners (the context runs). */
  _dropUnlock() {
    if (this._unlockDropped || !this.win) return;
    this._unlockDropped = true;
    try { for (const ev of UNLOCK_EVENTS) this.win.removeEventListener(ev, this._unlock, { capture: true }); } catch { /* ignore */ }
  }

  /** Start a silent 1-sample buffer (inside a user gesture: unlocks output on older WebKit). */
  _primeOutput() {
    try {
      const c = this.ctx;
      if (!c || typeof c.createBuffer !== 'function') return;
      const src = c.createBufferSource();
      src.buffer = c.createBuffer(1, 1, c.sampleRate || 44100);
      src.connect(c.destination);
      src.start ? src.start(0) : src.noteOn?.(0);
    } catch { /* ignore */ }
  }

  _onVis() {
    try {
      if (!this.ctx) return;
      if (this.win?.document?.hidden) {
        this._stopVoice();
        this.ctx.suspend().catch(() => {});
      } else if (this.ctx.state !== 'running') {
        // back on the page: resume, and keep a gesture ready in case the browser wants one first (iOS after a call)
        this._armUnlock();
        this.ctx.resume().then(() => { if (this.ctx?.state === 'running') this._dropUnlock(); }, () => {});
      }
    } catch { /* ignore */ }
  }

  _warn(key, err) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    try { console.warn(`[audio] ${key} unavailable`, err?.message || err || ''); } catch { /* ignore */ }
  }

  /**
   * Set channel volumes (0..1) and mute.
   * @param {{ bgm?: number, sfx?: number, muted?: boolean }} v
   */
  setVolumes(v) {
    const n = (x, d) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : d);
    this.volumes = { bgm: n(v?.bgm, this.volumes.bgm), sfx: n(v?.sfx, this.volumes.sfx), muted: typeof v?.muted === 'boolean' ? v.muted : this.volumes.muted };
    this.volumes.voiceOverrides = v?.voiceOverrides && typeof v.voiceOverrides === 'object' ? { ...v.voiceOverrides } : {};
    if (this.volumes.muted) this._stopVoice();
    this._applyVolumes();
    if (this.landWarm) this.warmLandings();
  }

  setVoiceSettings(value) {
    this.voiceSettings = { ...this.voiceSettings, ...value };
    if (!this.voiceSettings.enabled || this.voiceSettings.volume <= 0) this._stopVoice();
    this._applyVolumes();
  }

  _applyVolumes() {
    if (!this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      this.master.gain.setTargetAtTime(this.volumes.muted ? 0 : 1, t, 0.03);
      // perceptual curve
      this.bgmGain.gain.setTargetAtTime(this.volumes.bgm ** 2 * 0.55, t, 0.05);
      this.sfxGain.gain.setTargetAtTime(this.volumes.sfx ** 2 * 0.9, t, 0.03);
      this.voiceGain?.gain.setTargetAtTime(this.voiceSettings.enabled ? this.voiceSettings.volume ** 2 : 0, t, 0.03);
    } catch { /* ignore */ }
  }

  /** Fetch + decode (cached, LRU). Resolves null on failure. */
  _buffer(url) {
    const before = this.getManifest();
    const fallback = () => {
      if (!this.onFailed?.(url)) return null;
      const after = this.getManifest();
      let path = null;
      const walk = (v, keys) => {
        if (v === url) { path = keys; return true; }
        if (v && typeof v === 'object') for (const k of Object.keys(v)) if (walk(v[k], [...keys, k])) return true;
        return false;
      };
      walk(before?.audio, ['audio']);
      const next = path?.reduce((v, k) => v?.[k], after);
      return typeof next === 'string' && next !== url ? this._buffer(next) : null;
    };
    if (!this.ctx || typeof url !== 'string' || !url) return Promise.resolve(null);
    const hit = this.buffers.get(url);
    if (hit) {
      this.buffers.delete(url);
      this.buffers.set(url, hit);
      return hit;
    }
    const p = (async () => {
      try {
        // Extension-less URL first so download managers leave the BGM alone; a host without /media/ still works.
        const media = mediaUrl(url);
        let res = await cachedFetch(media);
        if (media !== url && !isAudioResponse(res)) {
          // Drop the unusable response (404, or a 200 that is really index.html) before trying the original URL.
          try { await res.body?.cancel?.(); } catch { /* the fallback request matters more than draining this one */ }
          res = await cachedFetch(url);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ab = await res.arrayBuffer();
        return await new Promise((resolve) => {
          try {
            const r = this.ctx.decodeAudioData(ab, resolve, () => resolve(null));
            if (r && typeof r.then === 'function') r.then(resolve, () => resolve(null));
          } catch { resolve(null); }
        });
      } catch (err) {
        this._warn(url, err);
        return null;
      }
    })().then((buffer) => {
      if (!buffer && this.buffers.get(url) === p) this.buffers.delete(url);
      return buffer || fallback();
    });
    this.buffers.set(url, p);
    while (this.buffers.size > BUFFER_CACHE) {
      const first = this.buffers.keys().next().value;
      // never evict the playing BGM
      if (this.bgm && first === this.bgm.loopUrl) { const v = this.buffers.get(first); this.buffers.delete(first); this.buffers.set(first, v); break; }
      this.buffers.delete(first);
    }
    return p;
  }

  /** Preload a list of URLs (e.g. UI SFX) once unlocked. */
  preload(urls) {
    if (!this.ctx) return;
    for (const u of Array.isArray(urls) ? urls : []) this._buffer(u);
  }

  // ---- BGM ------------------------------------------------------------------------------------------------

  /**
   * Switch BGM (null stops). Same loop URL ⇒ no restart.
   * @param {string|null} key see bgmKeyFor
   */
  refreshBgm() { this.playBgm(this.lastBgmKey); }

  playBgm(key) {
    this.lastBgmKey = key;
    try {
      if (!this.ctx) { this.wantBgm = key; return; }
      const track = resolveBgm(this.getManifest(), key);
      if (this.bgm && track && this.bgm.loopUrl === track.loop) { this.bgm.key = key; return; }
      if (!track && !this.bgm) return;
      const token = ++this.bgmToken;
      this._fadeOutBgm();
      if (!track) return;
      this._startBgm(key, track, token);
    } catch (err) { this._warn('bgm', err); }
  }

  async _startBgm(key, track, token) {
    const [intro, loop] = await Promise.all([track.intro ? this._buffer(track.intro) : null, this._buffer(track.loop)]);
    if (token !== this.bgmToken || !this.ctx || !loop) return;
    try {
      const ctx = this.ctx;
      const gain = ctx.createGain();
      gain.connect(this.bgmGain);
      const t0 = ctx.currentTime + 0.05;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(1, t0 + FADE_S);
      const nodes = [];
      let loopAt = t0;
      if (intro) {
        const s = ctx.createBufferSource();
        s.buffer = intro;
        const g = ctx.createGain();
        s.connect(g); g.connect(gain);
        s.start(t0);
        const end = t0 + intro.duration;
        const xf = Math.min(XFADE_S, intro.duration / 2);
        g.gain.setValueAtTime(1, Math.max(t0, end - xf));
        g.gain.linearRampToValueAtTime(0, end);
        nodes.push({ src: s, gain: g });
        loopAt = end - xf;
      }
      const s = ctx.createBufferSource();
      s.buffer = loop;
      s.loop = true;
      const g = ctx.createGain();
      s.connect(g); g.connect(gain);
      if (intro) {
        g.gain.setValueAtTime(0, loopAt);
        g.gain.linearRampToValueAtTime(1, loopAt + Math.min(XFADE_S, intro.duration / 2));
      }
      s.start(loopAt);
      nodes.push({ src: s, gain: g });
      this.bgm = { key, loopUrl: track.loop, nodes, gain };
    } catch (err) { this._warn('bgm-start', err); }
  }

  _fadeOutBgm() {
    const cur = this.bgm;
    this.bgm = null;
    if (!cur || !this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      cur.gain.gain.cancelScheduledValues(t);
      cur.gain.gain.setValueAtTime(cur.gain.gain.value, t);
      cur.gain.gain.linearRampToValueAtTime(0, t + FADE_S);
      for (const n of cur.nodes) { try { n.src.stop(t + FADE_S + 0.05); } catch { /* ignore */ } }
      setTimeout(() => { try { cur.gain.disconnect(); } catch { /* ignore */ } }, (FADE_S + 0.3) * 1000);
    } catch { /* ignore */ }
  }

  // ---- SFX ------------------------------------------------------------------------------------------------

  _play(url, { volume = 1, rate = 1, limited = false, unitKey = null } = {}) {
    if (!this.ctx || !url || this.volumes.muted || this.volumes.sfx <= 0) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (limited) { if (!this.limiter.tryAcquire(now, unitKey, url)) return; }
    else if (this.uiVoices >= 12) return;
    else this.uiVoices += 1;
    const release = () => { if (limited) this.limiter.release(url); else this.uiVoices = Math.max(0, this.uiVoices - 1); };
    this._buffer(url).then((buf) => {
      if (!buf || !this.ctx) { release(); return; }
      try {
        const s = this.ctx.createBufferSource();
        s.buffer = buf;
        s.playbackRate.value = rate;
        const g = this.ctx.createGain();
        g.gain.value = Math.max(0, Math.min(1.5, volume));
        s.connect(g); g.connect(this.sfxGain);
        let done = false;
        const end = () => { if (!done) { done = true; release(); try { g.disconnect(); } catch { /* ignore */ } } };
        s.onended = end;
        setTimeout(end, (buf.duration / rate) * 1000 + 250); // safety if onended never fires
        s.start();
      } catch { release(); }
    }, release);
  }

  /**
   * UI sound by name (sfx.ui keys). Unknown names are ignored.
   * @param {string} name
   * @param {{ volume?: number }} [o]
   */
  sfx(name, o = {}) {
    try {
      const url = this.getManifest()?.audio?.sfx?.ui?.[name];
      if (typeof url === 'string') this._play(url, { volume: o.volume ?? 0.9 });
    } catch { /* ignore */ }
  }

  /** Battle sound by name (sfx.battle keys), limited like unit sounds. */
  battle(name, o = {}) {
    try {
      const url = this.getManifest()?.audio?.sfx?.battle?.[name];
      if (typeof url === 'string') this._play(url, { volume: o.volume ?? 0.7, limited: true, unitKey: o.unitKey ?? `b:${name}` });
    } catch { /* ignore */ }
  }

  /**
   * Per-unit sound (attack/hit/skill/die/born), throttled.
   * @param {string} defId charId/tokenId/enemyId (or chess id — mapped via its spine/char id by the caller)
   * @param {'attack'|'hit'|'skill'|'die'|'born'} kind
   * @param {number|string} unitId battle unit id (cooldown key)
   * @returns {boolean} whether a unit-specific sound exists
   */
  unit(defId, kind, unitId, skillIndex, skillActive = false) {
    try {
      const u = this.getManifest()?.audio?.sfx?.units?.[defId];
      // DESIGN §16: the equipped skill's own ON_SKILL_START sound (`skills[index]`) when the manifest has it
      const own = kind === 'skill' && Number.isInteger(skillIndex) && u?.skills ? u.skills[skillIndex] : null;
      // the running skill's own swing / impact (header); only while it runs — otherwise 能天使 S2's file would ring on
      // every normal attack of hers (exactly what normalAttackSfx keeps out). 赤刃明霄陈 S3: `attacks[2]` = the S3 swing,
      // `hits[2]` = the S3 slash's impact.
      const table = kind === 'attack' ? u?.attacks : kind === 'hit' ? u?.hits : null;
      const mode = skillActive && Number.isInteger(skillIndex) && table ? table[skillIndex] : null;
      const url = typeof own === 'string' ? own : typeof mode === 'string' ? mode : u?.[kind];
      if (typeof url !== 'string') return false;
      // a skill-mode file is fine here when it IS the running skill's (mode); the gate is for normal attacks
      if ((kind === 'attack' || kind === 'hit') && typeof mode !== 'string' && !normalAttackSfx(defId, url)) return false;
      // the official bank's mix (header): a silent roll still counts as the unit's own sound (no generic fallback)
      const mix = kind === 'skill' ? null : typeof mode === 'string'
        ? (kind === 'attack' ? u?.attackMix : u?.hitMix)?.[skillIndex] : u?.mix?.[kind];
      if (!unitSoundPlays(mix, this.random())) return true;
      this._play(url, { volume: unitGain(kind === 'attack' || kind === 'hit' ? 0.55 : 0.8, mix), limited: true, unitKey: `${unitId}:${kind}` });
      return true;
    } catch { return false; }
  }

  /** Official deployment sound for a prep piece landing; shares the existing SFX cache. */
  deployCue(info, key) {
    try {
      const m = this.getManifest();
      const u = { def: info?.def ?? null, defId: info?.defId ?? null, kind: info?.kind ?? null, side: 'ally' };
      const url = deploySfxUrl(m, u);
      if (!url) return false;
      const own = url === m?.audio?.sfx?.units?.[u.def]?.born;
      const mix = own ? m.audio.sfx.units[u.def].mix?.born : null;
      if (unitSoundPlays(mix, this.random())) this._playLanding(url, `land:${key}`, own ? unitGain(0.8, mix) : 0.5);
      return true;
    } catch { return false; }
  }

  /**
   * Play a landing sound in the landing voices: never dropped for want of a voice — over LAND_VOICES (any file) the oldest
   * landing, playing or still loading, gives its voice up (_stealLanding) and the new one starts; only the per-piece
   * cooldown refuses one (the same piece twice within UNIT_COOLDOWN_MS: one landing never sounds twice), checked before
   * anything is taken over. The battle limiter is not touched. Muted or at SFX volume 0, nothing happens.
   * @param {string} url
   * @param {string} unitKey the piece's cooldown key (`land:<view id>`)
   * @param {number} volume gain of this sound under the SFX channel
   */
  _playLanding(url, unitKey, volume) {
    if (!this.ctx || typeof url !== 'string' || !url || this.volumes.muted || this.volumes.sfx <= 0) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const pool = this.landLimiter;
    if (pool.cooling(now, unitKey)) return;
    while (!pool.tryAcquire(now, unitKey, url)) {
      if (!this.landVoices.length) return;   // (a full pool always holds voices; never loop on a refusal it cannot lift)
      this._stealLanding(this.landVoices[0]);
    }
    const v = { url, src: null, gain: null, over: false, release: null };
    v.release = () => {
      if (v.over) return;
      v.over = true;
      pool.release(url);
      const i = this.landVoices.indexOf(v);
      if (i >= 0) this.landVoices.splice(i, 1);
    };
    this.landVoices.push(v);
    this._buffer(url).then((buf) => {
      if (v.over || !buf || !this.ctx) { v.release(); return; }   // taken over while it loaded: it never starts
      try {
        const s = this.ctx.createBufferSource();
        s.buffer = buf;
        const g = this.ctx.createGain();
        g.gain.value = Math.max(0, Math.min(1.5, volume));
        s.connect(g); g.connect(this.sfxGain);
        v.src = s; v.gain = g;
        let done = false;
        const end = () => { if (done) return; done = true; v.release(); try { g.disconnect(); } catch { /* ignore */ } };
        s.onended = end;
        setTimeout(end, (buf.duration || 0) * 1000 + 250); // safety if onended never fires
        s.start();
        this.landStats.started += 1;
      } catch { v.release(); }
    }, v.release);
  }

  /** A landing sound gives its voice to a newer one: the voice is free at once, the sound fades out over LAND_STEAL_S. */
  _stealLanding(v) {
    v.release();
    this.landStats.stolen += 1;
    if (!v.src || !v.gain || !this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      const g = v.gain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + LAND_STEAL_S);
      v.src.stop(t + LAND_STEAL_S + 0.005);
    } catch { /* ignore */ }
  }

  /**
   * Fetch the generic landing sounds ahead (b_char_set / b_char_tokenset, ~30 KB together), so the round start's first
   * landings never wait for a download (a wait would bunch the chain's first sounds together). The field view asks when a
   * match screen comes up (render/app.js createFieldView); before the first gesture, or while the SFX are silent, the wish
   * is kept (`landWarm`) and _unlock / setVolumes fetch then. An own deploy sound loads with the first landing that uses it.
   */
  warmLandings() {
    if (!this.ctx || this.volumes.muted || this.volumes.sfx <= 0) { this.landWarm = true; return; }
    this.landWarm = false;
    const b = this.getManifest()?.audio?.sfx?.battle;
    for (const url of [b?.deploy, b?.tokenDeploy]) if (typeof url === 'string') this._buffer(url);
  }

  // 来源版本的双语台词解析，通道忙时丢弃，不抢占、不排队。
  voice(charId, slot = 'place') {
    if (!this.ctx || !this.voiceGain || this.ctx.state !== 'running' || this.win?.document?.hidden || this.volumes.muted
        || !this.voiceSettings.enabled || this.voiceSettings.volume <= 0) return false;
    const id = voiceKey(charId);
    const line = voiceLine(this.getManifest()?.audio, id, slot, voiceLangFor(id, this.voiceSettings.lang, this.volumes.voiceOverrides), this.random);
    if (!line || !this.voiceGate.acquire(id, slot, this.voiceNow())) return false;
    const token = ++this.voiceToken;
    void this._playVoice(line.url, token, line.fallback);
    return true;
  }

  async _playVoice(url, token, fallback = null) {
    let src = null, gain = null;
    const end = () => {
      try { src?.disconnect(); gain?.disconnect(); } catch { /* 音频节点已断开 */ }
      if (token === this.voiceToken) { this.voiceNode = null; this.voiceGate.release(); }
    };
    try {
      let buf = await this._buffer(url);
      if (token !== this.voiceToken) return;
      if (!buf && fallback && fallback !== url) {
        // _buffer 复用 cachedFetch，只读已预载资源，缺失时不下载。
        buf = await this._buffer(fallback);
        if (token !== this.voiceToken) return;
      }
      if (!buf || this.ctx?.state !== 'running' || this.win?.document?.hidden || !this.voiceSettings.enabled || this.volumes.muted) { end(); return; }
      src = this.ctx.createBufferSource(); gain = this.ctx.createGain();
      src.buffer = buf; src.connect(gain); gain.connect(this.voiceGain);
      src.onended = end; this.voiceNode = { src, gain }; src.start();
    } catch (e) { end(); this._warn('voice', e); }
  }

  _stopVoice() {
    ++this.voiceToken;
    const node = this.voiceNode; this.voiceNode = null;
    // 先断开旧节点再释放通道，不使用会造成重叠的交叉淡化。
    try { node?.gain.disconnect(); node?.src.stop(); node?.src.disconnect(); } catch { /* 已结束 */ }
    this.voiceGate.release();
  }

  // ---- battle events ------------------------------------------------------------------------------------------

  /** Reset the unit map for a new field (m.field.units = UnitInfo[]). */
  setFieldUnits(units) {
    this._stopVoice();
    this.startVoiceDone = false;
    this.engaged.clear();
    this.units.clear();
    this.pendingSkill.clear();
    this.lastAttacker.clear();
    this.consumed.clear();
    for (const u of Array.isArray(units) ? units : []) this._track(u);
  }

  _track(u) {
    if (!u || typeof u !== 'object' || u.id == null) return;
    // UnitInfo.spine is the model id (charId / tokenId / enemyId) — the key of sfx.units; kind/defId pick the
    // official class sounds (operator vs summon vs device)
    this.units.set(u.id, { def: u.spine || u.defId, defId: u.defId ?? null, kind: u.kind ?? null, side: u.side, boss: !!u.boss,
      skillIndex: Number.isInteger(u.skillIndex) ? u.skillIndex : null, skillActive: !!u.skillActive });
    const held = this.pendingSkill.get(u.id);
    if (held) { this.pendingSkill.delete(u.id); this.handleBattleEvents([held]); }
  }

  /** Play a resolved battle sound for a unit event, limited like unit sounds. */
  _playUnitUrl(url, unitKey, volume = 0.8) {
    if (typeof url === 'string') this._play(url, { volume, limited: true, unitKey });
  }

  /**
   * React to `b.ev` tuples (DESIGN §8.2).
   * @param {any[]} ev
   */
  handleBattleEvents(ev) {
    if (!this.ctx || !Array.isArray(ev)) return;
    try {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      for (const e of ev) {
        if (!Array.isArray(e)) continue;
        const kind = e[0];
        if (kind === 'spawn') { this._track(e[1]); continue; }
        if (kind === 'atk') {
          // a chain bounce: its first id is the previous target, whose attack sound this is not (see header)
          if (CHAIN_KINDS.has(e[3])) { this.lastAttacker.delete(e[2]); continue; }
          const src = this.units.get(e[1]);
          if (!src) continue;
          // only a hostile attack authors the target's next impact (a heal — an ally aiming at an ally — never does)
          const tgt = this.units.get(e[2]);
          if (tgt && tgt.side !== src.side) {
            this.lastAttacker.set(e[2], { def: src.def, at: now, skillIndex: src.skillIndex, skillActive: !!src.skillActive });
            if (unitSoundClass(src) === 'char' && !this.engaged.has(e[1])) {
              this.engaged.add(e[1]); this.voice(src.def, 'faceEnemy');
            }
          }
          if (!this.unit(src.def, 'attack', e[1], src.skillIndex ?? undefined, src.skillActive) && src.side === 'enemy') this.battle('enemyHit', { unitKey: `${e[1]}:atk`, volume: 0.35 });
        } else if (kind === 'dmg') {
          const by = this.lastAttacker.get(e[1]);
          if (!by || !IMPACT_TYPES.has(e[3])) continue;
          this.lastAttacker.delete(e[1]); // one impact per attack
          if (now - by.at <= IMPACT_WINDOW_MS) this.unit(by.def, 'hit', `h${e[1]}`, by.skillIndex ?? undefined, by.skillActive);
        } else if (kind === 'heal') {
          this.battle('heal', { unitKey: `heal:${e[1]}`, volume: 0.35 });
        } else if (kind === 'skill' && e[2]) {
          const u = this.units.get(e[1]);
          if (u) {
            u.skillActive = true;
            this.unit(u.def, 'skill', e[1], u.skillIndex ?? undefined);
            if (unitSoundClass(u) === 'char') this.voice(u.def, `skill${Math.min(4, (u.skillIndex ?? 0) + 1)}`);
          } else {
            if (this.pendingSkill.size >= PENDING_SKILL_MAX) this.pendingSkill.delete(this.pendingSkill.keys().next().value);
            this.pendingSkill.set(e[1], e);
          }
        } else if (kind === 'skill') {
          const u = this.units.get(e[1]);
          if (u) u.skillActive = false;
          this.pendingSkill.delete(e[1]);
        } else if (kind === 'engage') {
          const u = this.units.get(e[1]);
          if (u && unitSoundClass(u) === 'char') this.voice(u.def, 'faceEnemy');
        } else if (kind === 'die') {
          const u = this.units.get(e[1]);
          if (!u) continue;
          const consumed = this.consumed.delete(e[1]);
          const m = this.getManifest();
          const url = deathSfxUrl(m, u, { consumed, reason: typeof e[2] === 'string' ? e[2] : null });
          if (!url) continue;
          const own = url === m?.audio?.sfx?.units?.[u.def]?.die;
          const mix = own ? m.audio.sfx.units[u.def].mix?.die : null;
          if (!unitSoundPlays(mix, this.random())) continue;
          this._playUnitUrl(url, own ? `${e[1]}:die` : `die:${e[1]}`, own ? unitGain(0.8, mix) : 0.7);
        } else if (kind === 'deploy') {
          const u = this.units.get(e[1]);
          if (!u || u.side === 'enemy') continue;
          this.engaged.delete(e[1]);
          if (unitSoundClass(u) === 'char') {
            if (!this.startVoiceDone) {
              this.startVoiceDone = true;
              if (!this.voice(u.def, 'start')) this.voice(u.def, 'place');
            } else if (!e[2]?.initial) this.voice(u.def, 'place');
          }
          const m = this.getManifest();
          const url = deploySfxUrl(m, u);
          if (!url) continue;
          const own = url === m?.audio?.sfx?.units?.[u.def]?.born;
          const mix = own ? m.audio.sfx.units[u.def].mix?.born : null;
          if (!unitSoundPlays(mix, this.random())) continue;
          this._playUnitUrl(url, own ? `${e[1]}:born` : 'deploy', own ? unitGain(0.8, mix) : 0.5);
        } else if (kind === 'fx') {
          // a summon used up by its own effect (香槟炸弹 exploding: `consumed`): its impact sound now, no death sound
          const ex = e[4];
          if (!ex || typeof ex !== 'object' || !ex.consumed || ex.id == null) continue;
          const u = this.units.get(ex.id);
          if (!u || u.side === 'enemy') continue;
          this.consumed.add(ex.id);
          if (this.consumed.size > 200) this.consumed.delete(this.consumed.values().next().value);
          this.unit(u.def, 'hit', `${ex.id}:boom`);
        } else if (kind === 'bounty') {
          this.battle('killCoin', { unitKey: 'coin' });
        }
      }
    } catch (err) { this._warn('events', err); }
  }
}

let manifestGetter = () => null;
/** App-wide audio manager. */
export const audio = new AudioManager({ getManifest: () => manifestGetter() });

/**
 * Wire the singleton to the app (called once by main.js): manifest source, settings and store-driven BGM.
 * @param {{ getManifest: () => any, subscribe: (fn: (s:any, prev:any) => void) => () => void, getState: () => any,
 *   selectRoute: (s:any) => string, settings?: { bgm:number, sfx:number, muted:boolean } }} deps
 */
export function installAudio(deps) {
  try {
    manifestGetter = typeof deps?.getManifest === 'function' ? deps.getManifest : manifestGetter;
    audio.onFailed = typeof deps?.onFailed === 'function' ? deps.onFailed : null;
    audio.install();
    if (deps?.settings) audio.setVolumes(deps.settings);
    if (typeof deps?.subscribe === 'function' && typeof deps?.getState === 'function') {
      const sync = (s) => {
        try { audio.playBgm(bgmKeyFor(deps.selectRoute(s), s.match?.public)); } catch { /* ignore */ }
      };
      sync(deps.getState());
      return deps.subscribe((s, prev) => {
        if (s.match?.public?.phase !== prev?.match?.public?.phase || s.room !== prev?.room || s.session !== prev?.session
          || s.match?.public?.bossId !== prev?.match?.public?.bossId) sync(s);
      });
    }
  } catch (err) { console.warn('[audio] install failed', err); }
  return () => {};
}
