export function registerClashRoutes(app, deps) {
  const { clashApi, loadSettings, KERNEL, fetchImpl = (...args) => fetch(...args) } = deps;

  app.get('/api/nodes/status', async (req, res) => {
    try {
      const data = await clashApi('/proxies');
      const proxies = data?.proxies ?? {};
      const groups = [];
      const nodes = [];
      const groupTypes = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance']);

      for (const [name, proxy] of Object.entries(proxies)) {
        if (name === 'GLOBAL') continue;
        if (groupTypes.has(proxy.type)) {
          groups.push({ name, type: proxy.type, now: proxy.now ?? null, members: proxy.all ?? [] });
        } else if (proxy.type !== 'Direct' && proxy.type !== 'Reject' && proxy.type !== 'Compatible') {
          nodes.push({ name, type: proxy.type, udp: proxy.udp !== false });
        }
      }

      res.json({
        groups: groups.sort((a, b) => (a.type === 'Selector' ? -1 : 1) - (b.type === 'Selector' ? -1 : 1)),
        nodes: nodes.sort((a, b) => a.name.localeCompare(b.name)),
      });
    } catch (err) {
      res.status(502).json({ error: `读取节点状态失败：${err.message}` });
    }
  });

  app.put('/api/nodes/select', async (req, res) => {
    const { group, name } = req.body || {};
    if (!group || !name) return res.status(400).json({ error: '缺少 group 或 name' });
    try {
      await clashApi(`/proxies/${encodeURIComponent(group)}`, {
        method: 'PUT',
        body: JSON.stringify({ name }),
      });
      // 切换节点后主动关闭所有已有活动连接，防止浏览器 Keep-Alive 复用旧连接导致 IP 迟迟不更新
      try {
        await clashApi('/connections', { method: 'DELETE' });
      } catch {}
      deps.log.info('切换分组 %s → %s 并已清空旧连接', group, name);
      res.json({ ok: true, group, name });
    } catch (err) {
      res.status(502).json({ error: `切换失败：${err.message}` });
    }
  });

  app.get('/api/nodes/latency', async (req, res) => {
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: '缺少 name' });
    const url = req.query.url || 'http://www.gstatic.com/generate_204';
    const timeout = Math.min(Math.max(Number(req.query.timeout) || 2800, 1000), 10000);
    try {
      const result = await clashApi(
        `/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(url)}&timeout=${timeout}`,
      );
      res.json({ name, delay: result?.delay ?? null, error: null });
    } catch (err) {
      // 超时/不可达是正常结果，不是服务端错误
      res.json({ name, delay: null, error: err.message.replace(/^.*内核返回 /, '') });
    }
  });

  app.post('/api/nodes/latency/batch', async (req, res) => {
    const names = Array.isArray(req.body?.names) ? req.body.names.slice(0, 200) : [];
    const url = req.body?.url || 'http://www.gstatic.com/generate_204';
    const timeout = Math.min(Math.max(Number(req.body?.timeout) || 2800, 1000), 10000);
    const results = {};
    if (!names.length) return res.json({ results });

    const concurrency = Math.min(10, names.length);
    let cursor = 0;
    async function worker() {
      while (cursor < names.length) {
        const index = cursor++;
        const name = names[index];
        try {
          const result = await clashApi(
            `/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(url)}&timeout=${timeout}`,
          );
          results[name] = { delay: result?.delay ?? null, error: null };
        } catch (err) {
          results[name] = { delay: null, error: err.message.replace(/^.*内核返回 /, '') };
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    res.json({ results });
  });

  app.get('/api/connections', async (req, res) => {
    try {
      const data = await clashApi('/connections');
      res.json({
        ok: true,
        connections: data?.connections ?? [],
        uploadTotal: data?.uploadTotal ?? 0,
        downloadTotal: data?.downloadTotal ?? 0,
        memory: data?.memory ?? 0,
      });
    } catch (err) {
      // 内核未启动或暂时不可达时优雅降级返回空连接列表，避免前端报 404/500
      res.json({ ok: false, connections: [], uploadTotal: 0, downloadTotal: 0, error: err.message });
    }
  });

  app.delete('/api/connections', async (req, res) => {
    try {
      await clashApi('/connections', { method: 'DELETE' });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  app.delete('/api/connections/:id', async (req, res) => {
    try {
      await clashApi(`/connections/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/nodes/connections', async (req, res) => {
    try {
      const data = await clashApi('/connections');
      const list = data?.connections ?? [];
      res.json({
        total: list.length,
        uploadTotal: data?.uploadTotal ?? 0,
        downloadTotal: data?.downloadTotal ?? 0,
        recent: list.slice(0, 30).map((connection) => ({
          host: connection.metadata?.host || connection.metadata?.destinationIP || '',
          rule: connection.rule || '',
          chain: connection.chains || [],
          network: connection.metadata?.network || '',
        })),
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Keep this catch-all mounted after the explicit API routes.
  app.use('/api/controller', async (req, res) => {
    const settings = loadSettings();
    const suffix = req.url && req.url !== '/' ? req.url : '/';
    const url = `http://${KERNEL.clashApiHost}:${KERNEL.clashApiPort}${suffix}`;
    try {
      const upstream = await fetchImpl(url, {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          ...(settings.kernel.clashSecret ? { Authorization: `Bearer ${settings.kernel.clashSecret}` } : {}),
        },
        ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: JSON.stringify(req.body ?? {}) }),
      });
      const text = await upstream.text();
      res.status(upstream.status).type('application/json').send(text || '{}');
    } catch (err) {
      res.status(502).json({ error: `内核未运行或不可达：${err.message}` });
    }
  });
}
