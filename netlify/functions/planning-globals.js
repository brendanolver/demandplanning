const { getStore } = require('@netlify/blobs');

// A single small shared settings blob — Planning's "Growth % by Month" row,
// which used to live only in each browser's own localStorage (savePlanField/
// PLAN_STORAGE_KEY in index.html). This store makes it the same for every
// session instead of a per-device setting, using Netlify Blobs since it's
// already built into this same platform — no new account/credential like
// Shopify or AM needed. Deliberately narrow: one key, one shape, not a
// general-purpose key-value endpoint.
const STORE_NAME = 'planning-globals';
const KEY = 'growth-by-month';

// Same shape check on the way in as the client sends: {"YYYY-MM": "<number
// string>"}. Rejecting anything else keeps this from silently becoming a
// dumping ground for whatever a future client version happens to send.
function sanitize(payload) {
  const clean = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!/^\d{4}-\d{2}$/.test(k)) continue;
    if (v === '' || v === null || v === undefined) continue;
    const n = parseFloat(v);
    if (isNaN(n) || Math.abs(n) > 1000) continue;
    clean[k] = String(n);
  }
  return clean;
}

exports.handler = async (event) => {
  const method = event.httpMethod || 'GET';
  let store;
  try {
    store = getStore(STORE_NAME);
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Netlify Blobs unavailable: ' + err.message }) };
  }

  if (method === 'GET') {
    try {
      const data = await store.get(KEY, { type: 'json' });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(data || {}),
      };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  if (method === 'PUT' || method === 'POST') {
    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON body' }) };
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'expected a flat object of monthKey -> value' }) };
    }
    const clean = sanitize(payload);
    try {
      await store.setJSON(KEY, clean);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ ok: true, saved: clean }),
      };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'method not allowed' }) };
};
