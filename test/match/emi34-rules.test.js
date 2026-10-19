// Emi34：定向规则验证及失败用例复验；仅使用内存 RankedStore，不导入 PlayerStore 或服务器入口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 将持久化误调用直接变成验证失败；游戏data目录的只读配置不受影响。
const rawRead = fs.readFileSync;
let blockedPersistence = 0;
const blockedOperations = [];
const researchReads = new Set();
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const checkRead = (input) => {
  const name = path.resolve(input instanceof URL ? fileURLToPath(input) : String(input)).replaceAll('\\', '/');
  const readOnlyJson = name.startsWith(`${sourceRoot}data/`) || name.startsWith(`${sourceRoot}docs/research/`);
  const sourceModule = name.startsWith(sourceRoot) && /\.(?:m?js|cjs)$/.test(name);
  if (!readOnlyJson && !sourceModule) {
    blockedPersistence++;
    blockedOperations.push({ operation: 'read', path: name });
    throw new Error(`隔离验证禁止读取非源码文件：${name}`);
  }
  if (name.startsWith(`${sourceRoot}docs/research/`)) researchReads.add(name.slice(sourceRoot.length));
};
fs.readFileSync = (input, ...args) => { checkRead(input); return rawRead(input, ...args); };
const rawAsyncRead = fs.readFile;
fs.readFile = (input, ...args) => { checkRead(input); return rawAsyncRead(input, ...args); };
const rawPromiseRead = fs.promises.readFile;
fs.promises.readFile = (input, ...args) => { checkRead(input); return rawPromiseRead(input, ...args); };
for (const name of ['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'mkdirSync']) {
  fs[name] = (path) => {
    blockedPersistence++;
    blockedOperations.push({ operation: name, path: String(path) });
    throw new Error(`隔离验证禁止磁盘写入：${name}`);
  };
}
for (const name of ['writeFile', 'appendFile', 'rename', 'unlink', 'mkdir', 'open']) {
  const deny = (input) => {
    blockedPersistence++;
    blockedOperations.push({ operation: name, path: String(input) });
    throw new Error(`隔离验证禁止磁盘写入或直接打开：${name}`);
  };
  fs[name] = deny;
  fs.promises[name] = deny;
}
syncBuiltinESMExports();

// 守卫先于游戏模块加载，避免静态import在守卫安装前完成模块初始化。
const { APP_VERSION, EMI_BUILD, modeIdFor } = await import('../../shared/constants.js');
const { GameData } = await import('../../server/match/gamedata.js');
const { bossPoolHp, SharedBossPool, CreditPool } = await import('../../server/match/finalAssault.js');
const { generateDraft } = await import('../../server/match/choices.js');
const { rankDelta } = await import('../../shared/ranks.js');
const { RankedStore } = await import('../../server/rankedStore.js');
const { createBattleFromSpec } = await import('../../server/sim/spec.js');
const { makeMatch, DATA, give } = await import('./harness.js');
const { canPlace, placeClass } = await import('../../server/match/board.js');

const difficulties = ['FUNNY', 'NORMAL', 'HARD', 'ABYSS'];
const spectators = ['viewer_1', 'viewer_2'];
const observe = (t, value) => t.diagnostic(`EMI34_OBSERVATION ${JSON.stringify(value)}`);

function initialPrep(h) {
  const m = h.m;
  m.start();
  // 多座位独立是人数矩阵的合成输入；它没有同盟的策略超时，必须逐人选不同策略。
  if (m.isSolo && m.order.length > 1) {
    for (const ps of m.order) m.handle(ps.playerId, { t: 'g.infoReady' });
    h.runToPhase('BAND_DRAFT');
    for (const [i, ps] of m.order.entries()) {
      if (i === 1) {
        const firstPick = m.draft.picks[m.order[0].playerId];
        const rejected = m.handle(ps.playerId, { t: 'g.band', bandId: firstPick });
        assert.equal(rejected.detail, '队友已选');
        assert.equal(m.draftTurn(), ps.playerId);
        assert.equal(m.deadline, 0);
        h.duplicateBandEvidence = { rejected, phase: m.phase, deadline: m.deadline };
      }
      const accepted = m.handle(ps.playerId, { t: 'g.band', bandId: m.timeoutBand(ps.playerId) });
      assert.equal(accepted.ok, true);
    }
  }
  h.toPrep(1);
}

function realSoloAuthority(t) {
  const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', humans: 1, spectators,
    instant: false, clientCombat: true, pace: 'paced', captureFrames: false });
  try {
    const m = h.m;
    initialPrep(h);
    const ps = h.ps('p_0');
    const map = ps.deployMap();
    let placed = false;
    for (const id of m.gd.visibleChess) {
      if (placed) break;
      const cls = placeClass(ps, m.gd.chess(id));
      for (let r = 9; r <= 12 && !placed; r++) for (let c = 1; c <= 7 && !placed; c++) {
        if (!canPlace(map, cls, r, c)) continue;
        give(m, ps, id, 'board', [r, c]);
        placed = true;
      }
    }
    assert.ok(placed, '真实数据干员部署于合法棋盘');
    ps.lp = 1000;
    m.round = m.gd.bossRound; m.bossId = 'boss_1';
    m.startFinalAssault(false);
    const f = m.fields[0];
    const max = m.bossPool.maxHp;
    assert.equal(max, Math.round(DATA.bosses.boss_1.bloodPoint.FUNNY * 0.25));
    assert.equal(f.authority, 'p_0');
    const client = h.clients.get('p_0');
    assert.ok(h.run(() => {
      const local = client.battles.get(f.battleId)?.battle;
      return !!local?.enemies.some((e) => e.alive && e.isBoss);
    }, { maxSteps: 4000 }), '真实模拟生成领袖');
    const entry = client.battles.get(f.battleId);
    const local = entry.battle;
    assert.equal(local.constructor.name, 'Battle');
    assert.ok(entry.authoritative);
    assert.equal(entry.spec.boss.poolMax, max);
    const boss = local.enemies.find((e) => e.alive && e.isBoss);
    const op = local.allyUnits.find((u) => u.kind === 'op' && u.alive);
    assert.ok(op, '真实模拟中的干员');
    // 确定性伤害刺激只调用真实Battle.dealDamage；不改Boss倍率、不直接写任何血池。
    const before = local.sharedBoss.hp;
    const dealt = local.dealDamage(op, boss, { amount: before, type: 'true', canDodge: false });
    assert.ok(dealt > 0);
    assert.equal(local.sharedBoss.hp, 0);
    assert.ok(h.run(() => m.phase !== 'FINAL_ASSAULT', { maxSteps: 4000 }));
    const result = h.runToEnd({ maxSteps: 4000 });
    h.sched.advance(1000);
    const outgoing = client.log.filter((msg) => msg.battleId === f.battleId);
    assert.ok(outgoing.some((msg) => msg.t === 'b.progress' && msg.bossDmg > 0));
    assert.ok(outgoing.some((msg) => msg.t === 'b.result'));
    assert.ok(client.starts.some((msg) => msg.battleId === f.battleId && msg.authoritative));
    assert.ok(client.ends.some((msg) => msg.battleId === f.battleId));
    assert.ok(client.pools.some((msg) => msg.hp === 0));
    assert.equal(m.bossPool.hp, 0);
    assert.equal([...m.bossPool.byPlayer.values()].reduce((a, b) => a + b, 0), max);
    assert.equal(result.victory, true);
    assert.equal(m._finalEnding, 'cleared');
    assert.equal(m.errorCount, 0);
    assert.equal(m.verifyStats.rejected, 0);
    assert.equal(m.rankedStore, null);
    observe(t, { check: 'soloRealBattleAuthorityChain', humans: 1, spectators: 2, simulation: local.constructor.name,
      stimulus: '真实Battle.dealDamage的确定性真伤；非自然阵容强度验收', max, dealt,
      authority: f.authority, frames: outgoing.map((msg) => msg.t),
      finalHp: m.bossPool.hp, creditedDamage: max, victory: result.victory,
      poolBroadcasts: client.pools.length, rejected: m.verifyStats.rejected, errors: m.errorCount });
  } finally { h.clients.closeAll(); h.m.dispose(); }
}

