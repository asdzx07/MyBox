/* MyBox 面板 —— 无构建步骤，直接跑。 */

const $ = (id) => document.getElementById(id);

let state = { settings: null, groups: [], policies: [], targets: [], nodes: [] };

/* --------------------------------------------------------------- 基础 */

async function api(path, options = {}) {
  // 部署接口可能耗时数分钟，单独给更长的超时
  const timeoutMs = path === '/deploy' ? 300000 : 30000;
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function busy(button, on, label) {
  if (!button) return;
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = label || '处理中…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* --------------------------------------------------------------- 登录 */

let setupMode = false;

async function checkAuth() {
  const status = await api('/auth/status');
  if (!status.passwordSet) {
    setupMode = true;
    $('gateHint').textContent = '第一次使用，请设置面板密码';
    $('gateConfirmField').classList.remove('hidden');
    $('gateSubmit').textContent = '设置密码并进入';
  } else if (!status.authenticated) {
    setupMode = false;
    $('gateHint').textContent = '请输入面板密码';
    $('gateConfirmField').classList.add('hidden');
    $('gateSubmit').textContent = '进入';
  } else {
    return showApp();
  }
  $('gate').classList.remove('hidden');
}

async function submitGate() {
  const password = $('gatePassword').value;
  $('gateError').textContent = '';
  if (!password) return;

  if (setupMode) {
    if (password !== $('gateConfirm').value) {
      $('gateError').textContent = '两次输入不一致';
      return;
    }
    try {
      await api('/auth/setup', { method: 'POST', body: { password } });
    } catch (err) {
      $('gateError').textContent = err.message;
      return;
    }
  } else {
    try {
      await api('/auth/login', { method: 'POST', body: { password } });
    } catch (err) {
      $('gateError').textContent = err.message;
      return;
    }
  }
  $('gate').classList.add('hidden');
  await showApp();
}

function showApp() {
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
  return loadAll();
}

/* --------------------------------------------------------------- 节点 */

state.nodeGroups = [];
state.nodeList = [];
state.latency = {};
state.collapsed = {};

const GROUP_LABEL = { Selector: '手动选择', URLTest: '自动择优', Fallback: '故障转移', LoadBalance: '负载均衡' };

async function loadNodes() {
  try {
    const data = await api('/nodes/status');
    state.nodeGroups = data.groups || [];
    state.nodeList = data.nodes || [];
    renderNodeGroups();
    renderNodeList();
  } catch (err) {
    $('nodeGroups').innerHTML = `<p class="err-text">${escapeHtml(err.message)}</p>`;
    $('nodeList').innerHTML = '';
  }
}

function delayBadge(name) {
  const entry = state.latency[name];
  if (!entry) return '';
  if (entry.pending) return '<span class="lat na">测速中…</span>';
  if (entry.delay === null || entry.delay === undefined) return '<span class="lat bad">超时</span>';
  const cls = entry.delay < 200 ? 'good' : entry.delay < 500 ? 'mid' : 'bad';
  return `<span class="lat ${cls}">${entry.delay} ms</span>`;
}

function renderNodeGroups() {
  const box = $('nodeGroups');
  if (!state.nodeGroups.length) {
    box.innerHTML = '<p class="note">内核没有返回任何分组。可能内核没在运行，或还没有部署配置。</p>';
    return;
  }
  // 默认全部折叠：分组一多，全展开要滚很久才能看到下面的东西
  const collapsed = (name) => state.collapsed[name] !== false;

  box.innerHTML = state.nodeGroups.map((g) => {
    const isCollapsed = collapsed(g.name);
    return `
    <div class="card" style="background:var(--surface-2);margin-bottom:10px">
      <div class="card-head group-head" data-collapse="${escapeHtml(g.name)}" style="cursor:pointer;margin-bottom:${isCollapsed ? '0' : '12px'}">
        <span class="chevron">${isCollapsed ? '▸' : '▾'}</span>
        <h3>${escapeHtml(g.name)}</h3>
        <span class="tag">${GROUP_LABEL[g.type] || g.type}</span>
        <span class="tag muted">${g.members.length} 个成员</span>
        <div class="spacer"></div>
        <span class="note">当前：<strong>${escapeHtml(g.now || '—')}</strong></span>
      </div>
      <div class="list${isCollapsed ? ' hidden' : ''}">
        ${g.members.map((m) => `
          <div class="item" data-select-group="${escapeHtml(g.name)}" data-select-name="${escapeHtml(m)}"
               style="cursor:pointer;${m === g.now ? 'outline:1px solid var(--accent)' : ''}">
            <div class="grow">
              <div class="title">${m === g.now ? '● ' : ''}${escapeHtml(m)}</div>
            </div>
            ${delayBadge(m)}
            <button class="small" data-latency="${escapeHtml(m)}">测速</button>
          </div>
        `).join('')}
      </div>
    </div>`;
  }).join('');
}

function renderNodeList() {
  $('nodeCount').textContent = `${state.nodeList.length} 个`;
  const box = $('nodeList');
  if (!state.nodeList.length) {
    box.innerHTML = '<p class="note">没有节点。先在「订阅」页添加订阅并刷新，然后部署配置。</p>';
    return;
  }
  box.innerHTML = state.nodeList.map((n) => `
    <div class="item">
      <div class="grow">
        <div class="title">${escapeHtml(n.name)}</div>
        <div class="sub">${escapeHtml(n.type)}${n.udp ? ' · UDP' : ''}</div>
      </div>
      ${delayBadge(n.name)}
      <button class="small" data-latency="${escapeHtml(n.name)}">测速</button>
    </div>
  `).join('');
}

async function testLatency(name) {
  state.latency[name] = { pending: true };
  renderNodeGroups();
  renderNodeList();
  try {
    const r = await api(`/nodes/latency?name=${encodeURIComponent(name)}`);
    state.latency[name] = { delay: r.delay, error: r.error };
  } catch (err) {
    state.latency[name] = { delay: null, error: err.message };
  }
  renderNodeGroups();
  renderNodeList();
}

async function testAll() {
  const names = state.nodeList.map((n) => n.name);
  if (!names.length) return;
  names.forEach((n) => { state.latency[n] = { pending: true }; });
  renderNodeGroups();
  renderNodeList();
  toast(`正在测 ${names.length} 个节点…`);
  try {
    const { results } = await api('/nodes/latency/batch', { method: 'POST', body: { names } });
    Object.assign(state.latency, results);
  } catch (err) {
    toast(err.message);
  }
  renderNodeGroups();
  renderNodeList();
}

async function switchNode(group, name) {
  try {
    await api('/nodes/select', { method: 'PUT', body: { group, name } });
    const g = state.nodeGroups.find((x) => x.name === group);
    if (g) g.now = name;
    renderNodeGroups();
    toast(`${group} → ${name}`);
  } catch (err) {
    toast(err.message);
    await loadNodes();
  }
}

/* --------------------------------------------------------------- 加载 */

async function loadAll() {
  await Promise.all([loadOverview(), loadSubscriptions(), loadGroups(), loadPolicies(), loadSettings()]);
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function fmtSpeed(bps) {
  return fmtBytes(bps) + '/s';
}

let trafficTimer = null;
const trafficHist = { up: [], down: [] };
const HIST_LEN = 60;
async function loadTraffic() {
  try {
    const t = await api('/traffic');
    if (!t.ok) return;
    $('statUp').textContent = t.connected ? fmtSpeed(t.up) : '—';
    $('statDown').textContent = t.connected ? fmtSpeed(t.down) : '—';
    $('statTotalUp').textContent = fmtBytes(t.totalUp);
    $('statTotalDown').textContent = fmtBytes(t.totalDown);
    // 曲线
    trafficHist.up.push(t.connected ? t.up : 0);
    trafficHist.down.push(t.connected ? t.down : 0);
    if (trafficHist.up.length > HIST_LEN) trafficHist.up.shift();
    if (trafficHist.down.length > HIST_LEN) trafficHist.down.shift();
    drawTrafficChart();
  } catch {}
}

function drawTrafficChart() {
  const cv = $('trafficChart');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = 120;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(1, ...trafficHist.up, ...trafficHist.down);
  const draw = (data, color, fill) => {
    if (!data.length) return;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (HIST_LEN - 1)) * w;
      const y = h - 8 - (v / max) * (h - 20);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    if (fill) {
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, color + '44'); g.addColorStop(1, color + '00');
      ctx.fillStyle = g; ctx.fill();
    }
  };
  // 网格线
  ctx.strokeStyle = 'rgba(128,128,128,.12)'; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath(); ctx.moveTo(0, (h / 4) * i); ctx.lineTo(w, (h / 4) * i); ctx.stroke();
  }
  draw(trafficHist.down, '#a78bfa', true);
  draw(trafficHist.up, '#38bdf8', true);
}
function startTrafficPoll() {
  if (trafficTimer) return;
  loadTraffic();
  trafficTimer = setInterval(() => {
    if ($('page-overview').classList.contains('active')) loadTraffic();
  }, 2000);
}

