// WNDRR Demand Planning — the dashboard's "Today's Margin" card.
// Gross profit as a share of what today's sales ACTUALLY sold for:
//   Revenue  what Shopify recorded as paid for each line after every discount — bundle deals, automatic discounts,
//            codes; a gift with purchase is (close to) $0 — taken ex GST. It comes from the sales feed's "recent"
//            snapshot (sales-price-data?span=recent), which carries units and money from the same sync run.
//   Cost     the day's recorded cost per unit where there is one, otherwise the cost implied by the product's own
//            Margin% at its sell price. Gifts cost what they cost, so giving them away lowers the margin, as it should.
//   Units    taken from the same snapshot as the revenue, so cost and revenue always describe the same sales.
// Until v3.7.8 revenue was today's units x each product's current sell price, which counted every discounted sale
// and every free gift at full sell price. That is still the fallback — for a line Shopify recorded without a
// price, or altogether when the snapshot can't be used — and the result says how much of it was a fallback.
// Pure functions only (no DOM, no network, no clock): the page loads this with a <script> tag
// (window.TodaysMargin) and tests/todays-margin.test.js runs the same file under Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TodaysMargin = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GST = 1.1;   // prices are GST-inclusive throughout the app; margin is worked out ex GST

  // Today's sales out of the feed's recent snapshot, by SKU: { SKU: { units, gross, net } } in dollars as Shopify
  // recorded them (gross = shelf price x units, net = actually paid; null where it gave no price).
  // recent = { data:{ days:[...], skus:{ SKU:[dayIdx, units, grossCents, netCents, ...] } }, meta:{ lastDay, syncTs } }
  // Returns null when the snapshot can't be trusted for `today`: missing, older than maxAgeMs, or from an earlier
  // day. An empty object means it is current and nothing has sold yet.
  function actualsFor(recent, opts) {
    const today = opts && opts.today, now = opts && opts.now, maxAgeMs = opts && opts.maxAgeMs;
    if (!recent || !recent.data || !recent.meta || !Array.isArray(recent.data.days) || !recent.data.skus) return null;
    const ts = recent.meta.syncTs;
    if (!ts || !today || recent.meta.lastDay !== today) return null;
    if (maxAgeMs != null && now != null && now - ts > maxAgeMs) return null;
    const out = {}, idx = recent.data.days.indexOf(today);
    if (idx < 0) return out;
    for (const sku of Object.keys(recent.data.skus)) {
      const a = recent.data.skus[sku];
      for (let i = 0; i + 3 < a.length; i += 4) {
        if (a[i] !== idx) continue;
        out[String(sku).toUpperCase()] = { units: a[i + 1], gross: a[i + 2] == null ? null : a[i + 2] / 100, net: a[i + 3] == null ? null : a[i + 3] / 100 };
        break;
      }
    }
    return out;
  }

  // rows      [{ sku, price (current sell price, GST-inclusive), margin (% or null), amOnly }] — one per variant
  // dayEntry  sku => { qty, cogs } for today from the app's own sales map (or null)
  // actuals   actualsFor()'s result, or null to value everything at sell price
  // → { pct|null, revenue, cost, units, atSellPrice, fallbackUnits, usedActual }   (money ex GST)
  function compute(rows, dayEntry, actuals) {
    const t = { pct: null, revenue: 0, cost: 0, units: 0, atSellPrice: 0, fallbackUnits: 0, usedActual: false };
    for (const r of rows || []) {
      if (!r || r.amOnly) continue;
      const entry = dayEntry ? dayEntry(r.sku) : null;
      const paid = actuals ? actuals[String(r.sku || '').toUpperCase()] : null;
      // With a usable snapshot it is the one record of today: a SKU it doesn't list hasn't sold as far as it knows.
      // (Topping it up from the app's own map would value a just-sold gift at full sell price until the next sync.)
      const qty = actuals ? (paid ? paid.units : 0) : (entry && entry.qty) || 0;
      if (!(qty > 0)) continue;
      const sell = r.price > 0 ? r.price / GST : 0;
      const havePaid = !!paid && paid.net != null;
      if (!havePaid && sell <= 0) continue;                        // nothing to value this sale at
      t.revenue += havePaid ? paid.net / GST : sell * qty;
      t.units += qty;
      t.atSellPrice += sell * qty;
      if (!havePaid) t.fallbackUnits += qty;
      if (entry && entry.cogs > 0 && entry.qty > 0) t.cost += entry.cogs / entry.qty * qty;
      else if (r.margin != null && sell > 0) t.cost += sell * (1 - r.margin / 100) * qty;
    }
    t.pct = t.revenue > 0 ? (t.revenue - t.cost) / t.revenue * 100 : null;
    t.usedActual = !!actuals && t.units > t.fallbackUnits;         // at least some of it is real takings
    return t;
  }

  return { actualsFor, compute, GST };
});
