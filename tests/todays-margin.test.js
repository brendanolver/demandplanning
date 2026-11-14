// Tests for the dashboard's "Today's Margin" card (todays-margin.js).
const assert = require('assert');
const T = require('../todays-margin.js');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, (msg || '') + ' expected ' + b + ', got ' + a);

// ── reading today out of the feed's recent snapshot ───────────────────────────
const NOW = 1800000000000, HOUR = 3600000;
const recent = {
  data: { v: 1, days: ['2026-11-12', '2026-11-13', '2026-11-14'], skus: {
    'TEE-M': [1, 5, 29975, 29975, 2, 3, 17985, 15587],          // yesterday 5 at shelf; today 3: 2 at 20% off + 1 full price
    'towel-os': [2, 118, 944354, 8260],                         // today: 118 gifts, $80.03 on the shelf, 70c actually paid each
    'GIFT-OS': [2, 1, 2500, 0],                                 // a completely free item
    'NOPRICE-S': [2, 4, null, null],                            // sold today, Shopify recorded no price
    'OLD-L': [0, 9, 9000, 9000],                                // two days ago only
  } },
  meta: { lastDay: '2026-11-14', syncTs: NOW - 5 * 60000 },
};
const opts = { today: '2026-11-14', now: NOW, maxAgeMs: 3 * HOUR };
const a = T.actualsFor(recent, opts);
assert.deepEqual(a, {
  'TEE-M': { units: 3, gross: 179.85, net: 155.87 },
  'TOWEL-OS': { units: 118, gross: 9443.54, net: 82.6 },        // SKU matched in capitals
  'GIFT-OS': { units: 1, gross: 25, net: 0 },                   // $0 is a real answer, not "unknown"
  'NOPRICE-S': { units: 4, gross: null, net: null },
});
// not usable: nothing loaded, too old, from an earlier day, malformed
assert.equal(T.actualsFor(null, opts), null); assert.equal(T.actualsFor({}, opts), null); assert.equal(T.actualsFor({ data: recent.data }, opts), null);
assert.equal(T.actualsFor(recent, { today: '2026-11-14', now: NOW + 3 * HOUR, maxAgeMs: 3 * HOUR }), null);          // synced over 3 hours ago
assert.notEqual(T.actualsFor(recent, { today: '2026-11-14', now: NOW + 2 * HOUR, maxAgeMs: 3 * HOUR }), null);
assert.equal(T.actualsFor(recent, { today: '2026-11-15', now: NOW, maxAgeMs: 3 * HOUR }), null);                     // yesterday's snapshot, just after midnight
assert.equal(T.actualsFor({ data: recent.data, meta: { lastDay: '2026-11-14' } }, opts), null);                       // no sync time
assert.equal(T.actualsFor({ data: { days: 'x', skus: {} }, meta: recent.meta }, opts), null);
// current, but nothing sold yet today
assert.deepEqual(T.actualsFor({ data: { days: ['2026-11-13'], skus: { 'TEE-M': [0, 5, 29975, 29975] } }, meta: recent.meta }, opts), {});

// ── the margin ───────────────────────────────────────────────────────────────
const rows = [
  { sku: 'TEE-M', price: 59.95, margin: 70 },
  { sku: 'TOWEL-OS', price: 79.95, margin: 85 },
  { sku: 'GIFT-OS', price: 25, margin: 60 },
  { sku: 'NOPRICE-S', price: 44, margin: 50 },
  { sku: 'AMONLY-M', price: 50, margin: 50, amOnly: true },      // not yet in Shopify: never counted
  { sku: 'UNSOLD-L', price: 50, margin: 50 },
];
const day = { 'TEE-M': { qty: 3, cogs: 45 }, 'TOWEL-OS': { qty: 118, cogs: 0 }, 'GIFT-OS': { qty: 1, cogs: 0 }, 'NOPRICE-S': { qty: 4, cogs: 0 }, 'AMONLY-M': { qty: 2, cogs: 10 } };
const entry = sku => day[sku] || null;

