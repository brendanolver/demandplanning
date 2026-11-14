// Tests for the date-range maths (date-range.js) behind the date-range picker and the Sales Cadence custom range.
const assert = require('assert');
const D = require('../date-range.js');

// ── days ──────────────────────────────────────────────────────────────────────
for (const ok of ['2026-11-14', '2028-02-29', '2026-01-01', '2026-12-31']) assert.equal(D.isDay(ok), true, ok);
for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-2-3', '14/11/2026', '', null, undefined, 20261114, '2026-11-14T00:00']) assert.equal(D.isDay(bad), false, String(bad));
assert.equal(D.addDays('2026-11-14', 1), '2026-11-15'); assert.equal(D.addDays('2026-11-14', -14), '2026-10-31');
assert.equal(D.addDays('2026-12-31', 1), '2027-01-01'); assert.equal(D.addDays('2027-01-01', -1), '2026-12-31');
assert.equal(D.addDays('2028-02-28', 1), '2028-02-29'); assert.equal(D.addDays('2027-02-28', 1), '2027-03-01');
// Melbourne's clocks change on 4 Oct 2026 and 5 Apr 2026: a day is still a day either side (no 23/25-hour drift).
assert.equal(D.addDays('2026-10-03', 1), '2026-10-04'); assert.equal(D.addDays('2026-10-03', 2), '2026-10-05'); assert.equal(D.addDays('2026-04-06', -2), '2026-04-04');
assert.equal(D.countDays('2026-10-01', '2026-10-31'), 31); assert.equal(D.countDays('2026-04-01', '2026-04-30'), 30);
assert.equal(D.countDays('2026-11-14', '2026-11-14'), 1); assert.equal(D.countDays('2026-10-15', '2026-11-13'), 30); assert.equal(D.countDays('2026-01-01', '2026-12-31'), 365); assert.equal(D.countDays('2028-01-01', '2028-12-31'), 366);
assert.equal(D.weekdayIndex('2026-11-14'), 5);   // Saturday
assert.equal(D.weekdayIndex('2026-10-01'), 3);   // Thursday
assert.equal(D.weekdayIndex('2026-11-01'), 6);   // Sunday
assert.equal(D.weekdayIndex('2026-11-09'), 0);   // Monday
assert.equal(D.startOfWeek('2026-11-14'), '2026-11-09'); assert.equal(D.startOfWeek('2026-11-09'), '2026-11-09'); assert.equal(D.startOfWeek('2027-01-01'), '2026-12-28');
assert.equal(D.startOfMonth('2026-11-14'), '2026-11-01'); assert.equal(D.endOfMonth('2026-11-14'), '2026-11-30'); assert.equal(D.endOfMonth('2028-02-03'), '2028-02-29'); assert.equal(D.endOfMonth('2026-12-01'), '2026-12-31');
assert.equal(D.addMonths('2026-11-14', 1), '2026-12-01'); assert.equal(D.addMonths('2026-11-14', 2), '2027-01-01'); assert.equal(D.addMonths('2026-01-31', -1), '2025-12-01'); assert.equal(D.addMonths('2026-03-31', -1), '2026-02-01');

