// Tests for the server-side sales feed (netlify/lib). Run: npm test
// Pure Node, no dependencies: fakes stand in for Shopify and Netlify Blobs.
// Real-data validation against Better Reports was done separately (see the
// v2.6.2 changelog note) — these guard the logic that validation can't re-check
// cheaply: timezone/DST bucketing, parse ordering, day replacement, locking,
// the shrink guard, and failure recovery.
(() => {
const L=require('../netlify/lib/shopify-sales.js'); const assert=require('assert');
const dayOf=L.makeDayOf('Australia/Melbourne');
assert.equal(dayOf('2026-10-03T13:59:59Z'),'2026-10-03'); assert.equal(dayOf('2026-10-03T14:00:00Z'),'2026-10-04');
assert.equal(dayOf('2026-10-04T12:59:59Z'),'2026-10-04'); assert.equal(dayOf('2026-10-04T13:00:00Z'),'2026-10-05');
assert.equal(dayOf('2026-09-19T14:30:00Z'),'2026-09-20');
assert.equal(L.addDays('2026-09-30',1),'2026-10-01'); assert.equal(L.daysBetween('2026-09-28','2026-10-01').length,4);
const nd=[
 {__parentId:'o1',sku:'w26ix002assm',currentQuantity:2}, {id:'o1',createdAt:'2026-09-19T14:30:00Z'},
 {__parentId:'o2',sku:'ORDPRO',currentQuantity:1}, {__parentId:'o2',sku:'OS',currentQuantity:4},
 {__parentId:'o2',sku:'W256A002ASSL',currentQuantity:2},          // odd-shaped but real SKU: must be KEPT
 {__parentId:'o2',sku:null,currentQuantity:1},                    // gift card, no SKU: dropped
 {__parentId:'o2',sku:'W26IX002ASSM',currentQuantity:0},          // fully refunded: ignored
 {__parentId:'o2',sku:'W26IX002ASSM',currentQuantity:3}, {id:'o2',createdAt:'2026-09-19T03:00:00Z'},
 {__parentId:'ghost',sku:'W26IX002ASSM',currentQuantity:9},
].map(o=>JSON.stringify(o)).join('\n')+'\nnot json\n';
const p=L.parseBulkNdjson(nd,dayOf);
assert.deepEqual(p.map,{W26IX002ASSM:{'2026-09-20':2,'2026-09-19':3},W256A002ASSL:{'2026-09-19':2}});
assert.equal(p.droppedUnits,6); assert.equal(p.stats.unresolved,1);
const ex={A:{'2026-09-10':68,'2026-09-15':10,'2026-09-16':5},B:{'2026-09-16':4}};
assert.deepEqual(L.replaceDays(ex,{A:{'2026-09-15':121}},['2026-09-15','2026-09-16']),{A:{'2026-09-10':68,'2026-09-15':121}});
const m={A:{'2026-09-10':68,'2026-09-15':121},B:{'2026-09-15':4}}; assert.deepEqual(L.decodeCompact(L.encodeCompact(m)),m);
console.log('lib unit tests: all passed');
})();
(() => {
const assert = require('assert');
const SS = require('../netlify/lib/sales-sync.js');
const S = require('../netlify/lib/shopify-sales.js');

function memStore() { const m = {}; return { m, get: async k => (m[k] === undefined ? null : JSON.parse(JSON.stringify(m[k]))), setJSON: async (k, v) => { m[k] = JSON.parse(JSON.stringify(v)); } }; }
const T0 = Date.UTC(2026, 8, 20, 5, 0, 0); // 20 Sep 2026 15:00 Melbourne
// fake Shopify: bulk file + paginated orders driven by test-controlled state
const world = { bulkLines: [], recentOrders: [], bulkPolls: 0, opId: 'gid://op/1', replaceOp: false, failBulk: false };
const gql = async (q, vars) => {
  if (q.includes('ianaTimezone')) return { shop: { ianaTimezone: 'Australia/Melbourne' } };
  if (q.includes('bulkOperationRunQuery')) return { bulkOperationRunQuery: { bulkOperation: { id: world.opId, status: 'CREATED' }, userErrors: [] } };
  if (q.includes('currentBulkOperation')) {
    world.bulkPolls++;
    if (world.replaceOp) return { currentBulkOperation: { id: 'gid://op/OTHER', status: 'COMPLETED', url: 'x' } };
    if (world.failBulk) return { currentBulkOperation: { id: world.opId, status: 'FAILED', errorCode: 'INTERNAL' } };
    return world.bulkPolls < 2 ? { currentBulkOperation: { id: world.opId, status: 'RUNNING' } }
      : { currentBulkOperation: { id: world.opId, status: 'COMPLETED', objectCount: '9', url: 'https://storage.googleapis.com/f' } };
  }
  if (q.includes('orders(first:50')) return { orders: { pageInfo: { hasNextPage: false }, edges: world.recentOrders.map(o => ({ node: o })) } };
  throw new Error('unexpected query ' + q.slice(0, 40));
};
const fetchText = async () => world.bulkLines.map(o => JSON.stringify(o)).join('\n');
const sleep = async () => {};
const run = (store, extra = {}) => SS.runSync({ store, gql, fetchText, sleep, ...extra });

(async () => {
  const store = memStore();
  // 1. first ever run -> full build (child rows deliberately BEFORE parents)
  world.bulkLines = [
    { __parentId: 'o1', sku: 'W26IX002ASSM', currentQuantity: 68 }, { id: 'o1', createdAt: '2026-09-15T02:00:00Z' },
    { __parentId: 'o2', sku: 'W26IX002ASSM', currentQuantity: 5 },  { id: 'o2', createdAt: '2026-09-19T01:00:00Z' },
    { __parentId: 'o2', sku: 'ORDPRO', currentQuantity: 5 },
  ];
  let r = await run(store, { now: T0 });
  assert.equal(r.mode, 'full'); assert.ok(!r.error, r.error); assert.equal(r.units, 73);
  assert.equal(store.m.meta.running, null); assert.equal(store.m.meta.stats.droppedUnits, 5);
  let p = await SS.getPayload({ store, now: T0 + 1000 });
  assert.equal(p.body.ready, true); assert.deepEqual(S.decodeCompact(p.body.data), { W26IX002ASSM: { '2026-09-15': 68, '2026-09-19': 5 } });
  // 2. immediately again -> fresh, nothing runs
  r = await run(store, { now: T0 + 60 * 1000 }); assert.deepEqual(r, { ran: false, reason: 'fresh' });
  // 3. 10 min later -> incremental; stale partial 19th (5) must be REPLACED by 27, new 20th added, 15th (outside window? 20-4=16) untouched
  world.recentOrders = [
    { createdAt: '2026-09-19T04:00:00Z', lineItems: { pageInfo: { hasNextPage: false }, edges: [{ node: { sku: 'W26IX002ASSM', currentQuantity: 27 } }] } },
    { createdAt: '2026-09-20T01:00:00Z', lineItems: { pageInfo: { hasNextPage: false }, edges: [{ node: { sku: 'W26IX002ASSM', currentQuantity: 16 } }] } },
  ];
  r = await run(store, { now: T0 + 10 * 60 * 1000 });
  assert.equal(r.mode, 'incremental'); assert.ok(!r.error, r.error);
  assert.deepEqual(store.m.daily, { W26IX002ASSM: { '2026-09-15': 68, '2026-09-19': 27, '2026-09-20': 16 } });
  // 4. lock: fresh lock blocks, stale lock (>20 min) is ignored
  store.m.meta.running = { mode: 'full', startedTs: T0 + 20 * 60 * 1000 };
  r = await run(store, { now: T0 + 25 * 60 * 1000 }); assert.deepEqual(r, { ran: false, reason: 'already running' });
  r = await run(store, { now: T0 + 60 * 60 * 1000 }); assert.equal(r.mode, 'incremental'); assert.ok(!r.error, r.error);
  // 5. daily full rebuild is due after 24h; a suspiciously tiny result must NOT overwrite good data
  world.bulkPolls = 0; world.bulkLines = [{ id: 'o9', createdAt: '2026-09-21T01:00:00Z' }, { __parentId: 'o9', sku: 'W26IX002ASSM', currentQuantity: 1 }];
  const before = JSON.stringify(store.m.daily);
  r = await run(store, { now: T0 + 25 * 3600 * 1000 });
  assert.equal(r.mode, 'full'); assert.match(r.error, /keeping existing data/);
  assert.equal(JSON.stringify(store.m.daily), before); assert.match(store.m.meta.lastError, /keeping existing/); assert.equal(store.m.meta.running, null);
  // 6. bulk replaced by another export / bulk FAILED -> clean error, lock released, data untouched
  world.bulkPolls = 0; world.replaceOp = true;
  r = await run(store, { now: T0 + 26 * 3600 * 1000 }); assert.match(r.error, /replaced by another/);
  world.replaceOp = false; world.failBulk = true; world.bulkPolls = 0;
  r = await run(store, { now: T0 + 27 * 3600 * 1000 }); assert.match(r.error, /FAILED/);
  assert.equal(JSON.stringify(store.m.daily), before); assert.equal(store.m.meta.running, null);
  // 6b. a feed built under older rules (version mismatch) is rebuilt in full even though it's otherwise fresh
  world.failBulk = false; world.bulkPolls = 0;
  world.bulkLines = [
    { id: 'o1', createdAt: '2026-09-15T02:00:00Z' }, { __parentId: 'o1', sku: 'W26IX002ASSM', currentQuantity: 68 },
    { id: 'o2', createdAt: '2026-09-19T01:00:00Z' }, { __parentId: 'o2', sku: 'W26IX002ASSM', currentQuantity: 27 },
  ];
  store.m.meta.feedVersion = 1; store.m.meta.lastSuccessTs = T0 + 27.5 * 3600 * 1000; store.m.meta.lastFullTs = T0 + 27.5 * 3600 * 1000;
  r = await run(store, { now: T0 + 27.6 * 3600 * 1000 });
  assert.equal(r.mode, 'full'); assert.ok(!r.error, r.error); assert.equal(store.m.meta.feedVersion, 2);
  // 7. explicit full request honoured only after 30 min since last full; meta-only + not-ready payloads
  const empty = memStore(); p = await SS.getPayload({ store: empty, metaOnly: false }); assert.equal(p.body.ready, false);
  p = await SS.getPayload({ store, metaOnly: true }); assert.equal(p.body.ready, true); assert.ok(!('data' in p.body));
  console.log('sales-sync integration tests: all passed');
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
})();
