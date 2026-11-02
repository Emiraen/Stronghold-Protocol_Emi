import { Nameplate } from '../ui/nameplates.js';
// Mizuki cooperative expedition: authoritative parties and native automatic fields.
import { h, Icon, Spinner, Button as ProtocolButton, Modal } from '../ui/components.js';
import { Fragment } from '../../vendor/preact.module.js';
import { MizukiBattleLineupScreen } from './mizukiRoute.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { store, useStore, emptyMatch } from '../store.js';
import { net } from '../net.js';
import { mizukiAssets as assets, MizukiImage as CachedImage, MizukiUnitThumb as UnitThumb } from '../mizukiAssets.js';
import { data } from '../data.js';
import { describeError } from '../ui/toasts.js';
import { NativeMizukiBattle, mizukiPersonalHealth, mizukiHealthText } from './mizukiBattle.js';
import { RichText } from '../ui/gameComponents.js';
import { requestMizukiExit } from './mizukiExit.js';
import { requestId } from '../requestId.js';
import { EquipReplaceDialog } from '../ui/equipReplace.js';
import { useMizukiUiClip } from '../mizukiUiMotion.js';
import { useMizukiRouteFx } from '../mizukiRouteFx.js';
import { useMizukiUiSfx } from '../mizukiUiSfx.js';
import { NativeMizukiConnector } from '../mizukiConnector.js';
import { mizukiPartyModel, mizukiWatchableFields } from '../mizukiParty.js';
import { applyPendingPrepMoves, createMizukiPrepMoveQueue, mizukiPrepMoveCanPredict } from '../mizukiPrep.js';
import { MIZUKI_VARIANT, MIZUKI_TITLE } from '../../../shared/mizuki-constants.js';
import { SquadSelectPage, RecruitGroupPage, InitialRecruitPage, StrategySelectPage, InitialSupplyPage, hudFields } from './mizukiSelect.js';
import { RecruitPage } from './mizukiRecruit.js';
import { RouteScreen } from './mizukiRoute.js';
import { RosterSidebar } from './mizukiRoster.js';
import { RecallConfirmation } from './mizukiRecall.js';
import { mizukiExplorationLayout, mizukiRouteMapBounds, MIZUKI_ROUTE_SCALE as ROUTE_SCALE } from '../mizukiRouteLayout.js';
export { mizukiExplorationLayout } from '../mizukiRouteLayout.js';

const e = (type, props, ...children) => h(type, props, ...children.flat(3));
const cx = (...parts) => parts.filter(Boolean).join(' ');
const arr = value => Array.isArray(value) ? value : [];
const same = (a, b) => a != null && b != null && String(a) === String(b);
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const percent = (value, max) => Math.max(0, Math.min(100, num(value) / Math.max(1, num(max, 1)) * 100));
const FIELD_NAMES = {};
const PHASE_NAMES = { MIZUKI_SQUAD: '选择分队', MIZUKI_STRATEGY: '盟约策略', MIZUKI_INITIAL_SUPPLY: '初始补给', MIZUKI_RECRUIT_GROUP: '招募组合', MIZUKI_ROUTE: '选择航线', MIZUKI_EVENT: '不期而遇', MIZUKI_RECRUIT: '干员招募', MIZUKI_SHOP: '诡意行商', PREP: '作战准备', COMBAT: '协同作战', MIZUKI_REWARD: '战后补给', MIZUKI_WAITING: '等待集合', RESULT: '探索结算' };

function mizukiPrepMoveApplied(prep, move) {
  const uid = move?.uid, target = move?.to;
  if (!Number.isInteger(uid) || !target) return false;
  if (target.area === 'board') {
    const piece = arr(prep?.board).find(value => value?.uid === uid);
    return !!piece && piece.row === target.row && piece.col === target.col && (!move.dir || piece.dir === move.dir);
  }
  if (target.area === 'hand') {
    const piece = (prep?.hand || prep?.bench)?.[target.idx];
    return (piece && typeof piece === 'object' ? piece.uid : piece) === uid;
  }
  return false;
}
const PROF_NAMES = { PIONEER: '先锋', WARRIOR: '近卫', TANK: '重装', SNIPER: '狙击', CASTER: '术师', MEDIC: '医疗', SUPPORT: '辅助', SPECIAL: '特种' };
const UNIT_REASONS = { DEVOUR_LOCKED: '该干员已被吞噬，解除后才能部署', OWNER_NOT_DEPLOYED: '所属干员尚未部署', TOKEN_UNAVAILABLE: '召唤物暂不可用', NO_SUMMON_STOCK: '召唤数量不足', SUMMON_LIMIT: '召唤物部署已达上限' };
function unitReason(unit) { return UNIT_REASONS[unit?.disabledReason] || unit?.disabledReason || ''; }

