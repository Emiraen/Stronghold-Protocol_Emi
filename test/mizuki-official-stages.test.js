import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Grid } from '../server/sim/grid.js';
import { mergeOfficialEnemyData, resolveOfficialEnemy, translateOfficialMap, translateOfficialRoute,
  officialMizukiStageOptions, createOfficialMizukiStage, inspectOfficialActionDependencies } from '../server/modes/mizuki/official-stages.js';
const INDEX = JSON.parse(readFileSync(new URL('../data/mizuki/levels/index.json', import.meta.url), 'utf8'));

const levelFile = (file) => new URL('../data/mizuki/levels/' + file, import.meta.url);
const level = (file) => JSON.parse(readFileSync(levelFile(file), 'utf8'));

test('all 60 original level files retain their recorded source hashes', () => {
  const sources = Object.values(INDEX.levelsById);
  assert.equal(sources.length, 60);
  for (const entry of sources) assert.equal(createHash('sha256').update(readFileSync(levelFile(entry.file)))
    .digest('hex'), entry.sha256, entry.file);
});

test('original map rows are reversed once with exact dimensions and original deployment masks', () => {
  for (const file of ['level_rogue2_1-1.json', 'level_rogue2_1-3.json', 'level_rogue2_5-1.json']) {
    const input = level(file);
    const { stage, rect, nativeStage } = translateOfficialMap('original', input, { name: 'original' });
    const rows = input.mapData.map;
    assert.deepEqual(rect, { r0: 0, c0: 0, r1: rows.length - 1, c1: rows[0].length - 1 });
    const grid = new Grid(stage, rect);
    assert.equal(nativeStage.rows.length, 19);
    assert.ok(nativeStage.rows.every((row) => row.length === 21));
    for (let row = 0; row < rows.length; row++) for (let col = 0; col < rows[0].length; col++) {
      const original = input.mapData.tiles[rows[rows.length - 1 - row][col]];
      assert.equal(grid.tile(row, col).key, original.tileKey);
      const native = nativeStage.tiles[nativeStage.rows[row][col]];
      assert.equal(native.tileKey, original.tileKey, 'native renderer maps the same original tile');
      assert.equal(native.height, /HIGH/i.test(original.heightType) ? 'HIGH' : 'LOW');
      if (original.tileKey !== 'tile_deepsea') assert.equal(grid.tile(row, col).build, original.buildableType);
    }
    assert.equal(grid.tile(rows.length, 0).build, 'NONE', 'outside original map is forbidden');
  }
});

test('oversized original maps fail explicitly instead of falling back or clipping', () => {
  assert.throws(() => translateOfficialMap('bad', { mapData: { map: [Array(40).fill(0)],
    tiles: [{ tileKey: 'tile_road' }] } }, { name: 'bad' }), /dimensions/);
});

test('m_defined inheritance retains base values and accepts explicit zero, false and empty lists', () => {
  const base = { attributes: { maxHp: 500, atk: 99, stunImmune: true }, skills: [{ prefabKey: 'x' }] };
  const out = mergeOfficialEnemyData(base, { attributes: {
    maxHp: { m_defined: false, m_value: 9000 }, atk: { m_defined: true, m_value: 0 },
    stunImmune: { m_defined: true, m_value: false } }, skills: [] });
  assert.deepEqual(out, { attributes: { maxHp: 500, atk: 0, stunImmune: false }, skills: [] });
  assert.equal(base.attributes.atk, 99);
});

test('enemy DB levels inherit then apply local overrides; missing DB never substitutes another enemy', () => {
  const db = { enemy: [
    { level: 0, enemyData: { name: { m_defined: true, m_value: 'base' },
      attributes: { maxHp: { m_defined: true, m_value: 500 }, atk: { m_defined: true, m_value: 50 } } } },
    { level: 1, enemyData: { attributes: { maxHp: { m_defined: true, m_value: 900 },
      atk: { m_defined: false, m_value: 200 } } } },
  ] };
  const ref = { id: 'enemy', useDb: true, level: 1,
    overwrittenData: { attributes: { atk: { m_defined: true, m_value: 80 } } } };
  assert.deepEqual(resolveOfficialEnemy(ref, db), { name: 'base', attributes: { maxHp: 900, atk: 80 } });
  assert.throws(() => resolveOfficialEnemy({ id: 'missing', useDb: true }, db), /missing/);
  assert.deepEqual(resolveOfficialEnemy({ id: 'inline', useDb: false, overwrittenData:
    { attributes: { maxHp: { m_defined: true, m_value: 20 } } } }, {}), { attributes: { maxHp: 20 } });
});

