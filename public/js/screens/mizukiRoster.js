// Roster tools for the formation pages: loadout, equipment and dismissal.
// Same server actions and rules as the legacy 编队整备 panel (`loadout`, `equip`, `equipmentPick`, `dismiss`).
// Anything the server does not send is simply not rendered.
import { h, Fragment, Button as ProtocolButton, Modal } from '../ui/components.js';
import { useState } from '../../vendor/hooks.module.js';
import { data } from '../data.js';
import { mizukiAssets as assets, MizukiUnitThumb as UnitThumb } from '../mizukiAssets.js';
import { RichText } from '../ui/gameComponents.js';
import { requestId } from '../requestId.js';
import { EquipReplaceDialog } from '../ui/equipReplace.js';
import { hudBg } from './mizukiHud.js';
import { OperatorSidebar, PROF_NAMES } from './mizukiRecruit.js';
import { attackInterval, rangeGridBox, tileKey } from '../ui/gameLogic.js';
import { attackRangeGrid } from '../../../shared/loadoutRecord.js';

const e = (type, props, ...children) => h(type, props, ...children.flat(3));
const cx = (...parts) => parts.filter(Boolean).join(' ');
const arr = value => Array.isArray(value) ? value : [];
const same = (a, b) => a != null && b != null && String(a) === String(b);
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const OUTSIDE_COMBAT = ['PREP', 'MIZUKI_ROUTE', 'MIZUKI_REWARD', 'MIZUKI_EVENT', 'MIZUKI_SHOP', 'MIZUKI_RECRUIT'];
const STATS = [['生命', 'maxHp'], ['攻击', 'atk'], ['防御', 'def'], ['法抗', 'res'], ['费用', 'cost'], ['阻挡', 'blockCnt']];

export const moduleIcon = option => option?.iconPath || (option && option.id !== 'none' && option.typeName
  ? '/assets/mizuki/native-ui-roster/modules/' + option.typeName.toLowerCase().replace(/[αβγδ]/g, value => ({ 'α': 'a', 'β': 'b', 'γ': 'g', 'δ': 'd' })[value]) + '.png' : null);

export function useRosterTools({ model, priv, phase, busy, online = true, act }) {
  const roster = arr(priv.roster).filter(unit => !unit.isToken);
  const capacity = Math.max(0, num(priv.squadCapacity, num(model.squadCapacity, 6)));
  const lineup = arr(priv.lineup).filter(uid => roster.some(unit => same(unit.uid, uid)));
  const rules = priv.equipmentRules || {};
  const inventory = arr(priv.equipment?.inventory);
  const offers = arr(priv.equipmentOffers);
  const [selectedItemUid, setSelectedItemUid] = useState(null);
  const [dragItemUid, setDragItemUid] = useState(null);
  const [replace, setReplace] = useState(null);
  const [dismiss, setDismiss] = useState(null);
  const [offersOpen, setOffersOpen] = useState(false);
  const itemRecord = item => ({ ...data.lookup('items', item?.id), ...item });
  const getItem = id => {
    const enriched = [...inventory, ...arr(priv.equipment?.equipped).flatMap(row => arr(row.items))].find(item => item.id === id);
    const rec = data.lookup('items', id);
    return rec ? { ...rec, ...enriched, desc: enriched?.description || rec.desc } : enriched;
  };
  const equipped = unit => arr(priv.equipment?.equipped).find(row => same(row.uid, unit.uid))?.items || arr(unit.items);
  const outsideCombat = OUTSIDE_COMBAT.includes(phase);
  const locked = !!busy || !online || !outsideCombat || !!priv.ready || !!model.sanCheck || !!priv.eliminated || priv.alive === false;
  const equipmentLocked = locked || !rules.enabled;
  const eligible = priv.dismissal ? !!priv.dismissal.enabled : OUTSIDE_COMBAT.includes(phase) && phase !== 'PREP' || phase === 'PREP' && num(priv.completedNodes, model.completedNodes) > 0;
  const selectedItem = inventory.find(item => same(item.uid, selectedItemUid)) || null;
  const selectedRecord = selectedItem ? itemRecord(selectedItem) : null;
  const consumable = !!selectedRecord && (selectedRecord.consumable || String(selectedRecord.effectKind || selectedRecord.kind).startsWith('consume_on_equip'));

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
      setReplace({ targetUid: unit.uid, targetId: unit.chessId || unit.operatorId, targetName: unit.name, golden: !!unit.promotion,
        item: { ...item, name: record.name || item.id },
        options: items.filter(value => replaceUid == null || same(value.uid, replaceUid)).map(value => ({ ...value, name: getItem(value.id)?.name || value.id })) });
    } else void equip(item, unit);
  };
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
    if (item) assignItem(item, unit, replaceUid);
  };
  const changeLoadout = (unit, skillIndex, moduleId) => { if (!locked && unit) void act('loadout', { uid: unit.uid, skillIndex, moduleId }); };
  const finish = async () => { if (!locked && eligible && dismiss && await act('dismiss', { uid: dismiss.uid, requestId: requestId() })) setDismiss(null); };
  const pick = async (offer, choice) => {
    if (equipmentLocked) return;
    await act('equipmentPick', { offerId: offer.id,
      ...(offer.kind === 'item' ? { itemId: choice.itemId || choice.id } : { operatorId: choice.operatorId || choice.id }), requestId: requestId() });
  };
  return { roster, capacity, lineup, rules, inventory, offers, itemRecord, getItem, equipped, locked, equipmentLocked, eligible,
    selectedItem, selectedRecord, consumable, setSelectedItemUid, dragItemUid, setDragItemUid, replace, setReplace, dismiss, setDismiss,
    offersOpen, setOffersOpen, equip, assignItem, acceptEquipmentDrag, dropEquipment, changeLoadout, finish, pick };
}

