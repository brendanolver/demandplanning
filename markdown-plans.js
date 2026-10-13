// WNDRR Markdown Planner — sale plan management.
// Pure functions (no DOM, no storage, no network): the page loads this as
// window.MarkdownPlans and tests/markdown-plans.test.js runs the same file under Node.
// A "state" is { v, activeId, order:[ids], plans:{ id: plan } }. Every function returns a
// NEW state (the input is never mutated), so persistence is just "save whatever came back"
// and the storage backend (localStorage today, shared storage later) can be swapped freely.
//
// A plan keeps its OWN setup, engine settings, overrides, collection mappings and export
// history. Overrides/mappings/exports are empty placeholders until those phases land, but
// they live on the plan from day one so a duplicate or archive never has to be reworked.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./markdown-engine.js'));
  else root.MarkdownPlans = factory(root.MarkdownEngine);
})(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';

  const STATE_VERSION = 1;

  // How readily products enter the sale and Group B, per primary objective. These are
  // starting assumptions like the factor weights — visible to the user and meant to be tuned.
  const OBJECTIVES = {
    clear:   { label: 'Clear stock',        excludeBelow: 30, groupBAt: 60 },
    balance: { label: 'Balance',            excludeBelow: 35, groupBAt: 65 },
    revenue: { label: 'Maximise revenue',   excludeBelow: 40, groupBAt: 70 },
    profit:  { label: 'Maximise gross profit', excludeBelow: 45, groupBAt: 75 },
  };
  const INCOMING = {
    none: 'Current SOH only',
    sale: 'Stock arriving by sale end',
    all:  'All stock on order',
  };

  const DEFAULT_SETUP = {
    start: '',                // YYYY-MM-DD
    end: '',
    objective: 'balance',
    targetRevenue: null,      // optional, $ ex GST
    targetClearPct: null,     // optional, % of SOH units to clear
    liftPct: null,            // scenario assumption: extra demand (%) per allowed level of deeper discount in the Aggressive scenario (and less in Conservative); blank = none
    growthPct: null,          // planned growth vs the same dates last year (%), e.g. 90 = nearly double; blank = flat on last year
    incoming: 'sale',
  };

  const clone = o => JSON.parse(JSON.stringify(o));
  const num = v => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));

  let seq = 0;
  function defaultId(now) { seq += 1; return 'p' + (now || Date.now()).toString(36) + seq.toString(36) + Math.floor(Math.random() * 1296).toString(36); }

  function parseDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const d = new Date(t);
    // reject impossible dates like 2026-02-31 (Date would silently roll them over)
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : null;
  }
  // Inclusive calendar days (a one-day sale is 1). null until both dates are valid and ordered.
  function durationDays(start, end) {
    const a = parseDay(start), b = parseDay(end);
    if (a == null || b == null || b < a) return null;
    return Math.round((b - a) / 86400000) + 1;
  }

  function newPlan(name, now, id) {
    const t = now || Date.now();
    return {
      id: id || defaultId(t), name: String(name || 'Sale').trim() || 'Sale', rev: 1, createdTs: t, updatedTs: t, archived: false,
      setup: clone(DEFAULT_SETUP),
      settings: Engine.mergeSettings({}),
      overrides: {},   // phase 4: per-product manual decisions
      catApprovals: {}, // category approval: { CATEGORY: { approved, ts, A, B, alloc: { productId: 'A'|'B'|'C'|'Exclude' } } } — kept when a category is reopened
      snapshots: [],   // saved forecast snapshots (kept per sale; a Duplicate does not copy them)
      groupLevels: {}, // your own Group A / B level per category: { CATEGORY: { A: pct, B: pct } } (absent = the planner's suggestion)
      mappings: {},    // phase 7: discount -> Shopify collection (id + title), independent per sale
      exports: [],     // phase 7: export + confirmation history
      special: [],     // special buys: Apparel Magic selections + the discount for each
      gwp: { items: [], threshold: null, qty: {} },   // gift with purchase: selections, optional spend threshold, planned giveaways per style
    };
  }

  function createState(now, idGen) {
    const p = newPlan('Sale 1', now, idGen && idGen());
    return { v: STATE_VERSION, activeId: p.id, order: [p.id], plans: { [p.id]: p } };
  }

  // First run after this feature ships: carry the single set of settings the Planner
  // used to save into "Sale 1" so nothing the user already chose is lost.
  function migrate(raw, legacySettings, now, idGen) {
    if (raw && raw.v === STATE_VERSION && raw.plans && Array.isArray(raw.order) && raw.order.length) {
      const s = clone(raw);
      for (const id of Object.keys(s.plans)) {                       // keep older plans valid as defaults grow
        const p = s.plans[id];
        p.setup = { ...DEFAULT_SETUP, ...(p.setup || {}) };
        p.settings = Engine.mergeSettings(p.settings);
        p.groupLevels = p.groupLevels && typeof p.groupLevels === 'object' ? p.groupLevels : {};
        p.snapshots = Array.isArray(p.snapshots) ? p.snapshots : [];
        p.catApprovals = p.catApprovals && typeof p.catApprovals === 'object' && !Array.isArray(p.catApprovals) ? p.catApprovals : {};
        p.overrides = p.overrides || {}; p.mappings = p.mappings || {}; p.exports = p.exports || [];
        p.special = Array.isArray(p.special) ? p.special : [];
        p.gwp = { items: [], threshold: null, qty: {}, ...(p.gwp || {}) };
        if (!Array.isArray(p.gwp.items)) p.gwp.items = [];
        if (!p.gwp.qty || typeof p.gwp.qty !== 'object') p.gwp.qty = {};
      }
      if (!s.plans[s.activeId] || s.plans[s.activeId].archived) s.activeId = s.order.find(id => s.plans[id] && !s.plans[id].archived) || s.order[0];
      return s;
    }
    const st = createState(now, idGen);
    if (legacySettings && typeof legacySettings === 'object') st.plans[st.activeId].settings = Engine.mergeSettings(legacySettings);
    return st;
  }

  function uniqueName(state, name, exceptId) {
    const base = String(name || 'Sale').trim() || 'Sale';
    const taken = new Set(Object.values(state.plans).filter(p => p.id !== exceptId).map(p => p.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    let i = 2; while (taken.has((base + ' ' + i).toLowerCase())) i++;
    return base + ' ' + i;
  }

  function addPlan(state, name, now, idGen) {
    const s = clone(state);
    const nm = uniqueName(s, name || 'Sale ' + (Object.keys(s.plans).length + 1));
    const p = newPlan(nm, now, idGen && idGen());
    s.plans[p.id] = p; s.order.push(p.id); s.activeId = p.id;
    return { state: s, id: p.id };
  }

  // A duplicate is a TEMPLATE: it copies configuration (setup rules + engine settings) but
  // not the old sale's dates, product overrides, collection mappings or export history —
  // those describe a different promotion and must not masquerade as current decisions.
  function duplicatePlan(state, id, now, idGen) {
    const src = state.plans[id]; if (!src) return { state, id: null };
    const s = clone(state);
    const p = newPlan(uniqueName(s, src.name + ' (copy)'), now, idGen && idGen());
    p.setup = { ...clone(src.setup), start: '', end: '' };
    p.settings = clone(src.settings);
    p.groupLevels = clone(src.groupLevels || {});   // the category strategy is part of the template
    s.plans[p.id] = p;
    s.order.splice(s.order.indexOf(id) + 1, 0, p.id);
    s.activeId = p.id;
    return { state: s, id: p.id };
  }

  function renamePlan(state, id, name, now) {
    if (!state.plans[id]) return state;
    const s = clone(state), p = s.plans[id];
    p.name = uniqueName(s, name, id); p.updatedTs = now || Date.now(); p.rev += 1;
    return s;
  }

  function setActive(state, id) {
    if (!state.plans[id] || state.plans[id].archived) return state;
    return { ...clone(state), activeId: id };
  }

  // Archive hides a plan but never deletes it. The last live plan can't be archived.
  function archivePlan(state, id, now) {
    const p = state.plans[id]; if (!p || p.archived) return state;
    const live = state.order.filter(x => state.plans[x] && !state.plans[x].archived);
    if (live.length <= 1) return state;
    const s = clone(state);
    s.plans[id].archived = true; s.plans[id].updatedTs = now || Date.now(); s.plans[id].rev += 1;
    if (s.activeId === id) s.activeId = live.find(x => x !== id);
    return s;
  }
  function restorePlan(state, id, now) {
    const p = state.plans[id]; if (!p || !p.archived) return state;
    const s = clone(state);
    s.plans[id].archived = false; s.plans[id].updatedTs = now || Date.now(); s.plans[id].rev += 1;
    s.activeId = id;
    return s;
  }

  // The discount levels offered for a sale: sorted, unique, sane. Custom levels (e.g. 25%)
  // are allowed; the max effective discount is kept on the list so it is always selectable.
  function cleanLevels(levels) {
    const out = [...new Set((levels || []).map(Number).filter(n => isFinite(n) && n > 0 && n <= 95).map(n => Math.round(n)))].sort((a, b) => a - b);
    return out.length ? out : [20];
  }

  // Apply a change to the plan's setup and/or engine settings, keeping them consistent.
  function updatePlan(state, id, patch, now) {
    if (!state.plans[id]) return state;
    const s = clone(state), p = s.plans[id];
    if (patch.setup) p.setup = { ...p.setup, ...patch.setup };
    { const l = p.setup.liftPct, n = Number(l); p.setup.liftPct = l == null || l === '' || !isFinite(n) || n <= 0 ? null : Math.min(50, Math.round(n * 10) / 10); }
    { const g = p.setup.growthPct, n = Number(g); p.setup.growthPct = g == null || g === '' || !isFinite(n) ? null : Math.max(-90, Math.min(500, Math.round(n * 10) / 10)); }
    if (patch.settings) p.settings = { ...p.settings, ...patch.settings, weights: { ...p.settings.weights, ...((patch.settings || {}).weights || {}) } };
    p.settings.allowedDiscounts = cleanLevels(p.settings.allowedDiscounts);
    // the max must be an allowed level (snap down to the nearest allowed level at/below it)
    const lv = p.settings.allowedDiscounts;
    const below = lv.filter(d => d <= p.settings.maxDiscount);
    p.settings.maxDiscount = below.length ? below[below.length - 1] : lv[0];
    // average-discount cap: blank/zero/garbage means "no cap"; otherwise 0.1-95 with one decimal
    const cap = Number(p.settings.avgDiscountCap);
    p.settings.avgDiscountCap = p.settings.avgDiscountCap == null || p.settings.avgDiscountCap === '' || !isFinite(cap) || cap <= 0 ? null : Math.min(95, Math.round(cap * 10) / 10);
    p.settings.scope = p.settings.scope === 'all' ? 'all' : 'recommended';
    p.updatedTs = now || Date.now(); p.rev += 1;
    return s;
  }

  // The settings the engine actually runs with: the plan's rules + what the setup implies
  // (sale length from the dates, objective thresholds).
  function engineSettings(plan) {
    const obj = OBJECTIVES[plan.setup.objective] || OBJECTIVES.balance;
    const days = durationDays(plan.setup.start, plan.setup.end);
    return Engine.mergeSettings({ ...plan.settings, excludeBelow: obj.excludeBelow, groupBAt: obj.groupBAt, saleDays: days || plan.settings.saleDays, avgDiscountCap: null });   // the average-discount TARGET is retired: the effective discount is now a live readout, not something the planner steers to
  }

  function validatePlan(plan) {
    const errors = [], warnings = [];
    const { start, end, targetRevenue, targetClearPct } = plan.setup;
    if (start && parseDay(start) == null) errors.push('Start date is not a valid date.');
    if (end && parseDay(end) == null) errors.push('End date is not a valid date.');
    if (start && end && parseDay(start) != null && parseDay(end) != null && parseDay(end) < parseDay(start)) errors.push('End date is before the start date.');
    if (!start || !end) warnings.push('Set the sale dates — the forecast uses the sale length (assuming ' + plan.settings.saleDays + ' days until then).');
    if (targetRevenue != null && !(num(targetRevenue) > 0)) errors.push('Target revenue must be a positive number.');
    if (targetClearPct != null && !(num(targetClearPct) > 0 && num(targetClearPct) <= 100)) errors.push('Target clearance must be between 1% and 100%.');
    const d = durationDays(start, end);
    if (d != null && d > 60) warnings.push('That is a long sale (' + d + ' days).');
    return { errors, warnings };
  }


  // ── Forecast: last year's same dates, grown by your target ──────────────────
  // The sale's dates shifted back 364 days (52 weeks, so Black Friday lands on last year's Black Friday). null until both dates are valid.
  function lyWindow(setup) {
    const a = parseDay(setup && setup.start), b = parseDay(setup && setup.end);
    if (a == null || b == null || b < a) return null;
    const iso = t => new Date(t - 364 * 86400000).toISOString().slice(0, 10);
    return { start: iso(a), end: iso(b), days: Math.round((b - a) / 86400000) + 1 };
  }
  // Units sold per category inside that window. salesBySkuDay = { sku: { 'YYYY-MM-DD': { qty } } }, skuCat = { sku: category }.
  function lyUnitsByCategory(salesBySkuDay, skuCat, win) {
    const out = {}; let total = 0;
    if (!win || !salesBySkuDay) return { byCat: out, total, matched: 0 };
    let matched = 0;
    for (const sku of Object.keys(salesBySkuDay)) {
      const cat = skuCat && skuCat[sku]; if (!cat) continue;
      const key = String(cat).toUpperCase(), days = salesBySkuDay[sku];
      for (const day of Object.keys(days)) {
        const d = String(day).slice(0, 10);
        if (d >= win.start && d <= win.end) { const q = Number(days[day] && days[day].qty) || 0; if (q) { out[key] = (out[key] || 0) + q; total += q; matched++; } }
      }
    }
    return { byCat: out, total, matched };
  }
  // Per category: last year's units x (1 + growth), against the stock available (stock now + arriving per the sale's incoming setting).
  // Revenue/GP use the sale price each product ends up at, weighted by stock; prices are GST-inclusive, so revenue is shown ex GST.
  const GST = 1.1;
  function buildForecast(items, lyByCat, growthPct) {
    const g = growthPct == null || !isFinite(Number(growthPct)) ? 0 : Number(growthPct), cats = {};
    for (const it of items || []) {
      const p = it.row.p, key = String(p.category || 'UNCATEGORISED').toUpperCase();
      const c = cats[key] || (cats[key] = { category: p.category || 'UNCATEGORISED', avail: 0, w: 0, price: 0, cost: 0, costUnits: 0 });
      const u = Math.max(0, it.row.m.soh || 0), inc = Math.max(0, p.onOrder || 0), units = u + inc;
      c.avail += units;
      const unitPrice = it.final.pct != null && it.price && it.price.newPrice != null ? it.price.newPrice : (p.price || 0);
      if (units > 0 && unitPrice > 0) { c.w += units; c.price += units * unitPrice; }
      const sc = Number(p.sohCost) || 0; if (u > 0 && sc > 0) { c.cost += sc; c.costUnits += u; }
    }
    const rows = Object.keys(cats).sort().map(k => {
      const c = cats[k], ly = (lyByCat && lyByCat[k]) || 0, demand = Math.round(ly * (1 + g / 100)), sold = Math.min(demand, c.avail);
      const avgPrice = c.w > 0 ? c.price / c.w : 0, unitCost = c.costUnits > 0 ? c.cost / c.costUnits : 0;
      const revenue = sold * avgPrice / GST, gp = revenue - sold * unitCost;
      return { category: c.category, ly, demand, avail: c.avail, left: c.avail - demand, sold, avgPrice, unitCost, revenue: Math.round(revenue), gp: Math.round(gp), short: Math.max(0, demand - c.avail) };
    });
    const sum = f => rows.reduce((a, r) => a + r[f], 0);
    const t = { ly: sum('ly'), demand: sum('demand'), avail: sum('avail'), sold: sum('sold'), revenue: sum('revenue'), gp: sum('gp'), short: sum('short') };
    t.left = t.avail - t.demand; t.gpPct = t.revenue > 0 ? Math.round(t.gp / t.revenue * 1000) / 10 : null;
    return { rows, totals: t, growthPct: g };
  }

  // ── Forecast, phase 5: ranges, discount scenarios, cross-check, commercial summary, snapshots ──
  const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

  // Demand range around your growth target. These are stated ASSUMPTIONS, not calibrated predictions: low = well short of the
  // target, high = beating it. The spread is at least 10 points either side, wider when the target is large.
  function demandScenarios(growthPct) {
    const g = growthPct == null || !isFinite(Number(growthPct)) ? 0 : Number(growthPct);
    return [
      { key: 'low', label: 'Low', growth: Math.max(-90, Math.round((g - Math.max(10, Math.abs(g) * 0.5)) * 10) / 10) },
      { key: 'base', label: 'Base', growth: g },
      { key: 'high', label: 'High', growth: Math.round((g + Math.max(10, Math.abs(g) * 0.25)) * 10) / 10 },
    ];
  }

  // How reliable the history behind the forecast is (the number and spread of last year's sales in the window).
  function forecastConfidence(ly, win, growthPct) {
    const total = ly ? ly.total : 0, days = win ? win.days : 0, g = Number(growthPct) || 0;
    let level = total >= 2000 && days >= 3 ? 'High' : total >= 300 ? 'Medium' : 'Low';
    const notes = [];
    if (!total) notes.push('no sales found for last year\'s dates');
    else if (total < 300) notes.push('little history in last year\'s window (' + total.toLocaleString() + ' units)');
    if (days && days < 3) notes.push('a very short sale — daily noise dominates');
    if (g >= 100) { notes.push('the growth target is more than double last year'); if (level === 'High') level = 'Medium'; }
    return { level, notes };
  }

  // Cross-check of the growth target: this year's recent daily rate x the uplift last year's sale window showed over the weeks before it.
  // (baseline demand x observed promotional uplift — the brief's formula, with the seasonal effect already inside last year's uplift.)
  function crossCheck(a) {
    // a: { win:{days}, lyUnits (window), preUnits (28 days before the window last year), preDays, recentUnits (last N days this year), recentDays, saleDays, lyByCat?, preByCat?, recentByCat? }
    if (!(a && a.win && a.preUnits > 0 && a.recentUnits > 0 && a.lyUnits > 0 && a.preDays > 0 && a.recentDays > 0)) return null;
    const winDaily = a.lyUnits / a.win.days, preDaily = a.preUnits / a.preDays, uplift = winDaily / preDaily;
    const recentDaily = a.recentUnits / a.recentDays, projected = Math.round(recentDaily * uplift * (a.saleDays || a.win.days));
    const yoyTrend = Math.round((recentDaily / preDaily - 1) * 1000) / 10;   // this year's recent daily rate vs last year's pre-sale daily rate (a rough trading trend)
    const out = { uplift: Math.round(uplift * 100) / 100, recentDaily: Math.round(recentDaily), preDaily: Math.round(preDaily), projected, yoyTrend, byCat: {} };
    for (const k of Object.keys(a.lyByCat || {})) {
      const pre = (a.preByCat || {})[k], rec = (a.recentByCat || {})[k];
      if (pre > 0 && rec > 0) out.byCat[k] = Math.round((rec / a.recentDays) * ((a.lyByCat[k] / a.win.days) / (pre / a.preDays)) * (a.saleDays || a.win.days));
    }
    return out;
  }

  // Group levels for a discount-strategy scenario: every category's CURRENT Group A / B level moved `shift` allowed levels (-1 lighter,
  // +1 deeper), staying within the allowed levels and the highest single discount; the engine keeps Group B deeper than Group A.
  function scenarioLevels(categories, allowed, maxDiscount, shift) {
    const lv = (allowed || []).filter(d => d <= maxDiscount).sort((a, b) => a - b), out = {};
    if (!lv.length) return out;
    const mv = v => { if (v == null) return null; let i = lv.reduce((b, d, k) => (Math.abs(d - v) < Math.abs(lv[b] - v) ? k : b), 0); i = Math.max(0, Math.min(lv.length - 1, i + shift)); return lv[i]; };
    for (const c of categories || []) { const e = {}; if (c.groupA != null) e.A = mv(c.groupA); if (c.groupB != null) e.B = mv(c.groupB); if (e.A != null || e.B != null) out[c.category] = e; }
    return out;
  }

  // The commercial dashboard figures that don't depend on a demand forecast.
  function commercialSummary(items, gwpCost) {
    let units = 0, cost = 0, retail = 0, inc = 0, exc = 0; const belowCost = [], lowMargin = [];
    for (const it of items || []) {
      const p = it.row.p, u = Math.max(0, it.row.m.soh || 0), rrp = p.rrp > 0 ? p.rrp : (p.price || 0), sc = Number(p.sohCost) || 0;
      units += u; cost += sc; retail += u * rrp;
      if (it.final.pct == null) { exc++; continue; }
      inc++;
      const unitCost = u > 0 && sc > 0 ? sc / u : 0, np = it.price && it.price.newPrice != null ? it.price.newPrice : 0;
      if (unitCost > 0 && np > 0) { const net = np / GST; if (net < unitCost) belowCost.push({ id: p.id, name: p.name, colour: p.colour, pct: it.final.pct, net: Math.round(net * 100) / 100, unitCost: Math.round(unitCost * 100) / 100 }); else if ((net - unitCost) / net < 0.15) lowMargin.push({ id: p.id, name: p.name, colour: p.colour, pct: it.final.pct }); }
    }
    return { units, cost: Math.round(cost), retail: Math.round(retail), included: inc, excluded: exc, belowCost, lowMargin, gwpCost: Math.round(gwpCost || 0) };
  }

  // Forecast snapshots (kept per sale, newest first, max 20). A snapshot is a small record of the headline numbers, not a recomputable plan.
  function addSnapshot(state, planId, snap, now) {
    if (!state.plans[planId] || !snap) return state;
    const s = clone(state), p = s.plans[planId]; p.snapshots = Array.isArray(p.snapshots) ? p.snapshots : [];
    p.snapshots.unshift({ ts: now || Date.now(), label: String(snap.label || '').slice(0, 60), growthPct: snap.growthPct == null ? null : Number(snap.growthPct), ...Object.fromEntries(['demand', 'sold', 'revenue', 'gp', 'gpPct', 'effDiscount', 'avail', 'gwpCost'].map(k => [k, snap[k] == null ? null : Number(snap[k])])) });
    if (p.snapshots.length > 20) p.snapshots.length = 20;
    p.updatedTs = now || Date.now(); p.rev += 1;
    return s;
  }
  function removeSnapshot(state, planId, ts) {
    const plan = state.plans[planId]; if (!plan || !(plan.snapshots || []).some(x => x.ts === ts)) return state;
    const s = clone(state); s.plans[planId].snapshots = s.plans[planId].snapshots.filter(x => x.ts !== ts); s.plans[planId].rev += 1; return s;
  }

  // ── Category approval (the main workflow) ───────────────────────────────────
  // Approving a category saves its final Group A / B levels and every product's allocation in it, and moves it to Approved. Reopening
  // moves it back but keeps everything saved (levels, allocations, your product decisions). 'Regenerate' drops the saved allocations of
  // categories that are NOT approved so the planner re-suggests them.
  const ALLOC_OK = ['A', 'B', 'C', 'Exclude'];
  function approveCategory(state, planId, category, snap, now) {
    const plan = state.plans[planId]; if (!plan || !category) return state;
    const s = clone(state), p = s.plans[planId], lvl = v => { const n = Number(v); return v != null && isFinite(n) && n > 0 ? Math.min(n, p.settings.maxDiscount) : null; };
    const A = lvl(snap && snap.A), B = snap && snap.B === 0 ? 0 : lvl(snap && snap.B), alloc = {};   // B === 0 = Group B switched off
    for (const id of Object.keys((snap && snap.alloc) || {})) if (ALLOC_OK.includes(snap.alloc[id])) alloc[id] = snap.alloc[id];
    p.catApprovals = p.catApprovals || {}; p.catApprovals[category] = { approved: true, ts: now || Date.now(), A, B, alloc };
    p.groupLevels = p.groupLevels || {};
    const e = { ...(p.groupLevels[category] || {}) }; if (A != null) e.A = A; if (B != null) e.B = B;
    if (e.A != null || e.B != null) p.groupLevels[category] = e;
    p.updatedTs = now || Date.now(); p.rev += 1;
    return s;
  }
  // Drop one category's saved allocation (when it isn't approved) so the planner re-allocates it.
  function releaseAllocation(state, planId, category, now) {
    const plan = state.plans[planId]; const ap = plan && plan.catApprovals && plan.catApprovals[category];
    if (!ap || ap.approved) return state;
    const s = clone(state); delete s.plans[planId].catApprovals[category]; s.plans[planId].updatedTs = now || Date.now(); s.plans[planId].rev += 1; return s;
  }
  function reopenCategory(state, planId, category, now) {
    const plan = state.plans[planId]; if (!plan || !plan.catApprovals || !plan.catApprovals[category] || !plan.catApprovals[category].approved) return state;
    const s = clone(state); s.plans[planId].catApprovals[category].approved = false; s.plans[planId].updatedTs = now || Date.now(); s.plans[planId].rev += 1; return s;
  }
  function refreshSuggestions(state, planId, now) {
    const plan = state.plans[planId]; if (!plan) return state;
    const open = Object.keys(plan.catApprovals || {}).filter(c => !plan.catApprovals[c].approved);
    if (!open.length) return state;
    const s = clone(state); for (const c of open) delete s.plans[planId].catApprovals[c];
    s.plans[planId].updatedTs = now || Date.now(); s.plans[planId].rev += 1; return s;
  }
  const isApproved = (plan, category) => !!(plan.catApprovals && plan.catApprovals[category] && plan.catApprovals[category].approved);
  // Saved allocations for the engine: every category with a record (approved or reopened) holds its products where they were put.
  function frozenAllocs(plan) {
    const out = {};
    for (const c of Object.keys(plan.catApprovals || {})) Object.assign(out, plan.catApprovals[c].alloc || {});
    return out;
  }
  // One row per category for the Suggested / Approved tables. GWP products never count (they are never discounted); a special buy counts once,
  // in its own category. onOrderByCat: { 'CATEGORY': units } (uppercase keys).
  function categoryRows(items, enginePlan, plan, onOrderByCat) {
    const byCat = {}, blockedBy = {};
    for (const it of items || []) { if (it.blocked) { const k = it.row.p.category || 'UNCATEGORISED'; blockedBy[k] = (blockedBy[k] || 0) + 1; } }   // a GWP product that also has a discount (a genuine conflict) blocks its category
    for (const it of items || []) {
      const p = it.row.p; if (p.isGWP) continue;
      const k = p.category || 'UNCATEGORISED';
      const c = byCat[k] || (byCat[k] = { category: k, products: 0, sold30: 0, unitsA: 0, unitsB: 0, countA: 0, countB: 0, countC: 0, countS: 0, countX: 0, countManual: 0, blocked: 0, needAttention: 0, changed: 0 });
      c.products++; c.sold30 += (p.sold && p.sold.d30) || 0;
      const a = it.final.action, u = it.row.m.soh || 0;
      if (a === 'A') { c.countA++; c.unitsA += u; } else if (a === 'B') { c.countB++; c.unitsB += u; } else if (a === 'C') c.countC++; else if (a === 'S') c.countS++; else if (a === 'Exclude') c.countX++; else if (a === 'Manual') c.countManual++;
      if (it.exception) c.needAttention++; if (it.override) c.changed++;
    }
    const ec = Object.fromEntries(((enginePlan && enginePlan.categories) || []).map(c => [c.category, c]));
    const rows = Object.keys(byCat).sort().map(k => {
      const c = byCat[k], e = ec[k] || {}, ap = (plan.catApprovals || {})[k];
      return { ...c, blocked: blockedBy[k] || 0, soh: e.soh || 0, restock: e.restock || 0, weeksCover: e.weeksCover == null ? null : e.weeksCover, onOrder: (onOrderByCat && onOrderByCat[String(k).toUpperCase()]) || 0,
        groupA: e.groupA == null ? null : e.groupA, groupB: e.groupB == null ? null : e.groupB, autoA: e.autoA == null ? null : e.autoA, autoB: e.autoB == null ? null : e.autoB,
        manualA: e.manualA == null ? null : e.manualA, manualB: e.manualB == null ? null : e.manualB, groupWarn: !!e.groupWarn,
        noB: !!e.noB, recB: e.recB || 0, levelA: e.levelA == null ? null : e.levelA, levelB: e.levelB == null ? null : e.levelB,
        approved: !!(ap && ap.approved), reopened: !!(ap && !ap.approved), approvedTs: ap ? ap.ts : null };
    });
    return rows;
  }
  function approvalProgress(rows) {
    const ap = rows.filter(r => r.approved);
    return { catsTotal: rows.length, catsApproved: ap.length, catsRemaining: rows.length - ap.length, prodsTotal: rows.reduce((a, r) => a + r.products, 0), prodsApproved: ap.reduce((a, r) => a + r.products, 0), prodsRemaining: rows.filter(r => !r.approved).reduce((a, r) => a + r.products, 0) };
  }

  // ── Category group levels ──────────────────────────────────────────────────
  // tier 'A' | 'B'; pct null/'' = back to the planner's suggestion. Levels are capped at the highest single discount.
  function setGroupLevel(state, planId, category, tier, pct, now) {
    const plan = state.plans[planId]; if (!plan || (tier !== 'A' && tier !== 'B') || !category) return state;
    // Group B only: 0 / 'none' switches it off for the category (its products stay in Group A).
    const none = tier === 'B' && (pct === 0 || pct === '0' || pct === 'none');
    const n = Number(pct), val = none ? 0 : pct == null || pct === '' || !isFinite(n) || n <= 0 ? null : Math.round(Math.min(n, plan.settings.maxDiscount) * 10) / 10;
    const cur = (plan.groupLevels || {})[category] || {};
    if ((cur[tier] == null ? null : cur[tier]) === val) return state;
    const s = clone(state), p = s.plans[planId]; p.groupLevels = p.groupLevels || {};
    const e = { ...(p.groupLevels[category] || {}) };
    if (val == null) delete e[tier]; else e[tier] = val;
    if (e.A == null && e.B == null) delete p.groupLevels[category]; else p.groupLevels[category] = e;
    p.updatedTs = now || Date.now(); p.rev += 1;
    return s;
  }
  function clearGroupLevels(state, planId, now) {
    const plan = state.plans[planId]; if (!plan || !Object.keys(plan.groupLevels || {}).length) return state;
    const s = clone(state); s.plans[planId].groupLevels = {}; s.plans[planId].updatedTs = now || Date.now(); s.plans[planId].rev += 1; return s;
  }

  // ── Decisions (overrides) ──────────────────────────────────────────────────
  // Keyed by product/colour id on the plan. They survive every regenerate and are only ever
  // changed by an explicit action; the engine applies them last.
  const EXCLUDE_REASONS = ['Strong current sales', 'Low stock cover', 'New arrival', 'Core protection', 'Commercial decision', 'Other'];

  function sanitizeOverride(o) {
    if (!o || typeof o !== 'object') return null;
    if (o.exclude && o.confirm) return { exclude: true, confirm: true };
    if (o.exclude) {
      const out = { exclude: true };
      if (o.reason) out.reason = String(o.reason).slice(0, 60);
      if (o.note) out.note = String(o.note).slice(0, 200);
      return out;
    }
    if (o.group === 'A' || o.group === 'B' || o.group === 'C') return { group: o.group };
    const pct = Number(o.pct);
    if (o.pct != null && o.pct !== '' && isFinite(pct) && pct > 0 && pct <= 95) return { pct: Math.round(pct * 10) / 10, kind: o.kind === 'approved' ? 'approved' : 'discount' };
    return null;
  }

  // entries: { productId: override | null } — null (or anything invalid) removes the decision.
  function setOverrides(state, planId, entries, now) {
    if (!state.plans[planId]) return state;
    const s = clone(state), p = s.plans[planId];
    let changed = false;
    for (const id of Object.keys(entries || {})) {
      const clean = sanitizeOverride(entries[id]);
      if (clean) { clean.ts = now || Date.now(); p.overrides[id] = clean; changed = true; }
      else if (id in p.overrides) { delete p.overrides[id]; changed = true; }
    }
    if (!changed) return state;
    p.updatedTs = now || Date.now(); p.rev += 1;
    return s;
  }

  // ids = null clears every decision on the plan ("reset all").
  function clearOverrides(state, planId, ids, now) {
    const plan = state.plans[planId]; if (!plan) return state;
    const targets = ids == null ? Object.keys(plan.overrides) : ids.filter(id => id in plan.overrides);
    if (!targets.length) return state;
    return setOverrides(state, planId, Object.fromEntries(targets.map(id => [id, null])), now);
  }

  // Counts for the review header. `liveIds` = products currently in the plan; saved decisions for
  // products no longer in stock are "stale": kept (never silently dropped) but called out.
  function overrideStats(plan, liveIds) {
    const live = new Set(liveIds || []);
    const st = { total: 0, exclude: 0, discount: 0, approved: 0, group: 0, stale: 0 };
    for (const id of Object.keys(plan.overrides || {})) {
      const o = plan.overrides[id]; st.total++;
      if (liveIds && !live.has(id)) st.stale++;
      if (o.exclude && o.confirm) st.approved++; else if (o.exclude) st.exclude++; else if (o.group) st.group++; else if (o.kind === 'approved') st.approved++; else st.discount++;
    }
    return st;
  }

  // ── Review table: filter, group by parent style, sort ───────────────────────
  // Pure — the screen only renders what this returns. A parent-style row appears only when 2+ colours
  // of that style survive the filters; everything else is a plain single row.
  const VIEWS = ['all', 'sale', 'notsale', 'clearance', 'special', 'groupA', 'groupB', 'overridden', 'attention', 'onorder', 'restock'];
  function buildReview(items, f, opts) {
    f = f || {}; opts = opts || {};
    const q = String(f.q || '').trim().toLowerCase();
    const view = VIEWS.includes(f.view) ? f.view : 'all';
    const oo = i => (opts.onOrder ? opts.onOrder(i) : 0);
    const hit = it => {
      const p = it.row.p, fin = it.final;
      if (f.category && String(p.category || '').toUpperCase() !== String(f.category).toUpperCase()) return false;
      if (f.collection && norm(p.collection) !== norm(f.collection)) return false;
      if (f.sugg) { const sp = it.systemPct; if (f.sugg === '__none__' ? sp != null : sp == null || Number(sp) !== Number(f.sugg)) return false; }
      if (f.month) { const dm = String(p.deliveryMonth || ''); if (f.month === '__none__' ? dm !== '' : dm.toUpperCase() !== String(f.month).toUpperCase()) return false; }
      if (f.core === 'core' && !p.isCore) return false;
      if (f.core === 'noncore' && p.isCore) return false;
      if (view === 'sale' && fin.pct == null) return false;
      if (view === 'notsale' && fin.action !== 'Exclude') return false;
      if (view === 'clearance' && fin.action !== 'C') return false;
      if (view === 'special' && fin.action !== 'S') return false;
      if (view === 'onorder' && !(oo(it) > 0)) return false;
      if (view === 'restock' && !(it.row.m.restock > 0)) return false;
      if (view === 'groupA' && fin.action !== 'A') return false;
      if (view === 'groupB' && fin.action !== 'B') return false;
      if (view === 'overridden' && !it.override) return false;
      if (view === 'attention' && !(it.exception || it.blocked || it.overCap)) return false;   // a different discount from the suggestion is a normal decision, not a problem
      if (q) {
        const hay = [p.name, p.colour, p.style, p.parentStyle, p.category].join(' ').toLowerCase();
        if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
      }
      return true;
    };
    const rows = items.filter(hit);
    const byStyle = {};
    rows.forEach(it => { const ps = it.row.p.parentStyle; if (ps) (byStyle[ps] = byStyle[ps] || []).push(it); });
    const groups = [], seen = new Set();
    for (const it of rows) {
      const ps = it.row.p.parentStyle;
      if (!f.flat && ps && byStyle[ps].length > 1) {
        if (seen.has(ps)) continue; seen.add(ps);
        groups.push({ key: 'ps:' + ps, parentStyle: ps, multi: true, items: byStyle[ps] });
      } else groups.push({ key: 'id:' + it.row.p.id, parentStyle: ps || '', multi: false, items: [it] });
    }
    // Any review column can be sorted, ascending or descending (f.dir). A parent row sorts on its colours combined
    // (stock/sales summed, prices and rates averaged); empty values always sort last whichever way you go.
    const MO = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
    const monthKey = dm => { const m = /^([A-Za-z]{3})-(\d{2})$/.exec(String(dm || '')); if (!m || !MO[m[1].toUpperCase()]) return null; const y = +m[2]; return (y < 50 ? 2000 + y : 1900 + y) * 100 + MO[m[1].toUpperCase()]; };
    const nz = v => (v == null || !isFinite(v) ? null : v);
    const SORTS = {
      category: { t: 's', v: i => String(i.row.p.category || '') },
      name: { t: 's', v: i => String(i.row.p.name || '') },
      parent: { t: 's', v: i => String(i.row.p.parentStyle || i.row.p.style || '') },
      month: { t: 'n', agg: 'first', v: i => monthKey(i.row.p.deliveryMonth) },
      soh: { t: 'n', agg: 'sum', v: i => nz(i.row.m.sohNow != null ? i.row.m.sohNow : i.row.m.soh) },
      onorder: { t: 'n', agg: 'sum', v: i => nz(oo(i)) },
      d7: { t: 'n', agg: 'sum', v: i => nz((i.row.p.sold || {}).d7) }, d30: { t: 'n', agg: 'sum', v: i => nz((i.row.p.sold || {}).d30) },
      d60: { t: 'n', agg: 'sum', v: i => nz((i.row.p.sold || {}).d60) }, d90: { t: 'n', agg: 'sum', v: i => nz((i.row.p.sold || {}).d90) },
      current: { t: 'n', agg: 'mean', v: i => nz(i.row.p.currentDiscountPct || 0) },
      cover: { t: 'n', agg: 'mean', v: i => nz(i.row.m.weeksCover) },
      sellthru: { t: 'n', agg: 'mean', v: i => nz(i.row.m.sellThroughProxy) },
      sizesout: { t: 'n', agg: 'sum', v: i => nz(i.row.p.soldOutSizes || 0) },
      rrp: { t: 'n', agg: 'mean', v: i => nz(i.row.p.rrp > 0 ? i.row.p.rrp : null) },
      price: { t: 'n', agg: 'mean', v: i => nz(i.row.p.price > 0 ? i.row.p.price : null) },
      suggested: { t: 'n', agg: 'mean', v: i => nz(i.systemPct) },
      discount: { t: 'n', agg: 'mean', v: i => nz(i.final.pct) },
      newprice: { t: 'n', agg: 'mean', v: i => nz(i.price && i.price.newPrice) },
      score: { t: 'n', agg: 'max', v: i => nz(i.row.score) },
      why: { t: 's', v: i => String((i.final && i.final.reason) || '') },
    };
    const DEFAULT_DIR = k => (SORTS[k] && SORTS[k].t === 's' ? 'asc' : 'desc');
    const skey = SORTS[f.sort] ? f.sort : 'category', sd = SORTS[skey], mult = (f.dir === 'asc' || f.dir === 'desc' ? f.dir : DEFAULT_DIR(skey)) === 'asc' ? 1 : -1;
    const gval = g => {
      const vals = g.items.map(sd.v).filter(v => v != null && v !== '');
      if (!vals.length) return null;
      if (sd.t === 's') return vals.map(String).sort((a, b) => a.localeCompare(b))[0];
      return sd.agg === 'sum' ? vals.reduce((a, v) => a + v, 0) : sd.agg === 'max' ? Math.max(...vals) : sd.agg === 'mean' ? vals.reduce((a, v) => a + v, 0) / vals.length : vals[0];
    };
    const nameOf = g => String(g.items[0].row.p.name || '');
    const cache = new Map(); groups.forEach(g => cache.set(g, gval(g)));
    groups.sort((a, b) => {
      const x = cache.get(a), y = cache.get(b);
      if (x == null && y != null) return 1; if (y == null && x != null) return -1;
      let c = 0; if (x != null) c = sd.t === 's' ? String(x).localeCompare(String(y)) : x - y;
      return (c * mult) || nameOf(a).localeCompare(nameOf(b)) || a.key.localeCompare(b.key);
    });
    groups.forEach(g => g.items.sort((a, b) => String(a.row.p.colour).localeCompare(String(b.row.p.colour)) || a.row.p.id.localeCompare(b.row.p.id)));
    return { groups, count: rows.length, total: items.length };
  }


  // ── Special buys & gift with purchase (Apparel Magic selections) ───────────
  // Both are per-SALE allocations (they describe one promotion), so a Duplicate does not copy them.
  // A selection says WHICH Apparel Magic styles — by collection/group, category, parent style, a single
  // style, or a customer PO on the open orders — and special-buy selections also carry the discount.
  const SPECIAL_KINDS = ['group', 'parent', 'style', 'po'];
  const GWP_KINDS = ['category', 'group', 'style'];
  const norm = v => String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();   // same normalisation the app uses for AM group names

  function sanitizeSelection(section, sel) {
    if (!sel || typeof sel !== 'object') return null;
    const kinds = section === 'gwp' ? GWP_KINDS : SPECIAL_KINDS;
    if (!kinds.includes(sel.kind)) return null;
    const value = String(sel.value == null ? '' : sel.value).trim().slice(0, 120);
    if (!value) return null;
    const out = { kind: sel.kind, value };
    if (section === 'special') {
      const pct = Number(sel.pct);
      if (!(isFinite(pct) && pct >= 5 && pct <= 95)) return null;
      out.pct = Math.round(pct * 10) / 10;
    }
    if (sel.label) out.label = String(sel.label).slice(0, 120);
    return out;
  }
  const sameSel = (a, b) => a.kind === b.kind && norm(a.value) === norm(b.value);

  function planList(plan, section) { return section === 'gwp' ? plan.gwp.items : plan.special; }

  // Adding the same collection/style again updates it instead of duplicating.
  function addSelection(state, planId, section, sel, now, idGen) {
    const clean = sanitizeSelection(section, sel);
    if (!clean || !state.plans[planId]) return { state, id: null };
    const s = clone(state), p = s.plans[planId], list = planList(p, section);
    const ex = list.find(x => sameSel(x, clean));
    let id;
    if (ex) { Object.assign(ex, clean); id = ex.id; }
    else { id = (idGen ? idGen() : defaultId(now)); list.push({ id, ...clean, addedTs: now || Date.now() }); }
    p.updatedTs = now || Date.now(); p.rev += 1;
    return { state: s, id };
  }
  function removeSelection(state, planId, section, selId, now) {
    const plan = state.plans[planId]; if (!plan || !planList(plan, section).some(x => x.id === selId)) return state;
    const s = clone(state), p = s.plans[planId];
    if (section === 'gwp') p.gwp.items = p.gwp.items.filter(x => x.id !== selId); else p.special = p.special.filter(x => x.id !== selId);
    p.updatedTs = now || Date.now(); p.rev += 1;
    return s;
  }
  function setSpecialPct(state, planId, selId, pct, now) {
    const plan = state.plans[planId]; const sel = plan && plan.special.find(x => x.id === selId); if (!sel) return state;
    const clean = sanitizeSelection('special', { ...sel, pct }); if (!clean) return state;
    const s = clone(state), t = s.plans[planId].special.find(x => x.id === selId);
    t.pct = clean.pct; s.plans[planId].updatedTs = now || Date.now(); s.plans[planId].rev += 1;
    return s;
  }
  // Planned giveaways per GWP style (null = back to the default of "everything available").
  function setGwpQty(state, planId, style, qty, now) {
    if (!state.plans[planId]) return state;
    const s = clone(state), p = s.plans[planId], key = String(style || '').trim().toUpperCase(); if (!key) return state;
    const n = Number(qty);
    if (qty == null || qty === '' || !isFinite(n) || n < 0) { if (!(key in p.gwp.qty)) return state; delete p.gwp.qty[key]; }
    else p.gwp.qty[key] = Math.floor(n);
    p.updatedTs = now || Date.now(); p.rev += 1;
    return s;
  }
  function setGwpThreshold(state, planId, v, now) {
    if (!state.plans[planId]) return state;
    const n = Number(v), val = v == null || v === '' || !isFinite(n) || n <= 0 ? null : Math.round(n * 100) / 100;
    if (state.plans[planId].gwp.threshold === val) return state;
    const s = clone(state); s.plans[planId].gwp.threshold = val; s.plans[planId].updatedTs = now || Date.now(); s.plans[planId].rev += 1;
    return s;
  }

  // Resolve selections to styles. catalogue = [{style,parentStyle,group,category,title,rrp,cost}] from Apparel Magic;
  // ctx = { stylesByPo: { 'PO TEXT': ['STYLE', ...] }, fallback: { STYLE: {title,category,group} } } (the open orders).
  // A style hit by several special-buy selections with DIFFERENT discounts is flagged, never silently resolved.
  function resolveSelections(selections, catalogue, ctx) {
    ctx = ctx || {};
    const byStyle = {}, order = [];
    const cat = catalogue || [];
    const add = (style, entry, sel) => {
      const k = String(style).toUpperCase(); if (!k) return;
      let r = byStyle[k]; if (!r) { r = byStyle[k] = { style: k, entry, sels: [] }; order.push(k); }
      if (!r.entry && entry) r.entry = entry;
      if (!r.sels.some(x => x.id === sel.id)) r.sels.push({ id: sel.id, kind: sel.kind, value: sel.value, pct: sel.pct });
    };
    for (const sel of selections || []) {
      const v = norm(sel.value);
      if (sel.kind === 'po') {
        for (const po of Object.keys(ctx.stylesByPo || {})) if (norm(po) === v) for (const st of ctx.stylesByPo[po]) add(st, cat.find(e => e.style === String(st).toUpperCase()) || (ctx.fallback && ctx.fallback[String(st).toUpperCase()] ? { style: String(st).toUpperCase(), ...ctx.fallback[String(st).toUpperCase()] } : null), sel);
        continue;
      }
      for (const e of cat) {
        const hit = sel.kind === 'group' ? norm(e.group) === v : sel.kind === 'category' ? norm(e.category) === v
          : sel.kind === 'parent' ? String(e.parentStyle || '').toUpperCase() === String(sel.value).trim().toUpperCase() : e.style === String(sel.value).trim().toUpperCase();
        if (hit) add(e.style, e, sel);
      }
    }
    return order.map(k => {
      const r = byStyle[k], pcts = [...new Set(r.sels.map(x => x.pct).filter(x => x != null))];
      return { ...r, pct: pcts.length ? r.sels.find(x => x.pct != null).pct : null, conflict: pcts.length > 1 ? 'Different discounts from different selections (' + pcts.map(x => x + '%').join(' vs ') + ')' : null };
    });
  }

  // A collection often holds BOTH the sale's gift-with-purchase and the products bought for it. A broad
  // special-buy pick (collection / parent style / PO) must not turn the GWP styles inside it into a conflict:
  // where a style is DEFINITELY GWP — Apparel Magic's own GWP category, or a style/category you picked as GWP —
  // GWP simply wins and the style is left out of the special buy (and reported). It is a real conflict only
  // where intent is unclear: the style was picked as a special buy BY NAME, or it is GWP only because a whole
  // collection was picked as GWP (so a collection overlapping a special-buy collection can't be resolved by guessing).
  function splitGwpOverlap(specialRows, gwpRows) {
    const gw = {}; for (const r of gwpRows || []) gw[String(r.style).toUpperCase()] = r;
    const strongGwp = r => !!(r.entry && String(r.entry.category || '').toUpperCase() === 'GWP') || r.sels.some(x => x.kind === 'style' || x.kind === 'category');
    const broadOnly = r => r.sels.every(x => x.kind === 'group' || x.kind === 'parent' || x.kind === 'po');
    const applied = [], leftOut = [], conflicts = [];
    for (const r of specialRows || []) {
      const g = gw[String(r.style).toUpperCase()];
      if (!g) { applied.push(r); continue; }
      if (strongGwp(g) && broadOnly(r)) leftOut.push(r);
      else { applied.push(r); conflicts.push(r.style); }
    }
    return { applied, leftOut, conflicts };
  }

  // Blocking conflicts between GWP and discounts. A GWP style must never carry a markdown; each is
  // reported with what to do about it (the export validation will refuse while any remain).
  function gwpConflicts(gwpStyles, specialStyles, decisionStyles) {
    const out = [], g = new Set([...gwpStyles].map(x => String(x).toUpperCase()));
    for (const s of specialStyles || []) if (g.has(String(s).toUpperCase())) out.push({ style: String(s).toUpperCase(), type: 'special', text: 'is marked as gift with purchase but is also in a special-buy selection with a discount' });
    for (const s of decisionStyles || []) if (g.has(String(s).toUpperCase())) out.push({ style: String(s).toUpperCase(), type: 'decision', text: 'is marked as gift with purchase but also has a saved markdown decision' });
    return out;
  }

  // GWP economics for one style. available = SOH (+ incoming per the sale's incoming-stock setting);
  // planned giveaways default to everything available and are capped at it.
  function gwpEconomics(row, plan) {
    const key = String(row.style).toUpperCase(), avail = Math.max(0, (row.soh || 0) + (row.incoming || 0));
    const planned = plan.gwp.qty[key] != null ? Math.min(plan.gwp.qty[key], avail) : avail;
    const cost = row.cost > 0 ? row.cost : null;
    return { available: avail, planned, unitCost: cost, totalCost: cost == null ? null : Math.round(planned * cost * 100) / 100, defaulted: plan.gwp.qty[key] == null, costMissing: cost == null };
  }

  return {
    STATE_VERSION, OBJECTIVES, INCOMING, DEFAULT_SETUP,
    parseDay, durationDays, newPlan, createState, migrate, uniqueName, addPlan, duplicatePlan,
    renamePlan, setActive, archivePlan, restorePlan, cleanLevels, updatePlan, engineSettings, validatePlan,
    EXCLUDE_REASONS, VIEWS, sanitizeOverride, setOverrides, clearOverrides, overrideStats, buildReview,
    SPECIAL_KINDS, GWP_KINDS, norm, sanitizeSelection, addSelection, removeSelection, setSpecialPct, setGwpQty, setGwpThreshold, lyWindow, lyUnitsByCategory, buildForecast, addDays, demandScenarios, forecastConfidence, crossCheck, scenarioLevels, commercialSummary, addSnapshot, removeSnapshot, approveCategory, reopenCategory, releaseAllocation, refreshSuggestions, isApproved, frozenAllocs, categoryRows, approvalProgress, setGroupLevel, clearGroupLevels, resolveSelections, splitGwpOverlap, gwpConflicts, gwpEconomics,
  };
});
