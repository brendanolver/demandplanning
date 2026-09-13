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

exports.handler = async (event) => {
  if (!SHOPIFY_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: 'SHOPIFY_ADMIN_TOKEN environment variable is not set' }) };
  }

  const method = event.httpMethod || 'GET';

  // GET is only used to fetch a completed bulk operation's result file —
  // everything else goes through POST as a GraphQL request.
  if (method === 'GET') {
    const download = (event.queryStringParameters || {}).download;
    if (!download || !isAllowedDownloadUrl(download)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invalid or disallowed download url' }) };
    }
    try {
      const resp = await fetch(download);
      const text = await resp.text();
      return {
        statusCode: resp.status,
        headers: { 'Content-Type': 'application/x-ndjson', 'Access-Control-Allow-Origin': '*' },
        body: text,
      };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  if (method === 'POST') {
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
