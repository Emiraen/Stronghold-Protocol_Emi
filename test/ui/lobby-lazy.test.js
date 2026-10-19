import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as moduleHooks from 'node:module';

// Observe actual ESM resolution without downloading report data or mounting a browser page.
let sweepImports = 0;
const hook = moduleHooks.registerHooks?.({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/public/js/screens/lobby.js') && specifier === './sweep.js') {
      sweepImports++;
      return { url: 'data:text/javascript,export function SweepReport() {}', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { createSweepLoader } = await import('../../public/js/screens/lobby.js');
const importsAtBoot = sweepImports;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('the lobby does not import the report until its viewer requests it', { skip: !hook }, async () => {
  try {
    assert.equal(importsAtBoot, 0, 'the initial lobby module graph contains no report');
    const request = createSweepLoader();
    assert.equal(sweepImports, 0, 'creating the loader performs no import');
    const first = await new Promise((resolve, reject) => request(resolve, reject));
    assert.equal(typeof first.SweepReport, 'function');
    assert.equal(sweepImports, 1);
    const again = await new Promise((resolve, reject) => request(resolve, reject));
    assert.equal(again, first);
    assert.equal(sweepImports, 1, 'reopening reuses the successful module');
  } finally { hook.deregister(); }
});

test('closing during a shared import cancels old callbacks while a reopened viewer receives the result', async () => {
  const pending = deferred();
  let loads = 0;
  const request = createSweepLoader(() => { loads++; return pending.promise; });
  const closed = [], opened = [];
  const cancel = request(value => closed.push(value), error => closed.push(error));
  await settle();
  cancel();
  const cancelAgain = request(value => opened.push(value), error => opened.push(error));
  const report = { SweepReport() {} };
  pending.resolve(report);
  await settle();
  assert.equal(loads, 1, 'rapid close/reopen shares the in-flight import');
  assert.deepEqual(closed, [], 'a closed viewer cannot reopen or show a late error');
  assert.deepEqual(opened, [report]);
  cancelAgain();
});

test('a failed import is retryable and closing also suppresses a late rejection', async () => {
  const first = deferred(), second = deferred();
  const recovered = { SweepReport() {} };
  let attempts = 0;
  const request = createSweepLoader(() => (++attempts === 1 ? first.promise : attempts === 2 ? second.promise : recovered));
  const errors = [];
  const cancel = request(assert.fail, error => errors.push(error));
  await settle();
  const failure = new Error('offline');
  first.reject(failure);
  await settle();
  assert.deepEqual(errors, [failure]);
  cancel();
  const cancelledErrors = [];
  const stop = request(assert.fail, error => cancelledErrors.push(error));
  await settle();
  assert.equal(attempts, 2, 'retry starts a fresh import after failure');
  stop();
  second.reject(new Error('still offline'));
  await settle();
  assert.deepEqual(cancelledErrors, []);
  assert.equal(await new Promise((resolve, reject) => request(resolve, reject)), recovered);
  assert.equal(attempts, 3, 'a later retry succeeds using the same loader');
});
