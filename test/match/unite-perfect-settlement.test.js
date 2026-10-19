import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { makeMatch, checkInvariants } from './harness.js';

for (const clientCombat of [false, true]) {
  for (const remaining of [0, 2]) {
    test(`normal unite settlement (${clientCombat ? 'client' : 'server'}): ${remaining} survivors determine LP, not original leaks`, () => {
      const h = makeMatch({ mode: 'coop', humans: 3, seed: 3419, fake: true, clientCombat,
        script: b => b.kind === 'normal' ? { leaks: { p_0: 6, p_2: 4 } } : b.kind === 'unite' ? { survivors: { p_0: remaining, p_2: 0 } } : {},
      }).start();
      const m = h.m;
      try {
        h.toPrep(1);
        const before = new Map(m.order.map(p => [p.playerId, p.lp]));
        h.drive(() => m.phase === PHASE.UNITE);
        assert.equal(m.isEntertainmentMulti, false);
        assert.deepEqual(m.unitePlan.leakers.map(p => p.playerId).sort(), ['p_0', 'p_2']);
        h.drive(() => m.phase === PHASE.SETTLE);
        for (const p of m.order) {
          const loss = p.playerId === 'p_0' ? remaining : 0;
          assert.equal(p.lp, before.get(p.playerId) - loss);
          assert.equal(p.stats.lpLost, loss);
          assert.equal(m.publicView().players.find(row => row.playerId === p.playerId).lp, p.lp);
        }
        checkInvariants(m);
      } finally { m.dispose(); }
    });
  }
}
