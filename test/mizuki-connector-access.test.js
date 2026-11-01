import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the actual component with isolated hooks and an indefinitely pending
// resource loader; network failure, rather than rendered text, is the trigger.
function harness() {
  const effects = [], timers = new Map(), refs = []; let timerId = 0, loads = 0;
  const context = {
    useEffect(effect) { effects.push(effect); },
    useRef(value) { const ref = { current: value }; refs.push(ref); return ref; },
    useState(value) { return [value, () => {}]; },
    h(type, props, ...children) {
      const node = { dataset: {}, setAttribute() {}, isConnected: true };
      if (props?.ref) props.ref.current = node;
      return { type, props, children };
    },
    loadMizukiUiMotion() { loads++; return new Promise(() => {}); },
    playMizukiUiClip() { throw new Error('a pending loader cannot start the clip'); },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const source = readFileSync(new URL('../public/js/mizukiConnector.js', import.meta.url), 'utf8')
    .split(String.fromCharCode(10)).filter(line => !line.startsWith('import ')).join(String.fromCharCode(10)).replace(/export /g, '');
  const api = vm.runInNewContext('(function(){' + source
    + ';return {NativeMizukiConnector,mizukiConnectorGeometry,MIZUKI_CONNECTOR_UNLOCK_TIMEOUT_MS};})()', context);
  return { api, effects, timers, refs, get loads() { return loads; } };
}
const permitted = () => ({ from: 'a', to: 'b', locked: false,
  fromNode: { current: true, completed: true, x: 0, y: 0, type: 'REST' },
  toNode: { available: true, x: 400, y: 0, type: 'BATTLE_NORMAL' } });

test('a never-settling connector resource cannot keep a permitted successor disabled forever', () => {
  const fixture = harness(), completed = [];
  fixture.api.NativeMizukiConnector({ edge: permitted(), index: 0, routeScope: 'floor-1', onComplete: id => completed.push(id) });
  const cleanup = fixture.effects.map(effect => effect());
  assert.equal(fixture.loads, 1); assert.equal(completed.length, 0);
  assert.equal(fixture.timers.size, 1);
  const timer = [...fixture.timers.values()][0];
  assert.equal(timer.ms, fixture.api.MIZUKI_CONNECTOR_UNLOCK_TIMEOUT_MS);
  timer.fn(); timer.fn();
  assert.deepEqual(completed, ['a:b']);
  cleanup.forEach(stop => stop?.()); assert.equal(fixture.timers.size, 0);
});

for (const reason of ['locked', 'unavailable', 'incomplete']) test(reason + ' edge never receives a presentation permission fallback', () => {
  const fixture = harness(), edge = permitted();
  if (reason === 'locked') edge.locked = true;
  if (reason === 'unavailable') edge.toNode.available = false;
  if (reason === 'incomplete') edge.fromNode.completed = false;
  const completed = [];
  fixture.api.NativeMizukiConnector({ edge, index: 0, onComplete: id => completed.push(id) });
  const cleanup = fixture.effects.map(effect => effect());
  assert.equal(fixture.timers.size, 0); assert.equal(completed.length, 0);
  cleanup.forEach(stop => stop?.());
});

test('native symbolic and numeric boss nodes use the original wider connector offsets', () => {
  const { api } = harness();
  const data = { curve: { _segment: 20, _width: 2, _startPosOffset: [0, 0], _endPosOffset: [0, 0], _degreeX: 70, _degreeY: 0 },
    settings: { panelConnectorX: 93.3, panelConnectorXBoss: 138.3 }, types: { values: { BATTLE_BOSS: 4 } } };
  for (const type of ['BATTLE_BOSS', 4]) {
    const edge = permitted(); edge.toNode.type = type;
    assert.equal(api.mizukiConnectorGeometry(edge, data).end.x, 261.7);
    edge.fromNode.type = type;
    assert.equal(api.mizukiConnectorGeometry(edge, data).start.x, 138.3);
  }
});