let mizukiLibraryPromise;
function loadMizukiLibrary() {
  if (!mizukiLibraryPromise) mizukiLibraryPromise = Promise.all([fetch('/assets/mizuki/library/manifest.json').then(response => response.ok ? response.json() : null), fetch('/assets/mizuki/native-ui-layout.json').then(response => response.ok ? response.json() : null), fetch('/assets/mizuki/native-ui-route/manifest.json').then(response => response.ok ? response.json() : null)]).then(([library, nativeUi, routeUi]) => library ? { ...library, nativeUi, routeUi } : null).catch(() => null);
  return mizukiLibraryPromise;
}
function ticketPicture(library, ticket) {
  const profession = String(ticket?.profession || 'ANY').toUpperCase();
  const key = ticket?.iconId || 'rogue_2_recruit_ticket_' + (profession === 'ANY' || profession === 'ALL' ? 'all' : profession.toLowerCase());
  return library?.groups?.tickets?.[key]?.path || null;
}
export function isMizukiMatch(pub, room) { return pub?.variant === MIZUKI_VARIANT || room?.variant === MIZUKI_VARIANT; }
export function mizukiRect(field) {
  const g = field?.geometry || {};
  const r = g.rect || field?.meta?.rect || {};
  return { r0: num(r.r0), r1: num(r.r1, Math.max(0, num(g.rows, 1) - 1)), c0: num(r.c0), c1: num(r.c1, Math.max(0, num(g.cols, 1) - 1)) };
}
export function mizukiTileReason({ tile, unit, field, mine, online, phase, occupied = false }) {
  if (!online) return '连接恢复后才能操作';
  if (!mine) return '正在观战另一分队，请切回我方战场';
  if (phase !== 'COMBAT') return '全队准备后开始手动部署';
  if (field?.done) return '本场战斗已结束';
  if (!unit) return '请先选择一名待部署干员';
  if (unit.deployable === false) return unitReason(unit) || '该单位暂不可部署';
  if (unit.deployed) return '该干员已部署在场';
  if (unit.removed) return '该干员暂不可再次部署';
  if (num(unit.redeployRemaining) > 0) return '再部署冷却 ' + Math.ceil(unit.redeployRemaining) + ' 秒';
  if (!tile || tile.build === 'NONE' || tile.obstacle || tile.special === 'start' || tile.special === 'end') return '此格不可部署';
  if (unit.position === 'MELEE' && (tile.height === 'HIGH' || !['ALL', 'MELEE'].includes(tile.build))) return '近战干员需要可部署地面';
  if (unit.position === 'RANGED' && !['ALL', 'RANGED'].includes(tile.build)) return '远程干员需要可部署高台';
  if (occupied) return '此格已有我方单位';
  const active = field?.deploySlotsUsed ?? Object.values(field?.rosters || {}).flatMap(arr).filter(item => item.deployed && !item.removed).reduce((sum, item) => sum + num(item.deploySlots, 1), 0);
  if (field?.deployLimit != null && active + num(unit.deploySlots, 1) > num(field.deployLimit)) return '本场共享部署位已满';
  return '';
}
function picture(record, enemy = false) {
  const a = record?.avatar;
  if (typeof a === 'string' && a.startsWith('/')) return a;
  return assets.picture(a || record?.charId || record?.defId || record?.chessId) || (enemy ? assets.enemyIcon(record?.defId) : assets.avatar(record?.charId)) || null;
}
function Art({ record, src, class: cls = '', enemy = false, portrait = false, alt = '' }) {
  const url = src || (portrait ? assets.portrait(record?.charId) : null) || picture(record, enemy);
  const [failed, setFailed] = useState(false);
  const [remoteFallback, setRemoteFallback] = useState(false);
  useEffect(() => { setFailed(false); setRemoteFallback(false); }, [url]);
  return e('span', { class: cx('mz-art', cls, portrait && 'mz-art--portrait', (!url || failed) && 'is-fallback') },
    e('span', { class: 'mz-art__fallback', 'aria-hidden': true }, String(record?.name || alt || '深')[0]),
    url && !failed ? e(remoteFallback ? CachedImage : 'img', { src: url, alt, loading: 'lazy', decoding: 'async', onError: () => remoteFallback ? setFailed(true) : setRemoteFallback(true) }) : null);
}
function Tag({ children, tone = '' }) { return e('span', { class: cx('mz-tag', tone && 'mz-tag--' + tone) }, children); }
function Button({ children, onClick, disabled = false, primary = false, danger = false, icon, busy = false, title, label, class: cls = '', ...rest }) {
  return e('button', { ...rest, type: 'button', class: cx('mz-btn', primary && 'mz-btn--primary', danger && 'mz-btn--danger', cls), disabled: disabled || busy, onClick, title, 'aria-label': label || undefined, 'aria-busy': busy || undefined },
    icon ? e(Icon, { name: icon }) : null, children, busy ? e('span', { class: 'mz-btn__busy', 'aria-hidden': true }) : null);
}
function PhaseHeading({ index, title, description, children }) { return e('div', { class: 'mz-phase-heading' }, e('div', {}, e('p', { class: 'mz-eyebrow' }, 'EXPEDITION / ' + index), e('h2', {}, title), description ? e('p', {}, description) : null), children); }
function Votes({ players, votes, id }) { return e('div', { class: 'mz-votes', 'aria-label': '队伍选择' }, players.map(p => e('span', { key: p.playerId, class: cx('mz-voter', same(votes?.[p.playerId], id) && 'is-on') }, e('span', {}, p.name || '博士'), same(votes?.[p.playerId], id) ? e(Icon, { name: 'check' }) : null))); }
function TeamPanel({ players, myId, fieldId, ready, priv }) {
  return e('section', { class: 'mz-panel mz-team' }, e('div', { class: 'mz-panel__heading' }, e('h3', {}, '联合探索队'), e(Tag, {}, players.length + ' 位博士')),
    players.map(p => e('div', { key: p.playerId, class: cx('mz-team__player', same(p.playerId, myId) && 'is-me') },
      e('span', { class: 'mz-team__seat' }, String(num(p.seat) + 1).padStart(2, '0')), e('div', {}, e('b', {}, p.name, same(p.playerId, myId) ? ' · 你' : ''), e('small', {}, FIELD_NAMES[p.fieldId] || p.fieldId || '待分配'),
        e('small', { 'data-mz-player-health': p.playerId }, mizukiHealthText(mizukiPersonalHealth(p, same(p.playerId, myId) ? priv : null)))),
      e(Tag, { tone: p.connected === false ? 'danger' : p.ready || same(p.playerId, myId) && ready ? 'mint' : '' }, p.connected === false ? '离线' : p.ready || same(p.playerId, myId) && ready ? '就绪' : same(p.fieldId, fieldId) ? '同场' : '联络'))));
}
function nativePicture(library, key) { return library?.groups?.ui?.[key]?.path || null; }
function nativeInitPicture(library, key) { return library?.nativeUi?.sprites?.[key]?.path || null; }
function nativeStyles(library) {
  const result = {};
  for (const [property, key] of Object.entries({ '--mz-ui-bkg': 'bkg', '--mz-ui-panel': 'panel_san_bkg', '--mz-ui-confirm': 'confirm_button', '--mz-ui-button': 'img_button', '--mz-ui-highlight': 'bg_select', '--mz-ui-select': 'bg_select_hard', '--mz-ui-title': 'title_bkg', '--mz-ui-dialog': 'image_ok_dialog_bkg', '--mz-ui-reward': 'img_button_bg', '--mz-ui-check': 'btn_select_check' })) { const path = nativePicture(library, key); if (path) result[property] = 'url(' + JSON.stringify(path) + ')'; }
  if (library?.nativeUi?.background?.path) result['--mz-init-background'] = 'url(' + JSON.stringify(library.nativeUi.background.path) + ')';
  return result;
}
function plainDescription(value) { return String(value || '').replace(/<[^>]+>/g, '').replace(/\\n/g, ' '); }
function NativeInitConfirm({ library, disabled, label, selectedName, onClick, kind, waiting }) {
  return e('div', { class: 'mz-init-commit' }, e('div', { class: 'mz-init-commit__summary' }, e('span', {}, selectedName || '请选择'), waiting ? e('small', {}, waiting) : null), e('button', { type: 'button', class: 'mz-btn mz-init-confirm', 'data-mz-confirm': kind, disabled, onClick }, e(Art, { src: nativeInitPicture(library, 'enter_btn_bg'), alt: '', class: 'mz-init-confirm__back' }), e(Art, { src: nativeInitPicture(library, 'enter_btn_arrow'), alt: '', class: 'mz-init-confirm__arrow' }), e('span', {}, label)));
}
function DifficultyControl({ model, isHost, busy, act, library }) {
  const [open,setOpen]=useState(false),options=arr(model.difficultyOptions);
  const selected=options.find(option=>num(option.grade)===num(model.difficultyGrade));
  const icon=library?.groups?.ui?.[num(model.difficultyGrade)>0?'hard_diff_icon':'easy_diff_icon']?.path;
  return e('div', {}, e(Button,{onClick:()=>setOpen(true),'data-mz-difficulty-open':true},icon?e(Art,{src:icon,alt:'',class:'mz-resource-icon'}):null,'N'+num(model.difficultyGrade)+' · '+(selected?.name||'探索难度')),
    e(Modal,{open,onClose:()=>setOpen(false),title:'探索难度',micro:'SURGING WAVES',actions:e(ProtocolButton,{onClick:()=>setOpen(false)},'完成')},
      e('p',{},isHost?'由房主在确定分队前选择本局难度。':'由房主选择本局难度，确定分队后锁定。'),
      library?.groups?.ui?.bg_select_hard?.path?e(Art,{src:library.groups.ui.bg_select_hard.path,alt:'',class:'mz-difficulty-original'}):null,
      e('div',{class:'mz-tickets',role:'group','aria-label':'原版难度 N0 至 N18'},options.map(option=>e('button',{key:option.grade,type:'button',class:cx('mz-ticket',num(model.difficultyGrade)===num(option.grade)&&'is-active'),disabled:!!busy||!isHost,'aria-pressed':num(model.difficultyGrade)===num(option.grade),'data-mz-difficulty':option.grade,onClick:()=>act('difficulty',{grade:option.grade}),title:plainDescription(option.ruleDesc||option.addDesc||option.name)},option.label||'N'+option.grade))),
      selected?e('div',{class:'mz-panel'},e('h3',{},(selected.label||'N'+selected.grade)+' · '+selected.name),e('p',{},plainDescription(selected.ruleDesc)),selected.addDesc?e('p',{},plainDescription(selected.addDesc)):null,e('small',{},'得分倍率 '+num(selected.scoreFactor,1))):null));
}
function SquadPhase({ model, players, mine, busy, act, library, isHost }) {
  const squads = arr(model.squads);
  const [focused, setFocused] = useState(null);
  const selected = squads.find(squad => same(squad.id, focused)) || squads.find(squad => same(squad.id, model.squadVotes?.[mine])) || squads[0];
  return e('section', { class: 'mz-phase mz-squad-phase mz-init-phase', 'data-native-prefab': 'roguelike_init_option' }, e(PhaseHeading, { index: '01 / INITIALIZATION', title: '选择分队', description: '决定本次探索的起点。全队共同选择一支分队。' },e(DifficultyControl,{model,isHost,busy,act,library})),
    e('div', { class: 'mz-init-gallery', role: 'group', 'aria-label': '原版探索分队' }, squads.map(squad => { const on = same(selected?.id, squad.id); return e('button', { type: 'button', key: squad.id, class: cx('mz-init-card', 'mz-init-card--squad', on && 'is-selected', same(model.squadVotes?.[mine], squad.id) && 'is-voted'), disabled: !!busy, 'aria-pressed': on, 'data-squad-id': squad.id, onClick: () => setFocused(squad.id), title: squad.name },
      e(Art, { src: nativeInitPicture(library, 'init_item_bg'), alt: '', class: 'mz-init-card__back' }), e(Art, { src: nativePicture(library, 'RELIC_INIT'), alt: '', class: 'mz-init-card__under' }), e(Art, { src: nativePicture(library, squad.iconId), alt: '', class: 'mz-init-card__icon' }), e('span', { class: 'mz-init-card__title' }, squad.name), e('span', { class: 'mz-init-card__line' }), e('span', { class: 'mz-init-card__desc' }, plainDescription(squad.description || squad.desc)),
      e('span', { class: 'mz-init-card__select', 'aria-hidden': true }, e(Art, { src: nativeInitPicture(library, on ? 'select_check' : 'option_check'), alt: '' })), e(Votes, { players, votes: model.squadVotes, id: squad.id })); })),
    e(NativeInitConfirm, { library, disabled: !!busy || !selected, selectedName: selected?.name, waiting: Object.keys(model.squadVotes || {}).length + ' / ' + players.length + ' 位博士已确认', label: same(model.squadVotes?.[mine], selected?.id) ? '已选择 · 等待队友' : '确认分队', kind: 'squad', onClick: () => act('squad', { squadId: selected.id }) }));
}
// Native-layout selection pages. State and actions are unchanged from the legacy phases above.
function SquadScreen({ model, priv, players, mine, busy, act, library, ownHealth }) {
  const squads = arr(model.squads);
  const [focused, setFocused] = useState(null);
  const selected = squads.find(squad => same(squad.id, focused)) || squads.find(squad => same(squad.id, model.squadVotes?.[mine])) || squads[0];
  return e(SquadSelectPage, { squads, selectedId: selected?.id, votedId: model.squadVotes?.[mine], library, busy, top: hudFields({ model, priv, player: players.find(player => same(player.playerId, mine)), ownHealth }),
    bottom: { dice: model.dice?.count }, waiting: Object.keys(model.squadVotes || {}).length + ' / ' + players.length + ' 位博士已确认',
    onFocus: setFocused, onConfirm: squad => act('squad', { squadId: squad.id }) });
}
function StrategyScreen({ model, priv, players, mine, busy, act, ownHealth }) {
  const strategy = priv.strategy || {};
  const options = arr(strategy.options || model.strategyOptions);
  const [focused, setFocused] = useState(null);
  const selections = model.strategySelections || {};
  const takenBy = bandId => Object.keys(selections).find(pid => !same(pid, mine) && same(selections[pid], bandId));
  const selected = options.find(option => same(option.bandId, focused)) || options.find(option => same(option.bandId, strategy.selected)) || options.find(option => !takenBy(option.bandId)) || options[0];
  return e(StrategySelectPage, { options, selectedId: selected?.bandId, done: !!strategy.done, busy, top: hudFields({ model, priv, player: players.find(player => same(player.playerId, mine)), ownHealth }), bottom: { dice: model.dice?.count },
    iconFor: option => assets.bandIcon(option.bandId), takenName: option => { const pid = takenBy(option.bandId); return pid ? players.find(player => same(player.playerId, pid))?.name || '队友' : null; },
    confirmedId: selections[mine], waiting: Object.keys(selections).length + ' / ' + players.length + ' 位博士已确认',
    onFocus: setFocused, onConfirm: option => act('strategy', { bandId: option.bandId }) });
}
function InitialSupplyScreen({ model, priv, players, mine, busy, act, library, ownHealth }) {
  const supply = priv.initialSupply || {};
  const options = arr(supply.options || model.initialSupplyOptions).map(option => option.iconKind === 'relic'
    ? { ...option, description: option.description + '\n团队共享收藏品，同一种仅生效一次。' } : option);
  const [focused, setFocused] = useState(null);
  const selected = options.find(option => same(option.id, focused)) || options.find(option => same(option.id, supply.selected)) || options[0];
  const selections = model.initialSupplySelections || {};
  return e(InitialSupplyPage, { options, selectedId: selected?.id, confirmedId: supply.selected || selections[mine],
    done: !!supply.done, busy, top: hudFields({ model, priv, player: players.find(player => same(player.playerId, mine)), ownHealth }), bottom: { dice: model.dice?.count },
    iconFor: option => library?.groups?.[option.iconKind === 'relic' ? 'items' : 'ui']?.[option.iconId]?.path
      || library?.groups?.items?.[option.itemId]?.path || assets.itemIcon(option.iconId || option.itemId),
    waiting: Object.keys(selections).length + ' / ' + players.length + ' 位博士已确认',
    onFocus: setFocused, onConfirm: option => act('initialSupply', { choiceId: option.id }) });
}
function RecruitGroupScreen({ model, priv, players, mine, busy, act, library, ownHealth }) {
  const groupState = priv.recruitGroup || {};
  const groups = arr(groupState.options || model.recruitGroups);
  const [focused, setFocused] = useState(null);
  const selected = groups.find(group => same(group.id, focused)) || groups.find(group => same(group.id, groupState.selected)) || groups[0];
  const ticketArt = group => e('span', { class: 'mzs-fan' },
    (arr(group.tickets).length ? arr(group.tickets) : [{}, {}, {}]).slice(0, 3).map((ticket, index) => e('img', { key: index, alt: '', draggable: false, src: ticketPicture(library, { profession: ticket.profession }) || nativePicture(library, 'RECRUIT_TICKET') || undefined })),
    group.id === 'recruit_group_random' ? e('span', { class: 'mzs-premium' }, 'PREMIUM') : null);
  return e(RecruitGroupPage, { groups, selectedId: selected?.id, done: !!groupState.done, busy, ticketArt, top: hudFields({ model, priv, player: players.find(player => same(player.playerId, mine)), ownHealth }),
    bottom: { dice: model.dice?.count }, waiting: Object.keys(model.recruitGroupSelections || {}).length + ' / ' + players.length + ' 位博士已确认',
    onFocus: setFocused, onConfirm: group => act('recruitGroup', { groupId: group.id }) });
}
function RecruitScreen({ model, priv, player, busy, online, act, library, ownHealth }) {
  const recruit = priv.recruit || {};
  const tickets = arr(recruit.tickets || priv.tickets);
  const activeId = recruit.activeTicketId || recruit.selectedTicketId || recruit.ticketId;
  const [picked, setPicked] = useState(null);
  const [offerId, setOfferId] = useState(null);
  const [rosterOpenRequest, setRosterOpenRequest] = useState(0);
  const onOperators = () => setRosterOpenRequest(value => value + 1);
  const withRoster = page => e(Fragment, {}, page, e(RosterManagement, { model, priv, phase: 'MIZUKI_RECRUIT', busy, online, act,
    slotKey: 'recruit:' + player?.playerId, hideTrigger: true, openRequest: rosterOpenRequest }));
  const top = hudFields({ model, priv, player, ownHealth });
  const bottom = { dice: model.dice?.count };
  const operators = arr(priv.roster).filter(unit => !unit.isToken).length;
  const available = tickets.filter(ticket => ticket.status === 'available');
  const showCards = !!recruit.ticket && picked != null && same(picked, activeId) && same(picked, recruit.ticket.id);
  useEffect(() => { setOfferId(null); }, [activeId, recruit.refreshToken]);
  // A ticket recruits once; when it is spent, go back to the ticket row for the next one.
  useEffect(() => { if (picked != null && !available.some(ticket => same(ticket.id, picked))) setPicked(null); }, [picked, available.length, activeId]);
  if (!showCards) {
    const ticketImage = ticket => e('img', { alt: '', draggable: false, src: ticketPicture(library, ticket) || undefined });
    return withRoster(e(InitialRecruitPage, { tickets, activeId, busy, ticketImage, top, bottom, operators, onOperators,
      onPick: async ticket => { if (!await act('recruit', { offerId: 'ticket:' + ticket.id })) return; setPicked(ticket.id); } }));
  }
  const offers = arr(recruit.choices);
  return withRoster(e(RecruitPage, { sidebar: offer => e(RosterSidebar, { unit: offer, tools: null }), offers, emptyReason: recruit.emptyReason, ticket: recruit.ticket,
    selectedId: offerId, busy, hope: priv.hope, bottom: { ...bottom, operators, onOperators },
    portraitFor: offer => assets.portrait(offer.charId) || picture(offer),
    onSelect: offer => setOfferId(offer.offerId), onExit: requestMizukiExit, onBack: () => setPicked(null),
    remaining: recruit.ticket ? num(recruit.ticket.count) : undefined, canRefresh: !!recruit.refreshToken, refreshLeft: num(recruit.freeRefreshes, recruit.ticket?.freeRefreshes), onRefresh: () => act('recruit', { offerId: recruit.refreshToken }),
    canGiveUp: !!recruit.canSkip && !!recruit.skipToken, onGiveUp: () => act('recruit', { offerId: recruit.skipToken }),
    onConfirm: offer => act('recruit', { offerId: offer.offerId }), confirmDisabled: !offers.some(offer => same(offer.offerId, offerId) && offer.available !== false) }));
}
function StrategyPhase({ model, priv, players, mine, busy, act }) {
  const strategy = priv.strategy || {};
  const options = arr(strategy.options || model.strategyOptions);
  const [focused, setFocused] = useState(null);
  const reservedBy = bandId => Object.entries(model.strategySelections || {}).find(([pid, id]) => !same(pid, mine) && same(id, bandId))?.[0];
  const reservedName = bandId => players.find(player => same(player.playerId, reservedBy(bandId)))?.name || '队友';
  const selected = options.find(option => same(option.bandId, focused)) || options.find(option => same(option.bandId, strategy.selected)) || options.find(option => !reservedBy(option.bandId));
  const preview = useRef(null);
  useMizukiUiClip(preview, 'showCard', selected?.bandId);
  return e('section', { class: 'mz-phase mz-strategy-phase' }, e(PhaseHeading, { index: 'PREPARATION / 02', title: '盟约策略选择', description: '保留卫戍协议现有盟约策略。每位博士独立选择一次，真实效果由服务器带入本次探索。' }),
    e('div', { class: 'mz-native-selection' }, e('div', { class: 'mz-native-selection__preview', ref: preview }, selected ? e('div', { 'data-native-path': 'container' }, e(Art, { src: assets.bandIcon(selected.bandId), alt: selected.name, class: 'mz-strategy-emblem' }), e('p', { class: 'mz-eyebrow' }, 'COVENANT STRATEGY'), e('h2', {}, selected.name), e('p', { class: 'mz-native-selection__description' }, plainDescription(selected.description || selected.desc)), e(Button, { primary: true, icon: 'check', disabled: !!busy || strategy.done || !!reservedBy(selected.bandId), onClick: () => act('strategy', { bandId: selected.bandId }) }, strategy.done ? '已确认 · 等待其他博士' : reservedBy(selected.bandId) ? reservedName(selected.bandId) + '已选择' : '确认策略'), e('p', { class: 'mz-native-selection__waiting' }, Object.keys(model.strategySelections || {}).length + ' / ' + players.length + ' 位博士已确认')) : e('p', {}, '正在同步盟约策略…')),
      e('div', { class: 'mz-strategy-list', role: 'group', 'aria-label': '卫戍协议盟约策略' }, options.map(option => e('button', { type: 'button', key: option.bandId, class: cx('mz-strategy-option', same(selected?.bandId, option.bandId) && 'is-selected'), disabled: !!busy || strategy.done, 'aria-pressed': same(selected?.bandId, option.bandId), onClick: () => setFocused(option.bandId) }, e(Art, { src: assets.bandIcon(option.bandId), alt: '', class: 'mz-strategy-option__art' }), e('span', {}, e('b', {}, option.name), e('small', {}, plainDescription(option.description || option.desc))), same(model.strategySelections?.[mine], option.bandId) ? e(Tag, { tone: 'mint' }, '已确认') : reservedBy(option.bandId) ? e(Tag, {}, reservedName(option.bandId) + '已选择') : null)))));
}
function RecruitGroupPhase({ model, priv, players, busy, act, library }) {
  const groupState = priv.recruitGroup || {};
  const options = arr(groupState.options || model.recruitGroups);
  const [focused, setFocused] = useState(null);
  const selected = options.find(option => same(option.id, focused)) || options.find(option => same(option.id, groupState.selected)) || options[0];
  return e('section', { class: 'mz-phase mz-recruit-group-phase mz-init-phase', 'data-native-prefab': 'roguelike_init_recruit' }, e(PhaseHeading, { index: '03 / INITIALIZATION', title: '招募组合', description: '每种职业各一张招募券；每张券可完成三次招募。' }),
    e('div', { class: 'mz-init-gallery mz-init-gallery--recruit', role: 'group', 'aria-label': '原版招募组合' }, options.map(option => { const on = same(selected?.id, option.id); return e('button', { type: 'button', key: option.id, class: cx('mz-init-card', 'mz-init-card--recruit', on && 'is-selected', (option.disabled || option.unavailableReason) && 'is-unavailable'), disabled: !!busy || groupState.done, 'aria-pressed': on, 'data-recruit-group-id': option.id, onClick: () => setFocused(option.id), title: option.unavailableReason || option.name },
      e(Art, { src: nativeInitPicture(library, 'recruit_bg'), alt: '', class: 'mz-init-card__back' }), e(Art, { src: nativePicture(library, 'RECRUIT_TICKET'), alt: '', class: 'mz-init-card__under' }), e('span', { class: 'mz-init-card__tickets' }, arr(option.tickets).map((ticket, index) => e(Art, { key: ticket.id || index, src: ticketPicture(library, typeof ticket === 'string' ? { profession: ticket } : ticket), alt: typeof ticket === 'string' ? PROF_NAMES[ticket] || ticket : ticket.name || '', class: 'mz-init-card__ticket' }))),
      e('span', { class: 'mz-init-card__title' }, option.name), e('span', { class: 'mz-init-card__line' }), e('span', { class: 'mz-init-card__desc' }, plainDescription(option.description || option.desc)), option.unavailableReason ? e('span', { class: 'mz-init-card__reason' }, option.unavailableReason) : null, e('span', { class: 'mz-init-card__select', 'aria-hidden': true }, e(Art, { src: nativeInitPicture(library, on ? 'select_check' : 'option_check'), alt: '' }))); })),
    e(NativeInitConfirm, { library, disabled: !!busy || groupState.done || !selected || selected.disabled || !!selected.unavailableReason, selectedName: selected?.name, waiting: Object.keys(model.recruitGroupSelections || {}).length + ' / ' + players.length + ' 位博士已确认', label: groupState.done ? '已确认 · 等待队友' : selected?.unavailableReason ? '暂不可选择' : '确认招募组合', kind: 'recruitGroup', onClick: () => act('recruitGroup', { groupId: selected.id }) }));
}
// Send topology only: never send official account inventory, progress or rewards.
export function mizukiDungeonImportPayload(value, sourceLabel = '') {
  const object = item => item !== null && typeof item === 'object' && !Array.isArray(item);
  const raw = object(value?.map) ? value.map : value;
  if (!object(raw) || (!object(raw.zones) && !Array.isArray(raw.zones))) throw new Error('没有找到原始 map.zones 或 zones 节点集合。');
  const collect = (item, depth = 0) => {
    if (depth > 5) throw new Error('节点容器层级过深。');
    if (object(item) && Object.hasOwn(item, 'pos')) {
      const pos = point => { if (!object(point) || !Number.isInteger(point.x) || !Number.isInteger(point.y) || point.x < 0 || point.y < 0 || point.x > 255 || point.y > 255) throw new Error('节点位置必须是 0–255 的原始整数坐标。'); return { x: point.x, y: point.y }; };
      if (typeof item.type !== 'string' || (item.stage != null && typeof item.stage !== 'string') || (item.visibility != null && !['string', 'number'].includes(typeof item.visibility)) || (item.nodeDisplaySubType != null && !Number.isInteger(item.nodeDisplaySubType)) || (item.next != null && !Array.isArray(item.next))) throw new Error('节点类型、关卡、可见性或连线字段无效。');
      return [{ pos: pos(item.pos), next: arr(item.next).map(line => { if ((line.hidden != null && ![0, 1, 2, 'SHOW', 'HIDE', 'APPEAR'].includes(line.hidden)) || (line.key != null && typeof line.key !== 'boolean')) throw new Error('连线显示或锁定字段无效。'); return { ...pos(line), ...(line.hidden == null ? {} : { hidden: line.hidden }), ...(line.key == null ? {} : { key: line.key }) }; }), type: item.type, stage: item.stage, nodeDisplaySubType: item.nodeDisplaySubType, visibility: item.visibility }];
    }
    if (!object(item) && !Array.isArray(item)) throw new Error('节点结构不符合原始结构。');
    return Object.values(item).filter(child => child !== null).flatMap(child => collect(child, depth + 1));
  };
  const dungeon = { zones: Object.fromEntries(Object.entries(raw.zones).map(([key, zone]) => { if (!object(zone)) throw new Error('楼层结构无效。'); return [key, { id: zone.id, nodes: collect(zone.nodes) }]; })) };
  const payload = { dungeon, sourceLabel: String(sourceLabel || '手动导入的原始结构数据').slice(0, 160) };
  const bytes = new TextEncoder().encode(JSON.stringify({ t: 'g.mizuki.importDungeon', ...payload })).length;
  if (bytes > 60 * 1024) throw new Error('精简后的路线数据为 ' + (bytes / 1024).toFixed(1) + ' KB，超过 60 KB。请只保留要导入的原始单层 zones 数据。');
  return { ...payload, bytes };
}
function DungeonImport({ busy, act, isHost }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [label, setLabel] = useState('');
  const [status, setStatus] = useState('');
  const importGraph = async () => {
    try { const { bytes, ...payload } = mizukiDungeonImportPayload(JSON.parse(text), label); if (await act('importDungeon', payload)) { setText(''); setOpen(false); setStatus('已导入 ' + (bytes / 1024).toFixed(1) + ' KB 原始拓扑；从入口开始探索。'); } }
    catch (error) { setStatus(error instanceof SyntaxError ? 'JSON 格式无效，请检查原始导出文件。' : error.message); }
  };
  return e('section', { class: 'mz-dungeon-import', 'aria-label': '原始路线导入' }, e('div', { class: 'mz-dungeon-import__bar' }, e('span', {}, '探索路线'), isHost ? e(Button, { disabled: !!busy, onClick: () => setOpen(value => !value), icon: 'book', class: 'mz-dungeon-import__toggle' }, open ? '收起导入' : '导入原始 JSON') : null), open && isHost ? e('div', { class: 'mz-dungeon-import__body' },
    e('p', {}, '支持 PlayerRoguelikeV2Dungeon，或包含 map.zones 的原始结构。只发送楼层 id、节点位置、连线、类型与关卡引用，不发送账号库存、进度或奖励。来源由提供者负责，未经过独立原版验证。'),
    e('label', { class: 'mz-dungeon-import__file' }, '读取本地 JSON', e('input', { type: 'file', accept: '.json,application/json', disabled: !!busy, onChange: async event => { const file = event.currentTarget.files?.[0]; if (!file) return; if (file.size > 10 * 1024 * 1024) { setStatus('文件超过 10 MB，请先精简为原始地图数据。'); return; } try { setText(await file.text()); setLabel(file.name.slice(0, 160)); setStatus('文件仅在本机读取，点击导入后发送精简拓扑。'); } catch { setStatus('无法读取该文件。'); } } })),
    e('textarea', { value: text, onInput: event => { setText(event.currentTarget.value); setStatus(''); }, placeholder: '粘贴原始探索结构 JSON，不预填示例路线', 'aria-label': '原始探索结构 JSON', spellcheck: false, disabled: !!busy }),
    e('div', { class: 'mz-dungeon-import__actions' }, e('small', {}, '精简后上限 60 KB · 非战斗节点仅展示 · 不自动补造层间结算'), e(Button, { primary: true, disabled: !!busy || !text.trim(), onClick: importGraph, class: 'mz-dungeon-import__submit' }, '导入并从入口开始'))) : null, status ? e('p', { class: 'mz-dungeon-import__status', role: 'status' }, status) : null);
}
function RouteDecisions({ model, players, mine, busy, act, library }) {
  const expedition = model.expedition || {}, parties = arr(expedition.parties);
  const party = parties.find(value => arr(value.memberIds).some(id => same(id, mine)));
  const leader = same(expedition.leaderId || model.hostId || players[0]?.playerId, mine);
  const members = party ? players.filter(player => arr(party.memberIds).includes(player.playerId)) : players;
  const votes = party?.votes || model.votes || {}, chosen = votes[mine];
  const pending = arr(expedition.requests).filter(value => value.status === 'pending');
  const allVoted = members.length > 0 && members.every(player => votes[player.playerId] != null);
  const nodeName = id => arr(model.route).find(node => same(node.id, id))?.title || arr(model.exploration?.nodes).find(node => same(node.id, id))?.title || id;
  return e('div', { class: 'mz-route-decisions' },
    e('div', { class: 'mz-init-commit' }, e('div', { class: 'mz-init-commit__summary' }, e('span', {}, '本队 ' + members.length + ' 人 · ' + Object.keys(votes).length + ' 票'), e('small', {}, leader ? '处理申请后，确认各队出发' : '投票后可向领队申请单独行动')),
      !leader && members.length > 1 ? e(ProtocolButton, { variant: 'secondary', disabled: !!busy || !chosen || pending.some(request => same(request.playerId, mine)), onClick: () => act('splitRequest', { nodeId: chosen }) }, '申请分开行动') : null,
      leader ? e(NativeInitConfirm, { library, kind: 'routeStart', disabled: !!busy || !allVoted || pending.length > 0 || !!party?.recallHold || !!model.sanCheck, selectedName: model.sanCheck ? '先完成层间检定' : party?.recallHold?'等待召回队友集合':'由领队确认航线', label: model.sanCheck ? '等待检定' : party?.recallHold?'等待归队':'确认出发', onClick: () => act('routeStart') }) : null),
    pending.length ? e('div', { class: 'mz-panel' }, pending.map(request => e('div', { key: request.id }, e('p', {}, (players.find(player => same(player.playerId, request.playerId))?.name || request.playerId) + ' 申请前往：' + nodeName(request.nodeId)), leader ? e('div', {}, e(ProtocolButton, { variant: 'primary', disabled: !!busy, onClick: () => act('splitDecide', { requestId: request.id, approve: true }) }, '批准分开行动'), e(ProtocolButton, { variant: 'secondary', disabled: !!busy, onClick: () => act('splitDecide', { requestId: request.id, approve: false }) }, '保留本队')) : e('small', {}, '等待领队审批')))) : null);
}
function SanCheckControls({ model, players, mine, busy, act, library }) {
  const [dismissed, setDismissed] = useState(null);
  const pending = model.sanCheck, check = pending?.check;
  if (!pending || !check) return null;
  const voter = players.find(player => same(player.playerId, mine));
  const eligible = arr(pending.memberIds).some(id => same(id, mine)) && !!voter && voter.connected !== false && voter.alive !== false && !voter.left;
  const names = new Map(players.map(player => [player.playerId, player.name || player.playerId]));
  const vote = choice => act('sanVote', { id: pending.id, choice });
  const background = nativePicture(library, 'panel_san_bkg');
  return e('div', {}, e(ProtocolButton, { size:'sm', variant:'secondary', onClick:() => setDismissed(null), 'data-mz-san-open':true }, '层间检定 · ' + check.roll),
    e(Modal, { open: dismissed !== pending.id, onClose: () => setDismissed(pending.id), title:'灯火检定', micro:'SAN CHECK',
      actions: [e(ProtocolButton, { disabled:!!busy || !eligible, onClick:() => vote('accept'), 'data-mz-san-vote':'accept' }, pending.votes?.[mine] === 'accept' ? '已选择接受' : '接受结果'),
        e(ProtocolButton, { variant:'secondary', disabled:!!busy || !eligible || !check.canReroll || num(model.dice?.count) < 1, onClick:() => vote('reroll'), 'data-mz-san-vote':'reroll' }, pending.votes?.[mine] === 'reroll' ? '已选择重投' : '消耗团队骰子重投 · ' + num(model.dice?.count))] },
      e('div', { class:'mz-panel', style: background ? { backgroundImage:'url(' + JSON.stringify(background) + ')', backgroundSize:'100% 100%' } : null, 'data-mz-san-id':pending.id },
        e('p', {}, e(Art, { src:nativePicture(library, 'DICE'), alt:'原版骰子', class:'mz-resource-icon' }), e('b', {}, '点数 ' + check.roll), ' · 灯火 ' + check.light),
        e('p', {}, plainDescription(check.resultDescription || ({ mutation:'排异反应', virtue:'获得正面效果', quiet:'无新增排异反应' })[check.kind] || check.kind).replace(/\{0\}/g, arr(check.targets).map(target => target.operatorName || '干员 ' + target.uid).join('、'))),
        arr(check.targets).map(target => e('div', { key:target.playerId + ':' + target.uid }, e('b', {}, target.playerName || names.get(target.playerId) || target.playerId, ' · ', target.operatorName || '干员 ' + target.uid),
          e('p', {}, e(Art, { src:nativePicture(library, target.mutationIcon), alt:'', class:'mz-resource-icon' }), target.mutationName || target.mutationId, ' · ', plainDescription(target.mutationDescription)))),
        pending.virtue ? e('p', {}, e(Art, { src:nativePicture(library, pending.virtue.iconId), alt:'', class:'mz-resource-icon' }), pending.virtue.name, ' · ', plainDescription(pending.virtue.description)) : null),
      e('p', {}, '全体在线成员完成表决后结算；票数相同时采用房主选择。'),
      e('div', { class:'mz-native-lineup', role:'status' }, arr(pending.memberIds).map(id => {
        const player = players.find(value => same(value.playerId, id));
        const vote = ({ accept:'接受', reroll:'重投' })[pending.votes?.[id]];
        const status = vote || (!player ? '已退出 · 不计票' : player.alive === false ? '已淘汰 · 不计票'
          : player.connected === false ? '离线 · 不计票' : '等待选择');
        return e('span', { key:id, class:'mz-tag' }, names.get(id) || id, '：', status);
      }))));
}
function RecallControls({ model, priv, players, mine, phase, busy, error, act }) {
  const [open,setOpen]=useState(false),[selected,setSelected]=useState([]);
  const expedition=model.expedition||{},parties=arr(expedition.parties);
  const party=parties.find(item=>arr(item.memberIds).some(id=>same(id,mine)));
  if(!party)return null;
  const leader=same(expedition.leaderId,mine),requests=arr(expedition.recalls);
  const targets=players.filter(player=>!arr(party.memberIds).some(id=>same(id,player.playerId)));
  const active=requests.filter(request=>['voting','scheduled'].includes(request.status));
  const name=id=>players.find(player=>same(player.playerId,id))?.name||id;
  const prompt=phase==='MIZUKI_ROUTE'?priv?.recallPrompt:null;
  const statuses={voting:'等待团队表决与本人确认',scheduled:'表决已通过，等待本人确认及路线集合',completed:'召回安排已结束',rejected:'召回未通过',cancelled:'召回已取消',superseded:'已由新的集合安排替代'};
  const propose=async()=>{const targetIds=selected.filter(id=>targets.some(player=>same(player.playerId,id)));if(targetIds.length&&await act('recallPropose',{targetIds}))setSelected([]);};
  return e('div',{},e(ProtocolButton,{size:'sm',variant:'secondary',icon:'users',onClick:()=>setOpen(true),'data-mz-recall-open':true},party.recallHold?'等待召回集合':'联队召回'+(active.length?' · '+active.length:'')),
    e(RecallConfirmation,{key:prompt?.requestId||'none',prompt,players,busy,error,act}),
    e(Modal,{open:open&&!prompt,onClose:()=>setOpen(false),title:'联队召回',micro:'RENDEZVOUS',actions:e(ProtocolButton,{onClick:()=>setOpen(false)},'关闭')},
      e('p',{},'领队提议后，由全队严格多数表决。被召回博士在路线中立即收到归队确认；正在节点中则在完成该节点并返回路线后确认。每人都可接受或拒绝。'),
      party.recallHold?e('p',{role:'status'},'本队已到达约定边界，等待队友归队。等待期间仍可观战其他战场。'):null,
      leader&&phase==='MIZUKI_ROUTE'&&!party.recallHold&&targets.length?e('div',{class:'mz-panel'},e('h3',{},'邀请队友归队'),e('div',{class:'mz-native-lineup'},targets.map(player=>e(ProtocolButton,{key:player.playerId,variant:selected.includes(player.playerId)?'primary':'secondary',disabled:!!busy||active.length>0,'aria-pressed':selected.includes(player.playerId),'data-mz-recall-target':player.playerId,onClick:()=>setSelected(values=>values.includes(player.playerId)?values.filter(id=>id!==player.playerId):[...values,player.playerId])},player.name))),e(ProtocolButton,{disabled:!!busy||!selected.length||active.length>0,onClick:propose,'data-mz-recall-propose':true},'发起召回表决')):null,
      requests.slice().reverse().map(request=>e('div',{key:request.id,class:'mz-panel','data-mz-recall-id':request.id},e('h3',{},arr(request.targetIds).map(name).join('、')),e('p',{},statuses[request.status]||request.status),e('small',{},'同意 '+Object.values(request.votes||{}).filter(Boolean).length+'/'+arr(request.electorate).length+' · 需 '+(Math.floor(arr(request.electorate).length/2)+1)+' 票'),
        request.status==='voting'&&arr(request.electorate).some(id=>same(id,mine))?e('div',{class:'mz-native-lineup'},e(ProtocolButton,{disabled:!!busy||Object.hasOwn(request.votes||{},mine),onClick:()=>act('recallVote',{requestId:request.id,agree:true}),'data-mz-recall-vote':'agree'},request.votes?.[mine]===true?'已投同意':'同意召回'),e(ProtocolButton,{variant:'secondary',disabled:!!busy||Object.hasOwn(request.votes||{},mine),onClick:()=>act('recallVote',{requestId:request.id,agree:false}),'data-mz-recall-vote':'reject'},request.votes?.[mine]===false?'已投反对':'反对召回')):null,
        arr(request.targetIds).some(id=>same(id,mine))?e('p',{},Object.hasOwn(request.responses||{},mine)?request.responses[mine]?'你已确认归队':'你已拒绝归队，将继续当前探索':['voting','scheduled'].includes(request.status)?'返回路线后会弹出你的归队确认。':null):null)),!requests.length?e('p',{},'暂无召回安排。'):null));
}
const mizukiSlotCache = new Map();
export function reconcileMizukiLineupSlots(previous, lineup, capacity) {
  const allowed = new Set(arr(lineup));
  const seen = new Set();
  const slots = Array.from({ length: Math.max(0, Math.trunc(capacity)) }, (_, index) => {
    const uid = arr(previous)[index];
    if (uid == null || !allowed.has(uid) || seen.has(uid)) return null;
    seen.add(uid); return uid;
  });
  for (const uid of allowed) if (!seen.has(uid)) {
    const index = slots.indexOf(null); if (index < 0) break;
    slots[index] = uid; seen.add(uid);
  }
  return slots;
}
function MizukiRosterCard({ unit, selected, equipped, onSelect, onRemove, locked, slot, fromKeyboard, filteredOut, onDragOver, onDrop }) {
  const rec = unit.uiRecord || data.lookup('chess', unit.chessId) || unit;
  const rarity = Math.max(1, Math.min(6, num(unit.rarity, num(rec.rarity, 1))));
  return e('div', { role: 'button', tabIndex: filteredOut ? -1 : 0, class: cx('mz-native-roster-card', filteredOut && 'is-filtered-out', selected && 'is-selected', unit.promotion && 'is-promoted', fromKeyboard && 'is-keyboard'), 'data-mz-roster-unit': unit.uid, 'data-mz-roster-slot': slot, 'data-mz-rarity': rarity, 'aria-pressed': !!selected, onDragOver, onDrop,
    onClick: () => onSelect(unit.uid, false), onKeyDown: event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(unit.uid, true); } } },
    e(Art, { record: rec, portrait: true, class: 'mz-native-roster-card__portrait' }),
    e('span', { class: 'mz-native-roster-card__band' }, e('b', {}, unit.name), e('small', {}, PROF_NAMES[rec.profession || unit.profession] || '干员')),
    e('span', { class: 'mz-native-roster-card__stars', 'aria-label': rarity + '星' }, e('img', { src: '/assets/mizuki/native-ui-roster/rarity_sprite_' + (rarity - 1) + '.png', alt: '' })),
    e('img', { class: 'mz-native-roster-card__elite', src: '/assets/mizuki/native-ui-roster/elite_' + (unit.promotion ? 2 : 1) + '.png', alt: unit.promotion ? '精英二' : '精英一', 'data-mz-elite': unit.promotion ? 2 : 1 }),
    e('span', { class: 'mz-native-roster-card__equipment' }, equipped(unit).map(item => e(UnitThumb, { key: item.uid, kind: 'item', id: item.id, size: 'sm', showTier: false }))),
    selected && onRemove ? e('button', { type: 'button', class: 'mz-native-roster-card__remove', disabled: locked, 'data-mz-lineup-remove': unit.uid, onClick: event => { event.stopPropagation(); void onRemove(unit.uid); } }, e('img', { src: '/assets/mizuki/native-ui-roster/remove.png', alt: '' }), e('span', {}, '确认撤下？')) : null);
}
function RosterManagement({ model, priv, phase, busy, online, act, slotKey, hideTrigger = false, openRequest = 0 }) {
  const [open, setOpen] = useState(false), [dismiss, setDismiss] = useState(null);
  useEffect(() => { if (openRequest > 0) setOpen(true); }, [openRequest]);
  const [rosterFilter, setRosterFilter] = useState(''), [libraryFilter, setLibraryFilter] = useState('');
  const [chooserSlot, setChooserSlot] = useState(null), [keyboardSelection, setKeyboardSelection] = useState(false), [dragItemUid, setDragItemUid] = useState(null);
  const [selectedUnitUid, setSelectedUnitUid] = useState(null);
  const [selectedItemUid, setSelectedItemUid] = useState(null), [replace, setReplace] = useState(null);
  const roster = arr(priv.roster).filter(unit => !unit.isToken);
  const capacity = Math.max(0, num(priv.squadCapacity, num(model.squadCapacity, 6)));
  const lineup = arr(priv.lineup).filter(uid => roster.some(unit => same(unit.uid, uid)));
  const lineupKey = lineup.join(',');
  const [slots, setSlots] = useState(() => reconcileMizukiLineupSlots(mizukiSlotCache.get(slotKey), lineup, capacity));
  const visibleSlots = slots.map((uid, index) => ({ index, unit: roster.find(unit => same(unit.uid, uid)) }));
  const reserveRoster = roster.filter(unit => !lineup.some(uid => same(uid, unit.uid)) && (unit.name || unit.chessId || '').toLowerCase().includes(libraryFilter.trim().toLowerCase()));
  useEffect(() => {
    if (phase === 'MIZUKI_SQUAD') mizukiSlotCache.delete(slotKey);
    setSlots(previous => { const next = reconcileMizukiLineupSlots(previous, lineup, capacity); mizukiSlotCache.set(slotKey, next); return next; });
  }, [slotKey, lineupKey, capacity, phase === 'MIZUKI_SQUAD']);
  const rules = priv.equipmentRules || {}, economy = priv.economy || {};
  const inventory = arr(priv.equipment?.inventory);
  const itemRecord = item => ({ ...data.lookup('items', item?.id), ...item });
  const getItem = id => {
    const enriched = [...inventory, ...arr(priv.equipment?.equipped).flatMap(row => arr(row.items))].find(item => item.id === id);
    const rec = data.lookup('items', id);
    return rec ? { ...rec, ...enriched, desc: enriched?.description || rec.desc } : enriched;
  };
  const selectedUnit = roster.find(unit => same(unit.uid, selectedUnitUid) && slots.some(uid => same(uid, unit.uid))) || roster.find(unit => same(unit.uid, slots.find(uid => uid != null)));
  const loadout = selectedUnit?.loadout || selectedUnit?.loadoutOptions || {};
  const selectedRecordData = selectedUnit?.uiRecord || data.lookup('chess', selectedUnit?.chessId) || {};
  const selectedStats = loadout.stats || selectedUnit?.stats || selectedRecordData.stats || {};
  const skillOptions = arr(loadout.skills?.length ? loadout.skills : selectedUnit?.skills);
  const moduleOptions = arr(loadout.modules);
  const currentSkill = loadout.skillIndex ?? selectedUnit?.skillIndex ?? 0;
  const currentModule = loadout.moduleId || selectedUnit?.moduleId || 'none';
  const moduleIcon = option => option.iconPath || (option.id !== 'none' && option.typeName ? '/assets/mizuki/native-ui-roster/modules/' + option.typeName.toLowerCase().replace(/[αβγδ]/g, value => ({ 'α': 'a', 'β': 'b', 'γ': 'g', 'δ': 'd' })[value]) + '.png' : null);
  const equipped = unit => arr(priv.equipment?.equipped).find(row => same(row.uid, unit.uid))?.items || arr(unit.items);
  const selectedItem = inventory.find(item => same(item.uid, selectedItemUid));
  const selectedRecord = selectedItem && itemRecord(selectedItem);
  const consumable = !!selectedRecord && (selectedRecord.consumable || String(selectedRecord.effectKind || selectedRecord.kind).startsWith('consume_on_equip'));
  const outsideCombat = ['PREP','MIZUKI_ROUTE','MIZUKI_REWARD','MIZUKI_EVENT','MIZUKI_SHOP','MIZUKI_RECRUIT'].includes(phase);
  const locked = !!busy || !online || !outsideCombat || !!priv.ready || !!model.sanCheck || priv.eliminated || priv.alive === false;
  const equipmentLocked = locked || !rules.enabled;
  const reason = !online ? '连接恢复后可整备' : priv.alive === false || priv.eliminated ? '本次探索已结束' : !outsideCombat ? '战斗结束后可整备' : model.sanCheck ? '请先完成层间检定' : priv.ready ? '取消准备后可整备' : '';
  const rowStyle = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '.12rem' };
  const eligible = priv.dismissal ? priv.dismissal.enabled : ['MIZUKI_ROUTE','MIZUKI_REWARD','MIZUKI_EVENT','MIZUKI_SHOP','MIZUKI_RECRUIT'].includes(phase) || phase === 'PREP' && num(priv.completedNodes, model.completedNodes) > 0;
  useEffect(() => { if (!inventory.some(item => same(item.uid, selectedItemUid))) setSelectedItemUid(null); }, [inventory, selectedItemUid]);
  const selectUnit = (uid, keyboard = false) => { setSelectedUnitUid(uid); setKeyboardSelection(keyboard); };
  const saveSlots = next => { setSlots(next); mizukiSlotCache.set(slotKey, next); };
  const removeFromLineup = async uid => {
    if (locked || !lineup.some(value => same(value, uid))) return;
    if (await act('lineup', { uids: lineup.filter(value => !same(value, uid)) })) saveSlots(slots.map(value => same(value, uid) ? null : value));
  };
  const addToLineup = async uid => {
    if (locked || chooserSlot == null || slots[chooserSlot] != null || lineup.length >= capacity || !roster.some(unit => same(unit.uid, uid)) || lineup.some(value => same(value, uid))) return;
    const next = slots.map((value, index) => index === chooserSlot ? uid : value);
    if (await act('lineup', { uids: next.filter(value => value != null) })) { saveSlots(next); selectUnit(uid); setChooserSlot(null); }
  };
  const changeLoadout = (skillIndex, moduleId) => { if (!locked && selectedUnit) void act('loadout', { uid: selectedUnit.uid, skillIndex, moduleId }); };
  const finish = async () => { if (!locked && eligible && dismiss && await act('dismiss', { uid: dismiss.uid, requestId: requestId() })) setDismiss(null); };
  const equip = async (item, unit, replaceUid) => {
    if (equipmentLocked || !item || !unit) return;
    if (await act('equip', { itemUid: item.uid, targetUid: unit.uid, ...(replaceUid == null ? {} : { replaceUid }), requestId: requestId() })) {
      setSelectedItemUid(null); setReplace(null);
    }
  };
  const assignItem = (item, unit, replaceUid) => {
    if (equipmentLocked || !item || !unit || !inventory.some(value => same(value.uid, item.uid))) return;
    const record = itemRecord(item);
    const consume = record.consumable || String(record.effectKind || record.kind).startsWith('consume_on_equip');
    const items = equipped(unit);
    if (!consume && (replaceUid != null || items.length >= num(rules.equipPerChess, 2))) {
      setReplace({ targetUid: unit.uid, targetId: unit.chessId || unit.operatorId, targetName: unit.name,
        golden: !!unit.promotion, item: { ...item, name: record.name || item.id },
        options: items.filter(value => replaceUid == null || same(value.uid, replaceUid)).map(value => ({ ...value, name: getItem(value.id)?.name || value.id })) });
    } else void equip(item, unit);
  };
  const assign = unit => assignItem(selectedItem, unit);
  const acceptEquipmentDrag = event => {
    if (equipmentLocked || (!inventory.some(item => same(item.uid, dragItemUid)) && !Array.from(event.dataTransfer?.types || []).includes('application/x-mizuki-item'))) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  };
  const dropEquipment = (event, unit, replaceUid) => {
    event.preventDefault(); event.stopPropagation();
    if (equipmentLocked || !unit) return;
    const uid = event.dataTransfer?.getData('application/x-mizuki-item');
    const item = inventory.find(value => same(value.uid, uid));
    setDragItemUid(null);
    if (item) { selectUnit(unit.uid); assignItem(item, unit, replaceUid); }
  };
  const pick = async (offer, choice) => {
    if (equipmentLocked) return;
    await act('equipmentPick', { offerId: offer.id,
      ...(offer.kind === 'item' ? { itemId: choice.itemId || choice.id } : { operatorId: choice.operatorId || choice.id }), requestId: requestId() });
  };
  return e('div', { class: 'mz-roster-management' }, hideTrigger ? null : e(ProtocolButton, { variant: 'secondary', size: 'sm', icon: 'users', 'data-mz-equipment-open': true, onClick: () => setOpen(true) }, '编队整备', inventory.length ? ' · 装备 ' + inventory.length : '', arr(priv.equipmentOffers).length ? ' · 待领取 ' + arr(priv.equipmentOffers).length : ''),
    e(Modal, { open, onClose: () => setOpen(false), title: '探索编队与装备', micro: 'SQUAD · EQUIPMENT', class: 'mz-native-roster-modal', width: 'min(1440px, 96vw)', actions: e(ProtocolButton, { onClick: () => setOpen(false) }, '完成') },
      e('label', { class: 'mz-native-roster-filter' }, e('span', {}, '探索编队 · ' + lineup.length + ' / ' + capacity), e('input', { type: 'search', value: rosterFilter, placeholder: '查找干员', 'aria-label': '查找探索编队干员', onInput: event => setRosterFilter(event.currentTarget.value) })),
      selectedUnit ? e('section', { class: 'mz-native-roster-operator', 'data-mz-operator-details': selectedUnit.uid }, e('h3', {}, selectedUnit.name),
        e('dl', { class: 'mz-native-roster-stats' }, [['生命', 'maxHp'], ['攻击', 'atk'], ['防御', 'def'], ['法抗', 'res'], ['费用', 'cost'], ['阻挡', 'blockCnt']].map(([label, key]) => e('div', { key }, e('dt', {}, label), e('dd', {}, selectedStats[key] == null ? '—' : Math.round(num(selectedStats[key])))))),
        e('div', { class: 'mz-native-gear-slots', 'aria-label': '干员装备栏' }, Array.from({ length: num(rules.equipPerChess, 2) }, (_, index) => {
          const item = equipped(selectedUnit)[index];
          return e('button', { key: index, type: 'button', class: cx('mz-native-gear-slot', item && 'is-occupied', dragItemUid != null && !equipmentLocked && 'is-drop-ready'), 'data-mz-gear-slot': index, 'data-mz-gear-item': item?.uid, disabled: equipmentLocked, title: item ? getItem(item.id)?.name || item.id : '装备栏 ' + (index + 1), 'aria-label': item ? getItem(item.id)?.name || item.id : '空装备栏 ' + (index + 1), onDragOver: acceptEquipmentDrag, onDrop: event => dropEquipment(event, selectedUnit, item?.uid), onClick: () => selectedItem && assignItem(selectedItem, selectedUnit, item?.uid) }, item ? e(UnitThumb, { kind: 'item', id: item.id, size: 'md' }) : null);
        })),
        e('div', { class: 'mz-native-loadout-list' },
        e('div', { class: 'mz-native-loadout-group' }, e('h4', {}, '技能'), skillOptions.map(option => e('button', { key: option.index, type: 'button', class: cx('mz-native-loadout-option', num(option.index) === num(currentSkill) && 'is-selected'), disabled: locked || loadout.editable === false, 'data-mz-loadout-skill': option.index, 'aria-pressed': num(option.index) === num(currentSkill), onClick: () => changeLoadout(option.index, currentModule) },
          e(Art, { src: assets.skillIcon(option.iconId || option.skillId), alt: '', class: 'mz-native-loadout-option__icon' }), e('span', { class: 'mz-native-loadout-option__text' }, e('b', {}, option.name || '技能 ' + (num(option.index) + 1)), e(RichText, { as: 'span', text: option.description || '' }))))),
        e('div', { class: 'mz-native-loadout-group' }, e('h4', {}, '模组'), (moduleOptions.length ? moduleOptions : [{ id: currentModule, name: currentModule === 'none' ? '不装备模组' : currentModule }]).map(option => e('button', { key: option.id, type: 'button', class: cx('mz-native-loadout-option', option.id === currentModule && 'is-selected'), disabled: locked || loadout.editable === false || !moduleOptions.length, 'data-mz-loadout-module': option.id, 'aria-pressed': option.id === currentModule, onClick: () => changeLoadout(currentSkill, option.id) },
          moduleIcon(option) ? e(Art, { src: moduleIcon(option), alt: '', class: 'mz-native-loadout-option__icon' }) : null, e('span', { class: 'mz-native-loadout-option__text' }, e('b', {}, option.name || option.id), e(RichText, { as: 'span', text: option.description || '' }))))))) : null,
      reason ? e('p', { role: 'status', 'data-mz-equipment-lock': true }, reason) : null,
      rules.enabled ? e('div', { class: 'mz-panel', 'data-mz-equipment-progress': true },
        e('span', {}, '希望 ' + num(priv.hope)), e('span', {}, '源石锭 ' + num(priv.gold)),
        e('small', { 'data-mz-economic-conversion': true }, '资金余数 ' + num(economy.coinRemainder) + ' / ' + num(economy.coinsPerHope, 5)), e('small', {}, '道具补给 ' + num(rules.nextDropIn, 2) + ' 场')) : null,
      arr(priv.equipmentOffers).map(offer => e('section', { key: offer.id, class: 'mz-panel', 'data-mz-equipment-offer': offer.id },
        e('h3', {}, offer.kind === 'item' ? '选择装备' : '选择干员'),
        e('div', { style: rowStyle }, arr(offer.choices).map(raw => {
          const choice = typeof raw === 'string' ? { id: raw, ...(offer.kind === 'item' ? { itemId: raw } : { operatorId: raw }) } : raw;
          const id = choice.itemId || choice.chessId || choice.operatorId || choice.id;
          const rec = offer.kind === 'item' ? getItem(id) : data.lookup('chess', choice.chessId || id);
          return e('div', { key: id, style: rowStyle }, e(UnitThumb, { kind: offer.kind === 'item' ? 'item' : 'chess', id, rec, size: 'md' }),
            e(ProtocolButton, { size: 'sm', disabled: equipmentLocked, 'data-mz-equipment-pick': id, onClick: () => pick(offer, choice) }, choice.name || rec?.name || id));
        })))),
      rules.enabled ? e('section', { class: 'mz-panel', 'data-mz-equipment-inventory': true }, e('h3', {}, '个人装备库存 · ' + inventory.length),
        e('div', { style: rowStyle }, inventory.map(item => e(ProtocolButton, { key: item.uid, variant: same(item.uid, selectedItemUid) ? 'primary' : 'secondary', size: 'sm',
          'data-mz-equipment-item': item.uid, draggable: !equipmentLocked, onDragStart: event => { if (equipmentLocked) { event.preventDefault(); return; } event.dataTransfer.setData('application/x-mizuki-item', String(item.uid)); event.dataTransfer.effectAllowed = 'move'; setDragItemUid(item.uid); }, onDragEnd: () => setDragItemUid(null), 'aria-pressed': same(item.uid, selectedItemUid), onClick: () => setSelectedItemUid(same(item.uid, selectedItemUid) ? null : item.uid) },
        e(UnitThumb, { kind: 'item', id: item.id, size: 'sm' }), itemRecord(item).name || item.id))),
        !inventory.length ? e('small', {}, '暂无待配发的装备。') : null,
        selectedRecord ? e('div', { 'data-mz-equipment-selected': selectedItem.uid }, e('b', {}, selectedRecord.name || selectedRecord.id, consumable ? ' · 使用后立即生效' : ' · 持续穿戴'),
          e(RichText, { as: 'p', text: selectedRecord.descRaw || selectedRecord.description || selectedRecord.desc || '' }),
          arr(selectedRecord.buffs || selectedRecord.effects).some(buff => buff.key === 'equip_round_start_upgrade_char') ? e('p', {}, '本模式使用后立即精英化目标干员。') : null) : null) : null,
      e('div', { class: 'mz-native-roster-grid', 'aria-label': '探索编队干员' }, visibleSlots.map(({ index, unit }) => unit
        ? e(MizukiRosterCard, { key: 'slot:' + index, unit, selected: same(unit.uid, selectedUnit?.uid), equipped, onSelect: selectUnit, onRemove: removeFromLineup, locked, slot: index, fromKeyboard: keyboardSelection, filteredOut: !(unit.name || unit.chessId || '').toLowerCase().includes(rosterFilter.trim().toLowerCase()), onDragOver: acceptEquipmentDrag, onDrop: event => dropEquipment(event, unit) })
        : e('button', { key: 'slot:' + index, type: 'button', class: 'mz-native-roster-empty', 'data-mz-lineup-plus': index, 'data-mz-roster-slot': index, disabled: locked, 'aria-label': '编队空位 ' + (index + 1), onClick: () => { setLibraryFilter(''); setChooserSlot(index); } }, e('img', { src: '/assets/mizuki/native-ui-roster/plus.png', alt: '+' })))),
      e('div', { class: 'mz-native-roster-details' }, selectedUnit ? [
        e('b', {}, selectedUnit.name),
        e('span', { class: 'mz-native-roster-details__items' }, equipped(selectedUnit).map(item => e('span', { key: item.uid, title: getItem(item.id)?.name || item.id, 'data-mz-equipped-item': item.uid }, e(UnitThumb, { kind: 'item', id: item.id, size: 'sm' }), e('small', {}, getItem(item.id)?.name || item.id))), !equipped(selectedUnit).length ? e('small', {}, '未装备') : null),
        selectedItem ? e(ProtocolButton, { size: 'sm', disabled: equipmentLocked, 'data-mz-equipment-assign': selectedUnit.uid, onClick: () => assign(selectedUnit) }, consumable ? '对该干员使用' : '为该干员配发') : null,
        e(ProtocolButton, { variant: 'danger', size: 'sm', disabled: locked || !eligible, onClick: () => setDismiss(selectedUnit) }, '遣散 · +1 希望')
      ] : e('span', {}, '尚未招募干员'))),
    e(Modal, { open: chooserSlot != null && open, onClose: () => setChooserSlot(null), title: '已招募干员', class: 'mz-native-roster-modal mz-native-roster-library', width: 'min(1200px, 94vw)' },
      e('input', { type: 'search', value: libraryFilter, placeholder: '查找干员', 'aria-label': '查找已招募干员', onInput: event => setLibraryFilter(event.currentTarget.value) }),
      e('div', { class: 'mz-native-roster-library__grid' }, reserveRoster.map(unit => e(MizukiRosterCard, { key: unit.uid, unit, equipped, onSelect: uid => addToLineup(uid), locked }))),
      reserveRoster.length ? null : e('small', {}, '暂无可编入干员')),
    e(Modal, { open: !!dismiss, onClose: () => setDismiss(null), title: '遣散干员', actions: [e(ProtocolButton, { variant: 'secondary', onClick: () => setDismiss(null) }, '保留干员'), e(ProtocolButton, { variant: 'danger', disabled: locked || !eligible, onClick: finish }, '确认遣散 · +1 希望')] }, e('p', {}, '遣散' + (dismiss?.name || '') + '，返还 1 点希望。该干员将离开本次探索，已穿戴装备退回装备库存。')),
    e(EquipReplaceDialog, { request: replace, getItem, busy: equipmentLocked, onCancel: () => setReplace(null), onConfirm: uid => equip(inventory.find(item => same(item.uid, replace?.item.uid)), roster.find(unit => same(unit.uid, replace?.targetUid)), uid) }));
}
function WaitingPhase({ model, priv, players, onWatch }) {
  const parties = arr(model.expedition?.parties);
  const watchable = mizukiWatchableFields(model, priv.partyId);
  const eliminated = !!priv.eliminated || priv.alive === false;
  return e('section', { class: 'mz-phase mz-reward', 'data-mz-waiting': 'true' },
    e('header', { class: 'mz-phase__head' }, e('h2', {}, eliminated ? '本次作战已结束' : '等待集合'), e('p', {}, eliminated ? '你的生命已耗尽，可以继续观战其他博士的战场。' : '本队已到达集合点，等待其他队伍。')),
    e('div', { class: 'mz-panel' }, parties.map(party => e('div', { key: party.id },
      e('p', {}, arr(party.memberIds).map(id => players.find(player => same(player.playerId, id))?.name || id).join('、')),
      e('small', {}, PHASE_NAMES[party.phase] || party.phase, party.currentNode?.title ? ' · ' + party.currentNode.title : '')))),
    watchable.length ? e('div', { class: 'mz-native-lineup' }, watchable.map(field => e(ProtocolButton, { key: field.fieldId, variant: 'secondary', icon: 'eye', 'data-mz-watch-field': field.fieldId, onClick: () => onWatch(field.fieldId) }, '观战 · ' + (field.name || field.fieldId))))
      : e('p', {}, '其他队伍正在整备或处理节点，战斗开始后可观战。'));
}
function ExplorationRoutePhase(props) {
  return e('div', { class: 'mz-exploration' }, e(RoutePhase, props), e(RouteDecisions, props));
}
// These PPtr-resolved sprites come directly from rogue_2's NodeViewData.
// Server topology intentionally need not carry presentation-specific icon ids.
export function mizukiRouteArtwork(node, library) {
  const manifest = library?.routeUi;
  const type = node?.revealed === false ? manifest?.types?.UNKNOWN
    : typeof node?.type === 'number' ? node.type : manifest?.types?.[node?.type];
  const explicit = node?.revealed === false ? null : nativePicture(library, node?.iconId || node?.nodeIconId);
  return { type, icon: explicit || manifest?.activeIcons?.[type]?.path || null,
    nameIcon: manifest?.nameIcons?.[type]?.path || null,
    color: manifest?.colors?.[type] || 'rgba(255,255,255,1)' };
}
function NativeRouteNode({ node, votes, mine, players, busy, act, library }) {
  const ref = useRef(null);
  const available = node.available && !node.unlockPending;
  useMizukiUiClip(ref, node.current ? 'anim_current_node' : available ? 'anim_selectable_node' : null, node.id);
  const voted = same(votes[mine], node.id);
  const artwork = mizukiRouteArtwork(node, library);
  const name = node.revealed === false ? '迷雾重重' : (node.available || node.current || node.completed ? node.stageName : null) || node.title || node.type;
  return e('button', { ref, type: 'button', class: cx('mz-map-node', node.current && 'is-current', available && 'is-available', node.completed && 'is-completed', node.discarded && 'is-discarded', voted && 'is-voted'), style: { left: node.x + 'px', top: node.y + 'px', '--mz-node-color': artwork.color }, 'data-native-node-type': artwork.type, 'data-route-id': node.id, 'data-route-depth': node.depth, 'data-route-index': node.index, 'data-route-unlock-pending': node.unlockPending ? 'true' : 'false', 'aria-label': name + (node.current ? '，当前位置' : available ? '，可前往' : node.completed ? '，已通过' : '，不可前往'), 'aria-pressed': voted, disabled: !!busy || !available, title: node.disabledReason || name, onClick: () => act('route', { nodeId: node.id }) },
    e('span', { class: 'mz-map-node__plate', 'data-native-path': 'panel_widgets/image_bkg' }, e(Art, { src: nativePicture(library, 'node_unactive'), alt: '' })),
    e('span', { class: 'mz-map-node__plate', 'data-native-path': 'panel_widgets/image_bkg_selectable', style: node.current || available ? undefined : { visibility: 'hidden' } }, e(Art, { src: nativePicture(library, 'node_active'), alt: '' })),
    artwork.icon ? e('span', { class: 'mz-map-node__icon', 'data-native-path': 'panel_widgets/image_icon' }, e(Art, { src: artwork.icon, alt: '' })) : null,
    artwork.nameIcon ? e('span', { class: 'mz-map-node__tag', style: { '--mz-node-tag': 'url(' + JSON.stringify(library?.routeUi?.plates?.description?.path) + ')' } }, e(Art, { src: artwork.nameIcon, alt: '', class: 'mz-map-node__type-name' })) : null,
    node.current ? e('span', { class: 'mz-map-node__current' }, '当前位置') : null,
    node.completed ? e('span', { class: 'mz-map-node__completed', 'aria-hidden': true }, e(Icon, { name: 'check' })) : null,
    e('span', { class: 'mz-map-node__label' }, name), Object.values(votes).some(id => same(id, node.id)) ? e(Votes, { players, votes, id: node.id }) : null);
}
function RoutePhase({ model, players, mine, busy, act, library }) {
  const exploration = model.exploration;
  const graph = mizukiExplorationLayout(exploration);
  const votes = exploration?.votes || model.votes || {};
  const floor = exploration?.floor;
  // The client ships one original rogue_2 map plate per floor.  Keep the
  // topology authoritative, but paint the route over that plate instead of
  // the generic gradient that was previously used as a placeholder.  This
  // is also what keeps the node field visually aligned with the native map
  // shown by the game client when the floor changes.
  const floorNumber = Math.max(1, Math.min(7, num(floor?.index, num(model.floor, 1) - 1) + 1));
  const mapBackground = nativePicture(library, floor?.backgroundId) || nativePicture(library, 'rogue_2_map_' + floorNumber);
  const unavailable = exploration?.available !== true || !graph.nodes.length;
  const canvas = useRef(null);
  const unlockKey = String(floor?.key || floor?.id || '') + ':' + String(exploration?.currentNodeId || 'entry');
  const [unlocked, setUnlocked] = useState({ key: '', edges: [] });
  const completeConnector = useMemo(() => id => setUnlocked(previous => {
    const edges = previous.key === unlockKey ? previous.edges : [];
    return edges.includes(id) ? previous : { key: unlockKey, edges: [...edges, id] };
  }), [unlockKey]);
  const pendingNodes = new Set(graph.edges.filter(edge => edge.fromNode.current && edge.fromNode.completed
    && edge.toNode.available && !edge.locked && !(unlocked.key === unlockKey
      && unlocked.edges.includes(String(edge.from) + ':' + String(edge.to)))).map(edge => String(edge.to)));
  const displayNodes = graph.nodes.map(node => ({ ...node, unlockPending: pendingNodes.has(String(node.id)) }));
  useMizukiRouteFx(canvas, displayNodes.map(node => ({ ...node, available: node.available && !node.unlockPending })), !unavailable);
  return e('section', { class: 'mz-phase mz-route-phase mz-native-map', 'data-route-version': exploration?.version || 'unavailable' },
    e('header', { class: 'mz-native-map__heading' }, e('h2', {}, floor?.name || '探索航线'), e('span', { class: 'mz-native-map__depth' }, floor?.index == null ? '深度待同步' : '第 ' + (Number(floor.index) + 1) + ' 层')),
    unavailable ? e('div', { class: 'mz-native-map__unavailable', role: 'status' }, e(Art, { src: nativePicture(library, 'node_unactive'), alt: '', class: 'mz-native-map__empty-node' }), e('h3', {}, '原版探索地图尚未载入'), e('p', {}, exploration?.unavailableReason || '等待服务器导入当前探索的节点位置与连线。'), e('small', {}, '关卡资源目录不等同于一局探索地图。')) :
      e('div', { class: 'mz-native-map__viewport', tabIndex: 0, 'aria-label': '探索路线图，可横向滚动' }, e('div', { class: 'mz-native-map__canvas', ref: canvas, 'data-native-map-floor': floorNumber, style: { width: graph.width + 'px', height: graph.height + 'px', ...(mapBackground ? { backgroundImage: 'url(' + JSON.stringify(mapBackground) + ')' } : {}) } },
        e('svg', { class: 'mz-native-map__edges', viewBox: '0 0 ' + graph.width + ' ' + graph.height, width: graph.width, height: graph.height, 'aria-hidden': true }, graph.edges.map((edge, index) => e(NativeMizukiConnector, { key: unlockKey + ':' + String(edge.from) + ':' + String(edge.to) + ':' + index, routeScope: unlockKey, edge, index, onComplete: completeConnector }))),
        displayNodes.map(node => e(NativeRouteNode, { key: unlockKey + ':' + node.id, node, votes, mine, players, busy, act, library })))));
}

