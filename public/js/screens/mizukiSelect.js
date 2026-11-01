// Mizuki selection pages in the native layout: 选择分队 / 选择招募组合 / 初始招募.
// Pure presentation. Every action is delegated to the caller, so game rules stay on the server.
import { h } from '../ui/components.js';
import { useState } from '../../vendor/hooks.module.js';
import { MizukiStage, MizukiTopBar, MizukiBottomBar, MizukiConfirm, hudBg } from './mizukiHud.js';

const e = (type, props, ...children) => h(type, props, ...children.flat(3));
const cx = (...parts) => parts.filter(Boolean).join(' ');
const arr = value => Array.isArray(value) ? value : [];
const same = (a, b) => a != null && b != null && String(a) === String(b);
const plain = value => String(value || '').replace(/<[^>]+>/g, '').replace(/\\n/g, ' ');
const INIT = name => '/assets/mizuki/native-ui/init/' + name + '.png';
const PROF_ICON = { PIONEER: 'pioneer', WARRIOR: 'warrior', TANK: 'tank', SNIPER: 'sniper', CASTER: 'caster', MEDIC: 'medic', SUPPORT: 'support', SPECIAL: 'special' };
const PROF_NAME = { PIONEER: '先锋', WARRIOR: '近卫', TANK: '重装', SNIPER: '狙击', CASTER: '术师', MEDIC: '医疗', SUPPORT: '辅助', SPECIAL: '特种' };

/** Fields shared by every page's top bar, derived from the synced model. */
export function hudFields({ model = {}, priv = {}, player = {}, ownHealth = {} }) {
  return {
    life: ownHealth.life, maxLife: ownHealth.maxLife, commander: model.commander,
    hope: priv.hope ?? player.hope, capacity: priv.hopeCapacity ?? player.hopeCapacity,
    gold: priv.gold ?? player.gold, keys: model.key ?? 0,
  };
}

function art(src, cls, extra) { return src ? e('img', { class: cls, src, alt: '', draggable: false, ...extra }) : null; }

/** "你确定要这么做？" prompt shown on the raised, selected card. Clicking the check confirms the pick. */
function Ask({ show, disabled, onConfirm }) {
  if (!show) return null;
  const fire = event => { event.stopPropagation(); if (!disabled) onConfirm(); };
  return e('span', { class: 'mzs-card__ask' }, e('small', {}, '你确定要这么做？'),
    e('span', { class: cx('mzs-card__check', disabled && 'is-disabled'), role: 'button', tabIndex: disabled ? -1 : 0, 'aria-label': '确认', 'aria-disabled': !!disabled, 'data-mz-card-confirm': true,
      onClick: fire, onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fire(event); } } }));
}

/** Small hex badges at the top-left of a squad card (rarity of the unlock tier). */
function Badges({ count }) {
  return e('span', { class: 'mzs-badges', 'aria-hidden': true }, Array.from({ length: count }, (_, index) => e('i', { key: index, class: 'mzs-badge mzs-badge--' + index })));
}

