const AM_BASE = 'https://kohindustries.app.apparelmagic.com/api';
const AM_TOKEN = 'cff4a1e4a3d0b3726a4117e4f14a618a';
const ALLOWED = ['products', 'inventory', 'orders', 'order_items', 'warehouses'];

exports.handler = async (event) => {
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
};
