/* MyBox 面板 —— 无构建步骤，直接跑。 */

const $ = (id) => document.getElementById(id);

let state = { settings: null, groups: [], policies: [], targets: [], nodes: [] };

/* --------------------------------------------------------------- 基础 */

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
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
  if (entry.pending) return '<span class="tag muted">测速中…</span>';
  if (entry.delay === null || entry.delay === undefined) return '<span class="tag err">超时</span>';
  const cls = entry.delay < 200 ? 'ok' : 'muted';
  return `<span class="tag ${cls}">${entry.delay} ms</span>`;
}

function renderNodeGroups() {
  const box = $('nodeGroups');
  if (!state.nodeGroups.length) {
    box.innerHTML = '<p class="note">内核没有返回任何分组。可能内核没在运行，或还没有部署配置。</p>';
    return;
  }
  box.innerHTML = state.nodeGroups.map((g) => `
    <div class="card" style="background:var(--surface-2);margin-bottom:10px">
      <div class="card-head">
        <h3>${escapeHtml(g.name)}</h3>
        <span class="tag">${GROUP_LABEL[g.type] || g.type}</span>
        <span class="tag muted">${g.members.length} 个成员</span>
        <div class="spacer"></div>
        <span class="note">当前：<strong>${escapeHtml(g.now || '—')}</strong></span>
      </div>
      <div class="list">
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
    </div>
  `).join('');
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

async function loadConnections() {
  try {
    const data = await api('/nodes/connections');
    const box = $('connList');
    if (!data.recent?.length) {
      box.innerHTML = '<p class="note">当前没有活动连接。</p>';
      return;
    }
    box.innerHTML = data.recent.map((c) => `
      <div class="item">
        <div class="grow">
          <div class="title">${escapeHtml(c.host || '(无域名)')}</div>
          <div class="sub">${escapeHtml(c.rule || '')} · ${escapeHtml(c.chain.join(' → '))}</div>
        </div>
        <span class="tag muted">${escapeHtml(c.network)}</span>
      </div>
    `).join('');
  } catch (err) {
    $('connList').innerHTML = `<p class="err-text">${escapeHtml(err.message)}</p>`;
  }
}

/* --------------------------------------------------------------- 加载 */

async function loadAll() {
  await Promise.all([loadOverview(), loadSubscriptions(), loadGroups(), loadPolicies(), loadSettings()]);
}

async function loadOverview() {
  try {
    const data = await api('/overview');
    $('brandVersion').textContent = data.kernel.version || '';
    $('statKernel').textContent = data.kernel.running ? '运行中' : (data.kernel.installed ? '已停止' : '未安装');
    $('statKernel').style.color = data.kernel.running ? 'var(--ok)' : 'var(--err)';
    $('statVersion').textContent = data.kernel.version || '—';
    $('statNodes').textContent = data.counts.nodes;
    $('statPolicies').textContent = `${data.counts.policiesEnabled} / ${data.counts.policies}`;

    const notes = [];
    if (data.platform?.label) notes.push(data.platform.label);
    if (data.dnsmasq?.takenOver) notes.push(`dnsmasq 已接管（${data.dnsmasq.confDir}）`);
    if (data.meta?.lastDeployAt) notes.push(`上次部署 ${new Date(data.meta.lastDeployAt).toLocaleString()}`);
    $('overviewNote').textContent = notes.join(' · ');

    // 给出下一步该干什么，别让用户对着空白页猜
    const hints = [];
    if (!data.counts.nodes) hints.push('还没有节点：去「订阅」页添加订阅并刷新');
    else if (!data.kernel.running) hints.push(`有 ${data.counts.nodes} 个节点但内核没在运行：去「设置」点「保存并部署」`);
    if (data.kernel.running && data.counts.nodes) hints.push('想换线路去「节点」页，点分组里的成员即可切换');
    $('overviewError').textContent = hints.length
      ? hints.join('　·　')
      : (data.meta?.lastDeployError ? `上次错误：${data.meta.lastDeployError}` : '');
    await loadKernelLog();
  } catch (err) {
    if (err.status === 401) return checkAuth();
    toast(err.message);
  }
}

async function loadKernelLog() {
  try {
    const { log } = await api('/kernel/log?lines=200');
    $('kernelLog').textContent = log || '（还没有日志）';
  } catch {
    /* 忽略 */
  }
}

async function loadSubscriptions() {
  const { subscriptions } = await api('/subscriptions');
  const list = $('subList');
  if (!subscriptions.length) {
    list.innerHTML = '<p class="note">还没有订阅。</p>';
    return;
  }
  list.innerHTML = subscriptions.map((s) => `
    <div class="item">
      <div class="grow">
        <div class="title">${escapeHtml(s.name)} <span class="tag muted">${s.nodeCount || 0} 节点</span></div>
        <div class="sub">${escapeHtml(s.url)}</div>
      </div>
      <button class="small" data-refresh="${s.id}">刷新</button>
      <button class="small danger" data-remove="${s.id}">删除</button>
    </div>
  `).join('');
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
  container.innerHTML = state.policies.map((p, i) => `
    <div class="card" data-policy="${i}">
      <div class="card-head">
        <h3>${escapeHtml(p.name)}</h3>
        <span class="tag muted">${escapeHtml(p.flipTag || '')}</span>
        <div class="spacer"></div>
        <span class="note" data-p-status="${i}">${p.enabled ? '已启用' : '已关闭'}</span>
        <label class="switch"><input type="checkbox" data-p-enabled="${i}" ${p.enabled ? 'checked' : ''}><span></span></label>
      </div>
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
  `).join('');
}

function renderSettings() {
  const s = state.settings;
  $('setTunStack').value = s.network.tun.stack || 'mixed';
  $('setTunMtu').value = s.network.tun.mtu || 0;
  $('setBypassPorts').value = s.network.bypassPorts || '';
  $('setIpv6').checked = Boolean(s.network.ipv6);
  $('setRejectQuic').checked = Boolean(s.network.rejectQuic);
  $('setAutoRedirect').checked = s.network.tun.autoRedirect !== false;
  $('setDirectBypass').checked = s.network.directBypass !== false;
  $('setDirectForNodes').checked = s.network.directForNodes !== false;
  $('setDnsMode').value = s.dns.mode;
  $('setDnsDirect').value = s.dns.direct === 'wan' ? '' : (s.dns.directAddress || '');
  $('setDnsProxy').value = s.dns.proxy || '';
  $('setFakeIp').checked = Boolean(s.dns.fakeIp);
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

  document.querySelectorAll('nav.tabs button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tab = btn.dataset.tab;
      if (tab === 'logout') {
        await api('/auth/logout', { method: 'POST' });
        location.reload();
        return;
      }
      document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('section.page').forEach((p) => p.classList.toggle('active', p.id === `page-${tab}`));
      // 节点页的数据依赖内核在跑，进页面时现拉
      if (tab === 'nodes') {
        await loadNodes();
        await loadConnections();
      }
    });
  });

  $('btnDeploy').addEventListener('click', (e) => doDeploy(e.currentTarget));
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

  // ---- 节点页
  $('btnReloadNodes').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    await loadNodes();
    toast('已刷新');
  }));
  $('btnTestAll').addEventListener('click', (e) => withBusy(e.currentTarget, testAll));
  $('btnReloadConns').addEventListener('click', (e) => withBusy(e.currentTarget, loadConnections));

  $('nodeGroups').addEventListener('click', async (e) => {
    const lat = e.target.dataset.latency;
    if (lat) {
      e.stopPropagation();
      await testLatency(lat);
      return;
    }
    const group = e.target.closest('[data-select-group]')?.dataset.selectGroup;
    const name = e.target.closest('[data-select-name]')?.dataset.selectName;
    if (group && name) await switchNode(group, name);
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

  $('btnSaveSettings').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const patch = {
      network: {
        ipv6: $('setIpv6').checked,
        rejectQuic: $('setRejectQuic').checked,
        directBypass: $('setDirectBypass').checked,
        directForNodes: $('setDirectForNodes').checked,
        bypassPorts: $('setBypassPorts').value.trim(),
        tun: {
          stack: $('setTunStack').value,
          mtu: Number($('setTunMtu').value) || 0,
          autoRedirect: $('setAutoRedirect').checked,
        },
      },
      dns: {
        mode: $('setDnsMode').value,
        direct: $('setDnsDirect').value.trim() ? 'custom' : 'wan',
        directAddress: $('setDnsDirect').value.trim(),
        proxy: $('setDnsProxy').value.trim() || '1.1.1.1',
        fakeIp: $('setFakeIp').checked,
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
    const idx = e.target.dataset.pRemove;
    if (idx === undefined) return;
    state.policies.splice(Number(idx), 1);
    renderPolicies();
  });
}

/* --------------------------------------------------------------- 启动 */

bindEvents();
checkAuth();