/** Map layer for the stage layout: same nodes, connectors and fx as RoutePhase, scaled up and scrollable. */
function RouteMapLayer({ model, players, mine, busy, act, library }) {
  const exploration = model.exploration;
  const graph = mizukiExplorationLayout(exploration);
  const votes = exploration?.votes || model.votes || {};
  const floor = exploration?.floor;
  const unavailable = exploration?.available !== true || !graph.nodes.length;
  const canvas = useRef(null), scroller = useRef(null);
  const unlockKey = String(floor?.key || floor?.id || '') + ':' + String(exploration?.currentNodeId || 'entry');
  const [unlocked, setUnlocked] = useState({ key: '', edges: [] });
  const completeConnector = useMemo(() => id => setUnlocked(previous => {
    const edges = previous.key === unlockKey ? previous.edges : [];
    return edges.includes(id) ? previous : { key: unlockKey, edges: [...edges, id] };
  }), [unlockKey]);
  const pendingNodes = new Set(graph.edges.filter(edge => edge.fromNode.current && edge.fromNode.completed
    && edge.toNode.available && !edge.locked && !(unlocked.key === unlockKey
      && unlocked.edges.includes(String(edge.from) + ':' + String(edge.to)))).map(edge => String(edge.to)));
  const displayNodes = graph.nodes.map(node => ({ ...node, unlockPending: pendingNodes.has(String(node.id)) }));
  useMizukiRouteFx(canvas, displayNodes.map(node => ({ ...node, available: node.available && !node.unlockPending })), !unavailable);
  const current = graph.nodes.find(node => node.current) || graph.nodes.find(node => same(node.id, exploration?.currentNodeId)) || graph.nodes[0];
  const bounds = mizukiRouteMapBounds(graph);
  useEffect(() => {
    const el = scroller.current;
    const focus = graph.nodes.find(node => same(node.id, votes[mine])) || current;
    if (el && focus) {
      el.scrollLeft = Math.max(0, focus.x * ROUTE_SCALE - 600);
      el.scrollTop = Math.max(0, bounds.offsetY + focus.y * ROUTE_SCALE - el.clientHeight / 2);
    }
  }, [unlockKey, votes[mine], graph.width, graph.height, bounds.offsetY]);
  if (unavailable) return e('div', { class: 'mzv-unavailable', role: 'status' }, e('h3', {}, '原版探索地图尚未载入'), e('p', {}, exploration?.unavailableReason || '等待服务器导入当前探索的节点位置与连线。'));
  return e('div', { class: 'mzv-map', ref: scroller, tabIndex: 0, 'aria-label': '探索路线图，可横向或纵向滚动' },
    e('div', { class: 'mzv-map__size', style: { width: bounds.width + 'px', height: bounds.height + 'px' } },
      e('div', { class: 'mz-native-map__canvas mzv-map__canvas', ref: canvas, style: { width: graph.width + 'px', height: graph.height + 'px', transform: 'translate(0,' + bounds.offsetY + 'px) scale(' + ROUTE_SCALE + ')' } },
        e('svg', { class: 'mz-native-map__edges', viewBox: '0 0 ' + graph.width + ' ' + graph.height, width: graph.width, height: graph.height, 'aria-hidden': true }, graph.edges.map((edge, index) => e(NativeMizukiConnector, { key: unlockKey + ':' + String(edge.from) + ':' + String(edge.to) + ':' + index, routeScope: unlockKey, edge, index, onComplete: completeConnector }))),
        displayNodes.map(node => e(NativeRouteNode, { key: unlockKey + ':' + node.id, node, votes, mine, players, busy, act, library })))));
}
const shownFloors = new Set();
/** Short full-screen card announcing the floor the party just entered (name, line, description). Click to skip. */
function FloorIntro({ floor, backdrop, icon, onDone }) {
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    const fade = setTimeout(() => setClosing(true), 3400), end = setTimeout(onDone, 4200);
    return () => { clearTimeout(fade); clearTimeout(end); };
  }, []);
  const skip = () => { setClosing(true); setTimeout(onDone, 500); };
  return e('div', { class: cx('mzv-intro', closing && 'is-out'), role: 'status', 'aria-live': 'polite', 'data-mz-floor-intro': floor.id || floor.key, onClick: skip },
    e('div', { class: 'mzv-intro__bg', style: backdrop ? { backgroundImage: 'url(' + JSON.stringify(backdrop) + ')' } : undefined }),
    e('div', { class: 'mzv-intro__body' },
      icon ? e('img', { class: 'mzv-intro__icon', src: icon, alt: '', draggable: false }) : null,
      e('i', { class: 'mzv-intro__line' }),
      e('small', {}, 'ZONE ' + String(num(floor.index, 0) + 1).padStart(2, '0')),
      e('h2', {}, floor.name),
      e('i', { class: 'mzv-intro__glow' }),
      floor.description ? e('p', {}, floor.description) : null));
}
function RouteStageScreen({ model, priv, players, mine, busy, online, act, library, ownHealth, error, onClearError, extras }) {
  const portraitFor = unit => assets.portrait(unit.charId) || picture(unit);
  const floor = model.exploration?.floor;
  const floorNumber = Math.max(1, Math.min(7, num(floor?.index, num(model.floor, 1) - 1) + 1));
  const backdrop = nativePicture(library, floor?.backgroundId) || nativePicture(library, 'rogue_2_map_' + floorNumber);
  const floorKey = floor ? String(floor.key ?? floor.id ?? floor.index) : null;
  const [introKey, setIntroKey] = useState(() => floorKey && !shownFloors.has(floorKey) ? floorKey : null);
  useEffect(() => { if (floorKey && !shownFloors.has(floorKey)) setIntroKey(floorKey); }, [floorKey]);
  const closeIntro = () => { if (introKey) shownFloors.add(introKey); setIntroKey(null); };
  const intro = floor && introKey && introKey === floorKey ? e(FloorIntro, { key: floorKey, floor, backdrop, icon: nativePicture(library, floor.zoneIconId), onDone: closeIntro }) : null;
  return e(RouteScreen, { model, priv, players, mine, busy, act, error, onClearError, extras, intro, backdrop, portraitFor, online,
    top: hudFields({ model, priv, player: players.find(player => same(player.playerId, mine)), ownHealth }), artworkFor: node => mizukiRouteArtwork(node, library),
    map: e(RouteMapLayer, { model, players, mine, busy, act, library }) });
}
function EventPhase({ model, players, mine, busy, act }) { const event = model.event || {}; return e('section', { class: 'mz-phase mz-event-phase', 'data-mz-scene': event.sceneId, 'data-mz-event-revision': event.state?.revision },
  e(PhaseHeading, { index: '02', title: event.title || '海中相逢', description: plainDescription(event.description || '一道陌生的回声，打断了下潜的脚步。') }),
  e('div', { class: 'mz-event-mark', 'aria-hidden': true }, e(Icon, { name: 'book' })),
  e('div', { class: 'mz-event-choices' }, arr(event.choices).map((choice, i) => { const selected = same(event.votes?.[mine], choice.id); return e('button', { type: 'button', key: event.sceneId + ':' + choice.id, class: cx('mz-event-choice', selected && 'is-selected'), disabled: !!busy || choice.available === false, title: choice.disabledReason || undefined, 'aria-pressed': selected, onClick: () => act('event', { choiceId: choice.id }) }, e('span', { class: 'mz-event-choice__number' }, String(i + 1).padStart(2, '0')), e('span', { class: 'mz-event-choice__text' }, e('b', {}, plainDescription(choice.label)), e('small', {}, plainDescription(choice.disabledReason || choice.description)), e(Votes, { players, votes: event.votes, id: choice.id })), e(Icon, { name: selected ? 'check' : 'chevronRight' })); }))); }
