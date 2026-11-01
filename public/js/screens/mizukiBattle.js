// Mizuki adapts server state to the existing Stronghold battlefield and HUD.
import { h, Button, Icon, Spinner } from '../ui/components.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { loadMizukiRuntime, createMizukiLookups, useMizukiFieldView } from '../mizukiRuntime.js';
import { TopBar } from '../ui/hud.js';
import { TeamPanel } from '../ui/teamPanel.js';
import { CombatHud } from '../ui/combatHud.js';
import { EnemyDrawer } from '../ui/enemyDrawer.js';
import { BondStrip, BondPopup } from '../ui/bondStrip.js';
import { GIcon, useGameData } from '../ui/gameComponents.js';
import { DetailPanel } from '../ui/detailPanel.js';
import { FacingWheel, holdPiece, setPieceDir, showRange } from '../mizukiFacingWheel.js';
import { SettingsModal, settingsStore } from '../ui/settings.js';
import { FullscreenButton, useDocClass } from '../ui/device.js';
import { data } from '../data.js';
import { RoundDamageModal } from '../ui/matchChrome.js';
import { MizukiExitModal } from './mizukiExit.js';
import { unitLoadout, prepCameraFor, shortcutFor, shortcutBlocked, panelSide, panelSlots } from '../ui/gameLogic.js';
import { net } from '../net.js';
import { mizukiPrepStage, mizukiPrepRenderState, mizukiPrepTarget, mizukiCanPlace, applyPendingPrepMoves, MIZUKI_PREP_SHIFT, MIZUKI_GEO } from '../mizukiPrep.js';
import { useMizukiBattleAudio } from '../mizukiAudio.js';
import { audio } from '../audio.js';
import { createMizukiBattleSfx } from '../mizukiBattleSfx.js';
import { mizukiLiveHealth, mizukiHealthTip } from '../mizukiHealth.js';
import { mizukiCoordinates } from '../mizukiCoordinates.js';
import { EmoteWheel, EmoteDanmaku } from '../ui/emotes.js';
import { Ticker } from '../ui/ticker.js';
import { EffectsList } from '../ui/effectsList.js';
import { Underframe, TempRowNotice, underframeRect } from '../ui/underframe.js';
import { openGuide } from '../ui/guide.js';
import { actions } from '../ui/gameActions.js';
import { useMatchCommunication, useMatchHudLayout } from '../ui/matchHudSupport.js';
import { PausedOverlay } from './game/overlays.js';
import { PhasePopup } from '../ui/matchPopups.js';
import { DownedPlate } from '../ui/matchPlates.js';
import { MizukiUnitThumb, MizukiImage } from '../mizukiAssets.js';
import { store, useStore } from '../store.js';
import { mizukiBattlePresentation, freezeMizukiBattleView } from '../mizukiBattlePresentation.js';
import { mizukiViewedPrep, mizukiViewedPhase } from '../mizukiViewedField.js';
import { inspectRange } from './game/range.js';
import { attackRangeGrid } from '../../../shared/loadoutRecord.js';

const e = (type, props, ...children) => h(type, props, ...children.flat(3));
const list = value => Array.isArray(value) ? value : [];
const same = (a, b) => a != null && b != null && String(a) === String(b);
const cx = (...parts) => parts.filter(Boolean).join(' ');

// Objective health belongs to one doctor, including when two doctors share a boss field.
export function mizukiPersonalHealth(player = {}, privateState = null) {
  return Object.fromEntries(['life', 'maxLife', 'shield'].map(key => {
    const value = Number.isFinite(privateState?.[key]) ? privateState[key] : player?.[key];
    return [key, Number.isFinite(value) ? Math.max(0, value) : null];
  }));
}
const healthValue = value => Number.isFinite(value) ? value : '--';
export function mizukiHealthText(health) {
  return '生命 ' + healthValue(health.life) + '/' + healthValue(health.maxLife) + ' · 护盾 ' + healthValue(health.shield);
}

function uiRecord(unit, gd) {
  if (!unit) return null;
  if (unit.uiRecord) return unit.uiRecord;
  const rec = unit.isToken ? gd.token(unit.tokenId || unit.defId || unit.chessId) : gd.chess(unit.chessId || unit.defId);
  if (rec && (!unit.charId || !rec.charId || rec.charId === unit.charId)) return rec;
  return { ...unit, id: unit.chessId || unit.defId || unit.charId, tier: unit.tier || unit.rarity,
    stats: unit.stats || {}, skills: unit.skills || [], bonds: unit.bonds || [] };
}

// The phase screen publishes state; the fixed host below owns the actual renderer.
export function NativeMizukiBattle(props) {
  const token = useRef(Symbol('mizuki-battle'));
  useLayoutEffect(() => () => mizukiBattlePresentation.depart(token.current, store.get()), []);
  useLayoutEffect(() => { mizukiBattlePresentation.present(token.current, props); });
  return null;
}

export function PersistentMizukiBattleHost() {
  const presentation = useStore(state => state, Object.is, mizukiBattlePresentation);
  useLayoutEffect(() => {
    mizukiBattlePresentation.sync(store.get());
    const off = store.subscribe(state => mizukiBattlePresentation.sync(state));
    return () => { off(); mizukiBattlePresentation.reset(); };
  }, []);
  if (!presentation.props) return null;
  const props = presentation.props;
  return e('div', { style: { position: 'absolute', inset: 0, zIndex: 2, background: '#07090e' }, inert: presentation.ending || presentation.waiting ? true : undefined,
    'data-mz-battle-presentation': presentation.ending ? 'ending' : presentation.waiting ? 'waiting' : 'battle' },
    e(MizukiBattleScene, { ...props, key: props.model?.currentNode?.id || props.ownFieldId || 'battle' }));
}