test('版本：Emi修改#34，APP仍为0.1.3', () => {
  assert.equal(APP_VERSION, '0.1.3');
  assert.equal(EMI_BUILD, 'Emi修改#34');
});

for (const mode of ['solo', 'coop']) for (const difficulty of difficulties) {
  test(`${mode}/${difficulty}：真实模式及全部Boss的存活1..4血池`, (t) => {
    const gd = new GameData(DATA, modeIdFor(mode, difficulty));
    assert.equal(gd.isSolo, mode === 'solo');
    assert.equal(gd.mode.type, mode === 'solo' ? 'SINGLE' : 'MULTI');
    const rows = [];
    for (const [id, boss] of Object.entries(DATA.bosses)) {
      const hp = [];
      for (let alive = 1; alive <= 4; alive++) {
        const share = mode === 'solo' ? 0.25 * alive : 1;
        const want = Math.max(1, Math.round(boss.bloodPoint[difficulty] * share));
        assert.equal(gd.bossPoolShare(alive), share);
        assert.equal(gd.bossPoolHp(id, alive), want);
        assert.equal(bossPoolHp(gd, id, alive), want);
        hp.push(want);
      }
      rows.push({ boss: id, hp });
    }
    observe(t, { check: 'bossMatrix', mode, difficulty, rows });
  });
}