function RecruitPhase({ priv, busy, act, library }) {
  const recruit = priv.recruit;
  const [query, setQuery] = useState('');
  const [profession, setProfession] = useState('ALL');
  const [rarity, setRarity] = useState('ALL');
  const [limit, setLimit] = useState(24);
  const activeTicketId = recruit?.activeTicketId || recruit?.selectedTicketId || recruit?.ticketId;
  const tickets = arr(recruit?.tickets || priv.tickets);
  const availableTickets = tickets.filter(ticket => ticket.status === 'available');
  const maxRoster = recruit?.maxRoster == null ? null : num(recruit.maxRoster);
  const rosterFull = maxRoster != null && arr(priv.roster).length >= maxRoster;
  useEffect(() => { setQuery(''); setProfession('ALL'); setRarity('ALL'); setLimit(24); }, [activeTicketId]);
  useEffect(() => setLimit(24), [query, profession, rarity]);
  const choices = arr(recruit?.choices);
  const filtered = useMemo(() => { const q = query.trim().toLocaleLowerCase(); return choices.filter(offer => (profession === 'ALL' || offer.profession === profession) && (rarity === 'ALL' || num(offer.rarity) === num(rarity)) && (!q || [offer.name, offer.charId, offer.chessId, ...(arr(offer.bonds))].join(' ').toLocaleLowerCase().includes(q))); }, [choices, query, profession, rarity]);
  return e('section', { class: 'mz-phase mz-recruit-phase' },
    e(PhaseHeading, { index: '03', title: '灯火之下，仍有同伴', description: '使用招募券与希望邀请干员。每名干员由所属博士指挥，与你的同场队友共同守线。' }, e(Tag, { tone: 'gold' }, '当前希望 ' + num(priv.hope))),
    recruit?.ticket ? e('div', {},
      e('div', { class: 'mz-ticket-bar' }, e('div', {}, e('p', { class: 'mz-eyebrow' }, 'RECRUITMENT PERMIT'), e('h3', {}, recruit.ticket?.name || '招募券'), e('small', {}, '当前持有 ' + availableTickets.length + ' 张 · 剩余招募次数 ' + availableTickets.reduce((sum, ticket) => sum + num(ticket.count, 1), 0) + ' · 已招募 ' + arr(priv.roster).length + (maxRoster == null ? '' : ' / ' + maxRoster) + (priv.squadCapacity == null ? '' : ' · 可携带 ' + priv.squadCapacity))),
        e('div', { class: 'mz-tickets', role: 'group', 'aria-label': '选择招募券' }, tickets.map(ticket => e('button', { type: 'button', key: ticket.id, class: cx('mz-ticket', same(ticket.id, activeTicketId) && 'is-active', ticket.status !== 'available' && 'is-used'), disabled: !!busy || ticket.status !== 'available' || same(ticket.id, activeTicketId), onClick: () => act('recruit', { offerId: 'ticket:' + ticket.id }), title: ticket.name + ' · ' + (ticket.status === 'available' ? '1 张，剩余 ' + num(ticket.count, 1) + ' 次招募' : ticket.status === 'used' ? '已使用' : '已跳过') }, ticketPicture(library, ticket) ? e(Art, { src: ticketPicture(library, ticket), alt: '', class: 'mz-ticket__art' }) : e(Icon, { name: ticket.status === 'used' ? 'check' : 'book' }), e('span', {}, ticket.name), e('small', {}, ticket.status === 'available' ? '1 张 · ' + num(ticket.count, 1) + ' 次' : ticket.status === 'used' ? '已使用' : '已跳过'))))),
      e('div', { class: 'mz-recruit-toolbar', role: 'search', 'aria-label': '筛选招募干员' },
        e('label', { class: 'mz-search' }, e(Icon, { name: 'search' }), e('input', { type: 'search', value: query, onInput: event => setQuery(event.currentTarget.value), placeholder: '搜索干员名称或代号', 'aria-label': '搜索干员名称或代号' })),
        e('label', { class: 'mz-filter' }, e('span', {}, '职业'), e('select', { value: profession, onChange: event => setProfession(event.currentTarget.value), 'aria-label': '按职业筛选' }, e('option', { value: 'ALL' }, '全部职业'), Object.entries(PROF_NAMES).map(([id, name]) => e('option', { key: id, value: id }, name)))),
        e('label', { class: 'mz-filter' }, e('span', {}, '星级'), e('select', { value: rarity, onChange: event => setRarity(event.currentTarget.value), 'aria-label': '按星级筛选' }, e('option', { value: 'ALL' }, '全部星级'), [1, 2, 3, 4, 5, 6].map(value => e('option', { key: value, value: String(value) }, value + ' 星'))))),
      e('div', { class: 'mz-recruit-count', role: 'status' }, e('span', {}, filtered.length + ' / ' + choices.length + ' 名可查看干员'), e('span', {}, '全干员池 · 招募券职业提高对应职业出现概率 · 同名三份精英化')),
      e('div', { class: 'mz-catalogue-grid' }, filtered.slice(0, limit).map(offer => { const actionName = ({ recruit: '招募', copy: '招募同名', promote: '三份精英化', upgrade: '高级券进阶' })[offer.action] || (offer.canUpgrade ? '进阶' : '招募'); const reason = offer.disabledReason || (rosterFull && !offer.owned ? '作战队列已满' : num(priv.hope) < num(offer.hopeCost) ? '希望不足' : offer.available === false ? '暂不可招募' : ''); return e('article', { class: cx('mz-catalogue-card', reason && 'is-unavailable'), key: offer.offerId, 'data-offer-id': offer.offerId }, e(Art, { record: offer, class: 'mz-catalogue-card__art' }), e('div', { class: 'mz-catalogue-card__info' }, e('p', { class: 'mz-eyebrow' }, (PROF_NAMES[offer.profession] || offer.profession || '干员') + ' / ' + num(offer.rarity) + '星'), e('h3', {}, offer.name), e('small', {}, '部署费用 ' + num(offer.cost) + ' DP' + (offer.owned ? ' · 本次后同名 ' + num(offer.recruitCopies, 1) + ' / 3' : '')), e('div', { class: 'mz-catalogue-card__bonds' }, arr(offer.bonds).slice(0, 3).map(bond => e('span', { key: typeof bond === 'string' ? bond : bond.id }, typeof bond === 'string' ? bond : bond.name || bond.id)))), e(Button, { primary: !reason, disabled: !!busy || !!reason, label: actionName + offer.name + '，' + (reason || num(offer.hopeCost) + '希望'), title: reason || '消耗当前招募券与 ' + num(offer.hopeCost) + ' 希望', onClick: () => act('recruit', { offerId: offer.offerId }), icon: offer.owned ? 'check' : 'plus' }, reason || actionName + ' · ' + num(offer.hopeCost) + ' 希望')); })),
      !filtered.length ? e('div', { class: 'mz-empty' }, e(Icon, { name: 'search' }), '没有符合筛选条件的干员，试试清除搜索或切换职业。') : null,
      filtered.length > limit ? e('div', { class: 'mz-load-more' }, e(Button, { onClick: () => setLimit(value => value + 24), icon: 'plus' }, '继续显示干员 · 剩余 ' + (filtered.length - limit))) : null,
      e('div', { class: 'mz-phase-footer' }, e('p', {}, '当前券为 1 张 · 剩余 ' + num(recruit.ticket?.count) + ' 次招募 · 免费刷新 ' + num(recruit.freeRefreshes, recruit.ticket?.freeRefreshes) + ' 次。选择干员后自动更换候选，保留免费刷新次数。'), e(Button, { disabled: !!busy || !recruit.refreshToken || num(recruit.freeRefreshes, recruit.ticket?.freeRefreshes) <= 0, onClick: () => act('recruit', { offerId: recruit.refreshToken }), 'data-mz-recruit-refresh': true }, '免费刷新 · ' + num(recruit.freeRefreshes, recruit.ticket?.freeRefreshes)), recruit.canSkip ? e(Button, { disabled: !!busy || !recruit.skipToken, onClick: () => act('recruit', { offerId: recruit.skipToken }), 'data-mz-recruit-skip': true }, '放弃本券剩余招募') : null))
      : e('div', { class: 'mz-complete' }, e(Icon, { name: 'check' }), e('h3', {}, '本次招募已完成'), e('p', {}, '正在等待其他博士完成选择。')));
}
function ShopPhase({ model, priv, busy, act, library }) {
  const [bankOpen, setBankOpen] = useState(false);
  const [withdrawCount, setWithdrawCount] = useState(1);
  const shop = priv.shop || {}, refreshCount = num(shop.refreshCost?.count, 1);
  const bank = shop.bank;
  const dice = num(model.dice?.count);
  return e('section', { class: 'mz-phase' }, e(PhaseHeading, { index: '04', title: '诡意行商', description: shop.closed ? '坎诺特已经收起了货物。' : shop.looted ? '商战胜利，选择本店剩余商品，无需支付源石锭。' : '用源石锭交换补给，也可以消耗骰子刷新商品。' }, e(Tag, { tone: 'gold' }, '源石锭 ' + num(priv.gold))),
    e('div', { class: 'mz-shop-grid' }, arr(shop.offers).map((offer, i) => {
      const art = library?.groups?.items?.[offer.iconId || offer.itemId]?.path || library?.groups?.tickets?.[offer.iconId || offer.itemId]?.path;
      return e('article', { class: cx('mz-shop-card', offer.sold && 'is-sold'), key: offer.offerId || offer.id },
        e('div', { class: 'mz-shop-card__glyph' }, art ? e(Art, { src: art, alt: offer.name || offer.title }) : e(Icon, { name: offer.type === 'recruitTicket' ? 'users' : 'gift' }), e('small', {}, 'SUPPLY / ' + String(i + 1).padStart(2, '0'))),
        e('h3', {}, offer.name || offer.title || offer.label), e('p', {}, plainDescription(offer.description)),
        e(Button, { primary: !offer.sold, disabled: !!busy || priv.ready || offer.sold || num(priv.gold) < num(offer.price), onClick: () => act('buy', { offerId: offer.offerId || offer.id }), icon: offer.sold ? 'check' : 'box' }, offer.sold ? '已购入' : num(priv.gold) < num(offer.price) ? '源石锭不足 · ' + offer.price : '购入 · ' + offer.price + ' 源石锭'));
    })),
    e('div', { class: 'mz-phase-footer' }, e('p', {}, priv.ready ? '你已准备离开商店，等待队友。' : shop.lastRoll ? '上次掷骰点数 ' + (shop.lastRoll.value ?? shop.lastRoll.roll ?? shop.lastRoll) + ' · 当前骰子 ' + dice : '补给完成后，确认继续探索。'),
      shop.canRefresh ? e(Button, { disabled: !!busy || priv.ready || dice < refreshCount, onClick: () => act('shopRefresh', {}), 'data-mz-shop-refresh': true }, '刷新商品 · ' + refreshCount + ' 骰子') : null,
      shop.canBattle ? e(Button, { disabled: !!busy || priv.ready, onClick: () => act('shopBattle', {}), icon: 'sword' }, '请坎诺特降价') : null,
      bank ? e(Button, { disabled: !!busy || priv.ready, onClick: () => setBankOpen(true) }, '投资系统 · ' + num(bank.current)) : null,
      e(Button, { primary: !priv.ready, disabled: !!busy, onClick: () => act('ready', { on: !priv.ready }), icon: priv.ready ? 'check' : 'chevronRight' }, priv.ready ? '取消就绪' : '补给完成')),
    bank ? e(Modal, { open: bankOpen, onClose: () => setBankOpen(false), title: '前瞻性投资系统',
      actions: e(ProtocolButton, { onClick: () => setBankOpen(false) }, '返回商店') },
      e('p', {}, '当前余额 ' + num(bank.current) + ' / ' + num(bank.maxGold, 999) + ' · 历史最高余额 ' + num(bank.record) + ' · 累计投入 ' + num(bank.totalPut)),
      e('div', { class: 'mz-phase-footer' },
        e(ProtocolButton, { disabled: !!busy || priv.ready || !bank.canPut, onClick: () => act('bank', { action: 'deposit', count: 1 }) }, '投入 1 源石锭'),
        e('label', { class: 'mz-filter' }, e('span', {}, '提取数量'),
          e('select', { value: Math.min(withdrawCount, Math.max(1, num(bank.withdrawMax))),
            disabled: !!busy || priv.ready || !bank.canWithdraw,
            onChange: event => setWithdrawCount(Number(event.currentTarget.value)) },
            Array.from({ length: Math.max(1, num(bank.withdrawMax)) }, (_, index) => e('option', { key: index + 1, value: index + 1 }, String(index + 1))))),
        e(ProtocolButton, { disabled: !!busy || priv.ready || !bank.canWithdraw,
          onClick: () => act('bank', { action: 'withdraw', count: Math.min(withdrawCount, num(bank.withdrawMax, 1)) }) },
          '提取源石锭 · ' + num(bank.withdrawKeyCost, 1) + ' 把钥匙')),
      arr(bank.rewards).map(reward => e('p', { key: reward.id }, (reward.unlocked ? '已解锁 · ' : '历史余额 ' + reward.threshold + ' · ') + plainDescription(reward.description)))) : null);
}
function RewardPhase({ priv, model, busy, act, library }) {
  const rewards = arr(priv.rewards), chosen = new Set(rewards.filter(reward => reward.selected).map(reward => reward.group));
  const groups = new Set(rewards.map(reward => reward.group).filter(Boolean));
  const settlement = priv.battleOutcome?.rewards;
  const autoGranted = arr(priv.battleOutcome?.autoGranted).filter(reward => num(reward.count) > 0);
  const extraGranted = autoGranted.filter(reward => !settlement || !['rogue_2_exp', 'rogue_2_gold'].includes(reward.itemId));
  const grantedName = reward => reward.name || reward.title || ({
    rogue_2_exp: '指挥经验', rogue_2_gold: '源石锭', rogue_2_population: '希望',
    rogue_2_hp: '目标生命', rogue_2_hpmax: '生命上限', rogue_2_shield: '护盾',
    rogue_2_dice: '投掷次数', rogue_2_key: '钥匙', rogue_2_pill: '改良基因', rogue_2_bigpill: '改良基因组',
  })[reward.itemId] || reward.itemId;
  const itemPicture = itemId => library?.groups?.items?.[itemId]?.path || assets.itemIcon(itemId);
  const rewardPicture = reward => {
    const ticket = arr(priv.tickets).find(ticket => same(ticket.id, reward.ticketId));
    return reward.itemId ? library?.groups?.tickets?.[reward.iconId || reward.itemId]?.path
      || library?.groups?.items?.[reward.iconId || reward.itemId]?.path || itemPicture(reward.itemId)
      : ticket ? ticketPicture(library, ticket) : null;
  };
  return e('section', { class: 'mz-phase' }, e(PhaseHeading, { index: '05', title: model.reward?.title || '风浪过后', description: groups.size > 1 ? '每类补给各选择一项，全部选择后继续探索。' : '战斗成果属于每位同行者。选择你的补给，准备进入下一段航线。' }),
    settlement ? e('div', { class: 'mz-panel', 'data-mz-battle-settlement': true },
      e('div', { class: 'mz-panel__heading' }, e('h3', {}, '战斗收益'), e(Tag, { tone: 'mint' }, '已到账')),
      e('div', { class: 'mz-result__stats' },
        e('div', { 'data-mz-granted-item': 'rogue_2_gold' },
          e(Art, { src: itemPicture('rogue_2_gold'), class: 'mz-resource-icon', alt: '' }),
          e('b', {}, '+' + num(settlement.gold)), e('span', {}, '源石锭'),
          autoGranted.filter(reward => reward.itemId === 'rogue_2_gold' && reward.sourceTitle)
            .map((reward, index) => e('small', { key: index }, reward.sourceTitle + ' +' + num(reward.count) + '（已计入）'))),
        e('div', { 'data-mz-granted-item': 'rogue_2_exp' },
          itemPicture('rogue_2_exp') ? e(Art, { src: itemPicture('rogue_2_exp'), class: 'mz-resource-icon', alt: '' }) : null,
          e('b', {}, '+' + num(settlement.exp)), e('span', {}, '指挥经验')),
        settlement.commanderAfter ? e('div', {},
          e('b', {}, 'LV.' + num(settlement.commanderBefore?.level, 1)
            + (num(settlement.commanderAfter.level) > num(settlement.commanderBefore?.level) ? ' → ' + num(settlement.commanderAfter.level) : '')),
          e('span', {}, '指挥等级 · 当前经验 ' + num(settlement.commanderAfter.exp))) : null),
      arr(settlement.levelRewards).map(reward => e('p', { key: reward.level, 'data-mz-commander-level-reward': reward.level },
        '指挥等级 ' + reward.level + '：' + [
          num(reward.populationUp) > 0 ? '希望 +' + reward.populationUp : null,
          num(reward.squadCapacityUp) > 0 ? '可携带干员 +' + reward.squadCapacityUp : null,
          num(reward.maxHpUp) > 0 ? '生命上限 +' + reward.maxHpUp : null,
        ].filter(Boolean).join(' · ')))) : null,
    extraGranted.length ? e('div', { class: 'mz-panel', 'data-mz-battle-extra-granted': true },
      e('div', { class: 'mz-panel__heading' }, e('h3', {}, '额外物资'), e(Tag, { tone: 'mint' }, '已到账')),
      e('div', { class: 'mz-result__stats' }, extraGranted.map((reward, index) =>
        e('div', { key: reward.itemId + ':' + index, 'data-mz-auto-granted-item': reward.itemId },
          itemPicture(reward.itemId) ? e(Art, { src: itemPicture(reward.itemId), class: 'mz-resource-icon', alt: '' }) : null,
          e('b', {}, '+' + num(reward.count)), e('span', {}, grantedName(reward)),
          reward.sourceTitle ? e('small', {}, reward.sourceTitle) : null)))) : null,
    rewards.length ? e('div', { class: 'mz-choice-grid mz-reward-grid' }, rewards.map(reward => {
      const used = reward.selected || !!reward.group && chosen.has(reward.group);
      return e('button', { type: 'button', class: cx('mz-route-card mz-reward-card', reward.selected && 'is-selected'), key: reward.id, disabled: !!busy || used, 'aria-pressed': !!reward.selected, onClick: () => act('reward', { rewardId: reward.id }) },
        e('span', { class: 'mz-route-card__icon' }, rewardPicture(reward) ? e(Art, { src: rewardPicture(reward), class: ['recruit', 'recruitTicket'].includes(reward.type) ? 'mz-reward-ticket-art' : 'mz-resource-icon', alt: '' }) : e(Icon, { name: ['recruit', 'recruitTicket'].includes(reward.type) ? 'users' : reward.type === 'hope' ? 'snow' : 'gift' })), e('h3', {}, reward.title), e('p', {}, plainDescription(reward.description)),
        e('span', { class: 'mz-route-card__action' }, reward.selected ? '已领取' : used ? '已选择同类补给' : '领取补给', e(Icon, { name: reward.selected ? 'check' : 'chevronRight' })));
    })) : e('div', { class: 'mz-complete' }, e(Icon, { name: 'check' }), e('h3', {}, '补给已领取'), e('p', {}, '等待全队整备完成。')));
}
export function ResultPhase({ model, result, room, player, priv, myId }) {
  const r = model.result || result || {};
  const finalPlayer = arr(r.players).find(value => same(value.playerId, myId)) || arr(result?.players).find(value => same(value.playerId, myId));
  const score = finalPlayer?.mizuki || (same(r.playerId, myId) ? r.mizuki : null) || (same(result?.playerId, myId) ? result?.mizuki : null);
  const labels = { floorsPassed: '通过层数', stepsPassed: '前进节点', normalBattles: '普通作战', eliteBattles: '紧急作战',
    bossBattles: '险路恶敌', recruits: '招募干员', itemsGained: '获得道具' };
  const health = mizukiPersonalHealth(finalPlayer || player, finalPlayer ? null : priv);
  const reasons = { ending_not_cleared: '最终首领尚未成功完成', abandoned: '本次探索已放弃', defeat: '队伍生命耗尽', victory: '探索完成' };
  return e('section', { class: 'mz-phase mz-result' }, e('div', { class: 'mz-result__mark' }, e(Icon, { name: r.victory ? 'crown' : 'shield' })), e('p', { class: 'mz-eyebrow' }, 'EXPEDITION COMPLETE'), e('h2', {}, r.ending?.name || (r.victory ? '穿越深蓝，共迎黎明' : '暂别深海')), e(Nameplate, { class: 'mz-result__nameplate', hideUncached: true, nameplate: finalPlayer?.nameplate ?? player?.nameplate }, e('b', {}, finalPlayer?.name || player?.name || '博士')), e('p', {}, plainDescription(r.ending?.desc) || reasons[r.reason] || r.reason || (r.victory ? '联合探索完成。感谢每一位并肩守线的博士。' : '本次探索已结束，积累的经验将照亮下一段旅途。')), e('div', { class: 'mz-result__stats' }, e('div', {}, e('b', {}, num(r.completedNodes, model.completedNodes)), e('span', {}, '探索节点')),
    e('div', { 'data-mz-personal-health': myId }, e('b', {}, health.life ?? '--', '/', health.maxLife ?? '--'), e('span', {}, '我的剩余生命 · 护盾 ' + (health.shield ?? '--'))),
    e('div', {}, e('b', {}, num(r.light, model.light)), e('span', {}, '剩余灯火'))),
    score ? e('div', { class: 'mz-score', 'data-mz-score': myId },
      e('div', { class: 'mz-result__stats mz-score__totals' },
        e('div', {}, e('b', {}, score.explorationScore), e('span', {}, '探索分数')),
        e('div', {}, e('b', {}, score.cellPoints), e('span', {}, '深海细胞'))),
      score.breakdown ? e('div', { class: 'mz-score__breakdown' }, Object.entries(labels).map(([key, label]) =>
        e('div', { key }, e('span', {}, label), e('span', {}, score.counters[key]), e('b', {}, '+' + score.breakdown.points[key]))),
        e('div', { class: 'mz-score__factor' }, e('span', {}, '难度倍率'), e('span', {}, '×' + score.breakdown.factor), e('b', {}, score.explorationScore))) : null) : null,
    e(Button, { primary: true, icon: 'back', onClick: () => store.set({ match: emptyMatch() }) }, room ? '返回同盟' : '返回大厅'));
}

