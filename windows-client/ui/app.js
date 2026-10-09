let localState = {
  connected: false,
  gatewayIp: '192.168.3.2',
  gatewayPort: 3036,
  latency: null,
  activeInterface: {},
};

let remoteData = {
  overview: {},
  groups: [],
  policies: [],
  connections: [],
};

let trafficHistory = {
  up: new Array(12).fill(0),
  down: new Array(12).fill(0),
};

let connDurationSec = 0;
let connTimer = null;

function $(id) { return document.getElementById(id); }

function toast(msg) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function fmtRate(bps) {
  return `${fmtBytes(bps)}/s`;
}

/* ------------------------------------------------------------- API 请求 */

async function fetchLocal(url, options = {}) {
  const res = await fetch(url, options);
  return await res.json();
}

async function fetchRemote(path, options = {}) {
  try {
    const res = await fetch(`/remote-api${path}`, options);
    if (res.status === 401) {
      showAuthModal();
      throw new Error('unauthorized');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (err.message === 'unauthorized') {
      showAuthModal();
    }
    console.warn(`请求远程 API 失败 [${path}]:`, err.message);
    throw err;
  }
}

/* ------------------------------------------------------------- 身份认证模态框 */

function showAuthModal() {
  const modal = $('authModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const errEl = $('authModalError');
  if (errEl) errEl.classList.add('hidden');
  setTimeout(() => $('authModalPassword')?.focus(), 80);
}

function hideAuthModal() {
  const modal = $('authModal');
  if (modal) modal.classList.add('hidden');
}

async function doLogin(password) {
  if (!password) {
    toast('请输入管理密码');
    return false;
  }
  try {
    toast('正在验证密码并登录旁路由...');
    const res = await fetch('/remote-api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || '密码错误');
    }
    // 登录成功，同步给本地服务持久化保存
    await fetchLocal('/api/local/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    hideAuthModal();
    toast('认证成功！节点已同步就绪');
    await loadGroups();
    await loadPolicies();
    await loadConnections();
    return true;
  } catch (err) {
    const errEl = $('authModalError');
    if (errEl) {
      errEl.textContent = `登录失败: ${err.message}`;
      errEl.classList.remove('hidden');
    }
    toast(`登录失败: ${err.message}`);
    return false;
  }
}

/* ------------------------------------------------------------- 状态同步 */

async function syncLocalStatus() {
  try {
    const data = await fetchLocal('/api/local/status');
    if (data.ok) {
      localState.connected = data.connected;
      localState.gatewayIp = data.gatewayIp;
      localState.gatewayPort = data.gatewayPort;
      localState.latency = data.latency;
      localState.activeInterface = data.interface || {};
      if ($('cfgAutoConnect') && data.autoConnect !== undefined) {
        $('cfgAutoConnect').checked = !!data.autoConnect;
      }
      renderStatusUI();
    }
  } catch (err) {
    console.error('获取本地状态失败:', err);
  }
}

function renderStatusUI() {
  const capsule = $('topCapsule');
  const capsuleTime = $('capsuleTime');
  const gwTitle = $('gwTitle');
  const gwDesc = $('gwDesc');
  const btnGw = $('btnToggleGw');
  const btnGwText = $('btnGwText');

  $('infoGwIp').textContent = localState.gatewayIp || '192.168.3.2';
  $('infoLocalIp').textContent = localState.activeInterface?.ip ? `${localState.activeInterface.ip} (网卡: ${localState.activeInterface.alias || '以太网'})` : '192.168.3.x';
  $('infoPing').textContent = localState.latency !== null ? `${localState.latency} ms` : '超时或离线';

  if (localState.connected) {
    capsule.className = 'status-capsule connected';
    if (!connTimer) {
      connTimer = setInterval(() => {
        connDurationSec++;
        const m = Math.floor(connDurationSec / 60);
        const s = connDurationSec % 60;
        capsuleTime.textContent = `${m}:${s < 10 ? '0' : ''}${s} ■`;
      }, 1000);
    }
    gwTitle.textContent = '当前状态：已接管 (经由旁路由 192.168.3.2 代理分流)';
    gwDesc.textContent = 'Windows 保持主路由 192.168.3.1 自动分配 IP 不变，全局流量由旁路由 MyBox 接管。';
    btnGw.className = 'btn-toggle-gw active';
    btnGwText.textContent = '断开 (恢复主路由直连)';
    $('infoGwMode').textContent = `旁路由代理 (${localState.gatewayIp})`;
  } else {
    capsule.className = 'status-capsule';
    clearInterval(connTimer);
    connTimer = null;
    connDurationSec = 0;
    capsuleTime.textContent = '未连接 ▶';
    gwTitle.textContent = '当前状态：直连主路由 192.168.3.1 (未走旁路由)';
    gwDesc.textContent = 'Windows 保持主路由 192.168.3.1 自动分配 IP 不变。点击右侧按钮瞬间切换为旁路由代理分流。';
    btnGw.className = 'btn-toggle-gw';
    btnGwText.textContent = '一键连接旁路由';
    $('infoGwMode').textContent = '主路由直连 (192.168.3.1)';
  }
}

async function toggleGateway() {
  const btn = $('btnToggleGw');
  btn.disabled = true;
  try {
    if (localState.connected) {
      toast('正在断开旁路由，恢复主路由直连...');
      await fetchLocal('/api/local/disconnect', { method: 'POST' });
      localState.connected = false;
      toast('已恢复主路由直连 (192.168.3.1)');
    } else {
      toast('正在连接旁路由并接管流量...');
      const res = await fetchLocal('/api/local/connect', { method: 'POST' });
      if (!res.ok) throw new Error(res.error || '连接失败');
      localState.connected = true;
      toast('已连接旁路由！流量正由 MyBox 接管分流');
    }
    await syncLocalStatus();
  } catch (err) {
    toast(`操作失败: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------- 实时流量 */

async function pollTraffic() {
  try {
    const data = await fetchRemote('/traffic');
    if (data.up !== undefined) {
      $('dispUp').textContent = fmtRate(data.upRate || 0);
      $('dispDown').textContent = fmtRate(data.downRate || 0);
      $('dispUpTotal').textContent = `累计 ${fmtBytes(data.up || 0)}`;
      $('dispDownTotal').textContent = `累计 ${fmtBytes(data.down || 0)}`;

      // 更新折线历史
      trafficHistory.up.shift();
      trafficHistory.up.push(data.upRate || 0);
      trafficHistory.down.shift();
      trafficHistory.down.push(data.downRate || 0);
      drawMiniCharts();
    }
  } catch {}
}

function drawMiniCharts() {
  drawMini('chartUpArea', 'chartUpLine', trafficHistory.up);
  drawMini('chartDownArea', 'chartDownLine', trafficHistory.down);
}

function drawMini(areaId, lineId, data) {
  const area = $(areaId);
  const line = $(lineId);
  if (!area || !line) return;

  const max = Math.max(...data, 1024);
  const w = 90;
  const h = 38;
  const step = w / (data.length - 1);

  const points = data.map((val, i) => {
    const x = i * step;
    const y = h - (val / max) * (h - 8) - 4;
    return [x, y];
  });

  const pathStr = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  line.setAttribute('d', pathStr);
  area.setAttribute('d', `${pathStr} L ${w} ${h} L 0 ${h} Z`);
}

/* ------------------------------------------------------------- 节点组 */

async function loadGroups() {
  const container = $('groupCardsContainer');
  try {
    const data = await fetchRemote('/nodes/status');
    remoteData.groups = data.groups || [];
    if (!remoteData.groups.length) {
      container.innerHTML = '<p class="empty-tip">暂无可用代理分组</p>';
      return;
    }
    container.innerHTML = remoteData.groups.map(g => `
      <div class="group-card-item">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <strong style="font-size:14px">${g.name}</strong>
            <span style="font-size:12px;color:var(--text-muted);margin-left:8px">当前: <span style="color:var(--accent);font-weight:600">${g.now || '—'}</span></span>
          </div>
          <span style="font-size:11px;background:#f3f4f6;padding:3px 8px;border-radius:6px">${g.type}</span>
        </div>
        <div class="node-pill-grid">
          ${(g.members || []).map(m => `
            <div class="node-pill ${m === g.now ? 'active' : ''}" onclick="selectNode('${escapeHtml(g.name)}', '${escapeHtml(m)}')">
              <span>${escapeHtml(m)}</span>
              ${m === g.now ? '<span style="font-size:10px">✓</span>' : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');
  } catch (err) {
    if (err.message === 'unauthorized') {
      container.innerHTML = `
        <div style="text-align:center;padding:30px 10px">
          <p style="font-size:13.5px;color:#4b5563;margin-bottom:12px">旁路由已开启访问密码保护，请先验证密码</p>
          <button class="small-btn primary" onclick="showAuthModal()" style="padding:7px 18px">输入密码解锁节点</button>
        </div>
      `;
    } else {
      container.innerHTML = `<p class="empty-tip" style="color:var(--danger)">加载节点失败: ${err.message}</p>`;
    }
  }
}

window.selectNode = async function(group, name) {
  try {
    toast(`正在切换「${group}」到节点: ${name}...`);
    await fetchRemote('/nodes/select', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group, name }),
    });
    toast(`已切换出口节点为: ${name}`);
    await loadGroups();
  } catch (err) {
    toast(`切换失败: ${err.message}`);
  }
};

/* ------------------------------------------------------------- 分流策略 */

async function loadPolicies() {
  const container = $('policyListContainer');
  try {
    const data = await fetchRemote('/policies');
    remoteData.policies = data.policies || [];
    const targets = data.targets || [];

    if (!remoteData.policies.length) {
      container.innerHTML = '<p class="empty-tip">暂无策略配置</p>';
      return;
    }

    container.innerHTML = remoteData.policies.map((p, i) => `
      <div class="policy-card-item">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong style="font-size:13.5px">${escapeHtml(p.name)}</strong>
          <span style="font-size:11px;color:${p.enabled ? 'var(--ok)' : 'var(--text-muted)'}">${p.enabled ? '已启用' : '已停用'}</span>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <label style="font-size:12px;color:var(--text-muted)">出口目标:</label>
          <select data-pol-idx="${i}" style="padding:4px 8px;border-radius:6px;border:1px solid var(--border);font-size:12px">
            <option value="builtin-direct" ${p.target === 'builtin-direct' ? 'selected' : ''}>直连</option>
            <option value="builtin-block" ${p.target === 'builtin-block' ? 'selected' : ''}>拒绝</option>
            <option value="all-auto" ${p.target === 'all-auto' ? 'selected' : ''}>所有-自动</option>
            <option value="all-manual" ${p.target === 'all-manual' ? 'selected' : ''}>所有-手动</option>
            ${(targets || []).filter(t => !['builtin-direct', 'builtin-block', 'all-auto', 'all-manual'].includes(t.value)).map(t => `
              <option value="${escapeHtml(t.value)}" ${p.target === t.value ? 'selected' : ''}>${escapeHtml(t.label)}</option>
            `).join('')}
          </select>
          <span style="font-size:11px;color:var(--text-muted)">规则: ${(p.rulesets || []).concat(p.domainSuffix || []).join(', ') || '无'}</span>
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<p class="empty-tip" style="color:var(--danger)">加载策略失败: ${err.message}</p>`;
  }
}

async function savePolicies() {
  document.querySelectorAll('#policyListContainer select[data-pol-idx]').forEach(sel => {
    const idx = Number(sel.dataset.polIdx);
    if (remoteData.policies[idx]) {
      remoteData.policies[idx].target = sel.value;
    }
  });

  try {
    toast('正在保存策略并触发内核部署...');
    await fetchRemote('/policies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policies: remoteData.policies }),
    });
    toast('策略已保存并已部署生效！');
    await loadPolicies();
  } catch (err) {
    toast(`保存策略失败: ${err.message}`);
  }
}

/* ------------------------------------------------------------- 当前连接 */

async function loadConnections() {
  const container = $('connsListContainer');
  try {
    const data = await fetchRemote('/connections');
    remoteData.connections = data.connections || [];
    renderConnections();
  } catch (err) {
    container.innerHTML = `<p class="empty-tip" style="color:var(--danger)">加载连接失败: ${err.message}</p>`;
  }
}

function renderConnections() {
  const container = $('connsListContainer');
  const kw = ($('connSearchLocal')?.value || '').toLowerCase().trim();
  const conns = remoteData.connections || [];

  $('dispConnCount').textContent = conns.length;

  const filtered = kw
    ? conns.filter(c => {
        const host = (c.metadata?.host || c.metadata?.destinationIP || '').toLowerCase();
        const rule = (c.rule || '').toLowerCase();
        const chain = (c.chains || []).join(' ').toLowerCase();
        return host.includes(kw) || rule.includes(kw) || chain.includes(kw);
      })
    : conns;

  if (!filtered.length) {
    container.innerHTML = '<p class="empty-tip">当前没有活动连接</p>';
    return;
  }

  container.innerHTML = filtered.slice(0, 50).map(c => `
    <div class="conn-row">
      <div>
        <strong style="color:#111">${escapeHtml(c.metadata?.host || c.metadata?.destinationIP || '—')}:${c.metadata?.destinationPort || ''}</strong>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px">
          <span>${c.metadata?.network?.toUpperCase()}</span> ·
          <span>源: ${c.metadata?.sourceIP}</span> ·
          <span>链路: ${(c.chains || []).join(' → ') || '直连'}</span>
        </div>
      </div>
      <div style="text-align:right">
        <div style="font-size:11px;font-family:monospace">↓ ${fmtBytes(c.download || 0)} / ↑ ${fmtBytes(c.upload || 0)}</div>
        <span style="font-size:10.5px;color:var(--text-muted)">${c.rule || '匹配'}</span>
      </div>
    </div>
  `).join('');
}

async function closeAllConnections() {
  if (!confirm('确定断开所有当前活动连接？（客户端会自动重连）')) return;
  try {
    await fetchRemote('/connections', { method: 'DELETE' });
    toast('已清空所有连接');
    await loadConnections();
  } catch (err) {
    toast(`断开失败: ${err.message}`);
  }
}

/* ------------------------------------------------------------- 设置 */

async function saveClientConfig() {
  const ip = $('cfgGatewayIp').value.trim();
  const port = Number($('cfgGatewayPort').value) || 3036;
  const autoConnect = !!$('cfgAutoConnect').checked;
  try {
    await fetchLocal('/api/local/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gatewayIp: ip, gatewayPort: port, autoConnect }),
    });
    localState.gatewayIp = ip;
    localState.gatewayPort = port;
    toast('配置已保存！正在重新同步状态...');
    await syncLocalStatus();
  } catch (err) {
    toast(`保存配置失败: ${err.message}`);
  }
}

function openWebPanel() {
  window.open(`http://${localState.gatewayIp}:${localState.gatewayPort}`, '_blank');
}

async function resetWindowsNetwork() {
  if (!confirm('确定彻底清除临时路由并还原本地 DNS 为自动获取吗？')) return;
  try {
    toast('正在还原 Windows 默认网络...');
    await fetchLocal('/api/local/disconnect', { method: 'POST' });
    localState.connected = false;
    toast('已完全恢复 Windows 默认网络 (DHCP 模式)');
    await syncLocalStatus();
  } catch (err) {
    toast(`还原失败: ${err.message}`);
  }
}

async function exitApplication() {
  if (!confirm('确定退出客户端？退出时将自动恢复 Windows 默认网络直连。')) return;
  try {
    toast('正在还原网络并退出服务...');
    await fetchLocal('/api/local/exit', { method: 'POST' });
    window.close();
  } catch {
    window.close();
  }
}

/* ------------------------------------------------------------- 选项卡与事件绑定 */

function switchTab(name) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));

  const nav = document.querySelector(`.nav-item[data-tab="${name}"]`);
  if (nav) nav.classList.add('active');

  const sec = $(`sec-${name}`);
  if (sec) sec.classList.add('active');

  const titleMap = { overview: '仪表', groups: '组', routing: '分流', conns: '连接', settings: '设置' };
  $('pageTitle').textContent = titleMap[name] || '仪表';

  if (name === 'groups') loadGroups();
  if (name === 'routing') loadPolicies();
  if (name === 'conns') loadConnections();
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bindEvents() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('topCapsule')?.addEventListener('click', toggleGateway);
  $('btnToggleGw')?.addEventListener('click', toggleGateway);

  $('btnRefreshAll')?.addEventListener('click', () => {
    toast('正在刷新数据...');
    syncLocalStatus();
    pollTraffic();
  });

  $('btnReloadGroups')?.addEventListener('click', loadGroups);
  $('btnSavePoliciesLocal')?.addEventListener('click', savePolicies);

  $('connSearchLocal')?.addEventListener('input', renderConnections);
  $('btnClearConnSearchLocal')?.addEventListener('click', () => {
    $('connSearchLocal').value = '';
    renderConnections();
  });
  $('btnCloseAllConnsLocal')?.addEventListener('click', closeAllConnections);
  $('btnReloadConnsLocal')?.addEventListener('click', loadConnections);

  $('btnSaveConfigLocal')?.addEventListener('click', saveClientConfig);
  $('btnOpenWebPanel')?.addEventListener('click', openWebPanel);
  $('btnResetWinNet')?.addEventListener('click', resetWindowsNetwork);
  $('btnExitApp')?.addEventListener('click', exitApplication);

  // 认证弹窗与密码事件
  $('btnSubmitAuth')?.addEventListener('click', () => {
    doLogin($('authModalPassword').value.trim());
  });
  $('authModalPassword')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin($('authModalPassword').value.trim());
  });
  $('btnCancelAuth')?.addEventListener('click', hideAuthModal);
  $('btnVerifyPassword')?.addEventListener('click', () => {
    doLogin($('cfgPanelPassword').value.trim());
  });
}

// 初始化
window.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  await syncLocalStatus();
  await pollTraffic();

  // 定时刷新状态与速率
  setInterval(syncLocalStatus, 5000);
  setInterval(pollTraffic, 2000);
});