async function loadOverview() {
  try {
    const data = await api('/overview');
    $('brandVersion').textContent = data.kernel.version || '';
    $('statKernel').textContent = data.kernel.running ? '运行中' : (data.kernel.installed ? '已停止' : '未安装');
    $('heroDot').className = 'dot ' + (data.kernel.running ? 'on' : 'off');
    $('statVersion').textContent = data.kernel.version || '—';
    $('statNodes').textContent = data.counts.nodes;
    $('statPolicies').textContent = `${data.counts.policiesEnabled} / ${data.counts.policies}`;

    const notes = [];
    if (data.platform?.label) notes.push(data.platform.label);
    if (data.dnsmasq?.takenOver) notes.push(`dnsmasq 已接管（${data.dnsmasq.confDir}）`);
    if (data.meta?.lastDeployAt) notes.push(`上次部署 ${new Date(data.meta.lastDeployAt).toLocaleString()}`);
    $('overviewNote').textContent = notes.join(' · ');

    // 只有真出问题时才提示，而且用琥珀色不用报错红——一切正常时这里必须空着，
    // 否则用户会以为系统坏了（之前那句"想换线路去节点页"就长得很像报错）。
    const problems = [];
    if (data.meta?.lastDeployError) problems.push(`上次部署出错：${data.meta.lastDeployError}`);
    if (!data.counts.nodes) problems.push('还没有节点，去「订阅」页添加订阅');
    else if (!data.kernel.running) problems.push(`有 ${data.counts.nodes} 个节点但内核没在运行，去「设置」点「保存并部署」`);
    const hint = $('overviewHint');
    hint.textContent = problems.join('　·　');
    hint.classList.toggle('hidden', problems.length === 0);

    await Promise.all([loadOverviewGroups(), updateConnBadge()]);
  } catch (err) {
    if (err.status === 401) return checkAuth();
    toast(err.message);
  }
}

