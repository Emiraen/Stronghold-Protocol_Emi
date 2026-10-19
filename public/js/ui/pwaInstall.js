import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button } from './components.js';
import { pwaInstall } from '../pwa.js';
import { t } from '../../../shared/i18n.js';

export function PwaInstallButton({ class: cls = '', size = 'sm', square = false }) {
  const [available, setAvailable] = useState(() => pwaInstall.available());
  useEffect(() => pwaInstall.subscribe(setAvailable), []);
  if (!available) return null;
  return html`<${Button} class=${cls} size=${size} variant="secondary" square=${square} icon="download"
    title=${t('添加到桌面')} aria-label=${t('添加到桌面')} onClick=${() => pwaInstall.request()}>${square ? null : t('添加到桌面')}<//>`;
}
