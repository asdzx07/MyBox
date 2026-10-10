let localState = {
  connected: false,
  gatewayIp: '192.168.3.2',
  gatewayPort: 3036,
  password: '',
  hasPassword: false,
  hasSession: false,
  authed: true,
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
  el._t = setTimeout(() => el.classList.add('hidden'), 2800);
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
      localState.authed = false;
      renderAuthBadge();
      throw new Error('unauthorized');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    localState.authed = true;
    renderAuthBadge();
    return await res.json();
  } catch (err) {
    if (err.message === 'unauthorized') {
      localState.authed = false;
      renderAuthBadge();
    }
    console.warn(`请求远程 API 失败 [${path}]:`, err.message);
    throw err;
  }
}

/* ------------------------------------------------------------- 旁路由直连认证与保存 */

function focusPasswordInput() {
  switchTab('overview');
  setTimeout(() => {
    const pwdEl = $('quickGwPassword');
    if (pwdEl) {
      pwdEl.focus();
      pwdEl.select();
    }
  }, 100);
}

function renderAuthBadge() {
  const badge = $('quickAuthBadge');
  if (!badge) return;
  if (!localState.hasPassword && !localState.hasSession && localState.authed) {
    badge.className = 'auth-pill-badge guest';
    badge.textContent = '免密直连';
  } else if (localState.authed && (localState.hasSession || localState.hasPassword)) {
    badge.className = 'auth-pill-badge authed';
    badge.textContent = '已认证';
  } else {
    badge.className = 'auth-pill-badge unauthed';
    badge.textContent = '需输入密码';
  }
}

async function saveAndAuth(ip, password) {
  ip = (ip || '').trim() || localState.gatewayIp || '192.168.3.2';
  password = (password !== undefined ? password : '').trim();

  try {
    toast(`正在连接旁路由 (${ip}) 验证密码...`);
    const res = await fetchLocal('/api/local/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gatewayIp: ip, password }),
    });

    if (!res || !res.ok) {
      localState.authed = false;
      renderAuthBadge();
      toast(res?.error || '登录失败: 密码错误，请检查旁路由管理密码');
      return false;
    }

    localState.gatewayIp = ip;
    localState.password = password;
    localState.hasPassword = Boolean(password);
    localState.hasSession = Boolean(res.hasSession !== false);
    localState.authed = true;

    renderAuthBadge();
    toast(password ? '认证成功！节点与策略已就绪' : '已保存旁路由 IP 配置');

    // 重新同步并加载业务数据
    await syncLocalStatus();
    await pollOverview();
    if ($('sec-groups')?.classList.contains('active')) loadGroups();
    if ($('sec-routing')?.classList.contains('active')) loadPolicies();
    if ($('sec-conns')?.classList.contains('active')) loadConnections();
    return true;
  } catch (err) {
    localState.authed = false;
    renderAuthBadge();
    toast(`验证失败: ${err.message}`);
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
      localState.hasPassword = !!data.hasPassword;
      localState.hasSession = !!data.hasSession;
      if (data.password !== undefined && !localState.password) {
        localState.password = data.password;
      }

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
  const capsuleText = $('capsuleText');
  const capsuleIcon = $('capsuleIcon');
  const gwTitle = $('gwTitle');
  const gwDesc = $('gwDesc');
  const btnGw = $('btnToggleGw');
  const btnGwText = $('btnGwText');

  const curIp = localState.gatewayIp || '192.168.3.2';
  // 保护用户正在输入的输入框，绝不覆盖已有内容
  if ($('quickGwIp') && !$('quickGwIp').value) {
    $('quickGwIp').value = curIp;
  }
  if ($('quickGwPassword') && !$('quickGwPassword').value && localState.password) {
    $('quickGwPassword').value = localState.password;
  }
  if ($('cfgGatewayIp') && !$('cfgGatewayIp').value) {
    $('cfgGatewayIp').value = curIp;
  }
  if ($('cfgPanelPassword') && !$('cfgPanelPassword').value && localState.password) {
    $('cfgPanelPassword').value = localState.password;
  }

  renderAuthBadge();

  $('infoLocalIp').textContent = localState.activeInterface?.ip ? `${localState.activeInterface.ip} (网卡: ${localState.activeInterface.alias || '以太网'})` : '192.168.3.x';
  $('infoPing').textContent = localState.latency !== null ? `${localState.latency} ms` : '超时或离线';

  if (localState.connected) {
    capsule.className = 'status-capsule connected';
    capsule.title = '当前已连接，点击断开并恢复网络设置';
    capsuleIcon.textContent = '■';
    if (!connTimer) {
      const updateTimer = () => {
        const m = Math.floor(connDurationSec / 60);
        const s = connDurationSec % 60;
        capsuleText.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
      };
      updateTimer();
      connTimer = setInterval(() => {
        connDurationSec++;
        updateTimer();
      }, 1000);
    }
    gwTitle.textContent = `当前状态：已接管 (经由旁路由 ${curIp} 代理分流)`;
    gwDesc.textContent = 'Windows 网关与 DNS 已指向旁路由，全局流量正由 MyBox 智能分流。再次点击即可恢复。';
    btnGw.className = 'btn-toggle-gw active';
    btnGwText.textContent = '断开 (恢复主路由直连)';
    $('infoGwMode').textContent = `旁路由代理 (${curIp})`;
  } else {
    capsule.className = 'status-capsule';
    capsule.title = '当前未连接，点击修改网络设置并连接旁路由';
    clearInterval(connTimer);
    connTimer = null;
    connDurationSec = 0;
    capsuleText.textContent = '';
    capsuleIcon.textContent = '▶';
    gwTitle.textContent = '当前状态：未连接 (保持主路由 DHCP 默认网络)';
    gwDesc.textContent = '当前网络保持主路由自动分配。点击顶部胶囊或右侧按钮瞬间接入旁路由代理。';
    btnGw.className = 'btn-toggle-gw';
    btnGwText.textContent = '一键连接旁路由';
    $('infoGwMode').textContent = '主路由直连 (自动分配)';
  }
}

