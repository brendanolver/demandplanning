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
// price capture: gross = shelf price at checkout, net = after all discounts, cents x units
const pn=L.parseBulkNdjson([
 {id:'p1',createdAt:'2026-09-19T03:00:00Z'},
 {__parentId:'p1',sku:'w26ix002assm',currentQuantity:2,originalUnitPriceSet:{shopMoney:{amount:'99.95'}},discountedUnitPriceAfterAllDiscountsSet:{shopMoney:{amount:'79.96'}}},
 {__parentId:'p1',sku:'W26IX002ASSM',currentQuantity:1,originalUnitPriceSet:{shopMoney:{amount:'99.95'}},discountedUnitPriceAfterAllDiscountsSet:{shopMoney:{amount:'99.95'}}},
 {__parentId:'p1',sku:'W26NOPRICE',currentQuantity:1},
].map(o=>JSON.stringify(o)).join('\n'),dayOf);
assert.deepEqual(pn.price,{W26IX002ASSM:{'2026-09-19':[2*9995+9995,2*7996+9995]}}); // [29985, 25987] cents
assert.equal(pn.map.W26NOPRICE['2026-09-19'],1); assert.ok(!pn.price.W26NOPRICE); // units kept even without a price
const pm={A:{'2026-01-01':[1000,800],'2026-06-01':[500,500]}};
assert.deepEqual(L.decodeCompact(L.encodeCompact(pm,'Australia/Melbourne',null,2),2),pm);
assert.deepEqual(L.decodeCompact(L.encodeCompact(pm,'Australia/Melbourne','2026-03-01',2),2),{A:{'2026-06-01':[500,500]}}); // fromDay trims
{ // beforeDay trims the other end; [fromDay, beforeDay) and [beforeDay, …) split a map with nothing lost and nothing twice
  const u={A:{'2025-01-10':3,'2025-06-30':4,'2025-07-01':5,'2026-02-02':6},B:{'2025-07-01':1},C:{'2024-12-31':9}};
  assert.deepEqual(L.decodeCompact(L.encodeCompact(u,'Australia/Melbourne','2025-01-01',1,'2025-07-01')),{A:{'2025-01-10':3,'2025-06-30':4}}); // the boundary day itself belongs to the later half
  assert.deepEqual(L.decodeCompact(L.encodeCompact(u,'Australia/Melbourne','2025-07-01')),{A:{'2025-07-01':5,'2026-02-02':6},B:{'2025-07-01':1}});
  assert.deepEqual(L.decodeCompact(L.encodeCompact(u,'Australia/Melbourne',null,1,'2025-01-01')),{C:{'2024-12-31':9}});
  assert.deepEqual(L.encodeCompact(u,'Australia/Melbourne','2025-01-01',1,'2025-01-01').skus,{}); // empty window
}
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
    { id: 'o0', createdAt: '2025-05-01T02:00:00Z' }, { __parentId: 'o0', sku: 'W26IX002ASSM', currentQuantity: 7, originalUnitPriceSet: { shopMoney: { amount: '100.00' } }, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '50.00' } } },
  ];
  let r = await run(store, { now: T0 });
  assert.equal(r.mode, 'full'); assert.ok(!r.error, r.error); assert.equal(r.units, 80); // 2 years stored (68+5 recent, 7 from May 2025)
  assert.equal(store.m.meta.coverageStart, '2025-09-21'); assert.equal(store.m.meta.storedStart, '2024-09-21');
  assert.equal(store.m.meta.running, null); assert.equal(store.m.meta.stats.droppedUnits, 5);
  let p = await SS.getPayload({ store, now: T0 + 1000 });
  assert.equal(p.body.ready, true); assert.deepEqual(S.decodeCompact(p.body.data), { W26IX002ASSM: { '2026-09-15': 68, '2026-09-19': 5 } }); // units feed: trailing year only, as before
  const pp = await SS.getPricePayload({ store, now: T0 + 1000 });
  assert.equal(pp.body.ready, true); assert.deepEqual(S.decodeCompact(pp.body.data, 2), { W26IX002ASSM: { '2025-05-01': [70000, 35000] } }); // price history: all stored days
  // the older stored year, served separately for last-year comparisons: everything before the trailing year, and nothing from it
  const op = await SS.getOlderPayload({ store, now: T0 + 1000 });
  assert.equal(op.status, 200); assert.equal(op.body.ready, true);
  assert.deepEqual(S.decodeCompact(op.body.data), { W26IX002ASSM: { '2025-05-01': 7 } });
  assert.equal(op.body.meta.from, '2024-09-21'); assert.equal(op.body.meta.to, '2025-09-20');       // storedStart … the day before coverageStart
  { // the two payloads together are every stored day exactly once
    const both = {}, add = m => { for (const k in m) for (const d in m[k]) { assert.ok(!(both[k] && d in both[k]), 'day served twice: ' + d); (both[k] = both[k] || {})[d] = m[k][d]; } };
    add(S.decodeCompact(p.body.data)); add(S.decodeCompact(op.body.data)); assert.deepEqual(both, store.m.daily);
  }
  assert.equal((await SS.getOlderPayload({ store: memStore() })).body.ready, false);                // nothing stored yet
  { const old = memStore(); old.m.daily = store.m.daily; old.m.meta = { ...store.m.meta, storedStart: undefined }; assert.equal((await SS.getOlderPayload({ store: old })).body.ready, false); } // a feed built before 2 years were kept
  { const stale = memStore(); stale.m.daily = store.m.daily; stale.m.meta = { ...store.m.meta, feedVersion: 2 }; assert.equal((await SS.getOlderPayload({ store: stale })).body.ready, false); }
  // 2. immediately again -> fresh, nothing runs
  r = await run(store, { now: T0 + 60 * 1000 }); assert.deepEqual(r, { ran: false, reason: 'fresh' });
  // 3. 10 min later -> incremental; stale partial 19th (5) must be REPLACED by 27, new 20th added, 15th (outside window? 20-4=16) untouched
  world.recentOrders = [
    { createdAt: '2026-09-19T04:00:00Z', lineItems: { pageInfo: { hasNextPage: false }, edges: [{ node: { sku: 'W26IX002ASSM', currentQuantity: 27 } }] } },
    { createdAt: '2026-09-20T01:00:00Z', lineItems: { pageInfo: { hasNextPage: false }, edges: [{ node: { sku: 'W26IX002ASSM', currentQuantity: 16 } }] } },
  ];
  r = await run(store, { now: T0 + 10 * 60 * 1000 });
  assert.equal(r.mode, 'incremental'); assert.ok(!r.error, r.error);
  assert.deepEqual(store.m.daily, { W26IX002ASSM: { '2025-05-01': 7, '2026-09-15': 68, '2026-09-19': 27, '2026-09-20': 16 } });
  assert.deepEqual(store.m.price, { W26IX002ASSM: { '2025-05-01': [70000, 35000] } }); // old price history survives an incremental; no price fields in these fakes
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
  r = await run(store, { now: T0 + 27 * 3600 * 1000 + 5 * 60 * 1000 }); assert.deepEqual(r, { ran: false, reason: 'recent error' }); // no retry storm after a failure
  // 6b. a feed built under older rules (version mismatch) is rebuilt in full even though it's otherwise fresh
  world.failBulk = false; world.bulkPolls = 0;
  world.bulkLines = [
    { id: 'o1', createdAt: '2026-09-15T02:00:00Z' }, { __parentId: 'o1', sku: 'W26IX002ASSM', currentQuantity: 68 },
    { id: 'o2', createdAt: '2026-09-19T01:00:00Z' }, { __parentId: 'o2', sku: 'W26IX002ASSM', currentQuantity: 27 },
  ];
  store.m.meta.feedVersion = 1; store.m.meta.lastSuccessTs = T0 + 27.5 * 3600 * 1000; store.m.meta.lastFullTs = T0 + 27.5 * 3600 * 1000;
  r = await run(store, { now: T0 + 27.6 * 3600 * 1000 });
  assert.equal(r.mode, 'full'); assert.ok(!r.error, r.error); assert.equal(store.m.meta.feedVersion, 3);
  // 6c. the "recent" snapshot the dashboard's Today's Margin uses: last 5 days, units + takings from the SAME run
  {
    const s2 = memStore(), money = v => ({ shopMoney: { amount: v } });
    const line = (parent, sku, qty, shelf, paid) => ({ __parentId: parent, sku, currentQuantity: qty, originalUnitPriceSet: money(shelf), discountedUnitPriceAfterAllDiscountsSet: money(paid) });
    world.bulkPolls = 0;
    world.bulkLines = [
      { id: 'a', createdAt: '2026-09-20T01:00:00Z' }, line('a', 'TEE-M', 2, '59.95', '47.96'), line('a', 'GIFT-OS', 1, '25.00', '0.00'),   // today: 20% off, plus a free gift
      { id: 'b', createdAt: '2026-09-20T03:00:00Z' }, line('b', 'TEE-M', 1, '59.95', '59.95'),                                            // today, full price
      { id: 'c', createdAt: '2026-09-18T01:00:00Z' }, line('c', 'TEE-M', 3, '59.95', '50.00'),
      { id: 'd', createdAt: '2026-09-16T01:00:00Z' }, { __parentId: 'd', sku: 'NOPRICE-S', currentQuantity: 4 },                          // Shopify gave no price
      { id: 'e', createdAt: '2026-09-15T01:00:00Z' }, line('e', 'OLD-L', 9, '10.00', '10.00'),                                            // 6 days ago: outside the snapshot
    ];
    assert.equal((await SS.getRecentPayload({ store: s2 })).body.ready, false);                       // nothing until a sync has run
    let rr = await SS.runSync({ store: s2, gql, fetchText, sleep, now: T0 }); assert.ok(!rr.error, rr.error);
    let rp = await SS.getRecentPayload({ store: s2, now: T0 + 60000 });
    assert.equal(rp.status, 200); assert.equal(rp.body.ready, true);
    assert.deepEqual(rp.body.meta, { tz: 'Australia/Melbourne', lastDay: '2026-09-20', syncTs: T0, ageSec: 60 });
    const rec = S.decodeCompact(rp.body.data, 3);
    assert.deepEqual(rec, {
      'TEE-M': { '2026-09-18': [3, 17985, 15000], '2026-09-20': [3, 17985, 15587] },   // today: 2 x 47.96 + 1 x 59.95 actually paid, against 3 x 59.95 on the shelf
      'GIFT-OS': { '2026-09-20': [1, 2500, 0] },                                       // a free gift: real units, nothing paid
      'NOPRICE-S': { '2026-09-16': [4, null, null] },
    });
    assert.deepEqual(rp.body.data.days, ['2026-09-16', '2026-09-18', '2026-09-20']);
    for (const sku in rec) for (const d in rec[sku]) {                                // it is exactly the stored units and prices, never a different count
      assert.equal(rec[sku][d][0], s2.m.daily[sku][d]);
      assert.deepEqual(rec[sku][d].slice(1), (s2.m.price[sku] && s2.m.price[sku][d]) || [null, null]);
    }
    assert.ok(!('OLD-L' in rec)); assert.ok(s2.m.daily['OLD-L']['2026-09-15'] === 9);
    // the next (incremental) run replaces it: a refund on today's order shows up in units and takings together
    world.recentOrders = [
      { createdAt: '2026-09-20T01:00:00Z', lineItems: { pageInfo: { hasNextPage: false }, edges: [{ node: { sku: 'TEE-M', currentQuantity: 1, originalUnitPriceSet: money('59.95'), discountedUnitPriceAfterAllDiscountsSet: money('47.96') } }] } },
      { createdAt: '2026-09-18T01:00:00Z', lineItems: { pageInfo: { hasNextPage: false }, edges: [{ node: { sku: 'TEE-M', currentQuantity: 3, originalUnitPriceSet: money('59.95'), discountedUnitPriceAfterAllDiscountsSet: money('50.00') } }] } },
    ];
    rr = await SS.runSync({ store: s2, gql, fetchText, sleep, now: T0 + 10 * 60 * 1000 }); assert.equal(rr.mode, 'incremental'); assert.ok(!rr.error, rr.error);
    rp = await SS.getRecentPayload({ store: s2, now: T0 + 10 * 60 * 1000 });
    assert.deepEqual(S.decodeCompact(rp.body.data, 3), { 'TEE-M': { '2026-09-18': [3, 17985, 15000], '2026-09-20': [1, 5995, 4796] } });
    assert.equal(rp.body.meta.syncTs, T0 + 10 * 60 * 1000);
    // a failure writing the snapshot must not fail the sync itself
    const s3 = memStore(), realSet = s3.setJSON; s3.setJSON = async (k, v) => { if (k === 'recent') throw new Error('blob store hiccup'); return realSet(k, v); };
    world.bulkPolls = 0; rr = await SS.runSync({ store: s3, gql, fetchText, sleep, now: T0 }); assert.ok(!rr.error, rr.error); assert.ok(s3.m.daily['TEE-M']); assert.ok(s3.m.meta.lastSuccessTs);
    assert.equal((await SS.getRecentPayload({ store: s3 })).body.ready, false);
    world.recentOrders = [];
  }
  // 7. explicit full request honoured only after 30 min since last full; meta-only + not-ready payloads
  const empty = memStore(); p = await SS.getPayload({ store: empty, metaOnly: false }); assert.equal(p.body.ready, false);
  p = await SS.getPayload({ store, metaOnly: true }); assert.equal(p.body.ready, true); assert.ok(!('data' in p.body));
  console.log('sales-sync integration tests: all passed');
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
})();
