export function registerClientRoutes(app, deps) {
  const { loadSavedClients, saveClients, scanLocalNetworkClients } = deps;

  app.get('/api/clients', async (req, res) => {
    try {
      let clients = loadSavedClients();
      if (!clients.length) clients = await scanLocalNetworkClients();
      res.json({ ok: true, clients });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/clients/scan', async (req, res) => {
    try {
      const clients = await scanLocalNetworkClients();
      res.json({ ok: true, clients, count: clients.length });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/clients', (req, res) => {
    try {
      const clients = req.body?.clients;
      if (!Array.isArray(clients)) return res.status(400).json({ ok: false, error: 'clients 必须是数组' });
      saveClients(clients);
      res.json({ ok: true, clients });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete('/api/clients/:id', (req, res) => {
    try {
      const { id } = req.params;
      let clients = loadSavedClients();
      clients = clients.filter((client) => client.id !== id && client.ip !== id);
      saveClients(clients);
      res.json({ ok: true, clients });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
