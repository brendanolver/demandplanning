const { connectLambda, getStore } = require('@netlify/blobs');
const { getPricePayload } = require('../lib/sales-sync');
const { guard } = require('../lib/app-auth');

// Serves the selling-price side of the Shopify sales feed (written by
// sales-sync-background.js alongside the units): {ready, meta, data} where data is
// {v, tz, days[], skus:{SKU:[dayIdx, grossCents, netCents, ...]}} — gross is the
// per-day shelf price x units at checkout (reflects a Hextom sale), net is after
// every discount. Used by the markdown planner only.
exports.handler = async (event) => {
  const denied = guard(event, process.env);   // signed-in app sessions only (netlify/lib/app-auth.js)
  if (denied) return denied;
  if ((event.httpMethod || 'GET') !== 'GET') return { statusCode: 405, body: JSON.stringify({ error: 'method not allowed' }) };
  try {
    connectLambda(event);
    const store = getStore('sales-data');
    const { status, body } = await getPricePayload({ store });
    return {
      statusCode: status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify(body),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
