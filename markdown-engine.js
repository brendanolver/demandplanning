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
    maxDiscount: 50,                // highest SINGLE-product effective discount vs original RRP
    avgDiscountCap: null,           // TARGET for the sale's AVERAGE effective discount (unit-weighted, styles in the sale): lowered if above, raised to get as close as possible without going over; null = none
    scope: 'recommended',           // recommended = healthy sellers stay full price | all = every eligible in-stock style joins at the lightest level
    excludeBelow: 35,               // clearance score under this stays full price
    groupBAt: 65,                   // score at/above this goes to the deeper Group B
    coreMode: 'protect',            // protect = Group A only | include | exclude
    existingReduced: 'clearance',   // clearance (move to the clearance %) | retain | reassess | exclude
    clearanceDiscount: 50,          // fixed % for the Clearance tier (capped by maxDiscount)
    minStockUnits: 50,              // under this with nothing on order = a remnant -> Clearance
    brokenSizesClearance: 4,        // this many sizes sold out (or more) = broken run -> Clearance
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
    // Planning stock = what is on the shelf now PLUS stock restocking a sold-out product by the sale
    // (restockUnits, set by the caller from the sale's incoming-stock setting). 'sohNow' is the real SOH.
    const sohNow = Math.max(0, num(p.soh) || 0);       // negative inventory is treated as zero
    const restock = Math.max(0, num(p.restockUnits) || 0);
    const soh = sohNow + restock;
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
    return { periodUnits, weeklyRate, soh, sohNow, restock, noSales, weeksCover, trendRatio, sellThroughProxy, brokenRatio, onOrder, ageWeeks: num(p.ageWeeks), d7, d30 };
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
    const idxByCat = {};
    // Items that can't be scored — gift-with-purchase, special buys (priced by choice) and restocks with no
    // sales history — must never shape the category's "typical" cover/velocity/sell-through, or they would
    // silently shift every OTHER product's score. They are still scored, but against pools they aren't in.
    const scorable = i => { const p = products[i]; return !p.isGWP && p.specialPct == null && !(ms[i].restock > 0 && !(num((p.sold || {}).d90) > 0)); };
    const poolByCat = {}, poolAll = [];
    products.forEach((p, i) => {
      const c = p.category || 'UNCATEGORISED';
      (idxByCat[c] = idxByCat[c] || []).push(i);
      if (scorable(i)) { (poolByCat[c] = poolByCat[c] || []).push(i); poolAll.push(i); }
    });
    // Percentile within the category, shrunk toward the whole-range percentile for small categories.
    function relPct(i, getter) {
      const c = products[i].category || 'UNCATEGORISED';
      const pool = (poolByCat[c] || []).map(j => getter(j)).filter(x => x != null);
      const whole = poolAll.map(j => getter(j)).filter(x => x != null);
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
      const catN = (poolByCat[p.category || 'UNCATEGORISED'] || []).length;
      const hasRrp = num(p.rrp) > 0, ageKnown = m.ageWeeks != null || p.isCore;   // evergreen core lines have no launch date by design
      const pts = (m.periodUnits >= 8 ? 1 : 0) + (catN >= S.minCategorySample ? 1 : 0) + (hasRrp && ageKnown ? 1 : 0);
      // A sold-out product's recent sales are understated by the stock-out and there is no stock history to correct them, so restocks are never better than Low.
      return { p, m, f, score, confidence: m.restock > 0 ? 'Low' : pts >= 3 ? 'High' : pts === 2 ? 'Medium' : 'Low', catN };
    });
  }

  // ── Eligibility + group (A = lighter, B = deeper), with plain-English reasons ──
  function classify(row, S) {
    const { p, m, score } = row;
    const status = String(p.status || '').toUpperCase();
    const reasons = [];
    const exclude = r => ({ action: 'Exclude', reason: r, hard: true });   // hard = a rule, not a score: never overridden by colour linking
    if (p.isGWP) return exclude('Gift with purchase — never discounted');
    if (p.notOnSale) return exclude('Not on sale — keeps its current price');   // picked in the Not on sale step (collection / category / style)
    if (m.soh <= 0) return exclude('No stock on hand');
    // Special buys are bought FOR this sale at a chosen discount: never scored against sales history
    // (they have none), never protected as "new arrivals", and never cleared as remnants.
    // Stock arriving for a sold-out product with NO sales in 90 days can't be scored; see the default below.
    const noHistory = m.restock > 0 && !(num((p.sold || {}).d90) > 0);
    if (p.specialPct != null) return { action: 'S', reason: 'Special buy — ' + (p.specialNote || 'chosen for this sale') + ' at ' + p.specialPct + '%', hard: false };
    // New-arrival protection is for product already on the shelf. Stock ARRIVING for the sale (a restock) is exempt —
    // it is being bought to sell in this promotion, so a recent/future launch date doesn't hold it out.
    if (S.excludeNew && !(m.restock > 0) && ((m.ageWeeks != null && m.ageWeeks * 7 < S.newProductDays) || status === 'NEW' || status === 'PRE-RELEASE')) return exclude('New arrival — protected from markdown');
    if (p.isCore && S.coreMode === 'exclude') return exclude('Core product — excluded');
    const cur = num(p.currentDiscountPct) || 0;
    const alreadyReduced = cur >= S.reducedThresholdPct;
    const clearPct = clearanceLevel(S);
    if (alreadyReduced && S.existingReduced === 'exclude') return exclude('Already reduced (' + Math.round(cur) + '% off) — excluded by sale rules');
    if (alreadyReduced && S.existingReduced === 'clearance') {
      // Reduced stock goes to the clearance level; anything already at/over it simply stays.
      // Group C = existing reduced, fixed at the clearance level (50%). One already deeper is a PROTECTED exception: it keeps its deeper discount.
      if (cur > clearPct + 0.5) return { action: 'P', reason: 'Already ' + Math.round(cur) + '% off — deeper than Group C (' + clearPct + '%): kept as is (protected)', hard: true };
      return { action: 'C', reason: cur >= clearPct - 0.5 ? 'Already ' + Math.round(cur) + '% off — Group C, stays at ' + clearPct + '% (no price change)' : 'Already reduced (' + Math.round(cur) + '% off) — Group C at ' + clearPct + '%', hard: false };
    }
    // ...so it defaults to the category's LIGHTEST offer (Group A) rather than being left out. New-arrival
    // protection (above) still applies, and a manual decision or special buy still wins.
    if (noHistory) return { action: 'A', reason: 'No sales history to judge it by — defaulted to the lowest discount in its category (Group A)', hard: false, defaultA: true };
    const healthy = score < S.excludeBelow;
    if (healthy && S.scope !== 'all') {
      const why = m.noSales ? 'low score' : m.weeksCover != null && m.weeksCover <= 8 ? 'only ' + round1(m.weeksCover) + ' weeks of cover' : 'healthy sales';
      return { action: 'Exclude', reason: 'Stays full price — ' + why + ' (score ' + score + ')', hard: false };
    }
    // Not a healthy seller, but not worth a normal markdown tier either: a remnant (few units,
    // nothing coming) or a broken size run is simply cleared out at the clearance level.
    // (A healthy seller is never cleared just for being low on stock, even when every style is on sale.)
    const remnant = m.soh < S.minStockUnits && m.onOrder <= 0;
    const broken = (num(p.soldOutSizes) || 0) >= S.brokenSizesClearance;
    if (!healthy && (remnant || broken)) {
      const why = broken && remnant ? 'only ' + m.soh + ' units and ' + p.soldOutSizes + ' sizes sold out' : broken ? p.soldOutSizes + ' sizes sold out' : 'only ' + m.soh + ' units and none on order';
      return { action: 'B', reason: 'Clearance candidate — ' + why + ' (Group B)', hard: false, clearance: true };   // remnants / broken size runs are Group B (clearance markdown); Group C is for products ALREADY reduced
    }
    if (score >= S.groupBAt && !(p.isCore && S.coreMode === 'protect')) return { action: 'B', reason: describe(row) };
    const prot = p.isCore && S.coreMode === 'protect' ? ' (core: capped at Group A)' : '';
    return { action: 'A', reason: (healthy ? 'Healthy seller — joins at the lightest level (all styles on sale)' : describe(row)) + prot };
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

  // The clearance % actually used: the largest allowed level not above the clearance target or the max.
  function clearanceLevel(S) {
    const cap = Math.min(S.clearanceDiscount, S.maxDiscount);
    const l = S.allowedDiscounts.filter(d => d <= cap);
    return l.length ? l[l.length - 1] : Math.min(...S.allowedDiscounts);
  }

  function priceAt(p, pct) {
    const rrp = num(p.rrp) > 0 ? num(p.rrp) : null;
    const base = rrp != null ? rrp : (num(p.price) > 0 ? num(p.price) : null);
    return { base, rrpMissing: rrp == null, newPrice: base == null ? null : Math.round(base * (1 - pct / 100) * 100) / 100 };
  }

  // ── Whole-range plan ─────────────────────────────────────────────────────────
  function buildPlan(products, settings, overrides, groupLevels, frozen) {
    const S = mergeSettings(settings);
    const rows = scoreAll(products, S);
    const lv = levels(S);
    const items = rows.map(r => {
      const c = classify(r, S);
      if (r.m.restock > 0 && !c.hard) c.reason = 'Restock — ' + r.m.restock.toLocaleString() + ' units arriving by the sale · ' + c.reason;
      return { row: r, ...c };
    });

    // Allocations saved when a category was approved (or reopened): { productId: 'A'|'B'|'C'|'Exclude' }. They hold a product in the
    // group it was approved in, so a data refresh can't silently move it. Rules (GWP, no stock, special buys) still win.
    if (frozen) for (const it of items) {
      const fz = frozen[it.row.p.id];
      const stillReduced = (num(it.row.p.currentDiscountPct) || 0) >= S.reducedThresholdPct;   // Group C = already reduced: a saved C stops holding once the product isn't
      if (fz && !it.hard && it.action !== 'S' && !it.row.p.isGWP && ['A', 'B', 'C', 'Exclude'].includes(fz) && !(fz === 'C' && !stillReduced) && fz !== it.action) {
        it.action = fz; it.frozen = true; it.reason = fz === 'Exclude' ? 'Kept out of the sale — saved when the category was approved' : 'Kept in its approved group — saved when the category was approved';
      } else if (fz && fz === it.action) it.frozen = true;
    }

    // Core colour consistency: all colours of a core parent style follow the style's group.
    if (S.coreConsistency !== 'independent') {
      const byStyle = {};
      items.forEach(it => { const p = it.row.p; if (p.isCore && p.parentStyle && !it.hard && !it.frozen && !it.clearance && it.action !== 'C' && it.action !== 'P' && it.action !== 'S') (byStyle[p.parentStyle] = byStyle[p.parentStyle] || []).push(it); });
      for (const st of Object.keys(byStyle)) {
        const g = byStyle[st]; if (g.length < 2) continue;
        const stock = g.reduce((a, it) => a + it.row.m.soh, 0) || 1;
        const avg = g.reduce((a, it) => a + it.row.score * it.row.m.soh, 0) / stock;
        const target = avg >= S.excludeBelow || S.scope === 'all' ? (avg >= S.groupBAt && S.coreMode !== 'protect' ? 'B' : 'A') : 'Exclude';
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

    // Group B can be switched off for a category (groupLevels[cat].B === 0): the products the planner would put in B stay in Group A.
    // Count them first so the UI can still say what the planner recommends.
    const recB = {}, noB = {};
    for (const it of items) {
      const c = it.row.p.category || 'UNCATEGORISED', gB = groupLevels && groupLevels[c] ? groupLevels[c].B : null;
      if (it.action === 'B') recB[c] = (recB[c] || 0) + 1;
      if (gB != null && gB !== '' && Number(gB) === 0) noB[c] = true;
    }
    for (const it of items) {
      const c = it.row.p.category || 'UNCATEGORISED';
      if (noB[c] && it.action === 'B' && !it.hard) { it.action = 'A'; it.reason = it.reason + ' · Group B is switched off for this category'; }
    }

    // Per-category discount groups from the distribution of scores.
    const cats = {};
    items.forEach(it => { const c = it.row.p.category || 'UNCATEGORISED'; (cats[c] = cats[c] || []).push(it); });
    const catPlans = Object.keys(cats).sort().map(c => {
      const list = cats[c];
      const A = list.filter(it => it.action === 'A'), B = list.filter(it => it.action === 'B');
      const elig = A.filter(it => !it.defaultA).concat(B);   // defaulted (no-history) items follow the group but don't set its level
      const stock = elig.reduce((a, it) => a + it.row.m.soh, 0);
      const pressure = stock > 0 ? elig.reduce((a, it) => a + it.row.score * it.row.m.soh, 0) / stock : 0;
      const aIdx = elig.length && pressure >= 50 ? Math.min(1, lv.length - 1) : 0;
      const bIdx = Math.min(lv.length - 1, aIdx + 2);
      // Your own level for a category's Group A / B ("set by you"): products in the group are then suggested from it.
      const gl = (groupLevels && groupLevels[c]) || {}, mp = v => { const n = Number(v); return v != null && v !== '' && isFinite(n) && n > 0 ? Math.min(n, S.maxDiscount) : null; };
      const manual = { A: mp(gl.A), B: mp(gl.B) };
      return { category: c, noB: !!noB[c], recB: recB[c] || 0, items: list, pressure: Math.round(pressure), idx: { A: A.length ? aIdx : null, B: B.length ? bIdx : null }, startIdx: { A: aIdx, B: bIdx }, manual,
        autoA: A.length ? lv[aIdx] : null, autoB: (B.length || recB[c]) ? lv[bIdx] : null,
        groupA: A.length ? lv[aIdx] : null, groupB: B.length ? lv[bIdx] : null };
    });
    const catByName = Object.fromEntries(catPlans.map(cp => [cp.category, cp]));
    const ov = overrides || {};
    const clearPct = clearanceLevel(S);
    // A level you set wins. The other group is then kept on the right side of it: Group B at least one allowed level
    // deeper than A, A at least one shallower than B (only a level you set on BOTH can break that, and it is flagged).
    const levelOf = (cp, tier) => {
      if (cp.manual[tier] != null) return cp.manual[tier];
      let v = lv[cp.idx[tier] != null ? cp.idx[tier] : cp.startIdx[tier]];
      if (tier === 'B' && cp.manual.A != null && v <= cp.manual.A) { const up = lv.find(d => d > cp.manual.A); if (up != null) v = up; }
      if (tier === 'A' && cp.manual.B != null && v >= cp.manual.B) { const dn = lv.filter(d => d < cp.manual.B); if (dn.length) v = dn[dn.length - 1]; }
      return v;
    };
    const groupPct = (cp, tier) => {
      if (cp.idx[tier] == null) return null;
      if (cp.manual[tier] != null) return cp.manual[tier];
      let v = lv[cp.idx[tier]];
      if (tier === 'B' && cp.manual.A != null && cp.idx.A != null && v <= cp.manual.A) { const up = lv.find(d => d > cp.manual.A); if (up != null) v = up; }
      if (tier === 'A' && cp.manual.B != null && cp.idx.B != null && v >= cp.manual.B) { const dn = lv.filter(d => d < cp.manual.B); if (dn.length) v = dn[dn.length - 1]; }
      return v;
    };

    // What each product ends up as, given the CURRENT group levels (user overrides are
    // applied last and never silently overwritten).
    function resolve(it) {
      const p = it.row.p, cp = catByName[p.category || 'UNCATEGORISED'];
      const sys = it.action === 'A' ? groupPct(cp, 'A') : it.action === 'B' ? groupPct(cp, 'B') : it.action === 'C' ? clearPct : it.action === 'P' ? Math.round((num(p.currentDiscountPct) || 0) * 10) / 10 : it.action === 'S' ? Math.min(p.specialPct, S.maxDiscount) : null;
      let pct = sys, action = it.action, reason = it.reason;
      const cur = num(p.currentDiscountPct) || 0;
      if ((it.action === 'A' || it.action === 'B') && cp.manual[it.action] != null) reason += ' · category Group ' + it.action + ' level set by you';
      else if ((it.action === 'A' || it.action === 'B') && cp.idx[it.action] < cp.startIdx[it.action]) reason += ' · level lowered to meet the ' + S.avgDiscountCap + '% average target';
      else if ((it.action === 'A' || it.action === 'B') && cp.idx[it.action] > cp.startIdx[it.action]) reason += ' · level raised to approach the ' + S.avgDiscountCap + '% average target';
      // Existing markdown: never stack on a sale price — compare against RRP.
      if (pct != null && S.existingReduced === 'retain' && cur >= S.reducedThresholdPct && cur >= pct) {
        action = 'Exclude'; pct = null; reason = 'Already reduced to ' + Math.round(cur) + '% off RRP — retained (sale ' + sys + '% would not be deeper)';
      }
      // Your decisions. An override is one of: exclude (with a reason), a fixed discount ('discount' =
      // typed in, 'approved' = a suggestion you locked), or a move to another group (follows that
      // group's level). They are applied last and never silently overwritten; if the system's
      // suggestion later moves away from an APPROVED discount, your figure is kept and flagged.
      // Never automatically reduce a discount the product already has in Shopify (measured against RRP, never stacked): the proposed discount is at
      // least the current one. It is kept as an exception (not a warning); a current discount deeper than the sale's highest single discount is flagged for review
      // rather than raised in price. Only an explicit decision of yours can lower it (that raises the price).
      let keptExisting = false;
      if (pct != null && action !== 'Exclude' && cur > pct + 0.5) { pct = Math.round(cur * 10) / 10; keptExisting = true; reason += ' · already ' + Math.round(cur) + '% off — never reduced'; }
      // 'Approved at the suggested figure' (and 'confirmed stays out') were per-product approvals from the old workflow. Approval is now per category, so
      // they no longer pin anything — they're kept in the saved data but ignored. Only real decisions (a typed discount, a group move, an exclusion) apply.
      const o0 = ov[p.id], o = o0 && (o0.kind === 'approved' || (o0.exclude && o0.confirm)) ? null : o0;
      let override = null, conflict = false, blocked = null;
      if (p.isGWP && p.specialPct != null) blocked = 'GWP';
      if (p.notOnSale && p.specialPct != null && !p.isGWP) blocked = 'NOS';   // Not on sale AND a discounted special buy: needs a decision, never silently discounted   // a GWP product also set up as a discounted special buy: a blocking conflict
      if (o && p.isGWP) {
        blocked = 'GWP';          // gift-with-purchase can never be discounted, whatever was saved
      } else if (o && p.notOnSale) {
        // Not on sale wins: the saved decision is KEPT (it applies again if the product is put back in the sale) but nothing is applied now
      } else if (o) {
        if (o.exclude && o.confirm) { action = 'Exclude'; pct = null; reason = 'Confirmed: stays out of the sale — ' + reason; override = 'confirmed'; }   // you confirmed the planner's "not in the sale"
        else if (o.exclude) { action = 'Exclude'; pct = null; reason = 'Excluded — ' + (o.reason || 'your decision') + (o.note ? ' (' + o.note + ')' : ''); override = 'exclude'; }
        else if (o.group === 'A' || o.group === 'B' || o.group === 'C') {
          const grp = o.group === 'B' && cp.noB ? 'A' : o.group;   // Group B is switched off for this category
          pct = Math.min(grp === 'C' ? clearPct : levelOf(cp, grp), S.maxDiscount); action = grp; override = 'group';
          reason = 'Moved to ' + (grp === 'C' ? 'Clearance' : 'Group ' + grp) + ' by you — follows that group\'s level';
        } else if (o.pct != null) {
          pct = Math.min(Number(o.pct), S.maxDiscount);
          override = o.kind === 'approved' ? 'approved' : 'discount';
          action = override === 'approved' && pct === sys ? action : 'Manual';   // a typed figure is always a manual override, even if it lands on the suggestion
          conflict = override === 'approved' && pct !== sys;
          reason = override === 'approved'
            ? (conflict ? 'Approved at ' + pct + '% — the system now suggests ' + (sys == null ? 'no discount' : sys + '%') + '; your approved figure is kept' : 'Approved at ' + pct + '%')
            : 'Manual override (system suggested ' + (sys == null ? 'none' : sys + '%') + ')';
        }
      }
      return { sys, cur, override, conflict, blocked, keptExisting: keptExisting && !override, final: { action, pct, reason } };
    }
    const avgNow = () => {
      let num_ = 0, den = 0;
      for (const it of items) { const r = resolve(it).final; if (r.pct != null) { num_ += r.pct * it.row.m.soh; den += it.row.m.soh; } }
      return den > 0 ? num_ / den : 0;
    };

    // Average effective discount cap: lower whole category GROUPS (never single products, so each
    // category keeps one consistent offer), healthiest group first, one allowed level at a time.
    // Clearance, manual overrides and already-reduced prices are never touched, and nobody is
    // dropped from the sale to hit the number (once every group is at the lowest allowed level
    // dropping groups cannot lower the average anyway). If the cap is still out of reach it is
    // reported with the lowest achievable average, never forced.
    let cap = null;
    if (S.avgDiscountCap != null) {
      const capPct = S.avgDiscountCap;
      const groupsLive = () => {
        const out = [];
        for (const cp of catPlans) for (const t of ['A', 'B']) {
          if (cp.idx[t] == null || cp.idx[t] <= 0 || cp.manual[t] != null) continue;
          if (t === 'B' && cp.idx.A != null && cp.idx.B - 1 <= cp.idx.A) continue;   // Group B always stays at least one level deeper than Group A
          const all = cp.items.filter(it => it.action === t && !ov[it.row.p.id]);
          if (!all.length) continue;
          const members = all.filter(it => !it.defaultA);
          const stock = members.reduce((a, it) => a + it.row.m.soh, 0) || 1;
          out.push({ cp, t, mean: members.length ? members.reduce((a, it) => a + it.row.score * it.row.m.soh, 0) / stock : -1, idx: cp.idx[t] });
        }
        return out;
      };
      const order = (a, b) => a.mean - b.mean || b.idx - a.idx || a.cp.category.localeCompare(b.cp.category) || (a.t < b.t ? -1 : 1);
      let steps = 0;
      while (avgNow() > capPct + 1e-9 && steps < 5000) {
        const g = groupsLive().sort(order)[0];
        if (!g) break;                       // every group is already at the lowest allowed level
        g.cp.idx[g.t] = g.idx - 1; steps++;
      }
      // The average is a TARGET, not just a ceiling: if the plan now sits below it, raise whole category groups
      // one allowed level at a time — the groups that most need discounting first — taking only steps that keep the
      // average at or under the target, until no further step fits. Then it lands as close as the levels allow
      // without going over. Levels never exceed the highest single discount, and Group A never goes deeper than B.
      let raised = 0;
      if (avgNow() < capPct - 1e-9) {
        const sums = cp => { let n = 0, d = 0; for (const it of cp.items) { const f = resolve(it).final; if (f.pct != null) { n += f.pct * it.row.m.soh; d += it.row.m.soh; } } return { n, d }; };
        const need = (cp, t) => {
          const mem = cp.items.filter(it => it.action === t && !ov[it.row.p.id] && !it.defaultA);
          const st = mem.reduce((a, it) => a + it.row.m.soh, 0);
          return mem.length && st ? mem.reduce((a, it) => a + it.row.score * it.row.m.soh, 0) / st : -1;
        };
        let N = 0, D = 0;
        for (const it of items) { const f = resolve(it).final; if (f.pct != null) { N += f.pct * it.row.m.soh; D += it.row.m.soh; } }
        for (let guard = 0; guard < 2000; guard++) {
          const avg = D > 0 ? N / D : 0;
          let best = null;
          for (const cp of catPlans) for (const t of ['A', 'B']) {
            const i0 = cp.idx[t];
            if (i0 == null || i0 >= lv.length - 1 || cp.manual[t] != null) continue;
            if (t === 'A' && cp.idx.B != null && i0 + 1 >= cp.idx.B) continue;   // Group A stays at least one level shallower than B
            const before = sums(cp); cp.idx[t] = i0 + 1; const after = sums(cp); cp.idx[t] = i0;
            const nN = N - before.n + after.n, nD = D - before.d + after.d, nAvg = nD > 0 ? nN / nD : 0;
            if (nAvg > capPct + 1e-9 || nAvg <= avg + 1e-9) continue;
            const m = need(cp, t);
            if (!best || m > best.m || (m === best.m && nAvg > best.nAvg) || (m === best.m && nAvg === best.nAvg && cp.category < best.cp.category)) best = { cp, t, i0, m, nAvg, nN, nD };
          }
          if (!best) break;
          best.cp.idx[best.t] = best.i0 + 1; N = best.nN; D = best.nD; raised++;
        }
      }
      const a = avgNow();
      cap = { cap: capPct, avg: Math.round(a * 10) / 10, met: a <= capPct + 1e-9, steps, raised, gap: Math.round((capPct - a) * 10) / 10 };
    }

    items.forEach(it => {
      const p = it.row.p, r = resolve(it), cp = catByName[p.category || 'UNCATEGORISED'];
      it.systemPct = r.sys; it.override = r.override; it.conflict = r.conflict; it.blocked = r.blocked; it.final = r.final;
      it.keptExisting = r.keptExisting; it.currentPct = r.cur;
      it.overCap = r.cur > S.maxDiscount + 0.5 && r.cur > 0;                  // an existing price deeper than the sale's cap: flagged for review, never auto-raised
      it.priceUp = r.final.pct != null && r.cur > 0 && r.final.pct < r.cur - 0.5;               // an explicit decision that puts the price up
      if (it.exception && r.override) { it.exception = false; it.exceptionResolved = true; }   // your decision resolves a core-colour exception
      const pct = r.final.pct;
      const pr = pct != null ? priceAt(p, pct) : { base: priceAt(p, 0).base, rrpMissing: priceAt(p, 0).rrpMissing, newPrice: null };
      it.price = pr;
      it.noPriceChange = pct != null && r.cur >= pct - 0.5 && r.cur > 0;
      it.capped = (it.action === 'A' || it.action === 'B') && cp.idx[it.action] < cp.startIdx[it.action];
      it.levelRaised = (it.action === 'A' || it.action === 'B') && cp.idx[it.action] > cp.startIdx[it.action];
      it.forecast = baseline(it.row.m, S);
      // Group membership is its own field (never inferred from the percentage): A / B / C, or X = an exception (a protected deeper discount, a kept existing
      // discount, or a typed discount that fits none of the groups). null = not in the standard A/B/C split (GWP, excluded, special buy).
      const lv3 = { A: levelOf(cp, 'A'), B: cp.noB ? null : levelOf(cp, 'B'), C: clearPct };
      const fits = g => lv3[g] != null && pct != null && Math.abs(lv3[g] - pct) < 0.05;
      let grp = null, xk = null;
      if (p.isGWP || pct == null || r.final.action === 'Exclude') grp = null;
      else if (it.override === 'group') grp = r.final.action;                                    // you moved it
      else if (it.override === 'discount') {                                                    // you typed a discount: it keeps its saved group; a figure that fits no group is a manual exception
        if (it.action === 'S') grp = null;
        else if (['A', 'B', 'C'].includes(it.action)) { const base = it.action === 'B' && cp.noB ? 'A' : it.action; grp = fits(base) ? base : 'X'; }
        else grp = ['A', 'B', 'C'].find(fits) || 'X';
        if (grp === 'X') xk = 'manual';
      } else if (r.final.action === 'S') grp = null;
      else if (r.final.action === 'P') { grp = 'X'; xk = 'protected'; }
      else if (r.keptExisting) { grp = 'X'; xk = 'kept'; }
      else grp = ['A', 'B', 'C'].includes(r.final.action) ? r.final.action : null;
      it.group = grp; it.exceptionKind = xk;
    });
    catPlans.forEach(cp => { cp.groupA = groupPct(cp, 'A'); cp.groupB = groupPct(cp, 'B'); cp.levelA = levelOf(cp, 'A'); cp.levelB = cp.noB ? 0 : levelOf(cp, 'B'); });

    const tot = totals(items);
    Object.assign(tot, effective(items));
    if (cap) { tot.avgDiscount = cap.avg; }
    else { tot.avgDiscount = avgFromItems(items); }
    return { settings: S, items, categories: catPlans.map(cp => summarise(cp, S)), totals: tot, cap };
  }

  // The EFFECTIVE discount, as one live figure: the RRP value of every unit in the sale less the discount suggested on it,
  // expressed as a % of that RRP value (so a deep discount on an expensive style weighs more than on a cheap one).
  function effective(items) {
    let units = 0, rrpValue = 0, off = 0;
    for (const it of items) {
      const pct = it.final.pct; if (pct == null) continue;
      const base = it.price && it.price.base != null ? it.price.base : 0, u = it.row.m.soh;
      if (!(u > 0) || !(base > 0)) continue;
      units += u; rrpValue += u * base; off += u * base * pct / 100;
    }
    return { effectiveDiscount: rrpValue > 0 ? Math.round(off / rrpValue * 1000) / 10 : 0, effUnits: units, effRrpValue: Math.round(rrpValue), effOffValue: Math.round(off), effSaleValue: Math.round(rrpValue - off) };
  }

  // Unit-weighted average effective discount over the products actually in the sale.
  function avgFromItems(items) {
    let n = 0, d = 0;
    for (const it of items) if (it.final.pct != null) { n += it.final.pct * it.row.m.soh; d += it.row.m.soh; }
    return d > 0 ? Math.round(n / d * 10) / 10 : 0;
  }

  // Baseline only: recent run-rate over the sale length, capped at stock. NO promotional
  // uplift is applied — uplift needs calibration against past sales (a later phase).
  function baseline(m, S) {
    const units = Math.min(m.soh, Math.round(m.weeklyRate * (S.saleDays / 7)));
    return { units, remaining: Math.max(0, m.soh - units), kind: 'baseline (no promo uplift)' };
  }

  // The A / B / C split of a category's STANDARD-sale products (GWP, excluded and special buys are left out). Every product is in exactly one of
  // A, B, C or X (exception), so A + B + C + X = eligible. SOH is stock on hand now, never negative; on order is never added.
  function groupSplit(list) {
    const out = { countA: 0, countB: 0, countC: 0, countX: 0, unitsA: 0, unitsB: 0, unitsC: 0, unitsX: 0, exProtected: 0, exKept: 0, exManual: 0 };
    for (const it of list) {
      const g = it.group; if (!g) continue;
      const u = Math.max(0, num(it.row.m.sohNow != null ? it.row.m.sohNow : it.row.m.soh) || 0);
      out['count' + g]++; out['units' + g] += u;
      if (g === 'X') { if (it.exceptionKind === 'protected') out.exProtected++; else if (it.exceptionKind === 'kept') out.exKept++; else out.exManual++; }
    }
    out.eligible = out.countA + out.countB + out.countC + out.countX; out.eligibleUnits = out.unitsA + out.unitsB + out.unitsC + out.unitsX;
    return out;
  }
  function summarise(cp, S) {
    const ms = cp.items.map(it => it.row);
    const soh = ms.reduce((a, r) => a + r.m.sohNow, 0);
    const restock = ms.reduce((a, r) => a + r.m.restock, 0);
    const units = ms.reduce((a, r) => a + r.m.periodUnits, 0);
    const rate = units / (S.periodDays / 7);
    const cost = cp.items.reduce((a, it) => a + (num(it.row.p.sohCost) || 0), 0);
    return {
      category: cp.category, products: cp.items.length, soh, restock, sohCost: Math.round(cost), periodUnits: units,
      weeksCover: rate > 0 ? round1(soh / rate) : null,
      sellThroughProxy: units + soh > 0 ? round1(units / (units + soh) * 100) : null,
      groupA: cp.items.some(it => it.group === 'A') ? cp.groupA : null,   // a group nobody ended up in isn't offered
      groupB: cp.items.some(it => it.group === 'B') ? cp.groupB : null,
      ...groupSplit(cp.items), levelC: clearanceLevel(S), cCapped: S.clearanceDiscount > clearanceLevel(S) + 0.01,
      countS: cp.items.filter(it => it.final.action === 'S' && !it.row.p.isGWP).length,
      countManual: cp.items.filter(it => it.override && it.group === 'X').length,
      countExcluded: cp.items.filter(it => it.final.action === 'Exclude' && !it.row.p.isGWP).length,
      forecastUnits: cp.items.reduce((a, it) => a + it.forecast.units, 0),
      forecastRemaining: cp.items.reduce((a, it) => a + it.forecast.remaining, 0),
      pressure: cp.pressure,
      manualA: cp.manual.A, manualB: cp.manual.B, autoA: cp.autoA, autoB: cp.autoB, noB: cp.noB, recB: cp.recB, levelA: cp.levelA, levelB: cp.levelB,
      groupWarn: cp.manual.A != null && cp.manual.B != null && cp.manual.B <= cp.manual.A,
    };
  }

  function totals(items) {
    const inc = items.filter(it => it.final.action !== 'Exclude');
    return {
      products: items.length, included: inc.length, excluded: items.length - inc.length,
      exceptions: items.filter(it => it.exception).length,
      saleUnits: inc.reduce((a, it) => a + it.row.m.soh, 0),
      conflicts: items.filter(it => it.conflict).length,
      overridden: items.filter(it => it.override).length,
      soh: items.reduce((a, it) => a + it.row.m.sohNow, 0),
      restock: items.reduce((a, it) => a + it.row.m.restock, 0),
      restockStyles: items.filter(it => it.row.m.restock > 0).length,
      sohCost: Math.round(items.reduce((a, it) => a + (num(it.row.p.sohCost) || 0), 0)),
    };
  }

  return { DEFAULTS, mergeSettings, clearanceLevel, percentileRank, metrics, ageScore, scoreAll, classify, levels, priceAt, baseline, buildPlan };
});
