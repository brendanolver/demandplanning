// WNDRR Demand Planning — Sales Cadence PDF export.
// Builds an A4-landscape report from a plain-data SNAPSHOT of what the Sales Cadence
// table is currently showing (index.html records one on every render), using jsPDF +
// jspdf-autotable so the result has selectable text and crisp vector tables.
// No DOM and no network in here: the page loads this with a <script> tag
// (window.SalesCadencePdf) and tests/sales-cadence-pdf.test.js runs the same file under Node.
//
// Snapshot shape (everything already rounded/derived by the app, exactly as displayed):
//   { view:'cat'|'prod', compare:bool, mode:'12m'|'12w'|'5w'|'7d', modeLabel:'12 Months',
//     tz:'Australia/Melbourne', generatedAt:<ISO>, range:{from:'YYYY-MM-DD', to:'YYYY-MM-DD'},
//     periods:[{label}]                    // newest → oldest, as displayed
//     rows:[{ name, colour, status, tier:{emoji,label}|null, dot:'#rrggbb'|null,
//             soh, onOrder, total, stPct|null, cells:[n per period] }],
//     totals:{ soh, onOrder, total, stPct|null, cells:[n per period] },
//     filters:[{label, value}] }
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SalesCadencePdf = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── The original WNDRR wordmark ("ACCENT LOGO - BLACK.pdf"), as the PDF's own vector
  // drawing operators — extracted verbatim from the artwork's content stream, NOT redrawn
  // or retyped. Coordinates are the artwork's native PDF space (y up); BOX is its ArtBox.
  const LOGO_BOX = [171.708, 428.108, 907.572, 652.002];
  const LOGO_OPS = [
    'q 1 0 0 1 655.5166 478.4512 cm',
    '0 0 m -5.533 -5.709 -13.089 -8.564 -22.61 -8.564 c -32.108 -8.564 -39.637 -5.709 -45.197 0 c',
    '-50.759 5.758 -53.515 13.041 -53.515 21.8 c -53.515 30.446 -50.759 37.729 -45.197 43.636 c',
    '-39.637 49.542 -32.108 52.471 -22.61 52.471 c -13.089 52.471 -5.533 49.542 0 43.636 c',
    '5.538 37.729 8.317 30.446 8.317 21.8 c 8.317 13.041 5.538 5.758 0 0 c',
    '6.743 76.558 m -3.295 88.319 -17.297 94.224 -35.307 94.224 c',
    '-55.04 94.224 -71.279 87.187 -84.051 73.089 c -87.717 69.077 -90.767 64.797 -93.376 60.318 c',
    '-95.441 67.7 -98.616 74.048 -102.972 79.313 c -111.287 89.254 -124.131 94.224 -141.601 94.224 c',
    '-160.62 94.224 -175.064 86.941 -184.955 72.301 c -185.447 72.301 l -185.447 89.746 l',
    '-212.586 89.746 l -233.574 89.746 l -265.708 89.746 l -299.836 16.287 l -333.914 89.746 l',
    '-362.456 89.746 l -396.583 16.287 l -430.416 89.746 l -483.809 89.746 l -412.945 -45.865 l',
    '-381.771 -45.865 l -348.209 28.431 l -314.623 -45.865 l -283.449 -45.865 l -233.574 49.592 l',
    '-233.574 -45.865 l -185.447 -45.865 l -185.447 24.456 l',
    '-185.447 45.408 -177.082 55.913 -160.35 55.913 c -158.062 55.913 -155.945 55.643 -154.001 55.126 c',
    '-152.058 54.585 -150.41 54.019 -148.982 53.404 c -147.555 52.79 -146.275 51.805 -145.144 50.501 c',
    '-144.012 49.196 -143.077 48.064 -142.388 47.181 c -141.674 46.294 -141.06 44.916 -140.519 42.947 c',
    '-140.001 41.027 -139.583 39.528 -139.336 38.469 c -139.066 37.387 -138.895 35.763 -138.795 33.572 c',
    '-138.722 31.382 -138.698 29.882 -138.698 29.069 c -138.698 24.31 l -138.698 20.226 l',
    '-138.698 -45.865 l -90.569 -45.865 l -90.569 -20.424 l',
    '-88.554 -23.375 -86.338 -26.329 -83.804 -29.083 c -70.836 -43.258 -54.499 -50.343 -34.765 -50.343 c',
    '-26.303 -50.343 -18.379 -48.719 -10.997 -45.471 c -3.567 -42.174 2.142 -37.302 6.203 -30.806 c',
    '6.743 -30.806 l 6.743 -45.865 l 54.846 -45.865 l 54.846 173.551 l 6.743 173.551 l h f Q',
    'q 1 0 0 1 898.2959 570.0674 cm',
    '0 0 m -20.25 0 -34.84 -8.046 -43.845 -24.064 c -44.387 -24.064 l -44.387 0 l -80.679 0 l',
    '-89.933 0 l -92.49 0 l -92.49 -0.099 l -111.412 -0.738 -125.189 -8.71 -133.802 -24.064 c',
    '-134.343 -24.064 l -134.343 -1.87 l -182.472 -1.87 l -182.472 -137.481 l -134.343 -137.481 l',
    '-134.343 -82.759 l -134.343 -69.718 -131.931 -59.618 -127.06 -52.506 c',
    '-122.237 -45.322 -113.577 -41.779 -101.053 -41.779 c -97.977 -41.779 -95.146 -42.074 -92.49 -42.47 c',
    '-92.49 -137.481 l -44.387 -137.481 l -44.387 -82.759 l -44.387 -69.718 -41.951 -59.618 -37.104 -52.506 c',
    '-32.281 -45.322 -23.597 -41.779 -11.073 -41.779 c -2.805 -41.779 3.987 -43.279 9.276 -46.258 c',
    '9.276 0 l h f Q',
    '481.437 627.889 -42.395 -42.371 re f',
    '538.817 627.889 -42.396 -42.371 re f',
  ];
  const LOGO_RATIO = (LOGO_BOX[2] - LOGO_BOX[0]) / (LOGO_BOX[3] - LOGO_BOX[1]);

  // Draws the logo with its top-left at (x, y) mm and the given width in mm; returns its height.
  function drawLogo(doc, x, y, widthMm, rgb) {
    const k = doc.internal.scaleFactor;
    const pageH = doc.internal.pageSize.getHeight();
    const w = widthMm, h = widthMm / LOGO_RATIO;
    const s = (w * k) / (LOGO_BOX[2] - LOGO_BOX[0]);
    const tx = x * k - LOGO_BOX[0] * s;
    const ty = (pageH - y - h) * k - LOGO_BOX[1] * s;
    const c = rgb || [0, 0, 0];
    const f = n => (n / 255).toFixed(3);
    doc.internal.write('q ' + s.toFixed(6) + ' 0 0 ' + s.toFixed(6) + ' ' + tx.toFixed(4) + ' ' + ty.toFixed(4) + ' cm');
    doc.internal.write(f(c[0]) + ' ' + f(c[1]) + ' ' + f(c[2]) + ' rg');
    LOGO_OPS.forEach(l => doc.internal.write(l));
    doc.internal.write('Q');
    return h;
  }

  // ── Formatting ──────────────────────────────────────────────────────────────
  const fmtInt = n => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fmtPct = n => (n == null || !isFinite(n)) ? '—' : Number(n).toFixed(1) + '%';
  function ymd(date, tz) { // YYYY-MM-DD in the business timezone
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }
  function dmy(date, tz) { // 14 Oct 2026
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).formatToParts(date);
    const g = t => (p.find(x => x.type === t) || {}).value;
    return g('day') + ' ' + g('month') + ' ' + g('year');
  }
  function dmyIso(iso, tz) { // 'YYYY-MM-DD' → 14 Oct 2026 (calendar date, no timezone shifting)
    const [y, m, d] = iso.split('-').map(Number);
    return dmy(new Date(Date.UTC(y, m - 1, d, 12)), 'UTC');
  }
  function timeOf(date, tz) { // 10:24 AM
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(date);
    const g = t => (p.find(x => x.type === t) || {}).value;
    return g('hour') + ':' + g('minute') + ' ' + g('dayPeriod');
  }
  function makeFilename(generatedAt, tz) {
    return 'WNDRR_Sales_Cadence_' + ymd(new Date(generatedAt), tz || 'Australia/Melbourne') + '.pdf';
  }

  // ── Colours (RGB) — the app's own palette ───────────────────────────────────
  const INK = [17, 24, 39], MUTED = [107, 114, 128], FAINT = [156, 163, 175];
  const TEAL = [14, 165, 160], PURPLE = [124, 58, 237], GREEN = [22, 163, 74], AMBER = [217, 119, 6], RED = [220, 38, 38];
  const NAVY = [26, 39, 64], RULE = [226, 229, 234], BAND = [243, 244, 246], HEAD_FILL = [248, 249, 251];
  const hexToRgb = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); return m ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4), 16)] : null; };
  const STATUS = { // [fill, text] — mirrors the .rp-* pills
    CORE: [[219, 234, 254], [37, 99, 235]], NEW: [[220, 252, 231], [22, 163, 74]], CURRENT: [[239, 246, 255], [59, 130, 246]],
    OLD: [[241, 245, 249], [100, 116, 139]], 'OLD CORE': [[229, 235, 245], [59, 90, 138]], REDUCED: [[255, 247, 237], [234, 88, 12]], DRAFT: [[243, 232, 255], [124, 58, 237]],
    'PRE-RELEASE': [[255, 241, 242], [225, 29, 72]], BUNDLE: [[237, 233, 254], [124, 58, 237]], INDENT: [[254, 243, 199], [217, 119, 6]],
    CLEARANCE: [[254, 226, 226], [220, 38, 38]], 'ON ORDER': [[237, 233, 254], [124, 58, 237]],
  };
  const OTHER_STATUS = [[243, 244, 246], [75, 85, 99]];
  const stColour = p => p == null ? FAINT : p >= 60 ? [21, 128, 61] : p >= 30 ? AMBER : RED;

  // ── Model: everything the PDF prints, as strings + colours, derived only from the snapshot ──
  function buildModel(snap) {
    if (!snap || !Array.isArray(snap.periods) || !Array.isArray(snap.rows) || !snap.totals) throw new Error('Nothing to export — the Sales Cadence table has not been built yet.');
    const isCat = snap.view === 'cat';
    const n = snap.periods.length;
    snap.rows.forEach((r, i) => { if (!r.cells || r.cells.length !== n) throw new Error('Row ' + (i + 1) + ' does not have a value for every period.'); });
    if (snap.totals.cells.length !== n) throw new Error('Totals do not cover every period.');
    const noun = isCat ? 'Categories' : 'Products';
    const kpis = [
      { label: noun + ' Selected', value: fmtInt(snap.rows.length) },
      { label: 'Total SOH', value: fmtInt(snap.totals.soh) },
      { label: 'On Order', value: fmtInt(snap.totals.onOrder) },
      { label: 'Sell Through', value: fmtPct(snap.totals.stPct) },
      { label: 'Total Sold (' + snap.modeLabel + ')', value: fmtInt(snap.totals.total) },
    ];
    const head = [isCat ? 'CATEGORY' : 'PRODUCT'].concat(isCat ? [] : ['STATUS'], ['SOH', 'ON ORDER', 'ST%', 'TOTAL SOLD'], snap.periods.map(p => String(p.label).toUpperCase()));
    const rows = snap.rows.map(r => ({
      raw: r,
      cells: [{ text: '' }].concat(isCat ? [] : [{ text: '' }], [
        { text: fmtInt(r.soh), color: INK },
        { text: r.onOrder > 0 ? fmtInt(r.onOrder) : '—', color: r.onOrder > 0 ? PURPLE : FAINT, bold: r.onOrder > 0 },
        { text: fmtPct(r.stPct), color: stColour(r.stPct), bold: r.stPct != null },
        { text: r.total > 0 ? fmtInt(r.total) : '—', color: r.total > 0 ? TEAL : FAINT, bold: r.total > 0 },
      ], r.cells.map((v, i) => {
        const prev = i + 1 < n ? r.cells[i + 1] : null; // next-older period, as the on-screen table compares
        if (!(v > 0)) return { text: '—', color: FAINT };
        if (prev !== null && v > prev) return { text: fmtInt(v), color: GREEN, bold: true };
        if (prev !== null && v < prev) return { text: fmtInt(v), color: RED };
        return { text: fmtInt(v), color: INK };
      })),
    }));
    const foot = ['TOTAL'].concat(isCat ? [] : [''], [fmtInt(snap.totals.soh), fmtInt(snap.totals.onOrder), fmtPct(snap.totals.stPct), fmtInt(snap.totals.total)], snap.totals.cells.map(fmtInt));
    return { isCat, n, kpis, head, rows, foot, noun };
  }

  // Column widths in mm. Numeric columns are fixed; the label column takes whatever the
  // period columns leave (so a 7-day report gets a roomier product column, and a 13-month
  // one a compact one) — never narrower than 50 mm so product names stay readable.
  function columnWidths(model, usable) {
    const fixed = (model.isCat ? [] : [18]).concat([13, 15, 13, 15]);
    const fixedSum = fixed.reduce((a, b) => a + b, 0);
    const periodW = Math.max(9.5, Math.min(17, (usable - fixedSum - 50) / Math.max(1, model.n)));
    const label = usable - fixedSum - periodW * model.n;
    return [label].concat(fixed, new Array(model.n).fill(periodW));
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────
  const PAGE = { w: 297, h: 210 }, M = { l: 10, r: 10, t: 10, b: 14 };
  const USABLE = PAGE.w - M.l - M.r;

  function setText(doc, size, style, rgb) { doc.setFont('helvetica', style || 'normal'); doc.setFontSize(size); doc.setTextColor(rgb[0], rgb[1], rgb[2]); }

  function slimHeader(doc) {
    drawLogo(doc, M.l, M.t, 26);
    setText(doc, 7.5, 'normal', MUTED);
    doc.text('DEMAND PLANNING   |   SALES CADENCE REPORT', PAGE.w - M.r, M.t + 6, { align: 'right' });
    doc.setDrawColor(NAVY[0], NAVY[1], NAVY[2]); doc.setLineWidth(0.35);
    doc.line(M.l, M.t + 11, PAGE.w - M.r, M.t + 11);
    return M.t + 11;
  }

  function firstPageHeader(doc, snap, model, tz, now) {
    const logoH = drawLogo(doc, M.l, M.t, 42);
    setText(doc, 8.5, 'normal', MUTED);
    doc.text('DEMAND PLANNING   |   SALES CADENCE REPORT', PAGE.w - M.r, M.t + logoH - 3, { align: 'right' });
    const ruleY = M.t + logoH + 3.5;
    doc.setDrawColor(NAVY[0], NAVY[1], NAVY[2]); doc.setLineWidth(0.4);
    doc.line(M.l, ruleY, PAGE.w - M.r, ruleY);

    const top = ruleY + 5;
    setText(doc, 22, 'bold', INK);
    doc.text('Sales Cadence', M.l, top + 7.5);
    setText(doc, 10, 'italic', MUTED);
    doc.text('Units sold over time — category & product view', M.l, top + 13.5);

    // Right-hand facts: period, view, filters, generated — one compact column each.
    const dateVal = snap.range && snap.range.from && snap.range.to ? dmyIso(snap.range.from) + ' – ' + dmyIso(snap.range.to) : snap.modeLabel;
    const viewLines = snap.view === 'cat' ? ['Category'] : (snap.compare ? ['Product', 'Compare mode'] : ['Product']);
    const cols = [
      { x: 118, w: 42, label: 'DATE RANGE', lines: [dateVal, snap.modeLabel] },
      { x: 163, w: 24, label: 'VIEW', lines: viewLines },
      { x: 190, w: 62, label: 'FILTERS APPLIED', lines: null },
      { x: 255, w: 32, label: 'GENERATED', lines: [dmy(now, tz), timeOf(now, tz)] },
    ];
    let bottom = top + 14;
    cols.forEach((c, i) => {
      setText(doc, 6.3, 'normal', FAINT);
      doc.text(c.label, c.x, top + 2.5);
      setText(doc, 8, 'normal', INK);
      let lines = c.lines;
      if (!lines) lines = (snap.filters || []).reduce((acc, f) => acc.concat(doc.splitTextToSize(f.label + ': ' + f.value, c.w)), []);
      if (!lines.length) lines = ['None'];
      let y = top + 7;
      lines.forEach(l => { doc.text(String(l), c.x, y); y += 3.6; });
      bottom = Math.max(bottom, y - 1);
      if (i > 0) { doc.setDrawColor(RULE[0], RULE[1], RULE[2]); doc.setLineWidth(0.2); doc.line(c.x - 2.5, top, c.x - 2.5, bottom + 1); }
    });
    // Re-draw dividers to the final shared height so they line up
    doc.setDrawColor(RULE[0], RULE[1], RULE[2]); doc.setLineWidth(0.2);
    cols.slice(1).forEach(c => doc.line(c.x - 2.5, top, c.x - 2.5, bottom + 1));
    return bottom + 4;
  }

  function kpiBand(doc, model, y) {
    const h = 14, w = USABLE / model.kpis.length;
    doc.setFillColor(BAND[0], BAND[1], BAND[2]); doc.rect(M.l, y, USABLE, h, 'F');
    model.kpis.forEach((k, i) => {
      const x = M.l + i * w;
      if (i > 0) { doc.setDrawColor(209, 213, 219); doc.setLineWidth(0.25); doc.line(x, y + 2.5, x, y + h - 2.5); }
      setText(doc, 14, 'bold', INK);
      doc.text(k.value, x + 5, y + 7);
      setText(doc, 7, 'normal', MUTED);
      doc.text(k.label, x + 5, y + 11.3);
    });
    return y + h;
  }

  function drawStatusPill(doc, text, cx, cy) {
    const key = String(text || '').toUpperCase();
    if (!key) { setText(doc, 7, 'normal', FAINT); doc.text('—', cx, cy + 1, { align: 'center' }); return; }
    const [fill, ink] = STATUS[key] || OTHER_STATUS;
    setText(doc, 5.8, 'bold', ink);
    const tw = doc.getTextWidth(key), w = tw + 3.4, h = 3.5;
    doc.setFillColor(fill[0], fill[1], fill[2]);
    doc.roundedRect(cx - w / 2, cy - h / 2, w, h, 0.9, 0.9, 'F');
    doc.text(key, cx, cy + 0.75, { align: 'center' });
  }

  const NAME_PT = 8, SUB_PT = 7, LINE_MM = 3.4, PADX = 1.8, PADY = 1.7;
  const nameBox = (labelW, hasDot, hasTier) => labelW - PADX * 2 - (hasDot ? 4.2 : 0) - (hasTier ? 4.6 : 0);

  // Renders the PDF. opts: { jsPDF, autoTable, snapshot, now?:Date, emojiImage?:(emoji)=>dataUrl|null }
  function buildPdf(opts) {
    const snap = opts.snapshot;
    const model = buildModel(snap);
    const tz = snap.tz || 'Australia/Melbourne';
    const now = opts.now || new Date(snap.generatedAt || Date.now());
    const doc = new opts.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
    doc.setProperties({ title: 'WNDRR Sales Cadence', subject: 'Sales Cadence report', author: 'WNDRR Demand Planning', creator: 'WNDRR Demand Planning' });

    let y = firstPageHeader(doc, snap, model, tz, now);
    y = kpiBand(doc, model, y) + 4;

    if (!model.rows.length) {
      doc.setDrawColor(RULE[0], RULE[1], RULE[2]); doc.setLineWidth(0.25); doc.setFillColor(HEAD_FILL[0], HEAD_FILL[1], HEAD_FILL[2]);
      doc.roundedRect(M.l, y, USABLE, 26, 1.5, 1.5, 'FD');
      setText(doc, 11, 'bold', INK); doc.text('No data for the current view', PAGE.w / 2, y + 11, { align: 'center' });
      setText(doc, 8.5, 'normal', MUTED); doc.text('Nothing matches the selected filters and period — adjust them in Sales Cadence and export again.', PAGE.w / 2, y + 17, { align: 'center' });
    } else {
      const widths = columnWidths(model, USABLE);
      const labelW = widths[0];
      const textCols = model.isCat ? 1 : 2; // columns that carry drawn (non-text) content
      // Row heights are decided up-front from the wrapped name so autotable never clips a product.
      const measured = model.rows.map(r => {
        const hasDot = !!r.raw.dot, hasTier = !!(r.raw.tier && r.raw.tier.emoji && opts.emojiImage);
        setText(doc, NAME_PT, 'bold', INK);
        const lines = doc.splitTextToSize(String(r.raw.name || ''), nameBox(labelW, hasDot, hasTier));
        r.nameLines = lines;
        const total = lines.length * LINE_MM + (r.raw.colour ? LINE_MM - 0.2 : 0) + PADY * 2;
        return Math.max(model.isCat ? 7 : 10, total);
      });

      const body = model.rows.map((r, i) => r.cells.map((c, ci) => ({
        content: c.text,
        styles: Object.assign(
          { textColor: c.color || INK, fontStyle: c.bold ? 'bold' : 'normal', halign: ci < textCols ? 'left' : 'center' },
          ci === 0 ? { minCellHeight: measured[i] } : {}),
      })));

      opts.autoTable(doc, {
        startY: y,
        margin: { left: M.l, right: M.r, top: M.t + 15, bottom: M.b },
        head: [model.head.map((h, i) => ({ content: h, styles: { halign: i < textCols ? 'left' : 'center' } }))],
        body,
        foot: [model.foot.map((f, i) => ({ content: f, styles: { halign: i < textCols ? 'left' : 'center' } }))],
        showHead: 'everyPage', showFoot: 'lastPage', rowPageBreak: 'avoid', tableWidth: USABLE,
        theme: 'grid',
        styles: { font: 'helvetica', fontSize: 7.5, cellPadding: { top: 1.4, bottom: 1.4, left: PADX, right: 1.2 }, lineColor: RULE, lineWidth: 0.2, textColor: INK, valign: 'middle', overflow: 'linebreak' },
        headStyles: { fillColor: HEAD_FILL, textColor: [55, 65, 81], fontStyle: 'bold', fontSize: 6.2, cellPadding: { top: 1.6, bottom: 1.6, left: 1.2, right: 1.2 }, minCellHeight: 8.5 },
        footStyles: { fillColor: BAND, textColor: INK, fontStyle: 'bold', fontSize: 8, minCellHeight: 8 },
        bodyStyles: { fillColor: [255, 255, 255] },
        columnStyles: widths.reduce((o, w, i) => { o[i] = { cellWidth: w }; return o; }, {}),
        didDrawCell(d) {
          if (d.section !== 'body') return;
          const r = model.rows[d.row.index];
          const { x, y: cy, width, height } = d.cell;
          if (d.column.index === 0) {
            const hasDot = !!r.raw.dot, dot = hasDot ? hexToRgb(r.raw.dot) : null;
            const emoji = r.raw.tier && r.raw.tier.emoji && opts.emojiImage ? opts.emojiImage(r.raw.tier.emoji) : null;
            const textX = x + PADX + (dot ? 4.2 : 0);
            const blockH = r.nameLines.length * LINE_MM + (r.raw.colour ? LINE_MM - 0.2 : 0);
            let ty = cy + (height - blockH) / 2 + 2.5;
            if (dot) { doc.setFillColor(dot[0], dot[1], dot[2]); doc.circle(x + PADX + 1.3, cy + height / 2, 1.3, 'F'); }
            setText(doc, NAME_PT, 'bold', INK);
            r.nameLines.forEach(l => { doc.text(l, textX, ty); ty += LINE_MM; });
            if (emoji) {
              const lastW = doc.getTextWidth(r.nameLines[r.nameLines.length - 1] || '');
              // ty has advanced one line past the last name line, so ty - LINE_MM is that line's baseline; the icon sits on it
              try { doc.addImage(emoji, 'PNG', textX + lastW + 1.1, ty - LINE_MM - 2.75, 3.3, 3.3); } catch (e) { /* a bad emoji image must never break the export */ }
            }
            if (r.raw.colour) { setText(doc, SUB_PT, 'normal', TEAL); doc.text(String(r.raw.colour), textX, ty - 0.2); }
          } else if (d.column.index === 1 && !model.isCat) {
            drawStatusPill(doc, r.raw.status, x + width / 2, cy + height / 2);
          }
        },
        didDrawPage(d) { if (d.pageNumber > 1) slimHeader(doc); },
      });
    }

    // Footer on every page — drawn last so the total page count is known.
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      const fy = PAGE.h - 8;
      doc.setDrawColor(RULE[0], RULE[1], RULE[2]); doc.setLineWidth(0.25);
      doc.line(M.l, fy - 3.5, PAGE.w - M.r, fy - 3.5);
      const lh = drawLogo(doc, M.l, fy - 3.2, 14);
      setText(doc, 6.8, 'normal', MUTED);
      doc.text('|   DEMAND PLANNING   |   SALES CADENCE', M.l + 16, fy + 0.2);
      doc.text('Page ' + p + ' of ' + pages + '   |   Generated ' + dmy(now, tz), PAGE.w - M.r, fy + 0.2, { align: 'right' });
    }
    return doc;
  }

  return { buildPdf, buildModel, columnWidths, makeFilename, drawLogo, LOGO_BOX, LOGO_OPS, fmtInt, fmtPct, ymd, dmy, dmyIso, timeOf, STATUS };
});
