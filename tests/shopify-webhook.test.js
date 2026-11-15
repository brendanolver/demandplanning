// Tests for the Shopify order-notification path: signature check, the immediate refresh it asks for, and the
// "another order landed mid-sync" re-run. Run: npm test. Fakes stand in for Shopify and Netlify Blobs.
const assert = require('assert');
const crypto = require('crypto');
const SS = require('../netlify/lib/sales-sync.js');
const W = require('../netlify/lib/shopify-webhook.js');

const memStore = () => { const m = {}; return { m, get: async k => (k in m ? JSON.parse(JSON.stringify(m[k])) : null), setJSON: async (k, v) => { m[k] = JSON.parse(JSON.stringify(v)); } }; };
const sign = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest('base64');
const SECRET = 'shpss_test_secret';
const hdr = (body, over = {}) => ({ 'x-shopify-hmac-sha256': sign(body, SECRET), 'x-shopify-topic': 'orders/create', 'x-shopify-shop-domain': W.SHOP_DOMAIN, ...over });

(async () => {
  // ── signature ──
  const body = Buffer.from(JSON.stringify({ id: 1, email: 'someone@example.com' }));
  assert.ok(W.validSignature(body, sign(body, SECRET), SECRET));
  assert.ok(!W.validSignature(body, sign(body, 'other'), SECRET));
  assert.ok(!W.validSignature(Buffer.from('{"id":2}'), sign(body, SECRET), SECRET));          // body changed after signing
  assert.ok(!W.validSignature(body, '', SECRET)); assert.ok(!W.validSignature(body, undefined, SECRET)); assert.ok(!W.validSignature(body, sign(body, SECRET), ''));
  assert.ok(!W.validSignature(body, 'AAAA', SECRET));                                          // wrong length must not throw

  // ── the receiver ──
  let triggered = 0; const mk = () => ({ store: memStore(), trigger: async () => { triggered++; }, secret: SECRET, now: 1234 });
  let ctx = mk(), res = await W.handleWebhook({ method: 'POST', rawBody: body, headers: hdr(body), ...ctx });
  assert.equal(res.status, 200); assert.equal(triggered, 1); assert.deepEqual(ctx.store.m.poke, { ts: 1234, topic: 'orders/create' });
  assert.ok(!JSON.stringify(ctx.store.m).includes('someone@example.com'));                       // nothing from the order itself is kept
  ctx = mk(); res = await W.handleWebhook({ method: 'POST', rawBody: body, headers: hdr(body, { 'x-shopify-hmac-sha256': 'bm9wZQ==' }), ...ctx });
  assert.equal(res.status, 401); assert.equal(triggered, 1); assert.ok(!ctx.store.m.poke);       // forged: nothing recorded, nothing started
  res = await W.handleWebhook({ method: 'POST', rawBody: body, headers: hdr(body), ...mk(), secret: undefined }); assert.equal(res.status, 503);
  res = await W.handleWebhook({ method: 'GET', rawBody: body, headers: hdr(body), ...mk() }); assert.equal(res.status, 405);
  res = await W.handleWebhook({ method: 'POST', rawBody: body, headers: hdr(body, { 'x-shopify-topic': 'products/update' }), ...mk() }); assert.equal(res.status, 200); assert.equal(triggered, 1);
  res = await W.handleWebhook({ method: 'POST', rawBody: body, headers: hdr(body, { 'x-shopify-shop-domain': 'someone-else.myshopify.com' }), ...mk() }); assert.equal(res.status, 200); assert.equal(triggered, 1);
  res = await W.handleWebhook({ method: 'POST', rawBody: body, headers: hdr(body, { 'x-shopify-topic': 'orders/updated' }), ...mk() }); assert.equal(triggered, 2);
  // the worker being unreachable / the blob store failing must not turn into an error Shopify would retry
  ctx = mk(); ctx.trigger = async () => { throw new Error('offline'); }; res = await W.handleWebhook({ method: 'POST', rawBody: body, headers: hdr(body), ...ctx }); assert.equal(res.status, 200); assert.ok(ctx.store.m.poke);
  ctx = mk(); ctx.store.setJSON = async () => { throw new Error('blobs down'); }; res = await W.handleWebhook({ method: 'POST', rawBody: body, headers: hdr(body), ...ctx }); assert.equal(res.status, 200); assert.equal(triggered, 3);

  // ── 'webhook' refreshes: skip the 45 s quick interval, keep a 2 s floor, never steal the 10-minute trailing run ──
  const T0 = Date.UTC(2026, 8, 20, 5, 0, 0);
  const world = { queries: [], orders: [] };
  const gql = async (q, vars) => {
    if (q.includes('ianaTimezone')) return { shop: { ianaTimezone: 'Australia/Melbourne' } };
    if (q.includes('orders(first:50')) { world.queries.push(vars.q); if (world.onQuery) await world.onQuery(); return { orders: { pageInfo: { hasNextPage: false }, edges: world.orders.map(o => ({ node: o })) } }; }
    throw new Error('unexpected query ' + q.slice(0, 40));
  };
  const order = (createdAt, qty) => ({ createdAt, lineItems: { pageInfo: { hasNextPage: false }, edges: [{ node: { sku: 'W26IX002ASSM', currentQuantity: qty } }] } });
  const base = () => { const s = memStore(); s.m.daily = { W26IX002ASSM: { '2026-09-19': 5 } }; s.m.price = {}; s.m.meta = { tz: 'Australia/Melbourne', lastDay: '2026-09-20', lastFullTs: T0 - 3600e3, lastSuccessTs: T0, lastTrailingTs: T0, feedVersion: 3, storedStart: '2024-09-21', coverageStart: '2025-09-21' }; return s; };
  const go = (store, extra) => SS.runSync({ store, gql, fetchText: async () => '', sleep: async () => {}, ...extra });

  let s = base(); world.orders = [order('2026-09-20T01:00:00Z', 3)];
  assert.deepEqual(await go(s, { now: T0 + 10e3 }), { ran: false, reason: 'fresh' });             // an ordinary poke 10 s after a run: nothing
  let r = await go(s, { now: T0 + 10e3, requested: 'webhook' });                                     // an order notification: refresh now
  assert.equal(r.mode, 'quick'); assert.ok(!r.error, r.error); assert.equal(s.m.daily.W26IX002ASSM['2026-09-20'], 3);
  assert.deepEqual(await go(s, { now: T0 + 11e3, requested: 'webhook' }), { ran: false, reason: 'fresh' });   // 1 s after that: still inside the 2 s floor
  assert.equal((await go(s, { now: T0 + 13e3, requested: 'webhook' })).mode, 'quick');
  // a notification arriving when the 10-minute trailing run is due still does the cheap thing (the timer's ordinary poke does the trailing run)
  s = base(); r = await go(s, { now: T0 + 11 * 60e3, requested: 'webhook' }); assert.equal(r.mode, 'quick'); assert.equal(s.m.meta.lastTrailingTs, T0);
  assert.equal((await go(s, { now: T0 + 11 * 60e3 + 5e3 })).mode, 'incremental');
  // …but not across midnight, where yesterday still needs its finishing run
  s = base(); s.m.meta.lastDay = '2026-09-20'; r = await go(s, { now: Date.UTC(2026, 8, 20, 14, 5, 0), requested: 'webhook' }); assert.equal(r.mode, 'incremental');
  // a due full rebuild is still a full rebuild; a run in progress is respected
  s = base(); s.m.meta.running = { mode: 'quick', startedTs: T0 }; assert.deepEqual(await go(s, { now: T0 + 5e3, requested: 'webhook' }), { ran: false, reason: 'already running' });

  // ── a notification landing during a run makes the worker go round again ──
  s = base(); world.orders = [order('2026-09-20T01:00:00Z', 3)]; world.queries = [];
  let clock = T0 + 60e3; const tick = () => (clock += 3000);
  world.onQuery = async () => { if (world.queries.length === 1) { await s.setJSON('poke', { ts: clock + 1, topic: 'orders/create' }); world.orders = [order('2026-09-20T01:00:00Z', 3), order('2026-09-20T01:00:10Z', 4)]; } };
  r = await SS.syncWithPokes({ store: s, gql, fetchText: async () => '', sleep: async () => {}, clock: tick });
  assert.equal(r.rounds, 2); assert.equal(world.queries.length, 2); assert.equal(s.m.daily.W26IX002ASSM['2026-09-20'], 7);   // the second order is in
  // no new notification → no second round
  world.onQuery = null; world.queries = []; r = await SS.syncWithPokes({ store: s, gql, fetchText: async () => '', sleep: async () => {}, clock: tick }); assert.equal(r.rounds, 1);
  // a run that does nothing (fresh / locked) never loops, and a notification storm is capped
  s = base(); r = await SS.syncWithPokes({ store: s, gql, fetchText: async () => '', sleep: async () => {}, clock: () => T0 + 1000 }); assert.equal(r.ran, false); assert.equal(r.rounds, 1);
  s = base(); world.queries = []; let t = T0 + 60e3; world.onQuery = async () => { await s.setJSON('poke', { ts: t + 2999, topic: 'orders/create' }); };
  r = await SS.syncWithPokes({ store: s, gql, fetchText: async () => '', sleep: async () => {}, clock: () => (t += 3000) }); assert.equal(r.rounds, 4); assert.equal(world.queries.length, 4);

  // ── the last notification time is visible in the feed's metadata ──
  s = base(); await s.setJSON('poke', { ts: T0 + 5, topic: 'orders/create' });
  let p = await SS.getPayload({ store: s, metaOnly: true, now: T0 + 1000 }); assert.equal(p.body.meta.lastWebhookTs, T0 + 5);
  s = base(); p = await SS.getPayload({ store: s, metaOnly: true, now: T0 + 1000 }); assert.equal(p.body.meta.lastWebhookTs, null);

  // ── the function wrapper: raw body (also when Netlify base64-encodes it) is what gets verified ──
  process.env.SHOPIFY_WEBHOOK_SECRET = SECRET; process.env.URL = 'https://example.netlify.app';
  const fnPath = require.resolve('../netlify/functions/shopify-order-webhook.js');
  const blobsPath = require.resolve('@netlify/blobs'); const fake = memStore();
  require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { connectLambda() {}, getStore: () => fake } };
  const fn = require(fnPath); const realFetch = global.fetch, calls = [];
  global.fetch = async (u, o) => { calls.push([u, o.method, o.body]); return { status: 202 }; };
  try {
    const raw = '{"id":99}\n'; const ev = (b64) => ({ httpMethod: 'POST', headers: hdr(Buffer.from(raw)), body: b64 ? Buffer.from(raw).toString('base64') : raw, isBase64Encoded: b64 });
    assert.equal((await fn.handler(ev(false))).statusCode, 200); assert.equal((await fn.handler(ev(true))).statusCode, 200);
    assert.deepEqual(calls[0], ['https://example.netlify.app/.netlify/functions/sales-sync-background', 'POST', '{"mode":"webhook"}']); assert.equal(calls.length, 2);
    assert.equal((await fn.handler({ ...ev(false), headers: { ...hdr(Buffer.from(raw)), 'x-shopify-hmac-sha256': sign(Buffer.from('tampered'), SECRET) } })).statusCode, 401); assert.equal(calls.length, 2);
  } finally { global.fetch = realFetch; }
  console.log('shopify webhook tests: all passed');
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
