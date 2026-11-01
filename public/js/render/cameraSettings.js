// Screen-space camera preferences shared by the 3D board, Pixi and picking.
export const DEFAULT_CAMERA_SETTINGS = Object.freeze({ cameraOffsetX: 0, cameraOffsetY: 0, cameraZoom: 100 });
export const CAMERA_SETTINGS_LIMITS = Object.freeze({ offsetMin: -30, offsetMax: 30, zoomMin: 50, zoomMax: 200 });
const bounded = (value, fallback, min, max) => Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
export function sanitizeCameraSettings(raw = {}) {
  return {
    cameraOffsetX: bounded(raw?.cameraOffsetX, 0, -30, 30),
    cameraOffsetY: bounded(raw?.cameraOffsetY, 0, -30, 30),
    cameraZoom: bounded(raw?.cameraZoom, 100, 50, 200),
  };
}
/** Apply once to a freshly calculated preset; positive offsets move the image right/down. */
export function applyCameraSettings(camera, viewport, settings) {
  const { cameraOffsetX, cameraOffsetY, cameraZoom } = sanitizeCameraSettings(settings);
  if (!cameraOffsetX && !cameraOffsetY && cameraZoom === 100) return camera;
  const width = Math.max(1, viewport.width), height = Math.max(1, viewport.height), zoom = cameraZoom / 100;
  camera.cx = width / 2 + (camera.cx - width / 2) * zoom + width * cameraOffsetX / 100;
  camera.cy = height / 2 + (camera.cy - height / 2) * zoom + height * cameraOffsetY / 100;
  camera.scale *= zoom;
  return camera.update();
}