test('fragment-relative wait checkpoint retains original type, delay and source coordinates', () => {
  const route = { motionMode: 'FLY', startPosition: { row: 2, col: 3 },
    endPosition: { row: 1, col: 8 }, checkpoints: [{ type: 'WAIT_CURRENT_FRAGMENT_TIME', time: 40,
      position: { row: 0, col: 0 }, reachOffset: { x: 0, y: 0 } }] };
  const converted = translateOfficialRoute(route);
  assert.equal(converted.motion, 'FLY');
  assert.deepEqual(converted.start, [2, 3]);
  assert.equal(converted.checkpoints[0].type, 'WAIT_CURRENT_FRAGMENT_TIME');
  assert.equal(converted.checkpoints[0].time, 40);
  assert.equal(route.checkpoints[0].originalType, undefined);
});

test('official route coordinates already align with the reversed map red entries and blue objectives', () => {
  for (const [id, file] of [['ro2_n_1_1', 'level_rogue2_1-1.json'], ['ro2_n_1_2', 'level_rogue2_1-2.json']]) {
    const raw = level(file), setup = createOfficialMizukiStage(id);
    const grid = new Grid(setup.stage, setup.rect);
    const actions = raw.waves.flatMap((wave) => wave.fragments.flatMap((fragment) => fragment.actions))
      .filter((action) => action.actionType === 'SPAWN' && action.key);
    let redEntries = 0;
    for (const action of actions) {
      const original = raw.routes[action.routeIndex], route = setup.routes[action.routeIndex];
      assert.deepEqual(route.start, [original.startPosition.row, original.startPosition.col]);
      assert.deepEqual(route.end, [original.endPosition.row, original.endPosition.col]);
      assert.equal(grid.tile(...route.end).key, 'tile_end', id + ': official enemy reaches its blue objective');
      // The levels also preplace a few enemies away from an entry gate.  Only
      // require the actual entry routes to remain on their original red gate.
      if (grid.tile(...route.start).key === 'tile_start') redEntries++;
    }
    assert.ok(redEntries > 0, id + ': original red-gate routes remain available');
    assert.ok(redEntries < actions.length, id + ': preplaced enemies need not start on a red gate');
  }
});

test('nonempty talent and skill overrides merge by source keys without discarding unrelated mechanisms', () => {
  const base = { talentBlackboard: [{ key: 'revive.hp_ratio', value: 0.04 },
    { key: 'sleepwalking.unmove_duration', value: 10 }], skills: [
    { prefabKey: 'a', cooldown: 30, blackboard: [{ key: 'x', value: 1 }, { key: 'y', value: 2 }] },
    { prefabKey: 'b', cooldown: 20, blackboard: [] }] };
  const out = mergeOfficialEnemyData(base, { talentBlackboard: [{ key: 'sleepwalking.unmove_duration', value: 0 }],
    skills: [{ prefabKey: 'a', blackboard: [{ key: 'x', value: 3 }] }] });
  assert.equal(out.talentBlackboard.find((v) => v.key === 'revive.hp_ratio').value, 0.04);
  assert.equal(out.talentBlackboard.find((v) => v.key === 'sleepwalking.unmove_duration').value, 0);
  assert.equal(out.skills.length, 2);
  assert.equal(out.skills[0].cooldown, 30);
  assert.deepEqual(out.skills[0].blackboard, [{ key: 'x', value: 3 }, { key: 'y', value: 2 }]);
  const l = level('level_rogue2_b-8.json');
  const ref = l.enemyDbRefs.find((v) => v.id === 'enemy_1151_dslntc_2');
  if (ref) {
    const resolved = resolveOfficialEnemy(ref);
    assert.equal(resolved.talentBlackboard.find((v) => v.key === 'revive.hp_ratio').value, 0.04);
  }
});

