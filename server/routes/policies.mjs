export function registerPolicyRoutes(app, deps) {
  const { loadSettings, mutateSettings, normalizeGroupInput, normalizePolicyInput, DEFAULT_POLICIES, flipTag, setFlip, deploy, log } = deps;

  app.get('/api/groups', (req, res) => {
    const { groups, nodes } = loadSettings();
    res.json({ groups, availableNodes: nodes.map((node) => node.tag) });
  });

  app.put('/api/groups', async (req, res) => {
    const list = req.body?.groups;
    if (!Array.isArray(list)) return res.status(400).json({ error: 'groups 必须是数组' });
    const clean = list.map(normalizeGroupInput);
    if (clean.some((group) => !group.name)) return res.status(400).json({ error: '分组名不能为空' });
    mutateSettings((settings) => {
      settings.groups = clean;
    });
    try {
      await deploy.deploy({ restart: true });
      log.info('分组配置保存并已部署生效');
    } catch (err) {
      log.warn('分组配置已保存，但内核部署未完成；运行配置可能仍是旧版本：%s', err.message);
    }
    res.json({ ok: true, groups: clean });
  });

  app.get('/api/policies', (req, res) => {
    const { policies, groups } = loadSettings();
    const toId = (target) => {
      if (target === 'builtin-direct' || target === 'direct') return 'builtin-direct';
      if (target === 'builtin-block' || target === 'block') return 'builtin-block';
      const group = groups.find((item) => item.name === target || item.id === target);
      return group ? group.id : target;
    };
    res.json({
      policies: policies.map((policy) => ({ ...policy, target: toId(policy.target), flipTag: flipTag(policy.id) })),
      targets: [
        { value: 'builtin-direct', label: '直连' },
        { value: 'builtin-block', label: '拒绝' },
        ...groups.filter((group) => group.enabled).map((group) => ({ value: group.id, label: group.name })),
      ],
    });
  });

  app.put('/api/policies', async (req, res) => {
    const list = req.body?.policies;
    if (!Array.isArray(list)) return res.status(400).json({ error: 'policies 必须是数组' });
    const clean = list.map(normalizePolicyInput);
    if (clean.some((policy) => !policy.name)) return res.status(400).json({ error: '策略名不能为空' });
    mutateSettings((settings) => {
      settings.policies = clean;
    });
    for (const policy of clean) {
      try {
        setFlip(policy.id, policy.enabled);
      } catch (err) {
        log.warn('写入策略 %s 的热切换状态失败：%s', policy.id, err.message);
      }
    }
    try {
      await deploy.deploy({ restart: true });
      log.info('策略配置保存并已部署生效');
    } catch (err) {
      log.warn('策略配置已保存，但内核部署未完成；运行配置可能仍是旧版本：%s', err.message);
    }
    res.json({ ok: true, policies: clean });
  });

  /**
   * 恢复默认策略。
   * 故意不保留旧出口：早期面板写的是分组名称、默认策略存的是分组 id，两套标识
   * 混在一起，按名字“保留用户选择”会把「国内」这种本该直连的策略指到代理组上。
   * 恢复默认就是恢复默认，要保留自己的配置请用「导出设置」。
   */
  app.post('/api/policies/reset', async (req, res) => {
    const next = DEFAULT_POLICIES.map((policy) => ({ ...policy }));
    mutateSettings((settings) => {
      settings.policies = next;
    });
    for (const policy of next) {
      try {
        setFlip(policy.id, policy.enabled);
      } catch (err) {
        log.warn('写入策略 %s 的热切换状态失败：%s', policy.id, err.message);
      }
    }
    try {
      await deploy.deploy({ restart: true });
    } catch (err) {
      log.warn('默认策略已保存，但内核部署未完成；运行配置可能仍是旧版本：%s', err.message);
    }
    res.json({ ok: true, policies: next });
  });

  /** 单独切换一个策略的开关——只改那个小文件，不重新部署、不重启内核。 */
  app.post('/api/policies/:id/toggle', (req, res) => {
    const enabled = req.body?.enabled !== false;
    const result = deploy.togglePolicy(req.params.id, enabled);
    res.json({ ok: true, ...result });
  });
}
