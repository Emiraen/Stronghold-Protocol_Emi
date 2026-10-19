// 从 A 原正文按职责拆分；保持原有行为。
import { MAX_PARTICLES, NO_OPTS, clamp } from './limits.js';

export const LOAD_PARTICLES = Object.freeze([1, 0.75, 0.55, 0.4]);

export const SOFT_CAP = 0.75;

export class FxParticles {
get quality() { return this.ctx.settings?.quality || 'high'; }
get load() { return this.ctx.loadLevel ? this.ctx.loadLevel() | 0 : 0; }
get maxParticles() { return Math.round((MAX_PARTICLES[this.quality] || MAX_PARTICLES.high) * LOAD_PARTICLES[Math.min(3, this.load)]); }
get rich() { return this.quality !== 'low' && this.load < 2; }
_room() { return this.parts.length < this.maxParticles * SOFT_CAP; }
_ts() { const r = this.ctx.timeScale ? Number(this.ctx.timeScale()) : 2; return r > 0.25 ? r : 0.25; }
_groundZ(x, y) { return this.ctx.heightAt ? (this.ctx.heightAt(Math.round(y), Math.round(x)) || 0) : 0; }
particle(tex, x, y, o = NO_OPTS) {
    if (this.parts.length >= this.maxParticles) this._freeParticle(this.parts.shift());
    const add = o.add !== false;
    const t = this.tex[tex] || this.tex.dot;
    let p = (add ? this.freeAdd : this.freeNorm).pop();
    if (!p) {
      const sp = new this.P.Sprite(t);
      (add ? this.addPc : this.normPc).addChild(sp);
      p = { sp, add };
    }
    const sp = p.sp;
    sp.texture = t;
    sp.anchor.set(o.anchorX ?? 0.5, o.ay ?? 0.5);
    sp.visible = true;
    sp.position.set(x, y);
    sp.tint = o.tint ?? 0xffffff;
    sp.rotation = o.rot ?? 0;
    p.x = x; p.y = y; p.vx = o.vx || 0; p.vy = o.vy || 0; p.g = o.g || 0; p.drag = o.drag ?? 0; p.life = 0; p.max = o.life || 0.5;
    p.s0 = o.s0 ?? 1; p.s1 = o.s1 ?? o.s0 ?? 1; p.sx = o.sx ?? 1; p.a0 = o.a0 ?? 1; p.a1 = o.a1 ?? 0; p.spin = o.spin || 0; p.fadeIn = o.fadeIn || 0;
    sp.scale.set(p.s0 * p.sx, p.s0);
    sp.alpha = p.fadeIn > 0 ? 0 : p.a0;
    this.parts.push(p);
    return p;
  }
_o() {
    const o = this._po;
    o.add = true; o.tint = 0xffffff; o.vx = 0; o.vy = 0; o.g = 0; o.drag = 0; o.life = 0.5; o.s0 = 1; o.s1 = 1; o.sx = 1;
    o.a0 = 1; o.a1 = 0; o.spin = 0; o.fadeIn = 0; o.rot = 0; o.anchorX = 0.5; o.ay = 0.5;
    return o;
  }
_freeParticle(p) {
    // Pixi's ParticleRenderer draws every child of the container (it never reads `visible`): a freed sprite becomes a
    // zero-size, fully transparent quad — no pixels, no fill cost — until the record is reused
    const sp = p.sp;
    sp.visible = false;
    sp.alpha = 0;
    sp.scale.set(0, 0);
    (p.add ? this.freeAdd : this.freeNorm).push(p);
  }
_updateParticles(dt) {
    const list = this.parts;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.life += dt;
      if (p.life >= p.max) { this._freeParticle(p); continue; }
      const k = p.life / p.max;
      if (p.drag) { const d = Math.max(0, 1 - p.drag * dt); p.vx *= d; p.vy *= d; }
      p.vy += p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      const sp = p.sp;
      sp.position.set(p.x, p.y);
      const s = p.s0 + (p.s1 - p.s0) * k;
      sp.scale.set(s * p.sx, s);
      if (p.spin) sp.rotation += p.spin * dt;
      let a = p.a0 + (p.a1 - p.a0) * k;
      if (p.fadeIn > 0 && p.life < p.fadeIn) a *= p.life / p.fadeIn;
      sp.alpha = clamp(a, 0, 1);
      list[w++] = p;
    }
    list.length = w;
  }
burst(x, y, s, n, tint, o = NO_OPTS) {
    const q = this.quality === 'low' ? Math.ceil(n / 2) : n;
    const speed = o.speed ?? 2.2, up = o.up ?? 0, g = (o.g ?? 0) * s, life = o.life ?? 0.35, size = (s / 64) * (o.size ?? 0.45), tex = o.tex || 'spark';
    for (let i = 0; i < q; i++) {
      const a = Math.random() * Math.PI * 2, v = s * speed * (0.4 + Math.random() * 0.8);
      const po = this._o();
      po.tint = tint; po.vx = Math.cos(a) * v; po.vy = Math.sin(a) * v * 0.7 - up * s; po.drag = 3; po.g = g;
      po.life = life * (0.7 + Math.random() * 0.6); po.s0 = size; po.s1 = (s / 64) * 0.05; po.spin = (Math.random() - 0.5) * 8;
      this.particle(tex, x, y, po);
    }
  }
_mote(x, y, s, tint, width) {
    const o = this._o();
    const j = s * width * 0.25;
    o.tint = tint; o.life = 0.28; o.s0 = (s * width * 0.75) / 32; o.s1 = 0; o.a0 = 0.8;
    o.vx = (Math.random() - 0.5) * s * 0.25; o.vy = (Math.random() - 0.5) * s * 0.25;
    this.particle('dot', x + (Math.random() - 0.5) * j, y + (Math.random() - 0.5) * j, o);
  }
_puff(x, y, s, tint, smoke, n) {
    const o = this._o();
    if ((n + (this.parts.length & 1)) & 1) {
      o.tint = tint; o.life = 0.24; o.s0 = (s * 0.16) / 32; o.s1 = 0; o.a0 = 0.9;
      this.particle('dot', x, y, o);
    } else {
      o.add = false; o.tint = smoke ?? 0x3a3430; o.life = 0.55; o.s0 = (s * 0.22) / 128; o.s1 = (s * 0.55) / 128; o.a0 = 0.45;
      o.vy = -s * 0.25; o.spin = (Math.random() - 0.5) * 2; o.rot = Math.random() * 6;
      this.particle('smoke', x, y, o);
    }
  }
}
