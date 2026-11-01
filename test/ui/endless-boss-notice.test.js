import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endlessBossNotice, tickerLineLive, pruneTickerLines, enqueueTickerLines } from '../../public/js/ui/ticker.js';
import { ENDLESS_MODE_ID, ENDLESS_VARIANT, PHASE } from '../../shared/constants.js';
import { Match } from '../../server/match/Match.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { getData } from '../../server/data.js';

test('endless boss notices match the server schedule, including repeated hidden bosses', t => {
  const scheduler = new VirtualScheduler({ instantCombat: true });
  const m = new Match({ mode: 'coop', variant: ENDLESS_VARIANT, difficulty: 'NORMAL',
    seats: [{ seat: 0, playerId: 'p0', name: 'P0', isBot: false, connected: true }],
    data: getData(), seed: 73, scheduler, clientCombat: false, botRehearsal: 0, send() {}, broadcast() {}, onEnd() {} });
  t.after(() => { m.dispose(); scheduler.dispose(); });
  for (let round = 1; round <= m.gd.bossRound + 75; round++) {
    m.round = round;
    for (const phase of [PHASE.ROUND_START, PHASE.SP_DRAFT, PHASE.PREP]) {
      m.phase = phase;
      const notice = endlessBossNotice(m.publicView());
      assert.equal(!!notice, m.isBossRound(round + 1), `R${round} ${phase}`);
      if (notice) {
        assert.ok(notice.text.includes(`第 ${round + 1} 回合`));
        assert.equal(notice.round, round);
      }
    }
  }
});

test('boss notices ignore other modes, invalid data, and combat phases', () => {
  const pub = { variant: ENDLESS_VARIANT, modeId: ENDLESS_MODE_ID, round: 18, bossRound: 14, phase: PHASE.PREP };
  assert.ok(endlessBossNotice(pub));
  for (const phase of [PHASE.COMBAT, PHASE.FINAL_ASSAULT, PHASE.SETTLE, PHASE.RESULT]) assert.equal(endlessBossNotice({ ...pub, phase }), null);
  assert.equal(endlessBossNotice({ ...pub, variant: null, modeId: 'mode_multi_normal' }), null);
  for (const round of [null, '18', 0, -1, 18.5, Infinity]) assert.equal(endlessBossNotice({ ...pub, round }), null);
  for (const bossRound of [null, '14', 0, -1, NaN]) assert.equal(endlessBossNotice({ ...pub, bossRound }), null);
});

test('the boss warning has flow priority and expires when its announced round ends', () => {
  const notice = endlessBossNotice({ variant: ENDLESS_VARIANT, round: 18, bossRound: 14, phase: PHASE.PREP });
  assert.equal(tickerLineLive(notice, 18), true);
  assert.equal(tickerLineLive(notice, 19), false);
  assert.deepEqual(pruneTickerLines([notice], notice, 19), { queue: [], dropCur: true });
  const normal = { id: 1, type: 'SHOP_LEVEL', priority: 11, round: 18, text: 'shop' };
  assert.equal(enqueueTickerLines([normal], null, [notice]).queue[0], notice);
});
