// "Send to Tuesday" relay: the browser can't hold Tuesday's key safely, so this function does. The key (MARKDOWNS_API_KEY) lives only in Netlify's
// environment variables, so the button works on any device with nothing to type. It forwards exactly two calls to Tuesday and nothing else:
//   GET  ?action=sales  -> Tuesday GET  /api/markdowns/sales
//   POST {saleId, csv, fileName, allowSkips} -> Tuesday POST /api/markdowns/import
// Pure (env, fetch and the request are passed in) so it can be tested without Netlify.
const DEFAULT_TUESDAY = 'https://wndrrtuesday-production.up.railway.app';
const DEFAULT_ORIGINS = ['https://wndrr-demand-v2.netlify.app'];
const MAX_BODY = 8 * 1024 * 1024;

const reply = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

function allowedOrigins(env) {
  const list = String(env.SEND_ALLOWED_ORIGINS || '').split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean);
  return list.length ? list : DEFAULT_ORIGINS;
}

async function handle({ method, query, body, headers, env, fetchImpl }) {
  env = env || {}; headers = headers || {}; query = query || {};
  const f = fetchImpl || fetch;
  const key = env.MARKDOWNS_API_KEY;
  if (!key || key.length < 24) return reply(503, { ok: false, error: 'Send to Tuesday isn\'t set up yet: add MARKDOWNS_API_KEY (the same key as in Tuesday\'s Railway settings) to this site\'s Netlify environment variables, then redeploy.' });
  // Only this app's own pages may use it (a browser always names its origin on these calls); other sites are refused.
  const origin = String(headers.origin || headers.Origin || '').replace(/\/$/, '');
  if (origin && !allowedOrigins(env).includes(origin)) return reply(403, { ok: false, error: 'That site isn\'t allowed to send to Tuesday.' });
  const base = String(env.TUESDAY_URL || DEFAULT_TUESDAY).replace(/\/$/, '');
  const auth = { Authorization: 'Bearer ' + key };
  const pass = async res => { let j = null; try { j = await res.json(); } catch (e) { /* not JSON */ } return reply(res.status, j || { ok: false, error: 'Tuesday answered with an unexpected response (HTTP ' + res.status + ').' }); };
  try {
    if (method === 'GET') {
      if (query.action !== 'sales') return reply(400, { ok: false, error: 'Unknown request.' });
      return await pass(await f(base + '/api/markdowns/sales', { headers: auth }));
    }
    if (method === 'POST') {
      if (String(body || '').length > MAX_BODY) return reply(413, { ok: false, error: 'That plan is far larger than a markdown plan should be, so it wasn\'t sent.' });
      let b; try { b = JSON.parse(body || ''); } catch (e) { return reply(400, { ok: false, error: 'The request wasn\'t valid JSON.' }); }
      const out = { saleId: b.saleId, csv: b.csv, fileName: b.fileName, allowSkips: b.allowSkips === true };   // nothing else is passed on
      return await pass(await f(base + '/api/markdowns/import', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth), body: JSON.stringify(out) }));
    }
    return reply(405, { ok: false, error: 'Method not allowed.' });
  } catch (err) {
    return reply(502, { ok: false, error: 'Couldn\'t reach Tuesday (' + (err && err.message || err) + '). Nothing was changed there.' });
  }
}

module.exports = { handle, allowedOrigins, DEFAULT_TUESDAY, DEFAULT_ORIGINS };