test('独立悬赏：真实会出现悬赏的schedule均固定3项', (t) => {
  let schedules = 0, draws = 0;
  for (const difficulty of difficulties) {
    const h = makeMatch({ mode: 'solo', difficulty });
    try {
      const gd = h.m.gd;
      for (const [round, sch] of Object.entries(gd.choices.schedule[gd.modeId]?.rounds || {})) {
        if (!sch.families?.some((f) => f.family === 'bounty' && f.weight > 0)) continue;
        schedules++;
        const copy = structuredClone(gd.choices);
        copy.schedule[gd.modeId].rounds[round].families = [{ family: 'bounty', weight: 1 }];
        const original = gd.choices;
        gd.raw = { ...gd.raw, choices: copy };
        try {
          for (let i = 0; i < 20; i++) {
            const draft = generateDraft(gd, h.m.rngDraft, Number(round));
            assert.equal(draft.family, 'bounty');
            assert.equal(draft.cards.length, 3);
            assert.equal(new Set(draft.cards.map((c) => c.id)).size, 3);
            draws++;
          }
        } finally { gd.raw = { ...gd.raw, choices: original }; }
      }
    } finally { h.m.dispose(); }
  }
  assert.ok(schedules > 0);
  observe(t, { check: 'soloBountyRealSchedules', schedules, draws });
});

test('独立固定3只作用于悬赏，不受schedule/format数量覆盖，也不改变其他family', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD' });
  try {
    const gd = h.m.gd;
    gd.raw = { ...gd.raw, choices: structuredClone(gd.choices) };
    gd.choices.format.solo.cards = 5;
    for (const cards of [1, 4, 6, null]) {
      gd.choices.schedule[gd.modeId].rounds['3'] = { cards, families: [{ family: 'bounty', weight: 1 }], bountyDraft: 'initial' };
      assert.equal(generateDraft(gd, h.m.rngDraft, 3).cards.length, 3);
    }
    gd.choices.schedule[gd.modeId].rounds['3'] = { cards: 5, families: [{ family: 'supply', weight: 1 }], supplyTiers: [1, 2] };
    assert.equal(generateDraft(gd, h.m.rngDraft, 3).cards.length, 5);
  } finally { h.m.dispose(); }
});

for (const humans of [1, 2, 3, 4]) {
  test(`同盟${humans}人开局：真实悬赏旧数量6不变，观众不计数`, (t) => {
    let schedules = 0, draws = 0;
    for (const difficulty of difficulties) {
      const h = makeMatch({ mode: 'coop', difficulty, humans, spectators });
      try {
        const gd = h.m.gd;
        assert.equal(h.m.players.size, humans);
        assert.equal(h.m.alivePlayers().length, humans);
        assert.equal(gd.choices.format.multi.cards, 6);
        for (const [round, sch] of Object.entries(gd.choices.schedule[gd.modeId]?.rounds || {})) {
          if (!sch.families?.some((f) => f.family === 'bounty' && f.weight > 0)) continue;
          assert.equal(sch.cards, 6);
          schedules++;
          const copy = structuredClone(gd.choices);
          copy.schedule[gd.modeId].rounds[round].families = [{ family: 'bounty', weight: 1 }];
          const original = gd.choices;
          gd.raw = { ...gd.raw, choices: copy };
          try {
            for (let i = 0; i < 20; i++) {
              const draft = generateDraft(gd, h.m.rngDraft, Number(round));
              assert.equal(draft.family, 'bounty');
              assert.equal(draft.cards.length, 6);
              draws++;
            }
          } finally { gd.raw = { ...gd.raw, choices: original }; }
        }
      } finally { h.m.dispose(); }
    }
    assert.ok(schedules > 0);
    observe(t, { check: 'coopBounty', humans, spectators: spectators.length, schedules, draws });
  });
}

