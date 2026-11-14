const { connectLambda, getStore } = require('@netlify/blobs');
const { getPayload, getOlderPayload } = require('../lib/sales-sync');

// Serves the shared Shopify sales feed (written by sales-sync-background.js) to
// the app: GET returns {ready, meta, data} with data in the compact
// {v, tz, days[], skus:{SKU:[dayIdx,units,...]}} format; GET ?meta=1 returns
// just {ready, meta} — cheap enough to poll for freshness. GET ?span=older returns the
// stored year BEFORE that one in the same format ({ready, meta:{from,to}, data}), which only
// Sales Cadence's last-year / previous-period comparison asks for.
exports.handler = async (event) => {
  if ((event.httpMethod || 'GET') !== 'GET') return { statusCode: 405, body: JSON.stringify({ error: 'method not allowed' }) };
  try {
    connectLambda(event);
    const store = getStore('sales-data');
    const qs = event.queryStringParameters || {};
    const metaOnly = !!qs.meta;
    const { status, body } = qs.span === 'older' ? await getOlderPayload({ store }) : await getPayload({ store, metaOnly });
    return {
      statusCode: status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(body),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
