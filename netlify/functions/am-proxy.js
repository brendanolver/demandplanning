const AM_BASE = 'https://kohindustries.app.apparelmagic.com/api';
const AM_TOKEN = 'cff4a1e4a3d0b3726a4117e4f14a618a';
const ALLOWED = ['products', 'inventory', 'orders', 'order_items', 'warehouses', 'sku_warehouse'];
// Paths that may be WRITTEN to (POST/PUT) — deliberately narrower than the
// read-only ALLOWED list above, since a write creates or modifies a real
// business record (a sales order) rather than just reading data. Currently
// just 'orders', for the Size Workings -> AM push feature.
const WRITABLE = ['orders'];

exports.handler = async (event) => {
  const method = event.httpMethod || 'GET';

  if (method === 'GET') {
    const params = { ...(event.queryStringParameters || {}) };
    const path = params.path;
    if (!path || !ALLOWED.some(a => path === a || path.startsWith(a + '/'))) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invalid path' }) };
    }
    delete params.path;
    const t = Date.now();
    const qs = new URLSearchParams({ ...params, token: AM_TOKEN, time: t }).toString();
    const url = `${AM_BASE}/${path}?${qs}`;
    try {
      const resp = await fetch(url);
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

  if (method === 'POST' || method === 'PUT') {
    const params = { ...(event.queryStringParameters || {}) };
    const path = params.path;
    if (!path || !WRITABLE.some(a => path === a || path.startsWith(a + '/'))) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invalid or non-writable path' }) };
    }
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON body' }) };
    }
    // token/time are injected here, server-side, exactly like the GET path —
    // never accepted from the client, so the token stays out of the browser.
    const t = Date.now();
    const fullBody = { ...body, token: AM_TOKEN, time: t };
    const url = `${AM_BASE}/${path}`;
    try {
      const resp = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fullBody),
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