function MissionControls({ model, mine, phase, busy, act }) {
  const [open, setOpen] = useState(false);
  const missions = arr(model.missions).filter(mission => !arr(mission.memberIds).length || mission.memberIds.some(id => same(id, mine)));
  if (!missions.length) return null;
  return e('span', {}, e(ProtocolButton, { size: 'sm', variant: 'secondary', onClick: () => setOpen(true), 'data-mz-missions-open': true }, '地区委托 · ' + missions.length),
    e(Modal, { open, onClose: () => setOpen(false), title: '地区委托', actions: e(ProtocolButton, { onClick: () => setOpen(false) }, '关闭') },
      missions.map(mission => {
        const complete = mission.status === 'completed' || mission.status === 'complete' || mission.status === 'claimable';
        const claimed = mission.status === 'claimed';
        return e('div', { class: 'mz-panel', key: mission.id || mission.missionId || mission.taskId }, e('h3', {}, mission.name),
          e('p', {}, plainDescription(mission.description)), e('p', {}, num(mission.progress) + ' / ' + num(mission.target)),
          e(ProtocolButton, { variant: complete ? 'primary' : 'secondary', disabled: !!busy || phase !== 'MIZUKI_ROUTE' || !complete,
            onClick: async () => { if (await act('missionClaim', { missionId: mission.id || mission.missionId })) setOpen(false); } }, claimed ? '奖励已领取' : complete ? '领取奖励' : '进行中'));
      })));
}