function MizukiBattleScene({ pub, model, priv, players, myId, ownFieldId, watchFieldId, onStopWatching, online, phase: ownPhase, busy, act, pendingMoves = [], error, onClearError, connection, room, me, chatId, spectator, readOnly = false, finishing = false }) {
  useDocClass('sp-in-match');
  const baseData = useGameData();
  const [runtime, setRuntime] = useState(null);
  useEffect(() => { let alive = true; loadMizukiRuntime().then(r => { if (alive) setRuntime(r); }).catch(() => { if (alive) setHint('作战资源加载失败，请刷新后重试'); }); return () => { alive = false; }; }, []);
  const gd = useMemo(() => createMizukiLookups(baseData, runtime), [baseData, runtime]);
  const hostRef = useRef(null);
  const hudRef = useRef(null);
  useMatchHudLayout(hudRef, pub.variant);
  const initialStageId = list(model.fields).find(f => f.fieldId === (watchFieldId || ownFieldId))?.stage?.id || list(model.fields)[0]?.stage?.id;
  const { view, kind: renderer } = useMizukiFieldView(hostRef, runtime, initialStageId);
  useEffect(() => {
    if (!view) return undefined;
    const previous = globalThis.__SP_VIEW__;
    globalThis.__SP_VIEW__ = view;
    return () => { if (globalThis.__SP_VIEW__ === view) globalThis.__SP_VIEW__ = previous || null; };
  }, [view]);
  const mounted = useRef({ key: null, ids: new Set() });
  const currentField = useRef(null);
  const facingRef = useRef(null);
  const [watching, setWatching] = useState(watchFieldId || ownFieldId);
  const [selectedUid, setSelectedUid] = useState(null);
  const [unitId, setUnitId] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [facing, setFacing] = useState(null);
  facingRef.current = facing;
  const [hint, setHint] = useState('');
  const [drawer, setDrawer] = useState(null);
  const [settings, setSettings] = useState(false);
  const [exit, setExit] = useState(false);
  const [bondId, setBondId] = useState(null);
  const [emoteOpen, setEmoteOpen] = useState(false);
  const [damageOpen, setDamageOpen] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [inspected, setInspected] = useState(null);
  const [phasePopup, setPhasePopup] = useState(null);
  const [downed, setDowned] = useState(false);
  const [pen, setPen] = useState(false);
  const [facilityCard, setFacilityCard] = useState(null);
  const previousPhase = useRef(null);
  const wasAlive = useRef(priv.alive !== false);
  const fields = list(model.fields);
  const field = fields.find(f => f.fieldId === watching) || fields.find(f => f.fieldId === ownFieldId) || fields[0];
  useEffect(() => { void net.watchMizukiField(field?.fieldId, { spectator: !!spectator }); }, [field?.fieldId, field?.battleId, online, spectator]);
  const phase = mizukiViewedPhase(field, model.expedition, ownPhase);
  useMizukiBattleAudio(field, phase);
  const battleSfx = useRef(null);
  if (!battleSfx.current) battleSfx.current = createMizukiBattleSfx(audio);
  useLayoutEffect(() => { battleSfx.current.setField(view ? field : null, { phase, finishing }); }, [view, field, phase, finishing]);
  useLayoutEffect(() => () => battleSfx.current.dispose(), []);
  currentField.current = field;
  useEffect(() => {
    if (!view || finishing) return undefined;
    return net.on('b.ev', packet => {
      const current = currentField.current;
      if (!current || !same(packet?.fieldId, current.fieldId) || !same(packet?.battleId, current.battleId)) return;
      view.pushEvents({ ...packet, t: current.t, ev: list(packet.ev || packet.events) });
      battleSfx.current.pushEvents(packet);
    });
  }, [view, finishing]);
  const mine = !!field && field.fieldId === ownFieldId;
  const { prep: viewedPrep, peerBoards } = mizukiViewedPrep(priv.prep, { fieldId: field?.fieldId, ownFieldId, playerId: myId, fields: model.prep?.fields });
  const prep = mine && phase === 'PREP' ? applyPendingPrepMoves(viewedPrep, pendingMoves) : viewedPrep;
  const nextEnemies = mine ? list(priv.nextEnemies) : [];
  const rosters = Object.entries(field?.rosters || {}).flatMap(([ownerId, units]) => list(units).map(u => ({ ...uiRecord(u, gd),
    ...(same(ownerId, myId) ? list(priv.roster).find(p => same(p.uid, u.uid)) : null), ...u, ownerId })));
  const ownRoster = rosters.filter(u => same(u.ownerId, myId));
  const roster = mine ? ownRoster.length ? ownRoster : list(priv.roster) : rosters;
  const prepSelected = [...list(prep.hand), ...list(prep.temp), ...list(prep.board), ...list(prep.supplies)].find(u => u && same(u.uid, selectedUid));
  const selected = phase === 'PREP' && prepSelected ? { ...prepSelected, chessId: prepSelected.id,
    isToken: prepSelected.kind === 'token', tokenId: prepSelected.kind === 'token' ? prepSelected.id : null } : roster.find(u => same(u.uid, selectedUid));
  const unit = rosters.find(u => same(u.id, unitId) && same(u.ownerId, myId)) || rosters.find(u => same(u.id, unitId));
  const info = list(field?.meta?.units).find(u => same(u.id, unitId));
  const tuple = list(field?.units).find(u => same(u[0], unitId));
  const active = inspected || unit || info;
  const controlled = online && !spectator && !readOnly && priv.alive !== false && mine && phase === 'PREP' && (!busy || busy === 'move') && !priv.ready;
  const toolControlled = online && !spectator && !readOnly && priv.alive !== false && mine && phase === 'COMBAT' && !busy && !field?.done;
  const prepSupplies = list(prep.supplies).filter(Boolean);
  const toolStock = list(field?.activeTools?.[myId]).filter(Boolean);
  const canUseTool = (tool, row, col) => {
    const tile = list(field?.geometry?.tiles).find(value => value.row === row && value.col === col);
    return toolControlled && tool?.toolId && tool.deployable !== false && tile && !tile.obstacle
      && !['start', 'end'].includes(tile.special) && (tool.position === 'ALL' ? tile.build !== 'NONE' : ['MELEE', 'ALL'].includes(tile.build));
  };
  const canPlace = (uid, target) => mizukiCanPlace(prep, field?.geometry, uid, target, peerBoards);
  const bondOwnerId = mine ? myId : Object.keys(field?.rosters || {})[0];
  const bondOwner = same(bondOwnerId, myId) ? null : players.find(p => same(p.playerId, bondOwnerId))?.name;
  const bonds = list(field?.covenants?.[bondOwnerId]).map(b => ({ ...b, bondId: b.bondId || b.id }));
  const bond = bonds.find(b => b.bondId === bondId);
  const ownHealth = mizukiPersonalHealth(players.find(p => same(p.playerId, myId)), priv);
  const ownLiveHealth = mizukiLiveHealth({ fields, playerId: myId, health: ownHealth, phase: ownPhase, finishing });
  const nativePub = { ...pub, phase: ownLiveHealth.unite ? 'UNITE' : phase, round: priv.round || model.round || pub.round, stageId: field?.stage?.id || pub.stageId, teamLp: null, players: players.map(p => {
    const personalField = fields.find(f => same(f.fieldId, p.fieldId)) || fields.find(f => list(f.players).some(id => same(id, p.playerId)) || Object.hasOwn(f.rosters || {}, p.playerId));
    const health = same(p.playerId, myId) ? ownHealth : mizukiPersonalHealth(p);
    const playerPhase = same(p.playerId, myId) ? ownPhase : mizukiViewedPhase(personalField, model.expedition, phase);
    const liveHealth = same(p.playerId, myId) ? ownLiveHealth : mizukiLiveHealth({ fields, playerId: p.playerId, health, phase: playerPhase, finishing });
    return { ...p, fieldId: personalField?.fieldId || p.fieldId, ...(same(p.playerId, myId) ? ownHealth : null), lp: liveHealth.lp, pendingLp: liveHealth.pending, uniteLeft: liveHealth.left, lpTip: mizukiHealthTip(liveHealth), alive: p.alive !== false,
      status: personalField?.done ? 'done' : (p.phase || phase) === 'COMBAT' ? 'combat' : p.ready ? 'ready' : 'acting' };
  }),
    fields: fields.map(f => ({ ...f, live: true, players: Array.isArray(f.players) ? f.players : Object.keys(f.rosters || {}) })) };
  const nativePriv = { ...priv, ...prep, ...ownHealth, ready: !!priv.ready, lp: ownLiveHealth.lp, alive: priv.alive !== false, bandId: priv.bandId || priv.strategy?.selected, hand: prep.hand || [], temp: prep.temp || [], board: prep.board || [] };
  const { bubbles, danmaku } = useMatchCommunication(nativePub, myId, gd.config);
  const readyMemberIds = list(model.expedition?.parties).find(party => same(party.id, priv.partyId))?.memberIds || field?.players || [myId];
  const readyPlayers = nativePub.players.filter(p => p.alive !== false && !p.left && readyMemberIds.some(id => same(id, p.playerId)));
  const canPause = !!pub.pauseAvailable && mine && !spectator && !readOnly && ownPhase === 'COMBAT';
  const manualPaused = pub.pauseReason === 'manual';
  const penAvail = phase === 'PREP' && mine && list(priv.nextEnemies).length > 0;
  const togglePause = async on => {
    if (!online || pauseBusy || (!canPause && !manualPaused)) return;
    setPauseBusy(true);
    try { await net.request('g.pause', { on }); } catch (err) { setHint(err.message || '暂停操作未完成'); }
    finally { setPauseBusy(false); }
  };
  const shownOwnerId = mine ? myId : Object.keys(field?.rosters || {})[0];
  const shownOwner = nativePub.players.find(p => same(p.playerId, shownOwnerId));
  const hud = { killed: field?.killed, resolved: field?.resolved, total: field?.total, dp: field?.dps?.[shownOwnerId] ?? field?.dp };
  const combatClient = {
    progress: nativePub.players.filter(p => !same(p.playerId, myId)).map(p => {
      const own = fields.find(f => same(f.fieldId, p.fieldId));
      return { playerId: p.playerId, name: p.name, done: !!own?.done, killed: own?.resolved ?? own?.killed, total: own?.total };
    }),
    observing: !mine && shownOwner ? { name: shownOwner.name } : null,
    onBack: onStopWatching || (ownFieldId && !spectator ? () => watch(ownFieldId) : null),
  };
  const damageArchive = useRef({ round: null, fields: new Map() });
  if (damageArchive.current.round !== nativePub.round) damageArchive.current = { round: nativePub.round, fields: new Map() };
  for (const current of fields) if (Array.isArray(current.damageRows)) damageArchive.current.fields.set(current.battleId || current.fieldId, current.damageRows);
  const damageRows = (round, ownerIds) => {
    if (round !== damageArchive.current.round) return [];
    const owners = ownerIds ? new Set(ownerIds.map(String)) : null, rows = new Map();
    for (const values of damageArchive.current.fields.values()) for (const item of values) {
      if (owners && !owners.has(String(item.ownerId))) continue;
      const previous = rows.get(item.key);
      if (!previous) rows.set(item.key, { ...item });
      else for (const key of ['phys', 'arts', 'other', 'total']) previous[key] += item[key] || 0;
    }
    return [...rows.values()].sort((a, b) => b.total - a.total);
  };
  const watch = id => { setWatching(typeof id === 'object' ? id.fieldId : id); setSelectedUid(null); setUnitId(null); setInspected(null); setDetailOpen(false); setFacing(null); setBondId(null); setPen(false); setHint(''); };
  useEffect(() => {
    const key = model.currentNode?.id + ':' + phase;
    if (previousPhase.current === key) return;
    previousPhase.current = key;
    setPhasePopup({ key, title: phase === 'PREP' ? '休整期' : '作战开始', micro: phase === 'PREP' ? 'REST' : 'COMBAT', tone: phase === 'PREP' ? 'mint' : 'orange', sub: phase === 'PREP' ? '部署干员，准备迎敌' : '各自行动阶段' });
  }, [phase, model.currentNode?.id]);
  const previewNow = field?.t ?? 0;
  const previewTiles = phase === 'COMBAT' && !finishing ? list(field?.officialWaves?.previews)
    .filter(signal => previewNow >= signal.time && previewNow - signal.time <= 3
      && ['PREVIEW', 'PREVIEW_CURSOR', 'PREVIEW_ROUTE'].includes(signal.actionType))
    .flatMap(signal => signal.actionType === 'PREVIEW_ROUTE' ? list(signal.points) : signal.start ? [signal.start] : []) : [];
  const previewTilesKey = JSON.stringify(previewTiles);
  useEffect(() => {
    if (!view || phase !== 'COMBAT' || finishing) return;
    const style = { group: 'mizukiEnemyPreview', color: 0xff5a4f, fill: .32, line: 2 };
    if (previewTiles.length) view.highlightTiles(previewTiles, style);
    // Wave previews highlight entrances; detail panels require explicit player input.
    return () => view.highlightTiles([], style);
  }, [view, phase, finishing, field?.battleId, previewTilesKey]);
  useEffect(() => {
    if (priv.alive === false && wasAlive.current && !spectator) setDowned(true);
    wasAlive.current = priv.alive !== false;
  }, [priv.alive, spectator]);
  useEffect(() => { document.body.classList.add('east-match-legacy'); return () => document.body.classList.remove('east-match-legacy'); }, []);
  useEffect(() => { watch(watchFieldId || ownFieldId); }, [ownFieldId, watchFieldId, model.currentNode?.id]);
  useLayoutEffect(() => {
    if (!view || field?.__overview || !field?.stage || !field?.meta) return;
    const key = field.battleId + ':' + field.fieldId + ':' + phase;
    if (phase === 'PREP') {
      const rect = field.meta.rect;
      if (mounted.current.view !== view || mounted.current.key !== key) {
        view.setStage(mizukiPrepStage(field.stage, rect));
        const camera = prepCameraFor({ ...nativePub, bossRound: null, hiddenRound: null }, myId, true);
        // Native bounds control drawing; the shared ordinary camera keeps its exact preset.
        view.setCamera(camera.kind, { ...camera.opts, rect: undefined, nativeRect: { r0: 0, r1: rect.r1 + MIZUKI_PREP_SHIFT, c0: Math.min(0, rect.c0), c1: Math.max(9, rect.c1) } });
        mounted.current = { view, key, ids: new Set() };
      }
      view.setPrep({ ...mizukiPrepRenderState(prep, peerBoards), fieldId: field.fieldId, battleId: field.battleId, nextEnemies,
        prepEnemies: list(field.prepEnemies).map(enemy => ({ ...enemy, y: enemy.y + MIZUKI_PREP_SHIFT })) }, { editable: controlled && !pen, canPlace });
      const coordinates = mizukiCoordinates(mizukiPrepStage(field.stage, field.meta.rect));
      view.raw?.debug?.mizukiFacilities?.setPreparation(coordinates.point(list(field.meta.units).filter(unit => unit.kind === 'device').map(unit => ({ ...unit, y:unit.y + MIZUKI_PREP_SHIFT }))));
      return;
    }
    if (mounted.current.view !== view || mounted.current.key !== key) {
      const kind = field.kind === 'hidden' ? 'boss' : field.kind || 'normal';
      const members = Array.isArray(field.players) ? field.players : Object.keys(field.rosters || {});
      const side = field.sides?.[myId] || (members.indexOf(myId) === 1 ? 'R' : 'L');
      view.setStage(field.stage);
      view.enterBattle({ ...field.meta, fieldId: field.fieldId, battleId: field.battleId, kind, prep: false });
      view.setCamera(kind, { rect: field.meta.rect, side });
      mounted.current = { view, key, ids: new Set(list(field.meta.units).map(u => u.id)) };
    }
    const fresh = list(field.meta.units).filter(u => !mounted.current.ids.has(u.id));
    if (fresh.length) {
      view.pushEvents({ fieldId: field.fieldId, battleId: field.battleId, t: field.t, ev: fresh.map(u => ['spawn', u]) });
      fresh.forEach(u => mounted.current.ids.add(u.id));
    }
    view.pushSnapshot(field);
  }, [view, field, phase, priv.prep, pendingMoves, controlled, model.prep, pen]);
  useEffect(() => {
    if (!view || !finishing) return undefined;
    setFacing(null); setPhasePopup(null); setFacilityCard(null);
    return freezeMizukiBattleView(view);
  }, [view, finishing, field?.t]);
  useEffect(() => {
    if (!view || phase !== 'PREP' || !field?.meta?.rect) return;
    view.setPen(nextEnemies);
    if (pen && penAvail) view.setCamera('pen', { shop: false });
    else {
      const camera = prepCameraFor({ ...nativePub, bossRound: null, hiddenRound: null }, myId, true), rect = field.meta.rect;
      view.setCamera(camera.kind, { ...camera.opts, rect: undefined, nativeRect: { r0: 0, r1: rect.r1 + MIZUKI_PREP_SHIFT, c0: Math.min(0, rect.c0), c1: Math.max(9, rect.c1) } });
    }
  }, [view, phase, pen, penAvail, priv.nextEnemies, field?.battleId, mine]);
  const callbacks = useRef(null);
  callbacks.current = {
    tile: ({ row, col }) => {
      if (facilityCard && (controlled || toolControlled) && !pen) {
        const target = phase === 'PREP' ? mizukiPrepTarget({ area: 'board', row, col }) : { row, col };
        const tile = list(field?.geometry?.tiles).find(value => value.row === target.row && value.col === target.col);
        if (tile && ['MELEE', 'ALL'].includes(tile.build) && !tile.obstacle
          && (phase !== 'PREP' || ![...list(prep.board), ...peerBoards].some(piece => piece.row === target.row && piece.col === target.col))) {
          setFacing({ row, col, facilityKey: facilityCard.key }); setHint('');
        } else setHint('此处不能摆放该装置。');
        return;
      }
      if (selected?.toolId && toolControlled) {
        if (canUseTool(selected, row, col)) { setDetailOpen(false); setFacing({ row, col, uid: selected.uid }); setHint(''); }
        else setHint('此处不能使用该支援道具，或道具仍在冷却。');
        return;
      }
      if (pen || !controlled || !selected || !canPlace(selected.uid, { area: 'board', row, col })) { clearSelection(); return; }
      setDetailOpen(false); setFacing({ row, col, uid: selected.uid }); setHint('');
    },
    piece: ev => { setFacilityCard(null); setInspected(ev.preview && ev.unit ? { ...ev.unit, kind: 'enemy' } : null); setUnitId(ev.unitId ?? ev.unit?.id ?? null); setSelectedUid(ev.uid ?? null); setDetailOpen(true); setFacing(null); setHint(''); },
    drop: ev => {
      if (!controlled || !canPlace(ev.uid, ev.target)) return;
      setSelectedUid(ev.uid); setDetailOpen(false); setHint('');
      if (ev.target.area === 'board') setFacing({ ...ev.target, uid: ev.uid });
      else void act('move', { uid: ev.uid, to: mizukiPrepTarget(ev.target) });
    },
  };
  useEffect(() => {
    if (!view) return;
    const listeners = [view.on('tileClick', ev => callbacks.current.tile(ev)), view.on('pieceClick', ev => callbacks.current.piece(ev)), view.on('pieceDrop', ev => callbacks.current.drop(ev))];
    return () => listeners.forEach(off => off?.());
  }, [view]);
  const rec = active?.kind === 'enemy' || active?.side === 'enemy'
    ? runtime?.enemies?.[active.defId || active.enemyKey] || data.lookup('enemies', active.defId || active.enemyKey) || active
    : uiRecord(active || selected, gd);
  const detail = rec ? active?.kind === 'enemy' || info?.side === 'enemy' ? { type: 'enemy', enemy: rec, unitId }
    : { type: active?.isToken || selected?.isToken ? 'token' : 'chess', [active?.isToken || selected?.isToken ? 'token' : 'chess']: rec, unitId, cultOpts: { cultivation: null } } : null;
  // Runtime records already contain the official cultivation. Never apply the legacy P6/E2 level multiplier again.
  const currentUnit = unit || selected;
  const live = currentUnit?.live ? { ...currentUnit.live, src: phase === 'PREP' ? 'prep' : 'battle', hp: tuple ? tuple[3] : currentUnit.hp, sp: tuple?.[5] ?? currentUnit.skill?.sp, spMax: tuple?.[6] ?? currentUnit.skill?.spMax } : null;
  const selectedPiece = phase === 'PREP' ? [...list(prep.board).map(p => ({ ...p, row: p.row + MIZUKI_PREP_SHIFT, area: 'board' })),
    ...list(prep.hand).map((p, idx) => p && ({ ...p, row: MIZUKI_GEO.HAND_ROW, col: idx, area: 'hand' })),
    ...list(prep.temp).map((p, idx) => p && ({ ...p, row: MIZUKI_GEO.TEMP_ROW, col: MIZUKI_GEO.TEMP_C0 + idx, area: 'temp' }))]
    .find(p => p && same(p.uid, selectedUid))
    : tuple && tuple[3] > 0 && info?.side === 'ally'
      ? { ...info, ...unit, row: Math.round(tuple[2]), col: Math.round(tuple[1]), area: 'board' } : null;
  const retreatSelected = async () => {
    if (!controlled || !selectedPiece || selectedPiece.area === 'hand') return;
    const idx = list(prep.hand).findIndex(p => !p);
    if (idx < 0) { setHint('整备区已满，请先移出一个位置。'); return; }
    if (await act('move', { uid: selectedPiece.uid, to: { area: 'hand', idx } })) { setSelectedUid(null); setUnitId(null); setDetailOpen(false); }
  };
  const clearSelection = () => { setFacilityCard(null); setSelectedUid(null); setUnitId(null); setInspected(null); setDetailOpen(false); };
  const toggleReady = () => mine && ownPhase === 'PREP' && !readOnly && !spectator && online && !busy && act('ready', { on: !priv.ready });
  const keyboard = useRef(null);
  keyboard.current = { controlled, phase, facing, emoteOpen, bondId, detailOpen, drawer, pen, canPause, manualPaused, togglePause, toggleReady, retreatSelected, clearSelection };
  useEffect(() => {
    const keydown = event => {
      const action = shortcutFor(event, settingsStore.get().keys), current = keyboard.current;
      if (!current || shortcutBlocked(action, { modal: !!document.querySelector('.modal,.guide,.downpl') })) return;
      if (current.facing) return;
      if (action === 'escape') {
        if (current.emoteOpen) setEmoteOpen(false);
        else if (current.pen && !current.detailOpen) setPen(false);
        else if (current.bondId) setBondId(null);
        else if (current.detailOpen) current.clearSelection();
        else if (current.drawer) setDrawer(null);
        else return;
        event.preventDefault(); return;
      }
      if (action === 'ready' && (current.canPause || current.manualPaused)) {
        event.preventDefault(); void current.togglePause(!current.manualPaused); return;
      }
      if (current.phase !== 'PREP') return;
      if (action === 'ready') { event.preventDefault(); void current.toggleReady(); }
      else if (action === 'retreat' && current.controlled) { event.preventDefault(); void current.retreatSelected(); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
  useEffect(() => {
    if (!facing || !view || facing.facilityKey) return undefined;
    holdPiece(view, facing.uid, { row: facing.row, col: facing.col });
    return () => {
      holdPiece(view, facing.uid, null);
    };
  }, [view, facing]);
  const selectedRange = detailOpen && !facing && !pen ? inspectRange({
    target: phase === 'PREP' ? { kind: 'piece', uid: selectedUid } : { kind: 'unit', unit: info && { ...info, ...unit } },
    detail, pieces: new Map(selectedPiece ? [[selectedUid, { ...selectedPiece, piece: selected }]] : []),
    showPrep: phase === 'PREP', field, snapshot: tuple, live,
    loadout: unitLoadout(rec, info), getChess: gd.chess, backups: gd.backups,
  }) : null;
  const selectedRangeKey = selectedRange ? JSON.stringify(selectedRange) : '';
  useEffect(() => {
    const style = { group: 'selRange', color: 0xff9c33, fill: .36, line: 1 };
    showRange(view, selectedRange?.grid, selectedRange?.row, selectedRange?.col, selectedRange?.dir, style);
    return () => showRange(view, null, 0, 0, null, style);
  }, [view, selectedRangeKey]);
  let detailSide = 'right';
  if (detail && detailOpen && !facing && selectedPiece) {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 100;
    detailSide = panelSide(underframeRect(view?.tileScreen(selectedPiece.row, selectedPiece.col), rem), panelSlots({ width: innerWidth, height: innerHeight }, rem));
  }
  const place = async dir => {
    if (!facing) return;
    const placing = facing;
    if (facing.facilityKey && (controlled || toolControlled)) {
      const tile = phase === 'PREP' ? mizukiPrepTarget({ area: 'board', row: facing.row, col: facing.col }) : facing;
      if (await act('facility', { battleId: field.battleId, key: facing.facilityKey, row: tile.row, col: tile.col, dir })) { setFacing(null); clearSelection(); }
      return;
    }
    if (selected?.toolId && toolControlled) {
      if (await act('deploy', { battleId: field.battleId, uid: selected.uid, row: facing.row, col: facing.col, dir })) { setFacing(null); clearSelection(); }
      return;
    }
    if (!controlled) return;
    if (await act('move', { uid: placing.uid, to: mizukiPrepTarget({ area: 'board', row: placing.row, col: placing.col }), dir })) {
      if (facingRef.current === placing) {
        setFacing(null);
        setSelectedUid(current => same(current, placing.uid) ? null : current);
      }
    }
  };
  const hudRecords = { lookup: (name, id) => name === 'stages' && same(id, field?.stage?.id) ? { ...field.stage, name: model.currentNode?.stageName || model.currentNode?.name || model.currentNode?.title || field.stage.name || field.stage.id }
    : name === 'bands' ? list(priv.strategy?.options || model.strategyOptions).find(b => same(b.bandId, id)) || data.lookup(name, id)
    : runtime?.[name]?.[id] || data.lookup(name, id) };
  return e('div', { class: cx('screen gm gm--mizuki-native', phase === 'PREP' ? 'gm--prep' : 'gm--combat', 'is-collapsed', pen && 'is-pen'), 'data-renderer': renderer },
    e('div', { class: 'gm__field', ref: hostRef, onContextMenu: event => event.preventDefault() }), e('div', { class: 'gm__vignette', 'aria-hidden': true }),
    danmaku.length ? e('div', { class: 'gm__danmaku' }, danmaku.map(message => e(EmoteDanmaku, { key: message.seq, emote: message, name: message.name, lane: message.seq % 5 }))) : null,
    phase === 'PREP' && mine && list(prep.temp).some(piece => piece && !piece.toolId) ? e(TempRowNotice, { view, geometry: MIZUKI_GEO, count: list(prep.temp).filter(piece => piece && !piece.toolId).length, label: !facing, ready: !!priv.ready, rule: '临时整备区的单位需移入整备区或战场后才可准备。' }) : null,
    e('div', { class: 'gm__hud', ref: hudRef },
      e(TopBar, { pub: nativePub, priv: nativePriv, conn: connection, hud, drawer, onExit: () => setExit(true), onDrawer: tab => setDrawer(drawer ? null : tab),
        live: { ...ownLiveHealth, tip: mizukiHealthTip(ownLiveHealth) },
        onReady: toggleReady, readyBusy: !!busy || !online || readOnly, readyCount: readyPlayers.filter(p => p.ready).length, playerCount: readyPlayers.length,
        config: gd.config, pause: canPause || manualPaused ? { show: canPause, paused: manualPaused, busy: pauseBusy, onToggle: () => togglePause(!manualPaused) } : null,
        pen, penAvail, onPen: setPen, frozenAt: pub.paused ? pub.pausedAt : null, myId, spectator }),
      e('div', { class: 'gm__bonds' }, e(BondStrip, { bonds, layersDisabled: false, owner: bondOwner, openId: bondId, onOpen: id => setBondId(id === bondId ? null : id) })),
      e(TeamPanel, { pub: nativePub, myId, watching: field?.fieldId, bubbles, seats: room?.seats, self: ownLiveHealth,
        onWatch: p => watch(p.fieldId), observe: { canObserve: p => p.alive !== false && fields.some(f => same(f.fieldId, p.fieldId)) ? { fieldId: p.fieldId } : { reason: '该阵地已结束' }, observing: !mine, onBack: combatClient.onBack || (() => watch(ownFieldId)) } }),
      e('div', { class: 'gm__effects' }, e(EffectsList, { effects: priv.effects }),
        phase === 'PREP' && mine && prepSupplies.length ? e('div', { class: 'mz-native-lineup', 'aria-label': '支援道具储备' }, prepSupplies.map(tool => e(Button, {
          key: tool.uid, size: 'sm', variant: same(selectedUid, tool.uid) ? 'primary' : 'secondary', disabled: !controlled,
          onClick: () => { clearSelection(); setSelectedUid(tool.uid); setHint('选择场上空格摆放' + tool.name + '，也可保留到作战时使用。'); },
        }, tool.name, ' ×' + tool.count))) : null,
        ['PREP', 'COMBAT'].includes(phase) && mine && list(field?.facilityCards).some(card => card.count > 0) ? e('div', { class: 'mz-native-lineup', 'aria-label': '关卡装置' }, list(field.facilityCards).filter(card => card.count > 0).map(card => e(Button, {
          key: card.key, size: 'sm', variant: facilityCard?.key === card.key ? 'primary' : 'secondary', disabled: !(controlled || toolControlled) || card.deployable === false,
          onClick: () => { clearSelection(); setFacilityCard(card); setHint('选择场上空格摆放' + card.name); },
        }, card.name, ' ×' + card.count, card.redeployRemaining > 0 ? ' · ' + Math.ceil(card.redeployRemaining) + '秒' : ' · ' + card.cost))) : null,
        phase === 'COMBAT' && mine && toolStock.length ? e('div', { class: 'mz-native-lineup', 'aria-label': '支援道具' }, toolStock.map(tool => e(Button, {
          key: tool.uid, size: 'sm', variant: same(selectedUid, tool.uid) ? 'primary' : 'secondary', disabled: !toolControlled || tool.deployable === false,
          title: tool.name + ' · ' + tool.cost + ' 费用', 'aria-pressed': same(selectedUid, tool.uid), onClick: () => { setSelectedUid(tool.uid); setUnitId(null); setInspected(null); setDetailOpen(true); setHint('选择场上空格使用' + tool.name); },
        }, runtime?.assetsLibrary?.groups?.items?.[tool.toolId]?.path ? e(MizukiImage, { src: runtime.assetsLibrary.groups.items[tool.toolId].path, alt: '', width: 24, height: 24 }) : null,
        tool.name, ' ×' + tool.count, tool.redeployRemaining > 0 ? ' · ' + Math.ceil(tool.redeployRemaining) + '秒' : ' · ' + tool.cost))) : null),
      !mine && phase === 'PREP' && !spectator ? e('div', { class: 'gm__watching', role: 'status' }, e(GIcon, { name: 'eye' }), e('span', {}, '正在查看 ', e('b', {}, shownOwner?.name || '队友'), ' 的阵地（只读）'), e(Button, { size: 'sm', variant: 'primary', icon: 'back', onClick: combatClient.onBack }, '返回自己')) : null,
      phase === 'COMBAT' ? e(CombatHud, { pub: nativePub, myId, watching: field?.fieldId, hud, myDone: mine && field?.done, onWatch: watch,
        spectating: !!spectator || priv.alive === false, spectator: !!spectator, client: combatClient }) : null,
      priv.alive === false && phase !== 'COMBAT' ? e('div', { class: 'gm__dead', role: 'status' }, e(Icon, { name: 'close' }), '你已被淘汰 · 可继续观战队友') : null,
      e(Ticker),
      e('div', { class: 'gm__corner' },
        !spectator ? e(EmoteWheel, { open: emoteOpen, onToggle: setEmoteOpen, onSend: id => actions.emote(id), disabled: !online }) : null,
        !spectator ? e('span', { class: 'gm__chat-slot', 'aria-hidden': true }) : null,
        e('button', { type: 'button', class: 'gm__gear', onClick: () => setSettings(true), title: '设置', 'aria-label': '设置' }, e(GIcon, { name: 'gear' })),
        e('button', { type: 'button', class: 'gm__gear gm__damage', 'aria-label': '本回合伤害统计', title: '本回合伤害统计', 'aria-expanded': damageOpen, onClick: () => setDamageOpen(open => !open) }, e(Icon, { name: 'sword' })),
        e('button', { type: 'button', class: 'gm__gear gm__guide', 'aria-label': '玩法说明', title: '玩法说明', onClick: () => openGuide(0) }, e(Icon, { name: 'book' })),
        e(FullscreenButton, { class: 'gm__gear gm__fs' })),
      bond ? e(BondPopup, { bondId, entry: bond, priv: nativePriv, banned: [], owner: bondOwner, onClose: () => setBondId(null), onMember: member => { const found = rosters.find(u => same(u.uid, member?.uid) || same(u.chessId, member?.id)); if (found) { setUnitId(found.deployed ? found.id : null); if (same(found.ownerId, myId)) setSelectedUid(found.uid); } setBondId(null); } }) : null,
      drawer ? e(EnemyDrawer, { tab: drawer, onTab: setDrawer, pub: nativePub, priv: nativePriv, records: hudRecords, Thumb: MizukiUnitThumb, onClose: () => setDrawer(null),
        onEnemy: id => { const found = list(field?.meta?.units).find(u => same(u.defId, id)); setInspected(found || { kind: 'enemy', defId: id }); setUnitId(found?.id || null); setDetailOpen(true); },
        onChess: id => { const found = rosters.find(u => same(u.chessId, id)); if (found) { setUnitId(found.id); setDetailOpen(true); } } }) : null,
      detail && detailOpen && !facing ? e(DetailPanel, { detail, editable: false, snapHp: tuple ? { hp: tuple[3], max: tuple[4] } : null, onClose: clearSelection, bonds, shopOpen: false, side: detailSide, voice: true, loadout: unitLoadout(rec, info), live,
        ignore: controlled ? '.scard, .dbond, .uframe, .uframe__close, .gm__field' : undefined,
        onBond: id => setBondId(id) }) : null,
      selectedPiece && controlled && detailOpen && !facing ? e(Underframe, { view, uid: selectedPiece.uid, row: selectedPiece.row, col: selectedPiece.col, actions: { retreat: selectedPiece.area !== 'hand', sell: null, destroy: false }, busy: !!busy, name: rec?.name || '', onClose: clearSelection, onRetreat: retreatSelected }) : null,
      hint || error ? e('div', { class: 'mz-native-notice', role: error ? 'alert' : 'status' }, e(Icon, { name: error ? 'warn' : 'info' }), error || hint, e(Button, { size: 'sm', variant: 'ghost', icon: 'close', square: true, onClick: () => { setHint(''); onClearError(); } })) : null,
      renderer === 'loading' ? e('div', { class: 'gm__loading' }, e(Spinner, { label: '加载卫戍协议战场' })) : null),
    phasePopup ? e(PhasePopup, { ...phasePopup, duration: 1500, onDone: () => setPhasePopup(null) }) : null,
    downed ? e(DownedPlate, { onWatch: () => setDowned(false), onSettle: () => { setDowned(false); setExit(true); } }) : null,
    facing && (selected || facilityCard) ? e(FacingWheel, { view, row: facing.row, col: facing.col, grid: facing.facilityKey ? [[0, 0]] : attackRangeGrid(rec) || [], name: facilityCard?.name || selected.name, onCommit: place, onPreview: dir => { if (!facing.facilityKey) setPieceDir(view, facing.uid, dir); }, onCancel: () => setFacing(null) }) : null,
    manualPaused ? e(PausedOverlay, { canResume: canPause, busy: pauseBusy, onResume: () => togglePause(false), onExit: () => setExit(true) }) : null,
    e(RoundDamageModal, { open: damageOpen, onClose: () => setDamageOpen(false), round: nativePub.round, ownerIds: list(field?.players).length ? field.players : [shownOwnerId].filter(Boolean), getRows: damageRows, Thumb: MizukiUnitThumb }),
    e(SettingsModal, { open: settings, onClose: () => setSettings(false) }),
    e(MizukiExitModal, { open: exit, onClose: () => setExit(false) }));
}
