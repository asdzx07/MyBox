/* MyBox 面板 —— 基于官方 sing-box 的透明代理控制面板，无构建步骤，直接跑。 */

const $ = (id) => document.getElementById(id);

let state = {
  settings: null,
  groups: [],
  policies: [],
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

const GROUP_LABEL = {
  Selector: '手动选择',
  URLTest: '自动择优',
  Fallback: '故障转移',
  LoadBalance: '负载均衡',
  selector: '手动选择',
  urltest: '自动择优',
  fallback: '故障转移',
  loadbalance: '负载均衡',
};

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

let connCache = { connections: [], uploadTotal: 0, downloadTotal: 0 };
let ignoredConnIds = new Set();
let isConnViewCleared = false;

window.clearConnectionRecords = function() {
  const conns = connCache.connections || [];
  conns.forEach(c => { if (c.id) ignoredConnIds.add(c.id); });
  isConnViewCleared = true;
  renderConnections();
  toast('已清空当前连接记录，正在监听新连接…');
};

window.resetConnectionRecords = function() {
  ignoredConnIds.clear();
  isConnViewCleared = false;
  loadConnectionsPage();
};

function renderConnections() {
  const countEl = $('connPageCount');
  const listEl = $('connsList');
  if (!listEl) return;

  const allConns = connCache.connections || [];
  const conns = isConnViewCleared ? allConns.filter(c => !ignoredConnIds.has(c.id)) : allConns;
  const query = ($('connSearch')?.value || '').trim().toLowerCase();

  const filtered = query
    ? conns.filter((c) => {
        const host = (c.metadata?.host || c.metadata?.destinationIP || '').toLowerCase();
        const port = String(c.metadata?.destinationPort || '');
        const src = (c.metadata?.sourceIP || '').toLowerCase();
        const proto = (c.metadata?.network || '').toLowerCase();
        const chain = (c.chains || []).join(' ').toLowerCase();
        const rule = (c.rule || '').toLowerCase();
        return host.includes(query) || port.includes(query) || src.includes(query) ||
               proto.includes(query) || chain.includes(query) || rule.includes(query);
      })
    : conns;

  if (countEl) {
    if (query) {
      countEl.textContent = `匹配 ${filtered.length} / 当前 ${conns.length} 条连接`;
    } else {
      countEl.textContent = `${conns.length} 条连接 · 累计 ↓ ${fmtBytes(connCache.downloadTotal || 0)} / ↑ ${fmtBytes(connCache.uploadTotal || 0)}${isConnViewCleared ? ' (已过滤历史记录)' : ''}`;
    }
  }

  if (!filtered.length) {
    if (isConnViewCleared) {
      listEl.innerHTML = `
        <div style="padding:28px 0;text-align:center">
          <p class="note" style="margin-bottom:10px">当前页面记录已清空，正在监听新接入的连接…</p>
          <button class="small" onclick="resetConnectionRecords()">恢复显示全部连接</button>
        </div>
      `;
    } else {
      listEl.innerHTML = query
        ? '<p class="note" style="padding:16px 0;text-align:center">未找到匹配的连接</p>'
        : '<p class="note" style="padding:16px 0;text-align:center">当前没有活动连接</p>';
    }
    return;
  }

  listEl.innerHTML = `<div class="list">${filtered.map((c) => {
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
}

let connAutoPollTimer = null;

async function loadConnectionsPage() {
  const listEl = $('connsList');
  try {
    const data = await api('/connections');
    connCache = {
      connections: data.connections || [],
      uploadTotal: data.uploadTotal || 0,
      downloadTotal: data.downloadTotal || 0,
    };
    renderConnections();
  } catch (err) {
    if (listEl) listEl.innerHTML = `<p class="err-text" style="padding:16px 0">${escapeHtml(err.message)}</p>`;
  }
}

function startConnAutoPoll() {
  stopConnAutoPoll();
  loadConnectionsPage();
  connAutoPollTimer = setInterval(loadConnectionsPage, 1500);
}

function stopConnAutoPoll() {
  if (connAutoPollTimer) {
    clearInterval(connAutoPollTimer);
    connAutoPollTimer = null;
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
  if (!confirm('确定清空并断开所有当前活动连接吗？（客户端会自动重连）')) return;
  try {
    await api('/connections', { method: 'DELETE' });
    toast('已清空所有连接');
    await loadConnectionsPage();
  } catch (err) {
    toast(`清空失败：${err.message}`);
  }
};

/* --------------------------------------------------------------- 内网分流 */

async function loadClients() {
  const box = $('clientList');
  try {
    const res = await api('/clients');
    state.clients = res.clients || [];
    renderClients();
  } catch (err) {
    if (box) box.innerHTML = `<p class="err-text" style="padding:12px 0">加载内网设备失败：${escapeHtml(err.message)}</p>`;
  }
}

function renderClients() {
  const box = $('clientList');
  if (!box) return;
  if (!state.clients.length) {
    box.innerHTML = '<p class="note" style="padding:16px 0;text-align:center">暂无内网设备。请点击上方「刷新设备列表」自动扫描在线设备，或点击「＋ 添加设备」手动添加。</p>';
    return;
  }
  box.innerHTML = state.clients.map((c, i) => `
    <div class="client-item">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span>${escapeHtml(c.name || '未命名设备')}</span>
          <span class="tag muted" style="font-family:monospace;font-size:12px">${escapeHtml(c.ip)}</span>
          ${c.mac ? `<span class="tag muted" style="font-size:11px;opacity:0.8">${escapeHtml(c.mac)}</span>` : ''}
          ${c.online ? `<span class="tag" style="color:var(--ok);font-size:11px;font-weight:600">● 在线</span>` : ''}
        </div>
        <div class="note" style="margin-top:4px">${escapeHtml(c.note || (c.online ? '局域网在线设备' : '已配置设备'))}</div>
      </div>
      <div class="inline" style="gap:8px;align-items:center;flex-shrink:0">
        <select onchange="updateClientMode('${escapeHtml(c.id || c.ip)}', this.value)" style="width:auto;font-size:12px;padding:4px 8px">
          <option value="rule"${c.mode === 'rule' ? ' selected' : ''}>规则分流 (推荐)</option>
          <option value="proxy"${c.mode === 'proxy' ? ' selected' : ''}>全局代理</option>
          <option value="direct"${c.mode === 'direct' ? ' selected' : ''}>完全直连 (绕过代理)</option>
        </select>
        <button class="small" onclick="openClientModal(${i})" style="padding:4px 9px">编辑</button>
        <button class="small danger" onclick="removeClient('${escapeHtml(c.id || c.ip)}')" style="padding:4px 9px">删除</button>
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

async function saveClientModal() {
  const idx = Number($('modalClientIndex').value);
  const name = $('modalClientName').value.trim();
  const ip = $('modalClientIp').value.trim();
  const mode = $('modalClientMode').value;
  if (!ip) {
    toast('请输入设备 IP 地址');
    return;
  }
  if (!/^192\.168\.\d+\.\d+|^10\.\d+\.\d+\.\d+|^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/.test(ip)) {
    toast('请输入正确的局域网内网 IP 地址');
    return;
  }
  if (idx >= 0 && state.clients[idx]) {
    state.clients[idx].name = name || '未命名设备';
    state.clients[idx].ip = ip;
    state.clients[idx].mode = mode;
  } else {
    state.clients.push({
      id: `client-${Date.now()}`,
      name: name || `设备 ${ip}`,
      ip,
      mode,
      note: '手动添加',
      online: true,
    });
  }
  try {
    await api('/clients', { method: 'POST', body: { clients: state.clients } });
    renderClients();
    closeClientModal();
    toast(`已保存设备「${name || ip}」`);
  } catch (err) {
    toast(`保存失败：${err.message}`);
  }
}

window.updateClientMode = async function(id, mode) {
  const client = state.clients.find((c) => c.id === id || c.ip === id);
  if (client) {
    client.mode = mode;
    try {
      await api('/clients', { method: 'POST', body: { clients: state.clients } });
      toast(`已更新设备「${client.name || client.ip}」策略为：${mode === 'direct' ? '完全直连' : (mode === 'proxy' ? '全局代理' : '规则分流')}`);
    } catch (err) {
      toast(`更新策略失败：${err.message}`);
    }
  }
};

window.removeClient = async function(id) {
  const client = state.clients.find((c) => c.id === id || c.ip === id);
  const name = client?.name || client?.ip || '该设备';
  if (confirm(`确认移除「${name}」的独立分流规则？`)) {
    try {
      await api(`/clients/${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.clients = state.clients.filter((c) => c.id !== id && c.ip !== id);
      renderClients();
      toast('已移除设备规则');
    } catch (err) {
      toast(`移除失败：${err.message}`);
    }
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
    const data = await api('/groups');
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
  box.innerHTML = state.groups.map((g, i) => {
    const isBuiltin = g.id === 'all-auto' || g.id === 'all-manual';
    const typeKey = String(g.type || '').toLowerCase();
    const typeText = typeKey === 'urltest' ? '自动择优' : '手动选择';
    return `
    <div class="card" style="background:var(--surface-2);margin-bottom:10px">
      <div class="row" style="align-items:flex-end">
        <label class="field" style="flex:1 1 140px">
          <span>分组名称</span>
          <input data-g-name="${i}" value="${escapeHtml(g.name || '')}">
        </label>
        <label class="field" style="flex:1 1 120px">
          <span>类型</span>
          <input value="${escapeHtml(typeText)}" readonly>
        </label>
        <label class="field" style="flex:2 1 200px">
          <span>${g.mode === 'dynamic' ? '匹配关键词（逗号分隔）' : '包含节点（逗号分隔）'}</span>
          <input data-g-members="${i}" value="${escapeHtml((g.mode === 'dynamic' ? g.keywords : g.members)?.join(', ') || '')}">
        </label>
        <div class="fixed" style="padding-bottom:10px;display:flex;align-items:center;gap:10px">
          <label class="inline"><input type="checkbox" data-g-enabled="${i}"${g.enabled !== false ? ' checked' : ''} style="width:auto"> 启用</label>
          ${isBuiltin ? '' : `<button class="small danger" onclick="removeGroup(${i}, event)" style="padding:4px 8px">删除</button>`}
        </div>
      </div>
    </div>
  `;
  }).join('');
}

window.removeGroup = function(index, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const g = state.groups[index];
  if (!g) return;
  if (!confirm(`确定删除节点分组「${g.name || '未命名'}」吗？`)) return;
  state.groups.splice(index, 1);
  renderGroups();
  toast('已删除分组，记得点击下方「保存分组」生效');
};

/* --------------------------------------------------------------- 目标分流 */

async function loadPolicies() {
  try {
    const data = await api('/policies');
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

function formatTargetLabel(val) {
  if (!val) return '—';
  if (val === 'builtin-direct' || val === 'direct') return '直连';
  if (val === 'builtin-block' || val === 'block') return '拒绝';
  if (val === 'all-auto') return '所有-自动';
  if (val === 'all-manual') return '所有-手动';
  const found = (state.groups || []).find((g) => g.id === val || g.name === val);
  if (found) return found.name;
  return val;
}

/**
 * 组装策略出口目标的下拉选项 HTML：支持内置出口、节点分组、所有单节点、以及绝对防回退兜底
 */
function getTargetOptionsHtml(currentTarget = '') {
  let matched = false;
  let html = '';

  // 1. 基础目标
  const builtins = [
    { val: 'all-auto', label: '所有-自动 (自动择优)' },
    { val: 'all-manual', label: '所有-手动 (手动切换)' },
    { val: 'builtin-direct', label: '直连 (direct - 绕过代理)' },
    { val: 'builtin-block', label: '拒绝 (block - 阻止连接)' },
  ];

  html += '<optgroup label="基础目标">';
  for (const b of builtins) {
    const isSel = (!matched) && (
      b.val === currentTarget ||
      (b.val === 'all-auto' && currentTarget === '所有-自动') ||
      (b.val === 'all-manual' && currentTarget === '所有-手动') ||
      (b.val === 'builtin-direct' && (currentTarget === 'direct' || currentTarget === 'builtin-direct')) ||
      (b.val === 'builtin-block' && (currentTarget === 'block' || currentTarget === 'builtin-block'))
    );
    if (isSel) matched = true;
    html += `<option value="${escapeHtml(b.val)}"${isSel ? ' selected' : ''}>${escapeHtml(b.label)}</option>`;
  }
  html += '</optgroup>';

  // 2. 出站分组 (排除内置的 all-auto 和 all-manual，因基础目标中已包含)
  const excludeIds = new Set(['all-auto', 'all-manual', 'direct', 'block', 'builtin-direct', 'builtin-block']);
  const groupItems = (state.groups || []).filter((g) => g && !excludeIds.has(g.id) && !excludeIds.has(g.name));

  if (groupItems.length) {
    html += '<optgroup label="出站分组">';
    for (const g of groupItems) {
      const gid = g.id || g.name;
      const isSel = (!matched) && (currentTarget === g.id || currentTarget === g.name);
      if (isSel) matched = true;
      const typeLabel = (g.type === 'urltest' || g.type === 'URLTest') ? '自动' : '手动';
      html += `<option value="${escapeHtml(gid)}"${isSel ? ' selected' : ''}>${escapeHtml(g.name)} (${typeLabel})</option>`;
    }
    html += '</optgroup>';
  }

  // 3. 单个节点
  const nodes = (state.nodeList || []).map((n) => n.name).filter(Boolean);
  if (nodes.length) {
    html += '<optgroup label="指定单个节点">';
    for (const n of nodes) {
      const isSel = (!matched) && (n === currentTarget);
      if (isSel) matched = true;
      html += `<option value="${escapeHtml(n)}"${isSel ? ' selected' : ''}>${escapeHtml(n)}</option>`;
    }
    html += '</optgroup>';
  }

  // 4. 防御性兜底：若前序均未匹配，且 currentTarget 非空，强制将其插入作为选中项，彻底杜绝浏览器回退到首项
  if (!matched && currentTarget) {
    html = `<optgroup label="当前配置"><option value="${escapeHtml(currentTarget)}" selected>${escapeHtml(formatTargetLabel(currentTarget))}</option></optgroup>` + html;
  }

  return html;
}

function renderPolicies() {
  const box = $('policyList');
  if (!state.policies.length) {
    box.innerHTML = '<p class="note">还没有策略。</p>';
    return;
  }
  const isCol = (idx) => state.policyCollapsed?.[idx] === true;

  box.innerHTML = state.policies.map((p, i) => {
    const collapsed = isCol(i);
    const targetVal = p.target || 'all-auto';
    return `
    <div class="card" style="background:var(--surface-2);margin-bottom:12px">
      <div class="card-head group-head" data-policy-collapse="${i}" style="cursor:pointer;margin-bottom:${collapsed ? '0' : '12px'}">
        <span class="chevron">${collapsed ? '▸' : '▾'}</span>
        <h3 style="display:flex;align-items:center;gap:6px">${policyIcon(p.name)}${escapeHtml(p.name)}</h3>
        <span class="tag muted" data-p-status="${i}">${p.enabled ? '已启用' : '已关闭'}</span>
        <span class="note" style="font-size:12px;margin-left:6px">出口：<strong style="color:var(--accent)" id="policyTargetLabel-${i}">${escapeHtml(formatTargetLabel(targetVal))}</strong></span>
        <div class="spacer"></div>
        <label class="switch" onclick="event.stopPropagation()">
          <input type="checkbox" data-p-enabled="${i}"${p.enabled ? ' checked' : ''}>
          <span></span>
        </label>
        <button class="small danger" onclick="removePolicy(${i}, event)">删除</button>
      </div>
      <div data-p-body="${i}" class="${collapsed ? 'hidden' : ''}">
        <div class="row">
          <label class="field" style="flex:1 1 200px">
            <span>策略名称</span>
            <input data-p-name="${i}" value="${escapeHtml(p.name || '')}">
          </label>
          <label class="field" style="flex:1 1 240px">
            <span>出口目标（直连/拒绝/分组/节点）</span>
            <select data-p-target="${i}" onchange="updatePolicyTarget(${i}, this.value)">
              ${getTargetOptionsHtml(targetVal)}
            </select>
          </label>
        </div>
        <div class="row">
          <label class="field"><span>规则集 (rulesets)</span><input data-p-rulesets="${i}" value="${escapeHtml(p.rulesets?.join(', ') || '')}"></label>
          <label class="field"><span>域名后缀 (domain_suffix)</span><input data-p-suffix="${i}" value="${escapeHtml(p.domainSuffix?.join(', ') || '')}"></label>
        </div>
      </div>
    </div>
  `;
  }).join('');
}

window.updatePolicyTarget = function(index, val) {
  if (state.policies[index]) {
    state.policies[index].target = val;
    const labelEl = $(`policyTargetLabel-${index}`);
    if (labelEl) labelEl.textContent = formatTargetLabel(val);
  }
};

window.removePolicy = function(index, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const p = state.policies[index];
  if (!p) return;
  if (!confirm(`确定删除分流策略「${p.name || '未命名策略'}」吗？`)) return;
  state.policies.splice(index, 1);
  renderPolicies();
  toast('已删除策略，记得点击下方「保存策略」生效');
};

/* ---------------------------------------------------------- 自定义规则集订阅 */

async function loadRulesetSubs() {
  const box = $('rulesetSubList');
  try {
    const data = await api('/ruleset-subs');
    const list = data.items || data.subscriptions || [];
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<p class="note" style="padding:10px 0">暂无自定义规则集订阅。点击右上角「添加」可引入远程规则集。</p>';
      return;
    }
    box.innerHTML = list.map((r) => `
      <div class="item">
        <label class="switch">
          <input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="toggleRulesetSub('${escapeHtml(r.id)}', this.checked)">
          <span></span>
        </label>
        <div class="grow">
          <div class="title" style="font-weight:600">
            ${escapeHtml(r.tag)}
            <span class="tag muted" style="font-size:11px;margin-left:6px">${r.format === 'source' ? 'Source' : 'Binary'}</span>
          </div>
          <div class="sub" style="font-size:12px;color:var(--text-2);word-break:break-all">${escapeHtml(r.url)}</div>
        </div>
        <button class="small danger" onclick="removeRulesetSub('${escapeHtml(r.id)}')">删除</button>
      </div>
    `).join('');
  } catch (err) {
    if (box) box.innerHTML = `<p class="err-text">加载规则集失败：${escapeHtml(err.message)}</p>`;
  }
}

window.openRulesetModal = function() {
  const modal = $('rulesetModal');
  if (!modal) return;
  $('modalRsTag').value = '';
  $('modalRsUrl').value = '';
  $('modalRsFormat').value = 'binary';
  modal.classList.remove('hidden');
};

window.closeRulesetModal = function() {
  const modal = $('rulesetModal');
  if (modal) modal.classList.add('hidden');
};

async function saveRulesetModal() {
  const tag = $('modalRsTag')?.value.trim();
  const url = $('modalRsUrl')?.value.trim();
  const format = $('modalRsFormat')?.value || 'binary';
  if (!tag) {
    toast('请输入规则集标识 (Tag)');
    return;
  }
  if (!url) {
    toast('请输入规则集订阅 URL');
    return;
  }
  try {
    await api('/ruleset-subs', {
      method: 'POST',
      body: { tag, url, format },
    });
    closeRulesetModal();
    await loadRulesetSubs();
    toast(`已添加规则集「${tag}」，改动已保存`);
  } catch (err) {
    toast(`添加失败：${err.message}`);
  }
}

window.toggleRulesetSub = async function(id, enabled) {
  try {
    await api(`/ruleset-subs/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: { enabled },
    });
    toast(enabled ? '已启用该规则集订阅' : '已停用该规则集订阅');
  } catch (err) {
    toast(`更新状态失败：${err.message}`);
    loadRulesetSubs();
  }
};

window.removeRulesetSub = async function(id) {
  if (!confirm('确认删除该规则集订阅？')) return;
  try {
    await api(`/ruleset-subs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('已删除规则集订阅');
    await loadRulesetSubs();
  } catch (err) {
    toast(`删除失败：${err.message}`);
  }
};

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
    loadNodes(),
    loadSettings(),
  ]);
  // 必须确保 groups 和 nodes 已经加载完毕，再执行 loadPolicies 渲染下拉选项
  await loadPolicies();
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
      if (tab === 'connections') {
        startConnAutoPoll();
      } else {
        stopConnAutoPoll();
      }
      if (tab === 'clients') loadClients();
      if (tab === 'subscriptions') await loadSubscriptions();
      if (tab === 'policies') {
        if (!state.groups?.length) await loadGroups();
        if (!state.nodeList?.length) await loadNodes();
        await loadPolicies();
      }
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
    const newIdx = state.groups.length + 1;
    state.groups.push({
      id: `grp-${Date.now()}`,
      name: `自定义组-${newIdx}`,
      type: 'selector',
      mode: 'dynamic',
      keywords: [],
      members: [],
      enabled: true,
    });
    renderGroups();
    toast('已添加新分组，请填写名称和关键词后点击「保存分组」');
  });

  $('btnSaveGroups')?.addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    // 强制从 DOM 元素提取所有分组字段的最新输入值
    document.querySelectorAll('#groupList input[data-g-name]').forEach((input) => {
      const idx = Number(input.dataset.gName);
      if (state.groups[idx]) {
        state.groups[idx].name = input.value.trim();
      }
    });
    document.querySelectorAll('#groupList input[data-g-members]').forEach((input) => {
      const idx = Number(input.dataset.gMembers);
      if (state.groups[idx]) {
        const arr = input.value.split(',').map((s) => s.trim()).filter(Boolean);
        if (state.groups[idx].mode === 'dynamic') {
          state.groups[idx].keywords = arr;
        } else {
          state.groups[idx].members = arr;
        }
      }
    });
    document.querySelectorAll('#groupList input[data-g-enabled]').forEach((input) => {
      const idx = Number(input.dataset.gEnabled);
      if (state.groups[idx]) {
        state.groups[idx].enabled = input.checked;
      }
    });

    const res = await api('/groups', { method: 'PUT', body: { groups: state.groups } });
    if (res?.groups) state.groups = res.groups;
    renderGroups();
    // 联动刷新策略下拉框中的分组列表
    if (state.policies?.length) renderPolicies();
    toast('分组已保存并已部署生效（内核已应用）');
  }));

  $('groupList')?.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.gName !== undefined) {
      const i = Number(t.dataset.gName);
      if (state.groups[i]) state.groups[i].name = t.value.trim();
    } else if (t.dataset.gMembers !== undefined) {
      const i = Number(t.dataset.gMembers);
      if (state.groups[i]) {
        const arr = t.value.split(',').map((s) => s.trim()).filter(Boolean);
        if (state.groups[i].mode === 'dynamic') {
          state.groups[i].keywords = arr;
        } else {
          state.groups[i].members = arr;
        }
      }
    }
  });

  $('groupList')?.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.gEnabled !== undefined) {
      const i = Number(t.dataset.gEnabled);
      if (state.groups[i]) state.groups[i].enabled = t.checked;
    }
  });

  // 内网分流按键与弹窗
  $('btnScanClients')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const oldHtml = btn.innerHTML;
    btn.innerHTML = '<span class="animate-spin">↻</span> 正在扫描局域网设备...';
    try {
      const res = await api('/clients/scan', { method: 'POST' });
      state.clients = res.clients || [];
      renderClients();
      toast(`扫描完成，共发现 ${state.clients.length} 台局域网设备`);
    } catch (err) {
      toast(`扫描失败：${err.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
    }
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
  $('btnConnsRefresh')?.addEventListener('click', (e) => withBusy(e.currentTarget, resetConnectionRecords));
  $('btnCloseAllConns')?.addEventListener('click', closeAllConnections);
  $('connSearch')?.addEventListener('input', renderConnections);
  $('connSearch')?.addEventListener('search', renderConnections);
  $('btnClearConnRecords')?.addEventListener('click', clearConnectionRecords);

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
    // 强制从 DOM 提取所有策略控件的最新值
    document.querySelectorAll('#policyList select[data-p-target]').forEach((sel) => {
      const idx = Number(sel.dataset.pTarget);
      if (state.policies[idx]) {
        state.policies[idx].target = sel.value;
      }
    });
    document.querySelectorAll('#policyList input[data-p-name]').forEach((input) => {
      const idx = Number(input.dataset.pName);
      if (state.policies[idx]) {
        state.policies[idx].name = input.value.trim();
      }
    });
    document.querySelectorAll('#policyList input[data-p-rulesets]').forEach((input) => {
      const idx = Number(input.dataset.pRulesets);
      if (state.policies[idx]) {
        state.policies[idx].rulesets = input.value.split(',').map((s) => s.trim()).filter(Boolean);
      }
    });
    document.querySelectorAll('#policyList input[data-p-suffix]').forEach((input) => {
      const idx = Number(input.dataset.pSuffix);
      if (state.policies[idx]) {
        state.policies[idx].domainSuffix = input.value.split(',').map((s) => s.trim()).filter(Boolean);
      }
    });

    const res = await api('/policies', { method: 'PUT', body: { policies: state.policies } });
    if (res?.policies) state.policies = res.policies;
    renderPolicies();
    toast('策略已保存并已部署生效（内核已应用）');
  }));

  $('btnAddPolicy').addEventListener('click', () => {
    const id = 'custom-' + Date.now();
    state.policies.push({ id, name: '新策略', target: 'builtin-direct', rulesets: [], domainSuffix: [], enabled: true });
    renderPolicies();
  });

  $('btnCollapseAllPolicies')?.addEventListener('click', () => {
    if (!state.policyCollapsed) state.policyCollapsed = {};
    const anyExpanded = state.policies.some((_, i) => !state.policyCollapsed[i]);
    state.policies.forEach((_, i) => { state.policyCollapsed[i] = anyExpanded; });
    renderPolicies();
    toast(anyExpanded ? '已全部折叠分流策略' : '已全部展开分流策略');
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

  $('policyList').addEventListener('click', (e) => {
    // 点击卡片头折叠/展开 (同节点分组效果)
    const collapseEl = e.target.closest('[data-policy-collapse]');
    if (collapseEl && !e.target.closest('.switch') && !e.target.closest('button')) {
      const idx = Number(collapseEl.dataset.policyCollapse);
      if (!state.policyCollapsed) state.policyCollapsed = {};
      state.policyCollapsed[idx] = !state.policyCollapsed[idx];
      renderPolicies();
    }
  });

  $('policyList').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.pName !== undefined) {
      const i = Number(t.dataset.pName);
      if (state.policies[i]) state.policies[i].name = t.value;
    } else if (t.dataset.pRulesets !== undefined) {
      const i = Number(t.dataset.pRulesets);
      if (state.policies[i]) {
        state.policies[i].rulesets = t.value.split(',').map((s) => s.trim()).filter(Boolean);
      }
    } else if (t.dataset.pSuffix !== undefined) {
      const i = Number(t.dataset.pSuffix);
      if (state.policies[i]) {
        state.policies[i].domainSuffix = t.value.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
  });

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

  // 自定义规则集订阅弹窗按键
  $('btnAddRulesetSub')?.addEventListener('click', openRulesetModal);
  $('btnCancelRulesetModal')?.addEventListener('click', closeRulesetModal);
  $('btnSaveRulesetModal')?.addEventListener('click', saveRulesetModal);
  $('rulesetModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'rulesetModal') closeRulesetModal();
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
