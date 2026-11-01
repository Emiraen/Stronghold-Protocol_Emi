// Route map, formation (编队) and operator-selection pages in the native 1920x1080 style.
// Presentation only: votes, route start and lineup changes go through the same server actions
// (`route`, `routeStart`, `splitRequest`, `splitDecide`, `lineup`, `loadout`, `equip`, `dismiss`) the legacy screen used.
// Fields the server does not send are not rendered.
import { h, Fragment, Modal, Button as ProtocolButton } from '../ui/components.js';
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { data } from '../data.js';
import { mizukiAssets as assets, MizukiUnitThumb as UnitThumb } from '../mizukiAssets.js';
import { MizukiStage, MizukiTopBar, MizukiBottomBar, hudBg, hudUrl } from './mizukiHud.js';
import { LightTopLeft, OperatorCard, ProfessionFilter, operatorProfession } from './mizukiRecruit.js';
import { useRosterTools, RosterDialogs, RosterSidebar, EquipmentBar, moduleIcon } from './mizukiRoster.js';
import { requestMizukiExit } from './mizukiExit.js';
import { RichText } from '../ui/gameComponents.js';

const e = (type, props, ...children) => h(type, props, ...children.flat(3));
const cx = (...parts) => parts.filter(Boolean).join(' ');
const arr = value => Array.isArray(value) ? value : [];
const same = (a, b) => a != null && b != null && String(a) === String(b);
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

const TYPE_NAMES = {
  BATTLE_NORMAL: '作战', BATTLE_ELITE: '紧急作战', BATTLE_BOSS: '险路恶敌', BATTLE_SHOP: '诡意行商', BATTLE_SAVAGE: '作战',
  INCIDENT: '不期而遇', SHOP: '诡意行商', REST: '安全的角落', TREASURE: '宝藏', ENTERTAINMENT: '兴致盎然', WISH: '得偿所愿',
  EXPEDITION: '紧急运输', SACRIFICE: '风雨际会', EVACUATE: '撤离', MISSION: '地区委托', PORTAL: '误入奇境', UNKNOWN: '迷雾重重',
};

