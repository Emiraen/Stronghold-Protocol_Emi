import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GEO } from '../shared/constants.js';
import { presetCamera } from '../public/js/render/projection.js';
import { mizukiPresetCamera } from '../public/js/mizukiProjection.js';

test('Mizuki prep projects like the ordinary folded-shop camera after the bench coordinate shift', () => {
  const viewport = { width: 1920, height: 1080 };
  const hud = { top: 216, bottom: 83 };
  const ordinary = presetCamera('prep', viewport, { rect: GEO.NORMAL_RECT, side: 'L', shop: false, hud });
  const nativeRects = [
    { r0: 0, r1: 6, c0: 0, c1: 9 },
    { r0: 0, r1: 13, c0: 0, c1: 20 },
  ];
  for (const nativeRect of nativeRects) {
    const native = mizukiPresetCamera('prep', viewport, { side: 'L', shop: false, hud, nativeRect });
    for (const row of [0, 1, 2, 5]) for (const col of [0, 5, 9]) for (const height of [0, 1]) {
      const expected = ordinary.project(col, row + GEO.HAND_ROW, height);
      const actual = native.project(col, row, height);
      for (const key of ['x', 'y', 's', 'depth']) {
        assert.ok(Math.abs(actual[key] - expected[key]) <= 1e-9,
          `${key} differs at native (${row}, ${col}, ${height}) for bounds ${JSON.stringify(nativeRect)}`);
      }
    }
  }
});
