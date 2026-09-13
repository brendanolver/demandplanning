const SHOP_DOMAIN = 'thewndrr.myshopify.com';
const API_VERSION = '2025-10'; // shopifyqlQuery/newer bulk-operation fields need 2025-10+; kept current for everything else too
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// Bulk operation result files are hosted on Google Cloud Storage under a
// short-lived signed URL Shopify hands back from currentBulkOperation.url —
// this is the only external URL this function will ever be asked to fetch,
// so it's allowlisted by host rather than proxying arbitrary URLs (which
// would otherwise make this an open SSRF relay).
function isAllowedDownloadUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.protocol === 'https:' && /(^|\.)googleapis\.com$/.test(u.hostname);
  } catch (e) {
    return false;
  }
}

// This proxy only ever needs to READ data (orders/line items for the sales
// overlay). The one exception is bulkOperationRunQuery — syntactically a
// GraphQL "mutation" even though the query it wraps is read-only (it just
// enqueues an async export job). Everything else calling itself a mutation
// is rejected here as defense-in-depth, on top of the token's own scopes
// (read_orders, read_reports) already having no write access at all.
function isAllowedQuery(query) {
  if (!/\bmutation\b/i.test(query)) return true;
  return /bulkOperationRunQuery\s*\(/i.test(query) && !/bulkOperationRunMutation/i.test(query);
}

// Same real-WNDRR-style-code shape the app's own AM_PRODUCT_STYLE_RE uses,
// to drop non-product service lines (return coverage, order protection,
// etc.) that show up as real line items in the order data too.
const PRODUCT_STYLE_RE = /^[A-Z]\d{2}[A-Z]{2}\d{3}[A-Z]{3}/;

// Fetches a completed bulk operation's NDJSON result and reduces it to
// {sku:{day:{qty,cogs}}} server-side, rather than returning the raw file —
// a year of order/line-item data easily runs to tens of MB, and Netlify
// Functions run on Lambda under the hood, which hard-caps a function's own
// response at 6MB (returns exactly the 502 this replaced). Fetching a large
// file FROM Google Cloud Storage has no such limit; only this function's
// OWN response back to the browser does, and the aggregated map is orders
// of magnitude smaller than the source file.
async function fetchAndAggregateBulkResult(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Bulk result fetch failed: HTTP ${resp.status}`);
  const text = await resp.text();
  const salesMap = {};
  const orderDateById = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (!row.__parentId) {
      if (row.id && row.createdAt) orderDateById[row.id] = row.createdAt.slice(0, 10);
      continue;
    }
    const day = orderDateById[row.__parentId];
    const sku = (row.sku || '').trim().toUpperCase();
    const qty = parseFloat(row.currentQuantity) || 0;
    if (!day || !sku || qty <= 0 || !PRODUCT_STYLE_RE.test(sku)) continue;
    if (!salesMap[sku]) salesMap[sku] = {};
    if (!salesMap[sku][day]) salesMap[sku][day] = { qty: 0, cogs: 0 };
    salesMap[sku][day].qty += qty;
  }
  return salesMap;
}

exports.handler = async (event) => {
  const method = event.httpMethod || 'GET';

  // GET is only used to fetch+aggregate a completed bulk operation's result
  // file, straight from Google Cloud Storage — it never touches Shopify's
  // API itself, so it doesn't need (and shouldn't require) the Shopify
  // token. Everything else goes through POST as a GraphQL request, which does.
  if (method === 'GET') {
    const download = (event.queryStringParameters || {}).download;
    if (!download || !isAllowedDownloadUrl(download)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invalid or disallowed download url' }) };
    }
    try {
      const salesMap = await fetchAndAggregateBulkResult(download);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ salesMap }),
      };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  if (method === 'POST') {
    if (!SHOPIFY_TOKEN) {
      return { statusCode: 500, body: JSON.stringify({ error: 'SHOPIFY_ADMIN_TOKEN environment variable is not set' }) };
    }
    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON body' }) };
    }
    const query = payload.query || '';
    if (!query || !isAllowedQuery(query)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invalid or disallowed query' }) };
    }
    try {
      const resp = await fetch(`https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        },
        body: JSON.stringify({ query, variables: payload.variables || {} }),
      });
      const text = await resp.text();
      return {
        statusCode: resp.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: text,
      };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'method not allowed' }) };
};