/** Dialogs shared by the formation pages: equipment offers, replacement and dismissal. */
export function RosterDialogs({ tools }) {
  const { offers, offersOpen, setOffersOpen, equipmentLocked, getItem, pick, dismiss, setDismiss, locked, eligible, finish, replace, setReplace, inventory, roster, equip } = tools;
  return e(Fragment, null,
    e(Modal, { open: offersOpen && offers.length > 0, onClose: () => setOffersOpen(false), title: '待领取', micro: 'EQUIPMENT', actions: e(ProtocolButton, { onClick: () => setOffersOpen(false) }, '完成') },
      offers.map(offer => e('section', { key: offer.id, class: 'mz-panel', 'data-mz-equipment-offer': offer.id },
        e('h3', {}, offer.kind === 'item' ? '选择装备' : '选择干员'),
        e('div', { class: 'mzv-offer' }, arr(offer.choices).map(raw => {
          const choice = typeof raw === 'string' ? { id: raw, ...(offer.kind === 'item' ? { itemId: raw } : { operatorId: raw }) } : raw;
          const id = choice.itemId || choice.chessId || choice.operatorId || choice.id;
          const rec = offer.kind === 'item' ? getItem(id) : data.lookup('chess', choice.chessId || id);
          return e('div', { key: id, class: 'mzv-offer__row' }, e(UnitThumb, { kind: offer.kind === 'item' ? 'item' : 'chess', id, rec, size: 'md' }),
            e(ProtocolButton, { size: 'sm', disabled: equipmentLocked, 'data-mz-equipment-pick': id, onClick: () => pick(offer, choice) }, choice.name || rec?.name || id));
        }))))),
    e(Modal, { open: !!dismiss, onClose: () => setDismiss(null), title: '遣散干员',
      actions: [e(ProtocolButton, { variant: 'secondary', onClick: () => setDismiss(null) }, '保留干员'), e(ProtocolButton, { variant: 'danger', disabled: locked || !eligible, onClick: finish }, '确认遣散 · +1 希望')] },
      e('p', {}, '遣散' + (dismiss?.name || '') + '，返还 1 点希望。该干员将离开本次探索，已穿戴装备退回装备库存。')),
    e(EquipReplaceDialog, { request: replace, getItem, busy: equipmentLocked, onCancel: () => setReplace(null),
      onConfirm: uid => equip(inventory.find(item => same(item.uid, replace?.item.uid)), roster.find(unit => same(unit.uid, replace?.targetUid)), uid) }));
}

