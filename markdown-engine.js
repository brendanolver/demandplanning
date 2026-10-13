// WNDRR Markdown Planner — recommendation engine.
// Pure functions only: no DOM, no network, no storage. The page loads this with a
// <script> tag (window.MarkdownEngine) and tests/markdown-engine.test.js runs the
// exact same file under Node. Everything is deterministic and explainable — each
// recommendation carries the factor scores and plain-English reasons behind it.
//
// Input product = ONE Shopify product/colour (never a size variant):
//   { id, name, colour, category, parentStyle, isCore, status, isGWP,
//     soh, sohCost, onOrder, sold:{d7,d30,d60,d90}, rrp, price, currentDiscountPct,
//     sizeCount, soldOutSizes, ageWeeks }
// Missing data is null/undefined and is handled explicitly (never silently zeroed).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MarkdownEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    // Initial assumptions from the brief — NOT proven optimal; tune against real decisions.
    weights: { cover: 30, velocity: 25, sellthrough: 15, broken: 15, age: 10, onOrder: 5 },
    periodDays: 30,                 // analysis window: 7 | 30 | 60 | 90
    saleDays: 10,                   // sale duration, for the baseline forecast
    allowedDiscounts: [20, 30, 40, 50, 60, 70],
    maxDiscount: 50,                // max EFFECTIVE discount vs original RRP
    excludeBelow: 35,               // clearance score under this stays full price
    groupBAt: 65,                   // score at/above this goes to the deeper Group B
    coreMode: 'protect',            // protect = Group A only | include | exclude
    existingReduced: 'retain',      // retain | reassess | exclude
    excludeNew: true,
    newProductDays: 42,             // arrivals younger than this are excluded
    coreConsistency: 'preferred',   // strict | preferred | independent
    minCategorySample: 6,           // smaller categories borrow strength from the whole range
    reducedThresholdPct: 10,        // current discount at/above this counts as "already reduced"
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = v => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  const round1 = v => Math.round(v * 10) / 10;

  function mergeSettings(s) {
    const out = { ...DEFAULTS, ...(s || {}) };
    out.weights = { ...DEFAULTS.weights, ...((s && s.weights) || {}) };
    out.allowedDiscounts = [...(out.allowedDiscounts || DEFAULTS.allowedDiscounts)].map(Number).sort((a, b) => a - b);
    return out;
  }

  // Mid-rank percentile of v within values: 0..1 (ties share the middle).
  function percentileRank(values, v) {
    if (!values.length) return 0.5;
    let lt = 0, eq = 0;
    for (const x of values) { if (x < v) lt++; else if (x === v) eq++; }
    return (lt + eq / 2) / values.length;
  }

  // ── Per-product metrics (all explicit about missing data) ───────────────────
  function metrics(p, S) {
    const sold = p.sold || {};
    const key = 'd' + S.periodDays;
    const periodUnits = Math.max(0, num(sold[key]) != null ? num(sold[key]) : num(sold.d30) || 0);
    const weeks = S.periodDays / 7;
    const weeklyRate = periodUnits / weeks;
    const soh = Math.max(0, num(p.soh) || 0);       // negative inventory is treated as zero
    // Zero sales must not produce a misleading cover number: null + noSales flag instead.
    const noSales = weeklyRate <= 0;
    const weeksCover = noSales ? null : Math.min(104, soh / weeklyRate);
    // Trend: last 7 days' daily rate against the 30-day daily rate. <1 = slowing.
    const d7 = Math.max(0, num(sold.d7) || 0), d30 = Math.max(0, num(sold.d30) || 0);
    const trendRatio = d30 > 0 ? (d7 / 7) / (d30 / 30) : null;
    // No stock-movement history exists, so true period sell-through is not available.
    // This proxy (units sold ÷ units sold + stock now) is labelled as such everywhere.
    const sellThroughProxy = periodUnits + soh > 0 ? periodUnits / (periodUnits + soh) : null;
    const sizeCount = num(p.sizeCount), sold_out = num(p.soldOutSizes);
    const brokenRatio = sizeCount > 0 && sold_out != null ? clamp(sold_out / sizeCount, 0, 1) : null;
    const onOrder = Math.max(0, num(p.onOrder) || 0);
    return { periodUnits, weeklyRate, soh, noSales, weeksCover, trendRatio, sellThroughProxy, brokenRatio, onOrder, ageWeeks: num(p.ageWeeks), d7, d30 };
  }

  // Age/season: young stock is not clearance; old stock is. Absolute, not relative.
  function ageScore(ageWeeks, status) {
    let s;
    if (ageWeeks == null) s = 50;
    else if (ageWeeks < 8) s = 0;
    else if (ageWeeks < 26) s = ((ageWeeks - 8) / 18) * 50;
    else if (ageWeeks < 52) s = 50 + ((ageWeeks - 26) / 26) * 30;
    else s = 100;
    if (String(status || '').toUpperCase() === 'OLD') s = Math.max(s, 75);
    return s;
  }

  // ── Scoring: factor scores 0-100 (higher = more clearance pressure), category-relative ──
  function scoreAll(products, settings) {
    const S = mergeSettings(settings);
    const ms = products.map(p => metrics(p, S));
    const idxByCat = {}, all = [];
    products.forEach((p, i) => {
      const c = p.category || 'UNCATEGORISED';
      (idxByCat[c] = idxByCat[c] || []).push(i);
      all.push(i);
    });
    // Percentile within the category, shrunk toward the whole-range percentile for small categories.
    function relPct(i, getter) {
      const c = products[i].category || 'UNCATEGORISED';
      const pool = idxByCat[c].map(j => getter(j)).filter(x => x != null);
      const whole = all.map(j => getter(j)).filter(x => x != null);
      const v = getter(i);
      if (v == null) return null;
      const catP = percentileRank(pool, v), allP = percentileRank(whole, v);
      const n = pool.length, k = S.minCategorySample;
      return n >= k ? catP : (n * catP + (k - n) * allP) / k;
    }
    const coverVal = j => ms[j].noSales ? (ms[j].soh > 0 ? 1e9 : null) : ms[j].weeksCover;
    const rateVal = j => ms[j].weeklyRate;
    const stVal = j => ms[j].sellThroughProxy;
    const W = S.weights, wsum = Object.values(W).reduce((a, b) => a + b, 0) || 1;

    return products.map((p, i) => {
      const m = ms[i];
      const cp = relPct(i, coverVal), rp = relPct(i, rateVal), sp = relPct(i, stVal);
      const trendScore = m.trendRatio == null ? 50 : clamp(((1.25 - m.trendRatio) / 1.0) * 100, 0, 100);
      const f = {
        cover: m.soh <= 0 ? 0 : m.noSales ? 100 : round1((cp == null ? 0.5 : cp) * 100),
        velocity: round1(0.6 * (rp == null ? 50 : (1 - rp) * 100) + 0.4 * trendScore),
        sellthrough: sp == null ? 50 : round1((1 - sp) * 100),
        broken: m.soh <= 0 || m.brokenRatio == null ? 0 : round1(clamp(m.brokenRatio / 0.5, 0, 1) * 100),
        age: round1(ageScore(m.ageWeeks, p.status)),
        onOrder: m.soh <= 0 ? 0 : round1(clamp(m.onOrder / Math.max(m.soh, 1), 0, 1) * 100),
      };
      const score = Math.round(Object.keys(W).reduce((a, k) => a + W[k] * f[k], 0) / wsum);
      const catN = idxByCat[p.category || 'UNCATEGORISED'].length;
      const hasRrp = num(p.rrp) > 0, ageKnown = m.ageWeeks != null;
      const pts = (m.periodUnits >= 8 ? 1 : 0) + (catN >= S.minCategorySample ? 1 : 0) + (hasRrp && ageKnown ? 1 : 0);
      return { p, m, f, score, confidence: pts >= 3 ? 'High' : pts === 2 ? 'Medium' : 'Low', catN };
    });
  }

  // ── Eligibility + group (A = lighter, B = deeper), with plain-English reasons ──
  function classify(row, S) {
    const { p, m, score } = row;
    const status = String(p.status || '').toUpperCase();
    const reasons = [];
    const exclude = r => ({ action: 'Exclude', reason: r, hard: true });   // hard = a rule, not a score: never overridden by colour linking
    if (p.isGWP) return exclude('Gift with purchase — never discounted');
    if (m.soh <= 0) return exclude('No stock on hand');
    if (S.excludeNew && ((m.ageWeeks != null && m.ageWeeks * 7 < S.newProductDays) || status === 'NEW' || status === 'PRE-RELEASE')) return exclude('New arrival — protected from markdown');
    if (p.isCore && S.coreMode === 'exclude') return exclude('Core product — excluded');
    const cur = num(p.currentDiscountPct) || 0;
    const alreadyReduced = cur >= S.reducedThresholdPct;
    if (alreadyReduced && S.existingReduced === 'exclude') return exclude('Already reduced (' + Math.round(cur) + '% off) — excluded by sale rules');
    if (score < S.excludeBelow) {
      const why = m.noSales ? 'low score' : m.weeksCover != null && m.weeksCover <= 8 ? 'only ' + round1(m.weeksCover) + ' weeks of cover' : 'healthy sales';
      return { action: 'Exclude', reason: 'Stays full price — ' + why + ' (score ' + score + ')', hard: false };
    }
    if (score >= S.groupBAt && !(p.isCore && S.coreMode === 'protect')) return { action: 'B', reason: describe(row) };
    const prot = p.isCore && S.coreMode === 'protect' ? ' (core: capped at Group A)' : '';
    return { action: 'A', reason: describe(row) + prot };
  }

  function describe(row) {
    const { m, f } = row;
    const bits = [];
    if (m.noSales) bits.push('no sales in ' + (m.periodUnits === 0 ? 'the period' : 'period') + ' with ' + m.soh + ' in stock');
    else if (m.weeksCover != null && f.cover >= 60) bits.push(round1(m.weeksCover) + ' weeks of cover');
    if (!m.noSales && f.velocity >= 60) bits.push(m.trendRatio != null && m.trendRatio < 0.75 ? 'slowing sales' : 'slow sales for the category');
    if (f.broken >= 50) bits.push('broken size run (' + Math.round((m.brokenRatio || 0) * 100) + '% sizes out)');
    if (f.age >= 70) bits.push('older stock');
    if (f.onOrder >= 50) bits.push('more stock on order');
    return bits.length ? bits.join(', ') : 'moderate overall clearance pressure';
  }

  // Allowed levels, capped at the max effective discount.
  function levels(S) {
    const l = S.allowedDiscounts.filter(d => d <= S.maxDiscount);
    return l.length ? l : [Math.min(...S.allowedDiscounts)];
  }

  function priceAt(p, pct) {
    const rrp = num(p.rrp) > 0 ? num(p.rrp) : null;
    const base = rrp != null ? rrp : (num(p.price) > 0 ? num(p.price) : null);
    return { base, rrpMissing: rrp == null, newPrice: base == null ? null : Math.round(base * (1 - pct / 100) * 100) / 100 };
  }

  // ── Whole-range plan ─────────────────────────────────────────────────────────
  function buildPlan(products, settings, overrides) {
    const S = mergeSettings(settings);
    const rows = scoreAll(products, S);
    const lv = levels(S);
    const items = rows.map(r => ({ row: r, ...classify(r, S) }));

    // Core colour consistency: all colours of a core parent style follow the style's group.
    if (S.coreConsistency !== 'independent') {
      const byStyle = {};
      items.forEach(it => { const p = it.row.p; if (p.isCore && p.parentStyle && !it.hard) (byStyle[p.parentStyle] = byStyle[p.parentStyle] || []).push(it); });
      for (const st of Object.keys(byStyle)) {
        const g = byStyle[st]; if (g.length < 2) continue;
        const stock = g.reduce((a, it) => a + it.row.m.soh, 0) || 1;
        const avg = g.reduce((a, it) => a + it.row.score * it.row.m.soh, 0) / stock;
        const target = avg >= S.excludeBelow ? (avg >= S.groupBAt && S.coreMode !== 'protect' ? 'B' : 'A') : 'Exclude';
        for (const it of g) {
          if (it.action !== target) {
            it.linkedFrom = it.action;
            it.exception = S.coreConsistency === 'preferred';   // Preferred: needs manual approval
            it.action = target;
            it.reason = target === 'Exclude' ? 'Core style average is healthy — colours kept consistent' : describe(it.row) + ' · colour linked to its core style group';
          }
        }
      }
    }

    // Per-category discount groups from the distribution of scores.
    const cats = {};
    items.forEach(it => { const c = it.row.p.category || 'UNCATEGORISED'; (cats[c] = cats[c] || []).push(it); });
    const catPlans = Object.keys(cats).sort().map(c => {
      const list = cats[c];
      const A = list.filter(it => it.action === 'A'), B = list.filter(it => it.action === 'B');
      const elig = A.concat(B);
      const stock = elig.reduce((a, it) => a + it.row.m.soh, 0);
      const pressure = stock > 0 ? elig.reduce((a, it) => a + it.row.score * it.row.m.soh, 0) / stock : 0;
      const aIdx = pressure < 50 ? 0 : Math.min(1, lv.length - 1);
      const bIdx = Math.min(lv.length - 1, aIdx + 2);
      return { category: c, items: list, pressure: Math.round(pressure), groupA: A.length ? lv[aIdx] : null, groupB: B.length ? lv[bIdx] : null };
    });

    // Apply category discounts (+ user overrides, never silently overwritten) to products.
    const ov = overrides || {};
    const catByName = Object.fromEntries(catPlans.map(cp => [cp.category, cp]));
    items.forEach(it => {
      const p = it.row.p, cp = catByName[p.category || 'UNCATEGORISED'];
      const sys = it.action === 'A' ? cp.groupA : it.action === 'B' ? cp.groupB : null;
      it.systemPct = sys;
      let pct = sys, action = it.action, reason = it.reason;
      // Existing markdown: never stack on a sale price — compare against RRP.
      const cur = num(p.currentDiscountPct) || 0;
      if (pct != null && S.existingReduced === 'retain' && cur >= S.reducedThresholdPct && cur >= pct) {
        action = 'Exclude'; pct = null; reason = 'Already reduced to ' + Math.round(cur) + '% off RRP — retained (sale ' + sys + '% would not be deeper)';
      }
      const o = ov[p.id];
      it.override = null;
      if (o) {
        if (o.exclude) { action = 'Exclude'; pct = null; reason = 'Manually excluded'; it.override = 'exclude'; }
        else if (o.pct != null) { action = o.pct === sys ? action : 'Manual'; pct = Math.min(Number(o.pct), S.maxDiscount); it.override = 'discount'; reason = 'Manual override (system suggested ' + (sys == null ? 'none' : sys + '%') + ')'; }
      }
      it.final = { action, pct, reason };
      const pr = pct != null ? priceAt(p, pct) : { base: priceAt(p, 0).base, rrpMissing: priceAt(p, 0).rrpMissing, newPrice: null };
      it.price = pr;
      it.forecast = baseline(it.row.m, S);
    });

    return { settings: S, items, categories: catPlans.map(cp => summarise(cp, S)), totals: totals(items) };
  }

  // Baseline only: recent run-rate over the sale length, capped at stock. NO promotional
  // uplift is applied — uplift needs calibration against past sales (a later phase).
  function baseline(m, S) {
    const units = Math.min(m.soh, Math.round(m.weeklyRate * (S.saleDays / 7)));
    return { units, remaining: Math.max(0, m.soh - units), kind: 'baseline (no promo uplift)' };
  }

  function summarise(cp, S) {
    const ms = cp.items.map(it => it.row);
    const soh = ms.reduce((a, r) => a + r.m.soh, 0);
    const units = ms.reduce((a, r) => a + r.m.periodUnits, 0);
    const rate = units / (S.periodDays / 7);
    const cost = cp.items.reduce((a, it) => a + (num(it.row.p.sohCost) || 0), 0);
    return {
      category: cp.category, products: cp.items.length, soh, sohCost: Math.round(cost), periodUnits: units,
      weeksCover: rate > 0 ? round1(soh / rate) : null,
      sellThroughProxy: units + soh > 0 ? round1(units / (units + soh) * 100) : null,
      groupA: cp.groupA, groupB: cp.groupB,
      countA: cp.items.filter(it => it.final.action === 'A').length,
      countB: cp.items.filter(it => it.final.action === 'B').length,
      countManual: cp.items.filter(it => it.final.action === 'Manual').length,
      countExcluded: cp.items.filter(it => it.final.action === 'Exclude').length,
      forecastUnits: cp.items.reduce((a, it) => a + it.forecast.units, 0),
      forecastRemaining: cp.items.reduce((a, it) => a + it.forecast.remaining, 0),
      pressure: cp.pressure,
    };
  }

  function totals(items) {
    const inc = items.filter(it => it.final.action !== 'Exclude');
    return {
      products: items.length, included: inc.length, excluded: items.length - inc.length,
      soh: items.reduce((a, it) => a + it.row.m.soh, 0),
      sohCost: Math.round(items.reduce((a, it) => a + (num(it.row.p.sohCost) || 0), 0)),
    };
  }

  return { DEFAULTS, mergeSettings, percentileRank, metrics, ageScore, scoreAll, classify, levels, priceAt, baseline, buildPlan };
});
