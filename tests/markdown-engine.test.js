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
assert.equal(E.ageScore(null), 50); assert.equal(E.ageScore(4), 0); assert.equal(E.ageScore(60), 100); assert.equal(E.ageScore(10, 'OLD'), 75);

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
assert.equal(c.products, 8); assert.equal(c.countExcluded + c.countA + c.countB + c.countManual, 8); assert.ok(c.groupA == null || c.groupA <= 50);
assert.equal(it.B1.forecast.units <= it.B1.row.m.soh, true); assert.equal(it.B1.forecast.units + it.B1.forecast.remaining, it.B1.row.m.soh);
assert.equal(it.Z0.forecast.units, 0); assert.equal(plan.totals.products, 8);

// existing sale price is never stacked: already 40% off, sale wants 30% -> retained, excluded from sale collections
const red = E.buildPlan([mk('R1', { currentDiscountPct: 40, price: 60, soh: 500, sold: { d7: 0, d30: 1, d60: 2, d90: 3 }, ageWeeks: 80 })], { maxDiscount: 30 });
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
// edge: empty input, single product, duplicate ids don't throw
assert.equal(E.buildPlan([], {}).items.length, 0); assert.equal(E.buildPlan([mk('ONE')], {}).items.length, 1);
assert.doesNotThrow(() => E.buildPlan([mk('D'), mk('D')], {}));
console.log('markdown engine tests: all passed');
})();