/** Draggable equipment strip at the bottom of the formation page. Hidden when the player has nothing. */
export function EquipmentBar({ tools }) {
  const { inventory, offers, selectedItem, selectedRecord, consumable, equipmentLocked, itemRecord, setDragItemUid, setSelectedItemUid, setOffersOpen } = tools;
  if (!inventory.length && !offers.length) return null;
  return e('div', { class: 'mzv-gear', 'data-mz-equipment-inventory': true },
    e('span', { class: 'mzv-gear__label' }, '装备'),
    e('div', { class: 'mzv-gear__list' }, inventory.map(item => {
      const on = same(item.uid, selectedItem?.uid);
      return e('button', { key: item.uid, type: 'button', class: cx('mzv-gear__item', on && 'is-selected'), draggable: !equipmentLocked, title: itemRecord(item).name || item.id,
        'data-mz-equipment-item': item.uid, 'aria-pressed': on,
        onDragStart: event => { if (equipmentLocked) { event.preventDefault(); return; } event.dataTransfer.setData('application/x-mizuki-item', String(item.uid)); event.dataTransfer.effectAllowed = 'move'; setDragItemUid(item.uid); },
        onDragEnd: () => setDragItemUid(null), onClick: () => setSelectedItemUid(on ? null : item.uid) },
      e(UnitThumb, { kind: 'item', id: item.id, size: 'md' }));
    })),
    inventory.length ? e('span', { class: 'mzv-gear__hint' }, selectedRecord ? (selectedRecord.name || selectedRecord.id) + (consumable ? ' · 使用后立即生效' : '') + ' · 点击干员配发' : '拖动装备到干员卡片上配发') : null,
    offers.length ? e('button', { type: 'button', class: 'mzv-gear__offers', onClick: () => setOffersOpen(true) }, '待领取 ' + offers.length) : null);
}

/** Mini attack-range map, drawn from the same grid the detail card uses. */
function RangeMap({ grid }) {
  if (!Array.isArray(grid) || !grid.length) return null;
  let box; try { box = rangeGridBox(grid); } catch { return null; }
  if (!box?.cells?.size) return null;
  const cells = [];
  for (let r = box.r0; r > box.r0 - box.rows; r--) for (let c = box.c0; c < box.c0 + box.cols; c++)
    cells.push(e('i', { key: r + ',' + c, class: cx(box.cells.has(tileKey(r, c)) && 'on', r === 0 && c === 0 && 'self') }));
  return e('div', { class: 'mzv-range' }, e('div', { class: 'mzv-range__grid', style: { gridTemplateColumns: 'repeat(' + box.cols + ',1fr)', aspectRatio: box.cols + ' / ' + box.rows } }, cells), e('span', {}, '攻击范围'));
}
const SP_TYPE = { INCREASE_WITH_TIME: '自动回复', INCREASE_WHEN_ATTACK: '攻击回复', INCREASE_WHEN_TAKEN_DAMAGE: '受击回复', ON_DEPLOY: '被动' };
const SKILL_TYPE = { MANUAL: '手动触发', AUTO: '自动触发', PASSIVE: '被动' };
/** Non-promoted operators cap at 70, promoted ones at 90 (the card shows the current level only). */
const levelOf = (unit, record) => unit.level ?? unit.lv ?? (unit.promotion ? 90 : record?.level ?? 70);