export function SquadSelectPage({ squads, selectedId, votedId, onFocus, onConfirm, library, top, bottom, busy, waiting, children }) {
  const selected = arr(squads).find(squad => same(squad.id, selectedId)) || arr(squads)[0];
  const icon = squad => library?.groups?.ui?.[squad.iconId]?.path || null;
  return e(MizukiStage, { class: 'mzs-page' },
    e('div', { class: 'mzh-backdrop mzh-backdrop--init' }),
    e(MizukiTopBar, { ...top, title: '选择分队', steps: 3, step: 0 }),
    e('div', { class: 'mzs-scroll', role: 'group', 'aria-label': '分队' }, arr(squads).map((squad, index) => {
      const on = same(selected?.id, squad.id);
      return e('button', { type: 'button', key: squad.id, class: cx('mzs-card', on && 'is-selected', same(votedId, squad.id) && 'is-voted'), style: { left: 54 + index * 383 + 'px' }, disabled: !!busy, 'aria-pressed': on, 'data-squad-id': squad.id, onClick: () => onFocus(squad.id), title: squad.name },
        e(Badges, { count: Math.min(3, 2 + (squad.effects?.length > 3 ? 1 : 0)) }),
        e('span', { class: 'mzs-card__art' }, art(icon(squad), 'mzs-card__icon')),
        e('span', { class: 'mzs-card__title' }, squad.name),
        e('span', { class: 'mzs-card__line' }),
        e('span', { class: 'mzs-card__desc' }, plain(squad.description || squad.desc)),
        children ? children(squad) : null,
        e(Ask, { show: on && !same(votedId, squad.id), disabled: !!busy, onConfirm: () => onConfirm(squad) }));
    })),
    arr(squads).length > 5 ? e('i', { class: 'mzs-more', 'aria-hidden': true }) : null,
    e('div', { class: 'mzs-actions' },
      e('span', { class: 'mzs-actions__text' }, waiting),
      e(MizukiConfirm, { kind: 'squad', disabled: !!busy || !selected, onClick: () => onConfirm(selected) }, same(votedId, selected?.id) ? '已选择' : '确认分队')),
    e(MizukiBottomBar, { showDice: false, ...bottom }));
}

/** 盟约策略: same card row as 选择分队, one band per card. */
export function StrategySelectPage({ options, selectedId, done, confirmedId, onFocus, onConfirm, top, bottom, busy, waiting, iconFor, takenName,
  title = '盟约策略', confirmKind = 'strategy', confirmLabel = '确认策略', optionAttr = 'data-band-id' }) {
  const selected = arr(options).find(option => same(option.bandId, selectedId)) || arr(options)[0];
  const taken = selected ? takenName(selected) : null;
  return e(MizukiStage, { class: 'mzs-page' },
    e('div', { class: 'mzh-backdrop mzh-backdrop--init' }),
    e(MizukiTopBar, { ...top, title }),
    e('div', { class: 'mzs-scroll', role: 'group', 'aria-label': title }, arr(options).map((option, index) => {
      const on = same(selected?.bandId, option.bandId), by = takenName(option);
      return e('button', { type: 'button', key: option.bandId, class: cx('mzs-card', on && 'is-selected', same(confirmedId, option.bandId) && 'is-voted', by && 'is-unavailable'), style: { left: 54 + index * 383 + 'px' }, disabled: !!busy || done, 'aria-pressed': on, [optionAttr]: option.bandId, onClick: () => onFocus(option.bandId), title: option.name },
        e('span', { class: 'mzs-card__art' }, art(iconFor(option), 'mzs-card__icon')),
        e('span', { class: 'mzs-card__title' }, option.name),
        e('span', { class: 'mzs-card__line' }),
        e('span', { class: 'mzs-card__desc' }, plain(option.description || option.desc)),
        by ? e('span', { class: 'mzs-card__reason' }, by + ' 已选择') : null,
        e(Ask, { show: on && !by && !done, disabled: !!busy, onConfirm: () => onConfirm(option) }));
    })),
    arr(options).length > 5 ? e('i', { class: 'mzs-more', 'aria-hidden': true }) : null,
    e('div', { class: 'mzs-actions' },
      e('span', { class: 'mzs-actions__text' }, waiting),
      e(MizukiConfirm, { kind: confirmKind, disabled: !!busy || done || !selected || !!taken, onClick: () => onConfirm(selected) }, done ? '已确认' : taken ? taken + ' 已选择' : confirmLabel)),
    e(MizukiBottomBar, { showDice: false, ...bottom }));
}

/** Opening supplies use the same cards, spacing and confirmation as strategy selection. */
export function InitialSupplyPage({ options, ...props }) {
  return e(StrategySelectPage, { ...props, options: arr(options).map(option => ({ ...option, bandId: option.id })),
    title: '初始补给', confirmKind: 'initialSupply', confirmLabel: '确认补给', optionAttr: 'data-initial-supply-id',
    takenName: () => null });
}

