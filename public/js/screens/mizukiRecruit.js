// Light-grey recruit page (干员招募) and the shared operator card / detail sidebar.
// Presentation only: offers, costs and availability come from the server view.
import { h, Fragment, Modal, Button } from '../ui/components.js';
import { useState } from '../../vendor/hooks.module.js';
import { data } from '../data.js';
import { MizukiStage, MizukiBottomBar, hudBg } from './mizukiHud.js';

const e = (type, props, ...children) => h(type, props, ...children.flat(3));
const cx = (...parts) => parts.filter(Boolean).join(' ');
const arr = value => Array.isArray(value) ? value : [];
const same = (a, b) => a != null && b != null && String(a) === String(b);
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const PROF_ICON = { PIONEER: 'pioneer', WARRIOR: 'warrior', TANK: 'tank', SNIPER: 'sniper', CASTER: 'caster', MEDIC: 'medic', SUPPORT: 'support', SPECIAL: 'special' };
export const PROF_NAMES = { PIONEER: '先锋', WARRIOR: '近卫', TANK: '重装', SNIPER: '狙击', CASTER: '术师', MEDIC: '医疗', SUPPORT: '辅助', SPECIAL: '特种' };

export function operatorProfession(unit) {
  const direct = unit?.profession || unit?.uiRecord?.profession || unit?.detail?.profession;
  if (direct) return direct;
  for (const id of [unit?.chessId, unit?.canonicalChessId, unit?.operatorId, unit?.baseId]) {
    if (!id) continue;
    const profession = data.lookup('chess', id)?.profession;
    if (profession) return profession;
  }
  return null;
}

