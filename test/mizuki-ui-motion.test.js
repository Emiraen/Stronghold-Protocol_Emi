import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileMizukiUiClip, sampleMizukiUiClip, mizukiUiClipTime } from '../public/js/mizukiUiMotion.js';
const root = new URL('../public/assets/mizuki/native-ui-motion/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
function original(name) {
  const entry = manifest.objects[manifest.clipsByName[name][0]];
  return compileMizukiUiClip(JSON.parse(readFileSync(new URL(entry.file, root), 'utf8')), entry);
}
test('original selectable node alpha/active curves retain original one-second default-wrap semantics', () => {
  const clip = original('anim_selectable_node'), mid = {}, end = {};
  sampleMizukiUiClip(clip, .5, (path, property, value) => { mid[path + ':' + property] = value; });
  sampleMizukiUiClip(clip, 3, (path, property, value) => { end[path + ':' + property] = value; });
  assert.equal(clip.duration, 1); assert.equal(clip.loop, false);
  assert.equal(mizukiUiClipTime(clip, 3), 1);
  assert.equal(mid['panel_widgets/image_bkg:m_Color.a'], .5);
  assert.equal(mid['panel_widgets/image_bkg_selectable:m_Color.a'], .5);
  assert.equal(mid['panel_widgets/image_bkg:m_IsActive'], 1);
  assert.equal(end['panel_widgets/image_bkg:m_IsActive'], 0);
  assert.equal(end['panel_widgets/image_bkg_selectable:m_Color.a'], 1);
  assert.equal(clip.events.find(event => event.functionName === 'AnimationEventOnPlayParticle').time, .20000000298023224);
});
test('original current-node and card curves keep opposite state fade and exact event-independent timeline', () => {
  const current = original('anim_current_node'), values = {};
  sampleMizukiUiClip(current, 1, (path, property, value) => { values[path + ':' + property] = value; });
  assert.equal(values['panel_widgets/image_bkg_selectable:m_IsActive'], 0);
  assert.equal(values['panel_widgets/image_bkg:m_Color.a'], 1);
  const card = original('showCard');
  sampleMizukiUiClip(card, .65, (path, property, value) => { values[path + ':' + property] = value; });
  assert.equal(values['container:m_AnchoredPosition.x'], 0);
  assert.equal(values[':m_BlocksRaycasts'], 0);
});
