// Tests for the cloud plan store (netlify/lib/plans-store.js) with an in-memory blob store.
const assert = require('assert');
const { handle, KEY, PREV_KEY } = require('../netlify/lib/plans-store.js');
(async () => {
  const mem = {}; const store = { get: async k => (mem[k] ? JSON.parse(JSON.stringify(mem[k])) : null), setJSON: async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); } };
  const st = n => ({ v: 1, activeId: 'a', order: ['a'], plans: { a: { id: 'a', name: 'Sale ' + n, rev: n, setup: {}, settings: {} } } });
  const call = async (m, b) => { const r = await handle(m, b == null ? null : JSON.stringify(b), store); return { s: r.statusCode, b: JSON.parse(r.body) }; };
  // empty store
  let r = await call('GET'); assert.equal(r.s, 200); assert.equal(r.b.rev, 0); assert.equal(r.b.state, null);
  // first save (no ifRev check needed when ifRev is 0)
  r = await call('PUT', { state: st(1), ifRev: 0, device: 'laptop' }); assert.equal(r.s, 200); assert.equal(r.b.rev, 1);
  r = await call('GET'); assert.equal(r.b.rev, 1); assert.equal(r.b.state.plans.a.name, 'Sale 1'); assert.equal(r.b.device, 'laptop');
  // an up-to-date write succeeds and bumps the revision; the previous version is kept
  r = await call('PUT', { state: st(2), ifRev: 1, device: 'phone' }); assert.equal(r.s, 200); assert.equal(r.b.rev, 2);
  assert.equal(mem[PREV_KEY].state.plans.a.name, 'Sale 1'); assert.equal(mem[KEY].state.plans.a.name, 'Sale 2');
  // an out-of-date write is refused with the current copy (never silently overwrites)
  r = await call('PUT', { state: st(3), ifRev: 1, device: 'laptop' }); assert.equal(r.s, 409); assert.equal(r.b.conflict, true); assert.equal(r.b.rev, 2); assert.equal(r.b.state.plans.a.name, 'Sale 2'); assert.equal(mem[KEY].state.plans.a.name, 'Sale 2');
  // bad input
  assert.equal((await call('PUT', { state: { nope: 1 }, ifRev: 2 })).s, 400); assert.equal((await call('PUT', { state: { v: 1, order: [], plans: { x: { id: 5 } } }, ifRev: 2 })).s, 400);
  assert.equal((await handle('PUT', '{not json', store)).statusCode, 400); assert.equal((await handle('DELETE', null, store)).statusCode, 405);
  const big = st(4); big.plans.a.blob = 'x'.repeat(5 * 1024 * 1024); assert.equal((await call('PUT', { state: big, ifRev: 2 })).s, 413);
  assert.equal(mem[KEY].state.plans.a.name, 'Sale 2');                                                       // the failed writes changed nothing
  r = await call('PUT', { state: st(5), device: 'x'.repeat(200) }); assert.equal(r.s, 200); assert.equal(mem[KEY].device.length, 40);   // no ifRev = force (first-device bootstrap only)
  console.log('plans store tests: all passed');
})().catch(e => { console.error(e); process.exit(1); });