export function MizukiScreen() {
  const pub = useStore(s => s.match.public);
  const privateState = useStore(s => s.match.private);
  const result = useStore(s => s.match.result);
  const room = useStore(s => s.room);
  const me = useStore(s => s.me);
  const connection = useStore(s => s.connection);
  const chatId = useStore(s => s.matchChat.matchId);
  const spectatorState = useStore(s => s.spectator);
  const [busy, setBusy] = useState('');
  const moveQueue = useRef(null);
  if (!moveQueue.current) moveQueue.current = createMizukiPrepMoveQueue(16);
  const [movePending, setMovePending] = useState(0);
  const [pendingMoves, setPendingMoves] = useState([]);
  const [error, setError] = useState('');
  const [, setAssetVersion] = useState(0);
  const [library, setLibrary] = useState(null);
  const priv = privateState?.mizuki || {};
  const eliminated = !!priv.eliminated || priv.alive === false;
  const spectator = !!spectatorState;
  const readOnly = spectator || eliminated;
  const model = mizukiPartyModel(pub?.mizuki || {}, priv);
  const [watchFieldId, setWatchFieldId] = useState(null);
  const [enteredBattle, setEnteredBattle] = useState(null);
  const players = arr(pub?.players).filter(p => !p.left).sort((a, b) => num(a.seat) - num(b.seat));
  const myPlayer = players.find(p => same(p.playerId, me.playerId));
  const ownHealth = mizukiPersonalHealth(myPlayer, priv);
  const ownFieldId = priv.fieldId || myPlayer?.fieldId;
  const phase = result || pub?.phase === 'RESULT' ? 'RESULT' : eliminated ? 'MIZUKI_WAITING' : priv.phase || pub?.phase;
  const battleEntryKey = JSON.stringify([pub?.matchId || chatId, me.playerId, ownFieldId, model.currentNode?.id, priv.round || model.round || pub?.round, priv.completedNodes ?? model.completedNodes]);
  useEffect(() => { if (!['PREP', 'COMBAT'].includes(phase)) setEnteredBattle(null); }, [phase]);
  useEffect(() => {
    if (!pendingMoves.length || !priv.prep) return;
    const confirmed = new Set(pendingMoves.filter(move => mizukiPrepMoveApplied(priv.prep, move)).map(move => move.id));
    if (confirmed.size) setPendingMoves(current => current.filter(move => !confirmed.has(move.id)));
  }, [priv.prep, pendingMoves]);
  const online = connection.status === 'online';
  const actionSound = useMizukiUiSfx({ model, priv, phase, online, runKey: chatId, playerId: me.playerId,
    enabled: !!pub?.mizuki && !spectator });
  useEffect(() => {
    document.body.classList.add('mizuki-active');
    const styles = ['/css/mizuki.css', '/css/mizuki-hud.css', '/css/mizuki-select.css', '/css/mizuki-recruit.css', '/css/mizuki-route.css', '/css/mizuki-mobile.css'].map(href => {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = href; link.dataset.mizukiStyles = '1';
      document.head.append(link); return link;
    });
    loadMizukiLibrary().then(setLibrary);
    const off = assets.onChange(() => setAssetVersion(v => v + 1));
    assets.ready().then(() => setAssetVersion(v => v + 1)).catch(() => {});
    return () => { document.body.classList.remove('mizuki-active'); styles.forEach(link => link.remove()); off(); };
  }, []);
  // A new run starts at the opening choices: forget which floors already played their intro.
  useEffect(() => { if (['MIZUKI_SQUAD', 'MIZUKI_STRATEGY', 'MIZUKI_INITIAL_SUPPLY', 'MIZUKI_RECRUIT_GROUP'].includes(phase)) shownFloors.clear(); }, [phase]);
  useEffect(() => setError(''), [phase]);
  useEffect(() => { if (phase !== 'MIZUKI_WAITING') setWatchFieldId(null); }, [phase]);
  const act = async (kind, payload = {}) => {
    const queuedMove = kind === 'move';
    if (busy || (!queuedMove && moveQueue.current.size)) return false;
    if (!online) { setError('与服务器连接中断，请等待重连后继续。'); return false; }
    if (readOnly) { setError(eliminated ? '生命耗尽后可继续交流并观看队友探索。' : '观战状态只能查看，不能下达指令。'); return false; }
    if (queuedMove && phase !== 'PREP') { setError('仅备战阶段可以摆位。'); return false; }
    if (!queuedMove) setBusy(kind);
    setError('');
    let moveId = null, request;
    if (queuedMove) {
      moveId = requestId();
      const move = { id: moveId, uid: payload.uid, to: payload.to, dir: payload.dir };
      if (mizukiPrepMoveCanPredict(applyPendingPrepMoves(priv.prep, pendingMoves), move))
        setPendingMoves(current => [...current, move]);
      request = moveQueue.current.enqueue(() => net.request('g.mizuki.' + kind, payload));
      if (!request) {
        setPendingMoves(current => current.filter(item => item.id !== moveId));
        setError('摆位队列已满，请稍候再试。');
        return false;
      }
      setMovePending(moveQueue.current.size);
    } else request = net.request('g.mizuki.' + kind, payload);
    try {
      await request;
      actionSound(kind, payload);
      return true;
    }
    catch (err) {
      setError(describeError(err));
      if (queuedMove && moveId) setPendingMoves(current => current.filter(move => move.id !== moveId));
      return false;
    }
    finally {
      if (queuedMove) {
        setMovePending(moveQueue.current.size);
      } else setBusy('');
    }
  };
  const recallControls=e('div', {}, e(RecallControls,{model,priv,players,mine:me.playerId,phase,busy:!!busy||!online||readOnly,error,act}), e(SanCheckControls,{model,players,mine:me.playerId,busy:!!busy||!online||readOnly,act,library}), e(MissionControls, { model, mine: me.playerId, phase, busy: !!busy || !online || readOnly, act }));
  if (pub?.mizuki && phase === 'PREP' && !readOnly && !priv.ready && enteredBattle !== battleEntryKey) return e(MizukiBattleLineupScreen, { key: battleEntryKey, model, priv, busy, online, act, portraitFor: unit => assets.portrait(unit.charId) || picture(unit), onStart: () => setEnteredBattle(battleEntryKey) });
  if (pub?.mizuki && (phase === 'PREP' || phase === 'COMBAT')) return e(NativeMizukiBattle, { key: model.currentNode?.id || 'battle', pub, model, priv, players, myId: me.playerId, ownFieldId, online, phase, busy: movePending > 0 ? 'move' : busy, act, pendingMoves, tileReason: mizukiTileReason, error, onClearError: () => setError(''), connection, room, me, chatId, spectator, readOnly, expeditionControls:recallControls });
  if (pub?.mizuki && phase === 'MIZUKI_WAITING' && watchFieldId && mizukiWatchableFields(model, priv.partyId).some(field => same(field.fieldId, watchFieldId))) return e(NativeMizukiBattle, { key: 'rendezvous:' + watchFieldId, pub, model, priv, players, myId: me.playerId, ownFieldId, watchFieldId, onStopWatching: () => setWatchFieldId(null), online, phase: 'COMBAT', busy: false, act, error, onClearError: () => setError(''), connection, room, me, chatId, spectator, readOnly: true, expeditionControls:recallControls });
  let content;
  const disabled = busy || (!online || readOnly ? 'disabled' : '');
  const isHost = same(model.hostId || room?.hostId || players[0]?.playerId, me.playerId);
  if (pub?.mizuki && phase === 'MIZUKI_SQUAD') return e(SquadScreen, { model, priv, players, mine: me.playerId, busy: disabled, act, library, ownHealth });
  if (pub?.mizuki && phase === 'MIZUKI_RECRUIT') return e(RecruitScreen, { model, priv, player: myPlayer, busy: disabled, online, act, library, ownHealth });
  if (pub?.mizuki && phase === 'MIZUKI_ROUTE') return e(RouteStageScreen, { model, priv, players, mine: me.playerId, busy: disabled, online, act, library, ownHealth, error, onClearError: () => setError(''), extras: e('div', {}, recallControls, isHost && !spectator && model.exploration?.available !== true ? e(DungeonImport, { busy: disabled, act, isHost: true }) : null) });
  if (pub?.mizuki && phase === 'MIZUKI_STRATEGY') return e(StrategyScreen, { model, priv, players, mine: me.playerId, busy: disabled, act, ownHealth });
  if (pub?.mizuki && phase === 'MIZUKI_INITIAL_SUPPLY') return e(InitialSupplyScreen, { model, priv, players, mine: me.playerId, busy: disabled, act, library, ownHealth });
  if (pub?.mizuki && phase === 'MIZUKI_RECRUIT_GROUP') return e(RecruitGroupScreen, { model, priv, players, mine: me.playerId, busy: disabled, act, library, ownHealth });
  if (!pub?.mizuki) content = e('div', { class: 'mz-empty mz-loading' }, e(Spinner, { size: 'lg', label: 'ENTERING THE ABYSS' }), e('h2', {}, '正在建立深海联络…'), e('p', {}, '探索状态与作战队列即将同步。'));
  else if (phase === 'MIZUKI_SQUAD') content = e(SquadPhase, { model, players, mine: me.playerId, busy: disabled, act, library, isHost });
  else if (phase === 'MIZUKI_STRATEGY') content = e(StrategyPhase, { model, priv, players, mine: me.playerId, busy: disabled, act, library });
  else if (phase === 'MIZUKI_RECRUIT_GROUP') content = e(RecruitGroupPhase, { model, priv, players, busy: disabled, act, library });
  else if (phase === 'MIZUKI_ROUTE') content = e(ExplorationRoutePhase, { model, players, mine: me.playerId, busy: disabled, act, library, isHost });
  else if (phase === 'MIZUKI_EVENT') content = e(EventPhase, { model, players, mine: me.playerId, busy: disabled, act });
  else if (phase === 'MIZUKI_RECRUIT') content = e(RecruitPhase, { priv, busy: disabled, act, library });
  else if (phase === 'MIZUKI_SHOP') content = e(ShopPhase, { model, priv, busy: disabled, act, library });
  else if (phase === 'MIZUKI_REWARD') content = e(RewardPhase, { model, priv, busy: disabled, act, library });
  else if (phase === 'MIZUKI_WAITING') content = e(WaitingPhase, { model, priv, players, onWatch: setWatchFieldId });
  else if (phase === 'RESULT') content = e(ResultPhase, { model, result, room, player: myPlayer, priv, myId: me.playerId });
  else content = e('div', { class: 'mz-empty' }, e(Spinner, { size: 'sm' }), '正在同步探索阶段…');
  return e('main', { class: cx('screen mz-screen', phase === 'MIZUKI_EVENT' && 'mz-screen--event', phase === 'RESULT' && 'mz-screen--result', (phase === 'PREP' || phase === 'COMBAT') && 'mz-screen--battle', (phase === 'MIZUKI_SQUAD' || phase === 'MIZUKI_STRATEGY' || phase === 'MIZUKI_RECRUIT_GROUP') && 'mz-screen--selection'), 'aria-label': MIZUKI_TITLE, style: nativeStyles(library) },
    e('div', { class: 'mz-abyss', 'aria-hidden': true }),
    e('header', { class: 'mz-header' }, e('div', { class: 'mz-brand' }, e('div', {}, e('p', { class: 'mz-eyebrow' }, 'MIZUKI & CAERULA ARBOR'), e('h1', {}, '水月与深蓝之树'), e('span', {}, '联合探索 · ' + players.length + '人协作 · 备战摆位 · 自动作战'))),
      e('div', { class: 'mz-resources' }, e('div', { class: 'mz-resource mz-resource--life', 'data-mz-personal-health': me.playerId, 'aria-label': '我的' + mizukiHealthText(ownHealth) }, e(Icon, { name: 'shield' }), e('span', {}, '我的生命', e('b', {}, ownHealth.life ?? '--', e('small', {}, '/' + (ownHealth.maxLife ?? '--'))), e('small', {}, '护盾 ' + (ownHealth.shield ?? '--')))), e('div', { class: 'mz-resource' }, e(Icon, { name: 'snow' }), e('span', {}, '团队灯火', e('b', {}, num(model.light)))), e('div',{class:'mz-resource'},e(Art,{src:library?.groups?.ui?.DICE?.path,alt:'',class:'mz-resource-icon'}),e('span',{},'团队骰子',e('b',{},num(model.dice?.count)))),e('div',{class:'mz-resource'},e(Icon,{name:'gift'}),e('span',{},'团队藏品',e('b',{},arr(model.collectibles).length))), e('div', { class: 'mz-resource mz-resource--gold' }, library?.groups?.items?.rogue_2_gold?.path ? e(Art, { src: library.groups.items.rogue_2_gold.path, alt: '', class: 'mz-resource-icon' }) : e(Icon, { name: 'box' }), e('span', {}, '我的源石锭', e('b', {}, num(priv.gold)))), e('div', { class: 'mz-resource' }, e(Icon, { name: 'plus' }), e('span', {}, '我的希望', e('b', {}, num(priv.hope))))),
      e('div', { class: 'mz-header__status' }, e(Tag, { tone: online ? 'mint' : 'danger' }, e(Icon, { name: online ? 'signal' : 'wifiOff' }), online ? '联络正常' : '正在重连'), e('small', {}, Number.isFinite(connection.ping) ? connection.ping + ' ms' : 'SERVER / SYNC'), e('span', { class: 'mz-chat-slot', 'data-mz-chat-slot': true, 'aria-hidden': true }))),
    phase === 'MIZUKI_ROUTE' ? null : e('div', { class: 'mz-progress' }, e('span', {}, '深度 ' + String(num(model.floor ?? (model.exploration?.floor?.index != null ? Number(model.exploration.floor.index) + 1 : 1), 1)).padStart(2, '0')), e('div', {}, Number.isFinite(model.totalNodes) && model.totalNodes > 0 ? e('i', { style: { width: percent(model.completedNodes, model.totalNodes) + '%' } }) : null), e('span', {}, num(model.completedNodes) + (Number.isFinite(model.totalNodes) && model.totalNodes > 0 ? ' / ' + model.totalNodes : '') + ' 节点'), e(Tag, {}, PHASE_NAMES[phase] || '建立联络')),
    (phase === 'MIZUKI_ROUTE' ? null : e('div',{class:'mz-phase-footer'},recallControls,e(Tag,{},'N'+num(model.difficultyGrade)))),
    phase !== 'MIZUKI_ROUTE' && model.lightEffect ? e('div', { class: 'mz-light-effect' }, model.lightEffect) : null,
    !online ? e('div', { class: 'mz-connection-banner', role: 'status' }, e(Icon, { name: 'wifiOff' }), '联络中断，指令暂时锁定。正在自动恢复连接，重连后将同步当前进度。') : null,
    model.paused ? e('div', { class: 'mz-connection-banner', role: 'status' }, e(Icon, { name: 'pause' }), '探索已暂停，等待博士重新连接。') : null,
    error ? e('div', { class: 'mz-error', role: 'alert' }, e(Icon, { name: 'warn' }), e('span', {}, error), e('button', { type: 'button', onClick: () => setError(''), 'aria-label': '关闭提示' }, e(Icon, { name: 'x' }))) : null,
    e('div', { class: 'mz-content' }, e('div', { class: 'mz-main' }, phase === 'MIZUKI_SQUAD' && pub?.mizuki ? e(DungeonImport, { busy: disabled, act, isHost }) : null, content), phase !== 'PREP' && phase !== 'COMBAT' && phase !== 'RESULT' && phase !== 'MIZUKI_SQUAD' && phase !== 'MIZUKI_STRATEGY' && phase !== 'MIZUKI_RECRUIT_GROUP' ? e('aside', { class: 'mz-expedition-aside' }, e('div', { class: 'mz-ocean-portrait' }, e(Art, { record: { charId: 'char_437_mizuki', name: '水月' }, portrait: true }), e('div', {}, e('p', { class: 'mz-eyebrow' }, 'INTO THE BLUE'), e('p', {}, '联合探索', e('br'), '准备下潜'))), e(TeamPanel, { players, myId: me.playerId, fieldId: ownFieldId, ready: priv.ready, priv }), e('p', { class: 'mz-prototype-note' }, '联合探索 · 卫戍协议作战', e('br'), '每位博士仅能指挥自己的干员')) : null),
    e('footer', { class: 'mz-footer' }, e('span', {}, 'STRONGHOLD PROTOCOL / MIZUKI EXPEDITION'), e('span', {}, '非官方同人娱乐模式 · 服务器权威同步')));
}