async function handleQuickSaveAuth() {
  const ip = $('quickGwIp')?.value?.trim();
  const pwd = $('quickGwPassword')?.value ?? '';
  await saveAndAuth(ip, pwd);
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
        <div class="unauth-tip-card">
          <div class="unauth-icon">🔒</div>
          <div class="unauth-title">旁路由已开启密码访问保护</div>
          <div class="unauth-desc">请在首页【仪表】中输入旁路由管理密码并点击“连接/保存”，即可自动拉取节点。</div>
          <button class="small-btn primary" onclick="focusPasswordInput()" style="padding:6px 18px">前往输入密码</button>
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

/* ------------------------------------------------------------- 概览与内核状态 */

async function pollOverview() {
  try {
    const data = await fetchRemote('/overview');
    if (data.kernel) {
      const el = $('infoKernelState');
      if (el) {
        if (data.kernel.running) {
          const verStr = data.kernel.versionOutput ? data.kernel.versionOutput.split('\n')[0] : '';
          const shortVer = verStr ? ' (' + verStr.replace(/^sing-box\s+version\s+/i, 'v') + ')' : '';
          el.textContent = `运行中${shortVer}`;
          el.style.color = 'var(--ok)';
        } else {
          el.textContent = '已停止';
          el.style.color = 'var(--danger)';
        }
      }
    }
  } catch {}
}

/* ------------------------------------------------------------- 分流策略 */

function buildTargetOptionsHtml(currentTarget = '', targets = []) {
  let matched = false;
  let html = '';

  const builtins = [
    { val: 'all-auto', label: '所有-自动 (自动优选)' },
    { val: 'all-manual', label: '所有-手动 (手动切换)' },
    { val: 'builtin-direct', label: '直连 (direct - 绕过代理)' },
    { val: 'builtin-block', label: '拒绝 (block - 阻止连接)' },
  ];

  html += '<optgroup label="内置目标">';
  for (const b of builtins) {
    const isSel = (!matched) && (
      b.val === currentTarget ||
      (b.val === 'all-auto' && (currentTarget === '所有-自动' || currentTarget === 'all-auto')) ||
      (b.val === 'all-manual' && (currentTarget === '所有-手动' || currentTarget === 'all-manual')) ||
      (b.val === 'builtin-direct' && (currentTarget === 'direct' || currentTarget === 'builtin-direct')) ||
      (b.val === 'builtin-block' && (currentTarget === 'block' || currentTarget === 'builtin-block'))
    );
    if (isSel) matched = true;
    html += `<option value="${escapeHtml(b.val)}"${isSel ? ' selected' : ''}>${escapeHtml(b.label)}</option>`;
  }
  html += '</optgroup>';

  const exclude = new Set(['all-auto', 'all-manual', 'builtin-direct', 'builtin-block', 'direct', 'block']);
  const customTargets = (targets || []).filter(t => !exclude.has(t.value) && !exclude.has(t.label));

  if (customTargets.length) {
    html += '<optgroup label="自定义分组与出站">';
    for (const t of customTargets) {
      const isSel = (!matched) && (currentTarget === t.value || currentTarget === t.label);
      if (isSel) matched = true;
      html += `<option value="${escapeHtml(t.value)}"${isSel ? ' selected' : ''}>${escapeHtml(t.label)}</option>`;
    }
    html += '</optgroup>';
  }

  // 严防误判：若尚未匹配，生成当前值专属项保留原策略，绝不偷梁换柱成直连
  if (!matched && currentTarget) {
    html += `<optgroup label="当前配置"><option value="${escapeHtml(currentTarget)}" selected>${escapeHtml(currentTarget)}</option></optgroup>`;
  }

  return html;
}

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
            ${buildTargetOptionsHtml(p.target, targets)}
          </select>
          <span style="font-size:11px;color:var(--text-muted)">规则: ${(p.rulesets || []).concat(p.domainSuffix || []).join(', ') || '无'}</span>
        </div>
      </div>
    `).join('');
  } catch (err) {
    if (err.message === 'unauthorized') {
      container.innerHTML = `
        <div class="unauth-tip-card">
          <div class="unauth-icon">🔒</div>
          <div class="unauth-title">旁路由已开启密码访问保护</div>
          <div class="unauth-desc">请在首页【仪表】中输入旁路由管理密码并点击“连接/保存”，即可配置分流策略。</div>
          <button class="small-btn primary" onclick="focusPasswordInput()" style="padding:6px 18px">前往输入密码</button>
        </div>
      `;
    } else {
      container.innerHTML = `<p class="empty-tip" style="color:var(--danger)">加载策略失败: ${err.message}</p>`;
    }
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

async function resetPolicies() {
  if (!confirm('确定将所有分流策略恢复为系统官方默认？（AI、Google、流媒体走代理，国内走直连）')) return;
  try {
    toast('正在恢复默认分流策略并重新部署...');
    await fetchRemote('/policies/reset', { method: 'POST' });
    toast('已恢复默认策略！内核已重新部署生效');
    await loadPolicies();
  } catch (err) {
    toast(`恢复策略失败: ${err.message}`);
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
    if (err.message === 'unauthorized') {
      container.innerHTML = `
        <div class="unauth-tip-card">
          <div class="unauth-icon">🔒</div>
          <div class="unauth-title">旁路由已开启密码访问保护</div>
          <div class="unauth-desc">请在首页【仪表】中输入旁路由管理密码并点击“连接/保存”，即可查看实时网络连接。</div>
          <button class="small-btn primary" onclick="focusPasswordInput()" style="padding:6px 18px">前往输入密码</button>
        </div>
      `;
    } else {
      container.innerHTML = `<p class="empty-tip" style="color:var(--danger)">加载连接失败: ${err.message}</p>`;
    }
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
  const pwd = $('cfgPanelPassword').value || '';
  const autoConnect = !!$('cfgAutoConnect').checked;

  try {
    toast('正在保存配置并验证旁路由连接...');
    await fetchLocal('/api/local/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gatewayIp: ip, gatewayPort: port, autoConnect }),
    });
    await saveAndAuth(ip, pwd);
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

  // 首页状态卡片旁路由 IP 与密码保存认证
  $('btnQuickSaveAuth')?.addEventListener('click', handleQuickSaveAuth);
  $('quickGwIp')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleQuickSaveAuth();
  });
  $('quickGwPassword')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleQuickSaveAuth();
  });

  $('btnRefreshAll')?.addEventListener('click', () => {
    toast('正在刷新数据...');
    syncLocalStatus();
    pollTraffic();
  });

  $('btnReloadGroups')?.addEventListener('click', loadGroups);
  $('btnSavePoliciesLocal')?.addEventListener('click', savePolicies);
  $('btnResetPoliciesLocal')?.addEventListener('click', resetPolicies);

  $('connSearchLocal')?.addEventListener('input', renderConnections);
  $('btnClearConnSearchLocal')?.addEventListener('click', () => {
    $('connSearchLocal').value = '';
    renderConnections();
  });
  $('btnCloseAllConnsLocal')?.addEventListener('click', closeAllConnections);
  $('btnReloadConnsLocal')?.addEventListener('click', loadConnections);

  $('btnSaveConfigLocal')?.addEventListener('click', saveClientConfig);
  $('btnVerifyPassword')?.addEventListener('click', saveClientConfig);
  $('btnOpenWebPanel')?.addEventListener('click', openWebPanel);
  $('btnResetWinNet')?.addEventListener('click', resetWindowsNetwork);
  $('btnExitApp')?.addEventListener('click', exitApplication);
}

// 初始化
window.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  await syncLocalStatus();
  await pollOverview();
  await pollTraffic();

  // 定时向本地服务发送心跳保活
  setInterval(() => {
    fetch('/api/local/heartbeat').catch(() => {});
  }, 2500);

  // 定时刷新状态与速率
  setInterval(syncLocalStatus, 5000);
  setInterval(pollOverview, 4000);
  setInterval(pollTraffic, 2000);
});

// 窗口关闭时自动通知后台断开并恢复网络
window.addEventListener('beforeunload', () => {
  if (localState.connected) {
    try {
      navigator.sendBeacon('/api/local/disconnect');
    } catch {}
  }
});
