// Tests for the Sales Cadence PDF export (sales-cadence-pdf.js) — run with `npm test`.
// Builds real PDFs with jsPDF + jspdf-autotable from synthetic snapshots (same shape the app records
// on every Sales Cadence render) and checks the numbers, layout rules and edge cases from the spec.
const assert = require('assert');
const { jsPDF: RealJsPdf } = require('jspdf');
const { autoTable } = require('jspdf-autotable');
const P = require('../sales-cadence-pdf.js');

// Wrap jsPDF so every string drawn is recorded per page (the PDF itself is compressed).
function recorder() {
  const log = { pages: {}, all: [] };
  const jsPDF = new Proxy(RealJsPdf, {
    construct(T, args) {
      const doc = new T(...args);
      const orig = doc.text.bind(doc);
      doc.text = function (t, ...rest) {
        (Array.isArray(t) ? t : [t]).forEach(s => { const p = doc.getCurrentPageInfo().pageNumber; (log.pages[p] = log.pages[p] || []).push(String(s)); log.all.push(String(s)); });
        return orig(t, ...rest);
      };
      return doc;
    },
  });
  return { jsPDF, log };
}

const MONTHS = ['Oct 26', 'Sept 26', 'Aug 26', 'July 26', 'June 26', 'May 26', 'Apr 26', 'Mar 26', 'Feb 26', 'Jan 26', 'Dec 25', 'Nov 25', 'Oct 25'];
const mkRow = (name, colour, status, soh, onOrder, cells, extra) => {
  const total = cells.reduce((a, b) => a + b, 0);
  return Object.assign({ name, colour, status, tier: null, dot: '#2dd4bf', soh, onOrder, total, stPct: total > 0 ? total / (soh + total) * 100 : null, cells }, extra || {});
};
function mkSnap(rows, over) {
  const periods = ((over && over.periodLabels) || MONTHS).map(label => ({ label }));
  const sum = k => rows.reduce((s, r) => s + r[k], 0);
  const cells = periods.map((_, i) => rows.reduce((s, r) => s + r.cells[i], 0));
  const total = sum('total'), soh = sum('soh');
  return Object.assign({
    view: 'prod', compare: false, mode: '12m', modeLabel: '12 Months', tz: 'Australia/Melbourne', generatedAt: '2026-10-13T10:24:00+11:00',
    range: { from: '2025-10-01', to: '2026-10-13' }, periods, rows,
    totals: { soh, onOrder: sum('onOrder'), total, stPct: total + soh > 0 ? total / (soh + total) * 100 : null, cells },
    filters: [{ label: 'Status', value: 'All' }, { label: 'Categories', value: 'All' }, { label: 'Tiers', value: 'All' }],
  }, over && over.snap);
}
const gen = n => Array.from({ length: n }, (_, i) => mkRow('PRODUCT ' + (i + 1), 'COLOUR ' + (i % 7), ['CORE', 'NEW', 'OLD', 'BUNDLE'][i % 4], (i * 13) % 200, i % 5 ? 0 : 100, MONTHS.map((_, m) => ((i + 1) * (m + 3)) % 23)));
const build = (snap, extra) => { const r = recorder(); const doc = P.buildPdf(Object.assign({ jsPDF: r.jsPDF, autoTable: (d, o) => autoTable(d, o), snapshot: snap, now: new Date(snap.generatedAt) }, extra)); return { doc, log: r.log }; };
const fmt = n => n.toLocaleString('en-US');

// 1. Compare mode, 4 products, 12 months — single landscape A4 page, KPI + TOTAL equal the sums of the rows
{
  const snap = mkSnap([
    mkRow('OFFEND BEACH SHORT', 'AIR BLUE', 'BUNDLE', 143, 200, [7, 11, 3, 17, 6, 2, 9, 20, 8, 20, 57, 104, 27]),
    mkRow('OFFEND BEACH SHORT', 'WASHED BLACK', 'BUNDLE', 197, 150, [9, 22, 8, 19, 10, 5, 4, 21, 14, 19, 55, 113, 14]),
    mkRow('OFFEND BEACH SHORT', 'CEMENT GREY', 'BUNDLE', 137, 200, [4, 22, 5, 23, 4, 4, 14, 26, 10, 12, 70, 56, 32]),
    mkRow('OFFEND BEACH SHORT', 'BLACK', 'BUNDLE', 132, 650, [15, 46, 31, 91, 19, 22, 31, 63, 17, 51, 138, 309, 56]),
  ], { snap: { compare: true, filters: [{ label: 'Products', value: '4 selected' }] } });
  const { doc, log } = build(snap);
  assert.equal(doc.getNumberOfPages(), 1);
  assert.equal(doc.internal.pageSize.getWidth().toFixed(0), '297'); assert.equal(doc.internal.pageSize.getHeight().toFixed(0), '210');
  const m = P.buildModel(snap);
  assert.deepEqual(m.kpis.map(k => k.label), ['Products Selected', 'Total SOH', 'On Order', 'Sell Through', 'Total Sold (12 Months)']);
  assert.equal(m.kpis[0].value, '4'); assert.equal(m.kpis[1].value, fmt(143 + 197 + 137 + 132)); assert.equal(m.kpis[2].value, fmt(1200));
  const tot = snap.rows.reduce((s, r) => s + r.total, 0); assert.equal(m.kpis[4].value, fmt(tot));
  assert.equal(m.kpis[3].value, (tot / (609 + tot) * 100).toFixed(1) + '%');          // aggregate ST%, not a mean of row ST%s
  assert.equal(m.foot[0], 'TOTAL'); assert.equal(m.foot.length, m.head.length);
  assert.ok(log.all.includes('Page 1 of 1   |   Generated 13 Oct 2026'));
  assert.ok(log.all.some(s => /Compare mode/.test(s)) && log.all.some(s => /4 selected/.test(s)));
  assert.ok(log.all.includes('OFFEND BEACH SHORT') && log.all.includes('AIR BLUE'));
  assert.equal(P.makeFilename(snap.generatedAt, snap.tz), 'WNDRR_Sales_Cadence_2026-10-13.pdf');
}

