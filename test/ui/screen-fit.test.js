import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  CONTROL_SCALE_MIN, CONTROL_SCALE_MAX, CONTROL_SCALE_DEFAULT,
  sanitizeControlScale, sanitizeFit, fitStore, updateFit, applyFit,
} = await import('../../public/js/ui/screenFit.js');

const DEFAULT_FIT = { l: 0, r: 0, t: 0, b: 0, scale: 100 };

// All globals are restored by descriptor, including when an assertion fails.
async function withGlobals(values, run) {
  const saved = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    return await run();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function browserFixture(pref = null) {
  const css = new Map();
  const storage = new Map(pref == null ? [] : [['sp.pref.screenFit', JSON.stringify(pref)]]);
  const events = [];
  const root = { dataset: {}, style: {
    setProperty: (key, value) => css.set(key, value),
    removeProperty: (key) => { const old = css.get(key); css.delete(key); return old || ''; },
  } };
  return { css, storage, events, root, globals: {
    document: { documentElement: root },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    Event: class { constructor(type) { this.type = type; } },
    dispatchEvent: (event) => { events.push(event); return true; },
  } };
}

describe('screen-fit control size', () => {
  test('default and limits preserve the original size', () => {
    assert.equal(CONTROL_SCALE_MIN, 75);
    assert.equal(CONTROL_SCALE_MAX, 150);
    assert.equal(CONTROL_SCALE_DEFAULT, 100);
    assert.deepEqual(sanitizeFit(null), DEFAULT_FIT);
    assert.deepEqual(sanitizeFit({ l: 12, r: -8, t: 0, b: 21 }), { l: 12, r: -8, t: 0, b: 21, scale: 100 });
  });

  test('control scale defaults invalid values and clamps rounded percentages', () => {
    for (const value of [undefined, null, '', NaN, Infinity, -Infinity, 'bad', {}]) {
      assert.equal(sanitizeControlScale(value), 100, String(value));
    }
    assert.equal(sanitizeControlScale(0), 75);
    assert.equal(sanitizeControlScale(-500), 75);
    assert.equal(sanitizeControlScale(500), 150);
    assert.equal(sanitizeControlScale('125'), 125);
    assert.equal(sanitizeControlScale(100.49), 100);
    assert.equal(sanitizeControlScale(100.5), 101);
    assert.equal(sanitizeControlScale(75), 75);
    assert.equal(sanitizeControlScale(150), 150);
  });

  test('scale and each edge sanitize independently', () => {
    assert.deepEqual(sanitizeFit({ l: 200, r: -200, t: '7.6', b: 'bad', scale: 125 }),
      { l: 100, r: -100, t: 8, b: 0, scale: 125 });
    assert.deepEqual(sanitizeFit({ ...DEFAULT_FIT, l: 20, scale: 'bad' }), { ...DEFAULT_FIT, l: 20 });
    assert.deepEqual(sanitizeFit({ ...DEFAULT_FIT, scale: 150 }), { ...DEFAULT_FIT, scale: 150 });
  });

  test('legacy persisted edge-only preferences load at 100 percent', async () => {
    const f = browserFixture({ l: 12, r: 6, t: -4, b: 18 });
    await withGlobals(f.globals, async () => {
      const legacy = await import('../../public/js/ui/screenFit.js?legacy-control-size-test');
      assert.deepEqual(legacy.fitStore.get(), { l: 12, r: 6, t: -4, b: 18, scale: 100 });
      assert.equal(f.css.has('--control-scale'), false);
      assert.equal(f.css.get('--fit-l'), '12px');
      assert.equal(f.events.at(-1)?.type, 'resize');
    });
  });

  test('updateFit merges edges and scale and persists both without interference', async () => {
    const initial = fitStore.get();
    const f = browserFixture();
    await withGlobals(f.globals, () => {
      try {
        fitStore.set(DEFAULT_FIT);
        updateFit({ l: 12, b: 18 });
        updateFit({ scale: 125 });
        assert.deepEqual(fitStore.get(), { l: 12, r: 0, t: 0, b: 18, scale: 125 });
        updateFit({ r: 8 });
        assert.deepEqual(fitStore.get(), { l: 12, r: 8, t: 0, b: 18, scale: 125 });
        assert.deepEqual(JSON.parse(f.storage.get('sp.pref.screenFit')), fitStore.get());
        assert.equal(f.css.get('--control-scale'), '1.25');
      } finally { fitStore.set(initial); }
    });
  });

  test('applyFit sets independent CSS variables and dispatches resize', async () => {
    const f = browserFixture();
    await withGlobals(f.globals, () => {
      applyFit({ l: 12, r: 8, t: -4, b: 18, scale: 125 });
      assert.equal(f.root.dataset.fit, '');
      assert.equal(f.css.get('--control-scale'), '1.25');
      for (const [side, value] of Object.entries({ l: 12, r: 8, t: -4, b: 18 })) {
        assert.equal(f.css.get(`--fit-${side}`), `${value}px`);
      }
      assert.deepEqual(f.events.map((event) => event.type), ['resize']);
    });
  });

  test('scale alone does not enable edge fit and defaults remove all overrides', async () => {
    const f = browserFixture();
    await withGlobals(f.globals, () => {
      applyFit({ ...DEFAULT_FIT, l: 14, scale: 150 });
      applyFit({ ...DEFAULT_FIT, scale: 75 });
      assert.equal(f.css.get('--control-scale'), '0.75');
      assert.equal(Object.hasOwn(f.root.dataset, 'fit'), false);
      for (const side of ['l', 'r', 't', 'b']) assert.equal(f.css.has(`--fit-${side}`), false);
      applyFit(DEFAULT_FIT);
      assert.equal(f.css.size, 0);
      assert.equal(Object.hasOwn(f.root.dataset, 'fit'), false);
      assert.deepEqual(f.events.map((event) => event.type), ['resize', 'resize', 'resize']);
    });
  });

  test('applyFit tolerates missing DOM and a resize listener failure', async () => {
    await withGlobals({ document: undefined }, () => assert.doesNotThrow(() => applyFit(DEFAULT_FIT)));
    const f = browserFixture();
    await withGlobals({ ...f.globals, dispatchEvent: () => { throw new Error('old browser'); } }, () => {
      assert.doesNotThrow(() => applyFit({ ...DEFAULT_FIT, scale: 125 }));
      assert.equal(f.css.get('--control-scale'), '1.25');
    });
  });
});
