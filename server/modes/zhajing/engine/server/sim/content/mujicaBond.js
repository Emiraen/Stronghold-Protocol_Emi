// 炸惊专属颂乐人偶盟约与卫戍特质；原版技能/Fever在 mujica.js 与各干员 kit。
import * as S from './support/index.js';
import { ensureMujica, addFever } from './mujica.js';
import { MORTIS_BEAST_CARD } from '../../../shared/mujicaJibian.js';

export const MUJICA_BOND = 'mujicaShip';
const TRAIT = (code) => `garrison_mujica_${code}`;
const has = (u, code) => (u?.def?.raw?.garrisonIds ?? u?.def?.garrisonIds ?? []).includes(TRAIT(code));
const isZj = (b) => /zhajing/i.test(String(b?.modeId || ''));
const rank = (b, pid, count) => {
  const s = S.bondState(b, pid, MUJICA_BOND);
  return !!s?.active && (Number(s.count) >= count || Number(s.tier) >= count - 1);
};
const traitLayers = (b, u, id) => S.bondLayers(b, u.ownerId, id);
const ownGain = (b, u, n) => S.gainLayers(b, { playerId: u.ownerId, bonds: S.unitBonds(u), n, source: u, reason: 'garrison' });

export function install(battle) {
  if (!isZj(battle)) return;
  const ops = battle.allyUnits.filter(S.isOp);
  if (!ops.some((u) => S.unitBonds(u).includes(MUJICA_BOND))) return;
  ensureMujica(battle);
  const refresh = () => {
    for (const u of ops) {
      const active = S.bondActive(battle, u.ownerId, MUJICA_BOND);
      const L = S.bondLayers(battle, u.ownerId, MUJICA_BOND);
      if (active && S.isMember(battle, u, MUJICA_BOND)) {
        S.passiveBuff(battle, u, 'bond:mujica', S.directMods(
          { atk: rank(battle, u.ownerId, 4) ? 0.23 + 0.009 * L : 0 },
          { aspd: 25 + 0.1 * L },
        ));
      }
      if (has(u, 'oblvns') || has(u, 'oblvns_b')) S.passiveBuff(battle, u, 'gar:mujica:oblvns',
        S.directMods({ atk: Math.floor(traitLayers(battle, u, MUJICA_BOND) / 3) * (has(u, 'oblvns_b') ? 0.03 : 0.02) }));
    }
  };
  refresh();
  battle.on('layerGain', () => battle.after(0, refresh), { priority: -100 });
  battle.on('battleStart', () => {
    // One start grant per fielded copy; redeploys do not repeat the battle-start trait.
    for (const u of ops) if (has(u, 'oblvns') || has(u, 'oblvns_b')) addFever(battle, u, traitLayers(battle, u, MUJICA_BOND) / 2);
  });
  // 若麦的层数加成已移到休整期结束时结算（卫戍特质 onPrepEnd），部署时不再加层。
  // ★ 2026-10-26（owner）：叠层从「每次开启技能 +1」改为「每开启两次技能 +1」。
  //   计数按玩家（同队所有【颂乐人偶】干员的施法都算），只影响 3 名档的叠层；5 名档的 Fever 仍是每次施法 +10。
  const castCounts = new Map();

  battle.on('skillStart', ({ unit }) => {
    if (!S.isOp(unit) || !S.isMember(battle, unit, MUJICA_BOND)) return;
    const casts = (castCounts.get(unit.ownerId) || 0) + 1;
    castCounts.set(unit.ownerId, casts);
    if (rank(battle, unit.ownerId, 3) && casts % 2 === 0) S.gainLayers(battle, {
      playerId: unit.ownerId, bonds: MUJICA_BOND, n: 1, source: unit, reason: 'bond',
    });
    if (rank(battle, unit.ownerId, 5)) addFever(battle, unit, 10);
  });
  battle.on('healed', ({ source, target, amount, opts }) => {
    // ★ 2026-10-24（owner）：三角初华的卫戍特质只作用于【颂乐人偶】【助力】，且必须已激活；
    //   普通 +2 / 精锐 +4（原来是 +1/+2 给「自身所有盟约」）。
    if (!(amount > 0) || opts?.regen) return;
    if (!(has(source, 'dolris') || has(source, 'dolris_b')) || !S.isOp(target)) return;
    S.gainLayers(battle, {
      playerId: source.ownerId,
      bonds: [MUJICA_BOND, 'deputShip'],
      n: has(source, 'dolris_b') ? 4 : 2,
      source,
      reason: 'garrison',
    });
  });
  battle.on('damaged', ({ source, target, dmg }) => {
    if (!(has(source, 'mortis') || has(source, 'mortis_b')) || !dmg?.isAttack || target?.side !== 'enemy' || !target.alive) return;
    // ★ 2026-10-23（owner）：持卡时改为统计「玩家所有已激活盟约」的层数总和（同一盟约只计一次）。
    const L = S.hasJibian(battle, source.ownerId, MORTIS_BEAST_CARD)
      ? S.activeBondIds(battle, source.ownerId).reduce((sum, id) => sum + S.bondLayers(battle, source.ownerId, id), 0)
      : traitLayers(battle, source, MUJICA_BOND);   // ★ 2026-10-23（owner）：特质只认【颂乐人偶】的层数
    const beast = S.hasJibian(battle, source.ownerId, MORTIS_BEAST_CARD);
    const amount = source.s.atk * Math.floor(L / 3) * (beast ? 0.02 : (has(source, 'mortis_b') ? 0.03 : 0.02));
    const bursting = !!target.findBuff('apoptosisBurst');
    battle.dealDamage(source, target, { amount, type: 'element', element: 'apoptosis', tags: ['gar:mujica:mortis'] });
    if (bursting && target.alive) battle.dealDamage(source, target, {
      amount, type: 'elemental', element: 'apoptosis', canDodge: false, tags: ['gar:mujica:mortis'],
    });
  });
}