// ── presets: the picker in the brief, opened on Saturday 14 Nov 2026, showed "Last 30 days" = 15 Oct to 13 Nov ──
const TODAY = '2026-11-14';
const P = Object.fromEntries(D.presets(TODAY).map(p => [p.key, p]));
assert.deepEqual(D.presets(TODAY).map(p => p.label), ['Today', 'Yesterday', 'This week', 'Last 7 days', 'Last 14 days', 'Last 30 days', 'Last 90 days', 'This month', 'Last month', 'Year to date']);
const range = k => [P[k].from, P[k].to];
assert.deepEqual(range('today'), ['2026-11-14', '2026-11-14']);
assert.deepEqual(range('yesterday'), ['2026-11-13', '2026-11-13']);
assert.deepEqual(range('this_week'), ['2026-11-09', '2026-11-14']);
assert.deepEqual(range('last_7'), ['2026-11-07', '2026-11-13']);
assert.deepEqual(range('last_14'), ['2026-10-31', '2026-11-13']);
assert.deepEqual(range('last_30'), ['2026-10-15', '2026-11-13']);
assert.deepEqual(range('last_90'), ['2026-08-16', '2026-11-13']);
assert.deepEqual(range('this_month'), ['2026-11-01', '2026-11-14']);
assert.deepEqual(range('last_month'), ['2026-10-01', '2026-10-31']);
assert.deepEqual(range('ytd'), ['2026-01-01', '2026-11-14']);
for (const [k, n] of [['last_7', 7], ['last_14', 14], ['last_30', 30], ['last_90', 90]]) { assert.equal(D.countDays(P[k].from, P[k].to), n); assert.equal(P[k].to, '2026-11-13'); }   // full days, never today
assert.equal(D.summary(P.last_30.from, P.last_30.to), '15 Oct to 13 Nov 2026 · 30 days');
// across a year boundary
const J = Object.fromEntries(D.presets('2027-01-01').map(p => [p.key, p]));
assert.deepEqual([J.last_month.from, J.last_month.to], ['2026-12-01', '2026-12-31']); assert.deepEqual([J.ytd.from, J.ytd.to], ['2027-01-01', '2027-01-01']);
assert.deepEqual([J.this_week.from, J.this_week.to], ['2026-12-28', '2027-01-01']); assert.deepEqual([J.last_7.from, J.last_7.to], ['2026-12-25', '2026-12-31']);
const M = Object.fromEntries(D.presets('2026-03-31').map(p => [p.key, p])); assert.deepEqual([M.last_month.from, M.last_month.to], ['2026-02-01', '2026-02-28']);
// with the first day of data known: "Maximum" appears, older reaches are trimmed, and presets wholly before it go
const withMin = D.presets(TODAY, '2026-09-01'), W = Object.fromEntries(withMin.map(p => [p.key, p]));
assert.deepEqual([W.max.from, W.max.to], ['2026-09-01', TODAY]); assert.equal(withMin[withMin.length - 1].key, 'max');
assert.equal(W.last_90.from, '2026-09-01'); assert.equal(W.ytd.from, '2026-09-01'); assert.equal(W.last_30.from, '2026-10-15');
assert.deepEqual(D.presets(TODAY, '2026-11-10').map(p => p.key), ['today', 'yesterday', 'this_week', 'last_7', 'last_14', 'last_30', 'last_90', 'this_month', 'ytd', 'max']);   // last month is entirely before the data starts
assert.deepEqual(D.presets(TODAY, TODAY).map(p => p.key), ['today', 'this_week', 'this_month', 'ytd', 'max']);
for (const p of D.presets(TODAY, '2026-11-10')) assert.ok(p.from >= '2026-11-10' && p.from <= p.to && p.to <= TODAY, p.key);
assert.equal(D.presets(TODAY, '2026-12-01').some(p => p.key === 'max'), false);   // "first day of data" in the future: no Maximum
// naming a range
assert.equal(D.matchPreset('2026-10-15', '2026-11-13', TODAY).key, 'last_30'); assert.equal(D.matchPreset('2026-10-16', '2026-11-13', TODAY), null);
assert.equal(D.matchPreset('2026-11-01', '2026-11-01', '2026-11-01').key, 'today');   // on the 1st, Today / This month / (a Sunday's) This week… the first listed wins
// a saved selection: presets roll forward with the date, fixed dates don't
assert.deepEqual(D.resolve({ key: 'last_30' }, TODAY), { from: '2026-10-15', to: '2026-11-13', key: 'last_30', label: 'Last 30 days' });
assert.deepEqual(D.resolve({ key: 'last_30' }, '2026-11-15'), { from: '2026-10-16', to: '2026-11-14', key: 'last_30', label: 'Last 30 days' });
assert.deepEqual(D.resolve({ from: '2026-10-15', to: '2026-11-13' }, '2026-11-20'), { from: '2026-10-15', to: '2026-11-13', key: null, label: '15 Oct – 13 Nov 2026' });
for (const bad of [null, undefined, {}, { key: 'nope' }, { from: '2026-11-13', to: '2026-10-15' }, { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-10-15' }, { key: 'last_month' /* before the data */ }]) assert.equal(D.resolve(bad, TODAY, bad && bad.key === 'last_month' ? '2026-11-10' : undefined), null);

// ── text ──────────────────────────────────────────────────────────────────────
assert.equal(D.formatRange('2026-10-15', '2026-11-13'), '15 Oct to 13 Nov 2026'); assert.equal(D.formatRange('2026-11-14', '2026-11-14'), '14 Nov 2026');
assert.equal(D.formatRange('2025-12-15', '2026-11-13'), '15 Dec 2025 to 13 Nov 2026'); assert.equal(D.formatRange('2026-01-01', '2026-01-09', ' – '), '1 Jan – 9 Jan 2026');
assert.equal(D.summary('2026-11-14', '2026-11-14'), '14 Nov 2026 · 1 day'); assert.equal(D.summary('2026-11-13', '2026-11-14'), '13 Nov to 14 Nov 2026 · 2 days');

// ── calendar: the two months in the brief's screenshot ───────────────────────
const oct = D.monthGrid(2026, 10), nov = D.monthGrid(2026, 11);
assert.deepEqual(oct[0], [null, null, null, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);                 // 1 Oct under Thu
assert.deepEqual(oct[oct.length - 1], ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', null]); assert.equal(oct.length, 5);
assert.deepEqual(nov[0], [null, null, null, null, null, null, '2026-11-01']);                                          // 1 Nov alone under Sun
assert.deepEqual(nov[nov.length - 1], ['2026-11-30', null, null, null, null, null, null]); assert.equal(nov.length, 6);
assert.equal(D.monthGrid(2027, 2).length, 4); assert.deepEqual(D.monthGrid(2027, 2)[0][0], '2027-02-01');                 // Feb 2027 is exactly four Mon–Sun weeks
for (const [y, m, n] of [[2026, 10, 31], [2026, 11, 30], [2027, 2, 28], [2028, 2, 29], [2026, 12, 31]]) {
  const g = D.monthGrid(y, m), days = g.flat().filter(Boolean);
  assert.equal(days.length, n); assert.ok(g.every(w => w.length === 7));
  g.forEach(w => w.forEach((d, i) => { if (d) assert.equal(D.weekdayIndex(d), i); }));                                   // every day sits under its own weekday
}
// two clicks make a range, in either order; a third starts over
let s = D.clickDay(null, '2026-11-10'); assert.deepEqual(s, { from: '2026-11-10', to: '2026-11-10', picking: true });
assert.deepEqual(D.clickDay(s, '2026-11-13'), { from: '2026-11-10', to: '2026-11-13', picking: false });
assert.deepEqual(D.clickDay(s, '2026-11-02'), { from: '2026-11-02', to: '2026-11-10', picking: false });
assert.deepEqual(D.clickDay(s, '2026-11-10'), { from: '2026-11-10', to: '2026-11-10', picking: false });               // same day twice = that one day
assert.deepEqual(D.clickDay({ from: '2026-11-02', to: '2026-11-10', picking: false }, '2026-10-20'), { from: '2026-10-20', to: '2026-10-20', picking: true });

// ── splitting a range into columns ────────────────────────────────────────────
assert.deepEqual(D.allowedGroupings(1), ['day']); assert.deepEqual(D.allowedGroupings(7), ['day']); assert.deepEqual(D.allowedGroupings(8), ['day', 'week']);
assert.deepEqual(D.allowedGroupings(30), ['day', 'week', 'month']); assert.deepEqual(D.allowedGroupings(62), ['day', 'week', 'month']); assert.deepEqual(D.allowedGroupings(63), ['week', 'month']);
assert.deepEqual(D.allowedGroupings(366), ['week', 'month']); assert.deepEqual(D.allowedGroupings(367), ['month']); assert.deepEqual(D.allowedGroupings(4000), ['month']);
assert.equal(D.autoGrouping(1), 'day'); assert.equal(D.autoGrouping(14), 'day'); assert.equal(D.autoGrouping(15), 'week'); assert.equal(D.autoGrouping(30), 'week'); assert.equal(D.autoGrouping(98), 'week'); assert.equal(D.autoGrouping(99), 'month');
for (let n = 1; n <= 800; n++) { assert.ok(D.allowedGroupings(n).length >= 1, 'no grouping for ' + n); assert.ok(D.allowedGroupings(n).includes(D.autoGrouping(n)), 'auto not allowed for ' + n); }
assert.equal(D.effectiveGrouping(30, 'day'), 'day'); assert.equal(D.effectiveGrouping(30, 'month'), 'month'); assert.equal(D.effectiveGrouping(30, undefined), 'week'); assert.equal(D.effectiveGrouping(30, 'auto'), 'week');
assert.equal(D.effectiveGrouping(200, 'day'), 'month'); assert.equal(D.effectiveGrouping(5, 'month'), 'day'); assert.equal(D.effectiveGrouping(400, 'week'), 'month');   // an impossible request falls back to automatic

const lbl = ps => ps.map(p => p.label), spans = ps => ps.map(p => [p.from, p.to, p.days]);
// days
assert.deepEqual(lbl(D.buildPeriods('2026-11-11', '2026-11-13', 'day')), ['Wed 11/11', 'Thu 12/11', 'Fri 13/11']);
// weeks: the 30 days in the brief → a 2-day leftover at the start, then four full weeks, newest ending on the last day
const wk = D.buildPeriods('2026-10-15', '2026-11-13', 'week');
assert.deepEqual(lbl(wk), ['W15/10', 'W17/10', 'W24/10', 'W31/10', 'W07/11']);
assert.deepEqual(spans(wk), [['2026-10-15', '2026-10-16', 2], ['2026-10-17', '2026-10-23', 7], ['2026-10-24', '2026-10-30', 7], ['2026-10-31', '2026-11-06', 7], ['2026-11-07', '2026-11-13', 7]]);
assert.deepEqual(D.buildPeriods('2026-10-17', '2026-11-13', 'week').map(p => p.days), [7, 7, 7, 7]);                    // a whole number of weeks: nothing left over
// months, cut off at both ends
const mo = D.buildPeriods('2026-10-15', '2026-11-13', 'month');
assert.deepEqual(lbl(mo), ['Oct 26', 'Nov 26']); assert.deepEqual(spans(mo), [['2026-10-15', '2026-10-31', 17], ['2026-11-01', '2026-11-13', 13]]);
assert.deepEqual(lbl(D.buildPeriods('2025-11-20', '2026-02-10', 'month')), ['Nov 25', 'Dec 25', 'Jan 26', 'Feb 26']);
assert.deepEqual(lbl(D.buildPeriods('2026-06-01', '2026-09-30', 'month')), ['June 26', 'July 26', 'Aug 26', 'Sept 26']);   // en-AU abbreviations, as the 12 Months view shows them
assert.deepEqual(lbl(D.buildPeriods('2026-06-01', '2026-07-31', 'month', { monthLabel: (y, m) => y + '/' + m })), ['2026/6', '2026/7']);

// The custom range reproduces the rolling views exactly when given the same days — same blocks, same labels.
// (Reference = the formulas buildCadencePeriods() in index.html has always used, written with local Date objects.)
{
  const today = new Date(2026, 10, 14), ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const ddmm = d => String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
  for (const n of [5, 12]) {
    const legacy = [];
    for (let i = n - 1; i >= 0; i--) { const a = new Date(today); a.setDate(today.getDate() - i * 7 - 6); const b = new Date(today); b.setDate(today.getDate() - i * 7); legacy.push(['W' + ddmm(a), ymd(a), ymd(b)]); }
    assert.deepEqual(D.buildPeriods(D.addDays(TODAY, -(n * 7 - 1)), TODAY, 'week').map(p => [p.label, p.from, p.to]), legacy, n + ' weeks');
  }
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], legacyDays = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(today); d.setDate(today.getDate() - i); legacyDays.push(names[d.getDay()] + ' ' + ddmm(d)); }
  assert.deepEqual(lbl(D.buildPeriods(D.addDays(TODAY, -6), TODAY, 'day')), legacyDays);
}

// Whatever the range and grouping: the columns cover every day exactly once, in order, with unique labels.
let checked = 0;
for (const from of ['2025-01-01', '2025-12-25', '2026-02-27', '2026-10-01', '2026-10-15', '2027-12-31', '2028-02-01']) {
  for (const n of [1, 2, 6, 7, 8, 13, 14, 15, 28, 29, 30, 31, 59, 62, 63, 90, 98, 99, 180, 364, 365, 366, 367, 500, 800]) {
    const to = D.addDays(from, n - 1);
    for (const g of D.allowedGroupings(n)) {
      const ps = D.buildPeriods(from, to, g), where = from + ' +' + n + ' by ' + g;
      assert.equal(ps[0].from, from, where); assert.equal(ps[ps.length - 1].to, to, where);
      for (let i = 0; i < ps.length; i++) {
        assert.ok(ps[i].from <= ps[i].to, where); assert.equal(ps[i].days, D.countDays(ps[i].from, ps[i].to), where);
        if (i) assert.equal(ps[i].from, D.addDays(ps[i - 1].to, 1), where + ': gap or overlap');
      }
      assert.equal(ps.reduce((a, p) => a + p.days, 0), n, where);
      assert.equal(new Set(lbl(ps)).size, ps.length, where + ': duplicate column label');
      if (g === 'day') assert.equal(ps.length, n);
      if (g === 'week') { assert.equal(ps.length, Math.ceil(n / 7), where); assert.ok(ps.slice(1).every(p => p.days === 7), where + ': only the first block may be short'); }
      if (g === 'month') assert.ok(ps.every(p => p.from.slice(0, 7) === p.to.slice(0, 7)), where + ': a month column spans two months');
      const idx = D.dayIndex(ps); assert.equal(Object.keys(idx).length, n, where);
      assert.equal(idx[from], ps[0].label); assert.equal(idx[to], ps[ps.length - 1].label);
      assert.equal(idx[D.addDays(from, -1)], undefined); assert.equal(idx[D.addDays(to, 1)], undefined);
      checked++;
    }
  }
}
assert.ok(checked > 250, 'sweep ran ' + checked + ' cases');
assert.ok(D.buildPeriods('2025-11-14', '2026-11-14', 'week').length <= 53); assert.ok(D.buildPeriods('2026-09-14', '2026-11-14', 'day').length <= D.MAX_DAY_COLUMNS);

console.log('date range tests: all passed');
