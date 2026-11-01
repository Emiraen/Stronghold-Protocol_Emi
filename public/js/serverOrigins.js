// This endpoint serves preload resources only; it never hosts a game session or profile.
export const SOUTH_PRELOAD_ORIGIN = 'http://120.24.21.224:3000';
export const SOUTH_PRELOAD_HTTPS_ORIGIN = 'https://south.emiraen.top';

export function isResourceOnlyOrigin(origin) {
  return origin === SOUTH_PRELOAD_ORIGIN || origin === SOUTH_PRELOAD_HTTPS_ORIGIN;
}
