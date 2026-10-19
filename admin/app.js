(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const bootView = $('bootView');
  const loginView = $('loginView');
  const dashboardView = $('dashboardView');
  const dialog = $('matchDialog');
  let snapshot = null;
  let activeTab = 'matches';
  let playerFilter = 'all';
  let authenticated = false;
  let failures = 0;
  let timer = null;
  let controller = null;
  let selectedRoom = null;
  let selectedPlayer = null;
  let announcementLoaded = false;
  let announcementBusy = false;
  let kickBusy = false;
  let sessionVersion = 0;
  const kickDialog = $('kickDialog');

  function feedback(id, message, error = false) {
    $(id).textContent = message;
    $(id).dataset.state = error ? 'error' : 'success';
    $(id).hidden = !message;
  }
  function previewAnnouncement() {
    $('announcementPreviewTitle').textContent = $('announcementTitle').value.trim() || '公告标题';
    $('announcementPreviewContent').textContent = $('announcementContent').value.trim() || '公告正文会显示在这里。';
  }
  async function operation(url, body) {
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    if (response.status === 401) { clearSession(); throw new Error('登录已过期，请重新登录。'); }
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || `请求失败（${response.status}）`);
    return result;
  }
  async function loadAnnouncement() {
    if (announcementBusy || !authenticated) return;
    announcementBusy = true;
    const version = sessionVersion;
    $('announcementReload').disabled = $('announcementPublish').disabled = true;
    try {
      const result = await operation('/api/announcement');
      if (version !== sessionVersion) return;
      const current = result.announcement;
      $('announcementTitle').value = current?.title || '';
      $('announcementContent').value = current?.content || '';
      $('announcementUpdated').textContent = current?.updatedAt ? `上次发布 ${dateLabel(current.updatedAt)}` : '尚无公告';
      announcementLoaded = true;
      previewAnnouncement();
      feedback('announcementStatus', '已读取当前公告。');
    } catch (error) { if (version === sessionVersion) feedback('announcementStatus', error.message, true); }
    finally { announcementBusy = false; $('announcementReload').disabled = $('announcementPublish').disabled = false; }
  }
  function openKick(player) {
    selectedPlayer = { ...player };
    $('kickTarget').textContent = `${value(player.name)} · ${serverName(player.serverId || 'main')} · 所在房间：${value(player.roomCode)}`;
    feedback('kickStatus', '');
    kickDialog.showModal();
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function value(item) {
    return item === null || item === undefined || item === '' ? '—' : String(item);
  }

  function dateLabel(input) {
    if (input === null || input === undefined || input === '') return '—';
    const date = new Date(input);
    return Number.isNaN(date.getTime()) ? value(input) : new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }

  function numberLabel(input) {
    if (input === null || input === undefined || input === '') return '—';
    const number = Number(input);
    return Number.isFinite(number) && number >= 0 ? new Intl.NumberFormat('zh-CN').format(number) : '—';
  }

  function list(input) {
    return Array.isArray(input) ? input : [];
  }

  const modeNames = new Map([['coop', '同盟'], ['solo', '独立']]);
  const difficultyNames = new Map([['FUNNY', '标准'], ['NORMAL', '险境'], ['HARD', '绝境'], ['ABYSS', '终极']]);
  const phaseNames = new Map([
    ['LOBBY', '等待中'], ['INFO_CHECK', '信息确认'], ['BAND_DRAFT', '策略选择'],
    ['BATTLE_CHECK', '协议启动'], ['ROUND_START', '回合开始'], ['SP_DRAFT', '机变阶段'],
    ['PREP', '备战'], ['COMBAT', '作战中'], ['UNITE', '联防阶段'], ['SETTLE', '结算'],
    ['FINAL_ASSAULT', '最终攻势'], ['HIDDEN_CORE', '隐秘核心'], ['RESULT', '模拟结束']
  ]);
  const label = (names, input) => names.get(input) ?? value(input);
  const serverNames = new Map([['main', '华东'], ['secondary', '华南']]);
  const incomplete = () => snapshot.summary?.complete === false;
  const serverName = (id) => list(snapshot.servers).find((server) => server.id === id)?.name || serverNames.get(id) || value(id);
  const totalLabel = (key) => incomplete() || snapshot.summary?.[key] == null ? '未知' : numberLabel(snapshot.summary[key]);

  function renderServers() {
    const servers = list(snapshot.servers);
    $('serverDetails').hidden = !servers.length;
    const fragment = document.createDocumentFragment();
    servers.forEach((server) => {
      const card = node('article', 'stat-card server-card');
      const top = node('div', 'stat-top');
      const available = server.status === 'online';
      top.append(node('span', '', `${value(server.name)} · ${value(server.id)}`), badge(available ? '在线' : '状态未知', `status-label${available ? '' : ' unknown'}`));
      const age = server.ageMs == null ? '未知' : `${numberLabel(Math.ceil(server.ageMs / 1000))} 秒`;
      const metrics = node('div', 'server-metrics');
      for (const [key, title] of [['online', '在线人数'], ['matches', '进行中对局'], ['ranked', '排位对局']]) {
        const count = available && server.summary?.[key] != null ? numberLabel(server.summary[key]) : '未知';
        metrics.append(meta(title, count));
      }
      card.append(top, node('p', 'row-sub', `快照年龄 ${age}`), metrics);
      fragment.append(card);
    });
    $('serverList').replaceChildren(fragment);
  }

  function display(view) {
    bootView.hidden = view !== 'boot';
    loginView.hidden = view !== 'login';
    dashboardView.hidden = view !== 'dashboard';
  }

  function connection(state, label) {
    $('connectionStatus').dataset.state = state;
    $('connectionText').textContent = label;
  }

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function stopPolling() {
    clearTimer();
    if (controller) controller.abort();
    controller = null;
  }

  function clearSession() {
    stopPolling();
    authenticated = false;
    failures = 0;
    snapshot = null;
    selectedRoom = null;
    sessionVersion++;
    selectedPlayer = null;
    announcementLoaded = false;
    if (kickDialog.open) kickDialog.close();
    $('announcementTitle').value = $('announcementContent').value = '';
    $('announcementUpdated').textContent = '尚未读取';
    previewAnnouncement();
    feedback('announcementStatus', ''); feedback('operationStatus', '');
    if (dialog.open) dialog.close();
    for (const id of ['matchList', 'onlineList', 'playerList', 'rankingList', 'dialogPlayers', 'dialogMeta', 'serverList']) $(id).replaceChildren();
    for (const id of ['statOnline', 'statPlayers', 'statMatches', 'statRanked', 'statOnlineNote', 'statMatchesNote', 'statRankedNote', 'matchTabCount', 'onlineTabCount', 'matchCount', 'onlineCount', 'playerCount', 'rankingCount']) $(id).textContent = '—';
    $('summaryStatus').textContent = '等待首次同步';
    $('serverDetails').hidden = true;
    $('updatedAt').textContent = '等待首次同步';
    $('password').value = '';
    $('loginError').hidden = true;
    display('login');
  }

  function empty(target, message) {
    const wrapper = node('div', 'empty-state');
    wrapper.append(node('span', 'empty-icon', '◇'), node('span', '', message));
    target.replaceChildren(wrapper);
  }

  function badge(text, className) {
    return node('span', className, text);
  }

  function matchTitle(match) {
    return value(match.code);
  }

  function renderMatches() {
    const matches = list(snapshot.matches);
    const target = $('matchList');
    if (!matches.length) return empty(target, incomplete() ? '已知服务器暂无进行中的对局，其他服务器状态未知。' : '暂无进行中的对局，新房间出现后会自动显示。');
    const fragment = document.createDocumentFragment();
    matches.forEach((match, index) => {
      const card = node('button', 'match-card');
      card.type = 'button';
      card.setAttribute('aria-label', `查看${match.serverId ? `${serverName(match.serverId)} ` : ''}房间 ${matchTitle(match)} 详情`);
      const top = node('div', 'match-card-top');
      top.append(node('span', 'room-code', `# ${matchTitle(match)}`), badge(match.ranked ? '排位赛' : '进行中', match.ranked ? 'ranked-tag' : 'live-tag'));
      const tags = node('div', 'match-card-info');
      if (match.serverId) tags.append(badge(serverName(match.serverId), 'info-pill'));
      tags.append(badge(label(modeNames, match.mode), 'info-pill'), badge(`难度 ${label(difficultyNames, match.difficulty)}`, 'info-pill'), badge(`第 ${value(match.round)} 回合`, 'info-pill'));
      const bottom = node('div', 'match-card-bottom');
      bottom.append(node('span', '', `${list(match.players).length} 位参战 · ${label(phaseNames, match.phase)}`), node('span', 'view-detail', '查看详情 ↗'));
      card.append(top, tags, bottom);
      card.addEventListener('click', () => openMatch(index));
      fragment.append(card);
    });
    target.replaceChildren(fragment);
  }

  function avatar(name, offline = false) {
    return node('span', `avatar${offline ? ' offline' : ''}`, Array.from(value(name))[0] || '?');
  }

  function renderOnline() {
    const online = list(snapshot.online);
    const term = $('onlineSearch').value.trim().toLocaleLowerCase();
    const matches = online.filter((player) => `${value(player.name)} ${value(player.roomCode)}`.toLocaleLowerCase().includes(term));
    const target = $('onlineList');
    if (!matches.length) return empty(target, term ? '没有找到匹配的在线玩家。' : incomplete() ? '已知服务器暂无在线玩家，其他服务器状态未知。' : '当前没有在线玩家。');
    const fragment = document.createDocumentFragment();
    matches.forEach((player) => {
      const row = node('article', 'player-row');
      const main = node('div', 'row-main');
      const text = node('div', 'row-text');
      text.append(node('div', 'row-title', value(player.name)), node('div', 'row-sub', `${player.serverId ? `${serverName(player.serverId)} · ` : ''}所在房间：${value(player.roomCode)}`));
      main.append(avatar(player.name), text);
      const side = node('div', 'row-side');
      side.append(node('div', 'status-label', '在线'));
      if (player.rankedLabel) side.append(node('div', 'row-sub', value(player.rankedLabel)));
      const kick = node('button', 'button button-danger kick-button', '踢下线');
      kick.type = 'button';
      kick.disabled = !player.targetId;
      kick.title = player.targetId ? '断开该玩家当前连接' : '等待服务器更新连接信息';
      kick.addEventListener('click', () => openKick(player));
      side.append(kick);
      row.append(main, side);
      fragment.append(row);
    });
    target.replaceChildren(fragment);
  }

  function renderPlayers() {
    const players = list(snapshot.players);
    const term = $('playerSearch').value.trim().toLocaleLowerCase();
    const matches = players.filter((player) => {
      if (playerFilter === 'online' && player.online !== true) return false;
      if (playerFilter === 'offline' && player.online !== false) return false;
      return value(player.name).toLocaleLowerCase().includes(term);
    });
    const target = $('playerList');
    if (!matches.length) return empty(target, players.length ? '没有符合条件的玩家。' : '还没有玩家档案。');
    const fragment = document.createDocumentFragment();
    matches.forEach((player) => {
      const row = node('article', 'player-row');
      const main = node('div', 'row-main');
      const text = node('div', 'row-text');
      text.append(node('div', 'row-title', value(player.name)), node('div', 'row-sub', `首次出现 ${dateLabel(player.firstSeen)} · 最近活跃 ${dateLabel(player.lastSeen)}`));
      main.append(avatar(player.name, player.online === false), text);
      const side = node('div', 'row-side');
      const status = player.online === true ? '在线' : player.online === false ? '离线' : '在线状态未知';
      side.append(node('div', `status-label${player.online === true ? '' : player.online === false ? ' offline' : ' unknown'}`, status));
      if (player.rankedLabel) side.append(node('div', 'row-sub', value(player.rankedLabel)));
      row.append(main, side);
      fragment.append(row);
    });
    target.replaceChildren(fragment);
  }

  function renderRanking() {
    const ranking = list(snapshot.ranking);
    const target = $('rankingList');
    if (!ranking.length) return empty(target, '暂无排名记录。');
    const fragment = document.createDocumentFragment();
    ranking.forEach((player, index) => {
      const row = node('article', 'ranking-row');
      const main = node('div', 'row-main');
      const text = node('div', 'row-text');
      text.append(node('div', 'row-title', value(player.name)), node('div', 'row-sub', `${value(player.label)} · ${numberLabel(player.wins)} 胜 / ${numberLabel(player.losses)} 负`));
      main.append(node('span', 'rank-number', String(player.position ?? index + 1).padStart(2, '0')), text);
      const points = node('div', 'rank-points', numberLabel(player.points));
      points.append(node('small', '', '积分'));
      row.append(main, points);
      fragment.append(row);
    });
    target.replaceChildren(fragment);
  }

  function meta(label, content) {
    const item = node('div', 'meta-item');
    item.append(node('span', 'meta-label', label), node('span', 'meta-value', content));
    return item;
  }

  function fillMatch(match) {
    $('dialogTitle').textContent = `房间 # ${matchTitle(match)}`;
    $('dialogSubtitle').textContent = `${match.serverId ? `${serverName(match.serverId)} · ` : ''}创建时间 ${dateLabel(match.startedAt)}`;
    $('dialogMeta').replaceChildren(
      meta('对局模式', label(modeNames, match.mode)), meta('游戏难度', label(difficultyNames, match.difficulty)),
      meta('当前回合', `第 ${value(match.round)} 回合`), meta('当前阶段', label(phaseNames, match.phase)),
      meta('对局类型', match.ranked ? '排位赛' : '普通对局')
    );
    const players = list(match.players);
    $('dialogPlayerCount').textContent = `${players.length} 位`;
    const fragment = document.createDocumentFragment();
    players.forEach((player) => {
      const row = node('div', 'dialog-player');
      row.append(node('span', 'dialog-player-name', `${value(player.name)}${player.isBot ? ' · 电脑' : ''}`), node('span', `dialog-player-state${player.connected ? ' connected' : ''}`, player.isBot ? '电脑玩家' : player.connected ? '已连接' : '未连接'));
      fragment.append(row);
    });
    if (!players.length) fragment.append(node('div', 'empty-state', '暂无参战玩家信息。'));
    $('dialogPlayers').replaceChildren(fragment);
  }

  function openMatch(index) {
    const match = list(snapshot?.matches)[index];
    if (!match) return;
    selectedRoom = { code: match.code, serverId: match.serverId };
    fillMatch(match);
    dialog.showModal();
  }

  function renderActiveTab() {
    if (activeTab === 'matches') renderMatches();
    else if (activeTab === 'online') renderOnline();
    else if (activeTab === 'players') renderPlayers();
    else if (activeTab === 'ranking') renderRanking();
  }

  function render() {
    const summary = snapshot.summary || {};
    for (const [key, id, description] of [['online', 'statOnline', '当前连接的玩家'], ['matches', 'statMatches', '活跃房间'], ['ranked', 'statRanked', '正在进行的排位']]) {
      $(id).textContent = totalLabel(key);
      $(`${id}Note`).textContent = incomplete() ? `已知小计 ${numberLabel(summary.known?.[key])}` : description;
    }
    $('statPlayers').textContent = numberLabel(summary.players);
    $('summaryStatus').textContent = incomplete() ? '双服合计未知 · 仅显示已知服务器明细' : list(snapshot.servers).length ? '双服数据完整 · 合计已同步' : '运行数据已同步';
    $('summaryStatus').dataset.state = incomplete() ? 'unknown' : 'complete';
    renderServers();
    $('updatedAt').textContent = `最近同步 ${dateLabel(snapshot.now)}`;
    $('matchCount').textContent = incomplete() ? `已知 ${numberLabel(summary.known?.matches)} 场 · 合计未知` : `${totalLabel('matches')} 场进行中`;
    $('matchTabCount').textContent = totalLabel('matches');
    $('onlineCount').textContent = incomplete() ? `已知 ${numberLabel(summary.known?.online)} 人 · 合计未知` : `${totalLabel('online')} 人在线`;
    $('onlineTabCount').textContent = totalLabel('online');
    $('playerCount').textContent = `${numberLabel(summary.players)} 位玩家`;
    $('rankingCount').textContent = `${list(snapshot.ranking).length} 位上榜`;
    renderActiveTab();
    if (dialog.open) {
      const match = list(snapshot.matches).find((item) => item.code === selectedRoom?.code && item.serverId === selectedRoom?.serverId);
      if (match) fillMatch(match);
      else dialog.close();
    }
  }

  function showBoot(message, retry) {
    $('bootMessage').textContent = message;
    $('bootRetry').hidden = !retry;
    display('boot');
  }

  async function loadState() {
    if (document.hidden) return;
    clearTimer();
    if (controller) controller.abort();
    const current = new AbortController();
    controller = current;
    if (authenticated) connection('sync', '正在同步');
    try {
      const response = await fetch('/api/state', { credentials: 'same-origin', cache: 'no-store', signal: current.signal });
      if (response.status === 401) {
        clearSession();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (current.signal.aborted) return;
      snapshot = data;
      authenticated = true;
      failures = 0;
      render();
      display('dashboard');
      connection('online', '实时连接');
    } catch (error) {
      if (current.signal.aborted) return;
      failures += 1;
      if (authenticated) connection('error', '连接中断 · 自动重试');
      else showBoot('暂时无法连接服务器，正在自动重试。', true);
    } finally {
      if (controller === current) {
        controller = null;
        if (!document.hidden && (authenticated || !bootView.hidden)) {
          const delay = failures ? Math.min(3000 * (2 ** Math.min(failures, 4)), 30000) : 10000;
          timer = setTimeout(loadState, delay);
        }
      }
    }
  }

  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $('loginButton');
    submit.disabled = true;
    $('loginError').hidden = true;
    try {
      const response = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('password').value })
      });
      if (!response.ok) {
        $('loginError').textContent = response.status === 401 ? '密码不正确，请重试。' : '登录暂不可用，请稍后重试。';
        $('loginError').hidden = false;
        return;
      }
      const result = await response.json();
      if (!result.ok) throw new Error('Login was not accepted');
      $('password').value = '';
      failures = 0;
      showBoot('正在加载实时数据…', false);
      await loadState();
    } catch {
      $('loginError').textContent = '无法连接服务器，请稍后重试。';
      $('loginError').hidden = false;
      display('login');
    } finally {
      submit.disabled = false;
    }
  });

  $('logoutButton').addEventListener('click', async () => {
    const button = $('logoutButton');
    button.disabled = true;
    stopPolling();
    try {
      const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      clearSession();
      $('password').focus();
    } catch {
      connection('error', '退出失败，请重试');
      if (!document.hidden) loadState();
    } finally {
      button.disabled = false;
    }
  });

  $('announcementReload').addEventListener('click', loadAnnouncement);
  $('announcementTitle').addEventListener('input', previewAnnouncement);
  $('announcementContent').addEventListener('input', previewAnnouncement);
  $('announcementForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (announcementBusy || !authenticated) return;
    const title = $('announcementTitle').value.trim(), content = $('announcementContent').value.trim();
    if (!title || !content || title.length > 80 || content.length > 3000) {
      feedback('announcementStatus', '请填写标题和正文；标题最多80字，正文最多3000字。', true); return;
    }
    announcementBusy = true;
    const version = sessionVersion;
    $('announcementPublish').disabled = $('announcementReload').disabled = true;
    feedback('announcementStatus', '正在发布公告…');
    try {
      const result = await operation('/api/announcement', { title, content });
      if (version !== sessionVersion) return;
      if (!result.ok) throw new Error('公告未发布成功，请重试。');
      announcementLoaded = true;
      $('announcementUpdated').textContent = `上次发布 ${dateLabel(result.announcement?.updatedAt)}`;
      feedback('announcementStatus', '公告已保存并发布；在线分区将收到更新通知。');
    } catch (error) { if (version === sessionVersion) feedback('announcementStatus', error.message, true); }
    finally { announcementBusy = false; $('announcementPublish').disabled = $('announcementReload').disabled = false; }
  });
  $('kickCancel').addEventListener('click', () => { if (!kickBusy) kickDialog.close(); });
  kickDialog.addEventListener('cancel', (event) => { if (kickBusy) event.preventDefault(); });
  kickDialog.addEventListener('close', () => { selectedPlayer = null; });
  $('kickConfirm').addEventListener('click', async () => {
    if (!selectedPlayer?.targetId || kickBusy || !authenticated) return;
    const player = selectedPlayer, version = sessionVersion;
    kickBusy = true;
    $('kickConfirm').disabled = $('kickCancel').disabled = true;
    feedback('kickStatus', '正在处理…');
    try {
      const target = { serverId: player.serverId || 'main', targetId: player.targetId };
      let result = await operation('/api/kick', target);
      if (version !== sessionVersion) return;
      for (let attempt = 0; result.status === 'pending' && attempt < 9; attempt++) {
        feedback('kickStatus', '请求已提交，正在等待所属服务器确认下线…');
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (version !== sessionVersion) return;
        result = await operation('/api/kick/status', target);
        if (version !== sessionVersion) return;
      }
      if (!result.ok || result.status !== 'kicked') throw new Error('尚未收到下线成功回执，请刷新在线列表确认。');
      kickDialog.close();
      feedback('operationStatus', `已断开 ${value(player.name)} 的当前连接。`);
      void loadState();
    } catch (error) { if (version === sessionVersion) feedback('kickStatus', error.message, true); }
    finally { kickBusy = false; $('kickConfirm').disabled = $('kickCancel').disabled = false; }
  });

  $('refreshButton').addEventListener('click', () => loadState());
  $('bootRetry').addEventListener('click', () => { showBoot('正在重新连接…', false); loadState(); });
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      activeTab = button.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach((tab) => {
        const active = tab.dataset.tab === activeTab;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== activeTab; });
      if (snapshot) renderActiveTab();
      if (activeTab === 'announcement' && !announcementLoaded) void loadAnnouncement();
    });
  });
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      playerFilter = button.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((filter) => {
        const active = filter.dataset.filter === playerFilter;
        filter.classList.toggle('active', active);
        filter.setAttribute('aria-pressed', String(active));
      });
      if (snapshot) renderPlayers();
    });
  });
  $('onlineSearch').addEventListener('input', () => { if (snapshot) renderOnline(); });
  $('playerSearch').addEventListener('input', () => { if (snapshot) renderPlayers(); });
  $('dialogClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { selectedRoom = null; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else if (authenticated || !bootView.hidden) {
      clearTimer();
      timer = setTimeout(loadState, Math.floor(Math.random() * 501));
    }
  });
  loadState();
})();