// 2. Single product
{
  const { doc, log } = build(mkSnap([mkRow('SOLO TEE', 'BLACK', 'CORE', 50, 0, MONTHS.map((_, i) => i))]));
  assert.equal(doc.getNumberOfPages(), 1); assert.ok(log.all.includes('SOLO TEE'));
  assert.equal(P.buildModel(mkSnap([mkRow('X', 'Y', 'CORE', 1, 0, MONTHS.map(() => 1))])).kpis[0].value, '1');
}

// 3. 20+ rows and a large multi-page selection: paginates, headings repeat, grand total only on the last page,
//    no row is dropped, page numbers are right
for (const n of [22, 64, 200]) {
  const rows = gen(n), snap = mkSnap(rows);
  const { doc, log } = build(snap);
  const pages = doc.getNumberOfPages();
  assert.ok(pages >= (n > 30 ? 2 : 1), n + ' rows → ' + pages + ' pages');
  for (let p = 1; p <= pages; p++) {
    assert.ok(log.pages[p].includes('Page ' + p + ' of ' + pages + '   |   Generated 13 Oct 2026'), 'footer on page ' + p);
    assert.ok(log.pages[p].includes('PRODUCT') && log.pages[p].includes('ON ORDER'), 'column headings on page ' + p);
    // The "TOTAL" of the TOTAL SOLD heading repeats on every page; the TOTAL row adds exactly one more, on the last page only.
    if (pages > 1) assert.equal(log.pages[p].filter(s => s === 'TOTAL').length, log.pages[1].filter(s => s === 'TOTAL').length + (p === pages ? 1 : 0), 'TOTAL row only on the last page (page ' + p + ')');
  }
  rows.forEach(r => assert.ok(log.all.includes(r.name), r.name + ' missing'));      // nothing silently omitted
  const names = log.all.filter(s => /^PRODUCT \d+$/.test(s));
  assert.deepEqual(names, rows.map(r => r.name));                                   // sort order preserved, each row exactly once
  assert.ok(log.pages[pages].includes(fmt(snap.totals.total)));                     // grand total on the final page
  if (pages > 1) assert.ok(log.pages[1].length && !log.pages[2].includes('Sales Cadence'), 'title only on page 1');
}

// 4. Category view: no Status column, ST% still present, noun switches
{
  const snap = mkSnap([mkRow('TEES', '', '', 500, 20, MONTHS.map(() => 10)), mkRow('SHORTS', '', '', 300, 0, MONTHS.map(() => 4))], { snap: { view: 'cat', filters: [{ label: 'Core', value: 'All' }] } });
  const m = P.buildModel(snap);
  assert.deepEqual(m.head.slice(0, 5), ['CATEGORY', 'SOH', 'ON ORDER', 'ST%', 'TOTAL SOLD']);
  assert.equal(m.kpis[0].label, 'Categories Selected');
  const w = P.columnWidths(m, 277); assert.equal(w.length, m.head.length);
  const { doc, log } = build(snap); assert.equal(doc.getNumberOfPages(), 1); assert.ok(log.all.includes('Category'));
}

