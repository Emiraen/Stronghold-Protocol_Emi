// Separate management listener; all state and operations stay with the running game authority.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startAdmin } from './admin.js';
import { profileConfig, remoteCall } from './profileService.js';

export async function startStandaloneAdmin({ env = process.env, config, call, log = console } = {}) {
  const rpcConfig = config || profileConfig({
    ...env,
    SP_PROFILE_SERVICE_URL: env.ADMIN_GAME_RPC_URL || 'http://127.0.0.1:3000',
  });
  if (!call && !rpcConfig.secret?.trim()) throw new Error('SP_PROFILE_SERVICE_SECRET is required');
  if (!env.ADMIN_TLS_KEY || !env.ADMIN_TLS_CERT) throw new Error('ADMIN_TLS_KEY and ADMIN_TLS_CERT are required');
  const port = Number(env.ADMIN_SIDECAR_PORT || 56130);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('invalid ADMIN_SIDECAR_PORT');
  const invoke = call || ((op, args) => remoteCall(rpcConfig, op, args));
  return startAdmin({
    lobby: {}, registry: {},
    stateSource: { state: () => invoke('admin.state', []) },
    controls: {
      getAnnouncement: () => invoke('admin.announcement.get', []),
      publishAnnouncement: (value) => invoke('admin.announcement.publish', [value]),
      kick: (value) => invoke('admin.kick', [value]),
      kickStatus: (value) => invoke('admin.kick.status', [value]),
    },
    port, host: env.ADMIN_HOST || '0.0.0.0', log,
    tls: { key: readFileSync(env.ADMIN_TLS_KEY), cert: readFileSync(env.ADMIN_TLS_CERT) },
  });
}

async function main() {
  const admin = await startStandaloneAdmin();
  console.info(`[admin] standalone listener ready on port ${admin.port}`);
  let closing = null;
  const stop = () => {
    if (closing) return;
    closing = admin.close().catch((error) => {
      console.error('[admin] shutdown failed', error.message);
      process.exitCode = 1;
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMain()) main().catch((error) => {
  console.error('[admin] startup failed', error.message);
  process.exitCode = 1;
});
