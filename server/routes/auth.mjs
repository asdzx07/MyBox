export function registerPublicAuthRoutes(app, deps) {
  const {
    ROOT, DATA_DIR, isPasswordSet, isAuthed, setPassword, verifyPassword,
    issueToken, clearSessionCookie, setSessionCookie, log,
  } = deps;
  const path = deps.path;

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, root: ROOT, dbPath: path.join(DATA_DIR, 'settings.json') });
  });

  app.get('/api/auth/status', (req, res) => {
    res.json({ enabled: true, authenticated: isAuthed(req), passwordSet: isPasswordSet() });
  });

  app.post('/api/auth/setup', (req, res) => {
    if (isPasswordSet()) return res.status(409).json({ error: '面板密码已设置' });
    try {
      setPassword(req.body?.password);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    setSessionCookie(res, issueToken());
    res.json({ ok: true });
  });

  app.post('/api/auth/login', (req, res) => {
    if (!isPasswordSet()) return res.status(409).json({ error: '还没有设置面板密码' });
    if (!verifyPassword(req.body?.password)) {
      log.warn('登录失败，来自 %s', req.ip);
      return res.status(401).json({ error: '密码错误' });
    }
    setSessionCookie(res, issueToken());
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });
}

export function registerProtectedAuthRoutes(app, deps) {
  const { verifyPassword, setPassword } = deps;

  app.get('/api/auth/me', (req, res) => res.json({ authenticated: true }));

  app.post('/api/auth/change-password', (req, res) => {
    if (!verifyPassword(req.body?.current)) return res.status(401).json({ error: '当前密码错误' });
    try {
      setPassword(req.body?.next);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    res.json({ ok: true });
  });
}
