export function registerSubscriptionRoutes(app, deps) {
  const { loadSettings, mutateSettings, newId, deploy, log, refreshSubscription } = deps;

  app.get('/api/subscriptions', (req, res) => {
    const { subscriptions, nodes } = loadSettings();
    res.json({
      subscriptions: subscriptions.map((subscription) => {
        const subNodes = nodes.filter((node) => node.__subscriptionId === subscription.id);
        return {
          ...subscription,
          nodeCount: subNodes.length,
          sampleNodes: subNodes.slice(0, 4).map((node) => node.tag),
        };
      }),
      totalNodes: nodes.length,
    });
  });

  app.post('/api/subscriptions', async (req, res) => {
    const { name, url } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: '请填写 http(s) 订阅地址' });

    const id = newId('sub');
    mutateSettings((settings) => {
      settings.subscriptions.push({ id, name: name || `订阅 ${settings.subscriptions.length + 1}`, url, enabled: true, addedAt: Date.now() });
    });
    try {
      const result = await refreshSubscription(id);
      try {
        await deploy.deploy({ restart: true });
      } catch (depErr) {
        log.warn('订阅已保存并拉取，但内核部署未完成；运行配置可能仍是旧版本：%s', depErr.message);
      }
      res.json({ id, ...result });
    } catch (err) {
      res.status(502).json({ id, error: `订阅已保存，但拉取失败：${err.message}` });
    }
  });

  /** 启用 / 停用一条订阅。停用后它的节点不进配置，自动部署生效。 */
  app.put('/api/subscriptions/:id', async (req, res) => {
    const enabled = req.body?.enabled !== false;
    let found = false;
    mutateSettings((settings) => {
      const subscription = settings.subscriptions.find((item) => item.id === req.params.id);
      if (subscription) {
        subscription.enabled = enabled;
        found = true;
      }
    });
    if (!found) return res.status(404).json({ error: '订阅不存在' });
    try {
      await deploy.deploy({ restart: true });
      log.info('订阅 %s 已%s 并已部署生效', req.params.id, enabled ? '启用' : '停用');
    } catch (depErr) {
      log.warn('订阅 %s 已保存为%s，但内核部署未完成；运行配置可能仍是旧版本：%s', req.params.id, enabled ? '启用' : '停用', depErr.message);
    }
    res.json({ ok: true, id: req.params.id, enabled });
  });

  app.delete('/api/subscriptions/:id', async (req, res) => {
    mutateSettings((settings) => {
      settings.subscriptions = settings.subscriptions.filter((item) => item.id !== req.params.id);
      settings.nodes = settings.nodes.filter((node) => node.__subscriptionId !== req.params.id);
    });
    try {
      await deploy.deploy({ restart: true });
      log.info('订阅 %s 已删除并已部署生效', req.params.id);
    } catch (depErr) {
      log.warn('订阅 %s 已删除，但内核部署未完成；运行配置可能仍是旧版本：%s', req.params.id, depErr.message);
    }
    res.json({ ok: true });
  });

  app.get('/api/ruleset-subs', (req, res) => {
    const settings = loadSettings();
    res.json({ ok: true, items: settings.rulesetSubs || [] });
  });

  app.post('/api/ruleset-subs', (req, res) => {
    const { tag, url, format } = req.body || {};
    if (!tag || !url) return res.status(400).json({ ok: false, error: '缺少 tag 或 url' });
    const item = {
      id: `rs${Date.now()}`,
      tag: String(tag).trim(),
      url: String(url).trim(),
      format: format === 'source' ? 'source' : 'binary',
      enabled: true,
    };
    mutateSettings((settings) => {
      settings.rulesetSubs = [...(settings.rulesetSubs || []), item];
    });
    res.json({ ok: true, item });
  });

  app.put('/api/ruleset-subs/:id', (req, res) => {
    const { tag, url, format, enabled } = req.body || {};
    mutateSettings((settings) => {
      const target = (settings.rulesetSubs || []).find((item) => item.id === req.params.id);
      if (!target) return;
      if (tag !== undefined) target.tag = String(tag).trim();
      if (url !== undefined) target.url = String(url).trim();
      if (format !== undefined) target.format = format === 'source' ? 'source' : 'binary';
      if (enabled !== undefined) target.enabled = Boolean(enabled);
    });
    res.json({ ok: true });
  });

  app.delete('/api/ruleset-subs/:id', (req, res) => {
    mutateSettings((settings) => {
      settings.rulesetSubs = (settings.rulesetSubs || []).filter((item) => item.id !== req.params.id);
    });
    res.json({ ok: true });
  });

  app.post('/api/subscriptions/:id/refresh', async (req, res) => {
    try {
      res.json(await refreshSubscription(req.params.id));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/nodes', (req, res) => {
    const { nodes, subscriptions } = loadSettings();
    const subById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
    res.json({
      nodes: nodes.map(({ __subscriptionId, ...rest }) => {
        const subscription = subById.get(__subscriptionId);
        return {
          ...rest,
          subscriptionId: __subscriptionId,
          subscriptionName: subscription?.name ?? null,
          subscriptionEnabled: subscription ? subscription.enabled !== false : true,
        };
      }),
    });
  });
}
