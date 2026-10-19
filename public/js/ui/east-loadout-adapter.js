// Management-only presentation adapters. The runtime detail and stat calculations remain shared with East.
import { html } from './components.js';
import { Img, RichText } from './gameComponents.js';
import { uiUrl } from './assetUrls.js';
import { garrisonTypeIconKey } from './detailPanel.js';
import { t } from '../../../shared/i18n.js';

export function GarrisonBlock({ garrison, m }) {
  if (!garrison) return null;
  return html`<section class="dgarrison" aria-label=${t('特质')} data-garrison=${garrison.garrisonId || ''}>
    <div class="dgarrison__head">
      <span class="dgarrison__k">${t('特质')}</span>
      <span class="dgarrison__type">
        <${Img} src=${uiUrl(m, `garrisonTypeIcon/${garrisonTypeIconKey(garrison)}`)} class="dgarrison__icon" />
        ${garrison.eventTypeDesc || ''}
      </span>
    </div>
    <${RichText} as="p" text=${garrison.descRaw || garrison.desc || ''} class="dgarrison__text" />
  </section>`;
}