/** 概览页左侧：节点组，下拉即切换。 */
async function loadOverviewGroups() {
  const box = $('overviewGroups');
  try {
    const data = await api('/nodes/status');
    state.nodeGroups = data.groups || [];
    if (!state.nodeGroups.length) {
      box.innerHTML = '<p class="mini-empty">内核没在运行，读不到节点组</p>';
      return;
    }
    box.innerHTML = `<div class="mini">${state.nodeGroups.map((g) => {
      const isSelector = g.type === 'Selector';
      const options = (g.members || [])
        .map((m) => `<option value="${escapeHtml(m)}"${m === g.now ? ' selected' : ''}>${escapeHtml(m)}</option>`)
        .join('');
      return `
        <div class="mini-row">
          <div class="grow">
            <div class="name">${escapeHtml(g.name)}</div>
            <div class="sub">${GROUP_LABEL[g.type] || g.type} · ${g.members.length} 个成员</div>
          </div>
          ${isSelector
            ? `<select data-ov-group="${escapeHtml(g.name)}">${options}</select>`
            : `<span class="tag">${escapeHtml(g.now || '测速中…')}</span>`}
        </div>`;
    }).join('')}</div>`;
  } catch (err) {
    box.innerHTML = `<p class="mini-empty">${escapeHtml(err.message)}</p>`;
  }
}

/** 连接页面：当前连接。 */
async function loadConnectionsPage() {
  const box = $('connsList');
  try {
    const data = await api('/nodes/connections');
    const n = data.total || 0;
    $('connPageCount').textContent = n ? `${n} 条` : '';
    const badge = $('sbConnCount');
    badge.textContent = n;
    badge.classList.toggle('hidden', !n);
    if (!data.recent?.length) {
      box.innerHTML = '<p class="mini-empty">当前没有活动连接</p>';
      return;
    }
    box.innerHTML = `<div class="mini">${data.recent.map((c) => `
      <div class="mini-row">
        <div class="grow">
          <div class="name">${escapeHtml(c.host || '(无域名)')}</div>
          <div class="sub">${escapeHtml([...c.chain].reverse().join(' → '))}${c.rule ? ` · ${escapeHtml(c.rule)}` : ''}</div>
        </div>
        <span class="tag muted">${escapeHtml(c.network || '')}</span>
      </div>`).join('')}</div>`;
  } catch (err) {
    box.innerHTML = `<p class="mini-empty">${escapeHtml(err.message)}</p>`;
  }
}

/** 仅更新侧边栏连接数徽标（概览页用）。 */
async function updateConnBadge() {
  try {
    const data = await api('/nodes/connections');
    const n = data.total || 0;
    const badge = $('sbConnCount');
    badge.textContent = n;
    badge.classList.toggle('hidden', !n);
  } catch { /* 忽略 */ }
}

/** 侧边栏订阅组列表。 */
async function loadSbSubGroups() {
  const box = $('sbSubGroups');
  try {
    const subs = await api('/subscriptions');
    box.innerHTML = (subs || []).map((s) => `
      <button data-sub="${escapeHtml(s.id)}"><span class="ic">📄</span>${escapeHtml(s.name || s.id)}</button>
    `).join('');
    box.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('aside.sidebar button[data-tab]').forEach((b) => b.classList.remove('active'));
        document.querySelector('aside.sidebar button[data-tab="subscriptions"]').classList.add('active');
        document.querySelectorAll('section.page').forEach((p) => p.classList.toggle('active', p.id === 'page-subscriptions'));
        loadSubscriptions();
      });
    });
  } catch { box.innerHTML = ''; }
}

let rawKernelLog = '';
async function loadKernelLog() {
  try {
    const { log } = await api('/kernel/log?lines=200');
    rawKernelLog = log || '';
    filterKernelLog();
  } catch {
    /* 忽略 */
  }
}

/** 日志搜索过滤 */
function filterKernelLog() {
  const q = ($('logSearch').value || '').trim().toLowerCase();
  if (!q) {
    $('kernelLog').textContent = rawKernelLog || '（还没有日志）';
    return;
  }
  const lines = rawKernelLog.split('\n').filter((l) => l.toLowerCase().includes(q));
  $('kernelLog').textContent = lines.length ? lines.join('\n') : '（没有匹配的日志）';
}

