const { connectLambda, getStore } = require('@netlify/blobs');
const { getPricePayload, getRecentPayload } = require('../lib/sales-sync');

// Serves the selling-price side of the Shopify sales feed (written by
// sales-sync-background.js alongside the units): {ready, meta, data} where data is
// {v, tz, days[], skus:{SKU:[dayIdx, grossCents, netCents, ...]}} — gross is the
// per-day shelf price x units at checkout (reflects a Hextom sale), net is after
// every discount. Used by the markdown planner only.
// GET ?span=recent returns just the last few days, with the units alongside ({SKU:[dayIdx, units,
// grossCents, netCents, ...]}) — a few kilobytes, which the dashboard's Today's Margin card uses.
exports.handler = async (event) => {
  if ((event.httpMethod || 'GET') !== 'GET') return { statusCode: 405, body: JSON.stringify({ error: 'method not allowed' }) };
  try {
    connectLambda(event);
    const store = getStore('sales-data');
    const recentOnly = !!event.queryStringParameters && event.queryStringParameters.span === 'recent';
    const { status, body } = recentOnly ? await getRecentPayload({ store }) : await getPricePayload({ store });
    return {
      statusCode: status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(body),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