// 5. Shorter periods (12 weeks, 5 weeks, 7 days) — column widths always fill exactly the usable width
for (const [mode, label, n] of [['12w', '12 Weeks', 12], ['5w', '5 Weeks', 5], ['7d', '7 Days', 7]]) {
  const labels = Array.from({ length: n }, (_, i) => 'P' + (i + 1));
  const rows = gen(8).map(r => mkRow(r.name, r.colour, r.status, r.soh, r.onOrder, labels.map((_, i) => (i * 3) % 11)));
  const snap = mkSnap(rows, { periodLabels: labels, snap: { mode, modeLabel: label } });
  const m = P.buildModel(snap), w = P.columnWidths(m, 277);
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 277) < 1e-6, mode + ' widths sum');
  assert.ok(w[0] >= 50, mode + ' label column too narrow: ' + w[0]);
  assert.equal(m.kpis[4].label, 'Total Sold (' + label + ')');
  assert.equal(build(snap).doc.getNumberOfPages(), 1);
}
// 13 monthly periods also fit
{ const w = P.columnWidths(P.buildModel(mkSnap(gen(3))), 277); assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 277) < 1e-6 && w[0] >= 50); }

// 6. Empty results — a real report with an explicit empty state, not an error or a blank page
{
  const snap = mkSnap([], { snap: { filters: [{ label: 'Search', value: '"ZZZ"' }] } });
  assert.equal(snap.totals.stPct, null);
  const { doc, log } = build(snap);
  assert.equal(doc.getNumberOfPages(), 1);
  assert.ok(log.all.includes('No data for the current view')); assert.ok(log.all.includes('Page 1 of 1   |   Generated 13 Oct 2026'));
  assert.ok(!log.all.includes('TOTAL'));
}

// 7. Long descriptions wrap and never split a row; zero SOH / zero sales render as 0 and an em dash
{
  const long = 'THE EXTREMELY LONG PRODUCT DESCRIPTION THAT KEEPS GOING AND GOING ' + 'WITH EVEN MORE WORDS '.repeat(4);
  const rows = gen(40); rows[17] = mkRow(long, 'A VERY LONG COLOURWAY NAME THAT ALSO NEEDS TO WRAP', 'CORE', 0, 0, MONTHS.map(() => 0));
  const snap = mkSnap(rows);
  const { doc, log } = build(snap);
  assert.ok(doc.getNumberOfPages() >= 2);
  const joined = log.all.join(' ').replace(/\s+/g, ' ');
  long.split(' ').filter(Boolean).forEach(word => assert.ok(joined.includes(word), 'word lost: ' + word));
  const m = P.buildModel(snap), z = m.rows[17].cells;
  assert.equal(z[1 + 1].text, '0');                                        // SOH 0 → "0" (status is cell 1)
  assert.equal(z[3].text, '—'); assert.equal(z[4].text, '—');               // on order 0 → dash, ST% null → dash
  assert.equal(z[5].text, '—'); assert.ok(z.slice(6).every(c => c.text === '—'));
}

// 8. Month cells compare with the next-older period (green higher, red lower, dash for zero)
{
  const m = P.buildModel(mkSnap([mkRow('A', 'B', 'CORE', 10, 0, [5, 3, 3, 0, 9, 1, 1, 1, 1, 1, 1, 1, 1])]));
  const c = m.rows[0].cells.slice(6);
  assert.equal(c[0].color, c[0].bold ? c[0].color : null); assert.deepEqual(c[0].color, [22, 163, 74]);   // 5 > 3 → green
  assert.deepEqual(c[1].color, [17, 24, 39]);                                                              // 3 = 3 → ink
  assert.equal(c[3].text, '—');                                                                            // 0 → dash
  assert.deepEqual(c[4].color, [22, 163, 74]);                                                             // 9 > 1
}

// 9. Bad snapshots fail loudly with a message the UI can show
assert.throws(() => P.buildModel(null), /Nothing to export/);
assert.throws(() => P.buildModel({ periods: [], rows: [], totals: null }), /Nothing to export/);
assert.throws(() => P.buildModel(mkSnap([Object.assign(mkRow('A', 'B', 'CORE', 1, 0, [1, 2]))])), /every period/);

// 10. Original logo: vector operators present, no raster, scaled into the requested box
{
  assert.ok(P.LOGO_OPS.length > 4 && P.LOGO_OPS.some(l => / c$| c /.test(l) || /\bc\b/.test(l)));
  const { doc } = build(mkSnap(gen(2)));
  assert.ok(doc.internal.getNumberOfPages() === 1);
  const h = P.drawLogo(new RealJsPdf({ orientation: 'landscape', unit: 'mm', format: 'a4' }), 10, 10, 42);
  assert.ok(Math.abs(h - 42 * (P.LOGO_BOX[3] - P.LOGO_BOX[1]) / (P.LOGO_BOX[2] - P.LOGO_BOX[0])) < 1e-6);
}

// 11. Formatters
assert.equal(P.fmtInt(1234567), '1,234,567'); assert.equal(P.fmtPct(81.456), '81.5%'); assert.equal(P.fmtPct(null), '—');

console.log('sales cadence pdf tests: all passed');
