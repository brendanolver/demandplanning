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
assert.deepEqual(dp.overrides, {}); assert.deepEqual(dp.mappings, {}); assert.deepEqual(dp.exports, []); assert.equal(dp.rev, 1); assert.notEqual(d.id, bfId);
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
const rplan = E.buildPlan(rp, { maxDiscount: 70 }, { W26BB002BLK: { exclude: true, reason: 'Other' }, W26CC003GRY: { pct: 40, kind: 'approved' } });
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

// approval status: approved = any saved decision; not approved = the planner's suggestion only (GWP can't be approved)
assert.deepEqual(P.sanitizeOverride({ exclude: true, confirm: true, reason: 'x' }), { exclude: true, confirm: true });
const apOv = { W26AA001BLK: { pct: 30, kind: 'approved' }, W26BB002BLK: { exclude: true, confirm: true }, W26CC003GRY: { pct: 40, kind: 'discount' } };
const apPlan = E.buildPlan(rp, { maxDiscount: 70 }, apOv);
assert.deepEqual(P.buildReview(apPlan.items, { approval: 'approved', flat: true }).groups.map(g => g.key).sort(), ['id:W26AA001BLK', 'id:W26BB002BLK', 'id:W26CC003GRY']);
assert.equal(P.buildReview(apPlan.items, { approval: 'pending', flat: true }).count, 3);
assert.equal(P.buildReview(apPlan.items, { approval: 'approved' }).count + P.buildReview(apPlan.items, { approval: 'pending' }).count, 6);          // every product is approved or not, never both
assert.equal(P.buildReview(apPlan.items, { approval: 'all' }).count, 6); assert.equal(P.buildReview(apPlan.items, {}).count, 6);
assert.equal(P.buildReview(apPlan.items, { approval: 'pending', category: 'TEES', flat: true }).count, 3);                                           // combines with the other filters
const gwApprove = E.buildPlan(rp.map(r => (r.id === 'NOPARENT' ? { ...r, isGWP: true } : r)), { maxDiscount: 70 });
assert.equal(P.buildReview(gwApprove.items, { approval: 'pending' }).groups.some(g => g.items.some(i => i.row.p.id === 'NOPARENT')), false);       // GWP never appears as "waiting for approval"
assert.deepEqual(P.overrideStats({ overrides: { A: { exclude: true, confirm: true }, B: { pct: 20, kind: 'approved' }, C: { exclude: true, reason: 'Other' } } }), { total: 3, exclude: 1, discount: 0, approved: 2, group: 0, stale: 0 });

assert.deepEqual(P.buildReview([], {}).groups, []);
// ── Special buys & GWP selections ───────────────────────────────────────────
let sp = P.createState(1, idGen), spid = sp.activeId;
assert.deepEqual(sp.plans[spid].special, []); assert.deepEqual(sp.plans[spid].gwp, { items: [], threshold: null, qty: {} });
assert.deepEqual(P.sanitizeSelection('special', { kind: 'group', value: '  2026 - BF EXCLUSIVE ', pct: 50 }), { kind: 'group', value: '2026 - BF EXCLUSIVE', pct: 50 });
for (const bad of [null, {}, { kind: 'group', value: '' }, { kind: 'nope', value: 'x', pct: 50 }, { kind: 'group', value: 'x' }, { kind: 'group', value: 'x', pct: 0 }, { kind: 'group', value: 'x', pct: 99 }, { kind: 'category', value: 'GWP', pct: 50 }]) assert.equal(P.sanitizeSelection('special', bad), null);
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
console.log('markdown plans tests: all passed');
})();
