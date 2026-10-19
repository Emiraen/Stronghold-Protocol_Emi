// 从 A 原正文按职责拆分；保持原有行为。
import { fxAtlas } from '../textures.js';
import { MAX_PARTICLES } from './limits.js';
import { ensureDamageFonts } from './fonts.js';
import { FxParticles } from './particles.js';
import { FxProjectiles } from './projectiles.js';
import { FxBeams } from './beams.js';
import { FxLocks } from './locks.js';
import { FxNumbers } from './numbers.js';
import { FxRings } from './rings.js';
import { FxArrivals } from './arrivals.js';
import { FxSim } from './simfx.js';
import { FxZones } from './zones.js';

export class FxSystem {
constructor(ctx) {
    const P = ctx.P;
    this.ctx = ctx;
    this.P = P;
    this.atlas = fxAtlas();
    this.tex = this.atlas.tex;
    ensureDamageFonts();
    const props = { vertices: true, position: true, rotation: true, uvs: true, tint: true };
    this.addPc = new P.ParticleContainer(MAX_PARTICLES.high, props, 512, true);
    this.addPc.blendMode = P.BLEND_MODES.ADD;
    this.normPc = new P.ParticleContainer(MAX_PARTICLES.high, props, 512, true);
    // ground shadows of flying shells / boomerangs: normal blend, under the units and the smoke
    this.shadowLayer = new P.Container();
    ctx.layers.fxNormal.addChild(this.shadowLayer, this.normPc);
    ctx.layers.fxAdd.addChild(this.addPc);
    this.parts = [];          // active particle records { sp, add, x, y, vx, … }
    this.freeAdd = []; this.freeNorm = [];   // pooled particle records (their sprites stay in the containers)
    this.projs = [];
    this.projFree = [];
    this.projLayer = new P.Container();
    ctx.layers.fxAdd.addChild(this.projLayer);
    this.locks = [];          // lock-on reticles { view, id, src, x, y, z, t, idle, max, out, ring, core, shell }
    this.lockFree = [];
    this._po = {};            // options of the per-frame emitters (see _o)
    this.beams = new P.Graphics();
    this.beams.blendMode = P.BLEND_MODES.ADD;
    ctx.layers.fxAdd.addChild(this.beams);
    this.beamList = [];
    this.flames = [];         // fire jets (炎佑 祛恶之焰) { src, tgt, x, y, z, r, col, t, end, disc, edge, … }
    this.nums = [];
    this._numPools = new Map();   // bitmap font → free number records
    this.auras = new Map();   // unit id → { sprite, ring, t }
    this.rings = [];          // ground rings { sprite, x, y, z, t, dur, r0, r1, tint }
    this.ringFree = [];
    this.pops = [];           // screen-space pops (bond glyphs, coins)
    this.zones = [];          // persistent ground areas (zone / telegraph fx)
    this.labels = [];         // floating '!' / '+n' labels
    this.tileFlashes = [];    // flashing tile sets (telegraphed boxes)
    this.tileGfx = new P.Graphics();
    this.tileGfx.blendMode = P.BLEND_MODES.ADD;
    ctx.layers.groundFx.addChild(this.tileGfx);
    this.tintSprite = new P.Sprite(P.Texture.WHITE);
    this.tintSprite.alpha = 0;
    this.tintSprite.blendMode = P.BLEND_MODES.ADD;
    ctx.layers.screen.addChild(this.tintSprite);
    this.tintT = 0; this.tintDur = 1; this.tintA = 0;
    this.vignette = new P.Sprite(ctx.redVignette || P.Texture.EMPTY);
    this.vignette.alpha = 0;
    ctx.layers.screen.addChild(this.vignette);
    this.vigT = 0;
    this.time = 0;
    this._p = { x: 0, y: 0, s: 0, depth: 0 };
    this._q = { x: 0, y: 0, s: 0, depth: 0 };
    this._g = { x: 0, y: 0, s: 0, depth: 0 };
  }
clear() {
    for (const p of this.parts) this._freeParticle(p);
    this.parts.length = 0;
    for (const pr of this.projs) this._releaseProj(pr);
    this.projs.length = 0;
    for (const L of this.locks) this._freeLock(L);
    this.locks.length = 0;
    this._slashAt = null;
    for (const t of this.nums) this._releaseNum(t);
    this.nums.length = 0;
    for (const r of this.rings) { r.sp.visible = false; this.ringFree.push(r); }
    this.rings.length = 0;
    for (const a of this.auras.values()) a.sp.destroy({ children: true });
    this.auras.clear();
    for (const p of this.pops) p.c.destroy({ children: true });
    this.pops.length = 0;
    this.beamList.length = 0;
    this.beams.clear();
    for (const F of this.flames) this._freeFlame(F);
    this.flames.length = 0;
    this.vigT = 0;
    this.vignette.alpha = 0;
    for (const zn of this.zones) this._freeZone(zn);
    this.zones.length = 0;
    for (const l of this.labels) l.t.destroy();
    this.labels.length = 0;
    this.tileFlashes.length = 0;
    this.tileGfx.clear();
    this.tintT = 0; this.tintSprite.alpha = 0;
  }
update(dt) {
    this.time += dt;
    this._updateParticles(dt);
    this._updateProjs(dt);
    this._updateLocks(dt);
    this._updateBeams(dt);
    this._updateFlames(dt);
    this._updateNums(dt);
    this._updateRings(dt);
    this._updateAuras(dt);
    this._updatePops(dt);
    this._updateZones(dt);
    this._updateLabels(dt);
    this._updateTileFlashes(dt);
    if (this.tintT > 0) {
      this.tintT = Math.max(0, this.tintT - dt);
      const size = this.ctx.screenSize();
      this.tintSprite.width = size.width; this.tintSprite.height = size.height;
      this.tintSprite.alpha = Math.sin((this.tintT / this.tintDur) * Math.PI) * this.tintA * 0.35;
    } else if (this.tintSprite.alpha) this.tintSprite.alpha = 0;
    if (this.vigT > 0) {
      this.vigT = Math.max(0, this.vigT - dt);
      const size = this.ctx.screenSize();
      this.vignette.width = size.width; this.vignette.height = size.height;
      this.vignette.alpha = Math.sin((this.vigT / 0.9) * Math.PI) * 0.55;
    } else if (this.vignette.alpha) this.vignette.alpha = 0;
  }
get counts() {
    return { particles: this.parts.length, projectiles: this.projs.length, numbers: this.nums.length, rings: this.rings.length, auras: this.auras.size, locks: this.locks.length, flames: this.flames.length, promotions: this.promotions || 0 };
  }
destroy() {
    this.clear();
    this.addPc.destroy({ children: true });
    this.normPc.destroy({ children: true });
    this.projLayer.destroy({ children: true });
    this.shadowLayer.destroy({ children: true });
    this.lockFree.length = 0;
    this.projFree.length = 0;
    this.freeAdd.length = 0; this.freeNorm.length = 0;
    this.beams.destroy();
    this.vignette.destroy();
    this.tileGfx.destroy();
    this.tintSprite.destroy();
    for (const list of this._numPools.values()) for (const t of list) t.text.destroy();
    this._numPools.clear();
  }
}

for (const C of [FxParticles, FxProjectiles, FxBeams, FxLocks, FxNumbers, FxRings, FxArrivals, FxSim, FxZones]) { for (const key of Object.getOwnPropertyNames(C.prototype)) { if (key !== 'constructor') Object.defineProperty(FxSystem.prototype, key, Object.getOwnPropertyDescriptor(C.prototype, key)); } }