const TrashIcon = () => e('svg', { viewBox: '0 0 24 24', width: '1em', height: '1em', 'aria-hidden': true, fill: 'currentColor' }, e('path', { d: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z' }));
const SearchIcon = () => e('svg', { viewBox: '0 0 48 48', width: '1em', height: '1em', 'aria-hidden': true, fill: 'none', stroke: '#fff', 'stroke-width': 5 }, e('circle', { cx: 20, cy: 20, r: 13 }), e('path', { d: 'M30 30 L44 44', 'stroke-linecap': 'round' }));
const PersonDot = ({ on }) => e('svg', { viewBox: '0 0 20 20', class: cx('mzv-dot', on && 'is-on'), 'aria-hidden': true }, e('circle', { cx: 10, cy: 5.5, r: 4 }), e('path', { d: 'M2 19 C2 11 18 11 18 19 Z' }));

/** One operator card with the data the server sends: level, selected skill / module, elite mark, worn equipment. */
function unitCard(unit, portraitFor, tools, extra = {}) {
  const skill = arr(unit.skills).find(value => num(value.index) === num(unit.skillIndex, 0));
  const skillIcon = skill ? assets.skillIcon(skill.iconId || skill.skillId) : null;
  const loadout = unit.loadout || unit.loadoutOptions || {};
  const moduleId = loadout.moduleId || unit.moduleId;
  const option = moduleId && moduleId !== 'none' ? (loadout.selectedModule || arr(loadout.modules).find(value => value.id === moduleId) || { id: moduleId, typeName: unit.moduleType }) : null;
  const worn = tools ? tools.equipped(unit) : [];
  return e(OperatorCard, { key: unit.uid, unit, portrait: portraitFor(unit), rarity: unit.rarity,
    elite: Number.isInteger(unit.formStatus?.phase) ? unit.formStatus.phase : unit.promotion ? 2 : 1, skillIcon, moduleIcon: option ? moduleIcon(option) : null,
    tag: unit.temporary || unit.isTemporary || unit.temp ? '临时招募' : null, ...extra },
  worn.length ? e('span', { class: 'mzr-card__gear' }, worn.map(item => e(UnitThumb, { key: item.uid, kind: 'item', id: item.id, size: 'sm', showTier: false }))) : null);
}

/* ---------------------------------------------------------------- route map */

let collectibleCatalogPromise;
function collectibleCatalog() {
  if (!collectibleCatalogPromise) collectibleCatalogPromise = Promise.all([
    fetch('/data/mizuki/rogue2.json').then(response => { if (!response.ok) throw Error('收藏品资料暂时无法读取'); return response.json(); }),
    fetch('/assets/mizuki/library/manifest.json').then(response => { if (!response.ok) throw Error('收藏品图像目录暂时无法读取'); return response.json(); }),
  ]).then(([records, library]) => ({ items: records.rawTopic.items, images: library.groups.items }))
    .catch(error => { collectibleCatalogPromise = null; throw error; });
  return collectibleCatalogPromise;
}

function CollectiblesStrip({ ids, onOpen }) {
  const [catalog, setCatalog] = useState(null);
  const counts = new Map();
  for (const value of arr(ids)) {
    const id = typeof value === 'string' ? value : value.id;
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  useEffect(() => {
    if (!counts.size || catalog) return;
    let active = true;
    collectibleCatalog().then(value => { if (active) setCatalog(value); }).catch(() => {});
    return () => { active = false; };
  }, [counts.size, catalog]);
  if (!counts.size) return null;
  return e('div', { class: 'mzv-collectibles-strip', role: 'group', 'aria-label': '已获得收藏品，可横向滚动', 'data-mz-collectibles-strip': true },
    [...counts].map(([id, count]) => {
      const item = catalog?.items[id], image = catalog?.images[item?.iconId || id]?.path || assets.itemIcon(id);
      return e('button', { type: 'button', key: id, class: 'mzv-collectibles-strip__item',
        'data-mz-owned-collectible': id, 'aria-label': (item?.name || '收藏品') + (count > 1 ? ' ×' + count : ''),
        title: item ? item.name + '\n' + (item.usage || item.description || '').replace(/<[^>]+>/g, '') : '查看收藏品', onClick: onOpen },
        image ? e('img', { src: image, alt: '', loading: 'lazy', draggable: false })
          : e('span', { class: 'mzv-collectibles-strip__icon', style: hudBg('cmn2-icon_relic'), 'aria-hidden': true }),
        count > 1 ? e('small', {}, '×' + count) : null);
    }));
}

function CollectiblesDialog({ open, ids, onClose }) {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open || catalog) return;
    let active = true; setError('');
    collectibleCatalog().then(value => { if (active) setCatalog(value); })
      .catch(value => { if (active) setError(value.message); });
    return () => { active = false; };
  }, [open, catalog]);
  const counts = new Map();
  for (const value of arr(ids)) { const id = typeof value === 'string' ? value : value.id; if (id) counts.set(id, (counts.get(id) || 0) + 1); }
  return e(Modal, { open, onClose, class: 'mz-native-roster-modal mz-native-roster-library', width: 'min(820px, 94vw)',
    title: '全队收藏品', micro: 'COLLECTION', actions: e(ProtocolButton, { onClick: onClose }, '关闭') },
    error ? e('p', { role: 'alert' }, error) : !catalog ? e('p', { role: 'status' }, '正在读取收藏品…')
      : !counts.size ? e('p', {}, '尚未获得收藏品') : [...counts].map(([id, count]) => {
        const item = catalog.items[id], image = catalog.images[item?.iconId || id]?.path;
        return e('section', { key: id, class: 'mzv-offer__row', 'data-mz-collectible': id, style: { marginBottom: '18px', alignItems: 'flex-start' } },
          image ? e('img', { src: image, alt: '', loading: 'lazy', draggable: false, style: { width: '82px', height: '82px', objectFit: 'contain', flex: 'none' } }) : null,
          e('div', {}, e('h3', {}, item?.name || id, count > 1 ? ' ×' + count : ''),
            e(RichText, { as: 'p', text: item?.usage || item?.description || '' })));
      }));
}

function StageIntel({ stageId }) {
  const [open, setOpen] = useState(false);
  const stage = stageId ? data.lookup('stages', stageId) : null;
  if (!stage) return null;
  return e('div', { class: 'mzv-intel' },
    e('button', { type: 'button', class: 'mzv-intel__card', onClick: () => setOpen(true), 'data-mz-intel': 'enemies' }, e('span', {}, '敌方情报'), e(SearchIcon)),
    e(Modal, { open, onClose: () => setOpen(false), title: stage.name || '敌方情报', micro: 'INTEL', actions: e(ProtocolButton, { onClick: () => setOpen(false) }, '关闭') },
      stage.description || stage.desc ? e('p', {}, stage.description || stage.desc) : e('p', {}, stage.name || stageId)));
}

function NodePanel({ node, artwork, children }) {
  const kind = node.revealed === false ? null : TYPE_NAMES[node.type];
  const name = node.revealed === false ? '迷雾重重' : (node.available || node.current || node.completed ? node.stageName : null) || node.title || kind || '';
  const desc = node.revealed === false ? '' : node.description || '';
  return e('aside', { class: 'mzv-panel', 'data-mz-node-panel': node.id },
    e('div', { class: 'mzv-panel__head' }, artwork.icon ? e('img', { class: 'mzv-panel__icon', src: artwork.icon, alt: '', draggable: false }) : null,
      kind && kind !== name ? e('span', { class: 'mzv-panel__kind' }, kind) : null, e('h2', { class: kind && kind !== name ? '' : 'is-solo' }, name)),
    desc ? e('i', { class: 'mzv-panel__tag' }, 'INFO.') : null,
    desc ? e('p', { class: 'mzv-panel__desc' }, desc) : null,
    children);
}

function MapPage(props) {
  const { model, players, mine, busy, act, top, map, extras, intro, error, onClearError, backdrop, artworkFor, onLineup, onCollectibles, operators, lineupCount, capacity } = props;
  const expedition = model.expedition || {}, parties = arr(expedition.parties);
  const party = parties.find(value => arr(value.memberIds).some(id => same(id, mine)));
  const leader = same(expedition.leaderId || model.hostId || players[0]?.playerId, mine);
  const members = party ? players.filter(player => arr(party.memberIds).includes(player.playerId)) : players;
  const votes = party?.votes || model.votes || {}, chosen = votes[mine];
  const pending = arr(expedition.requests).filter(value => value.status === 'pending');
  const allVoted = members.length > 0 && members.every(player => votes[player.playerId] != null);
  const node = chosen == null ? null : arr(model.exploration?.nodes).find(value => same(value.id, chosen));
  const nodeName = id => {
    const value = arr(model.route).find(item => same(item.id, id)) || arr(model.exploration?.nodes).find(item => same(item.id, id));
    return value?.revealed === false ? '迷雾重重' : (value?.available || value?.current || value?.completed ? value.stageName : null) || value?.title || id;
  };
  const blocked = !!busy || !allVoted || pending.length > 0 || !!party?.recallHold || !!model.sanCheck;
  const note = model.sanCheck ? '请先完成层间检定' : party?.recallHold ? '等待召回队友集合' : pending.length ? '请先处理分开行动申请'
    : '本队 ' + members.length + ' 人 · ' + Object.keys(votes).length + ' 票';
  const ready = e('div', { class: 'mzv-go-wrap' },
    leader ? e('button', { type: 'button', class: 'mzv-go', disabled: blocked, 'data-mz-confirm': 'routeStart', onClick: () => act('routeStart') },
      e('small', {}, 'READY TO'), e('b', {}, '出发前往'))
      : e('div', { class: 'mzv-go is-wait' }, e('small', {}, 'WAITING'), e('b', {}, '等待领队')),
    e('span', { class: 'mzv-go__note' }, note),
    !leader && members.length > 1 ? e('button', { type: 'button', class: 'mzv-split', disabled: !!busy || chosen == null || pending.some(request => same(request.playerId, mine)), onClick: () => act('splitRequest', { nodeId: chosen }) }, '申请分开行动') : null);
  return e(MizukiStage, { class: 'mzv-page', scheme: 'dark' },
    e('div', { class: 'mzh-backdrop mzh-backdrop--map', style: backdrop ? { backgroundImage: 'url(' + JSON.stringify(backdrop) + ')' } : undefined }),
    map,
    e(MizukiTopBar, { ...top, title: model.exploration?.floor?.name || '', info: true }),
    node ? e(NodePanel, { node, artwork: artworkFor(node) }, ready) : null,
    node ? e(StageIntel, { stageId: node.stageId }) : null,
    pending.length ? e('div', { class: 'mzv-requests' }, pending.map(request => e('div', { key: request.id },
      e('p', {}, (players.find(player => same(player.playerId, request.playerId))?.name || request.playerId) + ' 申请前往：' + nodeName(request.nodeId)),
      leader ? e('span', {}, e('button', { type: 'button', disabled: !!busy, onClick: () => act('splitDecide', { requestId: request.id, approve: true }) }, '批准'),
        e('button', { type: 'button', disabled: !!busy, onClick: () => act('splitDecide', { requestId: request.id, approve: false }) }, '保留本队')) : e('small', {}, '等待领队审批')))) : null,
    e('div', { class: 'mzv-extras' }, extras),
    intro,
    error ? e('div', { class: 'mzv-error', role: 'alert' }, e('span', {}, error), e('button', { type: 'button', onClick: onClearError, 'aria-label': '关闭提示' }, '×')) : null,
    e(MizukiBottomBar, { dice: model.dice?.count, showCollectibles: true, collectibles: arr(model.collectibles).length, onCollectibles,
      children: e(CollectiblesStrip, { ids: model.collectibles, onOpen: onCollectibles }), showOperators: true, operators, operatorsSide: 'right', onOperators: onLineup,
      right: e('button', { type: 'button', class: 'mzv-formation', 'data-mz-formation': true, onClick: onLineup },
        e('span', { class: 'mzv-formation__label' }, e('i', { style: hudBg('cmn1-img_btn_info') }), e('span', {}, '编队')),
        e('span', { class: 'mzv-dots', 'aria-label': '编队 ' + lineupCount + '/' + capacity }, Array.from({ length: Math.min(16, capacity) }, (_, index) => e(PersonDot, { key: index, on: index < lineupCount })))) }));
}

/* ----------------------------------------------------------- formation page */

const SLOT_POSITIONS = [[155, 208], [155, 375], [155, 542], [155, 709], [697, 120], [697, 287], [697, 454], [697, 621], [697, 788], [1275, 208], [1275, 375], [1275, 542], [1275, 709]];

function LineupPage({ tools, busy, act, portraitFor, onBack, onEdit, onStart }) {
  const { roster, lineup, capacity, selectedItem, assignItem, acceptEquipmentDrag, dropEquipment, setSelectedItemUid } = tools;
  const units = lineup.map(uid => roster.find(unit => same(unit.uid, uid))).filter(Boolean);
  return e(MizukiStage, { class: 'mzv-page mzv-lineup', scheme: 'light' },
    e('div', { class: 'mzh-backdrop mzh-backdrop--snow' }),
    e(LightTopLeft, { onBack, onExit: requestMizukiExit }),
    e('button', { type: 'button', class: 'mzv-quick', disabled: !!busy || tools.locked, onClick: () => onEdit(null), 'data-mz-quick': true }, e('span', {}, '快捷编队')),
    e('button', { type: 'button', class: 'mzv-trash', 'aria-label': '清空编队', disabled: !!busy || tools.locked || !lineup.length, onClick: () => act('lineup', { uids: [] }) }, e(TrashIcon)),
    SLOT_POSITIONS.map(([left, top], index) => {
      const unit = units[index], active = index < capacity, style = { left: left + 'px', top: top + 'px' };
      if (unit) return unitCard(unit, portraitFor, tools, { style, disabled: !!busy, 'data-mz-slot': index, selected: false,
        onDragOver: tools.acceptEquipmentDrag, onDrop: event => tools.dropEquipment(event, unit),
        onClick: () => { if (selectedItem) { assignItem(selectedItem, unit); setSelectedItemUid(null); } else onEdit(unit.uid); } });
      return e('button', { key: 'slot' + index, type: 'button', class: cx('mzv-slot', active && 'is-open'), style, disabled: !active || !!busy || tools.locked, 'aria-label': active ? '添加干员' : '未开放', 'data-mz-slot': index, onClick: () => onEdit(null) }, active ? e('span', { class: 'mzv-slot__plus' }) : null);
    }),
    e('div', { class: 'mzv-foot' },
      e('span', { class: 'mzv-foot__label', style: hudBg('cmn1-squad_back') }, '编队上限'),
      e('span', { class: 'mzv-foot__count' }, lineup.length + '/' + capacity),
      e(EquipmentBar, { tools }),
      e('button', { type: 'button', class: 'mzv-start', 'aria-label': '开始行动', 'data-mz-lineup-done': true, disabled: !!busy || tools.locked, onClick: onStart, style: { backgroundImage: 'url(' + hudUrl('cmn1-start_battle') + ')' } })),
    e(RosterDialogs, { tools }));
}

/* ---------------------------------------------------------- selection page */

function SelectPage({ tools, busy, act, portraitFor, startUid, onBack, onDone }) {
  const { roster, lineup, capacity } = tools;
  const [professions, setProfessions] = useState([]);
  const visibleRoster = roster.filter(unit => !professions.length || professions.includes(operatorProfession(unit)));
  const [picked, setPicked] = useState(() => [...lineup]);
  const [focus, setFocus] = useState(startUid ?? lineup[0] ?? roster[0]?.uid ?? null);
  const focused = roster.find(unit => same(unit.uid, focus));
  const toggle = unit => {
    setFocus(unit.uid);
    setPicked(previous => previous.some(uid => same(uid, unit.uid)) ? previous.filter(uid => !same(uid, unit.uid)) : previous.length >= capacity ? previous : [...previous, unit.uid]);
  };
  const confirm = async () => { if (await act('lineup', { uids: picked })) onDone(); };
  return e(MizukiStage, { class: 'mzv-page mzv-select', scheme: 'light' },
    e('div', { class: 'mzh-backdrop mzh-backdrop--snow' }),
    e(RosterSidebar, { unit: focused, tools }),
    e(LightTopLeft, { onBack, onExit: requestMizukiExit }),
    e('div', { class: 'mzr-grid', role: 'list' }, visibleRoster.map((unit, index) => {
      const order = picked.findIndex(uid => same(uid, unit.uid)) + 1;
      return unitCard(unit, portraitFor, tools, { selected: order > 0, disabled: !!busy || tools.locked, order: order || undefined, onClick: () => toggle(unit),
        style: { left: 80 + Math.floor(index / 4) * 527 + 'px', top: (index % 4) * 185 + 48 + 'px' } });
    })),
    e(ProfessionFilter, { value: professions, onChange: setProfessions, disabled: !!busy || tools.locked }),
    e(MizukiBottomBar, { showDice: false, showCollectibles: false, showOperators: false, right: e('div', { class: 'mzr-actions mzv-actions' },
      e('button', { type: 'button', class: 'mzr-giveup mzv-clear', disabled: !!busy || tools.locked || !picked.length, onClick: () => setPicked([]), 'data-mz-clear': true }, e(TrashIcon), '清空选择'),
      e('button', { type: 'button', class: 'mzr-confirm', disabled: !!busy || tools.locked, onClick: confirm, 'data-mz-confirm': 'lineup' }, e('i', {}), '确认')) }),
    e(RosterDialogs, { tools }));
}

/* -------------------------------------------------------------------- route */

/** Reuse the same formation pages before each player's newly entered battle. */
export function MizukiBattleLineupScreen({ model, priv, busy, online, act, portraitFor, onStart }) {
  const [editing, setEditing] = useState(false), [startUid, setStartUid] = useState(null);
  const tools = useRosterTools({ model, priv, phase: 'PREP', busy, online, act });
  return editing
    ? e(SelectPage, { tools, busy, act, portraitFor, startUid, onBack: () => setEditing(false), onDone: () => setEditing(false) })
    : e(LineupPage, { tools, busy, act, portraitFor, onBack: onStart, onStart, onEdit: uid => { setStartUid(uid); setEditing(true); } });
}

export function RouteScreen(props) {
  const { model, priv, busy, act, portraitFor, online = true } = props;
  const [view, setView] = useState('map');
  const [startUid, setStartUid] = useState(null);
  const [collectiblesOpen, setCollectiblesOpen] = useState(false);
  const tools = useRosterTools({ model, priv, phase: 'MIZUKI_ROUTE', busy, online, act });
  useEffect(() => { if (view !== 'map' && priv.ready) setView('map'); }, [priv.ready]);
  const onCollectibles = () => setCollectiblesOpen(true);
  const page = view === 'select' ? e(SelectPage, { tools, busy, act, portraitFor, startUid, onBack: () => setView('lineup'), onDone: () => setView('lineup') })
    : view === 'lineup' ? e(LineupPage, { tools, busy, act, portraitFor, onBack: () => setView('map'), onStart: () => setView('map'), onEdit: uid => { setStartUid(uid); setView('select'); } })
      : e(MapPage, { ...props, onCollectibles, operators: tools.roster.length, lineupCount: tools.lineup.length, capacity: tools.capacity, onLineup: () => setView('lineup') });
  return e(Fragment, {}, page, e(CollectiblesDialog, { open: collectiblesOpen, ids: model.collectibles, onClose: () => setCollectiblesOpen(false) }));
}