// 1. With today's real takings
let m = T.compute(rows, entry, a);
const rev = (155.87 + 82.6 + 0) / 1.1 + (44 / 1.1) * 4;                                     // three priced SKUs at what was paid; the unpriced one at sell price
const cost = 45 + (79.95 / 1.1) * 0.15 * 118 + (25 / 1.1) * 0.4 * 1 + (44 / 1.1) * 0.5 * 4;  // recorded cost for the tee; implied from Margin% for the rest
near(m.revenue, rev, 'revenue'); near(m.cost, cost, 'cost'); assert.equal(m.units, 3 + 118 + 1 + 4);
near(m.pct, (rev - cost) / rev * 100, 'pct');
assert.equal(m.fallbackUnits, 4); assert.equal(m.usedActual, true);
near(m.atSellPrice, (59.95 * 3 + 79.95 * 118 + 25 + 44 * 4) / 1.1, 'at sell price');
assert.ok(m.atSellPrice > m.revenue * 10);                       // the gifts alone were "worth" over ten times what the day actually took
// the free gift and the towels still cost money: they pull the margin down, well below the tee's own
assert.ok(m.pct < 0, 'giving away 119 gifts on 7 paid units is a loss-making day: ' + m.pct);

// 2. The pre-v3.7.8 answer (and the fallback when the snapshot can't be used): every unit at current sell price
m = T.compute(rows, entry, null);
const revOld = (59.95 * 3 + 79.95 * 118 + 25 * 1 + 44 * 4) / 1.1;
near(m.revenue, revOld, 'sell-price revenue'); near(m.cost, cost, 'cost is the same either way');
assert.equal(m.usedActual, false); assert.equal(m.fallbackUnits, m.units); near(m.atSellPrice, m.revenue);
near(m.pct, (revOld - cost) / revOld * 100); assert.ok(m.pct > 80);                          // which is how free gifts made the old card read high

// 3. A plain discounted day: 20% off across the board moves a 70% margin to 62.5%
{
  const r = [{ sku: 'A', price: 110, margin: 70 }], e = () => ({ qty: 10, cogs: 0 });
  const full = T.compute(r, e, { A: { units: 10, gross: 1100, net: 1100 } }), off = T.compute(r, e, { A: { units: 10, gross: 1100, net: 880 } });
  near(full.pct, 70); near(off.pct, 62.5); near(off.revenue, 800); near(off.cost, 300); near(off.atSellPrice, 1000);
  near(T.compute(r, e, null).pct, 70);
}
// 4. Units come from the snapshot, so cost and revenue cover the same sales even if the app's own map is a sync behind
{
  const r = [{ sku: 'A', price: 110, margin: 70 }];
  const m4 = T.compute(r, () => ({ qty: 8, cogs: 240 }), { A: { units: 10, gross: 1100, net: 1100 } });   // map says 8 sold ($30 each), snapshot says 10
  assert.equal(m4.units, 10); near(m4.cost, 300); near(m4.revenue, 1000); near(m4.pct, 70);
  const m5 = T.compute(r, () => null, { A: { units: 10, gross: 1100, net: 1100 } });                      // not in the map at all yet: cost from Margin%
  near(m5.cost, 300); near(m5.pct, 70);
}
// 4b. …and a SKU the snapshot doesn't list isn't topped up from the app's map at sell price
{
  const r = [{ sku: 'A', price: 110, margin: 70 }, { sku: 'GIFT', price: 80, margin: 85 }];
  const m6 = T.compute(r, sku => (sku === 'GIFT' ? { qty: 5, cogs: 0 } : { qty: 10, cogs: 0 }), { A: { units: 10, gross: 1100, net: 1100 } });
  assert.equal(m6.units, 10); near(m6.revenue, 1000); near(m6.pct, 70); assert.equal(m6.fallbackUnits, 0);
}
// 5. Edges
assert.deepEqual(T.compute([], entry, a), { pct: null, revenue: 0, cost: 0, units: 0, atSellPrice: 0, fallbackUnits: 0, usedActual: false });
assert.equal(T.compute(rows, entry, {}).pct, null);                                          // snapshot is current but nothing has sold today
assert.equal(T.compute(rows, entry, {}).units, 0);
assert.equal(T.compute([{ sku: 'X', price: 0, margin: null }], () => ({ qty: 3, cogs: 0 }), null).units, 0);   // no price anywhere: can't be valued, left out
{ const z = T.compute([{ sku: 'X', price: 0, margin: null }], () => null, { X: { units: 3, gross: 90, net: 60 } }); assert.equal(z.units, 3); near(z.revenue, 60 / 1.1); assert.equal(z.cost, 0); }   // real takings, no cost known
assert.equal(T.compute(null, entry, a).units, 0); assert.equal(T.compute([null, undefined], null, null).units, 0);
assert.equal(T.compute([{ sku: 'tee-m', price: 59.95, margin: 70 }], () => null, a).units, 3);                // lower-case SKU in the app still matches

console.log("today's margin tests: all passed");
