// No eval, no dynamic method names, no administrative or simulation APIs.
const METHODS = new Set(['state', 'context', 'catalog', 'events', 'request', 'chat', 'strategy', 'library', 'unit', 'join', 'switchServer', 'watch', 'avatar', 'skin', 'skins', 'portrait', 'voice', 'loadout', 'operatorSettings']);
export async function invokeAgent(api, method, params = {}) {
  if (!METHODS.has(method)) throw Object.assign(new Error('Unknown AI method'), { code: 'NO_METHOD' });
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw Object.assign(new Error('params must be an object'), { code: 'BAD_INPUT' });
  if (method === 'request') return api.request(params.type, params.fields ?? {}, params.guard ?? {});
  if (method === 'state' || method === 'context' || method === 'catalog') return api[method]();
  return api[method](params);
}
