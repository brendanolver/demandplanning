const { connectLambda, getStore } = require('@netlify/blobs');
const { handleWebhook } = require('../lib/shopify-webhook');

// Shopify posts here when an order is created or updated (set up under Shopify admin > Settings > Notifications >
// Webhooks; see the v3.9.0 note in index.html). Verifies the signature, then wakes the sales sync so today's sales
// are in the feed within seconds instead of at the next 2-minute timer tick.
exports.handler = async (event) => {
  connectLambda(event);
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '', 'utf8');
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
  const res = await handleWebhook({
    method: event.httpMethod, rawBody, headers: event.headers || {},
    secret: process.env.SHOPIFY_WEBHOOK_SECRET, store: getStore('sales-data'),
    trigger: async () => {
      if (!base) throw new Error('no site URL in the environment');
      const r = await fetch(`${base}/.netlify/functions/sales-sync-background`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'webhook' }) });
      if (r.status >= 400) throw new Error('worker answered ' + r.status);
    },
    log: m => console.log('[shopify-webhook]', m),
  });
  return { statusCode: res.status, body: res.body };
};
