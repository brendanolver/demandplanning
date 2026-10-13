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
      mappings: {},    // phase 7: discount -> Shopify collection (id + title), independent per sale
      exports: [],     // phase 7: export + confirmation history
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
        p.overrides = p.overrides || {}; p.mappings = p.mappings || {}; p.exports = p.exports || [];
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
    return Engine.mergeSettings({ ...plan.settings, excludeBelow: obj.excludeBelow, groupBAt: obj.groupBAt, saleDays: days || plan.settings.saleDays });
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
    const cap = plan.settings.avgDiscountCap, lv = plan.settings.allowedDiscounts;
    if (cap != null) {
      if (cap < Math.min(...lv)) warnings.push('The ' + cap + '% average cap is below your lowest discount level (' + Math.min(...lv) + '%), so it can\'t be reached — the plan will sit at the lowest levels.');
      else if (cap >= plan.settings.maxDiscount) warnings.push('The ' + cap + '% average cap is at or above your highest single discount (' + plan.settings.maxDiscount + '%), so it can never limit anything.');
    }
    const d = durationDays(start, end);
    if (d != null && d > 60) warnings.push('That is a long sale (' + d + ' days).');
    return { errors, warnings };
  }


  // ── Decisions (overrides) ──────────────────────────────────────────────────
  // Keyed by product/colour id on the plan. They survive every regenerate and are only ever
  // changed by an explicit action; the engine applies them last.
  const EXCLUDE_REASONS = ['Strong current sales', 'Low stock cover', 'New arrival', 'Core protection', 'Commercial decision', 'Other'];

  function sanitizeOverride(o) {
    if (!o || typeof o !== 'object') return null;
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
      if (o.exclude) st.exclude++; else if (o.group) st.group++; else if (o.kind === 'approved') st.approved++; else st.discount++;
    }
    return st;
  }

  // ── Review table: filter, group by parent style, sort ───────────────────────
  // Pure — the screen only renders what this returns. A parent-style row appears only when 2+ colours
  // of that style survive the filters; everything else is a plain single row.
  const VIEWS = ['all', 'sale', 'notsale', 'clearance', 'groupA', 'groupB', 'overridden', 'attention'];
  function buildReview(items, f, opts) {
    f = f || {}; opts = opts || {};
    const q = String(f.q || '').trim().toLowerCase();
    const view = VIEWS.includes(f.view) ? f.view : 'all';
    const hit = it => {
      const p = it.row.p, fin = it.final;
      if (f.category && String(p.category || '').toUpperCase() !== String(f.category).toUpperCase()) return false;
      if (f.core === 'core' && !p.isCore) return false;
      if (f.core === 'noncore' && p.isCore) return false;
      if (view === 'sale' && fin.pct == null) return false;
      if (view === 'notsale' && fin.action !== 'Exclude') return false;
      if (view === 'clearance' && fin.action !== 'C') return false;
      if (view === 'groupA' && fin.action !== 'A') return false;
      if (view === 'groupB' && fin.action !== 'B') return false;
      if (view === 'overridden' && !it.override) return false;
      if (view === 'attention' && !(it.exception || it.conflict || it.blocked)) return false;
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
      if (ps && byStyle[ps].length > 1) {
        if (seen.has(ps)) continue; seen.add(ps);
        groups.push({ key: 'ps:' + ps, parentStyle: ps, multi: true, items: byStyle[ps] });
      } else groups.push({ key: 'id:' + it.row.p.id, parentStyle: ps || '', multi: false, items: [it] });
    }
    const sum = (g, fn) => g.items.reduce((a, it) => a + fn(it), 0);
    const name = g => g.items[0].row.p.name;
    const cat = g => String(g.items[0].row.p.category || '');
    const oo = i => (opts.onOrder ? opts.onOrder(i) : 0);
    const sorters = {
      category: (a, b) => cat(a).localeCompare(cat(b)) || name(a).localeCompare(name(b)) || a.key.localeCompare(b.key),
      name: (a, b) => name(a).localeCompare(name(b)) || a.key.localeCompare(b.key),
      score: (a, b) => Math.max(...b.items.map(i => i.row.score)) - Math.max(...a.items.map(i => i.row.score)) || a.key.localeCompare(b.key),
      soh: (a, b) => sum(b, i => i.row.m.soh) - sum(a, i => i.row.m.soh) || a.key.localeCompare(b.key),
      onorder: (a, b) => sum(b, oo) - sum(a, oo) || a.key.localeCompare(b.key),
    };
    groups.sort(sorters[f.sort] || sorters.category);
    groups.forEach(g => g.items.sort((a, b) => String(a.row.p.colour).localeCompare(String(b.row.p.colour)) || a.row.p.id.localeCompare(b.row.p.id)));
    return { groups, count: rows.length, total: items.length };
  }

  return {
    STATE_VERSION, OBJECTIVES, INCOMING, DEFAULT_SETUP,
    parseDay, durationDays, newPlan, createState, migrate, uniqueName, addPlan, duplicatePlan,
    renamePlan, setActive, archivePlan, restorePlan, cleanLevels, updatePlan, engineSettings, validatePlan,
    EXCLUDE_REASONS, VIEWS, sanitizeOverride, setOverrides, clearOverrides, overrideStats, buildReview,
  };
});