// 直接调用真实Boss阶段入口，避免完整对局的无关战斗；客户端spec另用真实Battle反序列化。
for (const mode of ['solo', 'coop']) for (const alive of [1, 2, 3, 4]) {
  test(`${mode}实际存活${alive}：四人开局淘汰，最终/隐藏血池和authority一致`, (t) => {
    const observations = [];
    for (const hidden of [false, true]) for (const clientCombat of [false, true]) {
      const h = makeMatch({ mode, difficulty: 'HARD', humans: 4, spectators, fake: true, instant: false, clientCombat, clients: false });
      try {
        const m = h.m;
        initialPrep(h);
        for (let i = alive; i < m.order.length; i++) m.order[i].alive = false;
        m.round = hidden ? m.gd.hiddenRound : m.gd.bossRound;
        m.bossId = 'boss_1';
        m.hiddenBossId = 'boss_2';
        m.teamLp = 100;
        m.startFinalAssault(hidden);
        const id = hidden ? m.hiddenBossId : m.bossId;
        const want = Math.round(DATA.bosses[id].bloodPoint.HARD * (mode === 'solo' ? 0.25 * alive : 1));
        assert.equal(m.alivePlayers().length, alive);
        assert.equal(m.bossPool.maxHp, want);
        assert.equal(m.fields.flatMap((f) => f.players).length, alive);
        for (const f of m.fields) {
          if (clientCombat) {
            assert.equal(f.mode, 'client');
            assert.ok(f.players.includes(f.authority));
            assert.deepEqual(f.spec.boss, { poolHp: want, poolMax: want });
            const local = createBattleFromSpec(f.spec, DATA, { quiet: true, recordEvents: false });
            assert.equal(local.sharedBoss.hp, want);
            assert.equal(local.sharedBoss.maxHp, want);
          } else assert.equal(f.battle.sharedBoss, m.bossPool);
        }
        assert.equal(m.errorCount, 0);
        observations.push({ hidden, clientCombat, hp: want, fields: m.fields.length,
          authorities: m.fields.map((f) => f.authority ?? 'server'), duplicateBandEvidence: h.duplicateBandEvidence });
      } finally { h.m.dispose(); }
    }
    observe(t, { check: 'bossEntryAuthority', mode, initial: 4, alive, spectators: spectators.length, observations });
  });
}

test('同盟开局1/2/3：真实Boss阶段为四人份；既有可选aliveScaling分支保留', (t) => {
  const rows = [];
  for (const humans of [1, 2, 3]) {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans, spectators, fake: true, instant: false, clientCombat: true, clients: false });
    try {
      const m = h.m;
      initialPrep(h);
      m.round = m.gd.bossRound; m.bossId = 'boss_1';
      m.startFinalAssault(false);
      const base = DATA.bosses.boss_1.bloodPoint.NORMAL;
      assert.equal(m.bossPool.maxHp, base);
      assert.equal(m.bossPool.maxHp / (base / 4), 4);
      rows.push({ initial: humans, hp: m.bossPool.maxHp, singleShareMultiplier: 4 });
    } finally { h.m.dispose(); }
  }
  const gd = new GameData(DATA, 'mode_multi_hard');
  gd.mode = { ...gd.mode, bossHpScale: { ...gd.mode.bossHpScale, aliveScaling: true } };
  for (const alive of [1, 2, 3, 4]) assert.equal(gd.bossPoolShare(alive), alive / 4);
  observe(t, { check: 'coopShortStartAndOptionalScaling', rows });
});