export function RecruitGroupPage({ groups, selectedId, done, onFocus, onConfirm, top, bottom, busy, waiting, ticketArt }) {
  const selected = arr(groups).find(group => same(group.id, selectedId)) || arr(groups)[0];
  const count = arr(groups).length;
  const left = index => Math.round((1920 - (count * 356 + (count - 1) * 27)) / 2) + index * 383;
  return e(MizukiStage, { class: 'mzs-page' },
    e('div', { class: 'mzh-backdrop mzh-backdrop--init' }),
    e(MizukiTopBar, { ...top, title: '选择招募组合', steps: 3, step: 1 }),
    e('div', { class: 'mzs-row', role: 'group', 'aria-label': '招募组合' }, arr(groups).map((group, index) => {
      const on = same(selected?.id, group.id);
      const unavailable = !!(group.disabled || group.unavailableReason);
      return e('button', { type: 'button', key: group.id, class: cx('mzs-card', 'mzs-card--group', on && 'is-selected', unavailable && 'is-unavailable'), style: { left: left(index) + 'px' }, disabled: !!busy || done, 'aria-pressed': on, 'data-recruit-group-id': group.id, onClick: () => onFocus(group.id), title: group.unavailableReason || group.name },
        e('span', { class: 'mzs-card__art' }, ticketArt(group)),
        e('span', { class: 'mzs-card__title' }, group.name),
        e('span', { class: 'mzs-card__line' }),
        e('span', { class: 'mzs-card__desc' }, plain(group.description || group.desc)),
        group.unavailableReason ? e('span', { class: 'mzs-card__reason' }, group.unavailableReason) : null,
        e(Ask, { show: on && !unavailable && !done, disabled: !!busy, onConfirm: () => onConfirm(group) }));
    })),
    e('div', { class: 'mzs-actions' },
      e('span', { class: 'mzs-actions__text' }, waiting),
      e(MizukiConfirm, { kind: 'recruitGroup', disabled: !!busy || done || !selected || !!(selected?.disabled || selected?.unavailableReason), onClick: () => onConfirm(selected) }, done ? '已确认' : '确认招募组合')),
    e(MizukiBottomBar, { ...bottom }));
}

/** 初始招募: one card per ticket; clicking 招募 opens that ticket's candidate page. */
export function InitialRecruitPage({ tickets, activeId, onPick, top, bottom, busy, ticketImage, operators, onOperators }) {
  const list = arr(tickets);
  const left = index => Math.round((1920 - (list.length * 330 + Math.max(0, list.length - 1) * 60)) / 2) + index * 390;
  return e(MizukiStage, { class: 'mzs-page' },
    e('div', { class: 'mzh-backdrop mzh-backdrop--init' }),
    e(MizukiTopBar, { ...top, title: '初始招募', steps: 3, step: 2 }),
    e('div', { class: 'mzs-row mzs-row--ticket' }, list.map((ticket, index) => {
      const usable = ticket.status === 'available';
      return e('div', { key: ticket.id, class: cx('mzs-ticket', same(ticket.id, activeId) && 'is-active', !usable && 'is-used'), style: { left: left(index) + 'px' }, 'data-ticket-id': ticket.id },
        e('span', { class: 'mzs-ticket__art' }, ticketImage(ticket)),
        e('span', { class: 'mzs-ticket__title' }, ticket.name),
        e('span', { class: 'mzs-ticket__line' }),
        e('span', { class: 'mzs-ticket__desc' }, plain(ticket.description) || '招募一个' + (PROF_NAME[String(ticket.profession || '').toUpperCase()] || '') + '干员'),
        e('button', { type: 'button', class: 'mzs-ticket__btn', disabled: !!busy || !usable, onClick: () => onPick(ticket), 'data-mz-ticket-pick': ticket.id }, usable ? '招募' : ticket.status === 'used' ? '已使用' : '已跳过'));
    })),
    e(MizukiBottomBar, { ...bottom, showOperators: true, operators, onOperators }));
}

export { PROF_ICON, PROF_NAME };
