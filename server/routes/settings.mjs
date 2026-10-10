function sanitize(settings) {
  const { panel, ...rest } = settings;
  return { ...rest, panel: { passwordSet: Boolean(panel.passwordHash) } };
}

export function registerSettingsRoutes(app, deps) {
  const { loadSettings, saveSettings, normalizeGroupInput, normalizePolicyInput, kernel, netstack, platform } = deps;

  app.get('/api/overview', async (req, res) => {
    const settings = loadSettings();
    const k = await kernel.status();
    res.json({
      kernel: { ...k, versionOutput: await kernel.versionOutput() },
      dnsmasq: await netstack.dnsmasqStatus(),
      platform: platform.describe(),
      counts: {
        subscriptions: settings.subscriptions.length,
        nodes: settings.nodes.length,
        groups: settings.groups.filter((group) => group.enabled).length,
        policies: settings.policies.length,
        policiesEnabled: settings.policies.filter((policy) => policy.enabled).length,
      },
      meta: settings.meta,
      node: process.version,
    });
  });

  app.get('/api/settings', async (req, res) => {
    const data = sanitize(loadSettings({ force: true }));
    // 版本以磁盘上的实际内核为准，不看 settings 里那份（可能是安装脚本装的、没记进来）
    data.kernel = { ...data.kernel, version: await kernel.installedVersion(), installed: kernel.installed() };
    res.json(data);
  });

  app.put('/api/settings', (req, res) => {
    const incoming = req.body || {};
    const current = loadSettings({ force: true });
    // 接受已知的顶层区块，防止把任意字段写进配置
    for (const key of ['kernel', 'network', 'dns', 'meta']) {
      if (incoming[key] && typeof incoming[key] === 'object') {
        current[key] = { ...current[key], ...incoming[key] };
      }
    }
    // 兼容直接通过 settings 接口保存 groups / policies
    if (Array.isArray(incoming.groups)) current.groups = incoming.groups.map(normalizeGroupInput);
    if (Array.isArray(incoming.policies)) current.policies = incoming.policies.map(normalizePolicyInput);
    saveSettings(current);
    res.json(sanitize(current));
  });
}
