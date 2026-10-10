export function registerOperationRoutes(app, deps) {
  const { fs, path, spawn, ROOT, DATA_DIR, loadSettings, getTraffic, resetTrafficTotals, kernel, deploy, log } = deps;

  app.get('/api/traffic', (req, res) => {
    res.json({ ok: true, ...getTraffic() });
  });

  app.post('/api/traffic/reset', (req, res) => {
    resetTrafficTotals();
    res.json({ ok: true });
  });

  app.post('/api/adblock/refresh', async (req, res) => {
    try {
      // 删掉缓存的广告规则集 SRS，重启内核强制重新下载
      let deleted = 0;
      for (const dir of [DATA_DIR, '/tmp', process.cwd()]) {
        try {
          for (const file of fs.readdirSync(dir)) {
            if (file === 'adblock.srs' || file.startsWith('adblock.')) {
              fs.unlinkSync(path.join(dir, file));
              deleted++;
            }
          }
        } catch {}
      }
      await kernel.restart();
      res.json({ ok: true, deleted });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/rulesets/refresh', async (req, res) => {
    try {
      // 删掉所有缓存的远程规则集 SRS（策略用的 geosite/geoip），重启内核强制重新下载
      let deleted = 0;
      for (const dir of [DATA_DIR, '/tmp', process.cwd()]) {
        try {
          for (const file of fs.readdirSync(dir)) {
            if (file.endsWith('.srs')) {
              fs.unlinkSync(path.join(dir, file));
              deleted++;
            }
          }
        } catch {}
      }
      await kernel.restart();
      res.json({ ok: true, deleted });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/deploy', async (req, res) => {
    try {
      const report = await deploy.deploy({ restart: req.body?.restart !== false });
      res.json(report);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/teardown', async (req, res) => {
    try {
      res.json(await deploy.teardown());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/system/version', async (req, res) => {
    try {
      let semver = '1.0.0';
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        if (pkg.version) semver = pkg.version;
      } catch {}

      let commitSha = null;
      try {
        const shaFile = path.join(ROOT, 'data', 'commit.sha');
        if (fs.existsSync(shaFile)) commitSha = fs.readFileSync(shaFile, 'utf8').trim().slice(0, 7);
      } catch {}

      try {
        const versionText = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
        if (/^[a-f0-9]{7,40}$/i.test(versionText)) {
          if (!commitSha) commitSha = versionText.slice(0, 7);
        } else if (/^\d+\.\d+/.test(versionText)) {
          semver = versionText.replace(/^v/, '');
        }
      } catch {}

      const currentVersion = semver.startsWith('v') ? semver : `v${semver}`;
      const effectiveSha = commitSha || 'e31b623';
      const current = `${currentVersion}(${effectiveSha})`;

      let remoteCommitSha = null;
      let changelog = null;
      try {
        const response = await fetch('https://api.github.com/repos/asdzx07/MyBox/commits/main', {
          headers: { 'User-Agent': 'mybox' },
          signal: AbortSignal.timeout(4000),
        });
        if (response.ok) {
          const json = await response.json();
          remoteCommitSha = json.sha?.slice(0, 7) || null;
        }
      } catch {}

      const targetLatestSha = remoteCommitSha || effectiveSha;
      const latest = `${currentVersion}(${targetLatestSha})`;
      const hasUpdate = Boolean(remoteCommitSha && commitSha && remoteCommitSha !== commitSha);
      res.json({ ok: true, current, semver: currentVersion, commitSha: effectiveSha, latest, hasUpdate, changelog });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/system/update', async (req, res) => {
    try {
      const updateScript = path.join(ROOT, 'scripts', 'update.sh');
      const logFile = path.join(ROOT, 'data', 'update.log');
      let command = 'sh';
      let args = [];
      if (fs.existsSync(updateScript)) {
        args = [updateScript, '--mirror'];
      } else {
        args = ['-c', 'curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/asdzx07/mybox/main/scripts/update.sh | sh -s -- --mirror'];
      }

      try {
        const output = fs.openSync(logFile, 'w');
        const child = spawn(command, args, { detached: true, stdio: ['ignore', output, output] });
        child.unref();
      } catch (spawnErr) {
        log.error('触发更新脚本失败：%s', spawnErr.message);
        return res.status(500).json({ ok: false, error: spawnErr.message });
      }

      log.info('系统更新脚本已触发');
      res.json({ ok: true, message: '更新已在后台开始，面板服务即将重启，请稍后刷新页面' });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/system/update/log', (req, res) => {
    try {
      const logFile = path.join(ROOT, 'data', 'update.log');
      if (!fs.existsSync(logFile)) return res.json({ ok: true, log: '' });
      res.json({ ok: true, log: fs.readFileSync(logFile, 'utf8') });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/kernel/:action', async (req, res) => {
    const { action } = req.params;
    try {
      if (action === 'start') return res.json(await kernel.start());
      if (action === 'stop') return res.json(await kernel.stop());
      if (action === 'restart') return res.json(await kernel.restart());
      if (action === 'install') {
        const version = req.body?.version;
        if (!version) return res.status(400).json({ error: '缺少 version' });
        const wasRunning = (await kernel.status()).running;
        const info = await kernel.installKernel(version, { onProgress: (message) => log.info('%s', message) });
        // 新二进制要重启内核才生效（替换是 rename 做的，老进程还跑着旧的）
        if (wasRunning) {
          try {
            await kernel.restart();
            log.info('内核已用 %s 重启', version);
          } catch (err) {
            log.warn('内核重启失败，请手动检查：%s', err.message);
          }
        }
        return res.json({ ...info, restarted: wasRunning });
      }
      return res.status(400).json({ error: '未知操作' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/kernel/log', async (req, res) => {
    res.json({ log: await kernel.tailLogAsync(Number(req.query.lines) || 200) });
  });

  app.get('/api/kernel/latest', async (req, res) => {
    try {
      // 默认取 1.15 预发布版（用户指定）
      const includePrerelease = req.query.stable !== '1';
      res.json(await kernel.fetchLatestVersion({ includePrerelease }));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}
