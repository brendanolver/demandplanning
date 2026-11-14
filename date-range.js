// WNDRR Demand Planning — date range maths for the date-range picker and the Sales Cadence custom range.
// Pure functions only: no DOM, no clock, no timezone lookups. A "day" is always a 'YYYY-MM-DD' string naming a
// calendar day in the business timezone (the same keys the sales data uses), and "today" is passed in — so the
// answers never depend on the device's own timezone. The page loads this with a <script> tag (window.DateRange)
// and tests/date-range.test.js runs the same file under Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DateRange = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // How en-AU abbreviates months — what the 12 Months view's column headers have always shown (Sept, June, July).
  const MONTHS_AU = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
  const DOW_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];   // weeks run Monday to Sunday
  const DAY_MS = 86400000;

  const pad = n => String(n).padStart(2, '0');
  const parts = day => [Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))];
  const utc = day => { const [y, m, d] = parts(day); return Date.UTC(y, m - 1, d); };
  const fromUtc = ms => { const dt = new Date(ms); return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate()); };
  // A real calendar day in the exact 'YYYY-MM-DD' shape (so 2026-02-30 and 2026-2-3 are both refused).
  const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fromUtc(utc(s)) === s;

  const addDays = (day, n) => fromUtc(utc(day) + n * DAY_MS);
  const countDays = (from, to) => Math.round((utc(to) - utc(from)) / DAY_MS) + 1;          // inclusive of both ends
  const weekdayIndex = day => (new Date(utc(day)).getUTCDay() + 6) % 7;                    // Mon=0 … Sun=6
  const startOfWeek = day => addDays(day, -weekdayIndex(day));
  const startOfMonth = day => day.slice(0, 8) + '01';
  const endOfMonth = day => { const [y, m] = parts(day); return fromUtc(Date.UTC(y, m, 0)); };
  const addMonths = (day, n) => { const [y, m] = parts(day); return fromUtc(Date.UTC(y, m - 1 + n, 1)); };   // the 1st of the month n months away

  // ── Presets, in the order the picker lists them ──────────────────────────────
  // "Last N days" are the N complete days BEFORE today (ending yesterday), the way Meta Ads and the WNDRR
  // international dashboard count them — today is still filling up, so it would understate the newest day.
  // The "This …" and "to date" presets do include today. minDay (optional) is the first day there is data for:
  // a preset reaching back before it is trimmed to it, and one that falls entirely before it is left out.
  function presets(today, minDay) {
    const yesterday = addDays(today, -1);
    const lastN = n => ({ from: addDays(today, -n), to: yesterday });
    const lastMonthEnd = addDays(startOfMonth(today), -1);
    const list = [
      { key: 'today', label: 'Today', from: today, to: today },
      { key: 'yesterday', label: 'Yesterday', from: yesterday, to: yesterday },
      { key: 'this_week', label: 'This week', from: startOfWeek(today), to: today },
      Object.assign({ key: 'last_7', label: 'Last 7 days' }, lastN(7)),
      Object.assign({ key: 'last_14', label: 'Last 14 days' }, lastN(14)),
      Object.assign({ key: 'last_30', label: 'Last 30 days' }, lastN(30)),
      Object.assign({ key: 'last_90', label: 'Last 90 days' }, lastN(90)),
      { key: 'this_month', label: 'This month', from: startOfMonth(today), to: today },
      { key: 'last_month', label: 'Last month', from: startOfMonth(lastMonthEnd), to: lastMonthEnd },
      { key: 'ytd', label: 'Year to date', from: today.slice(0, 4) + '-01-01', to: today },
    ];
    if (minDay && minDay <= today) list.push({ key: 'max', label: 'Maximum', from: minDay, to: today });
    if (!minDay) return list;
    return list.filter(p => p.to >= minDay).map(p => (p.from < minDay ? Object.assign({}, p, { from: minDay }) : p));
  }
  // Which preset (if any) a range is — the first in list order when several coincide (on the 1st, Today = This month).
  function matchPreset(from, to, today, minDay) {
    return presets(today, minDay).find(p => p.from === from && p.to === to) || null;
  }
  // A selection is either a preset ({key}) or fixed dates ({from,to}). A preset is re-resolved against today every
  // time, so "Last 30 days" still means the last 30 days tomorrow. Returns {from,to,label,key} or null.
  function resolve(sel, today, minDay) {
    if (!sel) return null;
    if (sel.key) {
      const p = presets(today, minDay).find(x => x.key === sel.key);
      return p ? { from: p.from, to: p.to, key: p.key, label: p.label } : null;
    }
    if (!isDay(sel.from) || !isDay(sel.to) || sel.from > sel.to) return null;
    return { from: sel.from, to: sel.to, key: null, label: formatRange(sel.from, sel.to, ' – ') };
  }

  // ── Text ─────────────────────────────────────────────────────────────────────
  const dmy = (day, withYear) => { const [y, m, d] = parts(day); return d + ' ' + MONTHS_SHORT[m - 1] + (withYear ? ' ' + y : ''); };
  // "15 Oct to 13 Nov 2026" · "13 Nov 2026" for a single day · both years when they differ.
  function formatRange(from, to, joiner) {
    if (from === to) return dmy(to, true);
    return dmy(from, from.slice(0, 4) !== to.slice(0, 4)) + (joiner || ' to ') + dmy(to, true);
  }
  function summary(from, to) { const n = countDays(from, to); return formatRange(from, to) + ' · ' + n + (n === 1 ? ' day' : ' days'); }

  // ── Comparison periods ───────────────────────────────────────────────────────
  // What a selected range is compared against:
  //   prev — the same number of days immediately before it (30 days vs the 30 days before)
  //   ly   — the same calendar dates one year earlier, as the 12 Months view's LY MTD column does (29 Feb → 28 Feb)
  const COMPARE_MODES = { prev: 'Previous period', ly: 'Same period last year' };
  const yearBack = day => { const [y, m, d] = parts(day), last = parts(endOfMonth((y - 1) + '-' + pad(m) + '-01'))[2]; return (y - 1) + '-' + pad(m) + '-' + pad(Math.min(d, last)); };
  function compareRange(from, to, mode) {
    if (mode === 'prev') { const n = countDays(from, to); return { from: addDays(from, -n), to: addDays(from, -1) }; }
    if (mode === 'ly') return { from: yearBack(from), to: yearBack(to) };
    return null;
  }
  // How much of [from,to] has data, given the first day there is any: { days, covered, from } — from is null when none of it does.
  function coverage(from, to, firstDay) {
    const days = countDays(from, to);
    if (!firstDay || firstDay <= from) return { days, covered: days, from };
    if (firstDay > to) return { days, covered: 0, from: null };
    return { days, covered: countDays(firstDay, to), from: firstDay };
  }
  // Change from `then` to `now`: { units, pct } — pct is null when there is nothing to measure against.
  function change(now, then) {
    const a = Number(now) || 0, b = Number(then) || 0;
    return { units: a - b, pct: b > 0 ? (a - b) / b * 100 : null };
  }

  // ── Calendar ─────────────────────────────────────────────────────────────────
  // One month as rows of 7 (Monday first); cells outside the month are null.
  function monthGrid(year, month) {
    const first = year + '-' + pad(month) + '-01', n = parts(endOfMonth(first))[2];
    const cells = new Array(weekdayIndex(first)).fill(null);
    for (let d = 1; d <= n; d++) cells.push(year + '-' + pad(month) + '-' + pad(d));
    while (cells.length % 7) cells.push(null);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }
  // Picking a range by clicking two days: the first click starts a range, the second completes it (in either
  // order), and a click after that starts again. sel = {from, to, picking}.
  function clickDay(sel, day) {
    if (!sel || !sel.picking) return { from: day, to: day, picking: true };
    return day < sel.from ? { from: day, to: sel.from, picking: false } : { from: sel.from, to: day, picking: false };
  }

  // ── Splitting a range into table columns ─────────────────────────────────────
  // The rolling views carry 5 to 13 columns; a custom range gets the same feel by default, and can be regrouped
  // within what a table can sensibly carry.
  const MAX_DAY_COLUMNS = 62, MAX_WEEK_RANGE_DAYS = 366;
  function allowedGroupings(days) {
    const a = [];
    if (days <= MAX_DAY_COLUMNS) a.push('day');
    if (days >= 8 && days <= MAX_WEEK_RANGE_DAYS) a.push('week');
    if (days >= 29) a.push('month');
    return a;
  }
  const autoGrouping = days => (days <= 14 ? 'day' : days <= 98 ? 'week' : 'month');
  // What will actually be used: the requested grouping when the range allows it, otherwise the automatic one.
  function effectiveGrouping(days, requested) {
    return allowedGroupings(days).includes(requested) ? requested : autoGrouping(days);
  }

  // Columns oldest → newest: [{label, from, to, days}]. Labels match the rolling views ("Fri 13/11", "W07/11",
  // "Nov 26") and are unique within any range the limits above allow.
  //   day   — one per day
  //   week  — 7-day blocks counted back from the END of the range (as the 5/12 Weeks views count back from today),
  //           so the newest column is always a full week; whatever is left over at the start is a shorter block
  //   month — calendar months, cut off at the ends of the range
  function buildPeriods(from, to, grouping, opts) {
    const monthLabel = (opts && opts.monthLabel) || ((y, m) => MONTHS_AU[m - 1] + ' ' + String(y).slice(2));
    const ddmm = day => day.slice(8) + '/' + day.slice(5, 7);
    const out = [];
    if (grouping === 'day') {
      for (let d = from; d <= to; d = addDays(d, 1)) out.push({ label: DOW_SHORT[weekdayIndex(d)] + ' ' + ddmm(d), from: d, to: d });
    } else if (grouping === 'week') {
      for (let end = to; end >= from; end = addDays(end, -7)) {
        const start = addDays(end, -6) < from ? from : addDays(end, -6);
        out.unshift({ label: 'W' + ddmm(start), from: start, to: end });
      }
    } else {
      for (let s = startOfMonth(from); s <= to; s = addMonths(s, 1)) {
        const [y, m] = parts(s), e = endOfMonth(s);
        out.push({ label: monthLabel(y, m), from: s < from ? from : s, to: e > to ? to : e });
      }
    }
    for (const p of out) p.days = countDays(p.from, p.to);
    return out;
  }
  // { 'YYYY-MM-DD': column label } for every day in the periods — one lookup per sales day instead of a scan.
  function dayIndex(periods) {
    const map = {};
    for (const p of periods) for (let d = p.from; d <= p.to; d = addDays(d, 1)) map[d] = p.label;
    return map;
  }

  return {
    MONTHS_LONG, MONTHS_SHORT, DOW_SHORT, MAX_DAY_COLUMNS, MAX_WEEK_RANGE_DAYS,
    isDay, addDays, countDays, weekdayIndex, startOfWeek, startOfMonth, endOfMonth, addMonths,
    presets, matchPreset, resolve, formatRange, summary, monthGrid, clickDay,
    COMPARE_MODES, compareRange, coverage, change,
    allowedGroupings, autoGrouping, effectiveGrouping, buildPeriods, dayIndex,
  };
});
