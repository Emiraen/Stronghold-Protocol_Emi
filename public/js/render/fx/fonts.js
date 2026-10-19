// 从 A 原正文按职责拆分；保持原有行为。
import { DMG_STYLE } from '../style.js';

export let fontsReady = false;

export function ensureDamageFonts() {
  if (fontsReady) return;
  const P = globalThis.PIXI;
  for (const st of Object.values(DMG_STYLE)) {
    try {
      P.BitmapFont.from(st.font, {
        fontFamily: ['Bender', 'Oxanium', 'Rajdhani', 'Arial Black', 'sans-serif'], fontSize: 44, fontWeight: '700',
        fill: st.fill, fillGradientStops: [0.25, 1], stroke: st.stroke, strokeThickness: 7,
        dropShadow: true, dropShadowColor: '#000000', dropShadowAlpha: 0.45, dropShadowDistance: 2, dropShadowBlur: 2,
      }, { chars: st.font === 'sp-dmg-miss' ? [['0', '9'], '+-×!', 'MISS'] : [['0', '9'], '+-×!'], resolution: 2, padding: 6 });
    } catch (err) { console.warn('[fx] bitmap font', st.font, err?.message || err); }
  }
  fontsReady = true;
}
