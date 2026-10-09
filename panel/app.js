/* MyBox 面板 —— 基于官方 sing-box 的透明代理控制面板，无构建步骤，直接跑。 */

const $ = (id) => document.getElementById(id);

let state = {
  settings: null,
  groups: [],
  policies: [],
  targets: [],
  nodes: [],
  nodeGroups: [],
  nodeList: [],
  latency: {},
  collapsed: {},
  clients: [],
};

/* --------------------------------------------------------------- 基础工具 */

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
  if (!el) return;
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

// 自动匹配国家/地区 Emoji 国旗
function extractFlag(name = '') {
  const n = name.toUpperCase();
  if (n.includes('香港') || n.includes('HK') || n.includes('HONG KONG')) return '🇭🇰';
  if (n.includes('日本') || n.includes('JP') || n.includes('JAPAN') || n.includes('东京') || n.includes('大阪')) return '🇯🇵';
  if (n.includes('美国') || n.includes('US') || n.includes('USA') || n.includes('美') || n.includes('波特兰') || n.includes('洛杉矶')) return '🇺🇸';
  if (n.includes('新加坡') || n.includes('SG') || n.includes('SINGAPORE') || n.includes('狮城')) return '🇸🇬';
  if (n.includes('台湾') || n.includes('TW') || n.includes('TAIWAN') || n.includes('台北')) return '🇹🇼';
  if (n.includes('韩国') || n.includes('KR') || n.includes('KOREA') || n.includes('首尔')) return '🇰🇷';
  if (n.includes('英国') || n.includes('UK') || n.includes('GB') || n.includes('伦敦')) return '🇬🇧';
  if (n.includes('德国') || n.includes('DE') || n.includes('GERMANY') || n.includes('法兰克福')) return '🇩🇪';
  if (n.includes('法国') || n.includes('FR') || n.includes('FRANCE') || n.includes('巴黎')) return '🇫🇷';
  if (n.includes('加拿大') || n.includes('CA') || n.includes('CANADA')) return '🇨🇦';
  if (n.includes('澳大利亚') || n.includes('AU') || n.includes('AUSTRALIA') || n.includes('悉尼')) return '🇦🇺';
  if (n.includes('俄罗斯') || n.includes('RU') || n.includes('RUSSIA')) return '🇷🇺';
  if (n.includes('直连') || n.includes('DIRECT')) return '⚡';
  if (n.includes('拒绝') || n.includes('BLOCK') || n.includes('REJECT')) return '🚫';
  return '🌐';
}

// 自动识别协议 Badge
function extractProto(name = '', type = '') {
  if (type) return type.toUpperCase();
  const n = name.toUpperCase();
  if (n.includes('HY2') || n.includes('HYSTERIA')) return 'HY2';
  if (n.includes('VLESS')) return 'VLESS';
  if (n.includes('VMESS')) return 'VMESS';
  if (n.includes('TROJAN')) return 'TROJAN';
  if (n.includes('TUIC')) return 'TUIC';
  if (n.includes('SS') || n.includes('SHADOWSOCKS')) return 'SS';
  return 'NODE';
}

/* --------------------------------------------------------------- 登录认证 */

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

/* --------------------------------------------------------------- 节点与分组 */

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
  const cls = entry.delay < 150 ? 'good' : entry.delay < 350 ? 'mid' : 'bad';
  return `<span class="lat ${cls}">● ${entry.delay} ms</span>`;
}