/** The existing profession button opens the shared modal; filtering never changes selections. */
export function ProfessionFilter({ value = [], onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const selected = arr(value).filter(profession => PROF_NAMES[profession]);
  const toggle = profession => onChange(selected.includes(profession) ? selected.filter(value => value !== profession) : [...selected, profession]);
  return e(Fragment, null,
    e('button', { type: 'button', class: 'mzr-filter', 'aria-label': '职业筛选', 'aria-haspopup': 'dialog', 'aria-expanded': open, disabled, onClick: () => setOpen(true) }, '职业 ≡'),
    e(Modal, { open, onClose: () => setOpen(false), title: '职业筛选', actions: e(Button, { onClick: () => setOpen(false) }, '确认') },
      e('div', { role: 'group', 'aria-label': '职业筛选', style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
        e(Button, { active: !selected.length, disabled, 'data-mz-profession-filter': 'ALL', onClick: () => onChange([]) }, '全部职业'),
        Object.entries(PROF_NAMES).map(([profession, label]) => e(Button, { key: profession, active: selected.includes(profession), disabled, 'data-mz-profession-filter': profession, onClick: () => toggle(profession) }, label)))));
}

/** Light page header: back, exit, formation shortcut. `onBack` is optional. */
export function LightTopLeft({ onBack, onExit }) {
  return e('div', { class: 'mzr-topleft' },
    e('button', { type: 'button', class: 'mzr-back', 'aria-label': '返回', onClick: onBack, style: hudBg('common-btn_back') }),
    e('button', { type: 'button', class: 'mzh-exit mzr-exit', 'aria-label': '离开本次探索', 'data-mz-exit': true, onClick: onExit }),
    e('span', { class: 'mzr-info', style: hudBg('cmn1-img_btn_info'), 'aria-hidden': true }));
}

export function OperatorSidebar({ unit, skills = [], children }) {
  return e('aside', { class: 'mzr-side' },
    e('div', { class: 'mzr-side__head' }, e('span', { class: 'mzr-side__rook', style: hudBg('topic-hp') }),
      e('p', {}, unit ? unit.name : '轻触右侧干员以查看详情')),
    e('div', { class: 'mzr-side__tabs' }, e('span', {}, '技能'), e('span', {}, '分支+')),
    e('div', { class: 'mzr-side__skills' }, Array.from({ length: 3 }, (_, index) => {
      const skill = skills[index];
      return e('div', { key: index, class: 'mzr-skill' }, e('i', { class: 'mzr-skill__box', style: hudBg('cmn1-empty_skill_large') }, skill?.icon ? e('img', { src: skill.icon, alt: '' }) : null), e('span', {}, skill ? skill.name : 'NO INFO/'));
    })), children);
}

/** One operator card in the original slanted layout. `badge` is the corner label ("招募" or "临时招募"). */
export function OperatorCard({ unit, portrait, rarity, cost, label = '招募', selected, disabled, onClick, style, level, order, tag, elite, skillIcon, moduleIcon, children, ...rest }) {
  const stars = Math.max(1, Math.min(6, num(rarity, 4)));
  return e('button', { ...rest, type: 'button', class: cx('mzr-card', 'mzr-card--r' + stars, selected && 'is-selected', disabled && 'is-disabled', tag && 'is-temp'), style, disabled, 'aria-pressed': !!selected, 'data-mz-offer': unit?.offerId, onClick },
    tag ? e('span', { class: 'mzr-card__tag' }, tag) : null,
    e('span', { class: 'mzr-card__portrait' }, portrait ? e('img', { src: portrait, alt: '', draggable: false }) : null),
    e('span', { class: 'mzr-card__stars' }, e('img', { src: '/assets/mizuki/native-ui-roster/rarity_sprite_' + (stars - 1) + '.png', alt: '★'.repeat(stars) })),
    e('span', { class: 'mzr-card__prof' }, unit?.profession ? e('img', { src: '/assets/mizuki/native-ui-hud/prof-' + (PROF_ICON[unit.profession] || 'pioneer') + '.png', alt: '' }) : null),
    elite > 0 ? e('img', { class: 'mzr-card__elite', src: '/assets/mizuki/native-ui-roster/elite_' + elite + '.png', alt: '精英' + elite, 'data-mz-elite': elite }) : null,
    skillIcon || moduleIcon ? e('span', { class: 'mzr-card__loadout' },
      skillIcon ? e('i', {}, e('img', { src: skillIcon, alt: '', draggable: false })) : null,
      moduleIcon ? e('i', {}, e('img', { src: moduleIcon, alt: '', draggable: false })) : null) : null,
    cost != null ? e('span', { class: 'mzr-card__cost' }, e('em', {}, label), e('b', {}, e('i', { style: hudBg('cmn1-hope_icon') }), cost)) : null,
    e('span', { class: cx('mzr-card__name', String(unit?.name || '').length > 6 && 'is-long') }, unit?.name),
    order ? e('span', { class: 'mzr-card__order' }, order) : null,
    children);
}

export function RecruitPage({ sidebar, offers, ticket, emptyReason, portraitFor, selectedId, onSelect, onConfirm, onGiveUp, onExit, onBack, bottom, busy, hope, sidebarSkills, canGiveUp = true, confirmDisabled, canRefresh, refreshLeft = 0, onRefresh, remaining }) {
  const [professions, setProfessions] = useState([]);
  const visibleOffers = arr(offers).filter(offer => !professions.length || professions.includes(operatorProfession(offer)));
  const selected = arr(offers).find(offer => same(offer.offerId, selectedId));
  const preferredProfessions = [...new Set(arr(ticket?.preferredProfessions ?? ticket?.allowedProfessions ?? [ticket?.profession]))].filter(profession => PROF_NAMES[profession]);
  const ticketDescription = ticket?.kind === 'sixstar_free' ? '免费招募 · 两名六星候选 · 三次免费刷新'
    : ticket?.promotionOnly ? '选择本券适用的已招募干员进行进阶'
    : ticket?.randomCandidateCount ? ticket.name || '随机临时招募'
    : ticket?.kind === 'advanced' ? '全体可招募干员自由选择'
    : preferredProfessions.length ? '职业倾向：' + preferredProfessions.map(profession => PROF_NAMES[profession]).join('／') + ' · 对应职业出现权重×2' : '';
  const [scroll, setScroll] = useState(0);
  void scroll;
  return e(MizukiStage, { class: 'mzr-page', scheme: 'light' },
    e('div', { class: 'mzh-backdrop mzh-backdrop--snow' }),
    e(LightTopLeft, { onBack, onExit }),
    e('div', { class: 'mzr-hope', 'data-mz-hope': true }, e('span', { class: 'mzr-hope__icon', style: hudBg('cmn1-hope_icon') }), e('b', {}, '希望'), e('i', {}, e('s', { style: { width: Math.min(100, num(hope) / 6 * 100) + '%' } })), e('em', {}, num(hope))),
    selected && sidebar ? sidebar(selected) : e(OperatorSidebar, { unit: selected, skills: sidebarSkills?.(selected) }),
    e('div', { class: 'mzr-grid', role: 'list', onScroll: event => setScroll(event.currentTarget.scrollLeft) }, !visibleOffers.length
      ? e('p', { role: 'status', class: 'mzr-empty' }, emptyReason || '暂无可招募干员，请返回选择其他招募券。')
      : visibleOffers.map((offer, index) => e(OperatorCard, {
      key: offer.offerId, unit: offer, portrait: portraitFor(offer), rarity: offer.rarity, cost: num(offer.hopeCost), label: offer.directUpgrade ? '直接进阶' : ({ copy: '招募同名', promote: '三合一进阶', upgrade: '进阶' })[offer.action] || '招募',
      selected: same(selectedId, offer.offerId), disabled: !!busy || offer.available === false,
      elite: Number.isInteger(offer.formStatus?.phase) ? offer.formStatus.phase : undefined,
      style: { left: 80 + Math.floor(index / 4) * 527 + 'px', top: (index % 4) * 185 + 'px' }, onClick: () => onSelect(offer) }))),
    remaining != null ? e('div', { class: 'mzr-remain', 'data-mz-ticket-left': remaining }, '本券剩余招募 ', e('b', {}, remaining), ' 次',
      ticketDescription ? e('small', { style: { display: 'block', fontSize: '18px', lineHeight: '24px' }, 'data-mz-recruit-ticket-description': true, 'data-mz-recruit-preferred-professions': preferredProfessions.join(',') }, ticketDescription) : null) : null,
    e(ProfessionFilter, { value: professions, onChange: setProfessions, disabled: !!busy }),
    e(MizukiBottomBar, { ...bottom, showOperators: true, operatorsSide: 'left', right: e('div', { class: 'mzr-actions' },
      canRefresh ? e('button', { type: 'button', class: 'mzr-giveup mzr-refresh', disabled: !!busy || refreshLeft < 1, onClick: onRefresh, 'data-mz-recruit-refresh': true }, e('i', {}), '刷新', e('b', {}, refreshLeft)) : null,
      canGiveUp ? e('button', { type: 'button', class: 'mzr-giveup', disabled: !!busy, onClick: onGiveUp, 'data-mz-recruit-skip': true }, e('i', {}), '放弃') : null,
      e('button', { type: 'button', class: 'mzr-confirm', disabled: !!busy || confirmDisabled || !selected, onClick: () => onConfirm(selected), 'data-mz-confirm': 'recruit' }, e('i', {}), '确认招募')) }));
}
