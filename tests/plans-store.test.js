// Tests for the cloud plan store (netlify/lib/plans-store.js) with an in-memory blob store that has real ETag / conditional-write behaviour.
const assert = require('assert');
const { handle, KEY, PREV_KEY, HIST_INDEX, HIST_PREFIX, SNAP_EVERY_MS } = require('../netlify/lib/plans-store.js');
(async () => {
  const mem = {}, tags = {}; let n = 0, beforeWrite = null;
  const store = {
    get: async (k) => (mem[k] !== undefined ? JSON.parse(JSON.stringify(mem[k])) : null),
    getWithMetadata: async (k) => (mem[k] !== undefined ? { data: JSON.parse(JSON.stringify(mem[k])), etag: tags[k], metadata: {} } : null),
    setJSON: async (k, v, o) => {
      if (k === KEY && beforeWrite) { const f = beforeWrite; beforeWrite = null; f(); }       // simulate another writer sneaking in between our read and our write
      if (o && o.onlyIfNew && mem[k] !== undefined) return { modified: false };
      if (o && o.onlyIfMatch !== undefined && (mem[k] === undefined || tags[k] !== o.onlyIfMatch)) return { modified: false };
      mem[k] = JSON.parse(JSON.stringify(v)); tags[k] = 'e' + (++n); return { modified: true, etag: tags[k] };
    },
    delete: async (k) => { delete mem[k]; delete tags[k]; },
  };
  const plan = (id, name, extra) => ({ id, name, rev: 1, setup: {}, settings: {}, overrides: {}, catApprovals: {}, offers: [], ...(extra || {}) });
  const st = (...ps) => ({ v: 1, activeId: ps[0].id, order: ps.map(p => p.id), plans: Object.fromEntries(ps.map(p => [p.id, p])) });
  const call = async (m, b, q) => { const r = await handle(m, b == null ? null : JSON.stringify(b), store, q); return { s: r.statusCode, b: JSON.parse(r.body) }; };
  const realNow = Date.now; let clock = 1000000000000; Date.now = () => clock;

  // empty store
  let r = await call('GET'); assert.equal(r.s, 200); assert.equal(r.b.rev, 0); assert.equal(r.b.state, null);
  assert.deepEqual((await call('GET', null, { history: '1' })).b.history, []);
  // first save, then a normal save bumps the revision
  r = await call('PUT', { state: st(plan('a', 'Sale 1')), ifRev: 0, device: 'laptop' }); assert.equal(r.s, 200); assert.equal(r.b.rev, 1);
  r = await call('GET'); assert.equal(r.b.rev, 1); assert.equal(r.b.state.plans.a.name, 'Sale 1'); assert.equal(r.b.device, 'laptop');
  r = await call('PUT', { state: st(plan('a', 'Sale 2')), ifRev: 1, device: 'phone' }); assert.equal(r.s, 200); assert.equal(r.b.rev, 2);
  assert.equal(mem[PREV_KEY].state.plans.a.name, 'Sale 1'); assert.equal(mem[KEY].state.plans.a.name, 'Sale 2');
  // an out-of-date writer is refused with the current copy
  r = await call('PUT', { state: st(plan('a', 'Sale 3')), ifRev: 1, device: 'laptop' }); assert.equal(r.s, 409); assert.equal(r.b.conflict, true); assert.equal(r.b.state.plans.a.name, 'Sale 2');
  // ATOMIC: another writer lands between our read and our write -> we are refused (409 with their copy), never silently overwriting
  beforeWrite = () => { mem[KEY] = { rev: 3, updatedAt: 5, device: 'tablet', state: st(plan('a', 'Tablet edit')) }; tags[KEY] = 'e-sneaky'; };
  r = await call('PUT', { state: st(plan('a', 'Late writer')), ifRev: 2, device: 'laptop' }); assert.equal(r.s, 409); assert.equal(r.b.state.plans.a.name, 'Tablet edit'); assert.equal(mem[KEY].state.plans.a.name, 'Tablet edit');
  // the first-ever save is atomic too
  const fresh = {}; const s2 = { ...store, getWithMetadata: async () => null, get: async () => null, setJSON: async (k, v, o) => { fresh[k] = o; return k === KEY ? { modified: false } : { modified: true }; } };
  const rr = await handle('PUT', JSON.stringify({ state: st(plan('a', 'x')) }), s2); assert.equal(rr.statusCode, 409); assert.deepEqual(fresh[KEY], { onlyIfNew: true });

  // a save that would drop a plan the cloud already has is refused (plans are archived, never deleted)
  r = await call('PUT', { state: st(plan('a', 'Tablet edit'), plan('b', 'Second')), ifRev: 3 }); assert.equal(r.s, 200);
  r = await call('PUT', { state: st(plan('a', 'Tablet edit')), ifRev: 4 }); assert.equal(r.s, 422); assert.ok(/Second/.test(r.b.error)); assert.equal(Object.keys(mem[KEY].state.plans).length, 2);
  r = await call('PUT', { state: st(plan('a', 'Tablet edit'), plan('b', 'Second', { archived: true })), ifRev: 4 }); assert.equal(r.s, 200);     // archiving is fine
  r = await call('PUT', { state: st(plan('a', 'Tablet edit')), ifRev: 5, allowRemove: true }); assert.equal(r.s, 200);                              // explicit opt-in only

  // bad input
  assert.equal((await call('PUT', { state: { nope: 1 }, ifRev: 6 })).s, 400); assert.equal((await call('PUT', { state: { v: 1, order: [], plans: { x: { id: 'x' } } } })).s, 400);
  assert.equal((await handle('PUT', '{not json', store)).statusCode, 400); assert.equal((await handle('DELETE', null, store)).statusCode, 405);
  const big = st(plan('a', 'Big', { blob: 'x'.repeat(5 * 1024 * 1024) })); assert.equal((await call('PUT', { state: big, ifRev: 6 })).s, 413);
  const keep = mem[KEY].rev; r = await call('PUT', { state: st(plan('a', 'Dev'), plan('b', 'Second', { archived: true })), device: 'x'.repeat(200) }); assert.equal(r.s, 200); assert.equal(mem[KEY].device.length, 40); assert.ok(mem[KEY].rev === keep + 1);

  // HISTORY: a snapshot of the state before a burst of edits, at most one every 5 minutes
  const hist = async () => (await call('GET', null, { history: '1' })).b.history;
  const startN = (await hist()).length; assert.ok(startN >= 1);
  clock += 1000; await call('PUT', { state: st(plan('a', 'Burst 1', { overrides: { p1: {} } }), plan('b', 'Second', { archived: true })) });
  clock += 1000; await call('PUT', { state: st(plan('a', 'Burst 2', { overrides: { p1: {}, p2: {} } }), plan('b', 'Second', { archived: true })) });
  assert.equal((await hist()).length, startN, 'edits within 5 minutes add no snapshot');
  clock += SNAP_EVERY_MS + 1; await call('PUT', { state: st(plan('a', 'Burst 3'), plan('b', 'Second', { archived: true })) });
  let h = await hist(); assert.equal(h.length, startN + 1); assert.equal(h[0].plans.find(p => p.id === 'a').name, 'Burst 2'); assert.equal(h[0].plans.find(p => p.id === 'a').decisions, 2);   // the version BEFORE the latest change
  assert.ok(h[0].id.startsWith(HIST_PREFIX));
  // a version can be read back whole
  r = await call('GET', null, { version: h[0].id }); assert.equal(r.s, 200); assert.equal(r.b.state.plans.a.name, 'Burst 2');
  assert.equal((await call('GET', null, { version: 'plans' })).s, 400); assert.equal((await call('GET', null, { version: HIST_PREFIX + 'nope' })).s, 404);
  // retention: everything for 48h, then one per day; old ones are deleted from the store
  for (let i = 0; i < 6; i++) { clock += SNAP_EVERY_MS + 1; await call('PUT', { state: st(plan('a', 'Spaced ' + i), plan('b', 'Second', { archived: true })) }); }
  const before = (await hist()).length; clock += 3 * 86400000; await call('PUT', { state: st(plan('a', 'Much later'), plan('b', 'Second', { archived: true })) });
  h = await hist(); assert.ok(h.length < before + 1, 'old same-day snapshots are thinned to one per day'); for (const e of h) assert.ok(mem[e.id] !== undefined, 'every listed version still exists');
  assert.equal(Object.keys(mem).filter(k => k.startsWith(HIST_PREFIX)).length, h.length, 'no orphaned version blobs');
  // history failing must never stop a save
  const broken = { ...store, setJSON: async (k, v, o) => { if (k === HIST_INDEX || k.startsWith(HIST_PREFIX)) throw new Error('disk full'); return store.setJSON(k, v, o); } };
  clock += SNAP_EVERY_MS + 1; const cur = mem[KEY].rev; const rb = await handle('PUT', JSON.stringify({ state: st(plan('a', 'Still saves'), plan('b', 'Second', { archived: true })), ifRev: cur }), broken); assert.equal(rb.statusCode, 200);
  Date.now = realNow;
  console.log('plans store tests: all passed');
})().catch(e => { console.error(e); process.exit(1); });
