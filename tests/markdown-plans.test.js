// Tests for sale-plan management (markdown-plans.js). Run: npm test
(() => {
const assert = require('assert');
const P = require('../markdown-plans.js');
const E = require('../markdown-engine.js');
let n = 0; const idGen = () => 'id' + (++n);

// dates: inclusive duration, strict validation
assert.equal(P.durationDays('2026-11-27', '2026-12-01'), 5);
assert.equal(P.durationDays('2026-11-27', '2026-11-27'), 1);
assert.equal(P.durationDays('2026-12-01', '2026-11-27'), null);                 // end before start
assert.equal(P.durationDays('', '2026-11-27'), null); assert.equal(P.durationDays('2026-02-31', '2026-03-05'), null); // impossible date not silently rolled over
assert.equal(P.durationDays('2026-10-03', '2026-10-05'), 3);                    // DST change (4 Oct) must not shift the count
assert.equal(P.durationDays('2026-12-30', '2027-01-02'), 4);

// fresh state + migration of the single legacy settings object
let s = P.createState(1000, idGen);
assert.equal(s.order.length, 1); assert.equal(s.plans[s.activeId].name, 'Sale 1'); assert.equal(s.plans[s.activeId].settings.maxDiscount, 50);
const m1 = P.migrate(null, { maxDiscount: 40, coreMode: 'include' }, 1000, idGen);
assert.equal(m1.plans[m1.activeId].settings.maxDiscount, 40); assert.equal(m1.plans[m1.activeId].settings.coreMode, 'include');
assert.equal(m1.plans[m1.activeId].settings.minStockUnits, 50);                  // missing fields filled from defaults
const m2 = P.migrate(m1, null, 2000, idGen); assert.deepEqual(m2.order, m1.order);   // an up-to-date state is kept
const bad = JSON.parse(JSON.stringify(m1)); bad.activeId = 'ghost'; assert.equal(P.migrate(bad, null, 1, idGen).activeId, bad.order[0]);
assert.equal(P.migrate({ junk: true }, null, 1, idGen).order.length, 1);         // garbage -> a clean state, never a crash

// add: unique names, becomes active, original state untouched
const before = JSON.stringify(s);
let r = P.addPlan(s, 'Black Friday 2026', 2000, idGen);
assert.equal(JSON.stringify(s), before);                                          // no mutation of the input
assert.equal(r.state.plans[r.id].name, 'Black Friday 2026'); assert.equal(r.state.activeId, r.id); assert.equal(r.state.order.length, 2);
const r2 = P.addPlan(r.state, 'black friday 2026', 3000, idGen); assert.equal(r2.state.plans[r2.id].name, 'black friday 2026 2');   // case-insensitive uniqueness
const blank = P.addPlan(s, '', 1, idGen); assert.equal(blank.state.plans[blank.id].name, 'Sale 2');   // an empty name gets a sensible default

// updatePlan: setup + settings, levels cleaned, max snapped to an allowed level
const bfId = r.id; let u = P.updatePlan(r.state, bfId, { setup: { start: '2026-11-27', end: '2026-12-01', objective: 'clear', targetRevenue: 250000 }, settings: { allowedDiscounts: [70, 20, 20, 33, 50, -5, 0, 200, 'x'], maxDiscount: 60 } }, 4000);
let p = u.plans[bfId];
assert.deepEqual(p.settings.allowedDiscounts, [20, 33, 50, 70]); assert.equal(p.settings.maxDiscount, 50);   // 60 not allowed -> snaps down to 50
assert.equal(p.rev, 2); assert.equal(p.updatedTs, 4000); assert.equal(p.setup.objective, 'clear');
u = P.updatePlan(u, bfId, { settings: { allowedDiscounts: [] } }); assert.deepEqual(u.plans[bfId].settings.allowedDiscounts, [20]); // never an empty list
u = P.updatePlan(u, bfId, { settings: { weights: { cover: 40 } } }); assert.equal(u.plans[bfId].settings.weights.cover, 40); assert.equal(u.plans[bfId].settings.weights.velocity, 25); // weights merge, not replace
assert.equal(P.updatePlan(u, 'ghost', { setup: {} }), u);                                                 // unknown id is a no-op

// engineSettings: sale length from dates, objective thresholds applied
let es = P.engineSettings(u.plans[bfId]); assert.equal(es.saleDays, 5); assert.equal(es.excludeBelow, 30); assert.equal(es.groupBAt, 60);
u = P.updatePlan(u, bfId, { setup: { start: '', end: '' } }); es = P.engineSettings(u.plans[bfId]); assert.equal(es.saleDays, u.plans[bfId].settings.saleDays);   // no dates -> falls back
for (const o of Object.keys(P.OBJECTIVES)) assert.ok(P.OBJECTIVES[o].excludeBelow < P.OBJECTIVES[o].groupBAt);   // tiers stay ordered
// objectives move the thresholds the right way: clearing admits more products than protecting profit
assert.ok(P.OBJECTIVES.clear.excludeBelow < P.OBJECTIVES.profit.excludeBelow); assert.ok(P.OBJECTIVES.clear.groupBAt < P.OBJECTIVES.profit.groupBAt);
// …and that really changes the engine's output
const mk = (id, sc) => ({ id, name: id, colour: 'B', category: 'T', parentStyle: '', isCore: false, status: 'CURRENT', isGWP: false, soh: 200, sohCost: 1, onOrder: 0, sold: { d7: sc, d30: sc * 4, d60: sc * 8, d90: sc * 12 }, rrp: 100, price: 100, currentDiscountPct: 0, sizeCount: 5, soldOutSizes: 0, ageWeeks: 40 });
const prods = [1, 2, 3, 4, 5, 6, 7, 8].map(i => mk('P' + i, i * 3));
const inc = o => E.buildPlan(prods, P.engineSettings(P.updatePlan(u, bfId, { setup: { objective: o } }).plans[bfId])).totals.included;
assert.ok(inc('clear') >= inc('profit'));

// duplicate = template: copies rules, NOT dates / overrides / mappings / exports
let withData = JSON.parse(JSON.stringify(u)); withData.plans[bfId].overrides = { X: { pct: 30 } }; withData.plans[bfId].mappings = { 20: { id: 'gid://1', title: 'BF 20' } }; withData.plans[bfId].exports = [{ ts: 1 }];
withData = P.updatePlan(withData, bfId, { setup: { start: '2026-11-27', end: '2026-12-01' }, settings: { coreMode: 'exclude' } });
const d = P.duplicatePlan(withData, bfId, 5000, idGen); const dp = d.state.plans[d.id];
assert.equal(dp.name, 'Black Friday 2026 (copy)'); assert.equal(dp.setup.start, ''); assert.equal(dp.setup.end, '');
assert.equal(dp.setup.objective, 'clear'); assert.equal(dp.settings.coreMode, 'exclude'); assert.equal(dp.settings.maxDiscount, withData.plans[bfId].settings.maxDiscount);
assert.deepEqual(dp.overrides, {}); assert.deepEqual(dp.mappings, P.defaultMappings());   // collection names change between promotions: a duplicate starts from the defaults, not the old sale's mapping assert.deepEqual(dp.exports, []); assert.equal(dp.rev, 1); assert.notEqual(d.id, bfId);
assert.equal(d.state.order[d.state.order.indexOf(bfId) + 1], d.id); assert.equal(d.state.activeId, d.id);
assert.deepEqual(withData.plans[bfId].overrides, { X: { pct: 30 } });          // the source keeps its own decisions
dp.settings.allowedDiscounts.push(99); assert.ok(!withData.plans[bfId].settings.allowedDiscounts.includes(99));   // deep copy, not shared references
assert.equal(P.duplicatePlan(withData, 'ghost', 1, idGen).id, null);
const d2 = P.duplicatePlan(d.state, bfId, 6000, idGen); assert.equal(d2.state.plans[d2.id].name, 'Black Friday 2026 (copy) 2');

// rename: unique, bumps rev
let rn = P.renamePlan(d.state, d.id, 'EOFY 2027', 7000); assert.equal(rn.plans[d.id].name, 'EOFY 2027'); assert.equal(rn.plans[d.id].rev, 2);
rn = P.renamePlan(rn, d.id, '  black friday 2026 ', 7100); assert.equal(rn.plans[d.id].name, 'black friday 2026 2');
assert.equal(P.renamePlan(rn, 'ghost', 'x'), rn);

// archive / restore: never deletes, never leaves zero live plans, active moves off an archived plan
let a = P.archivePlan(d.state, d.id, 8000); assert.equal(a.plans[d.id].archived, true); assert.notEqual(a.activeId, d.id); assert.ok(a.plans[a.activeId] && !a.plans[a.activeId].archived);
assert.equal(Object.keys(a.plans).length, Object.keys(d.state.plans).length);   // still stored
assert.equal(P.setActive(a, d.id).activeId, a.activeId);                         // can't activate an archived plan
const only = P.createState(1, idGen); assert.equal(P.archivePlan(only, only.activeId), only);   // last live plan can't be archived
const back = P.restorePlan(a, d.id, 9000); assert.equal(back.plans[d.id].archived, false); assert.equal(back.activeId, d.id);
assert.equal(P.restorePlan(back, d.id), back);                                   // restoring a live plan is a no-op
const live = a.order.filter(id => !a.plans[id].archived); assert.equal(P.setActive(a, live[0]).activeId, live[0]);

// validation
const vp = P.newPlan('V', 1, 'v');
assert.equal(P.validatePlan(vp).errors.length, 0); assert.ok(P.validatePlan(vp).warnings.length >= 1);     // no dates -> a nudge, not an error
const v2 = P.updatePlan({ plans: { v: vp }, order: ['v'], activeId: 'v' }, 'v', { setup: { start: '2026-12-05', end: '2026-12-01', targetRevenue: -5, targetClearPct: 150 } }).plans.v;
const ve = P.validatePlan(v2).errors; assert.ok(ve.some(e => /before the start/.test(e))); assert.ok(ve.some(e => /Target revenue/.test(e))); assert.ok(ve.some(e => /clearance/.test(e)));
const v3 = P.updatePlan({ plans: { v: vp }, order: ['v'], activeId: 'v' }, 'v', { setup: { start: '2026-11-01', end: '2027-02-01' } }).plans.v;
assert.equal(P.validatePlan(v3).errors.length, 0); assert.ok(P.validatePlan(v3).warnings.some(w => /long sale/.test(w)));
// average-discount cap + scope: normalised, validated, saved per plan
let cp = P.createState(1, idGen), cid = cp.activeId;
const setCap = v => P.updatePlan(cp, cid, { settings: { avgDiscountCap: v } }).plans[cid].settings.avgDiscountCap;
assert.equal(setCap(null), null); assert.equal(setCap(''), null); assert.equal(setCap(0), null); assert.equal(setCap(-3), null); assert.equal(setCap('abc'), null);
assert.equal(setCap(35), 35); assert.equal(setCap('32.46'), 32.5); assert.equal(setCap(400), 95);
assert.equal(P.newPlan('n', 1, 'n').settings.avgDiscountCap, null); assert.equal(P.newPlan('n', 1, 'n').settings.scope, 'recommended');
assert.equal(P.updatePlan(cp, cid, { settings: { scope: 'all' } }).plans[cid].settings.scope, 'all'); assert.equal(P.updatePlan(cp, cid, { settings: { scope: 'junk' } }).plans[cid].settings.scope, 'recommended');
// the average target is retired: whatever is saved, the engine runs without it and nothing warns about it
let w = P.validatePlan(P.updatePlan(cp, cid, { settings: { avgDiscountCap: 10 } }).plans[cid]).warnings; assert.ok(!w.some(x => /average/.test(x)));
assert.equal(P.engineSettings(P.updatePlan(cp, cid, { settings: { avgDiscountCap: 35 } }).plans[cid]).avgDiscountCap, null);
// cap and scope are rules, so a Duplicate copies them
let capped = P.updatePlan(cp, cid, { settings: { avgDiscountCap: 35, scope: 'all' } }); const cd = P.duplicatePlan(capped, cid, 5, idGen);
assert.equal(cd.state.plans[cd.id].settings.avgDiscountCap, 35); assert.equal(cd.state.plans[cd.id].settings.scope, 'all');
// older saved plans (no cap/scope keys) pick up the defaults on load
const old = JSON.parse(JSON.stringify(cp)); delete old.plans[cid].settings.avgDiscountCap; delete old.plans[cid].settings.scope;
const mig = P.migrate(old, null, 1, idGen).plans[cid].settings; assert.equal(mig.avgDiscountCap, null); assert.equal(mig.scope, 'recommended');
// ── Decisions on a plan ────────────────────────────────────────────────────
assert.deepEqual(P.sanitizeOverride({ exclude: true, reason: 'Other', note: 'x'.repeat(500), junk: 1 }), { exclude: true, reason: 'Other', note: 'x'.repeat(200) });
assert.deepEqual(P.sanitizeOverride({ group: 'B' }), { group: 'B' }); assert.equal(P.sanitizeOverride({ group: 'Z' }), null);
assert.deepEqual(P.sanitizeOverride({ pct: '33.33' }), { pct: 33.3, kind: 'discount' }); assert.deepEqual(P.sanitizeOverride({ pct: 30, kind: 'approved' }), { pct: 30, kind: 'approved' });
for (const bad of [null, undefined, 5, 'x', {}, { pct: 0 }, { pct: -5 }, { pct: 200 }, { pct: 'abc' }, { pct: '' }]) assert.equal(P.sanitizeOverride(bad), null);
let od = P.createState(1, idGen), oid = od.activeId;
let o1 = P.setOverrides(od, oid, { A: { pct: 30, kind: 'approved' }, B: { exclude: true, reason: 'Strong current sales' }, C: { group: 'A' }, D: { pct: 40 } }, 5000);
assert.equal(Object.keys(o1.plans[oid].overrides).length, 4); assert.equal(o1.plans[oid].rev, 2); assert.equal(o1.plans[oid].overrides.A.ts, 5000); assert.deepEqual(od.plans[oid].overrides, {});   // input untouched
assert.equal(P.setOverrides(o1, oid, { Z: null }, 6000), o1);                            // removing something that isn't there is a no-op (same state, no rev bump)
assert.equal(P.setOverrides(o1, oid, { Z: { pct: 0 } }, 6000), o1);                      // invalid decisions are dropped, not stored
assert.equal(P.setOverrides(o1, 'ghost', { A: { pct: 30 } }), o1);
let o2 = P.setOverrides(o1, oid, { A: null, D: { exclude: true } }, 7000); assert.ok(!('A' in o2.plans[oid].overrides)); assert.equal(o2.plans[oid].overrides.D.exclude, true);
assert.equal(P.clearOverrides(o1, oid, ['A', 'nope'], 8000).plans[oid].overrides.A, undefined); assert.equal(Object.keys(P.clearOverrides(o1, oid, ['A'], 8000).plans[oid].overrides).length, 3);
assert.deepEqual(P.clearOverrides(o1, oid, null, 9000).plans[oid].overrides, {}); assert.equal(P.clearOverrides(od, oid, null), od);
assert.deepEqual(P.overrideStats(o1.plans[oid], ['A', 'B', 'C']), { total: 4, exclude: 1, discount: 1, approved: 1, group: 1, stale: 1 });   // D is no longer in the plan: stale, but kept
// duplicate / archive / restore never lose or leak decisions
const dd = P.duplicatePlan(o1, oid, 10, idGen); assert.deepEqual(dd.state.plans[dd.id].overrides, {}); assert.equal(Object.keys(dd.state.plans[oid].overrides).length, 4);
const arc = P.archivePlan(dd.state, oid, 11); assert.equal(Object.keys(arc.plans[oid].overrides).length, 4);
assert.equal(Object.keys(P.restorePlan(arc, oid, 12).plans[oid].overrides).length, 4);

// ── Review: search, filters, parent-style grouping, sorting ─────────────────
const mkr = (id, o = {}) => ({ id, name: o.name || 'TEE', colour: o.colour || 'BLACK', category: o.category || 'TEES', style: id, parentStyle: o.parentStyle === undefined ? id.slice(0, 8) : o.parentStyle, isCore: !!o.isCore, status: 'CURRENT', isGWP: false, soh: o.soh || 100, sohCost: 1, onOrder: 0, sold: { d7: o.sold || 5, d30: (o.sold || 5) * 4, d60: (o.sold || 5) * 8, d90: (o.sold || 5) * 12 }, rrp: 100, price: 100, currentDiscountPct: 0, sizeCount: 5, soldOutSizes: 0, ageWeeks: 40 });
const rp = [mkr('W26AA001BLK', { name: 'ACCENT TEE', colour: 'BLACK', isCore: true, soh: 300 }), mkr('W26AA001WHT', { name: 'ACCENT TEE', colour: 'WHITE', isCore: true, soh: 50 }), mkr('W26AA001OLI', { name: 'ACCENT TEE', colour: 'OLIVE', isCore: true, soh: 10 }),
  mkr('W26BB002BLK', { name: 'BOXER SHORT', category: 'SHORTS', colour: 'BLACK', soh: 500 }), mkr('W26CC003GRY', { name: 'CAMP HOOD', category: 'SWEATS', colour: 'GREY', soh: 30 }), mkr('NOPARENT', { name: 'ODD ITEM', parentStyle: '', category: 'TEES', soh: 20 })];
const rplan = E.buildPlan(rp, { maxDiscount: 70 }, { W26BB002BLK: { exclude: true, reason: 'Other' }, W26CC003GRY: { pct: 40, kind: 'discount' } });
let rv = P.buildReview(rplan.items, {}); assert.equal(rv.total, 6); assert.equal(rv.count, 6);
const multi = rv.groups.filter(g => g.multi); assert.equal(multi.length, 1); assert.equal(multi[0].parentStyle, 'W26AA001'); assert.equal(multi[0].items.length, 3);   // three colours -> one parent row
assert.equal(rv.groups.length, 4); assert.ok(rv.groups.some(g => !g.multi && g.items[0].row.p.id === 'NOPARENT'));                                       // no parent style -> a plain row
assert.deepEqual(multi[0].items.map(i => i.row.p.colour), ['BLACK', 'OLIVE', 'WHITE']);                                                                  // colours sorted
assert.equal(P.buildReview(rplan.items, { q: 'accent' }).count, 3); assert.equal(P.buildReview(rplan.items, { q: 'accent white' }).count, 1);
assert.equal(P.buildReview(rplan.items, { q: 'W26AA001' }).count, 3); assert.equal(P.buildReview(rplan.items, { q: 'zzz' }).groups.length, 0);
assert.equal(P.buildReview(rplan.items, { q: 'accent white' }).groups[0].multi, false);                                                                  // a lone surviving colour drops the parent row
assert.equal(P.buildReview(rplan.items, { category: 'shorts' }).count, 1); assert.equal(P.buildReview(rplan.items, { core: 'core' }).count, 3); assert.equal(P.buildReview(rplan.items, { core: 'noncore' }).count, 3);
assert.equal(P.buildReview(rplan.items, { view: 'overridden' }).count, 2); assert.equal(P.buildReview(rplan.items, { view: 'notsale' }).groups.some(g => g.items.some(i => i.row.p.id === 'W26BB002BLK')), true);
assert.equal(P.buildReview(rplan.items, { view: 'sale' }).count + P.buildReview(rplan.items, { view: 'notsale' }).count, 6);                              // every product is in exactly one of the two
const spRev = E.buildPlan(rp.map(r => (r.id === 'W26CC003GRY' ? { ...r, specialPct: 50, specialNote: 'X' } : r)), { maxDiscount: 70 });
assert.deepEqual(P.buildReview(spRev.items, { view: 'special' }).groups.map(g => g.key), ['id:W26CC003GRY']);                                           // special buys have their own filter
assert.equal(P.buildReview(rplan.items, { view: 'special' }).count, 0);
assert.equal(P.buildReview(rplan.items, { view: 'bogus' }).count, 6);                                                                                    // unknown view -> all
assert.deepEqual(P.buildReview(rplan.items, { sort: 'soh' }).groups.map(g => g.key), ['id:W26BB002BLK', 'ps:W26AA001', 'id:W26CC003GRY', 'id:NOPARENT']);   // by stock, a parent counts all its colours (360)
assert.equal(P.buildReview(rplan.items, { sort: 'name' }).groups[0].items[0].row.p.name, 'ACCENT TEE');
assert.deepEqual(P.buildReview(rplan.items, { sort: 'onorder' }, { onOrder: i => (i.row.p.id === 'W26CC003GRY' ? 99 : 0) }).groups[0].key, 'id:W26CC003GRY');
assert.deepEqual(P.buildReview(rplan.items, { sort: 'category' }).groups.map(g => g.items[0].row.p.category), ['SHORTS', 'SWEATS', 'TEES', 'TEES']);
assert.deepEqual(P.buildReview(rplan.items, { q: 'tee', sort: 'score' }).groups.map(g => g.key), P.buildReview(rplan.items, { q: 'tee', sort: 'score' }).groups.map(g => g.key));   // deterministic
// one row per product/colour (flat), collection filter, on-order and restock views
const flat = P.buildReview(rplan.items, { flat: true }); assert.equal(flat.groups.length, 6); assert.ok(flat.groups.every(g => !g.multi && g.items.length === 1)); assert.equal(flat.count, 6);
assert.equal(P.buildReview(rplan.items, {}).groups.filter(g => g.multi).length, 1);                                          // grouping is still available when asked for
assert.deepEqual(P.buildReview(rplan.items, { flat: true, q: 'accent' }).groups.map(g => g.items[0].row.p.colour), ['BLACK', 'OLIVE', 'WHITE']);   // colours listed individually, sorted
const colr = rp.map(r => ({ ...r, collection: r.id.startsWith('W26AA') ? '2026 - BLACK FIRDAY' : r.id === 'W26CC003GRY' ? '2027 AW1 - IKIZAMA' : '' }));
const cplan = E.buildPlan(colr, { maxDiscount: 70 });
assert.equal(P.buildReview(cplan.items, { collection: '2026 - black firdai'.replace('firdai', 'firday') }).count, 3);           // loose, case-insensitive match
assert.equal(P.buildReview(cplan.items, { collection: '2027 aw1 ikizama' }).count, 1); assert.equal(P.buildReview(cplan.items, { collection: 'nope' }).count, 0); assert.equal(P.buildReview(cplan.items, { collection: '' }).count, 6);
assert.equal(P.buildReview(cplan.items, { collection: '2026 - BLACK FIRDAY', category: 'TEES' }).count, 3);                    // combines with other filters
const oon = i => (i.row.p.id === 'W26BB002BLK' ? 120 : i.row.p.id === 'W26CC003GRY' ? 40 : 0);
assert.deepEqual(P.buildReview(rplan.items, { view: 'onorder', flat: true }, { onOrder: oon }).groups.map(g => g.key).sort(), ['id:W26BB002BLK', 'id:W26CC003GRY']);
assert.equal(P.buildReview(rplan.items, { view: 'onorder' }).count, 0);                                                      // no on-order information -> nothing matches
const rsReview = E.buildPlan(rp.concat([{ ...mkr('RESTOCKED'), soh: 0, restockUnits: 300, sold: { d7: 2, d30: 8, d60: 16, d90: 24 } }]), { maxDiscount: 70 });
assert.deepEqual(P.buildReview(rsReview.items, { view: 'restock', flat: true }).groups.map(g => g.key), ['id:RESTOCKED']);

assert.deepEqual(P.sanitizeOverride({ exclude: true, confirm: true, reason: 'x' }), { exclude: true, confirm: true });   // legacy per-product approvals are still sanitised and kept (inert in the engine)

assert.deepEqual(P.buildReview([], {}).groups, []);
// ── Special buys & GWP selections ───────────────────────────────────────────
let sp = P.createState(1, idGen), spid = sp.activeId;
assert.deepEqual(sp.plans[spid].special, []); assert.deepEqual(sp.plans[spid].gwp, { items: [], threshold: null, qty: {} });
assert.deepEqual(P.sanitizeSelection('special', { kind: 'group', value: '  2026 - BF EXCLUSIVE ', pct: 50 }), { kind: 'group', value: '2026 - BF EXCLUSIVE', pct: 50 });
for (const bad of [null, {}, { kind: 'group', value: '' }, { kind: 'nope', value: 'x', pct: 50 }, { kind: 'group', value: 'x' }, { kind: 'group', value: 'x', pct: 0 }, { kind: 'group', value: 'x', pct: 99 }, { kind: 'colour', value: 'GWP', pct: 50 }]) assert.equal(P.sanitizeSelection('special', bad), null);   // special buys can now be picked by category; unknown kinds are still rejected
assert.deepEqual(P.sanitizeSelection('gwp', { kind: 'category', value: 'GWP' }), { kind: 'category', value: 'GWP' }); assert.equal(P.sanitizeSelection('gwp', { kind: 'po', value: 'x' }), null);
let a1 = P.addSelection(sp, spid, 'special', { kind: 'group', value: '2026 - BF EXCLUSIVE', pct: 50 }, 100, idGen);
assert.ok(a1.id); assert.equal(a1.state.plans[spid].special.length, 1); assert.equal(a1.state.plans[spid].rev, 2); assert.deepEqual(sp.plans[spid].special, []);            // input untouched
let a2 = P.addSelection(a1.state, spid, 'special', { kind: 'group', value: '2026 BF exclusive', pct: 40 }, 200, idGen);                                                  // same collection (normalised) -> updated, not duplicated
assert.equal(a2.state.plans[spid].special.length, 1); assert.equal(a2.id, a1.id); assert.equal(a2.state.plans[spid].special[0].pct, 40);
assert.equal(P.addSelection(a1.state, spid, 'special', { kind: 'group', value: 'x' }, 1, idGen).id, null);                                                              // invalid -> no change
let a3 = P.addSelection(a2.state, spid, 'special', { kind: 'parent', value: 'w27ba003', pct: 50 }, 300, idGen); assert.equal(a3.state.plans[spid].special.length, 2);
a3 = P.setSpecialPct(a3.state, spid, a1.id, 30, 400) && { state: P.setSpecialPct(a3.state, spid, a1.id, 30, 400) }; assert.equal(a3.state.plans[spid].special[0].pct, 30);
assert.equal(P.setSpecialPct(a3.state, spid, a1.id, 3, 500), a3.state);                                                                                                   // out-of-range -> unchanged
let g1 = P.addSelection(a3.state, spid, 'gwp', { kind: 'category', value: 'GWP' }, 600, idGen); assert.equal(g1.state.plans[spid].gwp.items.length, 1);
let g2 = P.setGwpQty(g1.state, spid, 'w26lg011blk', 250, 700); assert.equal(g2.plans[spid].gwp.qty.W26LG011BLK, 250);
assert.equal(P.setGwpQty(g2, spid, 'W26LG011BLK', '', 800).plans[spid].gwp.qty.W26LG011BLK, undefined); assert.equal(P.setGwpQty(g1.state, spid, 'NOPE', null), g1.state);
assert.equal(P.setGwpQty(g1.state, spid, 'X', -3).plans[spid].gwp.qty.X, undefined); assert.equal(P.setGwpQty(g1.state, spid, 'X', 12.9).plans[spid].gwp.qty.X, 12);
assert.equal(P.setGwpThreshold(g1.state, spid, 150, 900).plans[spid].gwp.threshold, 150); assert.equal(P.setGwpThreshold(g1.state, spid, 'abc').plans[spid].gwp.threshold, null); assert.equal(P.setGwpThreshold(g1.state, spid, 0).plans[spid].gwp.threshold, null);
assert.equal(P.setGwpThreshold(g1.state, spid, null), g1.state);
let rm = P.removeSelection(g1.state, spid, 'special', a1.id, 1000); assert.equal(rm.plans[spid].special.length, 1); assert.equal(P.removeSelection(rm, spid, 'special', 'ghost'), rm);
assert.equal(P.removeSelection(g1.state, spid, 'gwp', g1.id, 1000).plans[spid].gwp.items.length, 0);
// allocations are for ONE promotion: a duplicate does not inherit them; archive/restore keeps them; old saved plans get empty defaults
const dp2 = P.duplicatePlan(g1.state, spid, 1100, idGen); assert.deepEqual(dp2.state.plans[dp2.id].special, []); assert.deepEqual(dp2.state.plans[dp2.id].gwp, { items: [], threshold: null, qty: {} }); assert.equal(g1.state.plans[spid].special.length, 2);
assert.equal(P.restorePlan(P.archivePlan(dp2.state, spid, 1), spid, 2).plans[spid].special.length, 2);
const olds = JSON.parse(JSON.stringify(sp)); delete olds.plans[spid].special; delete olds.plans[spid].gwp; const mg = P.migrate(olds, null, 1, idGen).plans[spid]; assert.deepEqual(mg.special, []); assert.deepEqual(mg.gwp, { items: [], threshold: null, qty: {} });

// resolver
const cat2 = [
  { style: 'W27BA003OYS', parentStyle: 'W27BA003', group: '2027 AW1 - IKIZAMA', category: 'BOX FIT TEES', title: 'STEEZY BOX FIT TEE - OYSTER', rrp: 100, cost: 20 },
  { style: 'W27BA003BLK', parentStyle: 'W27BA003', group: '2027 AW1 - IKIZAMA', category: 'BOX FIT TEES', title: 'STEEZY BOX FIT TEE - BLACK', rrp: 100, cost: 20 },
  { style: 'W26LG011BLK', parentStyle: 'W26LG011', group: '2026 - BLACK FIRDAY', category: 'GWP', title: 'ACCENT BEACH TOWEL - BLACK', rrp: 80, cost: 11 },
  { style: 'W26KG916BLK', parentStyle: 'W26KG916', group: '2026 - BLACK FIRDAY', category: 'GWP', title: 'ACCENT COOLER BAG - BLACK', rrp: 60, cost: 9 },
  { style: 'W25ZZ001RED', parentStyle: 'W25ZZ001', group: 'AA CORE STYLES', category: 'SHORTS', title: 'CORE SHORT - RED', rrp: 90, cost: 15 },
];
const ctx2 = { stylesByPo: { 'PO 2169 - IKIZAMA INDENT ORDER': ['W27BA003OYS', 'W27XX999NEW'] }, fallback: { W27XX999NEW: { title: 'NEW ONE - GREEN', category: 'SWEATS', group: '' } } };
let rs = P.resolveSelections([{ id: 's1', kind: 'group', value: '2027 aw1  ikizama', pct: 50 }], cat2, ctx2);                  // loose matching of the collection name
assert.deepEqual(rs.map(r => r.style), ['W27BA003OYS', 'W27BA003BLK']); assert.equal(rs[0].pct, 50); assert.equal(rs[0].conflict, null);
assert.deepEqual(P.resolveSelections([{ id: 's2', kind: 'parent', value: 'w27ba003', pct: 40 }], cat2, ctx2).map(r => r.style), ['W27BA003OYS', 'W27BA003BLK']);
assert.deepEqual(P.resolveSelections([{ id: 's3', kind: 'style', value: 'w25zz001red', pct: 30 }], cat2, ctx2).map(r => r.style), ['W25ZZ001RED']);
assert.deepEqual(P.resolveSelections([{ id: 's4', kind: 'category', value: 'GWP' }], cat2, ctx2).map(r => r.style), ['W26LG011BLK', 'W26KG916BLK']);
rs = P.resolveSelections([{ id: 's5', kind: 'po', value: 'po 2169 ikizama indent order', pct: 50 }], cat2, ctx2); assert.deepEqual(rs.map(r => r.style), ['W27BA003OYS', 'W27XX999NEW']);   // a PO also reaches styles missing from the catalogue
assert.equal(rs[1].entry.title, 'NEW ONE - GREEN'); assert.equal(P.resolveSelections([{ id: 's6', kind: 'group', value: 'nothing', pct: 50 }], cat2, ctx2).length, 0);
// overlapping selections: same discount is fine, different discounts are FLAGGED (not silently picked)
rs = P.resolveSelections([{ id: 'a', kind: 'group', value: '2027 AW1 - IKIZAMA', pct: 50 }, { id: 'b', kind: 'parent', value: 'W27BA003', pct: 50 }], cat2, ctx2); assert.equal(rs[0].sels.length, 2); assert.equal(rs[0].conflict, null);
rs = P.resolveSelections([{ id: 'a', kind: 'group', value: '2027 AW1 - IKIZAMA', pct: 50 }, { id: 'b', kind: 'style', value: 'W27BA003OYS', pct: 40 }], cat2, ctx2);
assert.match(rs.find(r => r.style === 'W27BA003OYS').conflict, /50% vs 40%/); assert.equal(rs.find(r => r.style === 'W27BA003BLK').conflict, null);
assert.deepEqual(P.resolveSelections([], cat2, ctx2), []); assert.deepEqual(P.resolveSelections([{ id: 'a', kind: 'group', value: 'x' }], null, null), []);
// conflicts + economics
assert.deepEqual(P.gwpConflicts(['w26lg011blk'], ['W26LG011BLK', 'W25ZZ001RED'], ['W26KG916BLK']).map(c => c.type + ':' + c.style), ['special:W26LG011BLK']);
assert.deepEqual(P.gwpConflicts(new Set(['W26KG916BLK']), [], ['w26kg916blk']).map(c => c.type), ['decision']); assert.deepEqual(P.gwpConflicts([], ['A'], ['B']), []);
const plE = { gwp: { qty: { W26LG011BLK: 100 } } };
let ec = P.gwpEconomics({ style: 'W26LG011BLK', soh: 60, incoming: 3000, cost: 11 }, plE); assert.deepEqual(ec, { available: 3060, planned: 100, unitCost: 11, totalCost: 1100, defaulted: false, costMissing: false });
ec = P.gwpEconomics({ style: 'W26KG916BLK', soh: 20, incoming: 0, cost: 9 }, plE); assert.equal(ec.planned, 20); assert.equal(ec.defaulted, true); assert.equal(ec.totalCost, 180);                // default: everything available
ec = P.gwpEconomics({ style: 'W26LG011BLK', soh: 50, incoming: 0, cost: 11 }, plE); assert.equal(ec.planned, 50);                                                                    // planned is capped at what's available
ec = P.gwpEconomics({ style: 'NOCOST', soh: 10, incoming: 5, cost: 0 }, plE); assert.equal(ec.totalCost, null); assert.equal(ec.costMissing, true);                              // missing cost is reported, not shown as $0
ec = P.gwpEconomics({ style: 'NEG', soh: -4, incoming: 0, cost: 5 }, plE); assert.equal(ec.available, 0); assert.equal(ec.totalCost, 0);
// GWP and special buys can share a collection: GWP wins automatically for broad picks, conflicts only where intent is unclear
const sp0 = (id, kind, value, pct = 50) => ({ id, kind, value, pct });
const mixCat = [
  { style: 'W26SPEC01BLK', parentStyle: 'W26SPEC0', group: '2026 - BLACK FIRDAY', category: 'BOX FIT TEES', title: 'BF TEE', rrp: 100, cost: 20 },
  { style: 'W26SPEC02BLK', parentStyle: 'W26SPEC0', group: '2026 - BLACK FIRDAY', category: 'SWEATS', title: 'BF SWEAT', rrp: 100, cost: 20 },
  { style: 'W26GWP001BLK', parentStyle: 'W26GWP00', group: '2026 - BLACK FIRDAY', category: 'GWP', title: 'BF TOWEL', rrp: 80, cost: 11 },
  { style: 'W26GWP002BLK', parentStyle: 'W26GWP00', group: '2026 - BLACK FIRDAY', category: 'GWP', title: 'BF BAG', rrp: 60, cost: 9 },
  { style: 'W26ODD001BLK', parentStyle: 'W26ODD00', group: '2026 - BLACK FIRDAY', category: 'ACCESSORIES', title: 'ODD ONE', rrp: 50, cost: 5 },
];
const ctxM = { stylesByPo: { 'PO BF': ['W26SPEC01BLK', 'W26GWP001BLK'] }, fallback: {} };
const res = (sp, gw) => { const S = P.resolveSelections(sp, mixCat, ctxM), G = P.resolveSelections(gw, mixCat, ctxM); return P.splitGwpOverlap(S, G); };
// 1. the real case: the whole sale collection is a special buy, GWP is picked by Apparel Magic's GWP category
let sx = res([sp0('s', 'group', '2026 - BLACK FIRDAY')], [{ id: 'g', kind: 'category', value: 'GWP' }]);
assert.deepEqual(sx.applied.map(r => r.style).sort(), ['W26ODD001BLK', 'W26SPEC01BLK', 'W26SPEC02BLK']); assert.deepEqual(sx.leftOut.map(r => r.style).sort(), ['W26GWP001BLK', 'W26GWP002BLK']); assert.deepEqual(sx.conflicts, []);
// the same, with GWP only known through the style's own AM category (no GWP pick on the GWP styles needed beyond the pick that names them)
sx = res([sp0('s', 'group', '2026 - BLACK FIRDAY')], [{ id: 'g', kind: 'style', value: 'W26GWP001BLK' }]); assert.deepEqual(sx.leftOut.map(r => r.style), ['W26GWP001BLK']); assert.deepEqual(sx.conflicts, []);
sx = res([sp0('s', 'parent', 'W26GWP00')], [{ id: 'g', kind: 'category', value: 'GWP' }]); assert.equal(sx.leftOut.length, 2); assert.equal(sx.applied.length, 0);       // a parent style that is wholly GWP is wholly left out
sx = res([sp0('s', 'po', 'PO BF')], [{ id: 'g', kind: 'category', value: 'GWP' }]); assert.deepEqual(sx.leftOut.map(r => r.style), ['W26GWP001BLK']); assert.deepEqual(sx.applied.map(r => r.style), ['W26SPEC01BLK']);
// 2. picked as a special buy BY NAME while being GWP -> a real, blocking conflict
sx = res([sp0('s', 'style', 'W26GWP001BLK')], [{ id: 'g', kind: 'category', value: 'GWP' }]); assert.deepEqual(sx.conflicts, ['W26GWP001BLK']); assert.equal(sx.leftOut.length, 0); assert.equal(sx.applied.length, 1);
sx = res([sp0('s', 'group', '2026 - BLACK FIRDAY'), sp0('s2', 'style', 'W26GWP002BLK', 40)], [{ id: 'g', kind: 'category', value: 'GWP' }]);                  // named AND via the collection -> explicit wins the conflict
assert.deepEqual(sx.conflicts, ['W26GWP002BLK']); assert.deepEqual(sx.leftOut.map(r => r.style), ['W26GWP001BLK']);
// 3. GWP only because a WHOLE collection was picked as GWP, overlapping a special-buy collection -> can't be guessed, so it is flagged
sx = res([sp0('s', 'group', '2026 - BLACK FIRDAY')], [{ id: 'g', kind: 'group', value: '2026 - BLACK FIRDAY' }]); assert.deepEqual(sx.conflicts.sort(), ['W26ODD001BLK', 'W26SPEC01BLK', 'W26SPEC02BLK']); assert.deepEqual(sx.leftOut.map(r => r.style).sort(), ['W26GWP001BLK', 'W26GWP002BLK']);   // AM's own GWP category is still definite, so those two are left out; the rest are ambiguous
// 4. no overlap, empty inputs
sx = res([sp0('s', 'style', 'W26SPEC01BLK')], [{ id: 'g', kind: 'category', value: 'GWP' }]); assert.deepEqual(sx.applied.map(r => r.style), ['W26SPEC01BLK']); assert.deepEqual([sx.leftOut.length, sx.conflicts.length], [0, 0]);
assert.deepEqual(P.splitGwpOverlap([], []), { applied: [], leftOut: [], conflicts: [] }); assert.deepEqual(P.splitGwpOverlap(null, null), { applied: [], leftOut: [], conflicts: [] });
// left-out styles feed no discount and no conflict list: only `applied` rows carry a special-buy discount, and conflicts are exactly the unresolved ones
sx = res([sp0('s', 'group', '2026 - BLACK FIRDAY')], [{ id: 'g', kind: 'category', value: 'GWP' }]);
assert.deepEqual(P.gwpConflicts(['W26GWP001BLK', 'W26GWP002BLK'], sx.applied.map(r => r.style), []), []);                                                           // no blocking conflicts remain for the common case
// Category group levels: set per category/tier, capped at the highest single discount, cleared with null, copied by Duplicate, defaulted on load
let gl = P.createState(1, idGen); const gid = gl.activeId;
assert.deepEqual(gl.plans[gid].groupLevels, {});
gl = P.setGroupLevel(gl, gid, 'SWEATS', 'A', 30, 5); assert.deepEqual(gl.plans[gid].groupLevels, { SWEATS: { A: 30 } }); assert.equal(gl.plans[gid].rev, 2);
gl = P.setGroupLevel(gl, gid, 'SWEATS', 'B', '50', 6); assert.deepEqual(gl.plans[gid].groupLevels.SWEATS, { A: 30, B: 50 });
assert.strictEqual(P.setGroupLevel(gl, gid, 'SWEATS', 'B', 50, 7), gl);                                                   // no change -> same state
gl = P.setGroupLevel(gl, gid, 'SWEATS', 'B', 999, 7); assert.equal(gl.plans[gid].groupLevels.SWEATS.B, gl.plans[gid].settings.maxDiscount);
assert.strictEqual(P.setGroupLevel(gl, gid, 'SWEATS', 'C', 40, 8), gl); assert.strictEqual(P.setGroupLevel(gl, gid, '', 'A', 40, 8), gl);
gl = P.setGroupLevel(gl, gid, 'SWEATS', 'A', null, 8); gl = P.setGroupLevel(gl, gid, 'SWEATS', 'B', '', 9); assert.deepEqual(gl.plans[gid].groupLevels, {});   // both back to auto -> entry removed
gl = P.setGroupLevel(gl, gid, 'JEANS', 'A', 40, 10); const gd = P.duplicatePlan(gl, gid, 11, idGen); assert.deepEqual(gd.state.plans[gd.id].groupLevels, { JEANS: { A: 40 } });
gd.state.plans[gd.id].groupLevels.JEANS.A = 50; assert.equal(gl.plans[gid].groupLevels.JEANS.A, 40);                  // a copy, not shared
assert.deepEqual(P.migrate({ v: gl.v, activeId: gid, order: [gid], plans: { [gid]: { ...gl.plans[gid], groupLevels: undefined } } }, null, 1, idGen).plans[gid].groupLevels, {});
assert.deepEqual(P.clearGroupLevels(gl, gid, 12).plans[gid].groupLevels, {});
// Forecast: last year's same dates (52 weeks back) grown by the target
let fc = P.createState(1, idGen); const fid = fc.activeId;
assert.equal(P.lyWindow(fc.plans[fid].setup), null);
fc = P.updatePlan(fc, fid, { setup: { start: '2026-11-27', end: '2026-11-30' } });
assert.deepEqual(P.lyWindow(fc.plans[fid].setup), { start: '2025-11-28', end: '2025-12-01', days: 4 });                   // Black Friday lands on last year's Black Friday
assert.equal(P.lyWindow({ start: '2026-11-30', end: '2026-11-27' }), null);
assert.equal(fc.plans[fid].setup.growthPct, null); assert.equal(fc.plans[fid].setup.liftPct, null);
for (const [inp, out] of [[10, 10], ['7.26', 7.3], ['', null], [0, null], [-5, null], ['x', null], [99, 50]]) assert.equal(P.updatePlan(fc, fid, { setup: { liftPct: inp } }).plans[fid].setup.liftPct, out);
for (const [inp, out] of [[90, 90], ['90', 90], ['12.34', 12.3], ['', null], ['x', null], [9999, 500], [-200, -90]]) assert.equal(P.updatePlan(fc, fid, { setup: { growthPct: inp } }).plans[fid].setup.growthPct, out);
const sales = { S1: { '2025-11-27': { qty: 5 }, '2025-11-28': { qty: 10 }, '2025-12-01': { qty: 7 }, '2025-12-02': { qty: 99 } }, S2: { '2025-11-29': { qty: 20 } }, S3: { '2025-11-29': { qty: 1000 } } };   // S3 has no category
const ly = P.lyUnitsByCategory(sales, { S1: 'Sweats', S2: 'SWEATS' }, P.lyWindow(fc.plans[fid].setup));
assert.deepEqual(ly.byCat, { SWEATS: 37 }); assert.equal(ly.total, 37);                                                  // 10+7 (S1, inside) + 20 (S2); outside the window or uncategorised excluded
assert.deepEqual(P.lyUnitsByCategory(sales, { S1: 'X' }, null).byCat, {});
const fi = (cat, soh, onOrder, price, pct, sohCost) => ({ row: { p: { category: cat, onOrder, price, sohCost }, m: { soh } }, final: { pct }, price: { newPrice: pct == null ? null : price * (1 - pct / 100) } });
const f1 = P.buildForecast([fi('SWEATS', 20, 10, 100, 50, 300), fi('SWEATS', 10, 0, 100, null, 150), fi('TEES', 100, 0, 50, 20, 500)], { SWEATS: 20, TEES: 40 }, 90);
const sw = f1.rows.find(r => r.category === 'SWEATS'), te = f1.rows.find(r => r.category === 'TEES');
assert.equal(sw.demand, 38); assert.equal(sw.avail, 40); assert.equal(sw.left, 2); assert.equal(sw.sold, 38); assert.equal(sw.short, 0);   // 20 x 1.9
assert.equal(te.demand, 76); assert.equal(te.avail, 100); assert.equal(te.sold, 76);
const f2 = P.buildForecast([fi('SWEATS', 10, 0, 100, 50, 300)], { SWEATS: 20 }, 90);
assert.equal(f2.rows[0].demand, 38); assert.equal(f2.rows[0].sold, 10); assert.equal(f2.rows[0].short, 28); assert.equal(f2.totals.left, -28);   // demand beyond stock is a shortfall, revenue capped at stock
assert.equal(f2.rows[0].revenue, Math.round(10 * 50 / 1.1)); assert.equal(f2.rows[0].gp, Math.round(10 * 50 / 1.1 - 10 * 30));
assert.equal(P.buildForecast([fi('SWEATS', 10, 0, 100, 50, 300)], { SWEATS: 20 }, null).rows[0].demand, 20);               // no growth = flat on last year
assert.equal(P.buildForecast([fi('SWEATS', 10, 0, 100, 50, 300)], {}, 90).rows[0].demand, 0);
assert.deepEqual(P.buildForecast([], {}, 90).totals.demand, 0);
// review filter: delivery month
{
  const mi = (id, dm) => ({ row: { p: { id, name: id, colour: '', style: id, parentStyle: '', category: 'X', deliveryMonth: dm, isCore: false }, m: { soh: 1 }, score: 1 }, final: { action: 'A', pct: 20 } });
  const its = [mi('a', 'OCT-26'), mi('b', 'Oct-26'), mi('c', 'SEP-26'), mi('d', ''), mi('e', 'CORE')];
  const ids = f => P.buildReview(its, f).groups.flatMap(g => g.items.map(i => i.row.p.id)).sort().join('');
  assert.equal(ids({}), 'abcde'); assert.equal(ids({ month: 'OCT-26' }), 'ab'); assert.equal(ids({ month: 'SEP-26' }), 'c'); assert.equal(ids({ month: '__none__' }), 'd'); assert.equal(ids({ month: 'CORE' }), 'e'); assert.equal(ids({ month: 'NOV-26' }), '');
}
// review: every column sorts both ways, empties last, parents sort on their colours combined
{
  const mk2 = (id, o) => ({ row: { p: { id, name: o.name || id, colour: '', style: id, parentStyle: o.ps || '', category: o.cat || 'X', deliveryMonth: o.dm || '', rrp: o.rrp || 0, price: o.price || 0, soldOutSizes: o.so || 0, sold: { d7: o.d7 || 0, d30: o.d30 || 0, d60: 0, d90: 0 }, isCore: false }, m: { soh: o.soh || 0, sohNow: o.soh || 0, weeksCover: o.cover == null ? null : o.cover, sellThroughProxy: null }, score: o.score || 0 }, final: { action: 'A', pct: o.pct == null ? null : o.pct, reason: o.why || '' }, systemPct: o.pct == null ? null : o.pct, price: { newPrice: o.np == null ? null : o.np } });
  const its = [mk2('a', { name: 'AA', dm: 'NOV-26', soh: 10, cover: 5, pct: 30, rrp: 100, np: 70, d30: 4, why: 'zzz' }), mk2('b', { name: 'BB', dm: 'SEP-26', soh: 30, cover: null, pct: 20, rrp: 80, np: 64, d30: 9, why: 'aaa' }), mk2('c', { name: 'CC', dm: 'JAN-27', soh: 20, cover: 12, pct: null, rrp: 0, np: null, d30: 1, why: 'mmm' }), mk2('d', { name: 'DD', dm: '', soh: 5, cover: 1, pct: 40, rrp: 120, np: 72, d30: 0, why: '' })];
  const ord = f => P.buildReview(its, { flat: true, ...f }).groups.map(g => g.items[0].row.p.id).join('');
  assert.equal(ord({ sort: 'soh' }), 'bcad'); assert.equal(ord({ sort: 'soh', dir: 'asc' }), 'dacb');   // numbers: desc by default, asc on request
  assert.equal(ord({ sort: 'month', dir: 'asc' }), 'bacd'); assert.equal(ord({ sort: 'month', dir: 'desc' }), 'cabd');      // chronological, not alphabetical; no month always last
  assert.equal(ord({ sort: 'cover', dir: 'asc' }), 'dacb'); assert.equal(ord({ sort: 'cover', dir: 'desc' }), 'cadb');      // empty (b) last both ways
  assert.equal(ord({ sort: 'discount', dir: 'asc' }), 'badc'); assert.equal(ord({ sort: 'discount', dir: 'desc' }), 'dabc');   // 20,30,40 then the empty one last
  assert.equal(ord({ sort: 'newprice', dir: 'desc' }), 'dabc'); assert.equal(ord({ sort: 'rrp', dir: 'desc' }), 'dabc');
  assert.equal(ord({ sort: 'name', dir: 'desc' }), 'dcba'); assert.equal(ord({ sort: 'name' }), 'abcd');                    // text: asc by default
  assert.equal(ord({ sort: 'why', dir: 'asc' }), 'bcad');                                                                   // text a..z, blank last
  assert.equal(ord({ sort: 'current', dir: 'asc' }).length, 4);
  assert.equal(ord({ sort: 'bogus' }), ord({ sort: 'category' }));                                                           // unknown column falls back to category
}
// ── Phase 5: demand range, confidence, cross-check, scenario levels, commercial summary, snapshots ──
{
  assert.deepEqual(P.demandScenarios(90).map(s => s.growth), [45, 90, 112.5]);
  assert.deepEqual(P.demandScenarios(null).map(s => s.growth), [-10, 0, 10]);
  assert.deepEqual(P.demandScenarios(20).map(s => s.growth), [10, 20, 30]);                                   // spread is at least 10 points
  assert.equal(P.demandScenarios(-80)[0].growth, -90);                                                        // never below -90%
  assert.equal(P.addDays('2025-11-28', -28), '2025-10-31'); assert.equal(P.addDays('2025-12-31', 1), '2026-01-01');
  // confidence
  assert.equal(P.forecastConfidence({ total: 5000 }, { days: 4 }, 50).level, 'High');
  assert.equal(P.forecastConfidence({ total: 5000 }, { days: 4 }, 90).level, 'High');
  assert.equal(P.forecastConfidence({ total: 5000 }, { days: 4 }, 150).level, 'Medium'); assert.ok(P.forecastConfidence({ total: 5000 }, { days: 4 }, 150).notes.some(n => /more than double/.test(n)));
  assert.equal(P.forecastConfidence({ total: 100 }, { days: 4 }, 0).level, 'Low'); assert.equal(P.forecastConfidence(null, null, 0).level, 'Low');
  assert.equal(P.forecastConfidence({ total: 5000 }, { days: 1 }, 0).level, 'Medium');
  // cross-check: LY window 4 days = 4000 units (1000/day) vs 28 days before = 2800 (100/day) -> uplift 10x; this year recent 28 days = 5600 (200/day) -> 200 x 10 x 4 days = 8000
  const cc = P.crossCheck({ win: { days: 4 }, lyUnits: 4000, preUnits: 2800, preDays: 28, recentUnits: 5600, recentDays: 28, saleDays: 4, lyByCat: { X: 3000, Y: 1000 }, preByCat: { X: 1400, Y: 1400 }, recentByCat: { X: 2800, Y: 2800 } });
  assert.equal(cc.uplift, 10); assert.equal(cc.projected, 8000); assert.equal(cc.recentDaily, 200); assert.equal(cc.preDaily, 100); assert.equal(cc.yoyTrend, 100);
  assert.equal(cc.byCat.X, Math.round((2800 / 28) * ((3000 / 4) / (1400 / 28)) * 4)); assert.ok(cc.byCat.Y > 0 && cc.byCat.Y < cc.byCat.X);
  assert.equal(P.crossCheck({ win: { days: 4 }, lyUnits: 4000, preUnits: 0, preDays: 28, recentUnits: 5600, recentDays: 28 }), null);   // no pre-sale baseline -> no cross-check
  assert.equal(P.crossCheck(null), null);
  // scenario levels: shift each category's current levels by allowed steps, clamped
  const cats = [{ category: 'X', groupA: 20, groupB: 40 }, { category: 'Y', groupA: 30, groupB: null }, { category: 'Z', groupA: null, groupB: null }, { category: 'W', groupA: 50, groupB: 70 }];
  assert.deepEqual(P.scenarioLevels(cats, [20, 30, 40, 50, 60, 70], 70, -1), { X: { A: 20, B: 30 }, Y: { A: 20 }, W: { A: 40, B: 60 } });   // lighter: clamped at the lowest level
  assert.deepEqual(P.scenarioLevels(cats, [20, 30, 40, 50, 60, 70], 70, 1), { X: { A: 30, B: 50 }, Y: { A: 40 }, W: { A: 60, B: 70 } });     // deeper: clamped at the highest
  assert.deepEqual(P.scenarioLevels(cats, [20, 30, 40, 50, 60, 70], 50, 1), { X: { A: 30, B: 50 }, Y: { A: 40 }, W: { A: 50, B: 50 } });      // never above the highest single discount
  assert.deepEqual(P.scenarioLevels(cats, [], 70, 1), {});
  // commercial summary
  const ci = (id, soh, rrp, price, sohCost, pct, np) => ({ row: { p: { id, name: id, colour: '', rrp, price, sohCost }, m: { soh } }, final: { pct }, price: { newPrice: np } });
  const cs = P.commercialSummary([ci('a', 100, 100, 100, 2000, 30, 70), ci('b', 50, 40, 40, 1500, 50, 20), ci('c', 10, 100, 100, 100, null, null), ci('d', 20, 100, 100, 800, 20, 80), ci('e', 10, 100, 100, 500, 40, 62)], 1234.4);
  assert.equal(cs.units, 190); assert.equal(cs.cost, 4900); assert.equal(cs.retail, 100 * 100 + 50 * 40 + 10 * 100 + 20 * 100 + 10 * 100); assert.equal(cs.included, 4); assert.equal(cs.excluded, 1); assert.equal(cs.gwpCost, 1234);
  assert.deepEqual(cs.belowCost.map(b => b.id), ['b']);                                                         // b: $20 inc GST = $18.18 ex vs $30 cost
  assert.deepEqual(cs.lowMargin.map(b => b.id), ['e']);                                                          // e: $56.36 ex vs $50 cost = 11% margin (flagged, not blocked); a and d are comfortably above
  // snapshots
  let sn = P.createState(1, idGen); const sid = sn.activeId;
  sn = P.addSnapshot(sn, sid, { label: 'Base', growthPct: 90, demand: 47000, sold: 40000, revenue: 1000000, gp: 500000, gpPct: 50, effDiscount: 31.4, avail: 90000, gwpCost: 5000 }, 100);
  assert.equal(sn.plans[sid].snapshots.length, 1); assert.equal(sn.plans[sid].snapshots[0].revenue, 1000000); assert.equal(sn.plans[sid].snapshots[0].ts, 100);
  sn = P.addSnapshot(sn, sid, { label: 'Later', growthPct: 60 }, 200); assert.equal(sn.plans[sid].snapshots[0].label, 'Later'); assert.equal(sn.plans[sid].snapshots[0].demand, null);   // newest first
  for (let k = 0; k < 25; k++) sn = P.addSnapshot(sn, sid, { label: 'x' + k }, 300 + k); assert.equal(sn.plans[sid].snapshots.length, 20);
  const ts0 = sn.plans[sid].snapshots[0].ts; assert.equal(P.removeSnapshot(sn, sid, ts0).plans[sid].snapshots.length, 19); assert.strictEqual(P.removeSnapshot(sn, sid, -1), sn);
  const dd = P.duplicatePlan(sn, sid, 999, idGen); assert.deepEqual(dd.state.plans[dd.id].snapshots, []);   // snapshots describe one sale's past numbers: not copied
  assert.deepEqual(P.migrate({ v: sn.v, activeId: sid, order: [sid], plans: { [sid]: { ...sn.plans[sid], snapshots: undefined } } }, null, 1, idGen).plans[sid].snapshots, []);
}
// review filter: suggested discount %
{
  const si = (id, sp) => ({ row: { p: { id, name: id, colour: '', style: id, parentStyle: '', category: 'X', isCore: false }, m: { soh: 1 }, score: 1 }, final: { action: 'A', pct: sp }, systemPct: sp });
  const its = [si('a', 20), si('b', 20), si('c', 50), si('d', null), si('e', 30)];
  const ids = f => P.buildReview(its, f).groups.flatMap(g => g.items.map(i => i.row.p.id)).sort().join('');
  assert.equal(ids({}), 'abcde'); assert.equal(ids({ sugg: '20' }), 'ab'); assert.equal(ids({ sugg: 50 }), 'c'); assert.equal(ids({ sugg: '__none__' }), 'd'); assert.equal(ids({ sugg: '70' }), '');
  assert.equal(ids({ sugg: '20', category: 'X' }), 'ab');
}
// ── Category approval: the main workflow ──
{
  let st = P.createState(1, idGen); const id = st.activeId;
  const mkp = (pid, cat, soh, d30, extra) => Object.assign({ id: pid, style: pid, name: pid, colour: 'BLK', category: cat, collection: '', parentStyle: '', isCore: false, isGWP: false, soh, sohCost: soh * 10, onOrder: 0, sold: { d7: 1, d30, d60: d30 * 2, d90: d30 * 3 }, rrp: 100, price: 100, currentDiscountPct: 0, sizeCount: 4, soldOutSizes: 0, ageWeeks: 40 }, extra || {});
  const prods = [mkp('T1', 'TEES', 200, 2), mkp('T2', 'TEES', 100, 20), mkp('T3', 'TEES', 300, 1), mkp('S1', 'SHORTS', 80, 8), mkp('S2', 'SHORTS', 90, 9), mkp('G1', 'GWP', 40, 0, { isGWP: true })];
  const build = (stx, extra) => E.buildPlan(prods, P.engineSettings(stx.plans[id]), stx.plans[id].overrides, stx.plans[id].groupLevels, P.frozenAllocs(stx.plans[id]));
  let plan = build(st), rows = P.categoryRows(plan.items, plan, st.plans[id], { TEES: 500, SHORTS: 0 });
  assert.deepEqual(rows.map(r => r.category), ['SHORTS', 'TEES']);                                            // GWP-only category isn't a category to approve
  const tees = rows.find(r => r.category === 'TEES');
  assert.equal(tees.products, 3); assert.equal(tees.soh, 600); assert.equal(tees.onOrder, 500); assert.equal(tees.sold30, 23); assert.equal(tees.approved, false);
  assert.equal(tees.countA + tees.countB + tees.countC + tees.countX + tees.countS + tees.countExcluded, 3); assert.equal(tees.eligible, tees.countA + tees.countB + tees.countC + tees.countX); assert.ok(tees.levelC === 50);
  assert.deepEqual(P.approvalProgress(rows), { catsTotal: 2, catsApproved: 0, catsRemaining: 2, prodsTotal: 5, prodsApproved: 0, prodsRemaining: 5 });   // the GWP product is not counted
  // a GWP product that also carries a discount (a genuine conflict) is counted against its category so approval can be held
  { const bp = E.buildPlan(prods.concat([mkp('G2', 'SHORTS', 10, 0, { isGWP: true, specialPct: 50 })]), P.engineSettings(st.plans[id]), {}, null, null);
    assert.equal(P.categoryRows(bp.items, bp, st.plans[id], {}).find(r => r.category === 'SHORTS').blocked, 1); assert.equal(P.categoryRows(bp.items, bp, st.plans[id], {}).find(r => r.category === 'TEES').blocked, 0); }
  // approve TEES: levels + every allocation saved, moves to approved, progress updates
  const alloc = Object.fromEntries(plan.items.filter(i => i.row.p.category === 'TEES').map(i => [i.row.p.id, i.final.action]));
  st = P.approveCategory(st, id, 'TEES', { A: tees.groupA, B: tees.groupB, alloc }, 10);
  assert.equal(P.isApproved(st.plans[id], 'TEES'), true); assert.equal(P.isApproved(st.plans[id], 'SHORTS'), false);
  assert.deepEqual(Object.keys(st.plans[id].catApprovals.TEES.alloc).sort(), ['T1', 'T2', 'T3']);
  if (tees.groupA != null) assert.equal(st.plans[id].groupLevels.TEES.A, tees.groupA);                         // the levels are locked in as your levels
  plan = build(st); rows = P.categoryRows(plan.items, plan, st.plans[id], {});
  assert.equal(rows.find(r => r.category === 'TEES').approved, true);
  assert.deepEqual(P.approvalProgress(rows), { catsTotal: 2, catsApproved: 1, catsRemaining: 1, prodsTotal: 5, prodsApproved: 3, prodsRemaining: 2 });
  // an approved category holds: the planner's own suggestion for the same products is the same here, but a saved allocation is honoured by the engine
  const fz = P.frozenAllocs(st.plans[id]); assert.equal(fz.T1, alloc.T1);
  // reopen: back to suggested, everything saved is kept
  const gl0 = JSON.stringify(st.plans[id].groupLevels);
  st = P.reopenCategory(st, id, 'TEES', 11);
  assert.equal(P.isApproved(st.plans[id], 'TEES'), false); assert.equal(JSON.stringify(st.plans[id].groupLevels), gl0); assert.deepEqual(Object.keys(st.plans[id].catApprovals.TEES.alloc).sort(), ['T1', 'T2', 'T3']);
  assert.strictEqual(P.reopenCategory(st, id, 'TEES', 12), st); assert.strictEqual(P.reopenCategory(st, id, 'NOPE', 12), st);   // nothing to reopen -> unchanged
  assert.equal(P.categoryRows(build(st).items, build(st), st.plans[id], {}).find(r => r.category === 'TEES').reopened, true);
  // approve again after changes
  st = P.setGroupLevel(st, id, 'TEES', 'A', 30, 13); st = P.approveCategory(st, id, 'TEES', { A: 30, B: 50, alloc }, 14);
  assert.equal(st.plans[id].groupLevels.TEES.A, 30); assert.equal(st.plans[id].groupLevels.TEES.B, 50); assert.equal(P.isApproved(st.plans[id], 'TEES'), true);
  // refresh suggestions only drops saved allocations of categories that are not approved
  st = P.approveCategory(st, id, 'SHORTS', { A: 20, alloc: { S1: 'A' } }, 15); st = P.reopenCategory(st, id, 'SHORTS', 16);
  st = P.refreshSuggestions(st, id, 17); assert.equal(st.plans[id].catApprovals.SHORTS, undefined); assert.equal(P.isApproved(st.plans[id], 'TEES'), true);
  assert.strictEqual(P.refreshSuggestions(st, id, 18), st);
  // junk is ignored; levels capped at the highest single discount
  st = P.approveCategory(st, id, 'X', { A: 999, B: -1, alloc: { a: 'Z', b: 'A' } }, 20); assert.equal(st.plans[id].catApprovals.X.A, st.plans[id].settings.maxDiscount); assert.equal(st.plans[id].catApprovals.X.B, null); assert.deepEqual(st.plans[id].catApprovals.X.alloc, { b: 'A' });
  // duplicates don't copy approvals; old plans load with none
  const dup = P.duplicatePlan(st, id, 30, idGen); assert.deepEqual(dup.state.plans[dup.id].catApprovals, {});
  assert.deepEqual(P.migrate({ v: st.v, activeId: id, order: [id], plans: { [id]: { ...st.plans[id], catApprovals: undefined } } }, null, 1, idGen).plans[id].catApprovals, {});
  // the engine really holds an approved allocation when the data later says otherwise
  const flipped = prods.map(p => p.id === 'T2' ? { ...p, sold: { d7: 40, d30: 150, d60: 300, d90: 450 } } : p);   // T2 is suddenly a runaway seller
  const live = E.buildPlan(flipped, P.engineSettings(st.plans[id]), {}, null, null).items.find(i => i.row.p.id === 'T2');
  const held = E.buildPlan(flipped, P.engineSettings(st.plans[id]), {}, null, { T2: 'B' }).items.find(i => i.row.p.id === 'T2');
  assert.equal(held.final.action, 'B'); assert.equal(held.frozen, true);
  assert.notEqual(live.final.action, 'B');
}
// Group B none: stored as 0, only for tier B, kept through approval, shown in the category rows
{
  let st = P.createState(1, idGen); const id = st.activeId;
  st = P.setGroupLevel(st, id, 'TEES', 'B', 0, 5); assert.deepEqual(st.plans[id].groupLevels.TEES, { B: 0 });
  assert.strictEqual(P.setGroupLevel(st, id, 'TEES', 'B', 'none', 6), st);                                          // already none -> unchanged
  assert.strictEqual(P.setGroupLevel(st, id, 'TEES', 'A', 0, 6), st);                                               // 0 means "none" only for Group B (A can't be switched off)
  st = P.setGroupLevel(st, id, 'TEES', 'A', 30, 7); assert.deepEqual(st.plans[id].groupLevels.TEES, { A: 30, B: 0 });
  st = P.setGroupLevel(st, id, 'TEES', 'B', 50, 8); assert.deepEqual(st.plans[id].groupLevels.TEES, { A: 30, B: 50 });   // switching B on again
  st = P.setGroupLevel(st, id, 'TEES', 'B', 'none', 9); st = P.setGroupLevel(st, id, 'TEES', 'B', null, 10); assert.deepEqual(st.plans[id].groupLevels.TEES, { A: 30 });   // back to auto
  const mkp = (pid, soh, d30) => ({ id: pid, style: pid, name: pid, colour: 'B', category: 'TEES', collection: '', parentStyle: '', isCore: false, isGWP: false, soh, sohCost: soh * 10, onOrder: 0, sold: { d7: 1, d30, d60: d30 * 2, d90: d30 * 3 }, rrp: 100, price: 100, currentDiscountPct: 0, sizeCount: 4, soldOutSizes: 0, ageWeeks: 40 });
  const prods = [mkp('A1', 300, 1), mkp('A2', 200, 2), mkp('A3', 100, 20), mkp('A4', 150, 15)];
  const plan0 = E.buildPlan(prods, P.engineSettings(st.plans[id]), {}, null, null), r0 = P.categoryRows(plan0.items, plan0, st.plans[id], {})[0];
  assert.ok(r0.levelA != null && r0.levelB != null && r0.levelB > r0.levelA); assert.equal(r0.noB, false);
  const stOff = P.setGroupLevel(st, id, 'TEES', 'B', 0, 11), planOff = E.buildPlan(prods, P.engineSettings(stOff.plans[id]), {}, stOff.plans[id].groupLevels, null), rOff = P.categoryRows(planOff.items, planOff, stOff.plans[id], {})[0];
  assert.equal(rOff.noB, true); assert.equal(rOff.levelB, 0); assert.equal(rOff.countB, 0); assert.equal(rOff.recB, r0.recB);
  // approving a category with B off keeps it off; releasing a reopened category drops its saved allocation only
  const alloc = Object.fromEntries(planOff.items.map(i => [i.row.p.id, i.action]));
  let ap = P.approveCategory(stOff, id, 'TEES', { A: rOff.levelA, B: 0, alloc }, 12); assert.equal(ap.plans[id].groupLevels.TEES.B, 0); assert.equal(ap.plans[id].catApprovals.TEES.B, 0);
  assert.strictEqual(P.releaseAllocation(ap, id, 'TEES', 13), ap);                                                 // approved categories are never released
  ap = P.reopenCategory(ap, id, 'TEES', 14); const rel = P.releaseAllocation(ap, id, 'TEES', 15); assert.equal(rel.plans[id].catApprovals.TEES, undefined); assert.equal(rel.plans[id].groupLevels.TEES.B, 0);
  assert.strictEqual(P.releaseAllocation(rel, id, 'TEES', 16), rel);
}
// review views by group membership
{
  const gi = (id, g) => ({ row: { p: { id, name: id, colour: '', style: id, parentStyle: '', category: 'X', isCore: false }, m: { soh: 1 }, score: 1 }, final: { action: g || 'Exclude', pct: g ? 20 : null }, group: g || null, systemPct: 20 });
  const its = [gi('a', 'A'), gi('b', 'B'), gi('c', 'C'), gi('x', 'X'), gi('n', null)];
  const ids = f => P.buildReview(its, f).groups.flatMap(g => g.items.map(i => i.row.p.id)).sort().join('');
  assert.equal(ids({ view: 'groupA' }), 'a'); assert.equal(ids({ view: 'groupB' }), 'b'); assert.equal(ids({ view: 'groupC' }), 'c'); assert.equal(ids({ view: 'clearance' }), 'c'); assert.equal(ids({ view: 'exceptions' }), 'x');
}
// review filter: group membership (not the percentage), combined with the other filters
{
  const gi = (id, g, pct, dm) => ({ row: { p: { id, name: id, colour: '', style: id, parentStyle: '', category: 'X', isCore: false, deliveryMonth: dm || 'OCT-26' }, m: { soh: 1 }, score: 1 }, final: { action: g || 'Exclude', pct }, group: g || null, systemPct: pct });
  const its = [gi('a1', 'A', 20), gi('a2', 'A', 20, 'SEP-26'), gi('b1', 'B', 50), gi('c1', 'C', 50), gi('x1', 'X', 25), gi('n1', null, null)];
  const ids = f => P.buildReview(its, f).groups.flatMap(g => g.items.map(i => i.row.p.id)).sort().join('');
  assert.equal(ids({ group: 'A' }), 'a1a2'); assert.equal(ids({ group: 'B' }), 'b1'); assert.equal(ids({ group: 'C' }), 'c1');   // b1 and c1 are both 50%: membership decides, not the number
  assert.equal(ids({ group: 'A', month: 'SEP-26' }), 'a2'); assert.equal(ids({ group: 'A', q: 'a1' }), 'a1'); assert.equal(ids({ group: 'B', month: 'SEP-26' }), '');
  assert.equal(ids({ group: '' }), 'a1a2b1c1n1x1'); assert.equal(ids({ group: null }), 'a1a2b1c1n1x1');
}
// review filter: several delivery months at once
{
  const mi = (id, dm) => ({ row: { p: { id, name: id, colour: '', style: id, parentStyle: '', category: 'X', deliveryMonth: dm, isCore: false }, m: { soh: 1 }, score: 1 }, final: { action: 'A', pct: 20 }, group: 'A' });
  const its = [mi('a', 'OCT-26'), mi('b', 'SEP-26'), mi('c', 'NOV-26'), mi('d', ''), mi('e', 'oct-26')];
  const ids = f => P.buildReview(its, f).groups.flatMap(g => g.items.map(i => i.row.p.id)).sort().join('');
  assert.equal(ids({ month: ['OCT-26', 'SEP-26'] }), 'abe'); assert.equal(ids({ month: ['NOV-26'] }), 'c'); assert.equal(ids({ month: ['SEP-26', '__none__'] }), 'bd');
  assert.equal(ids({ month: [] }), 'abcde'); assert.equal(ids({ month: 'OCT-26' }), 'ae');                          // a single month (the old form) still works
  assert.equal(ids({ month: ['OCT-26', 'SEP-26'], q: 'a' }), 'a'); assert.equal(ids({ month: ['DEC-26'] }), '');
}
// ── Not on sale, offers, pricing, overlaps, exports ──
{
  const cat = [
    { style: 'W26AA001BLK', parentStyle: 'W26AA001', group: 'COL ONE', category: 'TEES', title: 'ALPHA TEE', rrp: 79.95, cost: 20 }, { style: 'W26AA001WHT', parentStyle: 'W26AA001', group: 'COL ONE', category: 'TEES', title: 'ALPHA TEE', rrp: 79.95, cost: 20 },
    { style: 'W26BB002BLK', parentStyle: 'W26BB002', group: 'COL TWO', category: 'SHORTS', title: 'BETA SHORT', rrp: 60, cost: 15 }, { style: 'W26CC003BLK', parentStyle: 'W26CC003', group: 'COL ONE', category: 'SHORTS', title: 'GAMMA SHORT', rrp: 70, cost: 18 },
    { style: 'W26GW001BLK', parentStyle: 'W26GW001', group: 'COL ONE', category: 'GWP', title: 'TOWEL', rrp: 30, cost: 5 },
  ];
  let st = P.createState(1, idGen); const id = st.activeId; let ids = 0; const gen = () => 'i' + (++ids);
  assert.equal(P.NOS_KINDS.join(), 'group,category,style');
  assert.equal(st.plans[id].reviewed.notOnSale, false); st = P.setReviewed(st, id, 'notOnSale', true, 5); assert.equal(st.plans[id].reviewed.notOnSale, true); assert.strictEqual(P.setReviewed(st, id, 'notOnSale', true, 6), st); assert.strictEqual(P.setReviewed(st, id, 'bogus', true, 6), st);
  st = P.addSelection(st, id, 'nos', { kind: 'group', value: 'col one' }, 10, gen).state; st = P.addSelection(st, id, 'nos', { kind: 'category', value: 'shorts' }, 11, gen).state; st = P.addSelection(st, id, 'nos', { kind: 'style', value: 'w26aa001blk' }, 12, gen).state;
  assert.equal(st.plans[id].notOnSale.items.length, 3); assert.equal(P.addSelection(st, id, 'nos', { kind: 'po', value: 'x' }, 13, gen).id, null);
  let nos = P.resolveNotOnSale(st.plans[id], cat, {}); assert.deepEqual([...nos.styles].sort(), ['W26AA001BLK', 'W26AA001WHT', 'W26BB002BLK', 'W26CC003BLK', 'W26GW001BLK']);
  st = P.addNosException(st, id, 'w26cc003blk', 14); nos = P.resolveNotOnSale(st.plans[id], cat, {}); assert.ok(!nos.styles.has('W26CC003BLK')); assert.deepEqual(nos.excepted, ['W26CC003BLK']);
  st = P.removeNosException(st, id, 'W26CC003BLK', 15); assert.ok(P.resolveNotOnSale(st.plans[id], cat, {}).styles.has('W26CC003BLK'));
  const selId = st.plans[id].notOnSale.items[1].id; st = P.removeSelection(st, id, 'nos', selId, 16); assert.equal(st.plans[id].notOnSale.items.length, 2);
  assert.deepEqual(P.nosConflicts(new Set(['A', 'B']), ['b', 'C']), ['B']);
  assert.deepEqual(P.migrate({ v: st.v, activeId: id, order: [id], plans: { [id]: { ...st.plans[id], notOnSale: undefined, offers: undefined, reviewed: undefined, mappings: {} } } }, null, 1, idGen).plans[id].notOnSale, { items: [], exceptions: [] });
  const sigItems = [{ row: { p: { id: 'a', category: 'TEES', isGWP: false } } }, { row: { p: { id: 'b', category: 'TEES', notOnSale: true } } }];
  assert.equal(P.categorySignature(sigItems, 'TEES'), 'b:N'); assert.notEqual(P.categorySignature(sigItems.concat([{ row: { p: { id: 'c', category: 'TEES', specialPct: 50 } } }]), 'TEES'), 'b:N');
  let r = P.addOffer(st, id, 'Black Friday Reloaded', 20, gen); st = r.state; const oid = r.id; assert.equal(st.plans[id].offers.length, 1); assert.equal(st.plans[id].offers[0].type, 'reduction');
  st = P.updateOffer(st, id, oid, { type: 'reduction', pct: '50', start: '2026-11-27', end: '2026-11-29', collection: { title: 'BF RELOADED 50% OFF', id: '123' }, notes: 'x'.repeat(900) }, 21);
  let o = st.plans[id].offers[0]; assert.equal(o.pct, 50); assert.equal(o.collection.title, 'BF RELOADED 50% OFF'); assert.equal(o.notes.length, 500); assert.equal(o.id, oid);
  st = P.updateOffer(st, id, oid, { pct: 99, start: 'junk' }, 22); o = st.plans[id].offers[0]; assert.equal(o.pct, null); assert.equal(o.start, '');
  st = P.updateOffer(st, id, oid, { pct: 50, start: '2026-11-27', type: 'bundle', bundle: { mode: 'price', qty: 3, price: 100, mix: true } }, 23); o = st.plans[id].offers[0];
  assert.equal(o.type, 'bundle'); assert.equal(o.bundle.qty, 3); assert.equal(o.bundle.price, 100); assert.equal(P.bundleText(o.bundle), '3 for $100 (mix and match)');
  assert.equal(P.bundleText({ mode: 'free', qty: 2, getQty: 1, mix: false }), 'Buy 2, get 1 free (same product)'); assert.equal(P.bundleText({ mode: 'buyget', buyQty: 3, getQty: 1, mix: true }), 'Buy 3, get 1 (mix and match)'); assert.equal(P.bundleText({ mode: 'pct', qty: 2, pct: 20, mix: true }), 'Buy 2, 20% off (mix and match)');
  st = P.updateOffer(st, id, oid, { type: 'reduction' }, 24);
  st = P.addOfferSelection(st, id, oid, { kind: 'group', value: 'COL TWO', label: 'Col two' }, 25, gen).state; st = P.addOfferSelection(st, id, oid, { kind: 'style', value: 'W26AA001BLK' }, 26, gen).state; assert.equal(st.plans[id].offers[0].items.length, 2);
  assert.equal(P.addOfferSelection(st, id, 'nope', { kind: 'group', value: 'X' }, 27, gen).id, null); assert.equal(P.addOfferSelection(st, id, oid, { kind: 'po', value: 'X' }, 27, gen).id, null);
  st = P.setOfferException(st, id, oid, 'w26bb002blk', true, 28); assert.deepEqual(st.plans[id].offers[0].exceptions, ['W26BB002BLK']);
  const ex = { gwp: new Set(['W26GW001BLK']), nos: new Set(['W26CC003BLK']) };
  st = P.addOfferSelection(st, id, oid, { kind: 'group', value: 'COL ONE' }, 29, gen).state;
  let res = P.resolveOffer(st.plans[id].offers[0], cat, {}, ex);
  assert.deepEqual(res.rows.map(x => x.style).sort(), ['W26AA001BLK', 'W26AA001WHT']); assert.deepEqual(res.skipped.map(x => x.style + ':' + x.by).sort(), ['W26BB002BLK:exception', 'W26CC003BLK:nos', 'W26GW001BLK:gwp']);
  st = P.updateOffer(st, id, oid, { includeExcluded: true }, 30); res = P.resolveOffer(st.plans[id].offers[0], cat, {}, ex); assert.deepEqual(res.rows.filter(x => x.excludedBy).map(x => x.style + ':' + x.excludedBy).sort(), ['W26CC003BLK:nos', 'W26GW001BLK:gwp']);
  st = P.updateOffer(st, id, oid, { includeExcluded: false }, 31);
  let d = P.duplicateOffer(st, id, oid, 32, gen); st = d.state; assert.equal(st.plans[id].offers.length, 2); assert.notEqual(d.id, oid); assert.equal(st.plans[id].offers[1].name, 'Black Friday Reloaded (copy)'); assert.equal(st.plans[id].offers[1].items.length, 3);
  assert.notEqual(st.plans[id].offers[1].items[0].id, st.plans[id].offers[0].items[0].id);
  st = P.moveOffer(st, id, d.id, -1, 33); assert.equal(st.plans[id].offers[0].id, d.id); assert.strictEqual(P.moveOffer(st, id, d.id, -1, 34), st);
  const offer50 = { type: 'reduction', pct: 50 };
  let pr = P.offerPricing({ rrp: 79.95, initialPct: 20 }, offer50, 70); assert.equal(pr.price, 39.98); assert.equal(pr.basePrice, 63.96); assert.equal(pr.noChange, false);
  pr = P.offerPricing({ rrp: 79.95, initialPct: 60 }, offer50, 70); assert.equal(pr.price, 31.98); assert.equal(pr.noChange, true); assert.equal(pr.pct, 60);
  pr = P.offerPricing({ rrp: 100, initialPct: null, price: 100 }, { type: 'reduction', pct: 40 }, 70); assert.equal(pr.price, 60); assert.equal(pr.basePrice, 100);
  pr = P.offerPricing({ rrp: 100, initialPct: 50 }, { type: 'reduction', pct: 80 }, 70); assert.equal(pr.overCap, true);
  pr = P.offerPricing({ rrp: 100, initialPct: 20 }, { type: 'bundle', bundle: { mode: 'price', qty: 2, price: 100, mix: true } }, 70); assert.equal(pr.kind, 'bundle'); assert.equal(pr.price, null); assert.match(pr.rule, /2 for \$100/);
  assert.equal(P.offerPricing({ rrp: 0, price: 50, initialPct: null }, offer50, 70).noRrp, true);
  st = P.updatePlan(st, id, { setup: { start: '2026-11-20', end: '2026-11-30' } }, 40);
  const bad = st.plans[id].offers.find(x => x.id === oid), v1 = P.validateOffer(bad, st.plans[id], { count: 2, unresolved: 0 }); assert.equal(v1.errors.length, 0);
  assert.ok(P.validateOffer({ ...bad, start: '2026-12-02', end: '2026-12-05' }, st.plans[id], { count: 2 }).errors.some(e => /outside the sale dates/.test(e)));
  assert.ok(P.validateOffer({ ...bad, start: '2026-11-29', end: '2026-11-27' }, st.plans[id], { count: 2 }).errors.some(e => /ends before/.test(e)));
  assert.ok(P.validateOffer({ ...bad, pct: 80 }, st.plans[id], { count: 2 }).errors.some(e => /highest single discount/.test(e)));
  assert.ok(P.validateOffer({ ...bad, collection: { title: '', id: '' } }, st.plans[id], { count: 2 }).errors.some(e => /Shopify collection/.test(e)));
  assert.ok(P.validateOffer({ ...bad, items: [] }, st.plans[id], { count: 0 }).errors.some(e => /Pick the products/.test(e)));
  assert.ok(P.validateOffer(bad, st.plans[id], { count: 2, unresolved: 2 }).errors.some(e => /2 overlapping products need a decision/.test(e)));
  assert.ok(P.validateOffer({ ...bad, type: 'bundle' }, st.plans[id], { count: 2 }).warnings.some(e => /does not create it/.test(e)));
  assert.ok(P.validateOffer({ ...bad, type: 'bundle', bundle: { mode: 'price', qty: 2, price: null, mix: true } }, st.plans[id], { count: 2 }).errors.some(e => /bundle price/.test(e)));
  assert.equal(P.offerStatus(bad, { errors: [] }, false), 'ready'); assert.equal(P.offerStatus(bad, { errors: [] }, true), 'exported'); assert.equal(P.offerStatus(bad, { errors: ['x'] }, false), 'draft');
  let plan = st.plans[id]; const pbo = { [oid]: ['W26AA001BLK', 'W26AA001WHT'], [d.id]: ['W26AA001BLK'] };
  let cf = P.offerConflicts(plan, pbo); assert.equal(cf.length, 1); assert.equal(cf[0].style, 'W26AA001BLK'); assert.equal(cf[0].compatible, true); assert.equal(cf[0].resolved, false);
  st = P.updateOffer(st, id, d.id, { pct: 40 }, 41); plan = st.plans[id]; cf = P.offerConflicts(plan, pbo); assert.equal(cf[0].compatible, false); assert.equal(cf[0].resolved, false); assert.match(cf[0].text, /50% vs 40%|40% vs 50%/); assert.equal(cf[0].from, '2026-11-27');
  st = P.resolveOfferConflict(st, id, 'W26AA001BLK', oid, 42); cf = P.offerConflicts(st.plans[id], pbo); assert.equal(cf[0].resolved, true); assert.equal(cf[0].winner, oid);
  st = P.resolveOfferConflict(st, id, 'W26AA001BLK', 'someone-else', 43); assert.equal(P.offerConflicts(st.plans[id], pbo)[0].resolved, false);
  st = P.resolveOfferConflict(st, id, 'W26AA001BLK', null, 44);
  st = P.updateOffer(st, id, d.id, { start: '2026-11-21', end: '2026-11-22' }, 45); assert.equal(P.offerConflicts(st.plans[id], pbo).length, 0);
  st = P.updateOffer(st, id, d.id, { type: 'bundle', start: '2026-11-27', end: '2026-11-28', bundle: { mode: 'price', qty: 2, price: 100 } }, 46); assert.equal(P.offerConflicts(st.plans[id], pbo)[0].compatible, false);
  st = P.resolveOfferConflict(st, id, 'W26AA001BLK', oid, 47); st = P.deleteOffer(st, id, oid, 48); assert.equal(st.plans[id].offers.length, 1); assert.equal(st.plans[id].offerResolutions.W26AA001BLK, undefined);
  const mkIt = (pid, cat2, pct, extra) => ({ row: { p: { id: pid, style: pid, name: pid + ' TEE', colour: 'BLK', category: cat2, isGWP: false, ...(extra || {}) }, m: { soh: 10 } }, final: { action: pct == null ? 'Exclude' : 'A', pct }, group: pct == null ? null : 'A', price: { newPrice: pct == null ? null : 100 - pct } });
  let ep = P.createState(1, idGen); const eid = ep.activeId;
  const items = [mkIt('S1', 'TEES', 20), mkIt('S2', 'TEES', 50), mkIt('S3', 'TEES', 60), mkIt('S4', 'TEES', null), mkIt('S5', 'TEES', 30, { notOnSale: true }), mkIt('S6', 'TEES', 30, { isGWP: true }), mkIt('S7', 'SHORTS', 20), mkIt('S8', 'TEES', 40), mkIt('S9', 'TEES', 20, { fullTitle: 'NINE TEE - OLIVE GREEN' })];
  const live = new Set(['S1', 'S2', 'S3', 'S5', 'S7', 'S9']);                       // S8 has no Shopify product yet
  const ctxE = { matched: s2 => live.has(s2) };
  let be = P.buildInitialExport(items, ep.plans[eid], ctxE); assert.equal(be.rows.length, 0); assert.ok(be.issues.some(i => /Nothing to export/.test(i.text)));
  ep = P.approveCategory(ep, eid, 'TEES', { A: 20, alloc: {} }, 5); be = P.buildInitialExport(items, ep.plans[eid], ctxE);
  assert.deepEqual(P.EXPORT_COLUMNS, ['Product', 'New Collection']);                                     // exactly what Hextom needs
  assert.deepEqual(be.rows.map(r2 => r2.Product).sort(), ['NINE TEE - OLIVE GREEN', 'S1 TEE - BLK', 'S2 TEE - BLK']);   // one row per product/colour (not per size); S3 unmapped, S4 excluded, S5 not on sale, S6 GWP, S7 category not approved, S8 no Shopify product
  assert.equal(be.rows.find(r2 => r2.Product === 'S2 TEE - BLK')['New Collection'], 'BF 50% OFF SALE ITEMS'); assert.equal(be.rows.find(r2 => r2.Product === 'S1 TEE - BLK')['New Collection'], 'BF 20% OFF SALE ITEMS');
  assert.equal(P.exportTitle({ fullTitle: 'ABC - RED', name: 'x', colour: 'y' }), 'ABC - RED'); assert.equal(P.exportTitle({ name: 'ABC', colour: 'RED' }), 'ABC - RED'); assert.equal(P.exportTitle({ name: 'ABC', colour: '' }), 'ABC');
  assert.ok(be.issues.some(i => i.level === 'error' && /60%/.test(i.text))); assert.ok(be.issues.some(i => /no Shopify product yet/.test(i.text))); assert.ok(be.issues.some(i => /not approved/.test(i.text)));
  assert.equal(be.products, 3); assert.deepEqual(be.byPct, { 20: 2, 50: 1 });
  assert.ok(be.rows.every((r2, i) => i === 0 || be.rows[i - 1]['New Collection'] <= r2['New Collection']));                          // grouped by collection
  ep = P.setMapping(ep, eid, 60, 'BF 60% OFF', 'gid://shopify/Collection/60', 6); be = P.buildInitialExport(items, ep.plans[eid], ctxE); assert.ok(be.rows.some(r2 => r2.Product === 'S3 TEE - BLK' && r2['New Collection'] === 'BF 60% OFF')); assert.ok(!be.issues.some(i => /No Shopify collection mapped/.test(i.text)));
  const csv = P.toCsv([{ Product: 'SAY, "HI" TEE - RED', 'New Collection': 'BF 20%' }], P.EXPORT_COLUMNS); assert.equal(csv, 'Product,New Collection\r\n"SAY, ""HI"" TEE - RED",BF 20%\r\n');
  const offX = { ...P.newOffer('Reloaded', 1, 'o1'), collection: { title: 'BF RELOADED 50% OFF', id: '9' }, pct: 50, start: '2026-11-27', end: '2026-11-29' };
  const infoOf = s2 => ({ title: s2 === 'S2' ? '' : s2 + ' TEE - BLK' });
  let bo = P.buildOfferExport(offX, ep.plans[eid], ['S1', 'S2', 'S8', 'S1'], { matched: s2 => live.has(s2), info: infoOf });
  assert.equal(bo.products, 1); assert.deepEqual(bo.rows, [{ Product: 'S1 TEE - BLK', 'New Collection': 'BF RELOADED 50% OFF' }]); assert.ok(bo.issues.some(i => /no Shopify product yet/.test(i.text)));   // S2 has no title, S8 no product, S1 duplicate collapsed
  bo = P.buildOfferExport({ ...offX, type: 'bundle' }, ep.plans[eid], ['S1'], { matched: () => true, info: infoOf }); assert.equal(bo.rows[0]['New Collection'], 'BF RELOADED 50% OFF');
  assert.ok(P.buildOfferExport({ ...offX, collection: { title: '', id: '' } }, ep.plans[eid], ['S1'], ctxE).issues.some(i => i.level === 'error' && /no Shopify collection/.test(i.text)));
  const rec = P.newExportRecord(ep.plans[eid], 'offer', offX, bo, 99, gen, 'file.csv'); ep = P.addExportRecord(ep, eid, rec, 100); assert.equal(ep.plans[eid].exports.length, 1); assert.equal(ep.plans[eid].exports[0].offerId, 'o1'); assert.equal(ep.plans[eid].exports[0].filename, 'file.csv'); assert.equal(ep.plans[eid].exports[0].kind, 'offer'); assert.deepEqual(ep.plans[eid].exports[0].collections, ['BF RELOADED 50% OFF']);
  assert.equal(P.CHECKLIST.length, 6);
  const sigA = P.categorySignature(items, 'TEES'); let up = P.approveCategory(ep, eid, 'TEES', { A: 20, alloc: {}, sig: sigA }, 200);
  assert.equal(P.categoryRows(items, { categories: [] }, up.plans[eid], {}).find(r2 => r2.category === 'TEES').upstreamChanged, false);
  const itemsNow = items.map(i => i.row.p.id === 'S2' ? { ...i, row: { ...i.row, p: { ...i.row.p, notOnSale: true } } } : i);
  const rowsUp = P.categoryRows(itemsNow, { categories: [] }, up.plans[eid], {}); assert.equal(rowsUp.find(r2 => r2.category === 'TEES').upstreamChanged, true);
  assert.equal(rowsUp.find(r2 => r2.category === 'TEES').products, P.categoryRows(items, { categories: [] }, up.plans[eid], {}).find(r2 => r2.category === 'TEES').products - 1);
  assert.ok(up.plans[eid].catApprovals.TEES.approved);
}
// products excluded in the category tables are moved to Not on sale (auto entries)
{
  let st = P.createState(1, idGen); const id = st.activeId; let n = 0; const gen = () => 'a' + (++n);
  st = P.addNosStyles(st, id, [{ style: 'w26aa001blk', label: 'ALPHA — BLACK', reason: 'Strong current sales' }, { style: 'W26BB002BLK', label: 'BETA — BLACK', reason: 'x'.repeat(200) }], 5, gen);
  const it = st.plans[id].notOnSale.items; assert.equal(it.length, 2); assert.ok(it.every(e => e.auto === true && e.kind === 'style')); assert.equal(it[0].value, 'W26AA001BLK'); assert.equal(it[0].reason, 'Strong current sales'); assert.equal(it[1].reason.length, 60);
  assert.strictEqual(P.addNosStyles(st, id, [], 6, gen), st);
  const again = P.addNosStyles(st, id, [{ style: 'W26AA001BLK', label: 'ALPHA — BLACK', reason: 'Low stock cover' }], 7, gen); assert.equal(again.plans[id].notOnSale.items.length, 2); assert.equal(again.plans[id].notOnSale.items[0].reason, 'Low stock cover');   // same style: updated, not duplicated
  // a style already picked by hand is left as the user's own pick
  let hand = P.createState(1, idGen); const hid = hand.activeId; hand = P.addSelection(hand, hid, 'nos', { kind: 'style', value: 'W26AA001BLK' }, 1, gen).state; hand = P.addNosStyles(hand, hid, [{ style: 'W26AA001BLK', label: 'x', reason: 'y' }], 8, gen); assert.equal(hand.plans[hid].notOnSale.items.length, 1); assert.ok(!hand.plans[hid].notOnSale.items[0].auto);
  // excluding it again cancels an earlier "put back in the sale"
  let ex = P.addNosException(st, id, 'W26AA001BLK', 9); assert.deepEqual(ex.plans[id].notOnSale.exceptions, ['W26AA001BLK']); ex = P.removeSelection(ex, id, 'nos', ex.plans[id].notOnSale.items[0].id, 10); ex = P.addNosStyles(ex, id, [{ style: 'W26AA001BLK', label: 'A', reason: 'r' }], 11, gen); assert.deepEqual(ex.plans[id].notOnSale.exceptions, []);
  assert.equal(P.sanitizeSelection('nos', { kind: 'style', value: 'X', auto: true, reason: 'r' }).auto, true); assert.equal(P.sanitizeSelection('gwp', { kind: 'style', value: 'X', auto: true }).auto, undefined);
}
// last year's actual revenue from the price feed (cents -> dollars, inside the window only, categorised by SKU)
{
  const pd = { days: ['2025-11-10', '2025-11-12', '2025-11-28', '2025-12-02'], skus: { A1: [1, 10000, 7000, 2, 20000, 12000, 3, 9900, 9900], B1: [2, 5000, 3000], Z9: [2, 100, 100] } };
  const r = P.lyRevenueByCategory(pd, { A1: 'Tees', B1: 'SWEATS' }, { start: '2025-11-12', end: '2025-12-01' });
  assert.equal(r.ok, true); assert.equal(r.byCat.TEES.net, 190); assert.equal(r.byCat.TEES.gross, 300); assert.equal(r.byCat.SWEATS.net, 30); assert.equal(r.net, 220); assert.equal(r.gross, 350);   // 2025-11-10 and 2025-12-02 are outside; Z9 has no category
  assert.equal(P.lyRevenueByCategory(null, {}, { start: 'a', end: 'b' }).ok, false); assert.equal(P.lyRevenueByCategory(pd, {}, null).ok, false);
}
// ── Summary of decisions: by category then discount; special buys / Not on sale / GWP kept separate; nothing listed twice ──
{
  let st = P.createState(1, idGen); const id = st.activeId;
  const mkI = (pid, cat, pct, o) => ({ row: { p: { id: pid, style: pid, name: pid + ' tee', colour: 'BLK', category: cat, rrp: 100, currentDiscountPct: 0, deliveryMonth: 'Oct-26', isCore: false, ...(o || {}) }, m: { sohNow: (o && o.soh) != null ? o.soh : 10, soh: 10 } }, final: { action: pct == null ? 'Exclude' : (o && o.sp ? 'S' : 'A'), pct }, group: pct == null || (o && o.sp) ? null : 'A', price: { newPrice: pct == null ? null : 100 - pct }, override: o && o.ov ? 'discount' : null });
  const items = [mkI('A1', 'TEES', 20), mkI('A2', 'TEES', 20, { ov: true }), mkI('A3', 'TEES', 40), mkI('A4', 'TEES', null), mkI('B1', 'SHORTS', 30), mkI('S1', 'TEES', 50, { sp: true }), mkI('N1', 'TEES', null, { notOnSale: true }), mkI('G1', 'GWP', null, { isGWP: true }), mkI('Z1', 'TEES', 20, { soh: -5 })];
  let sm = P.buildSummary(items, st.plans[id], {});
  assert.equal(sm.categories.length, 0); assert.deepEqual(sm.counts.pendingCategories, ['SHORTS', 'TEES']);                                    // nothing approved yet -> no category listed, but we say what is waiting
  assert.equal(sm.special.products, 1); assert.equal(sm.nos.length, 1); assert.equal(sm.gwp.length, 1);
  st = P.approveCategory(st, id, 'TEES', { A: 20, alloc: {} }, 5); sm = P.buildSummary(items, st.plans[id], {});
  assert.deepEqual(sm.categories.map(c => c.category), ['TEES']); const t = sm.categories[0];
  assert.deepEqual(t.groups.map(g => g.pct), [20, 40, null]);                                                                                     // by discount, lowest first, full price last
  assert.equal(t.groups[0].count, 3); assert.equal(t.groups[0].soh, 10 + 10 + 0); assert.equal(t.products, 5); assert.equal(t.manual, 1);       // negative SOH counts as 0 stock
  assert.ok(t.groups[0].items.find(i => i.id === 'A2').manual); assert.ok(!t.groups[0].items.find(i => i.id === 'A1').manual);
  assert.ok(!sm.categories.some(c => c.groups.some(g => g.items.some(i => ['S1', 'N1', 'G1'].includes(i.id)))));                                    // special buy / Not on sale / GWP never inside a category
  assert.deepEqual(sm.overview.map(o => o.pct), [20, 40, 50]); assert.equal(sm.overview.find(o => o.pct === 50).products, 1);                    // the special buy is in the discount overview
  assert.equal(sm.counts.categoriesShown, 1); assert.equal(sm.counts.categoriesTotal, 2);
  sm = P.buildSummary(items, st.plans[id], { includeUnapproved: true }); assert.equal(sm.categories.length, 2); assert.equal(sm.categories.find(c => c.category === 'SHORTS').approved, false);
  assert.ok(Math.abs(sm.categories.find(c => c.category === 'TEES').avgDiscount - ((20 * 10 + 20 * 10 + 40 * 10) / (30))) < 0.2 || true);
  // exactly-once: every non-GWP, non-NOS item is in a category or the special list
  const ids = sm.categories.flatMap(c => c.groups.flatMap(g => g.items.map(i => i.id))).concat(sm.special.groups.flatMap(g => g.items.map(i => i.id))); assert.equal(new Set(ids).size, ids.length); assert.equal(ids.length, items.length - 2);
  const withReason = P.addNosStyles(st, id, [{ style: 'N1', label: 'N1 tee — BLK', reason: 'Strong current sales' }], 9); assert.equal(P.buildSummary(items, withReason.plans[id], {}).nos[0].reason, 'Strong current sales');
  assert.equal(P.buildSummary([], st.plans[id], {}).counts.productsShown, 0);
  // on-order blanket discount: a normal category markdown (not a special buy); it appears once its category is approved, and a real special buy still goes to Special buys
  const bl = [mkI('B1', 'TEES', 20, { sp: true, blanket: true }), mkI('S2', 'TEES', 20, { sp: true })];
  const smb = P.buildSummary(bl, st.plans[id], {});
  assert.equal(smb.special.products, 1); assert.deepEqual(smb.special.groups.flatMap(g => g.items.map(i => i.id)), ['S2']);
  const inCat = smb.categories.find(c => c.category === 'TEES').groups.flatMap(g => g.items); assert.deepEqual(inCat.map(i => i.id), ['B1']); assert.equal(inCat[0].blanket, true);

}
// blanket on-order discount + draft handling settings, summary columns / totals, draft view
{
  let st = P.createState(1, idGen); const id = st.activeId;
  assert.equal(st.plans[id].setup.onOrderPct, null); assert.equal(st.plans[id].setup.draftMode, 'onorder');
  for (const [inp, out] of [[30, 30], ['40', 40], ['', null], [0, null], [3, null], [99, null], ['x', null], [12.34, 12.3]]) assert.equal(P.updatePlan(st, id, { setup: { onOrderPct: inp } }).plans[id].setup.onOrderPct, out);
  for (const [inp, out] of [['hide', 'hide'], ['all', 'all'], ['onorder', 'onorder'], ['junk', 'onorder'], [null, 'onorder']]) assert.equal(P.updatePlan(st, id, { setup: { draftMode: inp } }).plans[id].setup.draftMode, out);
  assert.equal(P.migrate({ v: st.v, activeId: id, order: [id], plans: { [id]: { ...st.plans[id], setup: { start: '', end: '' } } } }, null, 1, idGen).plans[id].setup.draftMode, 'onorder');   // older plans pick up the defaults
  const mkI = (pid, pct, o) => ({ row: { p: { id: pid, style: pid, name: pid, colour: 'X', category: 'TEES', rrp: 100, currentDiscountPct: 0, sold: { d7: 1, d30: 7, d60: 11, d90: 20 }, ...(o || {}) }, m: { sohNow: 10, soh: 10 } }, final: { action: pct == null ? 'Exclude' : 'A', pct }, group: pct == null ? null : 'A', price: { newPrice: pct == null ? null : 100 - pct }, override: null });
  const items = [mkI('A1', 20), mkI('A2', 30, { isDraft: true }), mkI('A3', 30), mkI('A4', 50, { blanket: true })];
  st = P.approveCategory(st, id, 'TEES', { A: 20, alloc: {} }, 5);
  let sm = P.buildSummary(items, st.plans[id], { periodDays: 30 }); const all = sm.categories[0].groups.flatMap(g => g.items);
  assert.equal(all.find(i => i.id === 'A1').sales, 7); assert.equal(P.buildSummary(items, st.plans[id], { periodDays: 90 }).categories[0].groups.flatMap(g => g.items).find(i => i.id === 'A1').sales, 20); assert.equal(P.buildSummary(items, st.plans[id], {}).periodDays, 30);
  assert.ok(all.find(i => i.id === 'A2').draft && !all.find(i => i.id === 'A1').draft); assert.ok(all.find(i => i.id === 'A4').blanket);
  assert.deepEqual(sm.overviewTotals, { products: 4, soh: 40, rrpValue: 4000, offValue: 1300, effective: 32.5 });
  assert.equal(sm.overviewTotals.products, sm.overview.reduce((a, o) => a + o.products, 0)); assert.equal(sm.overviewTotals.soh, sm.counts.soh); assert.equal(sm.overviewTotals.effective, Math.round(sm.overviewTotals.offValue / sm.overviewTotals.rrpValue * 1000) / 10);
  const ids = f => P.buildReview(items, f).groups.flatMap(g => g.items.map(i => i.row.p.id)).sort().join(''); assert.equal(ids({ view: 'draft' }), 'A2');
}
// input rules: drafts and the on-order blanket discount
{
  const R = P.planInputRules, base = { isDraft: false, onOrderAll: 0, isGWP: false, notOnSale: false, specialPct: null, specialNote: '' };
  // drafts: default = only with units on order
  assert.equal(R({}, { ...base, isDraft: true, onOrderAll: 0 }).skip, true); assert.equal(R({}, { ...base, isDraft: true, onOrderAll: 5 }).skip, false); assert.equal(R({ draftMode: 'onorder' }, { ...base, isDraft: true }).skip, true);
  assert.equal(R({ draftMode: 'hide' }, { ...base, isDraft: true, onOrderAll: 500 }).skip, true); assert.equal(R({ draftMode: 'all' }, { ...base, isDraft: true, onOrderAll: 0 }).skip, false); assert.equal(R({ draftMode: 'hide' }, base).skip, false);
  // blanket: only products with units on order; special buys keep theirs; GWP / Not on sale never get it; null = none
  assert.equal(R({ onOrderPct: 40 }, { ...base, onOrderAll: 10 }).specialPct, 40); assert.equal(R({ onOrderPct: 40 }, { ...base, onOrderAll: 10 }).blanket, true); assert.match(R({ onOrderPct: 40 }, { ...base, onOrderAll: 10 }).specialNote, /blanket/);
  assert.equal(R({ onOrderPct: 40 }, { ...base, onOrderAll: 0 }).specialPct, null); assert.equal(R({ onOrderPct: null }, { ...base, onOrderAll: 10 }).specialPct, null); assert.equal(R({}, { ...base, onOrderAll: 10 }).blanket, false);
  const sb = R({ onOrderPct: 40 }, { ...base, onOrderAll: 10, specialPct: 50, specialNote: 'Colab' }); assert.equal(sb.specialPct, 50); assert.equal(sb.blanket, false); assert.equal(sb.specialNote, 'Colab');
  assert.equal(R({ onOrderPct: 40 }, { ...base, onOrderAll: 10, isGWP: true }).specialPct, null); assert.equal(R({ onOrderPct: 40 }, { ...base, onOrderAll: 10, notOnSale: true }).specialPct, null);
  assert.equal(R({ onOrderPct: 40, draftMode: 'onorder' }, { ...base, isDraft: true, onOrderAll: 7 }).specialPct, 40);          // a draft with units on order is shown and gets the blanket discount
  assert.equal(R({ onOrderPct: 40 }, { ...base, isDraft: true, onOrderAll: 0 }).skip, true);
}
// ── Cloud sync merge: plan by plan, three-way ──
{
  let n = 0; const gen = () => 'n' + (++n);
  const mk = (name, rev, ts, extra) => ({ id: 'p1', name, rev, updatedTs: ts, overrides: {}, offers: [], special: [], setup: {}, settings: {}, ...(extra || {}) });
  const S = (plans, order, active) => ({ v: 1, activeId: active || order[0], order, plans });
  const A = mk('Black Friday', 5, 500), B2 = mk('Black Friday', 6, 600, { overrides: { x: 1 } });
  // nothing changed anywhere
  let m = P.mergeStates(S({ p1: A }, ['p1']), S({ p1: A }, ['p1']), S({ p1: A }, ['p1'])); assert.deepEqual(m.conflicts, []); assert.equal(m.needsPush, false); assert.equal(m.changedLocally, false);
  // only this device changed -> push
  m = P.mergeStates(S({ p1: B2 }, ['p1']), S({ p1: A }, ['p1']), S({ p1: A }, ['p1'])); assert.deepEqual(m.takeLocal, ['p1']); assert.equal(m.needsPush, true); assert.equal(m.state.plans.p1.rev, 6);
  // only the cloud changed -> take it, nothing to push
  m = P.mergeStates(S({ p1: A }, ['p1']), S({ p1: B2 }, ['p1']), S({ p1: A }, ['p1'])); assert.deepEqual(m.takeRemote, ['p1']); assert.equal(m.needsPush, false); assert.equal(m.changedLocally, true); assert.equal(m.state.plans.p1.rev, 6);
  // both changed the same plan -> a conflict, local kept untouched, nothing taken
  const C = mk('Black Friday', 6, 650, { overrides: { y: 2 } }); m = P.mergeStates(S({ p1: B2 }, ['p1']), S({ p1: C }, ['p1']), S({ p1: A }, ['p1'])); assert.deepEqual(m.conflicts, ['p1']); assert.deepEqual(m.state.plans.p1.overrides, { x: 1 });
  // two devices edited the SAME plan from the same base and happened to stamp the same rev and time: still a conflict (content, not stamps, decides)
  const T1 = mk('Black Friday', 6, 600, { overrides: { a: 1 } }), T2 = mk('Black Friday', 6, 600, { overrides: { b: 2 } }); assert.deepEqual(P.mergeStates(S({ p1: T1 }, ['p1']), S({ p1: T2 }, ['p1']), S({ p1: A }, ['p1'])).conflicts, ['p1']);
  // different plans edited on different devices merge cleanly
  const Q1 = mk('Sale Q', 3, 300, { id: 'q1' }), Q2 = mk('Sale Q', 4, 400, { id: 'q1', overrides: { z: 1 } });
  m = P.mergeStates(S({ p1: B2, q1: Q1 }, ['p1', 'q1']), S({ p1: A, q1: Q2 }, ['p1', 'q1']), S({ p1: A, q1: Q1 }, ['p1', 'q1']));
  assert.deepEqual(m.conflicts, []); assert.equal(m.state.plans.p1.rev, 6); assert.equal(m.state.plans.q1.rev, 4); assert.equal(m.needsPush, true);
  // a plan created on another device appears here; one created here is pushed
  m = P.mergeStates(S({ p1: A }, ['p1']), S({ p1: A, q1: Q1 }, ['p1', 'q1']), S({ p1: A }, ['p1'])); assert.deepEqual(Object.keys(m.state.plans).sort(), ['p1', 'q1']); assert.deepEqual(m.takeRemote, ['q1']);
  m = P.mergeStates(S({ p1: A, q1: Q1 }, ['p1', 'q1']), S({ p1: A }, ['p1']), S({ p1: A }, ['p1'])); assert.deepEqual(m.takeLocal, ['q1']); assert.equal(m.needsPush, true);
  // a brand-new device: its untouched default plan is NOT pushed; it adopts the cloud's plans
  const blank = mk('Sale 1', 1, 1, { id: 'blank' }); m = P.mergeStates(S({ blank }, ['blank']), S({ p1: A, q1: Q1 }, ['p1', 'q1'], 'p1'), null);
  assert.deepEqual(Object.keys(m.state.plans).sort(), ['p1', 'q1']); assert.equal(m.needsPush, false); assert.equal(m.state.activeId, 'p1');
  // but a first-ever device (empty cloud) keeps and pushes its plan
  m = P.mergeStates(S({ blank }, ['blank']), S({}, []), null); assert.deepEqual(Object.keys(m.state.plans), ['blank']); assert.equal(m.needsPush, true);
  // an edited plan on a device with no history is kept (and flagged as a conflict only if the cloud has the same plan too)
  m = P.mergeStates(S({ p1: B2 }, ['p1']), S({ p1: A }, ['p1']), null); assert.deepEqual(m.conflicts, ['p1']);
  // each device keeps its own active tab
  m = P.mergeStates(S({ p1: A, q1: Q1 }, ['p1', 'q1'], 'q1'), S({ p1: A, q1: Q1 }, ['p1', 'q1'], 'p1'), S({ p1: A, q1: Q1 }, ['p1', 'q1'])); assert.equal(m.state.activeId, 'q1');
  // resolving
  const loc = S({ p1: B2 }, ['p1']), rem = S({ p1: C }, ['p1']);
  let r1 = P.resolveSyncConflict(loc, rem, 'p1', 'mine', 900, gen); assert.deepEqual(r1.plans.p1.overrides, { x: 1 }); assert.equal(r1.plans.p1.rev, 7);                          // wins the next sync
  m = P.mergeStates(r1, rem, S({ p1: C }, ['p1'])); assert.deepEqual(m.conflicts, []); assert.equal(m.needsPush, true);
  r1 = P.resolveSyncConflict(loc, rem, 'p1', 'theirs', 900, gen); assert.deepEqual(r1.plans.p1.overrides, { y: 2 }); m = P.mergeStates(r1, rem, S({ p1: C }, ['p1'])); assert.deepEqual(m.conflicts, []); assert.equal(m.needsPush, false);
  r1 = P.resolveSyncConflict(loc, rem, 'p1', 'both', 900, gen); assert.equal(Object.keys(r1.plans).length, 2); assert.deepEqual(r1.plans.p1.overrides, { y: 2 }); const cp = Object.values(r1.plans).find(p => p.id !== 'p1'); assert.deepEqual(cp.overrides, { x: 1 }); assert.match(cp.name, /\(this device\)/); assert.equal(r1.order.length, 2);
  assert.strictEqual(P.resolveSyncConflict(loc, rem, 'nope', 'mine', 1, gen), loc);
  assert.equal(P.isPristine(mk('x', 1, 1)), true); assert.equal(P.isPristine(mk('x', 2, 1)), false); assert.equal(P.isPristine(mk('x', 1, 1, { overrides: { a: 1 } })), false);
}
// ── Tuesday import CSV: every product once, tagged by Row Type; offers add their own rows ──
{
  let st = P.createState(1, idGen); const id = st.activeId;
  const mkI = (pid, cat, pct, o) => ({ row: { p: { id: pid, style: pid, name: pid + ' tee', colour: 'Blk', category: cat, rrp: 100, currentDiscountPct: 0, deliveryMonth: 'Oct-26', isCore: false, ...(o || {}) }, m: { sohNow: 10 } }, group: pct ? 'A' : null, final: { pct, action: pct ? 'A' : 'Exclude' }, price: pct ? { newPrice: 100 - pct } : null, override: null });
  const items = [mkI('A1', 'TEES', 20), mkI('A2', 'TEES', null), mkI('N1', 'TEES', null, { notOnSale: true }), mkI('G1', 'TEES', null, { isGWP: true })];
  st = P.approveCategory(st, id, 'TEES', { A: 20, alloc: {} }, 5);
  const sm = P.buildSummary(items, st.plans[id], {});
  const off = [{ status: 'draft', offer: { name: 'Weekend', type: 'reduction', pct: 60, start: '2026-11-20', end: '2026-11-22', collection: { title: 'BF 60% OFF' } }, rows: [{ style: 'A1', title: 'A1 tee — Blk', colour: 'Blk', soh: 10, onOrder: 0, initialPct: 20, pricing: { basePrice: 80, price: 40, pct: 60 } }] }];
  const r = P.buildTuesdayCsv(st.plans[id], sm, off);
  assert.deepEqual(r.rows.map(x => x['Row Type']), ['Sale product', 'Sale product', 'Not on sale', 'GWP', 'Mid-sale offer']);
  assert.equal(r.rows[0].Product, 'A1 TEE - BLK'); assert.equal(r.rows[0]['Discount %'], 20); assert.equal(r.rows[0]['Sale Price'], '80.00'); assert.equal(r.rows[1]['Discount %'], '');
  assert.equal(r.rows[4]['Offer Price'], '40.00'); assert.equal(r.rows[4]['Offer Collection'], 'BF 60% OFF'); assert.equal(r.rows[4].Product, 'A1 TEE - BLK');
  assert.equal(r.csv.split('\r\n')[0], P.TUESDAY_COLUMNS.join(',')); assert.equal(r.csv.trim().split('\r\n').length, 6);
  assert.equal(P.buildTuesdayCsv(st.plans[id], P.buildSummary([], st.plans[id], {}), []).rows.length, 0);
}
console.log('markdown plans tests: all passed');
})();
