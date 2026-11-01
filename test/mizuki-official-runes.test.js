import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileOfficialRunes, applyOfficialEnemyRunes, applyOfficialLevelRunes }
  from '../server/modes/mizuki/OfficialRunes.js';
import { officialMizukiStageOptions, resolveOfficialEnemy, translateOfficialMap }
  from '../server/modes/mizuki/official-stages.js';
import { Grid } from '../server/sim/grid.js';
const level = (id) => JSON.parse(readFileSync(new URL('../data/mizuki/levels/level_rogue2_' + id + '.json', import.meta.url), 'utf8'));
const bb = (r) => Object.fromEntries((r || []).map((v) => [v.key, v.value]));

test('all original stage runes have an exact supported handler', () => {
  for (const stage of officialMizukiStageOptions()) assert.deepEqual(stage.unsupported.filter((v) =>
    v.code === 'rune' || v.code === 'rune_parameter'), [], stage.id);
});

test('targeted attribute runes ignore numeric string-selector placeholders and affect only that family', () => {
  const input = { runes: [{ key: 'enemy_attribute_mul', difficultyMask: 'FOUR_STAR', blackboard: [
    { key: 'enemy', value: 0, valueStr: 'a|a|b' }, { key: 'atk', value: 1.3, valueStr: null }] }] };
  const cfg = compileOfficialRunes(input, 'FOUR_STAR');
  const enemy = { attributes: { maxHp: 100, atk: 50 } };
  assert.equal(applyOfficialEnemyRunes('a', enemy, cfg).attributes.atk, 65);
  assert.equal(applyOfficialEnemyRunes('c', enemy, cfg).attributes.atk, 50);
  assert.equal(enemy.attributes.atk, 50);
  assert.deepEqual(cfg.unsupported, []);
});

test('emergency stun skill gains the source five seconds and slime receives original invisible ability', () => {
  const l = level('1-3'), cfg = compileOfficialRunes(l, 'FOUR_STAR');
  const base = resolveOfficialEnemy(l.enemyDbRefs.find((r) => r.id === 'enemy_1047_sagent'));
  const out = applyOfficialEnemyRunes('enemy_1047_sagent', base, cfg);
  const before = base.skills.find((s) => s.prefabKey === 'stunattack');
  const after = out.skills.find((s) => s.prefabKey === 'stunattack');
  assert.equal(bb(after.blackboard).stun, bb(before.blackboard).stun + 5);
  const slime = applyOfficialEnemyRunes('enemy_1007_slime_2', { attributes: {} }, cfg);
  assert.deepEqual(slime.mizukiDynamicAbilities, ['invisible']);
});

test('emergency forbidden coordinates retain road passability and block only deployment', () => {
  const l = level('2-3'), cfg = compileOfficialRunes(l, 'FOUR_STAR');
  const out = applyOfficialLevelRunes(l, cfg);
  const a = translateOfficialMap('before', l, { name: 'source' });
  const b = translateOfficialMap('after', out, { name: 'source' });
  const before = new Grid(a.stage, a.rect), after = new Grid(b.stage, b.rect);
  assert.deepEqual(cfg.forbidden, [[1, 6], [5, 6], [2, 7], [4, 7]]);
  for (const [r, c] of cfg.forbidden) {
    assert.equal(after.tile(r, c).build, 'NONE');
    assert.equal(after.tile(r, c).key, before.tile(r, c).key);
    assert.equal(after.tile(r, c).pass, before.tile(r, c).pass);
  }
  assert.notDeepEqual(l, out);
  assert.deepEqual(compileOfficialRunes(l, 'NORMAL').forbidden, []);
});

test('enemy replacement touches source spawn actions, not shared enemy IDs or source files', () => {
  const source = { runes: [{ key: 'level_enemy_replace', difficultyMask: 'FOUR_STAR', blackboard: [
    { key: 'key', value: 0, valueStr: 'original' }, { key: 'value', value: 0, valueStr: 'elite' }] }],
  waves: [{ fragments: [{ actions: [{ actionType: 'SPAWN', key: 'original' }] }] }],
  branches: { b: { phases: [{ actions: [{ actionType: 'SPAWN', key: 'original' }] }] } } };
  const out = applyOfficialLevelRunes(source, compileOfficialRunes(source, 'FOUR_STAR'));
  assert.equal(out.waves[0].fragments[0].actions[0].key, 'elite');
  assert.equal(out.branches.b.phases[0].actions[0].key, 'elite');
  assert.equal(source.waves[0].fragments[0].actions[0].key, 'original');
});

test('facility presence and skill index follow original emergency aliases', () => {
  const l = level('3-8');
  const out = applyOfficialLevelRunes(l, compileOfficialRunes(l, 'FOUR_STAR'));
  const ballistae = out.predefines.tokenInsts.filter((p) => p.inst.characterKey === 'trap_007_ballis');
  assert.equal(ballistae.length, 3);
  assert.ok(ballistae.every((p) => p.hidden === false));
  const w = level('4-8');
  const replaced = applyOfficialLevelRunes(w, compileOfficialRunes(w, 'FOUR_STAR'));
  assert.equal(replaced.predefines.tokenInsts.find((p) => p.alias === 'trap_057_wpnsts#1').skillIndex, 1);
});

test('tile and respawn runes use original numeric values while NONE masks stay inactive', () => {
  const l = level('4-2'), cfg = compileOfficialRunes(l, 'FOUR_STAR'), out = applyOfficialLevelRunes(l, cfg);
  const i = l.mapData.tiles.findIndex((t) => t.tileKey === 'tile_volcano');
  assert.equal(bb(out.mapData.tiles[i].blackboard).damage, bb(l.mapData.tiles[i].blackboard).damage * 1.5);
  assert.equal(compileOfficialRunes(level('b-10'), 'NORMAL').respawnTime, 2);
  const none = { runes: [{ key: 'char_attribute_mul', difficultyMask: 'NONE', blackboard: [{ key: 'max_hp', value: 3 }] }] };
  assert.equal(compileOfficialRunes(none, 'NORMAL').charRules.length, 0);
});
