const { connectLambda, getStore } = require('@netlify/blobs');
const { getPayload } = require('../lib/sales-sync');

// Serves the shared Shopify sales feed (written by sales-sync-background.js) to
// the app: GET returns {ready, meta, data} with data in the compact
// {v, tz, days[], skus:{SKU:[dayIdx,units,...]}} format; GET ?meta=1 returns
// just {ready, meta} — cheap enough to poll for freshness.
exports.handler = async (event) => {
  if ((event.httpMethod || 'GET') !== 'GET') return { statusCode: 405, body: JSON.stringify({ error: 'method not allowed' }) };
  try {
    connectLambda(event);
    const store = getStore('sales-data');
    const metaOnly = !!(event.queryStringParameters && event.queryStringParameters.meta);
    const { status, body } = await getPayload({ store, metaOnly });
    return {
      statusCode: status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(body),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
