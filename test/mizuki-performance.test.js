import test from 'node:test';
import assert from 'node:assert/strict';
import { getData } from '../server/data.js';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { getSendMetadata } from '../server/sendMetadata.js';
import { mergeMizukiField, mergeMizukiSnapshot, mergeMizukiEvents } from '../public/js/mizukiSnapshots.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const command = (match, playerId, message) => assert.equal(match.handle(playerId, message).ok, true, JSON.stringify(message));
function fixture(t, seats = 2) {
  const scheduler = new VirtualScheduler({ instantCombat: false }), frames = [];
  const match = new MizukiMatch({ roomCode: 'PERF', seed: 619, matchId: 'mizuki-performance', hostId: 'p0', data: DATA, scheduler,
    seats: Array.from({ length: seats }, (_, seat) => ({ playerId: 'p' + seat, seat, connected: true })),
    log: { info() {}, warn() {}, error(...args) { assert.fail(args.map(String).join(' ')); } },
    send: (playerId, message) => frames.push({ playerId, message }), broadcast: message => frames.push({ message }), onEnd() {} });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  match.start();
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  for (const [index, player] of match.order.entries()) command(match, player.playerId, { t: 'g.mizuki.strategy', bandId: match.strategyOptions[index].bandId });
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  for (const player of match.order) while (match.phase === PHASE.RECRUIT && !player.ready) {
    command(match, player.playerId, { t: 'g.mizuki.recruit', offerId: match.privateView(player.playerId).mizuki.recruit.skipToken });
  }
  const operators = match.fullCatalog.operators.filter(operator => operator.rarity === 4).slice(0, 3);
  for (const player of match.order) for (const operator of operators) match._grantMetaChess(player, operator.operatorId);
  const route = match.privateView('p0').mizuki.route.find(node => node.type === 'combat' && node.available);
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.route', nodeId: route.id });
  command(match, 'p0', { t: 'g.mizuki.routeStart' });
  for (const player of match.order) for (const unit of player.roster) {
    const prep = match.privateView(player.playerId).mizuki.prep;
    const [row, col] = prep.legalTiles[unit.uid].find(([r, c]) => !prep.board.some(piece => piece.row === r && piece.col === c));
    command(match, player.playerId, { t: 'g.mizuki.move', uid: unit.uid, to: { area: 'board', row, col }, dir: 'RIGHT' });
  }
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.ready', on: true });
  frames.length = 0;
  return { match, scheduler, frames };
}

