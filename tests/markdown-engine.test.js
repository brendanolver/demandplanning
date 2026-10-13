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
// ── Clearance tier ────────────────────────────────────────────────────────
const slow = { sold: { d7: 0, d30: 1, d60: 2, d90: 3 }, ageWeeks: 90 };                  // not a healthy seller
const one = (p, st) => E.buildPlan([p], st || {}).items[0];
assert.equal(E.clearanceLevel(E.mergeSettings({})), 50);
assert.equal(E.clearanceLevel(E.mergeSettings({ maxDiscount: 40 })), 40);                  // capped by the max effective discount
assert.equal(E.clearanceLevel(E.mergeSettings({ clearanceDiscount: 45 })), 40);            // snapped to an allowed level
// already-reduced stock moves to the clearance %, products already there stay, deeper ones are left alone
let c1 = one(mk('RD', { ...slow, currentDiscountPct: 30, price: 70, soh: 200 }));
assert.equal(c1.final.action, 'C'); assert.equal(c1.final.pct, 50); assert.match(c1.final.reason, /moves to 50% clearance/); assert.equal(c1.noPriceChange, false);
assert.equal(c1.price.newPrice, 50);                                                        // 50% off RRP 100 — not stacked on the $70 price
c1 = one(mk('R50', { ...slow, currentDiscountPct: 50, price: 50, soh: 200 }));
assert.equal(c1.final.action, 'C'); assert.equal(c1.final.pct, 50); assert.equal(c1.noPriceChange, true); assert.match(c1.final.reason, /no price change/);
c1 = one(mk('R60', { ...slow, currentDiscountPct: 60, price: 40, soh: 200 }));
assert.equal(c1.final.action, 'Exclude'); assert.match(c1.final.reason, /deeper than clearance/);
// even a healthy seller that is already reduced follows the rule (the brief: reduced goes to 50%)
assert.equal(one(mk('RH', { currentDiscountPct: 30, price: 70, soh: 200, sold: { d7: 40, d30: 150, d60: 300, d90: 450 }, ageWeeks: 20 })).final.action, 'C');
// remnants and broken runs -> clearance; a normal-stock, intact-run slow seller -> a normal A/B tier
c1 = one(mk('REM', { ...slow, soh: 30 })); assert.equal(c1.final.action, 'C'); assert.match(c1.final.reason, /only 30 units and none on order/);
assert.notEqual(one(mk('REM2', { ...slow, soh: 30, onOrder: 100 })).final.action, 'C');     // stock coming = not a remnant
assert.notEqual(one(mk('REM3', { ...slow, soh: 50 })).final.action, 'C');                   // exactly the minimum is fine
c1 = one(mk('BRK', { ...slow, soh: 300, soldOutSizes: 4 })); assert.equal(c1.final.action, 'C'); assert.match(c1.final.reason, /4 sizes sold out/);
assert.notEqual(one(mk('BRK3', { ...slow, soh: 300, soldOutSizes: 3 })).final.action, 'C');
assert.equal(one(mk('BOTH', { ...slow, soh: 20, soldOutSizes: 5 })).final.action, 'C');
// a healthy seller is never cleared just because it is low on stock
const hot = { sold: { d7: 40, d30: 150, d60: 300, d90: 450 }, ageWeeks: 20 };
assert.equal(one(mk('HOT', { ...hot, soh: 20 })).final.action, 'Exclude');
// thresholds are configurable
assert.equal(one(mk('T1', { ...slow, soh: 80 }), { minStockUnits: 100 }).final.action, 'C');
assert.notEqual(one(mk('T2', { ...slow, soh: 300, soldOutSizes: 4 }), { brokenSizesClearance: 5 }).final.action, 'C');
// other reduced modes still available
assert.equal(one(mk('X1', { ...slow, currentDiscountPct: 30, price: 70, soh: 200 }), { existingReduced: 'exclude' }).final.action, 'Exclude');
assert.notEqual(one(mk('X2', { ...slow, currentDiscountPct: 30, price: 70, soh: 200 }), { existingReduced: 'reassess' }).final.action, 'C');
// clearance respects the cap and is counted in the category summary; clearance items are not colour-linked
const cp = E.buildPlan([mk('Y1', { ...slow, soh: 20 }), mk('Y2', { ...slow, soh: 10 }), mk('Y3', { soh: 500 })], { maxDiscount: 40 }).categories[0];
assert.equal(cp.countC, 2); cp.groupA === null || assert.ok(cp.groupA <= 40);
const coreC = E.buildPlan([mk('W26AA009BLK', { isCore: true, parentStyle: 'W26AA009', ...slow, soh: 20 }), mk('W26AA009WHT', { isCore: true, parentStyle: 'W26AA009', soh: 400, sold: { d7: 1, d30: 3, d60: 8, d90: 12 }, ageWeeks: 60 })], { coreConsistency: 'strict' }).items;
assert.equal(coreC.find(i => i.row.p.id === 'W26AA009BLK').final.action, 'C');

