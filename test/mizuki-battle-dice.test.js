import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Battle } from '../server/sim/Battle.js';
import { installMizukiActiveTools } from '../server/modes/mizuki/ActiveTools.js';
import { mizukiBattleDiceSpec, mizukiBattleDiceResult, snapshotMizukiBattleDiceEffects } from '../server/modes/mizuki/BattleDice.js';
import { compileEffect, Effect } from '../public/js/render/vfx/effect.js';
import { FrameData, cameraBasis } from '../public/js/render/vfx/geom.js';
import { createMizukiBattleSfx } from '../public/js/mizukiBattleSfx.js';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, a + ' != ' + b);
function fixture(diceId = 'rogue_2_dice_1', count = 1) {
  const inputs = Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat, activeTools: [],
    units: [{ uid: seat + 1, chessId: 'chess_char_1_02_a', row: 10 + seat, col: 5, abs: true }] }));
  const b = new Battle({ seed: 77, stageId: 'act1autochess_m02', content: 'none',
    rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, players: inputs });
  for (const player of b.players) player.dp = 10;
  let dice = 1, spent = false, rolls = [];
  const tools = installMizukiActiveTools(b, inputs, { id: diceId, canSpend: () => dice > 0 && !spent,
    spend: () => { if (!dice || spent) return false; dice--; spent = true; return true; }, onRoll: result => rolls.push(result) });
  const deploy = (playerId = 'p0', row = 9, col = 3) => tools.deploy(playerId, { uid: 900000000 + Number(playerId.slice(1)), row, col, dir: 'RIGHT' });
  return { b, tools, deploy, inputs, dice: () => dice, rolls };
}

test('all native die faces decode their original skill blackboard and exact thresholds', () => {
  for (const [id, faces] of [['rogue_2_dice_1', 6], ['rogue_2_dice_4', 8], ['rogue_2_dice_41', 12]]) {
    const spec = mizukiBattleDiceSpec(id); assert.equal(spec.faces, faces); assert.equal(spec.stats.cost, 3);
    for (let roll = 1; roll <= faces; roll++) {
      const result = mizukiBattleDiceResult(spec, roll), tier = roll <= 3 ? 0 : roll <= 6 ? 1 : roll <= 9 ? 2 : 3;
      assert.equal(result.tier, tier); assert.equal(result.duration, 15);
      assert.equal(result.aspd, [-20, -30, -40, -40][tier]);
      assert.equal(result.move, [-.5, -.7, -.8, -.8][tier]);
      assert.equal(result.redeployScale, [1, 1, .5, 0][tier]);
    }
  }
});

test('each die tier changes actual enemy stats and deducts exactly 3 DP and one shared die', () => {
  for (const [id, roll] of [['rogue_2_dice_1', 1], ['rogue_2_dice_1', 6], ['rogue_2_dice_4', 8], ['rogue_2_dice_41', 12]]) {
    const f = fixture(id), enemy = f.b.spawnEnemy('enemy_1007_slime');
    const before = { aspd: enemy.s.aspd, move: enemy.s.moveSpeed };
    f.b.rng = () => (roll - .5) / mizukiBattleDiceSpec(id).faces;
    const result = f.deploy(); assert.equal(result.ok, true); assert.equal(result.dice.roll, roll);
    assert.equal(f.dice(), 0); assert.equal(f.b.getPlayer('p0').dp, 7); assert.equal(f.rolls.length, 1);
    close(enemy.s.aspd, before.aspd + result.dice.aspd);
    close(enemy.s.moveSpeed, before.move * (1 + result.dice.move));
    assert.equal(f.tools.snapshot().p0.length, 0); assert.equal(f.deploy().ok, false);
  }
});

test('the native aura gives late enemies their full duration and ends after the die disappears', () => {
  const f = fixture(), early = f.b.spawnEnemy('enemy_1007_slime'); f.b.rng = () => 0;
  const result = f.deploy(), key = 'mizuki:dice:' + result.unitId;
  assert.equal(early.findBuff(key).timeLeft, 15);
  f.b.time = 14; const late = f.b.spawnEnemy('enemy_1007_slime');
  assert.equal(late.findBuff(key).timeLeft, 15);
  f.b.time = 15.01; f.b.emit('tick', { dt: 1.01 });
  assert.equal(f.b.allyUnits.find(unit => unit.id === result.unitId).alive, false);
  assert.equal(f.b.spawnEnemy('enemy_1007_slime').findBuff(key), null);
  f.b._tickBuffs(15.01); close(late.s.moveSpeed, late.base.moveSpeed);
});

