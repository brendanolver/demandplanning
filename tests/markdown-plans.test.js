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
let w = P.validatePlan(P.updatePlan(cp, cid, { settings: { avgDiscountCap: 10 } }).plans[cid]).warnings; assert.ok(w.some(x => /below your lowest discount level/.test(x)));
w = P.validatePlan(P.updatePlan(cp, cid, { settings: { avgDiscountCap: 60 } }).plans[cid]).warnings; assert.ok(w.some(x => /can never limit anything/.test(x)));
w = P.validatePlan(P.updatePlan(cp, cid, { settings: { avgDiscountCap: 35 } }).plans[cid]).warnings; assert.ok(!w.some(x => /average cap/.test(x)));
// cap and scope are rules, so a Duplicate copies them
let capped = P.updatePlan(cp, cid, { settings: { avgDiscountCap: 35, scope: 'all' } }); const cd = P.duplicatePlan(capped, cid, 5, idGen);
assert.equal(cd.state.plans[cd.id].settings.avgDiscountCap, 35); assert.equal(cd.state.plans[cd.id].settings.scope, 'all');
// older saved plans (no cap/scope keys) pick up the defaults on load
const old = JSON.parse(JSON.stringify(cp)); delete old.plans[cid].settings.avgDiscountCap; delete old.plans[cid].settings.scope;
const mig = P.migrate(old, null, 1, idGen).plans[cid].settings; assert.equal(mig.avgDiscountCap, null); assert.equal(mig.scope, 'recommended');
console.log('markdown plans tests: all passed');
})();