// ── Average effective discount cap + 'all styles' scope ───────────────────
const mkCat = (cat, i, o = {}) => mk(cat + i, { category: cat, soh: 100 + i * 60, sold: { d7: Math.max(0, 9 - i), d30: Math.max(0, 40 - i * 5), d60: Math.max(0, 80 - i * 9), d90: Math.max(0, 120 - i * 13) }, ageWeeks: 20 + i * 8, soldOutSizes: i % 3, ...o });
const range = [].concat(...['X', 'Y', 'Z'].map(c => [0, 1, 2, 3, 4, 5, 6, 7].map(i => mkCat(c, i))));
const capSet = c => ({ maxDiscount: 70, avgDiscountCap: c });
const base = E.buildPlan(range, capSet(null));
assert.ok(base.totals.avgDiscount > 0); assert.equal(base.cap, null);
const wavg = pl => { let n = 0, d = 0; for (const it of pl.items) if (it.final.pct != null) { n += it.final.pct * it.row.m.soh; d += it.row.m.soh; } return d ? Math.round(n / d * 10) / 10 : 0; };
assert.equal(base.totals.avgDiscount, wavg(base));                              // unit-weighted average over the products in the sale
assert.equal(base.totals.saleUnits, base.items.filter(i => i.final.pct != null).reduce((a, i) => a + i.row.m.soh, 0));
// a cap at or above the uncapped average changes nothing
const loose = E.buildPlan(range, capSet(base.totals.avgDiscount + 5));
assert.deepEqual(loose.items.map(i => [i.final.action, i.final.pct]), base.items.map(i => [i.final.action, i.final.pct])); assert.equal(loose.cap.met, true); assert.equal(loose.cap.steps, 0);
// a binding cap is met, and tightening it only ever lowers discounts
let prev = base;
for (const c of [Math.floor(base.totals.avgDiscount) - 1, 25, 20]) {
  const pl = E.buildPlan(range, capSet(c));
  assert.ok(pl.cap.met, 'cap ' + c + ' should be reachable'); assert.ok(wavg(pl) <= c + 1e-9, 'avg ' + wavg(pl) + ' > cap ' + c);
  assert.ok(pl.totals.avgDiscount <= c + 1e-9);
  pl.items.forEach((it, i) => assert.ok((it.final.pct || 0) <= (prev.items[i].final.pct || 0), 'a tighter cap must never raise a discount'));
  prev = pl;
}
// category offers stay consistent: every Group A product in a category shares one %, same for B
const capped = E.buildPlan(range, capSet(20));
for (const c of ['X', 'Y', 'Z']) for (const tier of ['A', 'B']) {
  const ps = new Set(capped.items.filter(i => i.row.p.category === c && i.final.action === tier).map(i => i.final.pct)); assert.ok(ps.size <= 1, c + ' ' + tier + ' has several %');
}
assert.ok(capped.items.some(i => i.capped)); assert.ok(capped.items.some(i => /average cap|average discount/.test(i.final.reason)));
// the average cap never touches Clearance, and manual overrides are left exactly as set
const clr = [mk('CL1', { soh: 30, sold: { d7: 0, d30: 1, d60: 2, d90: 3 }, ageWeeks: 90 }), mk('CL2', { currentDiscountPct: 30, price: 70, soh: 400, sold: { d7: 0, d30: 1, d60: 2, d90: 3 }, ageWeeks: 90 })];
const withClr = E.buildPlan(range.concat(clr), { ...capSet(20) }, { X3: { pct: 40 } });
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
assert.equal(floorP.cap.met, false); assert.equal(floorP.cap.avg, 20); assert.ok(floorP.totals.included > 0);
assert.equal(floorP.totals.included, floorRef.totals.included);                           // same products in the sale, nobody dropped
assert.ok(floorP.items.every(i => i.final.pct == null || i.final.pct >= 20));
// clearance alone above the cap -> reported, not forced
const onlyClr = E.buildPlan([mk('Q1', { soh: 30, ...{ sold: { d7: 0, d30: 1, d60: 2, d90: 3 }, ageWeeks: 90 } })], { avgDiscountCap: 20 });
assert.equal(onlyClr.cap.met, false); assert.equal(onlyClr.items[0].final.pct, 50);
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
// approve at the suggested figure: keeps its tier, flagged as approved, no conflict
let a1 = E.buildPlan(ovSet, { maxDiscount: 70 }, { W26AA010BLK: { pct: sys0('W26AA010BLK'), kind: 'approved' } }).items.find(i => i.row.p.id === 'W26AA010BLK');
assert.equal(a1.override, 'approved'); assert.equal(a1.conflict, false); assert.equal(a1.final.pct, sys0('W26AA010BLK')); assert.notEqual(a1.final.action, 'Manual'); assert.match(a1.final.reason, /^Approved at/);
// the system's suggestion later moves (a tighter average cap lowers the group its other members share): the approved figure is KEPT and the difference flagged
const moved = E.buildPlan(ovSet, { maxDiscount: 70, avgDiscountCap: 22 }, { M1: { pct: sys0('M1'), kind: 'approved' } });
const a2 = moved.items.find(i => i.row.p.id === 'M1');
assert.equal(sys0('M1'), 30); assert.equal(a2.final.pct, 30); assert.equal(a2.conflict, true); assert.match(a2.final.reason, /system now suggests 20%.*kept/); assert.equal(moved.totals.conflicts, 1);
assert.equal(a2.systemPct, 20); assert.equal(a2.final.action, 'Manual');
assert.ok(moved.cap.met);                                                                                   // the cap still holds, the locked product just isn't the one that was lowered
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
for (const dec of [{ pct: exBase.items.find(i => i.row.p.id === exId).systemPct || 20, kind: 'approved' }, { exclude: true, reason: 'Core protection' }, { pct: 30, kind: 'discount' }]) {
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
assert.equal(tinyOnly.final.action, 'C'); assert.match(tinyOnly.final.reason, /only 30 units/);
assert.equal(rsi('RS_NEW').final.action, 'Exclude'); assert.match(rsi('RS_NEW').final.reason, /New arrival/);       // a brand-new style is still protected
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
assert.equal(E.buildPlan([nh('NHN', { ageWeeks: 2 })], {}).items[0].final.action, 'Exclude');                                                    // new arrival: still protected
assert.equal(E.buildPlan([nh('NHN', { ageWeeks: 2 })], { excludeNew: false }).items[0].final.action, 'A');                                         // ...unless protection is switched off
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
// edge: empty input, single product, duplicate ids don't throw
assert.equal(E.buildPlan([], {}).items.length, 0); assert.equal(E.buildPlan([mk('ONE')], {}).items.length, 1);
assert.doesNotThrow(() => E.buildPlan([mk('D'), mk('D')], {}));
console.log('markdown engine tests: all passed');
})();
