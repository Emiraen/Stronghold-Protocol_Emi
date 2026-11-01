import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridgeServer } from '../tools/ai-bridge.mjs';

function call(port, { method = 'POST', path = '/v1/call', headers = {}, body = '{}' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', s => { text += s; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) })); });
    req.on('error', reject); req.end(body);
  });
}
test('local bridge enforces token, Origin/Host, schema, fixed methods and normal replies', async t => {
  const calls = [], { server, token } = createBridgeServer({ port: 0, invoke: async (method, params) => { calls.push({ method, params }); if (params.fail) throw Object.assign(new Error('wrong phase'), { code: 'WRONG_PHASE' }); return { phase: 'PREP' }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  t.after(() => { server.close(); server.closeAllConnections(); });
  assert.equal(server.address().address, '127.0.0.1');
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  assert.equal((await call(port)).status, 401);
  assert.equal((await call(port, { headers: { ...headers, Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await call(port, { headers: { ...headers, Host: 'evil.invalid:' + port } })).status, 403);
  assert.equal((await call(port, { headers, body: '{' })).data.error.code, 'BAD_JSON');
  assert.equal((await call(port, { headers, body: JSON.stringify({ method: 'eval', params: {} }) })).data.error.code, 'NO_METHOD');
  const response = await call(port, { headers, body: JSON.stringify({ id: 7, method: 'state', params: {} }) });
  assert.deepEqual(response.data, { ok: true, id: 7, result: { phase: 'PREP' } });
  const error = await call(port, { headers, body: JSON.stringify({ method: 'request', params: { fail: true } }) }); assert.equal(error.data.error.code, 'WRONG_PHASE');
  assert.equal(calls.length, 2);
});