test('无GameData倍率接口时独立fallback同样乘存活人数；省略人数仍为单人份', () => {
  const gd = new GameData(DATA, 'mode_single_hard');
  const base = DATA.bosses.boss_1.bloodPoint.HARD;
  assert.equal(gd.bossPoolHp('boss_1'), base / 4);
  gd.bossPoolShare = undefined;
  for (const alive of [1, 2, 3, 4]) assert.equal(bossPoolHp(gd, 'boss_1', alive), base / 4 * alive);
  assert.equal(bossPoolHp(gd, 'boss_1'), base / 4);
});

for (const mode of ['solo', 'coop']) {
  test(`${mode}客户端真实计账通道：清空血池，胜利且不重复记伤`, (t) => {
    const h = makeMatch({ mode, difficulty: 'FUNNY', humans: 3, spectators, fake: true, instant: false, clientCombat: true,
      script: (b) => b.kind === 'boss' ? { bossDps: 1000000 } : { duration: 2 } });
    try {
      const m = h.m;
      initialPrep(h);
      m.round = m.gd.bossRound; m.bossId = 'boss_1';
      m.startFinalAssault(false);
      const max = m.bossPool.maxHp;
      assert.ok(h.drive(() => m.phase !== 'FINAL_ASSAULT', { maxSteps: 20000 }));
      assert.equal(m.bossPool.hp, 0);
      assert.equal(m._finalEnding, 'cleared');
      assert.equal([...m.bossPool.byPlayer.values()].reduce((a, b) => a + b, 0), max);
      assert.equal(h.runToEnd().victory, true);
      assert.equal(m.errorCount, 0);
      const fields = m.fields.map((f) => ({ fieldId: f.fieldId, battleId: f.battleId, authority: f.authority }));
      assert.ok([...h.clients.values()].some((client) => client.log.some((msg) => msg.t === 'b.progress' && msg.bossDmg > 0)));
      observe(t, { check: 'clientCreditVictory', mode, alive: 3, max, finalHp: 0, fields });
    } finally { h.clients.closeAll(); h.m.dispose(); }
    if (mode === 'solo') realSoloAuthority(t);
  });
}

test('服务端接管CreditPool保留已确认伤害去重', () => {
  const pool = new SharedBossPool(1000);
  pool.damage('p_0', 100);
  const credit = new CreditPool(pool, { acked: 100 });
  assert.equal(credit.damage('p_0', 60), 0);
  assert.equal(credit.damage('p_0', 80), 40);
  assert.equal(pool.hp, 860);
});

test('少人补分完整保留：1/2/3/4人权重1.3/1.2/1.1/1.0及失败、死亡、跳段', (t) => {
  let cases = 0;
  const examples = [];
  for (const difficulty of ['NORMAL', 'HARD', 'ABYSS']) for (const pointsBefore of [600, 1000, 1500, 2300]) {
    for (const humanCount of [1, 2, 3, 4]) for (const mmr of [500, 1000, 1800]) {
      const input = { difficulty, pointsBefore, humanCount, mmr, win: true, alive: true, roundsPassed: 14, layers: 240, assists: 4, hiddenCleared: true, dominantStreakBefore: 1 };
      const base = pointsBefore < 900 ? 100 : pointsBefore < 1200 ? 70 : pointsBefore < 2100 ? 60 : 48;
      const mult = { NORMAL: 0.55, HARD: 1, ABYSS: 1.45 }[difficulty];
      const perf = Math.min(1.15, 0.75 + 0.015 * 14 + 0.0004 * 240 + 0.02 * 4 + 0.05);
      const mmrMult = Math.min(1.15, Math.max(0.85, 1 + (mmr - 1000) / 6666));
      const comp = 1 + 0.1 * (4 - humanCount);
      const weight = base * mult * perf * mmrMult * comp;
      const skipBonus = difficulty === 'NORMAL' ? 0 : 100;
      const actual = rankDelta(input);
      assert.deepEqual(actual, { delta: Math.round(50 * weight / (weight + 60)) + skipBonus, kind: 'win', skipBonus });
      const loss = pointsBefore >= 2100 ? -Math.round({ NORMAL: 55, HARD: 40, ABYSS: 30 }[difficulty] * 1.1) : 0;
      assert.deepEqual(rankDelta({ ...input, win: false }), { delta: loss, kind: 'lossSurvived', skipBonus: 0 });
      assert.deepEqual(rankDelta({ ...input, alive: false }), { delta: loss, kind: 'lossSurvived', skipBonus: 0 });
      assert.deepEqual(rankDelta({ ...input, roundsPassed: 8 }), { delta: loss, kind: 'earlyDeath', skipBonus: 0 });
      cases += 4;
      if (difficulty === 'HARD' && pointsBefore === 1500 && mmr === 1000) examples.push({ humanCount, comp, delta: actual.delta, skipBonus });
    }
  }
  observe(t, { check: 'rankFormula', cases, examples });
});