test('Mizuki keeps two-times simulation and 20 Hz complete battle/HUD frames while coalescing idle panels', t => {
  const { match, scheduler, frames } = fixture(t);
  let snapshots = 0, fieldMetaCalls = 0;
  for (const field of match.fields.values()) {
    const snapshot = field.engine.snapshot.bind(field.engine);
    field.engine.snapshot = (...args) => { snapshots++; return snapshot(...args); };
    const fieldMeta = field.engine.fieldMeta.bind(field.engine);
    field.engine.fieldMeta = () => { fieldMetaCalls++; return fieldMeta(); };
  }
  scheduler.advance(1000);
  assert.ok(match.battleTicks >= 58 && match.battleTicks <= 60);
  const battle = frames.filter(({ message }) => message.t === 'b.snap');
  const panels = frames.filter(({ message }) => message.t === 'm.public');
  assert.ok(battle.length >= 38 && battle.length <= 40);
  assert.ok(panels.length >= 4 && panels.length <= 5);
  assert.equal(snapshots, battle.length, 'one battle snapshot per field per broadcast, none for per-tick settlement');
  assert.equal(fieldMetaCalls, match.fields.size, 'static field metadata is reliable once instead of rebuilt twenty times/second');
  const hydration = { variant: match.variant, mizuki: { fields: [...match.fields.values()].map(field => ({ fieldId: field.fieldId, battleId: field.battleId, t: -1 })) } };
  let hydrated = hydration;
  for (const { message } of frames) {
    if (message.t === 'm.field') hydrated = mergeMizukiField(hydrated, message);
    else if (message.t === 'b.ev') hydrated = mergeMizukiEvents(hydrated, message);
    else if (message.t === 'b.snap') hydrated = mergeMizukiSnapshot(hydrated, message);
  }
  for (const { message } of battle) {
    assert.equal(getSendMetadata(message).cadenceMs, 10);
    assert.ok(message.battleId && message.fieldId && message.partyId);
    assert.ok(Array.isArray(message.players) && message.players.length === 1);
    assert.ok(message.rosters && message.progression);
    assert.equal(message.stage, undefined); assert.equal(message.geometry, undefined); assert.equal(message.meta, undefined);
    assert.ok(message.objectiveLossByPlayer && message.objectiveDirectLossByPlayer);
    assert.ok(Array.isArray(message.damageRows));
    assert.equal(message.time, message.tick / 30);
  }
  for (const field of hydrated.mizuki.fields) {
    assert.ok(field.stage && field.geometry && field.meta && field.units);
    for (const [id] of field.units) assert.ok(field.meta.units.some(unit => String(unit.id) === String(id)), 'reliable metadata/spawn events describe every displayed unit');
  }
  for (const { message } of panels) {
    const { legacyMessage, ...metadata } = getSendMetadata(message);
    assert.equal(typeof legacyMessage, 'function');
    assert.deepEqual(metadata, { priority: 'medium', periodic: true, cadenceMs: 200 });
    assert.equal(message.gameSpeed, 2);
    for (const field of message.mizuki.fields) {
      const packet = battle.find(({ message: snapshot }) => snapshot.fieldId === field.fieldId && snapshot.time === field.t)?.message;
      assert.ok(packet);
      const { t: _type, time: _time, ...value } = packet;
      assert.deepEqual({ ...value, t: field.t }, field);
    }
  }
  const before = frames.filter(({ message }) => message.t === 'm.public').length;
  match._commit();
  assert.equal(frames.filter(({ message }) => message.t === 'm.public').length, before + 1, 'commands publish immediately');
  assert.deepEqual(getSendMetadata(frames.filter(({ message }) => message.t === 'm.public').at(-1).message), {}, 'committed panels remain reliable');
  const player = match.order[0], count = frames.length;
  match.onReconnect(player.playerId);
  assert.ok(frames.slice(count).some(frame => frame.playerId === player.playerId && frame.message.t === 'm.private'));
  assert.ok(frames.slice(count).some(frame => frame.playerId === player.playerId && frame.message.t === 'b.snap'));
  for (const { message } of frames.slice(count).filter(frame => frame.playerId === player.playerId && frame.message.t === 'b.snap')) {
    assert.equal(message.droppable, false, 'reconnect snapshots cannot be coalesced behind idle traffic');
    assert.ok(message.players && message.damageRows && message.objectiveLossByPlayer);
  }
  frames.length = 0;
  const changedField = [...match.fields.values()][0], grid = changedField.engine.battle.grid;
  const { r0, c0 } = changedField.engine.battle.rect;
  const previous = grid.version; grid.setObstacle(r0, c0, true);
  assert.ok(grid.version > previous); scheduler.advance(100);
  const update = frames.find(({ message }) => message.t === 'm.field' && message.fieldId === changedField.fieldId)?.message;
  assert.ok(update?.stage && update.geometry && update.units, 'terrain mutation is delivered reliably with complete map metadata');
});

test('lightweight combat settlement exactly matches the complete covenant snapshot path', t => {
  const optimized = fixture(t), complete = fixture(t);
  for (const field of complete.match.fields.values()) {
    const covenants = field.engine.covenants;
    field.engine.covenants = { snapshot: covenants.snapshot.bind(covenants) };
  }
  for (let tick = 0; tick < 120; tick++) {
    for (const current of [optimized, complete]) {
      for (const field of current.match.fields.values()) {
        const owner = field.engine.battle.players[0];
        owner.bonds.visiShip ||= {}; owner.bonds.miraShip ||= {};
        owner.bonds.visiShip.layers = 12 + tick;
        owner.bonds.miraShip.layers = 20 + tick;
        owner.bonds.visiShip.active = true; owner.bonds.miraShip.active = true;
        owner.bonds.visiShip.tier = 1; owner.bonds.miraShip.tier = 1;
      }
      current.scheduler.advance(1000 / 30);
    }
    for (const player of optimized.match.order) {
      const other = complete.match.players.get(player.playerId);
      for (const key of ['layers', 'gold', 'hope', 'hopeCapacity', 'equipmentInventory', 'metaCounters', 'economicCoinTotal']) {
        assert.deepEqual(player[key], other[key], `tick ${tick}: ${player.playerId}.${key}`);
      }
    }
  }
  assert.equal(optimized.match.battleTicks, complete.match.battleTicks);
});

