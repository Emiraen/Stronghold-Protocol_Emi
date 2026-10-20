import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioManager, bgmKeyFor, resolveBgm } from '../../public/js/audio.js';
import { battleBgmFor, MatchViews } from '../../server/match/match/views.js';
import { createRng } from '../../server/sim/rng.js';
import { PHASE } from '../../shared/constants.js';

const manifest = {
  audio: {
    bgm: {
      lobby: { loop: '/audio/lobby.mp3' }, prep: { loop: '/audio/prep.mp3' },
      combat: { loop: '/audio/combat.mp3' }, boss: { loop: '/audio/boss.mp3' },
      battleTracks: Object.fromEntries(['sand_bgm1', 'sand_bgm2', 'siracusa_bgm1', 'kashimir_bgm1', 'kashimir_bgm2']
        .map((key) => [key, { loop: `/assets/local/audio/bgm/${key}.mp3` }])),
    },
    sfx: { battle: { leak: '/assets/local/audio/b_ui_alarmenter.mp3' } },
  },
};

function fakeAudio() {
  const sources = [];
  class Param {
    constructor() { this.value = 1; }
    setValueAtTime(v) { this.value = v; }
    linearRampToValueAtTime(v) { this.value = v; }
    setTargetAtTime(v) { this.value = v; }
    cancelScheduledValues() {}
  }
  class Node { connect() {} disconnect() {} }
  class Gain extends Node { constructor() { super(); this.gain = new Param(); } }
  class Source extends Node {
    constructor() { super(); this.playbackRate = new Param(); this.started = 0; this.stopped = 0; sources.push(this); }
    start() { this.started++; }
    stop() { this.stopped++; }
  }
  class Context {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = new Node(); }
    createGain() { return new Gain(); }
    createBufferSource() { return new Source(); }
  }
  const a = new AudioManager({
    win: { AudioContext: Context, document: { hidden: false }, removeEventListener() {} },
    getManifest: () => manifest,
  });
  const reads = [];
  a._buffer = async (url) => { reads.push(url); return { duration: 0.01, url }; };
  a._unlock();
  return { a, reads, sources };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('all 11 maps use their specified battle music pool', () => {
  const sand = ['sand_bgm1', 'sand_bgm2'];
  const maps = [
    ...Array.from({ length: 7 }, (_, i) => [`act1autochess_m0${i + 1}`, sand]),
    ['act2autochess_m01', ['siracusa_bgm1']],
    ['act2autochess_m02', sand],
    ['act2autochess_m03', ['kashimir_bgm1', 'kashimir_bgm2']],
    ['act2autochess_m04', sand],
  ];
  for (const [stage, pool] of maps) {
    const selected = new Set();
    for (let seed = 1; seed <= 32; seed++) {
      const key = battleBgmFor(stage, seed);
      assert.ok(pool.includes(key), `${stage}: ${key}`);
      assert.ok(resolveBgm(manifest, `battle:${key}`)?.loop.endsWith(`${key}.mp3`));
      selected.add(key);
    }
    assert.deepEqual([...selected].sort(), [...pool].sort(), `${stage}: both candidate tracks can be chosen`);
  }
  assert.equal(battleBgmFor('unknown', 1), null);
});

test('public view fixes battle music before combat and never consumes gameplay RNG', () => {
  const m = Object.assign(new MatchViews(), {
    phase: PHASE.INFO_CHECK, stageId: 'act2autochess_m03', seed: 412,
    rng: createRng(412), round: 1, gd: { lastRound: 15, spRounds: () => [] },
    sched: { now: () => 1000 }, factions: [], disabledBonds: [], staticInactiveBonds: [],
    bannedChess: [], order: [], fields: [],
  });
  const before = m.rng.state();
  const selected = m.publicView().battleBgm;
  assert.ok(['kashimir_bgm1', 'kashimir_bgm2'].includes(selected));
  for (const phase of [PHASE.PREP, PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE, PHASE.RESULT]) {
    m.phase = phase;
    m.round++;
    assert.equal(m.publicView().battleBgm, selected, `${phase}: same music throughout the match`);
    assert.equal(m.rng.state(), before, 'serializing the choice cannot alter gameplay randomness');
  }
});

test('the four battle phases select match music; preparation and results restore original BGM', () => {
  const pub = { battleBgm: 'sand_bgm2', bossId: 'boss_1', hiddenBossId: 'boss_2' };
  for (const phase of [PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]) {
    assert.equal(bgmKeyFor('game', { ...pub, phase }), 'battle:sand_bgm2');
  }
  assert.equal(bgmKeyFor('game', { ...pub, phase: PHASE.PREP }), 'prep');
  assert.equal(bgmKeyFor('game', { ...pub, phase: PHASE.SETTLE }), 'prep');
  assert.equal(bgmKeyFor('game', { ...pub, phase: PHASE.RESULT }), 'lobby');
  assert.equal(bgmKeyFor('room', pub), 'lobby');
});

test('cached battle track loops across battle phases and stops when preparation resumes', async () => {
  const { a, sources } = fakeAudio();
  const pub = { battleBgm: 'sand_bgm1', phase: PHASE.COMBAT };
  a.playBgm(bgmKeyFor('game', pub));
  await flush();
  const music = a.bgm.nodes[0].src;
  assert.equal(a.bgm.loopUrl, manifest.audio.bgm.battleTracks.sand_bgm1.loop);
  assert.equal(music.loop, true, 'short music loops until combat ends');
  for (const phase of [PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]) {
    a.playBgm(bgmKeyFor('game', { ...pub, phase }));
    await flush();
    assert.equal(a.bgm.nodes[0].src, music, 'same match track does not restart between battle phases');
  }
  a.playBgm(bgmKeyFor('game', { ...pub, phase: PHASE.PREP }));
  await flush();
  assert.equal(a.bgm.loopUrl, manifest.audio.bgm.prep.loop);
  assert.equal(music.stopped, 1, 'battle music is stopped on leaving combat');
  assert.equal(sources.length, 2);
});

test('missing optional battle audio falls back to original combat music', async () => {
  const { a, reads } = fakeAudio();
  const optional = manifest.audio.bgm.battleTracks.sand_bgm2.loop;
  a._buffer = async (url) => { reads.push(url); return url === optional ? null : { duration: 0.01, url }; };
  a.playBgm('battle:sand_bgm2');
  await flush();
  assert.deepEqual(reads, [optional, manifest.audio.bgm.combat.loop]);
  assert.equal(a.bgm.loopUrl, manifest.audio.bgm.combat.loop);
  assert.equal(a.bgm.nodes[0].src.loop, true);
});

test('every leak in one tick starts an alarm even when ordinary voice channels are full', async () => {
  const { a, reads, sources } = fakeAudio();
  a.limiter.active = a.limiter.maxVoices;
  a.uiVoices = 12;
  a.handleBattleEvents(Array.from({ length: 20 }, (_, i) => ['leak', i + 100]));
  await flush();
  assert.equal(reads.length, 20);
  assert.ok(reads.every((url) => url === manifest.audio.sfx.battle.leak));
  assert.equal(sources.filter((source) => source.started).length, 20, 'one alarm per enemy, without tick coalescing');
  assert.equal(a.limiter.active, a.limiter.maxVoices, 'priority alarms do not corrupt the ordinary limiter');
  assert.equal(a.uiVoices, 12);
});
