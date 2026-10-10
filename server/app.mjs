import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerDeps } from './lib/server-deps.mjs';
import { registerPublicAuthRoutes, registerProtectedAuthRoutes } from './routes/auth.mjs';
import { registerSettingsRoutes } from './routes/settings.mjs';
import { registerSubscriptionRoutes } from './routes/subscriptions.mjs';
import { registerPolicyRoutes } from './routes/policies.mjs';
import { registerOperationRoutes } from './routes/operations.mjs';
import { registerClientRoutes } from './routes/clients.mjs';
import { registerClashRoutes } from './routes/clash.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ deps = createServerDeps(), panelDir = path.join(here, '..', 'panel') } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  // Keep static resources and public authentication routes before authMiddleware.
  app.use(express.static(panelDir, { index: 'index.html' }));
  registerPublicAuthRoutes(app, deps);
  app.use(deps.authMiddleware);
  registerProtectedAuthRoutes(app, deps);

  registerSettingsRoutes(app, deps);
  registerSubscriptionRoutes(app, deps);
  registerPolicyRoutes(app, deps);
  registerOperationRoutes(app, deps);
  registerClientRoutes(app, deps);
  registerClashRoutes(app, deps);

  app.use((err, req, res, _next) => {
    deps.log.error('%s %s：%s', req.method, req.path, err.message);
    res.status(500).json({ error: err.message });
  });
  return app;
}