test('真实排位结算：观众/机器人不计数，死亡真人计数，离开及全离开回退保留，store file:null', (t) => {
  const observed = [];
  for (const humans of [1, 2, 3, 4]) for (const leftCount of [0, humans]) {
    const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans, bots: 4 - humans, spectators });
    const store = new RankedStore({ file: null });
    try {
      const m = h.m;
      assert.equal(m.rankedStore, null);
      m.ranked = true; m.rankedStore = store; m.outcome = { victory: true };
      const rows = [];
      for (const [i, ps] of m.order.filter((p) => !p.isBot).entries()) {
        ps.aid = `isolated_emi34_${i}`;
        ps.left = i < leftCount;
        if (i > 0) ps.alive = false;
        const profile = store.ensure(ps.aid, ps.name);
        Object.assign(profile, { points: 1500, placementDone: true, placementPlayed: 3 });
        rows.push({ playerId: ps.playerId, roundsPassed: 14, stats: { activatedLayers: 100, assists: 0 } });
      }
      const counts = [];
      const settle = store.settleMatch.bind(store);
      store.settleMatch = (who, ctx, perf) => { counts.push(ctx.humanCount); return settle(who, ctx, perf); };
      const result = { players: rows };
      m._settleRanked(result);
      assert.deepEqual(counts, Array(humans).fill(humans));
      assert.equal(store.file, null);
      assert.equal(store.size, humans);
      assert.ok(result.players.every((r) => r.rank));
      observed.push({ humans, bots: 4 - humans, spectators: 2, leftCount, counts });
    } finally { h.m.dispose(); }
  }
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 3, spectators });
  const store = new RankedStore({ file: null });
  try {
    const m = h.m; m.ranked = true; m.rankedStore = store; m.outcome = { victory: true };
    h.ps('p_2').left = true; h.ps('p_1').alive = false;
    h.ps('p_0').aid = 'isolated_partial';
    let count;
    const settle = store.settleMatch.bind(store);
    store.settleMatch = (who, ctx, perf) => { count = ctx.humanCount; return settle(who, ctx, perf); };
    m._settleRanked({ players: [{ playerId: 'p_0', roundsPassed: 14, stats: {} }] });
    assert.equal(count, 2);
    observed.push({ humans: 3, leftCount: 1, deadButPresent: 1, count });
  } finally { h.m.dispose(); }
  observe(t, { check: 'rankedSettlementCounting', storeFile: null, observed });
});

test('隔离边界：全过程无持久化读写尝试', (t) => {
  const store = new RankedStore({ file: null });
  const p = store.ensure('emi34_retest_memory', 'isolated');
  Object.assign(p, { points: 1500, placementDone: true, placementPlayed: 3 });
  const settled = store.settleMatch({ aid: p.aid, name: p.name },
    { difficulty: 'HARD', humanCount: 1, teamWin: true, hiddenCleared: false },
    { alive: true, roundsPassed: 14, layers: 100, assists: 0 });
  assert.ok(settled.delta > 0);
  store.save();
  assert.equal(store.file, null);
  assert.equal(store.size, 1);
  observe(t, { check: 'persistenceIsolation', blockedPersistence, blockedOperations,
    allowedResearchReads: [...researchReads], instantiatedStores: 'RankedStore only; file:null',
    guardedBeforeGameImports: true, nodePermissionWritesAllowed: process.permission?.has('fs.write') ?? null,
    memorySettlementDelta: settled.delta, playerStoreImported: false });
  assert.equal(blockedPersistence, 0, JSON.stringify(blockedOperations));
  if (process.permission) assert.equal(process.permission.has('fs.write'), false);
});
