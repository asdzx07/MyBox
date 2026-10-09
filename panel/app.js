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
    $('overviewError').textContent = data.meta?.lastDeployError ? `上次错误：${data.meta.lastDeployError}` : '';
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
        <span>${g.mode === 'dynamic' ? '关键词（逗号分隔，自动收编）' : '成员（逗号分隔）'}</span>
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
  $('setKernelVersion').value = s.kernel.version || '（未安装）';
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
    if (!confirm(`下载并安装官方 sing-box ${latest.version}？`)) return;
    await api('/kernel/install', { method: 'POST', body: { version: latest.version } });
    toast(`已安装 ${latest.version}`);
    await loadOverview();
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