/** Equipment menu: the owned items; picking one wears it (a full operator opens the destroy-and-replace dialog). */
function EquipMenu({ unit, tools, open, onClose }) {
  const { inventory, itemRecord, selectedItem, selectedRecord, consumable, setSelectedItemUid, assignItem, equipmentLocked } = tools;
  return e(Modal, { open, onClose, title: '装备菜单', micro: 'EQUIPMENT',
    actions: [e(ProtocolButton, { key: 'c', variant: 'secondary', onClick: onClose }, '关闭'),
      e(ProtocolButton, { key: 'w', disabled: equipmentLocked || !selectedItem, 'data-mz-equipment-assign': unit.uid, onClick: () => { assignItem(selectedItem, unit); onClose(); } }, consumable ? '使用' : '穿戴')] },
  inventory.length ? e('div', { class: 'mzv-menu' },
    e('div', { class: 'mzv-inv' }, inventory.map(item => {
      const on = same(item.uid, selectedItem?.uid);
      return e('button', { key: item.uid, type: 'button', class: cx('mzv-inv__item', on && 'is-selected'), title: itemRecord(item).name || item.id, 'aria-pressed': on, onClick: () => setSelectedItemUid(on ? null : item.uid) }, e(UnitThumb, { kind: 'item', id: item.id, size: 'md' }));
    })),
    selectedRecord ? e('div', { class: 'mzv-sel' }, e('b', {}, (selectedRecord.name || selectedRecord.id) + (consumable ? ' · 使用后立即生效' : ' · 持续穿戴')),
      selectedRecord.descRaw || selectedRecord.description || selectedRecord.desc ? e(RichText, { as: 'p', text: selectedRecord.descRaw || selectedRecord.description || selectedRecord.desc }) : null) : e('p', { class: 'mzv-muted' }, '点选一件装备')) : e('p', { class: 'mzv-muted' }, '暂无装备'));
}

const lookupChess = id => { try { return id ? data.lookup('chess', id) : null; } catch { return null; } };
/** Server `detail` (full official skill list, trait, range, stats) wins; the client chess table fills what it lacks. */
const chessRecord = unit => {
  const native = unit.uiRecord || [unit.chessId, unit.canonicalChessId, unit.operatorId, unit.baseId].map(lookupChess).find(Boolean) || {};
  const detail = unit.detail || {};
  return { ...native, ...Object.fromEntries(Object.entries(detail).filter(([, value]) => value != null && value !== '' && !(Array.isArray(value) && !value.length))),
    trait: detail.trait || native.trait, assets: { ...(native.assets || {}), ...(detail.subProfIcon ? { subProfIcon: detail.subProfIcon } : {}) },
    subProfessionName: detail.subProfessionName || native.subProfessionName };
};
const phaseOf = value => Number.isInteger(value) ? value : /^PHASE_[0-2]$/.test(value || '') ? Number(String(value).slice(-1)) : null;
const skillUnlocked = (skill, status) => {
  const cond = skill?.unlockCond;
  if (!cond) return true;
  const need = phaseOf(cond.phase), have = phaseOf(status?.phase);
  if (need === null || have === null) return false;
  return have > need || have === need && num(status?.level, 1) >= num(cond.level, 1);
};

/** Left column of the operator pages: identity, current level, stats, range, then 技能 / 分支+ (/ 装备). Scrolls as a whole.
 *  `tools` is null on the recruit page: details only, no loadout, equipment or dismissal. */