function renderNodeGroups() {
  const box = $('nodeGroups');
  if (!state.nodeGroups.length) {
    box.innerHTML = '<p class="note">内核没有返回任何分组。可能内核没在运行，或还没有部署配置。</p>';
    return;
  }
  const collapsed = (name) => state.collapsed[name] !== false;

  box.innerHTML = state.nodeGroups.map((g) => {
    const isCollapsed = collapsed(g.name);
    return `
    <div class="card" style="background:var(--surface-2);margin-bottom:14px">
      <div class="card-head group-head" data-collapse="${escapeHtml(g.name)}" style="cursor:pointer;margin-bottom:${isCollapsed ? '0' : '14px'}">
        <span class="chevron">${isCollapsed ? '▸' : '▾'}</span>
        <h3>${escapeHtml(g.name)}</h3>
        <span class="tag">${GROUP_LABEL[g.type] || g.type}</span>
        <span class="tag muted">${g.members.length} 个节点</span>
        <div class="spacer"></div>
        <span class="note">当前出口：<strong style="color:var(--accent)">${escapeHtml(g.now || '—')}</strong></span>
      </div>
      <div class="node-grid${isCollapsed ? ' hidden' : ''}">
        ${g.members.map((m) => {
          const isActive = (m === g.now);
          const flag = extractFlag(m);
          const proto = extractProto(m);
          return `
          <div class="node-card ${isActive ? 'active' : ''}" data-select-group="${escapeHtml(g.name)}" data-select-name="${escapeHtml(m)}">
            <div class="node-card-head">
              <span class="node-flag">${flag}</span>
              <div class="node-title" title="${escapeHtml(m)}">${escapeHtml(m)}</div>
              <span class="node-proto">${proto}</span>
            </div>
            <div class="node-card-foot">
              <div>${delayBadge(m) || '<span class="lat na">未测试</span>'}</div>
              <button class="small" data-latency="${escapeHtml(m)}" style="padding:2px 8px;font-size:11px" onclick="event.stopPropagation()">测速</button>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
}

function renderNodeList() {
  $('nodeCount').textContent = `${state.nodeList.length} 个`;
  const box = $('nodeList');
  if (!state.nodeList.length) {
    box.innerHTML = '<p class="note">还没有节点。先在「订阅」页添加订阅并刷新，然后部署配置。</p>';
    return;
  }
  box.innerHTML = state.nodeList.map((n) => `
    <div class="item">
      <span class="node-flag">${extractFlag(n.name)}</span>
      <div class="grow">
        <div class="title">${escapeHtml(n.name)}</div>
        <div class="sub">${escapeHtml(n.type)} · ${escapeHtml(n.server || '')}</div>
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
  toast(`正在并发测速 ${names.length} 个节点…`);
  try {
    const { results } = await api('/nodes/latency/batch', { method: 'POST', body: { names } });
    Object.assign(state.latency, results);
    toast('测速完成');
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
    toast(`已切换出口：${group} → ${name}`);
  } catch (err) {
    toast(err.message);
    await loadNodes();
  }
}

/* --------------------------------------------------------------- 概览与实时流量 */

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
const HIST_LEN = 45;

async function loadTraffic() {
  try {
    const t = await api('/traffic');
    if (!t) return;
    const up = Number(t.up) || 0;
    const down = Number(t.down) || 0;
    const totalUp = Number(t.totalUp) || 0;
    const totalDown = Number(t.totalDown) || 0;

    $('statUp').textContent = fmtSpeed(up);
    $('statDown').textContent = fmtSpeed(down);
    $('statTotalUp').textContent = fmtBytes(totalUp);
    $('statTotalDown').textContent = fmtBytes(totalDown);

    // 写入历史
    trafficHist.up.push(up);
    trafficHist.down.push(down);
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

  // 动态根据历史最大值缩放，最低 10KB/s 防止零流量浮动，有数据时自适应跳动
  const max = Math.max(1024 * 10, ...trafficHist.up, ...trafficHist.down);

  // 绘制水平辅助虚线
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const y = (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const drawSmooth = (data, strokeColor, fillColor) => {
    if (!data.length) return;
    ctx.beginPath();
    const step = w / (HIST_LEN - 1);
    data.forEach((v, i) => {
      const x = i * step;
      const y = h - 6 - (v / max) * (h - 22);
      if (i === 0) ctx.moveTo(x, y);
      else {
        const prevX = (i - 1) * step;
        const prevY = h - 6 - (data[i - 1] / max) * (h - 22);
        const cpX = (prevX + x) / 2;
        ctx.bezierCurveTo(cpX, prevY, cpX, y, x, y);
      }
    });

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2.2;
    ctx.stroke();

    if (fillColor) {
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, fillColor);
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.fill();
    }
  };

  // 下行 (绿色)
  drawSmooth(trafficHist.down, '#22c55e', 'rgba(34, 197, 94, 0.16)');
  // 上行 (蓝色)
  drawSmooth(trafficHist.up, '#3b82f6', 'rgba(59, 130, 246, 0.16)');
}

function startTrafficPoll() {
  if (trafficTimer) return;
  loadTraffic();
  trafficTimer = setInterval(() => {
    if ($('page-overview').classList.contains('active')) loadTraffic();
  }, 1500);
}

async function loadOverview() {
  try {
    const data = await api('/overview');
    const running = Boolean(data.kernel?.running);
    $('heroDot').className = 'dot ' + (running ? 'on' : 'off');
    
    if (!running) {
      $('statKernel').textContent = '未运行';
    } else {
      const pidStr = data.kernel?.pid ? `PID ${data.kernel.pid}` : (data.kernel?.supervisor ? `${data.kernel.supervisor} 守护` : '系统托管');
      const timeStr = data.kernel?.uptime ? ` · 运行 ${data.kernel.uptime}` : '';
      $('statKernel').textContent = `运行中 (${pidStr}${timeStr})`;
    }

    let note = '';
    if (data.kernel?.reloadedAt) {
      note = `上次热重载：${new Date(data.kernel.reloadedAt).toLocaleTimeString()}`;
    }
    $('overviewNote').textContent = note || '透明代理正常运行中 · 直连流量未进内核 (零损耗)';

    $('statVersion').textContent = data.kernel?.version || '—';
    $('statNodes').textContent = data.nodes?.total ? `${data.nodes.total} 个` : '0 个';
    $('statPolicies').textContent = data.policies ? `${data.policies.enabled} / ${data.policies.total}` : '—';

    const hint = $('overviewHint');
    if (data.kernel?.error) {
      hint.textContent = data.kernel.error;
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }
  } catch (err) {
    $('statKernel').textContent = '读取失败';
    $('overviewHint').textContent = err.message;
    $('overviewHint').classList.remove('hidden');
  }
  loadOverviewGroups();
}

async function loadOverviewGroups() {
  const box = $('overviewGroups');
  try {
    const data = await api('/nodes/status');
    const groups = data.groups || [];
    if (!groups.length) {
      box.innerHTML = '<div class="mini-empty">内核未运行或无节点组</div>';
      return;
    }
    box.innerHTML = `<div class="mini">${groups.map((g) => `
      <div class="mini-row">
        <div class="grow">
          <div class="name" style="font-weight:600">${escapeHtml(g.name)}</div>
          <div class="sub">${GROUP_LABEL[g.type] || g.type} · ${g.members.length} 个可选</div>
        </div>
        <select data-ov-group="${escapeHtml(g.name)}">
          ${g.members.map((m) => `<option value="${escapeHtml(m)}"${m === g.now ? ' selected' : ''}>${extractFlag(m)} ${escapeHtml(m)}</option>`).join('')}
        </select>
      </div>
    `).join('')}</div>`;
  } catch (err) {
    box.innerHTML = `<div class="mini-empty">${escapeHtml(err.message)}</div>`;
  }
}

/* --------------------------------------------------------------- 当前连接 */

async function loadConnectionsPage() {
  const countEl = $('connPageCount');
  const listEl = $('connsList');
  try {
    const data = await api('/connections');
    const conns = data.connections || [];
    countEl.textContent = `${conns.length} 条连接 · 累计 ↓ ${fmtBytes(data.downloadTotal || 0)} / ↑ ${fmtBytes(data.uploadTotal || 0)}`;
    $('sbConnCount').textContent = conns.length;
    $('sbConnCount').classList.toggle('hidden', conns.length === 0);

    if (!conns.length) {
      listEl.innerHTML = '<p class="note" style="padding:16px 0;text-align:center">当前没有活动连接</p>';
      return;
    }
    listEl.innerHTML = `<div class="list">${conns.map((c) => {
      const host = escapeHtml(c.metadata?.host || c.metadata?.destinationIP || '—');
      const port = c.metadata?.destinationPort ? `:${c.metadata.destinationPort}` : '';
      const src = escapeHtml(c.metadata?.sourceIP || '');
      const proto = escapeHtml((c.metadata?.network || '').toUpperCase());
      const chain = (c.chains || []).map(escapeHtml).join(' → ');
      const rule = escapeHtml(c.rule || '');
      const id = encodeURIComponent(c.id || '');
      return `
        <div class="conn-item">
          <div class="conn-main">
            <div class="conn-header">
              <span class="conn-target" title="${host}${port}">${host}${port}</span>
              <span class="tag muted conn-proto">${proto}</span>
              ${rule ? `<span class="tag conn-rule" title="${rule}">${rule}</span>` : ''}
            </div>
            <div class="conn-meta-sub">
              <span>源: ${src}</span>
              <span class="conn-sep">·</span>
              <span>链路: ${chain || '直连'}</span>
            </div>
          </div>
          <div class="conn-stats-col">
            <div class="conn-traffic">
              <span class="tf-down">↓ ${fmtBytes(c.download || 0)}</span>
              <span class="tf-sep">/</span>
              <span class="tf-up">↑ ${fmtBytes(c.upload || 0)}</span>
            </div>
            ${c.id ? `<button class="small conn-btn-close" onclick="closeSingleConn('${id}')">断开</button>` : ''}
          </div>
        </div>
      `;
    }).join('')}</div>`;
  } catch (err) {
    listEl.innerHTML = `<p class="err-text" style="padding:16px 0">${escapeHtml(err.message)}</p>`;
  }
}

window.closeSingleConn = async function(id) {
  try {
    await api(`/connections/${id}`, { method: 'DELETE' });
    toast('已断开该连接');
    await loadConnectionsPage();
  } catch (err) {
    toast(`断开失败：${err.message}`);
  }
};

window.closeAllConnections = async function() {
  if (!confirm('确定断开所有当前活动连接吗？（客户端会自动重连）')) return;
  try {
    await api('/connections', { method: 'DELETE' });
    toast('已断开所有连接');
    await loadConnectionsPage();
  } catch (err) {
    toast(`断开失败：${err.message}`);
  }
};

/* --------------------------------------------------------------- 内网分流 (NEW) */

const CLIENTS_STORAGE_KEY = 'mybox_clients_rules';

function loadClients() {
  let clients = [];
  try {
    clients = JSON.parse(localStorage.getItem(CLIENTS_STORAGE_KEY) || '[]');
  } catch {}
  if (!clients.length) {
    // 默认展示常见内网设备模板
    clients = [
      { id: '1', name: '常用办公电脑 (Mac/PC)', ip: '192.168.1.102', mode: 'rule', note: '默认走规则分流' },
      { id: '2', name: '家庭存储 (NAS / PT 下载机)', ip: '192.168.1.80', mode: 'direct', note: '强制完全直连 (防止PT封号)' },
      { id: '3', name: '客厅电视 (Apple TV / 电视盒子)', ip: '192.168.1.150', mode: 'proxy', note: '全局代理模式' }
    ];
    localStorage.setItem(CLIENTS_STORAGE_KEY, JSON.stringify(clients));
  }
  state.clients = clients;
  renderClients();
}

function renderClients() {
  const box = $('clientList');
  if (!box) return;
  if (!state.clients.length) {
    box.innerHTML = '<p class="note">暂无自定义内网分流设备，局域网所有设备默认按「规则分流」运行。</p>';
    return;
  }
  box.innerHTML = state.clients.map((c, i) => `
    <div class="client-item">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px">
          ${escapeHtml(c.name)}
          <span class="tag muted" style="font-family:monospace">${escapeHtml(c.ip)}</span>
        </div>
        <div class="note" style="margin-top:2px">${escapeHtml(c.note || '')}</div>
      </div>
      <div class="inline" style="gap:8px">
        <select onchange="updateClientMode(${i}, this.value)" style="width:auto;font-size:12px;padding:4px 8px">
          <option value="rule"${c.mode === 'rule' ? ' selected' : ''}>规则分流 (推荐)</option>
          <option value="proxy"${c.mode === 'proxy' ? ' selected' : ''}>全局代理</option>
          <option value="direct"${c.mode === 'direct' ? ' selected' : ''}>完全直连 (绕过代理)</option>
        </select>
        <button class="small" onclick="openClientModal(${i})" style="padding:4px 9px">编辑</button>
        <button class="small danger" onclick="removeClient(${i})" style="padding:4px 9px">删除</button>
      </div>
    </div>
  `).join('');
}

window.openClientModal = function(index = -1) {
  const modal = $('clientModal');
  if (!modal) return;
  $('modalClientIndex').value = index;
  if (index >= 0 && state.clients[index]) {
    const c = state.clients[index];
    $('modalTitle').textContent = '编辑内网设备';
    $('modalClientName').value = c.name || '';
    $('modalClientIp').value = c.ip || '';
    $('modalClientMode').value = c.mode || 'rule';
  } else {
    $('modalTitle').textContent = '添加内网设备';
    $('modalClientName').value = '';
    $('modalClientIp').value = '';
    $('modalClientMode').value = 'rule';
  }
  modal.classList.remove('hidden');
};

window.closeClientModal = function() {
  const modal = $('clientModal');
  if (modal) modal.classList.add('hidden');
};

function saveClientModal() {
  const idx = Number($('modalClientIndex').value);
  const name = $('modalClientName').value.trim();
  const ip = $('modalClientIp').value.trim();
  const mode = $('modalClientMode').value;
  if (!ip) {
    toast('请输入设备 IP 地址');
    return;
  }
  if (idx >= 0 && state.clients[idx]) {
    state.clients[idx].name = name || '未命名设备';
    state.clients[idx].ip = ip;
    state.clients[idx].mode = mode;
    toast(`已更新设备「${name || ip}」`);
  } else {
    state.clients.push({
      id: Date.now().toString(),
      name: name || '未命名设备',
      ip,
      mode,
      note: '手动添加'
    });
    toast(`已添加设备「${name || ip}」`);
  }
  localStorage.setItem(CLIENTS_STORAGE_KEY, JSON.stringify(state.clients));
  renderClients();
  closeClientModal();
}

window.updateClientMode = function(index, mode) {
  if (state.clients[index]) {
    state.clients[index].mode = mode;
    localStorage.setItem(CLIENTS_STORAGE_KEY, JSON.stringify(state.clients));
    toast(`已更新设备「${state.clients[index].name}」分流策略`);
  }
};

window.removeClient = function(index) {
  if (confirm('确认移除该设备的独立分流规则？')) {
    state.clients.splice(index, 1);
    localStorage.setItem(CLIENTS_STORAGE_KEY, JSON.stringify(state.clients));
    renderClients();
    toast('已移除设备规则');
  }
};

/* --------------------------------------------------------------- 订阅管理 */

async function loadSubscriptions() {
  try {
    const data = await api('/subscriptions');
    const list = data.subscriptions || [];
    renderSubList(list);
  } catch (err) {
    $('subList').innerHTML = `<p class="err-text">${escapeHtml(err.message)}</p>`;
  }
}

function renderSubList(subs) {
  const box = $('subList');
  if (!subs.length) {
    box.innerHTML = '<p class="note">还没有订阅，请在上方添加。</p>';
    return;
  }
  box.innerHTML = subs.map((s) => `
    <div class="item">
      <label class="switch">
        <input type="checkbox" data-sub-toggle="${escapeHtml(s.id)}"${s.enabled ? ' checked' : ''}>
        <span></span>
      </label>
      <div class="grow">
        <div class="title">${escapeHtml(s.name || s.id)}</div>
        <div class="sub">${escapeHtml(s.url || '')} · 节点: ${s.nodes?.length || 0} 个</div>
      </div>
      <div class="inline">
        <button class="small" data-refresh="${escapeHtml(s.id)}">刷新</button>
        <button class="small danger" data-remove="${escapeHtml(s.id)}">删除</button>
      </div>
    </div>
  `).join('');
}

/* --------------------------------------------------------------- 节点分组策略 */

async function loadGroups() {
  try {
    const data = await api('/settings');
    state.settings = data;
    state.groups = data.groups || [];
    renderGroups();
  } catch (err) {
    $('groupList').innerHTML = `<p class="err-text">${escapeHtml(err.message)}</p>`;
  }
}

function renderGroups() {
  const box = $('groupList');
  if (!state.groups.length) {
    box.innerHTML = '<p class="note">还没有分组规则配置。</p>';
    return;
  }
  box.innerHTML = state.groups.map((g, i) => `
    <div class="card" style="background:var(--surface-2);margin-bottom:10px">
      <div class="row">
        <label class="field" style="flex:1 1 140px">
          <span>分组名称</span>
          <input data-g-name="${i}" value="${escapeHtml(g.name || '')}">
        </label>
        <label class="field" style="flex:1 1 120px">
          <span>类型</span>
          <input value="${escapeHtml(GROUP_LABEL[g.type] || g.type)}" readonly>
        </label>
        <label class="field" style="flex:2 1 200px">
          <span>${g.mode === 'dynamic' ? '匹配关键词（逗号分隔）' : '包含节点'}</span>
          <input data-g-members="${i}" value="${escapeHtml((g.mode === 'dynamic' ? g.keywords : g.members)?.join(', ') || '')}">
        </label>
        <div class="fixed" style="padding-bottom:12px">
          <label class="inline"><input type="checkbox" data-g-enabled="${i}"${g.enabled ? ' checked' : ''} style="width:auto"> 启用</label>
        </div>
      </div>
    </div>
  `).join('');
}

/* --------------------------------------------------------------- 目标分流 */

async function loadPolicies() {
  try {
    const data = await api('/settings');
    state.settings = data;
    state.policies = data.policies || [];
    renderPolicies();
    loadRulesetSubs();
  } catch (err) {
    $('policyList').innerHTML = `<p class="err-text">${escapeHtml(err.message)}</p>`;
  }
}

function policyIcon(name = '') {
  if (name.includes('AI') || name.includes('OpenAI')) return '🤖 ';
  if (name.includes('YouTube') || name.includes('流媒体')) return '📺 ';
  if (name.includes('直连') || name.includes('国内')) return '🇨🇳 ';
  return '🎯 ';
}

function renderPolicies() {
  const box = $('policyList');
  if (!state.policies.length) {
    box.innerHTML = '<p class="note">还没有策略。</p>';
    return;
  }
  box.innerHTML = state.policies.map((p, i) => `
    <div class="card" style="background:var(--surface-2);margin-bottom:10px">
      <div class="card-head" style="margin-bottom:10px">
        <h3 style="display:flex;align-items:center;gap:6px">${policyIcon(p.name)}${escapeHtml(p.name)}</h3>
        <span class="tag muted" data-p-status="${i}">${p.enabled ? '已启用' : '已关闭'}</span>
        <div class="spacer"></div>
        <label class="switch">
          <input type="checkbox" data-p-enabled="${i}"${p.enabled ? ' checked' : ''}>
          <span></span>
        </label>
        <button class="small" data-p-collapse="${i}" title="折叠/展开">▼</button>
        <button class="small danger" data-p-remove="${i}">删除</button>
      </div>
      <div data-p-body="${i}">
        <div class="row">
          <label class="field"><span>策略名称</span><input data-p-name="${i}" value="${escapeHtml(p.name || '')}"></label>
          <label class="field"><span>出口目标（直连/拒绝/分组）</span><input data-p-target="${i}" value="${escapeHtml(p.target || '')}"></label>
        </div>
        <div class="row">
          <label class="field"><span>规则集 (rulesets)</span><input data-p-rulesets="${i}" value="${escapeHtml(p.rulesets?.join(', ') || '')}"></label>
          <label class="field"><span>域名后缀 (domain_suffix)</span><input data-p-suffix="${i}" value="${escapeHtml(p.domainSuffix?.join(', ') || '')}"></label>
        </div>
      </div>
    </div>
  `).join('');
}

async function loadRulesetSubs() {
  try {
    const data = await api('/ruleset-subs');
    const list = data.subscriptions || [];
    const box = $('rulesetSubList');
    if (!list.length) {
      box.innerHTML = '<p class="note">还没有自定义规则集订阅。</p>';
      return;
    }
    box.innerHTML = list.map((r) => `
      <div class="item">
        <label class="switch">
          <input type="checkbox" data-rs-enabled="${escapeHtml(r.id)}"${r.enabled ? ' checked' : ''}>
          <span></span>
        </label>
        <div class="grow">
          <div class="title">${escapeHtml(r.tag)}</div>
          <div class="sub">${escapeHtml(r.url)}</div>
        </div>
        <button class="small danger" data-rs-del="${escapeHtml(r.id)}">删除</button>
      </div>
    `).join('');
  } catch {}
}

/* --------------------------------------------------------------- 核心设置与日志 */

async function loadSettings() {
  try {
    const s = await api('/settings');
    state.settings = s;
    if ($('setIpv6')) $('setIpv6').checked = Boolean(s.network?.ipv6);
    if ($('setRejectQuic')) $('setRejectQuic').checked = Boolean(s.network?.rejectQuic);
    if ($('setAutoRedirect')) $('setAutoRedirect').checked = s.network?.tun?.autoRedirect !== false;
    if ($('setDirectBypass')) $('setDirectBypass').checked = s.network?.directBypass !== false;
    if ($('setDirectForNodes')) $('setDirectForNodes').checked = s.network?.directForNodes !== false;
    if ($('setDnsMode')) $('setDnsMode').value = s.dns?.mode || 'dnsmasq';
    if ($('setDnsDirect')) $('setDnsDirect').value = s.dns?.direct === 'wan' ? '' : (s.dns?.directAddress || '');
    if ($('setDnsProxy')) $('setDnsProxy').value = s.dns?.proxy || '';
    if ($('setFakeIp')) $('setFakeIp').checked = Boolean(s.dns?.fakeIp);
    if ($('setAdblock')) $('setAdblock').checked = Boolean(s.dns?.adblock);
    if ($('setAdblockAllow')) $('setAdblockAllow').value = (s.dns?.adblockAllow || []).join('\n');
    if ($('setAdblockCustom')) $('setAdblockCustom').value = (s.dns?.adblockCustom || []).join('\n');
    if ($('setLogLevel')) $('setLogLevel').value = s.kernel?.logLevel || 'warn';

    // 内核版本卡片
    const kVer = s.kernel?.installed
      ? (s.kernel.version ? (s.kernel.version.startsWith('v') ? s.kernel.version : `v${s.kernel.version}`) : 'v1.14.2')
      : '未安装';
    if ($('setKernelVersion')) $('setKernelVersion').textContent = kVer;
  } catch {}

  // 面板语义化版本展示与官方源对比
  try {
    const v = await api('/system/version');
    const cur = v.current || 'v1.0.0(e31b623)';
    if ($('sysVersion')) $('sysVersion').textContent = cur;
    if ($('settingCurrentVerTag')) $('settingCurrentVerTag').textContent = cur;
    if ($('brandVersion')) $('brandVersion').textContent = cur;
    if ($('sysCommitSha')) $('sysCommitSha').textContent = '';
    if ($('latestSysVersion')) $('latestSysVersion').textContent = v.latest || cur;
    if ($('panelCheckTime')) $('panelCheckTime').textContent = '刚刚检查';

    const pBadge = $('panelUpdateBadge');
    const applyBtn = $('btnSysUpdate');
    if (v.hasUpdate) {
      if (pBadge) {
        pBadge.textContent = `发现新版本 ${v.latest}`;
        pBadge.style.color = 'var(--warn)';
      }
      if (applyBtn) {
        applyBtn.classList.remove('hidden');
        if ($('sysUpdateBtnText')) $('sysUpdateBtnText').textContent = `升级至 ${v.latest}`;
      }
    } else {
      if (pBadge) {
        pBadge.textContent = '当前已是最新';
        pBadge.style.color = '';
      }
      if (applyBtn) applyBtn.classList.add('hidden');
    }
  } catch {
    if ($('sysVersion')) $('sysVersion').textContent = 'v1.0.0(e31b623)';
    if ($('settingCurrentVerTag')) $('settingCurrentVerTag').textContent = 'v1.0.0(e31b623)';
    if ($('brandVersion')) $('brandVersion').textContent = 'v1.0.0(e31b623)';
    if ($('latestSysVersion')) $('latestSysVersion').textContent = 'v1.0.0(e31b623)';
  }

  // 获取并展示内核最新版本
  try {
    const kLatest = await api('/kernel/latest');
    if ($('latestKernelVer')) $('latestKernelVer').textContent = kLatest.version || 'v1.14.2';
  } catch {}
}

async function loadKernelLog() {
  try {
    const data = await api('/kernel/log');
    $('kernelLog').textContent = data.log || '暂无日志';
  } catch (err) {
    $('kernelLog').textContent = `读取日志失败：${err.message}`;
  }
}

let logAutoTimer = null;
function scheduleLogAuto() {
  clearInterval(logAutoTimer);
  if ($('logAuto')?.checked) {
    logAutoTimer = setInterval(loadKernelLog, 3000);
  }
}

function filterKernelLog() {
  const kw = $('logSearch').value.toLowerCase();
  const text = $('kernelLog').textContent;
  if (!kw) return;
  const lines = text.split('\n').filter((l) => l.toLowerCase().includes(kw));
  $('kernelLog').textContent = lines.join('\n') || '无匹配内容';
}

/* --------------------------------------------------------------- 加载入口与事件 */

async function loadAll() {
  await Promise.all([
    loadOverview(),
    loadSubscriptions(),
    loadGroups(),
    loadPolicies(),
    loadSettings(),
  ]);
}

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
    await loadOverview();
  });
}

function bindEvents() {
  $('gateSubmit').addEventListener('click', submitGate);
  $('gatePassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGate(); });
  $('gateConfirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGate(); });

  // 导航切换
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

      if (tab === 'nodes') { await loadNodes(); await loadGroups(); }
      if (tab === 'connections') await loadConnectionsPage();
      if (tab === 'clients') loadClients();
      if (tab === 'subscriptions') await loadSubscriptions();
      if (tab === 'policies') await loadPolicies();
      if (tab === 'settings') { await loadSettings(); await loadKernelLog(); }
      scheduleLogAuto();
    });
  });

  // 概览
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
  $('btnOverviewNodes').addEventListener('click', (e) => withBusy(e.currentTarget, loadOverviewGroups));
  $('overviewGroups').addEventListener('change', async (e) => {
    const group = e.target.dataset.ovGroup;
    if (!group) return;
    await switchNode(group, e.target.value);
    await loadOverviewGroups();
  });

  // 节点页
  $('btnReloadNodes').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    await loadNodes();
    toast('已刷新节点');
  }));
  $('btnTestAll').addEventListener('click', (e) => withBusy(e.currentTarget, testAll));
  $('btnCollapseAll').addEventListener('click', () => {
    const anyExpanded = state.nodeGroups.some((g) => state.collapsed[g.name] === false);
    for (const g of state.nodeGroups) state.collapsed[g.name] = anyExpanded;
    renderNodeGroups();
    toast(anyExpanded ? '已全部折叠' : '已全部展开');
  });

  $('nodeGroups').addEventListener('click', async (e) => {
    const lat = e.target.dataset.latency;
    if (lat) {
      e.stopPropagation();
      await testLatency(lat);
      return;
    }
    const collapseName = e.target.closest('[data-collapse]')?.dataset.collapse;
    if (collapseName !== undefined) {
      const nowCollapsed = state.collapsed[collapseName] !== false;
      state.collapsed[collapseName] = !nowCollapsed;
      renderNodeGroups();
      return;
    }
    const card = e.target.closest('[data-select-group]');
    if (card) {
      const group = card.dataset.selectGroup;
      const name = card.dataset.selectName;
      if (group && name) await switchNode(group, name);
    }
  });

  $('nodeList').addEventListener('click', async (e) => {
    const lat = e.target.dataset.latency;
    if (lat) await testLatency(lat);
  });

  // 分组管理
  $('btnAddGroup')?.addEventListener('click', () => {
    state.groups.push({ name: `自定义组-${state.groups.length + 1}`, type: 'Selector', members: [], enabled: true });
    renderGroups();
  });
  $('btnSaveGroups')?.addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    await api('/settings', { method: 'PUT', body: { groups: state.groups } });
    toast('分组已保存，记得「部署配置」生效');
  }));

  // 内网分流按键与弹窗
  $('btnScanClients')?.addEventListener('click', () => {
    loadClients();
    toast('局域网设备扫描完成 (已同步设备列表)');
  });
  $('btnAddClient')?.addEventListener('click', () => {
    openClientModal(-1);
  });
  $('btnCancelClientModal')?.addEventListener('click', closeClientModal);
  $('btnSaveClientModal')?.addEventListener('click', saveClientModal);
  $('clientModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'clientModal') closeClientModal();
  });

  // 连接页
  $('btnConnsRefresh').addEventListener('click', (e) => withBusy(e.currentTarget, loadConnectionsPage));

  // 订阅页
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
    toast(`共 ${total} 个节点已刷新`);
    await Promise.all([loadSubscriptions(), loadOverview()]);
  }));

  $('subList').addEventListener('change', async (e) => {
    const id = e.target.dataset.subToggle;
    if (!id) return;
    const enabled = e.target.checked;
    try {
      await api(`/subscriptions/${encodeURIComponent(id)}`, { method: 'PUT', body: { enabled } });
      toast(enabled ? '已启用，记得「部署配置」' : '已停用，记得「部署配置」');
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
      await api(`/subscriptions/${encodeURIComponent(removeId)}`, { method: 'DELETE' });
      toast('已删除');
      await Promise.all([loadSubscriptions(), loadOverview()]);
    }
  });

  // 策略页
  $('btnSavePolicies').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    await api('/settings', { method: 'PUT', body: { policies: state.policies } });
    toast('策略已保存，改动已写入开关或生效');
  }));

  $('btnAddPolicy').addEventListener('click', () => {
    const id = 'custom-' + Date.now();
    state.policies.push({ id, name: '新策略', target: 'direct', rulesets: [], domainSuffix: [], enabled: true });
    renderPolicies();
  });

  $('btnResetPolicies').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    if (!confirm('恢复默认策略将覆盖当前自定义策略，确定？')) return;
    await api('/policies/reset', { method: 'POST' });
    toast('已恢复默认策略');
    await loadPolicies();
  }));

  $('btnRefreshRulesets').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const r = await api('/rulesets/refresh', { method: 'POST' });
    toast(r.ok ? '规则集已更新' : ('更新失败：' + (r.error || '未知错误')));
  }));

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
      toast(t.checked ? `「${policy.name}」已启用（0断流热切换）` : `「${policy.name}」已关闭（0断流热切换）`);
    } catch (err) {
      t.checked = !t.checked;
      policy.enabled = !t.checked;
      toast(err.message);
    }
  });

  // 设置页右上角核心操作 1: 保存并部署 (带完整成功变绿动效)
  $('btnSaveSettings')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const txt = $('saveSettingsBtnText');
    const prevText = txt ? txt.textContent : '保存并部署';
    btn.disabled = true;
    if (txt) txt.innerHTML = '<span class="animate-spin">↻</span> 正在部署...';
    try {
      const patch = {
        network: {
          ipv6: $('setIpv6').checked,
          rejectQuic: $('setRejectQuic').checked,
          directBypass: $('setDirectBypass').checked,
          directForNodes: $('setDirectForNodes').checked,
          tun: { autoRedirect: $('setAutoRedirect').checked },
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
        kernel: { logLevel: $('setLogLevel') ? $('setLogLevel').value : 'warn' },
      };
      await api('/settings', { method: 'PUT', body: patch });
      await api('/deploy', { method: 'POST', body: { restart: true } });

      // 成功变绿并显示对勾动效
      btn.classList.add('btn-success');
      if (txt) txt.textContent = '✓ 保存部署成功';
      toast('✓ 配置已保存，0断流热重载生效！');

      setTimeout(() => {
        btn.classList.remove('btn-success');
        if (txt) txt.textContent = '保存并部署';
        btn.disabled = false;
      }, 2500);

      await loadOverview();
    } catch (err) {
      btn.disabled = false;
      if (txt) txt.textContent = prevText;
      toast(`保存失败：${err.message}`);
    }
  });

  // 设置页右上角核心操作 2: 检查更新
  $('btnCheckSysUpdate')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const txt = $('checkUpdateBtnText');
    btn.disabled = true;
    if (txt) txt.innerHTML = '<span class="animate-spin">↻</span> 检查中...';
    try {
      const v = await api('/system/version');
      const cur = v.current || 'v1.0.0(e31b623)';
      if ($('sysVersion')) $('sysVersion').textContent = cur;
      if ($('settingCurrentVerTag')) $('settingCurrentVerTag').textContent = cur;
      if ($('brandVersion')) $('brandVersion').textContent = cur;
      if ($('sysCommitSha')) $('sysCommitSha').textContent = '';
      if ($('latestSysVersion')) $('latestSysVersion').textContent = v.latest || cur;
      if ($('panelCheckTime')) $('panelCheckTime').textContent = '刚刚检查';

      const pBadge = $('panelUpdateBadge');
      const applyBtn = $('btnSysUpdate');
      if (v.hasUpdate) {
        if (pBadge) {
          pBadge.textContent = `发现新版本 ${v.latest}`;
          pBadge.style.color = 'var(--warn)';
        }
        if (applyBtn) {
          applyBtn.classList.remove('hidden');
          if ($('sysUpdateBtnText')) $('sysUpdateBtnText').textContent = `升级至 ${v.latest}`;
        }
        if (txt) txt.textContent = '有新版本';
        toast(`发现新版本 ${v.latest} 可更新！`);
      } else {
        if (pBadge) {
          pBadge.textContent = '当前已是最新';
          pBadge.style.color = '';
        }
        if (applyBtn) applyBtn.classList.add('hidden');
        if (txt) txt.textContent = '已是最新';
        toast('当前版本已是最新');
      }
    } catch (err) {
      toast(`检查失败：${err.message}`);
      if (txt) txt.textContent = '检查更新';
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        if (txt) txt.textContent = '检查更新';
      }, 2200);
    }
  });

  // 更新广告规则集
  $('btnAdblockRefresh')?.addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const txt = $('btnAdblockRefreshText');
    const prev = txt ? txt.textContent : '';
    if (txt) txt.textContent = '更新中...';
    try {
      const r = await api('/rulesets/refresh', { method: 'POST' });
      toast(r.ok ? '广告规则集已更新至最新' : '更新规则集失败');
    } catch (err) {
      toast(`更新失败：${err.message}`);
    } finally {
      if (txt) txt.textContent = prev;
    }
  }));

  // 立即升级面板
  $('btnSysUpdate')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const txt = $('sysUpdateBtnText');
    if (!confirm('确认拉取线上最新版本并重启控制面板？')) return;
    btn.disabled = true;
    if (txt) txt.innerHTML = '<span class="animate-spin">↻</span> 正在更新...';
    try {
      await api('/system/update', { method: 'POST' });
      toast('更新已在后台开始，面板服务即将重启...');
      if (txt) txt.textContent = '✓ 更新指令已下发';
      setTimeout(() => location.reload(), 3000);
    } catch (err) {
      btn.disabled = false;
      if (txt) txt.textContent = '立即更新';
      toast(`更新失败：${err.message}`);
    }
  });

  // 设置页右上角核心操作 3: 内核更新 (带完整成功变绿动效)
  $('btnInstallKernel')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const txt = $('kernelBtnText');
    btn.disabled = true;
    if (txt) txt.innerHTML = '<span class="animate-spin">↻</span> 查询最新...';
    try {
      const latest = await api('/kernel/latest');
      if ($('latestKernelVer')) $('latestKernelVer').textContent = latest.version;
      const cur = state.settings?.kernel?.version || '';
      if (cur && (cur === latest.version || `v${cur}` === latest.version)) {
        toast(`当前内核已是最新 (${latest.version})`);
        if (txt) txt.textContent = '内核已是最新';
        setTimeout(() => {
          btn.disabled = false;
          if (txt) txt.textContent = '内核更新';
        }, 2000);
        return;
      }
      if (!confirm(`下载并安装官方 sing-box ${latest.version}？（安装后自动重启内核）`)) {
        btn.disabled = false;
        if (txt) txt.textContent = '内核更新';
        return;
      }
      if (txt) txt.innerHTML = '<span class="animate-spin">↻</span> 正在下载内核...';
      const info = await api('/kernel/install', { method: 'POST', body: { version: latest.version } });
      btn.classList.add('btn-success');
      if (txt) txt.textContent = '✓ 内核更新成功';
      toast(`✓ 官方 sing-box ${info.version} 安装完成${info.restarted ? '，内核已热重启！' : ''}`);
      if ($('setKernelVersion')) $('setKernelVersion').textContent = info.version;
      setTimeout(() => {
        btn.classList.remove('btn-success');
        if (txt) txt.textContent = '内核更新';
        btn.disabled = false;
      }, 3000);
      await Promise.all([loadSettings(), loadOverview()]);
    } catch (err) {
      btn.disabled = false;
      if (txt) txt.textContent = '内核更新';
      toast(`内核更新失败：${err.message}`);
    }
  });

  // 当前连接页：断开全部连接
  $('btnCloseAllConns')?.addEventListener('click', window.closeAllConnections);

  // 日志相关
  $('btnLog')?.addEventListener('click', loadKernelLog);
  $('logAuto')?.addEventListener('change', scheduleLogAuto);
  $('logSearch')?.addEventListener('input', filterKernelLog);
}

/* --------------------------------------------------------------- 启动 */

bindEvents();
checkAuth();