test('all 97 original stage records have implemented readiness and preserve their source identity', () => {
  const stages = officialMizukiStageOptions();
  assert.equal(stages.length, 97);
  assert.ok(stages.every((s) => s.source.sha256 && s.levelId.includes('RO2/') && s.trial));
  assert.ok(stages.every((s) => s.available === !s.disabled));
  assert.ok(stages.filter((s) => s.disabled).every((s) => s.unavailableReason && s.unsupported.length));
  assert.throws(() => createOfficialMizukiStage('made_up'), /Unknown/);
  assert.deepEqual(stages.filter((s) => s.disabled).map((s) => [s.id, s.unsupported]), []);
  for (const stage of stages) assert.equal(createOfficialMizukiStage(stage.id).stageId, stage.stageId);
});

test('original cards, facilities and unbound branches cannot be omitted from an available battle', () => {
  const stages = officialMizukiStageOptions();
  for (const stage of stages) for (const limitation of stage.limitations) {
    if (!['predefined_cards', 'predefined_devices', 'branches'].includes(limitation.code)) continue;
    assert.equal(stage.available, false, stage.id);
    for (const key of limitation.keys) assert.ok(stage.unsupported.some((item) => item.key === key), key);
    assert.throws(() => createOfficialMizukiStage(stage.id), /not ready/);
  }
});

test('random bad-box alternatives include their branch enemy before a particular seed rolls them', () => {
  const raw = level('level_rogue2_1-1.json');
  const deps = inspectOfficialActionDependencies(raw);
  assert.ok(deps.ids.has('enemy_2035_sybox'));
  assert.ok(deps.supportedBranchKeys.includes('trap_068_badbox#1'));
  assert.ok(deps.supportedBranchKeys.includes('trap_068_badbox#2'));
  const dormant = structuredClone(raw);
  dormant.waves = [];
  assert.equal(inspectOfficialActionDependencies(dormant).ids.has('enemy_2035_sybox'), false);
  const actions = raw.waves.flatMap((w) => w.fragments.flatMap((f) => f.actions));
  for (const a of actions) if (a.actionType === 'ACTIVATE_PREDEFINED' && a.key?.startsWith('trap_068_badbox')) a.hiddenGroup = 'test:hidden';
  assert.equal(inspectOfficialActionDependencies(raw).ids.has('enemy_2035_sybox'), false);
  assert.equal(inspectOfficialActionDependencies(raw, ['test:hidden']).ids.has('enemy_2035_sybox'), true);
});

test('real Izumik level admits its bound branches and all original jelly alternatives', () => {
  const raw = level(INDEX.stagesById.ro2_b_7.file);
  const deps = inspectOfficialActionDependencies(raw);
  assert.equal(deps.supportedBranchKeys.length, 5);
  const option = officialMizukiStageOptions().find((v) => v.id === 'ro2_b_7');
  assert.equal(option.limitations.some((v) => v.code === 'branches'), false);
  for (const key of ['enemy_2041_syjely_boom1', 'enemy_2041_syjely_boom2', 'enemy_2041_syjely_o']) {
    assert.ok(deps.ids.has(key), key);
    assert.ok(raw.enemyDbRefs.some((ref) => ref.id === key), key);
  }
});

test('native flking map preserves its dormant copied ice branch without inventing an ice crystal', () => {
  const option = officialMizukiStageOptions().find((v) => v.id === 'ro2_b_10');
  assert.equal(option.available, true);
  const stage = createOfficialMizukiStage('ro2_b_10');
  assert.deepEqual(stage.officialWaveOptions.dormantBranchKeys, ['frosts']);
  assert.equal(stage.officialLevel.predefines.tokenInsts.length, 0);
  assert.equal(stage.officialLevel.enemyDbRefs.some((v) => v.id === 'enemy_2007_flwitch'), false);
  assert.ok(stage.officialLevel.branches.frosts);
});
