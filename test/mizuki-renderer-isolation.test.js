import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptMizukiFieldView, createMizukiAssets, createMizukiData, createMizukiLookups, mizukiFacilityStage }
  from '../public/js/mizukiRuntime.js';
const ART = JSON.parse(readFileSync(new URL('../public/assets/mizuki/library/manifest.json', import.meta.url), 'utf8'));
const UI = JSON.parse(readFileSync(new URL('../data/mizuki/runtime-ui.json', import.meta.url), 'utf8'));
const ASSETS = JSON.parse(readFileSync(new URL('../data/assets.json', import.meta.url), 'utf8'));
import { spineEntry, validSpine } from '../public/js/assets.js';

test('Mizuki extracted Spine resolver does not change shared native asset entries', () => {
  const before = JSON.stringify(ASSETS);
  const base = { manifest: ASSETS, spineEntry: (id, opts) => spineEntry(ASSETS, id, opts) };
  const scoped = createMizukiAssets(base, ART);
  assert.equal(base.spineEntry('enemy_1004_mslime'), null);
  assert.ok(validSpine(scoped.spineEntry('enemy_1004_mslime')));
  assert.strictEqual(scoped.spineEntry('enemy_1007_slime'), base.spineEntry('enemy_1007_slime'));
  assert.equal(scoped.spineEntry('made_up_enemy'), null);
  assert.equal(base.spineEntry('enemy_1004_mslime'), null, 'outside this mode no overlay remains');
  assert.equal(JSON.stringify(ASSETS), before);
});

test('all extracted Spine entries contain valid native resolver records', () => {
  for (const [id, record] of Object.entries(ART.spines)) assert.ok(validSpine(record), id);
});

test('mode-local official E1/E2 lookups preserve original operator and data stores', () => {
  const original = { old: { name: 'unchanged' } };
  const base = { chess: (id) => original[id] || null, token: () => null, list: () => Object.values(original) };
  const runtime = { chess: { extra: { charId: 'real', status: { phase: 'PHASE_1' } } }, tokens: {} };
  const scoped = createMizukiLookups(base, runtime);
  assert.equal(scoped.chess('extra').charId, 'real');
  assert.strictEqual(scoped.chess('old'), original.old);
  assert.equal(base.chess('extra'), null);
  const store = { get: () => original, lookup: (_name, id) => original[id] || null };
  const modeData = createMizukiData(store, runtime);
  assert.strictEqual(modeData.lookup('chess', 'extra'), runtime.chess.extra);
  assert.strictEqual(modeData.lookup('bonds', 'old'), original.old);
  assert.strictEqual(store.get('chess'), original);
  assert.equal(Object.keys(UI.chess).length, 436);
  assert.ok(Object.values(UI.chess).every((record) => record.charId && record.stats && record.status));
});

test('only the adapted renderer instance replaces fixed garrison row bands with the original map rect', () => {
  const calls = [];
  const make = () => {
    const tiles = { setView: (...args) => calls.push(args) };
    return { debug: { tiles },
      setCamera() { tiles.setView([6, 13], null, [6, 13]); },
      enterBattle() {}, resize() { tiles.setView([6, 13], null, [6, 13]); }, pushSnapshot() {} };
  };
  const oldMode = make(); const mode = adaptMizukiFieldView(make());
  const rect = { r0: 0, c0: 0, r1: 5, c1: 8 };
  mode.enterBattle({ rect }); mode.setCamera('normal', { rect }); mode.resize(); mode.pushSnapshot({});
  assert.deepEqual(calls.at(-1), [[0, 5], rect, [0, 5]]);
  oldMode.setCamera();
  assert.deepEqual(calls.at(-1), [[6, 13], null, [6, 13]], 'old-mode instance still uses its native bands');
  const next = { r0: 0, c0: 0, r1: 8, c1: 12 };
  mode.enterBattle({ rect: next });
  assert.deepEqual(calls.at(-1), [[0, 8], next, [0, 8]]);
});

test('activated original facilities rewrite a private stage and removal restores the source tile', () => {
  const source = { id: 'source', rows: ['ab'], tiles: { a: { tileKey: 'tile_road', height: 'LOW', buildable: 'ALL' }, b: { tileKey: 'tile_deepsea', height: 'LOW', buildable: 'NONE' } } };
  const fixture = [{ unitId: 7, row: 0, col: 1, active: true, buildable: 'MELEE', passable: 'NONE', obstacleLike: true, originalFacilityHeight: .4 }];
  const copy = mizukiFacilityStage(source, fixture), glyph = copy.rows[0][1];
  assert.notEqual(glyph, 'b'); assert.equal(source.rows[0], 'ab');
  assert.equal(copy.tiles[glyph].buildable, 'MELEE'); assert.equal(copy.tiles[glyph].groundPassable, true);
  assert.equal(copy.tiles[glyph].originalFacilityHeight, .4);
  assert.strictEqual(mizukiFacilityStage(source, [{ ...fixture[0], active: false }]), source);
  assert.strictEqual(mizukiFacilityStage(source, []), source);
  const stages = [], raw = { debug: {}, setStage: stage => stages.push(stage), pushSnapshot() {} };
  adaptMizukiFieldView(raw); raw.setStage(source);
  for (let i = 0; i < 20; i++) raw.pushSnapshot({ officialFacilities: { tiles: [] } });
  assert.equal(stages.length, 1, 'ordinary snapshots do not reload an unchanged empty map');
  raw.pushSnapshot({ officialFacilities: { tiles: fixture } });
  assert.notEqual(stages.at(-1), source);
  const count = stages.length;
  raw.pushSnapshot({ officialFacilities: { tiles: structuredClone(fixture) } });
  assert.equal(stages.length, count, 'identical facility metadata does not rebuild the map');
  raw.pushSnapshot({ officialFacilities: { tiles: [{ ...fixture[0], active: false }] } });
  assert.strictEqual(stages.at(-1), source);
});