let logTimer = null;
const LOG_REFRESH_MS = 5000;

/** 日志自动刷新：只在「日志」页可见且勾了自动时跑，离开就停，别白打请求。 */
function scheduleLogAuto() {
  clearInterval(logTimer);
  logTimer = null;
  if (!$('page-logs').classList.contains('active') || !$('logAuto').checked) return;
  logTimer = setInterval(() => {
    if ($('page-logs').classList.contains('active')) loadKernelLog();
    else scheduleLogAuto();
  }, LOG_REFRESH_MS);
}

async function loadSubscriptions() {
  const { subscriptions } = await api('/subscriptions');
  const list = $('subList');
  if (!subscriptions.length) {
    list.innerHTML = '<p class="note">还没有订阅。</p>';
    return;
  }
  list.innerHTML = subscriptions.map((s) => {
    const on = s.enabled !== false;
    return `
    <div class="item">
      <label class="switch" title="${on ? '点击停用' : '点击启用'}">
        <input type="checkbox" data-sub-toggle="${escapeHtml(s.id)}"${on ? ' checked' : ''}><span></span>
      </label>
      <div class="grow">
        <div class="title">
          ${escapeHtml(s.name)}
          <span class="tag muted">${s.nodeCount || 0} 节点</span>
          ${on ? '' : '<span class="tag err">已停用</span>'}
        </div>
        <div class="sub">${escapeHtml(s.url)}</div>
      </div>
      <button class="small" data-refresh="${escapeHtml(s.id)}">刷新</button>
      <button class="small danger" data-remove="${escapeHtml(s.id)}">删除</button>
    </div>`;
  }).join('');

  const off = subscriptions.filter((s) => s.enabled === false).length;
  $('subSwitchNote').textContent = off
    ? `有 ${off} 条订阅已停用，它的节点不会进配置（改完记得「保存并部署」）。`
    : '开关控制这条订阅的节点是否进配置。停用后要「保存并部署」才生效。';
  // 同步侧边栏订阅组
  loadSbSubGroups();
}

async function loadGroups() {
  const data = await api('/groups');
  state.groups = data.groups;
  state.nodes = data.availableNodes;
  renderGroups();
}

async function loadPolicies() {
  const data = await api('/policies');
  state.policies = data.policies;
  state.targets = data.targets;
  renderPolicies();
  loadRulesetSubs();
}

async function loadRulesetSubs() {
  const { items } = await api('/ruleset-subs');
  const el = $('rulesetSubList');
  if (!items.length) {
    el.innerHTML = '<p class="note">还没有自定义规则集。</p>';
    return;
  }
  el.innerHTML = items.map((r) => `
    <div class="row" style="align-items:center;gap:8px;margin-bottom:8px">
      <label class="switch"><input type="checkbox" data-rs-enabled="${r.id}" ${r.enabled ? 'checked' : ''}><span></span></label>
      <code>${escapeHtml(r.tag)}</code>
      <span class="note" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.url)}</span>
      <span class="tag">${r.format}</span>
      <button class="small danger" data-rs-del="${r.id}">删</button>
    </div>
  `).join('');
}

async function loadSettings() {
  state.settings = await api('/settings');
  renderSettings();
}

/* --------------------------------------------------------------- 渲染 */

function renderGroups() {
  const container = $('groupList');
  if (!state.groups.length) {
    container.innerHTML = '<div class="card"><p class="note">还没有分组。</p></div>';
    return;
  }
  container.innerHTML = state.groups.map((g, i) => `
    <div class="card" data-group="${i}">
      <div class="card-head">
        <h3>${escapeHtml(g.name)}</h3>
        <span class="tag">${g.type === 'urltest' ? '自动择优' : '手动选择'}</span>
        ${g.mode === 'dynamic' ? '<span class="tag muted">动态</span>' : ''}
        <div class="spacer"></div>
        <label class="switch"><input type="checkbox" data-g-enabled="${i}" ${g.enabled ? 'checked' : ''}><span></span></label>
      </div>
      <label class="field">
        <span>名称</span>
        <input data-g-name="${i}" value="${escapeHtml(g.name)}">
      </label>
      ${g.type === 'urltest' ? `
        <div class="row">
          <label class="field"><span>测速间隔</span><input data-g-interval="${i}" value="${escapeHtml(g.interval || '300s')}"></label>
          <label class="field"><span>容差 (ms)</span><input type="number" data-g-tolerance="${i}" value="${Number(g.tolerance) || 100}"></label>
        </div>` : ''}
      <label class="field">
        <span>${g.mode === 'dynamic' ? '关键词（逗号分隔；留空 = 收编全部节点）' : '成员（逗号分隔）'}</span>
        <input data-g-members="${i}" value="${escapeHtml((g.mode === 'dynamic' ? g.keywords : g.members).join(', '))}">
      </label>
      <p class="note">可用节点：${state.nodes.length ? escapeHtml(state.nodes.slice(0, 12).join('、')) + (state.nodes.length > 12 ? ` …等 ${state.nodes.length} 个` : '') : '（还没有节点）'}</p>
    </div>
  `).join('');
}

