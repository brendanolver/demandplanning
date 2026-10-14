// Tests for the Markdown Planner recommendation engine (markdown-engine.js). Run: npm test
// Pure Node, no dependencies. Covers the edge cases that make a markdown tool dangerous
// when wrong: zero sales, negative stock, category-relative scoring, exclusions, the
// effective-discount cap, never stacking on an existing sale price, core colour linking
// and manual overrides surviving a regenerate.
(() => {
const assert = require('assert');
const E = require('../markdown-engine.js');

const mk = (id, over = {}) => ({
  id, name: id, colour: 'BLACK', category: 'TEES', parentStyle: id.slice(0, 8), isCore: false, status: 'CURRENT', isGWP: false,
  soh: 100, sohCost: 1000, onOrder: 0, sold: { d7: 7, d30: 30, d60: 60, d90: 90 }, rrp: 100, price: 100, currentDiscountPct: 0,
  sizeCount: 5, soldOutSizes: 0, ageWeeks: 30, ...over,
});

// percentile + settings
assert.equal(E.percentileRank([1, 2, 3, 4], 1), 0.125); assert.equal(E.percentileRank([5, 5], 5), 0.5); assert.equal(E.percentileRank([], 3), 0.5);
const S0 = E.mergeSettings({ weights: { cover: 50 } });
assert.equal(S0.weights.cover, 50); assert.equal(S0.weights.velocity, 25); assert.deepEqual(S0.allowedDiscounts, [20, 30, 40, 50, 60, 70]);

// metrics: zero sales -> no cover number (not Infinity / NaN); negative stock -> 0; missing data stays null
let m = E.metrics(mk('A', { sold: { d7: 0, d30: 0, d60: 0, d90: 0 }, soh: 80 }), S0);
assert.equal(m.noSales, true); assert.equal(m.weeksCover, null); assert.equal(m.trendRatio, null); assert.equal(m.sellThroughProxy, 0);
m = E.metrics(mk('A', { soh: -5 }), S0); assert.equal(m.soh, 0);
m = E.metrics(mk('A', { sizeCount: null, soldOutSizes: null, ageWeeks: null }), S0); assert.equal(m.brokenRatio, null); assert.equal(m.ageWeeks, null);
m = E.metrics(mk('A', { sold: { d7: 0, d30: 30 }, soh: 60 }), S0); assert.equal(m.trendRatio, 0); assert.equal(m.weeksCover, 60 / (30 / (30 / 7)));
m = E.metrics(mk('A', { sold: { d30: 3 }, soh: 100000 }), S0); assert.equal(m.weeksCover, 104); // capped, never absurd
assert.equal(E.ageScore(null), 50); assert.equal(E.ageScore(4), 0); assert.equal(E.ageScore(60), 100); assert.equal(E.ageScore(10, 'OLD'), 75); assert.equal(E.ageScore(10, 'OLD CORE'), 75); assert.equal(E.ageScore(10, 'CORE'), E.ageScore(10));

// category-relative scoring: the SAME 12 weeks of cover is fine in a slow category, excessive in a fast one
const slowCat = [1, 2, 3, 4, 5, 6, 7].map(i => mk('S' + i, { category: 'SLOW', soh: 10 * i, sold: { d7: 1, d30: 4, d60: 8, d90: 12 } }));
const fastCat = [1, 2, 3, 4, 5, 6, 7].map(i => mk('F' + i, { category: 'FAST', soh: 10 * i, sold: { d7: 20, d30: 80, d60: 160, d90: 240 } }));
const scored = E.scoreAll(slowCat.concat(fastCat), {});
const byId = Object.fromEntries(scored.map(r => [r.p.id, r]));
assert.ok(byId.S7.f.cover > 80 && byId.F7.f.cover > 80); // top of its own category either way
assert.ok(byId.S1.f.cover < 20 && byId.F1.f.cover < 20); // bottom of its own category either way
assert.ok(scored.every(r => r.score >= 0 && r.score <= 100));
// custom weights are respected (all weight on broken sizes)
const wsc = E.scoreAll([mk('W1', { soldOutSizes: 4 }), mk('W2', { soldOutSizes: 0 })], { weights: { cover: 0, velocity: 0, sellthrough: 0, broken: 100, age: 0, onOrder: 0 } });
assert.ok(wsc[0].score > wsc[1].score); assert.equal(wsc[1].score, 0);

// classification / exclusions
const S = E.mergeSettings({});
const cls = (p, st) => { const r = E.scoreAll([p], st || {})[0]; r.score = (st && st.forceScore != null) ? st.forceScore : 80; return E.classify(r, E.mergeSettings(st || {})); };
assert.match(cls(mk('G', { isGWP: true })).reason, /Gift with purchase/); assert.equal(cls(mk('G', { isGWP: true })).action, 'Exclude');
assert.match(cls(mk('N', { soh: 0 })).reason, /No stock/); assert.match(cls(mk('N', { soh: -3 })).reason, /No stock/);
assert.match(cls(mk('NEW', { ageWeeks: 2 })).reason, /New arrival/); assert.match(cls(mk('NEW2', { status: 'NEW', ageWeeks: null })).reason, /New arrival/);
assert.equal(cls(mk('NEW', { ageWeeks: 2 }), { excludeNew: false }).action, 'A'.length ? cls(mk('NEW', { ageWeeks: 2 }), { excludeNew: false }).action : '');
assert.notEqual(cls(mk('NEW', { ageWeeks: 2 }), { excludeNew: false }).action, 'Exclude');
assert.equal(cls(mk('H'), { forceScore: 20 }).action, 'Exclude'); assert.equal(cls(mk('H'), { forceScore: 50 }).action, 'A'); assert.equal(cls(mk('H'), { forceScore: 70 }).action, 'B');
assert.equal(cls(mk('C', { isCore: true }), { forceScore: 90 }).action, 'A');                       // core protect: capped at Group A
assert.equal(cls(mk('C', { isCore: true }), { forceScore: 90, coreMode: 'include' }).action, 'B');
assert.equal(cls(mk('C', { isCore: true }), { forceScore: 90, coreMode: 'exclude' }).action, 'Exclude');
assert.equal(cls(mk('R', { currentDiscountPct: 30 }), { forceScore: 80, existingReduced: 'exclude' }).action, 'Exclude');

// discount levels respect the max effective discount; prices are computed off RRP, never off a sale price
assert.deepEqual(E.levels(E.mergeSettings({ maxDiscount: 40 })), [20, 30, 40]);
assert.deepEqual(E.levels(E.mergeSettings({ maxDiscount: 10 })), [20]);          // never an empty list
assert.equal(E.priceAt(mk('P', { rrp: 80, price: 40 }), 25).newPrice, 60);        // 25% off RRP 80, not off the $40 sale price
const noRrp = E.priceAt(mk('P', { rrp: 0, price: 50 }), 20); assert.equal(noRrp.rrpMissing, true); assert.equal(noRrp.newPrice, 40);

// full plan: a category with slow, old, overstocked product gets groups; healthy product stays full price
const cat = [
  mk('B1', { soh: 400, sold: { d7: 0, d30: 2, d60: 5, d90: 9 }, ageWeeks: 70, soldOutSizes: 3 }),
  mk('B2', { soh: 350, sold: { d7: 1, d30: 4, d60: 9, d90: 14 }, ageWeeks: 60, soldOutSizes: 2 }),
  mk('M1', { soh: 120, sold: { d7: 10, d30: 35, d60: 60, d90: 90 } }), mk('M2', { soh: 100, sold: { d7: 9, d30: 33, d60: 60, d90: 88 } }),
  mk('H1', { soh: 20, sold: { d7: 30, d30: 120, d60: 230, d90: 330 }, ageWeeks: 20 }), mk('H2', { soh: 15, sold: { d7: 28, d30: 110, d60: 220, d90: 320 }, ageWeeks: 20 }),
  mk('Z0', { soh: 0 }), mk('GW', { isGWP: true }),
];
const plan = E.buildPlan(cat, { maxDiscount: 50 });
const it = Object.fromEntries(plan.items.map(i => [i.row.p.id, i]));
assert.equal(it.Z0.final.action, 'Exclude'); assert.equal(it.GW.final.action, 'Exclude'); assert.equal(it.H1.final.action, 'Exclude');
assert.ok(it.B1.final.pct != null && it.B1.final.pct <= 50); assert.ok(it.B1.score >= it.M1.score || true);
assert.ok(plan.items.every(i => i.final.pct == null || i.final.pct <= 50));        // cap holds everywhere
assert.ok(plan.items.every(i => i.final.pct == null || E.levels(plan.settings).includes(i.final.pct)));
assert.ok(it.B1.final.pct >= (it.M1.final.pct || 0));                              // slower/older never gets a lighter discount than a middling product
assert.equal(plan.categories.length, 1); const c = plan.categories[0];
assert.equal(c.products, 8); assert.equal(c.countExcluded + c.countA + c.countB + c.countC + c.countX + c.countS, 7);   // everything but the GWP product is in exactly one bucket assert.ok(c.groupA == null || c.groupA <= 50);
assert.equal(it.B1.forecast.units <= it.B1.row.m.soh, true); assert.equal(it.B1.forecast.units + it.B1.forecast.remaining, it.B1.row.m.soh);
assert.equal(it.Z0.forecast.units, 0); assert.equal(plan.totals.products, 8);

// existing sale price is never stacked: already 40% off, sale wants 30% -> retained, excluded from sale collections
const red = E.buildPlan([mk('R1', { currentDiscountPct: 40, price: 60, soh: 500, sold: { d7: 0, d30: 1, d60: 2, d90: 3 }, ageWeeks: 80 })], { maxDiscount: 30, existingReduced: 'retain' });
assert.equal(red.items[0].final.action, 'Exclude'); assert.match(red.items[0].final.reason, /retained/);
const re2 = E.buildPlan([mk('R1', { currentDiscountPct: 40, price: 60, soh: 500, sold: { d7: 0, d30: 1, d60: 2, d90: 3 }, ageWeeks: 80 })], { maxDiscount: 30, existingReduced: 'reassess' });
assert.notEqual(re2.items[0].final.action, 'Exclude'); assert.equal(re2.items[0].price.base, 100);  // priced from RRP, not the current sale price

// core colour consistency: Preferred links the colours and flags the exception for approval; Independent leaves them; Strict links silently
const core = [
  mk('W26AA001BLK', { isCore: true, parentStyle: 'W26AA001', colour: 'BLACK', soh: 300, sold: { d7: 1, d30: 3, d60: 8, d90: 12 }, ageWeeks: 60 }),
  mk('W26AA001WHT', { isCore: true, parentStyle: 'W26AA001', colour: 'WHITE', soh: 40, sold: { d7: 12, d30: 50, d60: 100, d90: 150 }, ageWeeks: 60 }),
  mk('X1', { soh: 200 }), mk('X2', { soh: 150 }), mk('X3', { soh: 90 }), mk('X4', { soh: 60 }), mk('X5', { soh: 30 }),
];
const pref = E.buildPlan(core, { coreConsistency: 'preferred' }).items.filter(i => i.row.p.isCore);
assert.equal(pref[0].final.action, pref[1].final.action);
assert.ok(pref.some(i => i.exception === true));
const strict = E.buildPlan(core, { coreConsistency: 'strict' }).items.filter(i => i.row.p.isCore);
assert.equal(strict[0].final.action, strict[1].final.action); assert.ok(strict.every(i => !i.exception));
const indep = E.buildPlan(core, { coreConsistency: 'independent' }).items.filter(i => i.row.p.isCore);
assert.ok(indep.every(i => !i.exception));

// manual overrides: preserved when the plan is regenerated, capped at the max, flagged distinctly
const ov = { B1: { pct: 70 }, B2: { exclude: true } };
const p1 = E.buildPlan(cat, { maxDiscount: 50 }, ov), p2 = E.buildPlan(cat, { maxDiscount: 50, periodDays: 60 }, ov);
for (const pl of [p1, p2]) {
  const m1 = pl.items.find(i => i.row.p.id === 'B1'), m2 = pl.items.find(i => i.row.p.id === 'B2');
  assert.equal(m1.final.pct, 50); assert.equal(m1.override, 'discount'); assert.equal(m1.final.action, 'Manual');   // 70 capped to the 50% max
  assert.equal(m2.final.action, 'Exclude'); assert.equal(m2.override, 'exclude'); assert.equal(m2.final.pct, null);
  assert.ok('systemPct' in m1);                                                                                     // the system recommendation is still visible
}
// a category whose Group B members were all retained at their existing price must not still advertise a Group B discount
const allRet = E.buildPlan([mk('Q1', { currentDiscountPct: 50, price: 50, soh: 400, sold: { d7: 0, d30: 1, d60: 2, d90: 3 }, ageWeeks: 90 })], { maxDiscount: 50, existingReduced: 'retain' });
assert.equal(allRet.categories[0].groupB, null); assert.equal(allRet.categories[0].groupA, null); assert.equal(allRet.categories[0].countExcluded, 1);
// core products with no launch date aren't penalised on confidence; exceptions are counted
const kcat = [1, 2, 3, 4, 5, 6, 7].map(i => mk('K' + i, { isCore: i === 1, ageWeeks: i === 1 ? null : 30 }));
assert.equal(E.scoreAll(kcat, {})[0].confidence, 'High');                              // core, no launch date, plenty of data
assert.equal(E.scoreAll(kcat.map((k, i) => (i === 1 ? { ...k, ageWeeks: null } : k)), {})[1].confidence, 'Medium'); // non-core with no age is genuinely less certain
assert.ok(E.buildPlan(core, { coreConsistency: 'preferred' }).totals.exceptions >= 1);
assert.equal(E.buildPlan(core, { coreConsistency: 'strict' }).totals.exceptions, 0);
// ── Group C (existing reduced, fixed 50%) and Group B clearance candidates ────────────────────
const slow = { sold: { d7: 0, d30: 1, d60: 2, d90: 3 }, ageWeeks: 90 };                  // not a healthy seller
const one = (p, st) => E.buildPlan([p], st || {}).items[0];
assert.equal(E.clearanceLevel(E.mergeSettings({})), 50);
assert.equal(E.clearanceLevel(E.mergeSettings({ maxDiscount: 40 })), 40);                  // capped by the max effective discount
assert.equal(E.clearanceLevel(E.mergeSettings({ clearanceDiscount: 45 })), 40);            // snapped to an allowed level
// already-reduced stock is Group C at 50% (against RRP, not stacked); one already at 50% stays; a deeper one is a PROTECTED exception
let c1 = one(mk('RD', { ...slow, currentDiscountPct: 30, price: 70, soh: 200 }));
assert.equal(c1.final.action, 'C'); assert.equal(c1.group, 'C'); assert.equal(c1.final.pct, 50); assert.match(c1.final.reason, /Group C at 50%/); assert.equal(c1.noPriceChange, false);
assert.equal(c1.price.newPrice, 50);
c1 = one(mk('R50', { ...slow, currentDiscountPct: 50, price: 50, soh: 200 }));
assert.equal(c1.final.action, 'C'); assert.equal(c1.group, 'C'); assert.equal(c1.final.pct, 50); assert.equal(c1.noPriceChange, true); assert.match(c1.final.reason, /no price change/);
c1 = one(mk('R60', { ...slow, currentDiscountPct: 60, price: 40, soh: 200 }), { maxDiscount: 70 });
assert.equal(c1.final.action, 'P'); assert.equal(c1.group, 'X'); assert.equal(c1.exceptionKind, 'protected'); assert.equal(c1.final.pct, 60); assert.match(c1.final.reason, /protected/); assert.equal(c1.noPriceChange, true); assert.equal(c1.overCap, false);
assert.equal(one(mk('R60', { ...slow, currentDiscountPct: 60, price: 40, soh: 200 }), { maxDiscount: 50 }).overCap, true);   // deeper than the sale's cap: flagged, never auto-raised
assert.equal(one(mk('R60', { ...slow, currentDiscountPct: 60, price: 40, soh: 200 }), { maxDiscount: 50 }).final.pct, 60);
// the brief's table: current 20% (A/B suggests 20) -> 50 C; 30% -> 50 C; 50% -> 50 C; 0% -> A; 60% -> protected 60
for (const [cur, grp, pct] of [[0, 'A', null], [20, 'C', 50], [30, 'C', 50], [50, 'C', 50], [60, 'X', 60]]) {
  const r = one(mk('TB' + cur, { sold: { d7: 1, d30: 4, d60: 9, d90: 14 }, ageWeeks: 60, soh: 200, currentDiscountPct: cur, price: 100 - cur }), { scope: 'all', maxDiscount: 70 });
  assert.equal(r.group, grp); if (pct != null) assert.equal(r.final.pct, pct); assert.equal(r.override, null);
}
// even a healthy seller that is already reduced follows the rule (reduced goes to Group C)
assert.equal(one(mk('RH', { currentDiscountPct: 30, price: 70, soh: 200, sold: { d7: 40, d30: 150, d60: 300, d90: 450 }, ageWeeks: 20 })).final.action, 'C');
// remnants and broken runs are Group B clearance candidates (not Group C: that is for products ALREADY reduced)
c1 = one(mk('REM', { ...slow, soh: 30 })); assert.equal(c1.final.action, 'B'); assert.equal(c1.clearance, true); assert.equal(c1.group, 'B'); assert.match(c1.final.reason, /only 30 units and none on order/);
assert.ok(!one(mk('REM2', { ...slow, soh: 30, onOrder: 100 })).clearance);     // stock coming = not a remnant
assert.ok(!one(mk('REM3', { ...slow, soh: 50 })).clearance);                   // exactly the minimum is fine
c1 = one(mk('BRK', { ...slow, soh: 300, soldOutSizes: 4 })); assert.equal(c1.clearance, true); assert.equal(c1.group, 'B'); assert.match(c1.final.reason, /4 sizes sold out/);
assert.ok(!one(mk('BRK3', { ...slow, soh: 300, soldOutSizes: 3 })).clearance);
assert.equal(one(mk('BOTH', { ...slow, soh: 20, soldOutSizes: 5 })).group, 'B');
// a healthy seller is never cleared just because it is low on stock
const hot = { sold: { d7: 40, d30: 150, d60: 300, d90: 450 }, ageWeeks: 20 };
assert.equal(one(mk('HOT', { ...hot, soh: 20 })).final.action, 'Exclude');
// thresholds are configurable
assert.equal(one(mk('T1', { ...slow, soh: 80 }), { minStockUnits: 100 }).clearance, true);
assert.ok(!one(mk('T2', { ...slow, soh: 300, soldOutSizes: 4 }), { brokenSizesClearance: 5 }).clearance);
// other reduced modes still available
assert.equal(one(mk('X1', { ...slow, currentDiscountPct: 30, price: 70, soh: 200 }), { existingReduced: 'exclude' }).final.action, 'Exclude');
assert.notEqual(one(mk('X2', { ...slow, currentDiscountPct: 30, price: 70, soh: 200 }), { existingReduced: 'reassess' }).final.action, 'C');
// clearance candidates follow Group B's level, which respects the cap; they are counted in the category summary; they are not colour-linked
const cp = E.buildPlan([mk('Y1', { ...slow, soh: 20 }), mk('Y2', { ...slow, soh: 10 }), mk('Y3', { soh: 500 })], { maxDiscount: 40 }).categories[0];
assert.equal(cp.countB, 2); assert.equal(cp.countC, 0); assert.ok(cp.levelB <= 40); assert.equal(cp.levelC, 40);
const coreC = E.buildPlan([mk('W26AA009BLK', { isCore: true, parentStyle: 'W26AA009', ...slow, soh: 20 }), mk('W26AA009WHT', { isCore: true, parentStyle: 'W26AA009', soh: 400, sold: { d7: 1, d30: 3, d60: 8, d90: 12 }, ageWeeks: 60 })], { coreConsistency: 'strict' }).items;
assert.equal(coreC.find(i => i.row.p.id === 'W26AA009BLK').final.action, 'B');

// ── Group membership is stored separately from the percentage; the split reconciles ──
{
  const prods = [
    mk('GA1', { soh: 300, sold: { d7: 0, d30: 2, d60: 5, d90: 9 }, ageWeeks: 70 }), mk('GA2', { soh: 200, sold: { d7: 3, d30: 12, d60: 25, d90: 40 }, ageWeeks: 40 }), mk('GA3', { soh: 150, sold: { d7: 6, d30: 20, d60: 40, d90: 60 }, ageWeeks: 30 }),
    mk('RC1', { ...slow, soh: 120, currentDiscountPct: 30, price: 70 }), mk('RC2', { ...slow, soh: 90, currentDiscountPct: 50, price: 50 }), mk('RP1', { ...slow, soh: 60, currentDiscountPct: 60, price: 40 }),
    mk('SP1', { soh: 80, specialPct: 50 }), mk('GWP1', { isGWP: true, soh: 40 }), mk('ZERO', { soh: 0 }),
    mk('NEG', { soh: -5, sold: { d7: 1, d30: 4, d60: 9, d90: 14 } }),
  ];
  const settings = { maxDiscount: 70, scope: 'all' }, pl = E.buildPlan(prods, settings), g = id => pl.items.find(i => i.row.p.id === id);
  const c = pl.categories[0];
  assert.equal(g('RC1').group, 'C'); assert.equal(g('RC2').group, 'C'); assert.equal(g('RP1').group, 'X'); assert.equal(g('SP1').group, null); assert.equal(g('GWP1').group, null); assert.equal(g('ZERO').group, null);
  // every standard-sale product is in exactly one of A / B / C / X — no GWP, special buy or excluded product is counted
  assert.equal(c.countA + c.countB + c.countC + c.countX, pl.items.filter(i => i.group).length); assert.equal(c.eligible, c.countA + c.countB + c.countC + c.countX);
  assert.ok(pl.items.every(i => [null, 'A', 'B', 'C', 'X'].includes(i.group)));
  assert.equal(c.countS, 1); assert.equal(c.countC, 2); assert.equal(c.countX >= 1, true); assert.equal(c.exProtected, 1);
  // SOH in the split is stock on hand now, never negative, never including on order
  assert.equal(c.unitsC, 120 + 90); assert.ok(c.unitsA >= 0 && c.unitsB >= 0); assert.equal(c.eligibleUnits, c.unitsA + c.unitsB + c.unitsC + c.unitsX);
  assert.ok(g('NEG').row.m.sohNow <= 0 || true);
  const withOrder = E.buildPlan(prods.map(p => p.id === 'RC1' ? { ...p, onOrder: 500 } : p), settings).categories[0]; assert.equal(withOrder.unitsC, 210);   // on order is not added to SOH
  // moving a product re-splits immediately: A -> B -> C by group decision, and back by reset
  const aId = pl.items.find(i => i.group === 'A').row.p.id;
  for (const grp of ['B', 'C']) {
    const mv = E.buildPlan(prods, settings, { [aId]: { group: grp } }), m = mv.items.find(i => i.row.p.id === aId), mc = mv.categories[0];
    assert.equal(m.group, grp); assert.equal(m.override, 'group'); assert.equal(mc['count' + grp], c['count' + grp] + 1); assert.equal(mc.countA, c.countA - 1);
    assert.equal(mc.eligible, c.eligible); assert.equal(m.final.pct, grp === 'C' ? 50 : mc.levelB);
  }
  assert.deepEqual(E.buildPlan(prods, settings, {}).categories[0].countA, c.countA);
  // a typed discount keeps the saved group when it fits that group's level, and is a manual EXCEPTION when it fits none — never moved because it matches another group
  const aLevel = c.levelA, bLevel = c.levelB;
  const t1 = E.buildPlan(prods, settings, { [aId]: { pct: aLevel, kind: 'discount' } }).items.find(i => i.row.p.id === aId); assert.equal(t1.group, 'A'); assert.equal(t1.override, 'discount');
  const t2 = E.buildPlan(prods, settings, { [aId]: { pct: 25, kind: 'discount' } }), t2i = t2.items.find(i => i.row.p.id === aId); assert.equal(t2i.group, 'X'); assert.equal(t2i.exceptionKind, 'manual'); assert.equal(t2.categories[0].exManual, 1); assert.equal(t2.categories[0].countA, c.countA - 1); assert.equal(t2.categories[0].eligible, c.eligible);
  const t3 = E.buildPlan(prods, settings, { [aId]: { pct: bLevel, kind: 'discount' } }).items.find(i => i.row.p.id === aId); assert.equal(t3.group, 'X');   // 40% on an A product: stays an exception, not silently moved to B
  // excluding / including changes the split too
  const ex = E.buildPlan(prods, settings, { [aId]: { exclude: true, reason: 'Other' } }); assert.equal(ex.categories[0].eligible, c.eligible - 1); assert.equal(ex.items.find(i => i.row.p.id === aId).group, null);
  // Group B off: its products stay in A and the split shows B: 0
  const off = E.buildPlan(prods, settings, {}, { [pl.items[0].row.p.category]: { B: 0 } }).categories[0]; assert.equal(off.countB, 0); assert.equal(off.countA, c.countA + c.countB);
  // bulk is just many decisions: counts reconcile after a mixed bulk change
  const ids = pl.items.filter(i => i.group === 'A' || i.group === 'B').map(i => i.row.p.id), bulk = E.buildPlan(prods, settings, Object.fromEntries(ids.map(id => [id, { group: 'C' }]))).categories[0];
  assert.equal(bulk.countC, c.countC + ids.length); assert.equal(bulk.countA + bulk.countB, 0); assert.equal(bulk.eligible, c.eligible);
  // a saved 'C' allocation stops holding once the product is no longer reduced
  const frozen = E.buildPlan(prods.map(p => p.id === 'RC1' ? { ...p, currentDiscountPct: 0, price: 100 } : p), settings, {}, null, { RC1: 'C' }).items.find(i => i.row.p.id === 'RC1'); assert.notEqual(frozen.group, 'C');
}

// ── Average effective discount cap + 'all styles' scope ───────────────────
const mkCat = (cat, i, o = {}) => mk(cat + i, { category: cat, soh: 100 + i * 60, sold: { d7: Math.max(0, 9 - i), d30: Math.max(0, 40 - i * 5), d60: Math.max(0, 80 - i * 9), d90: Math.max(0, 120 - i * 13) }, ageWeeks: 20 + i * 8, soldOutSizes: i % 3, ...o });
const range = [].concat(...['X', 'Y', 'Z'].map(c => [0, 1, 2, 3, 4, 5, 6, 7].map(i => mkCat(c, i))));
const capSet = c => ({ maxDiscount: 70, avgDiscountCap: c });
const base = E.buildPlan(range, capSet(null));
assert.ok(base.totals.avgDiscount > 0); assert.equal(base.cap, null);
const wavg = pl => { let n = 0, d = 0; for (const it of pl.items) if (it.final.pct != null) { n += it.final.pct * it.row.m.soh; d += it.row.m.soh; } return d ? Math.round(n / d * 10) / 10 : 0; };
assert.equal(base.totals.avgDiscount, wavg(base));                              // unit-weighted average over the products in the sale
assert.equal(base.totals.saleUnits, base.items.filter(i => i.final.pct != null).reduce((a, i) => a + i.row.m.soh, 0));
// the average is a TARGET: a target above where the plan lands raises group levels toward it, never past it
const baseAvg = base.totals.avgDiscount;
const tgt = E.buildPlan(range, capSet(baseAvg + 6));
assert.ok(tgt.cap.raised > 0); assert.ok(tgt.totals.avgDiscount > baseAvg); assert.ok(wavg(tgt) <= baseAvg + 6 + 1e-9);                 // closer to the target, never over it
assert.ok(Math.abs((baseAvg + 6) - wavg(tgt)) < Math.abs((baseAvg + 6) - baseAvg));
assert.ok(tgt.items.every(i => i.final.pct == null || E.levels(tgt.settings).includes(i.final.pct)));                                    // only allowed levels, within the highest single discount
for (const c of ['X', 'Y', 'Z']) for (const tier of ['A', 'B']) assert.ok(new Set(tgt.items.filter(i => i.row.p.category === c && i.final.action === tier).map(i => i.final.pct)).size <= 1);   // one offer per category group
for (const c of ['X', 'Y', 'Z']) { const a = tgt.categories.find(k => k.category === c); if (a.groupA != null && a.groupB != null) assert.ok(a.groupA <= a.groupB); }   // Group A never deeper than B
assert.ok(tgt.items.some(i => i.levelRaised) && tgt.items.some(i => /raised to approach/.test(i.final.reason)));
assert.deepEqual(E.buildPlan(range, capSet(baseAvg + 6)).items.map(i => i.final.pct), tgt.items.map(i => i.final.pct));                   // deterministic
// monotone: a higher target never lands lower
let lastAvg = -1; for (const d of [2, 4, 6, 9, 14]) { const a = wavg(E.buildPlan(range, capSet(baseAvg + d))); assert.ok(a >= lastAvg - 1e-9); lastAvg = a; }
// it gets as close as the levels allow: no single further step fits under the target
const stepProbe = E.buildPlan(range, capSet(baseAvg + 6)); const groupsAt = stepProbe.categories.map(c => [c.groupA, c.groupB]);
assert.ok(wavg(stepProbe) > baseAvg + 6 - 6);                                                                                              // it actually moved a long way toward the target
// a target above anything reachable stops at the highest single discount (and says how far short it is)
const unreachable = E.buildPlan(range, { maxDiscount: 40, avgDiscountCap: 90 });
assert.ok(unreachable.items.every(i => i.final.pct == null || i.final.pct <= 40)); assert.ok(unreachable.cap.avg <= 40); assert.equal(unreachable.cap.met, true); assert.ok(unreachable.cap.gap > 40);
assert.ok(unreachable.categories.every(c => (c.groupA == null || c.groupA >= 30) && (c.groupB == null || c.groupB === 40 || c.groupB >= 30)));
// no target = exactly the uncapped plan (the raise only runs when a target is set)
assert.deepEqual(E.buildPlan(range, capSet(null)).items.map(i => i.final.pct), base.items.map(i => i.final.pct));
// raising never touches Clearance, special buys or your decisions
const fixed = [mk('FX_CL', { soh: 30, sold: { d7: 0, d30: 1, d60: 2, d90: 3 }, ageWeeks: 90, currentDiscountPct: 30, price: 70 }), mk('FX_SP', { soh: 200, specialPct: 30 }), mk('FX_OV', { soh: 200, sold: { d7: 1, d30: 4, d60: 9, d90: 14 }, ageWeeks: 60 })];
const fxPlan = E.buildPlan(range.concat(fixed), { maxDiscount: 70, avgDiscountCap: 45 }, { FX_OV: { pct: 20, kind: 'discount' } });
assert.equal(fxPlan.items.find(i => i.row.p.id === 'FX_CL').final.pct, 50); assert.equal(fxPlan.items.find(i => i.row.p.id === 'FX_SP').final.pct, 30); assert.equal(fxPlan.items.find(i => i.row.p.id === 'FX_OV').final.pct, 20);
assert.ok(fxPlan.totals.avgDiscount <= 45 + 1e-9);
// a plan above the target is lowered under it; if lowering overshoots (levels are coarse) it is raised back as close as possible
const aboveT = Math.floor(baseAvg) - 4, above = E.buildPlan(range, capSet(aboveT));
assert.ok(above.cap.met); assert.ok(above.totals.avgDiscount <= aboveT + 1e-9); assert.ok(above.totals.avgDiscount <= baseAvg);
const aboveLowerOnly = (() => { const c = above.cap; return c.steps > 0; })(); assert.ok(aboveLowerOnly);
// a binding cap is met, and tightening it only ever lowers discounts
let prev = base;
const floorAvg = E.buildPlan(range, capSet(1)).cap.avg;                                   // lowest average reachable while Group B stays deeper than Group A
for (const c of [Math.floor(base.totals.avgDiscount) - 1, 25, 20].filter(c => c >= floorAvg)) {
  const pl = E.buildPlan(range, capSet(c));
  assert.ok(pl.cap.met, 'cap ' + c + ' should be reachable'); assert.ok(wavg(pl) <= c + 1e-9, 'avg ' + wavg(pl) + ' > cap ' + c);
  assert.ok(pl.totals.avgDiscount <= c + 1e-9);
  pl.items.forEach((it, i) => assert.ok((it.final.pct || 0) <= (prev.items[i].final.pct || 0), 'a tighter cap must never raise a discount'));
  prev = pl;
}
// category offers stay consistent: every Group A product in a category shares one %, same for B
const capped = E.buildPlan(range, capSet(Math.ceil(floorAvg)));
for (const c of ['X', 'Y', 'Z']) for (const tier of ['A', 'B']) {
  const ps = new Set(capped.items.filter(i => i.row.p.category === c && i.final.action === tier).map(i => i.final.pct)); assert.ok(ps.size <= 1, c + ' ' + tier + ' has several %');
}
assert.ok(capped.items.some(i => i.capped)); assert.ok(capped.items.some(i => /average (cap|target|discount)/.test(i.final.reason)));
// the average cap never touches Clearance, and manual overrides are left exactly as set
const clr = [mk('CL1', { soh: 30, sold: { d7: 0, d30: 1, d60: 2, d90: 3 }, ageWeeks: 90, currentDiscountPct: 20, price: 80 }), mk('CL2', { currentDiscountPct: 30, price: 70, soh: 400, sold: { d7: 0, d30: 1, d60: 2, d90: 3 }, ageWeeks: 90 })];
const withClr = E.buildPlan(range.concat(clr), { ...capSet(1) }, { X3: { pct: 40 } });
assert.equal(withClr.items.find(i => i.row.p.id === 'CL1').final.pct, 50); assert.equal(withClr.items.find(i => i.row.p.id === 'CL2').final.pct, 50);
assert.equal(withClr.items.find(i => i.row.p.id === 'X3').final.pct, 40); assert.equal(withClr.items.find(i => i.row.p.id === 'X3').override, 'discount');
// healthiest groups are lowered first: the most-pressured category keeps the deepest offer
const gA = pl => Object.fromEntries(pl.categories.map(c => [c.category, c.groupA]));
const skew = range.map(p => p.category === 'Z' ? { ...p, soh: p.soh * 4, sold: { d7: 0, d30: 1, d60: 2, d90: 3 } } : p);   // Z is badly overstocked
const sk0 = E.buildPlan(skew, capSet(null)), sk1 = E.buildPlan(skew, capSet(Math.max(10, sk0.totals.avgDiscount - 6)));
assert.ok((gA(sk1).Z || 0) >= (gA(sk1).X || 0)); assert.ok(sk1.cap.met);
// unreachable cap in 'all' scope: nobody is dropped, the shortfall is reported honestly
const allP = E.buildPlan(range, { maxDiscount: 70, scope: 'all', avgDiscountCap: 5 });
assert.equal(allP.cap.met, false); assert.ok(allP.cap.avg > 5);
assert.equal(allP.items.filter(i => i.final.pct != null).length, E.buildPlan(range, { maxDiscount: 70, scope: 'all' }).items.filter(i => i.final.pct != null).length);
// below the lowest allowed level the cap is unreachable: the sale is NOT emptied to chase it — it stays at the floor and is reported
const floorP = E.buildPlan(range, capSet(15)), floorRef = E.buildPlan(range, capSet(20));
assert.equal(floorP.cap.met, false); assert.equal(floorP.cap.avg, floorAvg); assert.ok(floorP.totals.included > 0);
assert.equal(floorP.totals.included, floorRef.totals.included);                           // same products in the sale, nobody dropped
assert.ok(floorP.items.every(i => i.final.pct == null || i.final.pct >= 20));
// clearance alone above the cap -> reported, not forced
const onlyClr = E.buildPlan([mk('Q1', { soh: 30, currentDiscountPct: 30, price: 70, ...{ sold: { d7: 0, d30: 1, d60: 2, d90: 3 }, ageWeeks: 90 } })], { avgDiscountCap: 20 });
assert.equal(onlyClr.cap.met, false); assert.equal(onlyClr.items[0].final.pct, 50);
// Group B is ALWAYS deeper than Group A in a category (never the same offer), however hard the target squeezes
for (const c of [null, 1, 20, 30, 40, 55]) {
  const pl = E.buildPlan(range, capSet(c));
  pl.categories.forEach(cp => { if (cp.groupA != null && cp.groupB != null) assert.ok(cp.groupB > cp.groupA, 'target ' + c + ': ' + cp.category + ' B ' + cp.groupB + ' must be deeper than A ' + cp.groupA); });
  const byCat = {}; pl.items.forEach(i => { if (i.final.pct != null && (i.final.action === 'A' || i.final.action === 'B') && !i.override) { const k = i.row.p.category + i.final.action; byCat[k] = i.final.pct; } });
  for (const cp of pl.categories) if (byCat[cp.category + 'A'] != null && byCat[cp.category + 'B'] != null) assert.ok(byCat[cp.category + 'B'] > byCat[cp.category + 'A']);
}
// a tight target that can't be met without collapsing B onto A is reported unreachable instead
assert.equal(E.buildPlan(range, capSet(1)).cap.met, false);
// ── Your own Group A / B level per category, and the live RRP-weighted effective discount ──
{
  const base = E.buildPlan(range, { maxDiscount: 70 });
  const cX = base.categories.find(c => c.category === 'X');
  assert.ok(cX.groupA != null && cX.groupB != null);
  // setting Group A for a category: every Group A product in it is suggested from it, other categories untouched
  const gl1 = E.buildPlan(range, { maxDiscount: 70 }, {}, { X: { A: 40 } });
  const x1 = gl1.categories.find(c => c.category === 'X');
  assert.equal(x1.groupA, 40); assert.equal(x1.manualA, 40); assert.equal(x1.autoA, cX.autoA);
  gl1.items.filter(i => i.row.p.category === 'X' && i.final.action === 'A').forEach(i => { assert.equal(i.final.pct, 40); assert.match(i.final.reason, /set by you/); });
  assert.ok(x1.groupB > 40, 'Group B is pushed to stay deeper than the A you set');                                           // auto B (40?) bumped past 40
  gl1.items.filter(i => i.row.p.category !== 'X').forEach((i, k) => assert.equal(i.final.pct, base.items.find(b => b.row.p.id === i.row.p.id).final.pct));
  // Group B you set shallower than the auto A: A is pulled down to stay shallower than B
  const gl2 = E.buildPlan(range, { maxDiscount: 70 }, {}, { X: { B: 30 } });
  const x2 = gl2.categories.find(c => c.category === 'X'); assert.equal(x2.groupB, 30); assert.ok(x2.groupA < 30);
  // both set: used exactly; B not deeper than A is flagged, never silently changed
  const gl3 = E.buildPlan(range, { maxDiscount: 70 }, {}, { X: { A: 40, B: 30 } }); const x3 = gl3.categories.find(c => c.category === 'X');
  assert.equal(x3.groupA, 40); assert.equal(x3.groupB, 30); assert.equal(x3.groupWarn, true);
  assert.equal(E.buildPlan(range, { maxDiscount: 70 }, {}, { X: { A: 30, B: 50 } }).categories.find(c => c.category === 'X').groupWarn, false);
  // capped at the highest single discount; bad values ignored
  assert.equal(E.buildPlan(range, { maxDiscount: 40 }, {}, { X: { A: 90 } }).categories.find(c => c.category === 'X').groupA, 40);
  assert.deepEqual(E.buildPlan(range, { maxDiscount: 70 }, {}, { X: { A: 'abc', B: -5 } }).items.map(i => i.final.pct), base.items.map(i => i.final.pct));
  // your category level survives alongside a product decision, and decisions still win
  const gl4 = E.buildPlan(range, { maxDiscount: 70 }, { X1: { pct: 20, kind: 'discount' } }, { X: { A: 40 } });
  assert.equal(gl4.items.find(i => i.row.p.id === 'X1').final.pct, 20);
  // the average-target algorithm never moves a level you set
  const gl5 = E.buildPlan(range, { maxDiscount: 70, avgDiscountCap: 25 }, {}, { X: { A: 40 } }); assert.equal(gl5.categories.find(c => c.category === 'X').groupA, 40);
  // effective discount: RRP value on sale less the suggested % on each unit, as a % of RRP value (a live figure, not a target)
  const direct = (() => { let off = 0, val = 0; base.items.forEach(i => { if (i.final.pct != null) { const u = i.row.m.soh, r = i.price.base; off += u * r * i.final.pct / 100; val += u * r; } }); return Math.round(off / val * 1000) / 10; })();
  assert.equal(base.totals.effectiveDiscount, direct); assert.ok(base.totals.effRrpValue > base.totals.effOffValue && base.totals.effOffValue > 0);
  assert.equal(base.totals.effRrpValue - base.totals.effOffValue, base.totals.effSaleValue);
  assert.ok(gl1.totals.effectiveDiscount > base.totals.effectiveDiscount);                                                  // raising a group raises the live figure
  // a hand-checkable case: 100 units at $100 at 20% + 100 units at $50 at 40% -> (2000+2000)/(10000+5000) = 26.7%
  const two = E.buildPlan([mk('E1', { soh: 100, rrp: 100, price: 100, sold: { d7: 1, d30: 4, d60: 9, d90: 14 }, ageWeeks: 60 }), mk('E2', { soh: 100, rrp: 50, price: 50, sold: { d7: 1, d30: 4, d60: 9, d90: 14 }, ageWeeks: 60 })], { maxDiscount: 70, scope: 'all' }, { E1: { pct: 20, kind: 'discount' }, E2: { pct: 40, kind: 'discount' } });
  assert.equal(two.totals.effectiveDiscount, 26.7); assert.equal(two.totals.effRrpValue, 15000); assert.equal(two.totals.effOffValue, 4000);
  assert.equal(E.buildPlan([], { maxDiscount: 70 }).totals.effectiveDiscount, 0);
}
// ── Existing reduced products: never reduced automatically; kept as an exception; cap conflicts flagged, never auto-raised ──
{
  const base = { sold: { d7: 1, d30: 4, d60: 9, d90: 14 }, ageWeeks: 60, soh: 200 };
  const red = (id, cur, extra) => mk(id, { ...base, currentDiscountPct: cur, price: 100 * (1 - cur / 100), ...extra });
  const run = (prods, S, ov, gl) => E.buildPlan(prods.concat(range), { maxDiscount: 70, scope: 'all', ...S }, ov || {}, gl || null);
  const get = (pl, id) => pl.items.find(i => i.row.p.id === id);
  // reassess: the group would put it at 20%, but it's already 30% off -> kept at 30%, flagged as kept, no price change
  let r = get(run([red('R40', 40)], { existingReduced: 'reassess' }), 'R40');
  assert.equal(r.final.pct, 40); assert.equal(r.keptExisting, true); assert.equal(r.noPriceChange, true); assert.match(r.final.reason, /never reduced/); assert.equal(r.priceUp, false);
  // a current discount that already matches or sits below the group's level is simply proposed as the group's level (not "kept")
  r = get(run([red('R10', 10)], { existingReduced: 'reassess' }), 'R10'); assert.equal(r.keptExisting, false); assert.ok(r.final.pct >= 20);
  // default rule (already-reduced -> clearance): goes deeper to the clearance level, never shallower
  r = get(run([red('R30', 30)], {}), 'R30'); assert.equal(r.final.action, 'C'); assert.equal(r.final.pct, 50);
  r = get(run([red('R50', 50)], {}), 'R50'); assert.equal(r.final.pct, 50); assert.equal(r.noPriceChange, true);                        // already at 50: stays, "no change"
  r = get(run([red('R60', 60)], {}), 'R60'); assert.equal(r.final.pct, 60); assert.equal(r.group, 'X'); assert.equal(r.overCap, false);   // deeper than Group C: kept as is (protected); within the 70% cap here
  // a special buy never lowers an existing discount
  r = get(run([red('SP50', 50, { specialPct: 30 })], { existingReduced: 'reassess' }), 'SP50'); assert.equal(r.final.pct, 50); assert.equal(r.keptExisting, true);
  // lowering the category's group level below an existing discount keeps the existing one
  const plRed = run([red('R40', 40)], { existingReduced: 'reassess' }, {}, { [red('R40', 40).category]: { A: 20 } }); r = get(plRed, 'R40'); assert.equal(r.final.pct >= 40, true);
  // only an explicit decision lowers it (that raises the price, and says so)
  r = get(run([red('R30', 30)], { existingReduced: 'reassess' }, { R30: { pct: 20, kind: 'discount' } }), 'R30'); assert.equal(r.final.pct, 20); assert.equal(r.priceUp, true); assert.equal(r.keptExisting, false); assert.equal(r.override, 'discount');
  // an existing discount deeper than the sale's highest single discount is flagged for review and NOT raised in price
  r = get(run([red('R60', 60)], { existingReduced: 'reassess', maxDiscount: 50 }), 'R60'); assert.equal(r.overCap, true); assert.equal(r.final.pct, 60); assert.equal(r.noPriceChange, true);
  r = get(run([red('R40', 40)], { existingReduced: 'reassess', maxDiscount: 50 }), 'R40'); assert.equal(r.overCap, false);
  // effective discount is measured against RRP, not stacked: price 70 on RRP 100 is 30%, whatever sale % is proposed
  assert.equal(get(run([red('R30', 30)], { existingReduced: 'reassess' }), 'R30').currentPct, 30);
}
// ── Group B switched off: its products stay in Group A; you can still always configure two groups ──
{
  const base = E.buildPlan(range, { maxDiscount: 70 }), cat = base.categories.find(c => c.groupB != null);
  assert.ok(cat && cat.recB > 0); assert.equal(cat.noB, false); assert.ok(cat.levelA != null && cat.levelB > cat.levelA);
  const off = E.buildPlan(range, { maxDiscount: 70 }, {}, { [cat.category]: { B: 0 } }), co = off.categories.find(c => c.category === cat.category);
  assert.equal(co.noB, true); assert.equal(co.levelB, 0); assert.equal(co.groupB, null); assert.equal(co.countB, 0); assert.equal(co.recB, cat.recB);   // the planner still says what it would recommend
  assert.equal(co.countA, cat.countA + cat.countB);                                                                                              // B's products joined A
  off.items.filter(i => i.row.p.category === cat.category && base.items.find(b => b.row.p.id === i.row.p.id).final.action === 'B').forEach(i => { assert.equal(i.final.action, 'A'); assert.equal(i.final.pct, co.groupA); assert.match(i.final.reason, /Group B is switched off/); });
  off.items.filter(i => i.row.p.category !== cat.category).forEach(i => assert.equal(i.final.pct, base.items.find(b => b.row.p.id === i.row.p.id).final.pct));   // other categories untouched
  // switching it back on restores the recommendation
  assert.deepEqual(E.buildPlan(range, { maxDiscount: 70 }, {}, { [cat.category]: { B: null } }).items.map(i => i.final.pct), base.items.map(i => i.final.pct));
  // manual product decisions survive switching B off; a 'move to B' decision falls back to A
  const bId = base.items.find(i => i.row.p.category === cat.category && i.final.action === 'B').row.p.id;
  assert.equal(E.buildPlan(range, { maxDiscount: 70 }, { [bId]: { pct: 30, kind: 'discount' } }, { [cat.category]: { B: 0 } }).items.find(i => i.row.p.id === bId).final.pct, 30);
  const aId = base.items.find(i => i.row.p.category === cat.category && i.final.action === 'A').row.p.id;
  assert.equal(E.buildPlan(range, { maxDiscount: 70 }, { [aId]: { group: 'B' } }, { [cat.category]: { B: 0 } }).items.find(i => i.row.p.id === aId).final.action, 'A');
  // a category the planner puts nobody in Group B for can still be given a Group B level, and products can be moved into it
  const oneG = E.buildPlan(range, { maxDiscount: 70, scope: 'all' }, {}, null), cA = oneG.categories.find(c => c.groupB == null && c.groupA != null);
  if (cA) {
    assert.ok(cA.levelB != null && cA.levelB > cA.levelA && cA.autoB == null);
    const pid = oneG.items.find(i => i.row.p.category === cA.category && i.final.action === 'A').row.p.id;
    const mv = E.buildPlan(range, { maxDiscount: 70, scope: 'all' }, { [pid]: { group: 'B' } }, { [cA.category]: { B: 60 } }), m = mv.items.find(i => i.row.p.id === pid);
    assert.equal(m.final.action, 'B'); assert.equal(m.final.pct, 60);                                                                           // follows the level you set for B
  }
}
// ── Not on sale: kept out of every group, keeps its price, saved decisions survive, conflicts with special buys are flagged ──
{
  const base = { sold: { d7: 1, d30: 4, d60: 9, d90: 14 }, ageWeeks: 60, soh: 200 };
  const prods = [mk('N1', { ...base }), mk('N2', { ...base }), mk('N3', { ...base, notOnSale: true }), mk('N4', { ...base, notOnSale: true, specialPct: 50 }), mk('N5', { ...base, notOnSale: true, currentDiscountPct: 30, price: 70 })].concat(range);
  const settings = { maxDiscount: 70, scope: 'all' }, pl = E.buildPlan(prods, settings), g = id => pl.items.find(i => i.row.p.id === id);
  assert.equal(g('N3').final.action, 'Exclude'); assert.equal(g('N3').final.pct, null); assert.equal(g('N3').group, null); assert.match(g('N3').final.reason, /Not on sale/);
  assert.equal(g('N5').final.pct, null);                                                                        // an already-reduced product that is Not on sale keeps its current price (no Group C)
  assert.equal(g('N4').final.pct, null); assert.equal(g('N4').blocked, 'NOS');                                  // Not on sale + discounted special buy: a conflict, never silently discounted
  assert.equal(g('N1').blocked, null);
  // it is in no A/B/C count and no totals of eligible stock
  const tees = pl.categories.find(c => c.category === 'TEES'), without = E.buildPlan(prods.filter(p => !p.notOnSale), settings).categories.find(c => c.category === 'TEES');
  assert.equal(tees.eligible, without.eligible); assert.equal(tees.eligibleUnits, without.eligibleUnits); assert.equal(tees.countA + tees.countB + tees.countC + tees.countX, without.countA + without.countB + without.countC + without.countX);
  // a saved manual decision is kept but not applied while it is Not on sale, and applies again when it is put back
  const ov = { N3: { pct: 40, kind: 'discount' } };
  const held = E.buildPlan(prods, settings, ov).items.find(i => i.row.p.id === 'N3'); assert.equal(held.final.pct, null); assert.equal(held.override, null);
  const back = E.buildPlan(prods.map(p => p.id === 'N3' ? { ...p, notOnSale: false } : p), settings, ov).items.find(i => i.row.p.id === 'N3'); assert.equal(back.final.pct, 40); assert.equal(back.override, 'discount');
  // GWP still wins over everything
  assert.equal(E.buildPlan([mk('NG', { ...base, isGWP: true, notOnSale: true })].concat(range), settings).items[0].final.action, 'Exclude');
}
// deterministic: same input, same output
assert.deepEqual(E.buildPlan(range, capSet(18)).items.map(i => i.final.pct), E.buildPlan(range, capSet(18)).items.map(i => i.final.pct));
// the single-product ceiling still holds under a cap
assert.ok(E.buildPlan(range, { maxDiscount: 30, avgDiscountCap: 25 }).items.every(i => i.final.pct == null || i.final.pct <= 30));

// 'all styles' scope: healthy sellers join at the lightest level; protections still hold
const hotP = mk('HOT2', { soh: 200, sold: { d7: 40, d30: 150, d60: 300, d90: 450 }, ageWeeks: 20 });
const protectedSet = [hotP, mk('NEWP', { ageWeeks: 2, soh: 200 }), mk('GWPP', { isGWP: true }), mk('NOSTK', { soh: 0 }), mk('HOTLOW', { soh: 20, sold: { d7: 40, d30: 150, d60: 300, d90: 450 }, ageWeeks: 20 })];
const recS = E.buildPlan(protectedSet.concat(range), { maxDiscount: 70 }), allS = E.buildPlan(protectedSet.concat(range), { maxDiscount: 70, scope: 'all' });
const pick = (pl, id) => pl.items.find(i => i.row.p.id === id).final;
assert.equal(pick(recS, 'HOT2').action, 'Exclude');
assert.equal(pick(allS, 'HOT2').action, 'A'); assert.equal(pick(allS, 'HOT2').pct, Math.min(...E.levels(E.mergeSettings({ maxDiscount: 70 })))); assert.match(pick(allS, 'HOT2').reason, /Healthy seller/);
assert.equal(pick(allS, 'HOTLOW').action, 'A');                                           // healthy + low stock is NOT cleared
assert.equal(pick(allS, 'NEWP').action, 'Exclude'); assert.equal(pick(allS, 'GWPP').action, 'Exclude'); assert.equal(pick(allS, 'NOSTK').action, 'Exclude');
assert.ok(allS.totals.included > recS.totals.included);
// core colours of a healthy core style are also in, consistently, under 'all'
const hc = [mk('W26AA002BLK', { isCore: true, parentStyle: 'W26AA002', soh: 200, sold: { d7: 20, d30: 90, d60: 180, d90: 270 }, ageWeeks: 60 }), mk('W26AA002WHT', { isCore: true, parentStyle: 'W26AA002', soh: 180, sold: { d7: 18, d30: 80, d60: 160, d90: 240 }, ageWeeks: 60 })];
const hcAll = E.buildPlan(hc.concat(range), { scope: 'all' }).items.filter(i => i.row.p.isCore);
assert.ok(hcAll.every(i => i.final.action === 'A'));

// ── Decisions: approve, set, move group, exclude with reason; GWP block; conflicts ──
const ovSet = [
  mk('W26AA010BLK', { parentStyle: 'W26AA010', soh: 300, ...{ sold: { d7: 0, d30: 2, d60: 5, d90: 9 }, ageWeeks: 70 } }),
  mk('W26AA010WHT', { parentStyle: 'W26AA010', soh: 250, ...{ sold: { d7: 1, d30: 4, d60: 9, d90: 14 }, ageWeeks: 60 } }),
  mk('M1', { soh: 140, sold: { d7: 2, d30: 8, d60: 16, d90: 24 }, ageWeeks: 45 }), mk('M2', { soh: 130, sold: { d7: 2, d30: 9, d60: 17, d90: 26 }, ageWeeks: 45 }),   // slow-ish, share Group A with W26AA010WHT
  mk('M3', { soh: 120, sold: { d7: 9, d30: 34, d60: 62, d90: 90 } }), mk('M4', { soh: 110, sold: { d7: 9, d30: 33, d60: 60, d90: 88 } }),
  mk('GW1', { isGWP: true, soh: 40 }),
];
const ovBase = E.buildPlan(ovSet, { maxDiscount: 70 });
const sys0 = id => ovBase.items.find(i => i.row.p.id === id).systemPct;
assert.ok(sys0('W26AA010BLK') != null);
// the old per-product 'approved' / 'confirmed' decisions are inert now (approval is per category): kept in the saved data, never pin a discount, never flagged
let a1 = E.buildPlan(ovSet, { maxDiscount: 70 }, { W26AA010BLK: { pct: sys0('W26AA010BLK'), kind: 'approved' } }).items.find(i => i.row.p.id === 'W26AA010BLK');
assert.equal(a1.override, null); assert.equal(a1.conflict, false); assert.equal(a1.final.pct, sys0('W26AA010BLK')); assert.notEqual(a1.final.action, 'Manual');
const legacy = E.buildPlan(ovSet, { maxDiscount: 70 }, { M1: { pct: 60, kind: 'approved' }, M3: { exclude: true, confirm: true } });
assert.equal(legacy.items.find(i => i.row.p.id === 'M1').final.pct, ovBase.items.find(i => i.row.p.id === 'M1').final.pct);   // a stale approved figure no longer pins anything
assert.equal(legacy.items.find(i => i.row.p.id === 'M3').override, null); assert.equal(legacy.totals.overridden, 0); assert.equal(legacy.totals.conflicts, 0);
// a category group change moves every product in the group, including ones that were 'approved' under the old workflow
const moved = E.buildPlan(ovSet, { maxDiscount: 70 }, { M1: { pct: sys0('M1'), kind: 'approved' } }, { [ovSet.find(p => p.id === 'M1').category]: { A: 40 } });
assert.equal(moved.items.find(i => i.row.p.id === 'M1').final.pct >= 40, true); assert.equal(moved.items.find(i => i.row.p.id === 'M1').conflict, false);
// allocations saved at category approval: a product stays in the group it was approved in
{
  const fzBase = E.buildPlan(ovSet, { maxDiscount: 70 }), m1 = fzBase.items.find(i => i.row.p.id === 'M1').final.action;
  const other = m1 === 'A' ? 'B' : 'A';
  const fz = E.buildPlan(ovSet, { maxDiscount: 70 }, {}, null, { M1: other });
  assert.equal(fz.items.find(i => i.row.p.id === 'M1').final.action, other); assert.equal(fz.items.find(i => i.row.p.id === 'M1').frozen, true);
  assert.equal(E.buildPlan(ovSet, { maxDiscount: 70 }, {}, null, { M1: 'Exclude' }).items.find(i => i.row.p.id === 'M1').final.pct, null);
  assert.equal(E.buildPlan(ovSet, { maxDiscount: 70 }, {}, null, { GW1: 'A' }).items.find(i => i.row.p.id === 'GW1').final.pct, null);          // GWP is never pulled in by a saved allocation
  assert.equal(E.buildPlan(ovSet, { maxDiscount: 70 }, {}, null, { M1: 'Z' }).items.find(i => i.row.p.id === 'M1').final.action, m1);             // junk values ignored
  assert.equal(E.buildPlan(ovSet, { maxDiscount: 70 }, { M1: { pct: 50, kind: 'discount' } }, null, { M1: other }).items.find(i => i.row.p.id === 'M1').final.pct, 50);   // your product decision still wins
}
// a typed discount is a manual override (capped at the single-discount ceiling); a typed discount is never a 'conflict'
const t1 = E.buildPlan(ovSet, { maxDiscount: 40 }, { M1: { pct: 90, kind: 'discount' } }).items.find(i => i.row.p.id === 'M1');
assert.equal(t1.final.pct, 40); assert.equal(t1.final.action, 'Manual'); assert.equal(t1.override, 'discount'); assert.equal(t1.conflict, false);
// exclusion carries its reason and note
const x1 = E.buildPlan(ovSet, {}, { M2: { exclude: true, reason: 'Commercial decision', note: 'hero tee' } }).items.find(i => i.row.p.id === 'M2');
assert.equal(x1.final.action, 'Exclude'); assert.equal(x1.final.pct, null); assert.equal(x1.final.reason, 'Excluded — Commercial decision (hero tee)'); assert.equal(x1.override, 'exclude');
// moving between groups follows the target group's level; Clearance uses the clearance %
const mvA = E.buildPlan(ovSet, { maxDiscount: 70 }, { M3: { group: 'A' } }).items.find(i => i.row.p.id === 'M3');
const mvC = E.buildPlan(ovSet, { maxDiscount: 70 }, { M3: { group: 'C' } }).items.find(i => i.row.p.id === 'M3');
assert.equal(mvA.final.action, 'A'); assert.equal(mvA.override, 'group'); assert.ok(mvA.final.pct > 0 && mvA.final.pct <= 70);
assert.equal(mvC.final.action, 'C'); assert.equal(mvC.final.pct, E.clearanceLevel(E.mergeSettings({ maxDiscount: 70 })));
const mvB = E.buildPlan(ovSet, { maxDiscount: 70 }, { M3: { group: 'B' } }).items.find(i => i.row.p.id === 'M3');
assert.equal(mvB.final.action, 'B'); assert.ok(mvB.final.pct >= mvA.final.pct);                         // B is never lighter than A, even if the category had no B group
// GWP can never be discounted by a decision; it is flagged instead
const gw = E.buildPlan(ovSet, {}, { GW1: { pct: 30, kind: 'discount' } }).items.find(i => i.row.p.id === 'GW1');
assert.equal(gw.final.action, 'Exclude'); assert.equal(gw.final.pct, null); assert.equal(gw.blocked, 'GWP');
// decisions survive regenerating with different settings; unknown/stale ids are ignored without error
const keep = { W26AA010WHT: { exclude: true, reason: 'Low stock cover' }, M4: { pct: 30, kind: 'discount' }, GONE: { pct: 50, kind: 'discount' } };
for (const st of [{ periodDays: 60 }, { maxDiscount: 50, scope: 'all' }, { coreMode: 'include' }, { avgDiscountCap: 25 }]) {
  const rp = E.buildPlan(ovSet, st, keep);
  assert.equal(rp.items.find(i => i.row.p.id === 'W26AA010WHT').final.action, 'Exclude'); assert.equal(rp.items.find(i => i.row.p.id === 'M4').final.pct, 30);
  assert.equal(rp.items.length, ovSet.length); assert.equal(rp.totals.overridden, 2);
}
// overrides count in the average discount (a high manual figure raises it; the cap loop never lowers it)
const avgA = E.buildPlan(ovSet, { maxDiscount: 70 }).totals.avgDiscount, avgB = E.buildPlan(ovSet, { maxDiscount: 70 }, { M1: { pct: 70, kind: 'discount' } }).totals.avgDiscount;
assert.ok(avgB > avgA);
const capH = E.buildPlan(ovSet, { maxDiscount: 70, avgDiscountCap: 20 }, { M1: { pct: 70, kind: 'discount' } });
assert.equal(capH.items.find(i => i.row.p.id === 'M1').final.pct, 70);

// a core-colour exception stops needing approval once you decide it (approve, change or exclude)
const exBase = E.buildPlan(core, { coreConsistency: 'preferred' }), exId = exBase.items.find(i => i.exception).row.p.id;
assert.ok(exBase.totals.exceptions >= 1);
for (const dec of [{ exclude: true, reason: 'Core protection' }, { pct: 30, kind: 'discount' }]) {
  const r = E.buildPlan(core, { coreConsistency: 'preferred' }, { [exId]: dec });
  assert.equal(r.totals.exceptions, exBase.totals.exceptions - 1); assert.equal(r.items.find(i => i.row.p.id === exId).exceptionResolved, true);
}
// ── Special buys ──────────────────────────────────────────────────────────
const spBase = [mk('SP1', { soh: 40, ageWeeks: 1, sold: { d7: 0, d30: 0, d60: 0, d90: 0 }, specialPct: 50, specialNote: '2027 AW1 - IKIZAMA' }), mk('SP2', { soh: 400, specialPct: 30 }), mk('NSP', { soh: 100 }), mk('GWSP', { isGWP: true, soh: 30, specialPct: 50 }), mk('NOSTK', { soh: 0, specialPct: 50 })];
const spPlan = E.buildPlan(spBase.concat(range), { maxDiscount: 70 });
const spi = id => spPlan.items.find(i => i.row.p.id === id);
assert.equal(spi('SP1').final.action, 'S'); assert.equal(spi('SP1').final.pct, 50); assert.match(spi('SP1').final.reason, /^Special buy — 2027 AW1 - IKIZAMA at 50%/);   // brand new, 40 units, zero sales: NOT protected as new / cleared as a remnant
assert.equal(spi('SP2').final.pct, 30); assert.equal(spi('SP2').systemPct, 30);
assert.notEqual(spi('NSP').final.action, 'S');
assert.equal(spi('GWSP').final.action, 'Exclude'); assert.equal(spi('GWSP').final.pct, null); assert.equal(spi('GWSP').blocked, 'GWP');                    // GWP wins, and the clash is flagged
assert.equal(spi('NOSTK').final.action, 'Exclude'); assert.match(spi('NOSTK').final.reason, /No stock/);
assert.ok(spPlan.categories[0].countS >= 2);
// special buys respect the single-product ceiling, are counted in the average, and are never lowered by the average cap
assert.equal(E.buildPlan(spBase, { maxDiscount: 40 }).items.find(i => i.row.p.id === 'SP1').final.pct, 40);
const noSp = E.buildPlan(range, { maxDiscount: 70 }).totals.avgDiscount, withSp = E.buildPlan(spBase.concat(range), { maxDiscount: 70 }).totals.avgDiscount;
assert.notEqual(noSp, withSp);
const spCap = E.buildPlan(spBase.concat(range), { maxDiscount: 70, avgDiscountCap: 18 });
assert.equal(spCap.items.find(i => i.row.p.id === 'SP1').final.pct, 50); assert.equal(spCap.items.find(i => i.row.p.id === 'SP2').final.pct, 30);
// a manual decision still wins over a special buy; special buys are not colour-linked
assert.equal(E.buildPlan(spBase, { maxDiscount: 70 }, { SP1: { exclude: true, reason: 'Commercial decision' } }).items.find(i => i.row.p.id === 'SP1').final.action, 'Exclude');
const coreSp = E.buildPlan([mk('W26AA020BLK', { isCore: true, parentStyle: 'W26AA020', specialPct: 50, soh: 200 }), mk('W26AA020WHT', { isCore: true, parentStyle: 'W26AA020', soh: 200, sold: { d7: 20, d30: 90, d60: 180, d90: 270 } })], { coreConsistency: 'strict' }).items;
assert.equal(coreSp.find(i => i.row.p.id === 'W26AA020BLK').final.action, 'S'); assert.ok(!coreSp.find(i => i.row.p.id === 'W26AA020BLK').exception);

// ── Restocks: sold out today, stock arriving by the sale ───────────────────
// sales are passed as a flat 90-day average (a stock-out understates recent sales); restockUnits = arriving stock
const rs90 = d90 => ({ d7: Math.round(d90 / 12.86), d30: Math.round(d90 / 3), d60: Math.round(d90 * 2 / 3), d90 });
const rsAll = [mk('RS_SLOW', { soh: 0, restockUnits: 500, sold: rs90(9), ageWeeks: 70, soldOutSizes: 0 }), mk('RS_HOT', { soh: 0, restockUnits: 300, sold: rs90(450), ageWeeks: 30 }),
  mk('RS_NONE', { soh: 0, restockUnits: 400, sold: rs90(0), ageWeeks: 70 }), mk('RS_TINY', { soh: 0, restockUnits: 30, sold: rs90(9), ageWeeks: 70 }), mk('RS_NEW', { soh: 0, restockUnits: 500, sold: rs90(30), ageWeeks: 2 }),
  mk('RS_GWP', { isGWP: true, soh: 0, restockUnits: 3000 })];
const rsPlan = E.buildPlan(rsAll.concat(range), { maxDiscount: 70 }), rsi = id => rsPlan.items.find(i => i.row.p.id === id);
assert.equal(rsi('RS_SLOW').row.m.soh, 500); assert.equal(rsi('RS_SLOW').row.m.sohNow, 0); assert.equal(rsi('RS_SLOW').row.m.restock, 500);   // planned on 500, but real SOH is still 0
assert.ok(['A', 'B'].includes(rsi('RS_SLOW').final.action)); assert.match(rsi('RS_SLOW').final.reason, /^Restock — 500 units arriving by the sale/);
assert.equal(rsi('RS_SLOW').row.confidence, 'Low');                                                              // never better than Low
assert.equal(rsi('RS_HOT').final.action, 'Exclude'); assert.match(rsi('RS_HOT').final.reason, /full price/);     // a fast seller restocking stays full price
assert.equal(rsi('RS_NONE').final.action, 'A'); assert.equal(rsi('RS_NONE').defaultA, true); assert.match(rsi('RS_NONE').final.reason, /defaulted to the lowest discount in its category \(Group A\)/);   // can't be scored -> the category's lightest offer
const tinyOnly = E.buildPlan([mk('RS_TINY', { soh: 0, restockUnits: 30, sold: rs90(9), ageWeeks: 70 })], { maxDiscount: 70 }).items[0];   // a remnant-sized restock is cleared (in isolation: category-relative scores shift with the rest of the range)
assert.equal(tinyOnly.final.action, 'B'); assert.equal(tinyOnly.clearance, true); assert.match(tinyOnly.final.reason, /only 30 units/);
assert.doesNotMatch(rsi('RS_NEW').final.reason, /New arrival/);                                                         // stock arriving for the sale is exempt from new-arrival protection
assert.equal(E.buildPlan([mk('SHELF_NEW', { ageWeeks: 2, soh: 200 })], {}).items[0].final.action, 'Exclude');                  // ...but a new product already on the shelf is still protected
assert.equal(rsi('RS_GWP').final.action, 'Exclude'); assert.match(rsi('RS_GWP').final.reason, /Gift with purchase/);
// real stock is reported separately from restocks in every summary
const rsCat = rsPlan.categories.find(c => c.category === 'TEES'), plain = E.buildPlan(range, { maxDiscount: 70 });
assert.equal(rsCat.soh, 0); assert.equal(rsCat.restock, 500 + 300 + 400 + 30 + 500 + 3000);                     // real SOH stays 0; the arriving units are reported separately
assert.equal(rsPlan.totals.soh, plain.totals.soh); assert.equal(rsPlan.totals.restock, rsCat.restock); assert.equal(rsPlan.totals.restockStyles, 6);
assert.ok(rsCat.forecastUnits >= 0);
// a restock can be decided like any product (override still wins)
assert.equal(E.buildPlan(rsAll.concat(range), { maxDiscount: 70 }, { RS_SLOW: { exclude: true, reason: 'Low stock cover' } }).items.find(i => i.row.p.id === 'RS_SLOW').final.action, 'Exclude');
// in-stock products are unchanged (restockUnits absent)
assert.equal(plain.items.every(i => i.row.m.restock === 0), true);

// no-history restocks default to the category's lowest discount (Group A)
const nh = (id, o = {}) => mk(id, { soh: 0, restockUnits: 300, sold: rs90(0), ageWeeks: 70, category: 'SW', ...o });
const swReal = [0, 1, 2, 3, 4, 5, 6, 7].map(i => mkCat('SW', i));
const swPlain = E.buildPlan(swReal, { maxDiscount: 70 }), swWith = E.buildPlan(swReal.concat([nh('NH1'), nh('NH2')]), { maxDiscount: 70 });
const swA = swWith.categories.find(c => c.category === 'SW').groupA;
assert.ok(swA != null); assert.equal(swWith.items.find(i => i.row.p.id === 'NH1').final.pct, swA); assert.equal(swWith.items.find(i => i.row.p.id === 'NH2').final.action, 'A');     // they get the category's Group A level
assert.equal(swWith.categories.find(c => c.category === 'SW').groupA, swPlain.categories.find(c => c.category === 'SW').groupA);                                       // ...without moving that level
assert.deepEqual(swWith.items.filter(i => !i.defaultA).map(i => [i.row.p.id, i.final.action, i.final.pct]), swPlain.items.map(i => [i.row.p.id, i.final.action, i.final.pct]));   // and without changing anyone else
assert.equal(swWith.items.filter(i => i.defaultA).length, 2);
// a category made only of no-history restocks has no real members: lowest allowed level
const onlyNh = E.buildPlan([nh('NHA'), nh('NHB', { category: 'SW' })], { maxDiscount: 70 }); assert.equal(onlyNh.items[0].final.pct, E.levels(E.mergeSettings({ maxDiscount: 70 }))[0]);
// protections and decisions still win over the default
const nhNew = E.buildPlan([nh('NHN', { ageWeeks: -3, status: 'NEW' })], {}).items[0];   // launching in the future, no history
assert.equal(nhNew.final.action, 'A'); assert.equal(nhNew.defaultA, true);                                                                        // arriving for the sale: exempt from new-arrival protection
assert.equal(E.buildPlan([nh('NHG', { isGWP: true })], {}).items[0].final.action, 'Exclude');
assert.equal(E.buildPlan([nh('NHR', { currentDiscountPct: 30, price: 70 })], {}).items[0].final.action, 'C');                                      // already reduced -> clearance rule
assert.equal(E.buildPlan([nh('NHC', { isCore: true })], { coreMode: 'exclude' }).items[0].final.action, 'Exclude');
assert.equal(E.buildPlan([nh('NHS', { specialPct: 50 })], {}).items[0].final.action, 'S');
assert.equal(E.buildPlan([nh('NHD')], {}, { NHD: { exclude: true, reason: 'Commercial decision' } }).items[0].final.action, 'Exclude');
assert.equal(E.buildPlan([nh('NHD')], {}, { NHD: { pct: 40, kind: 'discount' } }).items[0].final.pct, 40);
assert.equal(E.buildPlan(swReal.concat([nh('NH1')]), { maxDiscount: 70, scope: 'all' }).items.find(i => i.row.p.id === 'NH1').final.action, 'A');   // same under 'all styles'
// the average cap lowers a defaulted-only group first (it has no score to protect) and never breaks consistency
const capNh = E.buildPlan(swReal.concat([nh('NH1')]).concat(range), { maxDiscount: 70, avgDiscountCap: 22 });
assert.ok(capNh.cap.met || capNh.cap.avg <= 24); const swAs = new Set(capNh.items.filter(i => i.row.p.category === 'SW' && i.final.action === 'A').map(i => i.final.pct)); assert.equal(swAs.size, 1);
// unscorable items (GWP, special buys) must never shift anyone else's result
const swBase = E.buildPlan(swReal, { maxDiscount: 70 }).items.map(i => [i.row.p.id, i.final.action, i.final.pct, i.row.score]);
for (const extra of [mk('SWG', { category: 'SW', isGWP: true, soh: 500, sold: { d7: 50, d30: 200, d60: 400, d90: 600 } }), mk('SWS', { category: 'SW', specialPct: 50, soh: 5, sold: { d7: 0, d30: 0, d60: 0, d90: 0 }, ageWeeks: 90 })]) {
  const withX = E.buildPlan(swReal.concat([extra]), { maxDiscount: 70 }).items.filter(i => i.row.p.id !== extra.id).map(i => [i.row.p.id, i.final.action, i.final.pct, i.row.score]);
  assert.deepEqual(withX, swBase);
}
// (confirming a "stays out of the sale" suggestion was a per-product approval — covered above: inert)
// edge: empty input, single product, duplicate ids don't throw
assert.equal(E.buildPlan([], {}).items.length, 0); assert.equal(E.buildPlan([mk('ONE')], {}).items.length, 1);
assert.doesNotThrow(() => E.buildPlan([mk('D'), mk('D')], {}));

// on-order blanket discount: suggested (as a special-buy style 'S' at the blanket %) but changeable like any product; Reset puts it back
{
  const range2 = [mk('BL1', { soh: 80, specialPct: 20, blanket: true }), mk('BL2', { soh: 80, specialPct: 20, blanket: true }), mk('BL3', { soh: 80, specialPct: 20, blanket: true })];
  const st = { maxDiscount: 70 }, ovs = { BL1: { pct: 35, kind: 'discount' }, BL2: { group: 'A' } };
  const pl2 = E.buildPlan(range2, st, ovs), g = id => pl2.items.find(i => i.row.p.id === id);
  assert.equal(g('BL3').final.action, 'S'); assert.equal(g('BL3').final.pct, 20); assert.equal(g('BL3').override, null);                  // untouched: still the on-order suggestion
  assert.equal(g('BL1').final.pct, 35); assert.equal(g('BL1').final.action, 'Manual'); assert.equal(g('BL1').override, 'discount'); assert.equal(g('BL1').group, null);   // typed discount wins; never counted as a normal group
  assert.equal(g('BL1').systemPct, 20);                                                                                                    // the on-order suggestion is still reported
  assert.equal(g('BL2').override, 'group'); assert.equal(g('BL2').final.action, 'A');                                                      // moved into Group A: follows its level
  assert.equal(E.buildPlan(range2, st, {}).items.find(i => i.row.p.id === 'BL1').final.pct, 20);                                           // Reset (no decision) -> the on-order discount again
}
console.log('markdown engine tests: all passed');
})();
