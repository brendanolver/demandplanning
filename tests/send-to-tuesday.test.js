// Tests for the Send to Tuesday relay (netlify/lib/send-to-tuesday.js) with a fake Tuesday.
const assert = require('assert');
const { handle } = require('../netlify/lib/send-to-tuesday.js');
(async () => {
  const KEY = 'k'.repeat(32), env = { MARKDOWNS_API_KEY: KEY }, calls = [];
  const tuesday = async (url, opts) => { calls.push({ url, opts }); return { status: url.endsWith('/sales') ? 200 : 200, json: async () => (url.endsWith('/sales') ? { sales: [{ id: 'a', name: 'BF' }] } : { ok: true, imported: 3 }) }; };
  const ok = { origin: 'https://wndrr-demand-v2.netlify.app' };
  // not configured: closed, with a message that says what to do
  let r = await handle({ method: 'GET', query: { action: 'sales' }, headers: ok, env: {}, fetchImpl: tuesday }); assert.equal(r.statusCode, 503); assert.ok(/MARKDOWNS_API_KEY/.test(JSON.parse(r.body).error)); assert.equal(calls.length, 0);
  assert.equal((await handle({ method: 'GET', query: { action: 'sales' }, headers: ok, env: { MARKDOWNS_API_KEY: 'short' }, fetchImpl: tuesday })).statusCode, 503);
  // other sites are refused before anything is sent
  r = await handle({ method: 'GET', query: { action: 'sales' }, headers: { origin: 'https://evil.example' }, env, fetchImpl: tuesday }); assert.equal(r.statusCode, 403); assert.equal(calls.length, 0);
  // list sales: forwards with the key from the environment
  r = await handle({ method: 'GET', query: { action: 'sales' }, headers: ok, env, fetchImpl: tuesday }); assert.equal(r.statusCode, 200); assert.equal(JSON.parse(r.body).sales[0].name, 'BF');
  assert.equal(calls[0].url, 'https://wndrrtuesday-production.up.railway.app/api/markdowns/sales'); assert.equal(calls[0].opts.headers.Authorization, 'Bearer ' + KEY);
  assert.equal((await handle({ method: 'GET', query: { action: 'other' }, headers: ok, env, fetchImpl: tuesday })).statusCode, 400);
  // send: only the four known fields go on, to the import route
  r = await handle({ method: 'POST', body: JSON.stringify({ saleId: 'a', csv: 'x', fileName: 'f', allowSkips: true, evil: 'drop table' }), headers: ok, env: Object.assign({ TUESDAY_URL: 'https://t.example/' }, env), fetchImpl: tuesday });
  assert.equal(r.statusCode, 200); const c = calls[calls.length - 1]; assert.equal(c.url, 'https://t.example/api/markdowns/import'); assert.deepEqual(JSON.parse(c.opts.body), { saleId: 'a', csv: 'x', fileName: 'f', allowSkips: true });
  r = await handle({ method: 'POST', body: JSON.stringify({ saleId: 'a', csv: 'x', allowSkips: 'yes' }), headers: ok, env, fetchImpl: tuesday }); assert.equal(JSON.parse(calls[calls.length - 1].opts.body).allowSkips, false);   // only a real true skips lines
  // bad input / methods / a Tuesday that is down or refuses
  assert.equal((await handle({ method: 'POST', body: '{nope', headers: ok, env, fetchImpl: tuesday })).statusCode, 400);
  assert.equal((await handle({ method: 'POST', body: 'x'.repeat(9 * 1024 * 1024), headers: ok, env, fetchImpl: tuesday })).statusCode, 413);
  assert.equal((await handle({ method: 'DELETE', headers: ok, env, fetchImpl: tuesday })).statusCode, 405);
  r = await handle({ method: 'GET', query: { action: 'sales' }, headers: ok, env, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }); assert.equal(r.statusCode, 502); assert.ok(/Nothing was changed/.test(JSON.parse(r.body).error));
  r = await handle({ method: 'POST', body: JSON.stringify({ saleId: 'a', csv: 'x' }), headers: ok, env, fetchImpl: async () => ({ status: 422, json: async () => ({ ok: false, error: '2 lines have problems', errors: [{ line: 2, message: 'bad' }] }) }) });
  assert.equal(r.statusCode, 422); assert.equal(JSON.parse(r.body).errors[0].line, 2);                       // Tuesday's own refusal is passed back as it was
  r = await handle({ method: 'GET', query: { action: 'sales' }, headers: ok, env, fetchImpl: async () => ({ status: 500, json: async () => { throw new Error('html'); } }) }); assert.equal(r.statusCode, 500);
  assert.equal((await handle({ method: 'GET', query: { action: 'sales' }, headers: {}, env, fetchImpl: tuesday })).statusCode, 200);   // no Origin header (server-to-server / same-origin GET): allowed
  console.log('send to tuesday tests: all passed');
})().catch(e => { console.error(e); process.exit(1); });