export function registerMeta(registry) {
  registry.bond(MUJICA_BOND, {
    // ★ 2026-10-23（owner）：「<首次获得祐天寺若麦时>获得一个谜の假面」。
    //   必须写在**这个** bond 注册里：addon/meta.js 也注册过 bond:mujicaShip，而 registry.register
    //   是「后注册覆盖先注册」，那边的 onGain 会被这里的 onRefresh 覆盖（已实测），赠礼放这里两个钩子共存。
    onGain(ctx, ev) {
      const piece = ev && ev.piece;
      if (!piece || ev.kind !== 'chess' || !piece.id) return;
      if (!['chess_zj_amoris_a', 'chess_zj_amoris_b'].includes(piece.id)) return;
      const key = 'bondaddon:mujica:gift:amoris';
      if (ctx.counter(key)) return;
      ctx.setCounter(key, 1);
      if (ctx.grantItem('chess_item_mujica_mask_a')) {
        ctx.toast('【颂乐人偶】首次获得祐天寺若麦：获得「谜の假面」', 'reward');
      }
    },
    onRefresh(ctx, ev) {
      if (!ctx.gd.zhajing || ev?.trigger || !ctx.bondActive(MUJICA_BOND)) return;
      const EVERY = 10;
      const key = 'bond:mujica:refreshes';
      // ★ 修复「满仓时每刷一次都尝试发奖、腾出位置后又连续追发」：
      //   计数改成 0..EVERY-1 的**周期进度**，并且在发奖副作用（rollChess / grantChess）**之前**结算本周期。
      //   旧代码只在 grantChess 成功时 n - EVERY —— 满仓 / 卡池为空时计数停在 >=EVERY，之后每次刷新都再试一次。
      //   取余同时把旧逻辑积压的整周期计数规范掉（不补发）：旧 10/20/100 → 0，下一次合法刷新变 1。
      const raw = Number(ctx.counter(key));
      const prev = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
      const next = (prev % EVERY) + 1;
      ctx.setCounter(key, next % EVERY);
      if (next < EVERY) return;
      const id = ctx.rollChess({ bond: MUJICA_BOND, maxTier: ctx.shopLevel() });
      if (id) ctx.grantChess(id, { source: 'bond:mujica' });   // 满仓 / 返还由 acquireChess 处理，本次机会不积压
    },
  });
  registry.garrison('MUJICA_AMORIS', {
    // ★ 2026-10-23（owner）：卫戍特质改为「休整期结束时」一次性结算：资金 + 自身已激活盟约层数。
    //   普通 2 资金 / +5 层；精锐 4 资金 / +10 层（翻倍）。
    //   条件不变：在棋盘上，或已激活【颂乐人偶】（此时在整备区也有效）。
    onPrepEnd(ctx) {
      if (!ctx.gd.zhajing) return;
      const gold = ctx.gd?.isGolden?.(ctx.source.piece?.id) === true;
      if (ctx.source.where !== 'board' && !ctx.bondActive(MUJICA_BOND)) return;
      ctx.addPendingFunds(gold ? 4 : 2);
      const uid = ctx.source.piece?.uid;
      const bonds = uid && typeof ctx.pieceBonds === 'function' ? ctx.pieceBonds(uid) : [];
      const n = gold ? 10 : 5;
      for (const b of bonds) if (b) ctx.addLayers(b, n, { requireActive: true, reason: 'garrison' });
    },
  });
  registry.garrison('MUJICA_TMORIS', {
    onRefresh(ctx, ev) {
      if (!ctx.gd.zhajing || ev?.trigger) return;
      const uid = ctx.source.piece?.uid;
      if (!uid) return;
      const key = 'gar:mujica:tmoris:refresh';
      const gold = ctx.gd?.isGolden?.(ctx.source.piece?.id) === true;   // 精锐：休整期内无次数限制
      if (!gold && ctx.pieceCounter(uid, key) >= 5) return;
      ctx.incPieceCounter(uid, key);
      for (const id of [MUJICA_BOND, 'swiftShip', 'siracusaShip']) ctx.addLayers(id, 2, { requireActive: true });
    },
  });
}