export function RosterSidebar({ unit, tools }) {
  const [tab, setTab] = useState('skill');
  const [menu, setMenu] = useState(false);
  if (!unit) return e(OperatorSidebar, { unit: null, skills: [] });
  const rules = tools?.rules || {}, inventory = tools?.inventory || [], locked = tools ? tools.locked : true, eligible = !!tools?.eligible;
  const loadout = unit.loadout || unit.loadoutOptions || {};
  const record = chessRecord(unit);
  const status = unit.formStatus || record.status || null;
  const stats = loadout.stats || unit.stats || record.stats || {};
  const unlockedList = arr(loadout.skills?.length ? loadout.skills : unit.skills);
  const full = arr(unit.detail?.skills).length ? arr(unit.detail.skills) : arr(record.skills).length ? arr(record.skills) : unlockedList;
  const skills = full.map((skill, index) => {
    const idx = num(skill.index, index), live = unlockedList.find(value => num(value.index) === idx);
    const open = typeof skill.locked === 'boolean' ? !skill.locked : unlockedList.length ? !!live : skillUnlocked(skill, status);
    return { ...skill, ...(live || {}), index: idx, locked: !open, description: live?.description || skill.description || skill.desc || '' };
  });
  const modules = arr(loadout.modules).filter(option => option.id !== 'none' || arr(loadout.modules).length > 1);
  const currentSkill = loadout.skillIndex ?? unit.skillIndex ?? 0;
  const currentModule = loadout.moduleId || unit.moduleId || 'none';
  const worn = tools ? tools.equipped(unit) : [];
  const slots = Math.max(num(rules.equipPerChess, 2), worn.length);
  const branchName = record.subProfessionName || unit.subProfessionName;
  const traitDesc = record.trait?.descRaw || record.trait?.desc;
  let branchIcon = null; try { branchIcon = assets.subProfIcon?.(record.assets?.subProfIcon || record.subProfessionId); } catch { branchIcon = null; }
  let grid = null; try { grid = attackRangeGrid(record); } catch { grid = null; }
  const phase = Number.isInteger(status?.phase) ? status.phase : unit.promotion ? 2 : null;
  const level = unit.level ?? unit.lv ?? status?.level ?? (phase === 2 ? 90 : null);
  const interval = stats.bat != null ? attackInterval(stats.bat, stats.aspd ?? 100) : null;
  const rows = [['生命', stats.maxHp], ['攻击', stats.atk], ['防御', stats.def], ['法抗', stats.res],
    ['间隔', interval == null ? null : Number(interval).toFixed(2) + 's'], ['费用', stats.cost], ['阻挡', stats.blockCnt], ['再部署', stats.respawnTime == null ? null : stats.respawnTime + 's']]
    .filter(([, value]) => value != null && value !== '');
  const showGear = !!tools && (rules.enabled || inventory.length || worn.length);
  const tabs = [['skill', '技能'], ['branch', '分支+'], showGear ? ['gear', '装备'] : null].filter(Boolean);
  const active = tabs.some(([id]) => id === tab) ? tab : 'skill';
  const editable = !locked && loadout.editable !== false;
  const english = record.appellation || unit.appellation;
  const unlockText = skill => { const need = phaseOf(skill.unlockCond?.phase); return need ? '精英' + need + '解锁' : '未解锁'; };
  return e('aside', { class: 'mzr-side mzv-side', 'data-mz-operator-details': unit.uid ?? unit.offerId },
    e('div', { class: 'mzv-scroll' },
    e('div', { class: 'mzv-id' }, english ? e('small', {}, english) : null, e('h2', {}, unit.name), PROF_NAMES[unit.profession || record.profession] ? e('em', {}, PROF_NAMES[unit.profession || record.profession] + (branchName ? ' · ' + branchName : '')) : null),
    level != null ? e('div', { class: 'mzv-lv', 'data-mz-level': level },
      phase ? e('img', { class: 'mzv-lv__elite', src: '/assets/mizuki/native-ui-roster/elite_' + phase + '.png', alt: '精英' + phase }) : null,
      e('small', {}, 'LV'), e('b', {}, level), e('span', {}, '当前')) : null,
    grid || rows.length ? e('div', { class: 'mzv-vit' }, e(RangeMap, { grid }),
      rows.length ? e('dl', { class: 'mzv-stats' }, rows.map(([label, value]) => e('div', { key: label }, e('dt', {}, label), e('dd', {}, typeof value === 'number' ? Math.round(value * 100) / 100 : value)))) : null) : null,
    e('div', { class: 'mzr-side__tabs mzv-tabs' }, tabs.map(([id, label]) => e('button', { key: id, type: 'button', class: cx(id === active && 'is-active'), 'aria-pressed': id === active, onClick: () => setTab(id) }, label))),
    e('div', { class: 'mzv-side__body' },
      active === 'skill' ? (skills.length ? skills.map(option => {
        const icon = assets.skillIcon(option.iconId || option.skillId);
        const on = !option.locked && num(option.index) === num(currentSkill);
        const tags = [SP_TYPE[option.spType], SKILL_TYPE[option.skillType], option.duration != null && option.duration > 0 ? option.duration + '秒' : null].filter(Boolean);
        return e('button', { key: option.index, type: 'button', class: cx('mzv-opt', on && 'is-selected', option.locked && 'is-locked'), disabled: !editable || option.locked, 'aria-pressed': on, 'data-mz-loadout-skill': option.index, onClick: () => tools && tools.changeLoadout(unit, option.index, currentModule) },
          e('i', { class: 'mzv-opt__icon', style: hudBg('cmn1-empty_skill_large') }, icon ? e('img', { src: icon, alt: '' }) : null,
            option.level != null ? e('s', {}, option.level) : null,
            option.initSp != null && option.spCost != null ? e('u', {}, option.initSp + '/' + option.spCost) : null,
            option.locked ? e('q', {}, unlockText(option)) : null),
          e('b', {}, option.name || '技能 ' + (num(option.index) + 1)),
          tags.length ? e('span', { class: 'mzv-opt__tags' }, tags.map(tag => e('em', { key: tag }, tag))) : null,
          option.description ? e(RichText, { as: 'span', text: option.description }) : null);
      }) : e('p', { class: 'mzv-muted mzv-pad' }, 'NO INFO/')) : null,
      active === 'branch' ? e('div', { class: 'mzv-branch' },
        branchName ? e('div', { class: 'mzv-branch__head' }, branchIcon ? e('img', { src: branchIcon, alt: '' }) : null, e('span', {}, e('small', {}, '分支'), e('b', {}, branchName))) : null,
        traitDesc ? e(RichText, { as: 'p', text: traitDesc }) : null,
        modules.length ? e('h4', {}, '模组') : null,
        modules.map(option => {
          const icon = moduleIcon(option);
          const on = option.id === currentModule;
          return e('button', { key: option.id, type: 'button', class: cx('mzv-opt', on && 'is-selected'), disabled: !editable, 'aria-pressed': on, 'data-mz-loadout-module': option.id, onClick: () => tools && tools.changeLoadout(unit, currentSkill, option.id) },
            e('i', { class: 'mzv-opt__icon', style: hudBg('cmn1-empty_skill_large') }, icon ? e('img', { src: icon, alt: '' }) : null),
            e('b', {}, option.name || option.id), option.description ? e(RichText, { as: 'span', text: option.description }) : null);
        }),
        !branchName && !traitDesc && !modules.length ? e('p', { class: 'mzv-muted' }, 'NO INFO/') : null) : null,
      active === 'gear' ? e('div', { class: 'mzv-gear-tab' },
        e('h4', {}, '已穿戴 ' + worn.length + '/' + slots),
        e('div', { class: 'mzv-worn' }, Array.from({ length: slots }, (_, index) => {
          const item = worn[index];
          return item ? e('div', { key: item.uid, class: 'mzv-eq', 'data-mz-equipped-item': item.uid }, e(UnitThumb, { kind: 'item', id: item.id, size: 'md' }), e('span', {}, tools.getItem(item.id)?.name || item.id))
            : e('div', { key: 'empty' + index, class: 'mzv-eq is-empty' }, e('i', {}), e('span', {}, '空'));
        })),
        e('button', { type: 'button', class: 'mzv-sel__assign', disabled: tools.equipmentLocked, 'data-mz-equipment-menu': unit.uid, onClick: () => setMenu(true) }, '装备穿戴')) : null)),
    eligible ? e('button', { type: 'button', class: 'mzv-side__dismiss', disabled: locked, onClick: () => tools.setDismiss(unit) }, '遣散 · +1 希望') : null,
    tools ? e(EquipMenu, { unit, tools, open: menu, onClose: () => setMenu(false) }) : null);
}