test('eight- and twelve-sided dice reduce current cooldowns of both players without altering future base cooldown', () => {
  for (const [id, roll, scale] of [['rogue_2_dice_4', 8, .5], ['rogue_2_dice_41', 9, .5], ['rogue_2_dice_41', 10, 0]]) {
    const f = fixture(id, 2); f.b.time = 10;
    for (const unit of f.b.allyUnits) { unit.respawnAt = 70; unit.mem.readyAt = 50; unit.mem.deckReadyAt = 30; }
    const original = f.b.allyUnits.map(unit => unit.base.respawnTime);
    f.b.rng = () => (roll - .5) / mizukiBattleDiceSpec(id).faces; assert.equal(f.deploy().ok, true);
    for (const [index, unit] of f.b.allyUnits.filter(unit => unit.kind === 'op').entries()) {
      close(unit.respawnAt, 10 + 60 * scale); close(unit.mem.readyAt, 10 + 40 * scale);
      close(unit.mem.deckReadyAt, 10 + 20 * scale); assert.equal(unit.base.respawnTime, original[index]);
    }
    assert.equal(f.deploy('p1', 9, 4).ok, false); assert.equal(f.b.getPlayer('p1').dp, 10); assert.equal(f.dice(), 0);
  }
});

test('invalid placement and insufficient DP neither spend dice nor create a successful tool use', () => {
  const f = fixture(); assert.equal(f.deploy('p0', -1, 0).ok, false);
  assert.equal(f.dice(), 1); assert.equal(f.b.getPlayer('p0').dp, 10);
  f.b.getPlayer('p0').dp = 2; assert.equal(f.deploy().error, 'NO_DP'); assert.equal(f.dice(), 1);
  f.b.getPlayer('p0').dp = 10; assert.equal(f.deploy().ok, true);
});

test('normal Stronghold active tools receive no dice unless the Mizuki dice options are provided', () => {
  const f = fixture(); assert.deepEqual(installMizukiActiveTools(f.b, f.inputs).snapshot(), { p0: [] });
});

