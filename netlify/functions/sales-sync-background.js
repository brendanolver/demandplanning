const { connectLambda, getStore } = require('@netlify/blobs');
const { makeClient, runSync } = require('../lib/sales-sync');

// Background function (the -background suffix is what gives it Netlify's
// 15-minute limit instead of ~10s — a full-year Shopify bulk export takes
// minutes). POST returns 202 immediately; the work happens after. Safe to call
// as often as any open browser likes: runSync() itself decides whether a run is
// actually due (min interval, daily full rebuild, overlap lock), so a burst of
// calls costs nothing.
exports.handler = async (event) => {
  connectLambda(event); // legacy exports.handler style — Blobs isn't auto-configured otherwise
  const store = getStore('sales-data');
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) {
    const meta = (await store.get('meta', { type: 'json' })) || {};
    await store.setJSON('meta', { ...meta, lastError: 'SHOPIFY_ADMIN_TOKEN environment variable is not set', lastErrorTs: Date.now() });
    return { statusCode: 500, body: 'SHOPIFY_ADMIN_TOKEN not set' };
  }
  let requested;
  try { requested = (JSON.parse(event.body || '{}') || {}).mode; } catch (e) { /* no body is fine */ }
  const { gql, fetchText } = makeClient(token);
  const result = await runSync({ store, gql, fetchText, requested, log: m => console.log('[sales-sync]', m) });
  console.log('[sales-sync] result', JSON.stringify(result));
  return { statusCode: 200, body: JSON.stringify(result) };
};
