export function createRefreshSubscription({
  loadSettings,
  mutateSettings,
  fetchTextLimited,
  parseSubscription,
  dedupeTags,
  timeoutMs = 30000,
  maxBytes = 10 * 1024 * 1024,
}) {
  return async function refreshSubscription(id) {
    const settings = loadSettings({ force: true });
    const sub = settings.subscriptions.find((item) => item.id === id);
    if (!sub) throw new Error('订阅不存在');

    const text = await fetchTextLimited(sub.url, {
      timeoutMs,
      maxBytes,
      headers: { 'User-Agent': 'mybox/0.1' },
      redirect: 'follow',
    });

    const { format, nodes } = parseSubscription(text);
    const tagged = dedupeTags(nodes.map((node) => ({ ...node, __subscriptionId: id })));

    mutateSettings((current) => {
      current.nodes = [...current.nodes.filter((node) => node.__subscriptionId !== id), ...tagged];
      const target = current.subscriptions.find((item) => item.id === id);
      if (target) {
        target.format = format;
        target.nodeCount = tagged.length;
        target.updatedAt = Date.now();
      }
    });

    return { format, nodeCount: tagged.length, sample: tagged.slice(0, 8).map((node) => node.tag) };
  };
}