test('native dice effects produce actual renderer geometry and all dependencies are required resources', () => {
  const json = path => JSON.parse(readFileSync(new URL('../' + path, import.meta.url), 'utf8'));
  const manifest = json('public/assets/mizuki/fx/manifest.json');
  const preload = ['data/resource-preload.json', 'data/resource-preload.local.json',
    'data/resource-preload.json.gz', 'data/resource-preload.runtime.json.gz'].map(path => {
    const bytes = readFileSync(new URL('../' + path, import.meta.url));
    return new Map(JSON.parse((path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString()).groups.required.map(entry => [entry.url, entry]));
  });
  const verified = new Set();
  const verify = record => {
    if (verified.has(record.path)) return; verified.add(record.path);
    const bytes = readFileSync(new URL('../public' + record.path, import.meta.url));
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert.equal(hash, record.sha256, record.path); assert.equal(bytes.length, record.bytes);
    for (const entries of preload) { const item = entries.get(record.path); assert.ok(item, record.path);
      assert.equal(item.version, hash); assert.equal(item.bytes, bytes.length); }
  };
  const meshes = new Map();
  const lib = { mesh: key => meshes.get(key) || null };
  const camera = cameraBasis(45, [0, -15, -15], 900, .8);
  for (const key of ['rogue_active_01', 'rogue_trai_01', 'rogue_buff_01', 'rogue_buff_02', 'rogue_buff_03', 'rogue_buff_04']) {
    const record = manifest.groups['fx/prefabs'][key]; verify(record);
    const desc = json('public' + record.path);
    assert.ok(desc.stats.particleSystems >= 7);
    for (const [group, ids] of [['fx/tex', desc.textures], ['fx/mesh', desc.meshes]]) for (const id of ids) {
      const asset = manifest.groups[group][id]; verify(asset);
      if (group === 'fx/mesh') meshes.set(id, json('public' + asset.path));
    }
    const def = compileEffect(desc, lib), effect = new Effect(def, { lib, seed: 1 });
    effect.place({ pos: [0, 0, 0], groundZ: 0 });
    let drawn = 0;
    for (let frame = 0; frame < 60; frame++) {
      effect.update(1 / 30); const data = new FrameData();
      effect.collect(camera, data, entry => { drawn += entry.count || 0; }, frame);
    }
    assert.ok(drawn > 0, key + ' must generate real geometry, not an empty exported root');
  }
  const library = json('public/assets/mizuki/library/manifest.json');
  const tokens = json('data/mizuki/runtime-ui.json').tokens;
  for (const id of ['rogue_2_dice_battle1', 'rogue_2_dice_battle2', 'rogue_2_dice_battle3']) {
    const spec = mizukiBattleDiceSpec(id); verify(library.groups.items[id]);
    assert.equal(tokens[spec.key].assets.avatar, id); assert.equal(tokens[spec.key].stats.cost, 3);
  }
});

test('dice result snapshot publishes original tier visuals and sound through existing battle channels', () => {
  const f = fixture('rogue_2_dice_41'); f.b.rng = () => .99; const result = f.deploy();
  assert.equal(result.ok, true);
  assert.deepEqual(snapshotMizukiBattleDiceEffects(f.b).map(item => item.key), ['rogue_trai_01', 'rogue_buff_04']);
  const played = [];
  const audio = { ctx: {}, setFieldUnits() {}, handleBattleEvents() {}, sfx(key) { played.push(key); } };
  const sfx = createMizukiBattleSfx(audio); sfx.setField({ fieldId: 'a', meta: { units: [] } });
  const packet = { fieldId: 'a', events: f.b.drainEvents() };
  assert.equal(sfx.pushEvents(packet), true); assert.equal(sfx.pushEvents(packet), false);
  assert.deepEqual(played, ['mizuki:ui.ON_ROGUELIKE_DICEGREAT']);
  f.b.time = 16; assert.deepEqual(snapshotMizukiBattleDiceEffects(f.b), []); sfx.dispose();
});

test('production dice spending persists through combat PREP rewind and is shared atomically across parallel fields', t => {
  const data = getData({ log: { info() {}, warn() {}, error() {} } });
  const scheduler = new VirtualScheduler({ instantCombat: false });
  let saves = 0;
  const options = { data, scheduler, roomCode: 'DICE', seed: 912, seats: [{ playerId: 'p0', seat: 0, connected: true }],
    dungeon: { zones: [{ id: 'zone_1', nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] }] }] },
    send() {}, broadcast() {}, onEnd() {}, onCheckpoint() { saves++; } };
  const match = new MizukiMatch(options); t.after(() => { match.dispose(); scheduler.dispose(); });
  const command = message => assert.deepEqual(match.handle('p0', message), { ok: true });
  match.start(); command({ t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  command({ t: 'g.mizuki.strategy', bandId: 'band_amiya' });
  command({ t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
  command({ t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' }); skipMizukiRecruit(match);
  command({ t: 'g.mizuki.route', nodeId: match.privateView('p0').mizuki.route.find(node => node.available).id });
  command({ t: 'g.mizuki.routeStart' });
  command({ t: 'g.mizuki.ready', on: true });
  const field = [...match.fields.values()][0]; field.engine.step(1 / 30);
  const stock = field.engine.activeTools.snapshot().p0.find(tool => tool.toolId.startsWith('rogue_2_dice_battle'));
  assert.ok(stock, 'production combat publishes the original die through its existing tool stock');
  const tile = field.engine.snapshot().geometry.tiles.find(tile => !tile.obstacle && tile.build !== 'NONE'
    && !['start', 'end'].includes(tile.special) && !field.engine.battle.unitAt(tile.row, tile.col));
  assert.ok(tile); const before = match.dice, savedBefore = saves;
  command({ t: 'g.mizuki.deploy', battleId: field.battleId, uid: stock.uid, row: tile.row, col: tile.col, dir: 'RIGHT' });
  assert.equal(match.dice, before - 1); assert.equal(saves, savedBefore + 1);
  const doc = match.exportCheckpoint(); assert.equal(doc.mizuki.battleDiceSpent[field.battleDiceKey], 1);
  assert.equal(doc.mizuki.dice, before - 1);
  const restored = new MizukiMatch({ ...options, onCheckpoint() {} }); t.after(() => restored.dispose());
  assert.equal(restored.restoreCheckpoint(doc), true);
  assert.equal(restored._battleDiceOptions(field.battleDiceKey, ['p0']).canSpend(), false);
  assert.equal(restored.dice, before - 1);
  restored.dice = 1;
  const first = restored._battleDiceOptions('parallel-a', ['p0']), second = restored._battleDiceOptions('parallel-b', ['p0']);
  assert.equal(first.spend(), true); assert.equal(second.spend(), false); assert.equal(restored.dice, 0);
  assert.equal(first.spend(), false); assert.equal(restored.dice, 0);
});