test('participant, eliminated and observer watch requests return one complete independent field immediately', t => {
  const { match, scheduler, frames } = fixture(t);
  scheduler.advance(100);
  const target = [...match.fields.values()].find(field => !field.players.includes('p0'));
  const own = match.players.get('p0').fieldId;
  assert.ok(target && target.fieldId !== own);
  const check = playerId => {
    const sent = frames.filter(frame => frame.playerId === playerId).map(frame => frame.message);
    const metadata = sent.find(frame => frame.t === 'm.field'), snapshot = sent.find(frame => frame.t === 'b.snap');
    assert.equal(metadata.fieldId, target.fieldId);
    assert.equal(snapshot.fieldId, target.fieldId);
    assert.equal(snapshot.battleId, target.battleId);
    assert.equal(snapshot.droppable, false);
    assert.ok(snapshot.stage && snapshot.geometry && snapshot.meta && snapshot.rosters);
    assert.equal(snapshot.time, target.engine.snapshot().t);
    assert.deepEqual(snapshot.players, target.players);
    assert.deepEqual(Object.keys(snapshot.rosters), target.players, 'watching must never merge the independent own roster');
  };
  frames.length = 0;
  command(match, 'p0', { t: 'g.watch', fieldId: target.fieldId, viewOnly: true }); check('p0');
  assert.equal(match.players.get('p0').fieldId, own);
  match.players.get('p0').alive = false;
  frames.length = 0;
  command(match, 'p0', { t: 'g.watch', fieldId: target.fieldId, viewOnly: true }); check('p0');
  match.addObserver('observer'); frames.length = 0;
  assert.equal(match.watchObserver('observer', target.fieldId).ok, true); check('observer');
  assert.notEqual(match.handle('p0', { t: 'g.watch', fieldId: 'missing' }).ok, true);
});


test('existing stream v1 pages receive complete lazy snapshots without taxing v2 recipients', t => {
  const { match, scheduler, frames } = fixture(t);
  let fullSnapshots = 0;
  for (const field of match.fields.values()) {
    const original = field.engine.snapshot.bind(field.engine);
    field.engine.snapshot = (options) => { if (!options?.stream) fullSnapshots++; return original(options); };
  }
  scheduler.advance(260);
  assert.equal(fullSnapshots, 0, 'modern recipients do not build full periodic field metadata');
  const packets = frames.filter(({ message }) => message.t === 'b.snap');
  assert.ok(packets.length > 0);
  const first = packets[0].message, fallback = getSendMetadata(first).legacyMessage;
  const legacy = fallback();
  assert.ok(legacy.meta && legacy.geometry && legacy.stage);
  assert.deepEqual(legacy.units, first.units);
  assert.equal(legacy.fieldId, first.fieldId); assert.equal(legacy.battleId, first.battleId);
  assert.equal(legacy.time, first.time); assert.equal(getSendMetadata(legacy).legacyMessage, undefined);
  assert.strictEqual(fallback(), legacy, 'legacy recipients share one immutable frame');
  assert.equal(fullSnapshots, match.fields.size, 'legacy fallback constructs all fields once per source frame');
  const panel = frames.find(({ message }) => message.t === 'm.public').message;
  const legacyPanel = getSendMetadata(panel).legacyMessage();
  assert.ok(legacyPanel.mizuki.fields.every(field => field.meta && field.stage && field.geometry));
  assert.equal(legacyPanel.phase, panel.phase);
  assert.equal(getSendMetadata(legacyPanel).legacyMessage, undefined);
});

test('combat private panels use ordinary deduplication while preserving updates, retries and committed frames', t => {
  const { match, frames } = fixture(t, 1);
  let value = { t: 'm.private', playerId: 'p0', mizuki: { hope: 4, roster: [{ uid: 1, hp: 20 }] } };
  match.privateView = () => structuredClone(value);
  frames.length = 0;
  match._sendCombatPrivate('p0'); match._sendCombatPrivate('p0');
  assert.equal(frames.length, 1);
  const first = frames[0].message, cached = getSendMetadata(first).encoded;
  assert.equal(cached, JSON.stringify(first));
  value.mizuki.hope++; value.mizuki.roster[0].hp--;
  match._sendCombatPrivate('p0');
  assert.equal(frames.length, 2); assert.equal(frames[1].message.mizuki.hope, 5);
  assert.equal(JSON.parse(cached).mizuki.roster[0].hp, 20, 'prior encoded frames remain immutable');
  match._commit();
  const committed = frames.filter(frame => frame.message.t === 'm.private').at(-1).message;
  assert.deepEqual(getSendMetadata(committed), {}, 'commands still publish reliable full private state');
  const count = frames.length; match._sendCombatPrivate('p0');
  assert.equal(frames.length, count + 1, 'a commit clears deduplication for pending/recovery frames');
  match.opts.send = () => false; value.mizuki.hope++;
  match._sendCombatPrivate('p0');
  match.opts.send = (playerId, message) => frames.push({ playerId, message });
  match._sendCombatPrivate('p0');
  assert.equal(frames.at(-1).message.mizuki.hope, 6, 'a failed send cannot suppress its retry');
});
