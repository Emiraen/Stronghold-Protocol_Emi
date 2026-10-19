// Optional UI-plugin surfaces. A server without plugins keeps the existing screens unchanged.
import { useEffect } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { useStore } from '../store.js';
import { installedCount } from '../content.js';
import { uiPlugins } from './uiPlugins.js';
import { t } from '../../../shared/i18n.js';

let hostLoad = null;
function loadHost() {
  if (!hostLoad) hostLoad = import('./pluginFrame.js').catch((error) => {
    hostLoad = null;
    console.warn('[plugins] the interface host did not load', error);
  });
}

function usePluginHost() {
  const installed = useStore(installedCount);
  const ids = useStore((s) => s.ids, Object.is, uiPlugins);
  const active = installed > 0 && ids.length > 0;
  useEffect(() => { if (active) loadHost(); }, [active, ids]);
  return active;
}

export function UiPluginHost() {
  usePluginHost();
  return null;
}

export function UiPluginSlot({ slot, class: cls = '' }) {
  const active = usePluginHost();
  if (!active) return null;
  // Plugin frames are moved between slots by the host; Preact must not replace their children.
  return html`<div class=${'ui-slot ' + cls} data-ui-slot=${slot} aria-label=${t('界面插件')} dangerouslySetInnerHTML=${{ __html: '' }}></div>`;
}