function renderPolicies() {
  const container = $('policyList');
  if (!state.policies.length) {
    container.innerHTML = '<div class="card"><p class="note">还没有策略。</p></div>';
    return;
  }
  container.innerHTML = state.policies.map((p, i) => {
    const collapsed = localStorage.getItem(`mybox-policy-collapsed-${i}`) === '1';
    return `
    <div class="card" data-policy="${i}">
      <div class="card-head">
        <button class="small" data-p-collapse="${i}" title="${collapsed ? '展开' : '折叠'}">${collapsed ? '▶' : '▼'}</button>
        <h3>${escapeHtml(p.name)}</h3>
        <span class="tag muted">${escapeHtml(p.flipTag || '')}</span>
        <div class="spacer"></div>
        <span class="note" data-p-status="${i}">${p.enabled ? '已启用' : '已关闭'}</span>
        <label class="switch"><input type="checkbox" data-p-enabled="${i}" ${p.enabled ? 'checked' : ''}><span></span></label>
      </div>
      <div data-p-body="${i}" style="${collapsed ? 'display:none' : ''}">
      <div class="row">
        <label class="field"><span>名称</span><input data-p-name="${i}" value="${escapeHtml(p.name)}"></label>
        <label class="field"><span>出口</span>
          <select data-p-target="${i}">
            ${state.targets.map((t) => `<option value="${escapeHtml(t.value)}" ${t.value === p.target ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}
          </select>
        </label>
      </div>
      <label class="field"><span>规则集（逗号分隔）</span><input data-p-rulesets="${i}" value="${escapeHtml((p.rulesets || []).join(', '))}"></label>
      <label class="field"><span>域名（逗号分隔）</span><input data-p-domain="${i}" value="${escapeHtml((p.domain || []).join(', '))}"></label>
      <label class="field"><span>域名后缀（逗号分隔）</span><input data-p-suffix="${i}" value="${escapeHtml((p.domainSuffix || []).join(', '))}"></label>
      <button class="small danger" data-p-remove="${i}">删除这条策略</button>
      </div>
    </div>
  `;}).join('');
}

function renderSettings() {
  const s = state.settings;
  // 面板版本号（不阻塞，失败就显示 unknown）
  api('/system/version').then((v) => {
    $('sysVersion').textContent = v.current || 'unknown';
  }).catch(() => {
    $('sysVersion').textContent = 'unknown';
  });
  $('setIpv6').checked = Boolean(s.network.ipv6);
  $('setRejectQuic').checked = Boolean(s.network.rejectQuic);
  $('setAutoRedirect').checked = s.network.tun.autoRedirect !== false;
  $('setDirectBypass').checked = s.network.directBypass !== false;
  $('setDirectForNodes').checked = s.network.directForNodes !== false;
  $('setDnsMode').value = s.dns.mode;
  $('setDnsDirect').value = s.dns.direct === 'wan' ? '' : (s.dns.directAddress || '');
  $('setDnsProxy').value = s.dns.proxy || '';
  $('setFakeIp').checked = Boolean(s.dns.fakeIp);
  $('setAdblock').checked = Boolean(s.dns.adblock);
  $('setAdblockAllow').value = (s.dns.adblockAllow || []).join('\n');
  $('setAdblockCustom').value = (s.dns.adblockCustom || []).join('\n');
  $('setKernelVersion').value = s.kernel.installed
    ? (s.kernel.version ? `已安装 ${s.kernel.version}` : '已安装（版本未知）')
    : '（未安装）';
  $('setLogLevel').value = s.kernel.logLevel || 'warn';
}

/* --------------------------------------------------------------- 动作 */

async function withBusy(button, fn) {
  busy(button, true);
  try {
    await fn();
  } catch (err) {
    toast(err.message);
  } finally {
    busy(button, false);
  }
}

async function doDeploy(button) {
  await withBusy(button, async () => {
    const report = await api('/deploy', { method: 'POST', body: { restart: true } });
    const warns = report.warnings?.length ? `（${report.warnings.length} 条提示）` : '';
    toast(`部署完成${warns}`);
    if (report.warnings?.length) console.warn('部署提示：', report.warnings);
    await loadOverview();
  });
}

/* --------------------------------------------------------------- 事件 */

function bindEvents() {
  $('gateSubmit').addEventListener('click', submitGate);
  $('gatePassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGate(); });
  $('gateConfirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGate(); });

  document.querySelectorAll('aside.sidebar nav.sb-nav button, .sb-foot button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tab = btn.dataset.tab;
      if (tab === 'logout') {
        await api('/auth/logout', { method: 'POST' });
        location.reload();
        return;
      }
      document.querySelectorAll('aside.sidebar button[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('section.page').forEach((p) => p.classList.toggle('active', p.id === `page-${tab}`));
      // 节点页的数据依赖内核在跑，进页面时现拉
      if (tab === 'nodes') await loadNodes();
      if (tab === 'logs') await loadKernelLog();
      if (tab === 'connections') await loadConnectionsPage();
      if (tab === 'subscriptions') await loadSubscriptions();
      scheduleLogAuto();
    });
  });

  $('btnDeploy').addEventListener('click', (e) => doDeploy(e.currentTarget));
  $('btnTrafficReset').addEventListener('click', async () => {
    await api('/traffic/reset', { method: 'POST' });
    toast('流量统计已清零');
    loadTraffic();
  });
  startTrafficPoll();
  $('btnRestart').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    await api('/kernel/restart', { method: 'POST' });
    toast('内核已重启');
    await loadOverview();
  }));
  $('btnStop').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    await api('/kernel/stop', { method: 'POST' });
    toast('内核已停止');
    await loadOverview();
  }));
  $('btnLog').addEventListener('click', loadKernelLog);
  $('logAuto').addEventListener('change', scheduleLogAuto);
  $('logSearch').addEventListener('input', filterKernelLog);
  $('btnAdblockRefresh').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const r = await api('/adblock/refresh', { method: 'POST' });
    toast(r.ok ? '广告规则集已更新，内核已重启' : ('更新失败：' + (r.error || '未知错误')));
  }));

  // ---- 概览页的节点组 / 当前连接
  $('btnOverviewNodes').addEventListener('click', (e) => withBusy(e.currentTarget, loadOverviewGroups));
  $('btnConnsRefresh').addEventListener('click', (e) => withBusy(e.currentTarget, loadConnectionsPage));

  $('overviewGroups').addEventListener('change', async (e) => {
    const group = e.target.dataset.ovGroup;
    if (!group) return;
    await switchNode(group, e.target.value);
    await loadOverviewGroups();
  });

  // ---- 节点页
  $('btnReloadNodes').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    await loadNodes();
    toast('已刷新');
  }));
  $('btnTestAll').addEventListener('click', (e) => withBusy(e.currentTarget, testAll));

  $('nodeGroups').addEventListener('click', async (e) => {
    const lat = e.target.dataset.latency;
    if (lat) {
      e.stopPropagation();
      await testLatency(lat);
      return;
    }
    // 点组标题折叠/展开
    const collapseName = e.target.closest('[data-collapse]')?.dataset.collapse;
    if (collapseName !== undefined) {
      const nowCollapsed = state.collapsed[collapseName] !== false;
      state.collapsed[collapseName] = !nowCollapsed;
      renderNodeGroups();
      return;
    }
    const group = e.target.closest('[data-select-group]')?.dataset.selectGroup;
    const name = e.target.closest('[data-select-name]')?.dataset.selectName;
    if (group && name) await switchNode(group, name);
  });

  $('btnCollapseAll').addEventListener('click', () => {
    const anyExpanded = state.nodeGroups.some((g) => state.collapsed[g.name] === false);
    for (const g of state.nodeGroups) state.collapsed[g.name] = anyExpanded;
    renderNodeGroups();
    toast(anyExpanded ? '已全部折叠' : '已全部展开');
  });

  $('nodeList').addEventListener('click', async (e) => {
    const lat = e.target.dataset.latency;
    if (lat) await testLatency(lat);
  });

  $('btnAddSub').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const url = $('subUrl').value.trim();
    if (!url) throw new Error('请填写订阅地址');
    const result = await api('/subscriptions', { method: 'POST', body: { name: $('subName').value.trim(), url } });
    $('subUrl').value = '';
    $('subName').value = '';
    toast(`已解析 ${result.nodeCount ?? 0} 个节点`);
    await Promise.all([loadSubscriptions(), loadOverview()]);
  }));

  $('btnRefreshSubs').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const { subscriptions } = await api('/subscriptions');
    let total = 0;
    for (const s of subscriptions) {
      try {
        const r = await api(`/subscriptions/${s.id}/refresh`, { method: 'POST' });
        total += r.nodeCount || 0;
      } catch (err) {
        toast(`${s.name} 刷新失败：${err.message}`);
      }
    }
    toast(`共 ${total} 个节点`);
    await Promise.all([loadSubscriptions(), loadOverview()]);
  }));

  // 订阅启用/停用
  $('subList').addEventListener('change', async (e) => {
    const id = e.target.dataset.subToggle;
    if (!id) return;
    const enabled = e.target.checked;
    try {
      await api(`/subscriptions/${encodeURIComponent(id)}`, { method: 'PUT', body: { enabled } });
      toast(enabled ? '已启用，记得「保存并部署」' : '已停用，记得「保存并部署」');
      await loadSubscriptions();
    } catch (err) {
      e.target.checked = !enabled;
      toast(err.message);
    }
  });

  $('subList').addEventListener('click', async (e) => {
    const refreshId = e.target.dataset.refresh;
    const removeId = e.target.dataset.remove;
    if (refreshId) {
      await withBusy(e.target, async () => {
        const r = await api(`/subscriptions/${refreshId}/refresh`, { method: 'POST' });
        toast(`已解析 ${r.nodeCount} 个节点`);
        await Promise.all([loadSubscriptions(), loadOverview()]);
      });
    }
    if (removeId) {
      if (!confirm('删除这条订阅及其节点？')) return;
      await api(`/subscriptions/${removeId}`, { method: 'DELETE' });
      await Promise.all([loadSubscriptions(), loadOverview()]);
    }
  });

  $('btnAddGroup').addEventListener('click', () => {
    state.groups.push({
      id: 'g' + Date.now().toString(36),
      name: '新分组',
      mode: 'manual',
      members: [],
    });
    renderGroups();
    toast('已添加，编辑后点「保存分组」');
  });

  $('btnSaveGroups').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    await api('/groups', { method: 'PUT', body: { groups: state.groups } });
    toast('分组已保存，记得部署');
  }));

  $('btnSavePolicies').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    await api('/policies', { method: 'PUT', body: { policies: state.policies } });
    toast('策略已保存，记得部署');
  }));

  $('btnAddPolicy').addEventListener('click', () => {
    state.policies.push({ id: `pol-${Math.random().toString(16).slice(2, 10)}`, name: '新策略', enabled: true, rulesets: [], domain: [], domainSuffix: [], ipCidr: [], target: 'all-auto' });
    renderPolicies();
  });

  $('btnResetPolicies').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    if (!confirm('恢复成默认策略？你自己加的策略会被删掉，出口选择也会重置。')) return;
    const r = await api('/policies/reset', { method: 'POST' });
    state.policies = r.policies;
    await loadPolicies();
    toast('已恢复默认策略，记得「保存并部署」');
  }));
  $('btnRefreshRulesets').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const r = await api('/rulesets/refresh', { method: 'POST' });
    toast(r.ok ? `规则集已更新（删了 ${r.deleted} 个缓存），内核已重启` : ('更新失败：' + (r.error || '未知错误')));
  }));
  $('btnAddRulesetSub').addEventListener('click', async () => {
    const tag = prompt('规则集 tag（在策略里引用，如 my-rules）：');
    if (!tag) return;
    const url = prompt('规则集 URL（.srs 或 .json）：');
    if (!url) return;
    const format = confirm('是 binary（.srs）格式吗？点"确定"=binary，点"取消"=source（.json）') ? 'binary' : 'source';
    const r = await api('/ruleset-subs', { method: 'POST', body: JSON.stringify({ tag, url, format }) });
    if (r.ok) { toast('已添加，记得「保存并部署」'); loadRulesetSubs(); }
    else toast('添加失败：' + (r.error || '未知错误'));
  });
  $('rulesetSubList').addEventListener('change', async (e) => {
    const id = e.target.dataset.rsEnabled;
    if (!id) return;
    await api(`/ruleset-subs/${id}`, { method: 'PUT', body: JSON.stringify({ enabled: e.target.checked }) });
    toast('已' + (e.target.checked ? '启用' : '停用') + '，记得「保存并部署」');
  });
  $('rulesetSubList').addEventListener('click', async (e) => {
    const id = e.target.dataset.rsDel;
    if (!id) return;
    if (!confirm('删除这个规则集订阅？')) return;
    await api(`/ruleset-subs/${id}`, { method: 'DELETE' });
    loadRulesetSubs();
    toast('已删除，记得「保存并部署」');
  });

  $('btnSaveSettings').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const patch = {
      network: {
        ipv6: $('setIpv6').checked,
        rejectQuic: $('setRejectQuic').checked,
        directBypass: $('setDirectBypass').checked,
        directForNodes: $('setDirectForNodes').checked,
        tun: {
          autoRedirect: $('setAutoRedirect').checked,
        },
      },
      dns: {
        mode: $('setDnsMode').value,
        direct: $('setDnsDirect').value.trim() ? 'custom' : 'wan',
        directAddress: $('setDnsDirect').value.trim(),
        proxy: $('setDnsProxy').value.trim() || '1.1.1.1',
        fakeIp: $('setFakeIp').checked,
        adblock: $('setAdblock').checked,
        adblockAllow: $('setAdblockAllow').value.split('\n').map((s) => s.trim()).filter(Boolean),
        adblockCustom: $('setAdblockCustom').value.split('\n').map((s) => s.trim()).filter(Boolean),
      },
      kernel: { logLevel: $('setLogLevel').value },
    };
    await api('/settings', { method: 'PUT', body: patch });
    await api('/deploy', { method: 'POST', body: { restart: true } });
    toast('已保存并部署');
    await loadAll();
  }));

  $('btnCheckUpdate').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const latest = await api('/kernel/latest');
    $('kernelUpdateNote').textContent = `最新 ${latest.version}（${new Date(latest.publishedAt).toLocaleDateString()}）`;
  }));

  // 面板版本检查与更新
  $('btnCheckSysUpdate').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const v = await api('/system/version');
    $('sysVersion').textContent = v.current || 'unknown';
    if (v.hasUpdate) {
      $('sysUpdateHint').textContent = `有新版本 ${v.latest} 可更新`;
      $('btnSysUpdate').style.display = '';
    } else if (v.latest) {
      $('sysUpdateHint').textContent = '已是最新';
      $('btnSysUpdate').style.display = 'none';
    } else {
      $('sysUpdateHint').textContent = '检查失败（网络问题）';
    }
  }));
  $('btnSysUpdate').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    if (!confirm('确定更新面板？更新过程中面板会重启，请稍后手动刷新页面。')) return;
    const r = await api('/system/update', { method: 'POST' });
    toast(r.message || '更新已开始');
  }));

  $('btnInstallKernel').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const latest = await api('/kernel/latest');
    const current = state.settings?.kernel?.version;
    const msg = current && current === latest.version
      ? `当前已经是 ${latest.version}，仍要重新下载安装吗？`
      : `下载并安装官方 sing-box ${latest.version}？（约 30 MB，装完会自动重启内核）`;
    if (!confirm(msg)) return;
    $('kernelUpdateNote').textContent = '正在下载…这一步可能要一两分钟';
    try {
      const info = await api('/kernel/install', { method: 'POST', body: { version: latest.version } });
      $('kernelUpdateNote').textContent = `已安装 ${info.version}${info.restarted ? '，内核已重启' : ''}`;
      toast(`内核已更新到 ${info.version}`);
      await Promise.all([loadSettings(), loadOverview()]);
    } catch (err) {
      $('kernelUpdateNote').textContent = `安装失败：${err.message}`;
      toast('内核安装失败');
    }
  }));

  // 分组表单
  $('groupList').addEventListener('input', (e) => {
    const t = e.target;
    const readIdx = (attr) => (t.dataset[attr] !== undefined ? Number(t.dataset[attr]) : null);
    let i = readIdx('gName');
    if (i !== null) { state.groups[i].name = t.value; return; }
    i = readIdx('gMembers');
    if (i !== null) {
      const parts = t.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (state.groups[i].mode === 'dynamic') state.groups[i].keywords = parts;
      else state.groups[i].members = parts;
      return;
    }
    i = readIdx('gInterval');
    if (i !== null) { state.groups[i].interval = t.value; return; }
    i = readIdx('gTolerance');
    if (i !== null) { state.groups[i].tolerance = Number(t.value) || 100; }
  });
  $('groupList').addEventListener('change', (e) => {
    const t = e.target;
    const i = t.dataset.gEnabled !== undefined ? Number(t.dataset.gEnabled) : null;
    if (i !== null) state.groups[i].enabled = t.checked;
  });

  // 策略表单
  $('policyList').addEventListener('input', (e) => {
    const t = e.target;
    const set = (attr, fn) => { if (t.dataset[attr] !== undefined) { fn(Number(t.dataset[attr]), t.value); return true; } return false; };
    if (set('pName', (i, v) => { state.policies[i].name = v; })) return;
    if (set('pRulesets', (i, v) => { state.policies[i].rulesets = v.split(',').map((s) => s.trim()).filter(Boolean); })) return;
    if (set('pDomain', (i, v) => { state.policies[i].domain = v.split(',').map((s) => s.trim()).filter(Boolean); })) return;
    if (set('pSuffix', (i, v) => { state.policies[i].domainSuffix = v.split(',').map((s) => s.trim()).filter(Boolean); })) return;
    set('pTarget', (i, v) => { state.policies[i].target = v; });
  });

  // 策略开关：只改小文件，不重新部署
  $('policyList').addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.pEnabled === undefined) return;
    const i = Number(t.dataset.pEnabled);
    const policy = state.policies[i];
    policy.enabled = t.checked;
    const status = document.querySelector(`[data-p-status="${i}"]`);
    try {
      await api(`/policies/${encodeURIComponent(policy.id)}/toggle`, { method: 'POST', body: { enabled: t.checked } });
      if (status) status.textContent = t.checked ? '已启用' : '已关闭';
      toast(t.checked ? `「${policy.name}」已启用（未重启内核）` : `「${policy.name}」已关闭（未重启内核）`);
    } catch (err) {
      t.checked = !t.checked;
      policy.enabled = !t.checked;
      toast(err.message);
    }
  });

  $('policyList').addEventListener('click', (e) => {
    // 折叠/展开
    const cIdx = e.target.dataset.pCollapse;
    if (cIdx !== undefined) {
      const key = `mybox-policy-collapsed-${cIdx}`;
      const nowCollapsed = localStorage.getItem(key) !== '1';
      localStorage.setItem(key, nowCollapsed ? '1' : '0');
      const body = document.querySelector(`[data-p-body="${cIdx}"]`);
      if (body) body.style.display = nowCollapsed ? 'none' : '';
      e.target.textContent = nowCollapsed ? '▶' : '▼';
      e.target.title = nowCollapsed ? '展开' : '折叠';
      return;
    }
    const idx = e.target.dataset.pRemove;
    if (idx === undefined) return;
    state.policies.splice(Number(idx), 1);
    renderPolicies();
  });
}

/* --------------------------------------------------------------- 启动 */

bindEvents();
checkAuth();
