// Shared logic for the server-side Shopify sales feed (sales-sync-background.js
// writes it, sales-data.js serves it). Kept out of netlify/functions so it isn't
// deployed as an endpoint of its own, and dependency-injected (gql/fetchText)
// so the exact same code can be exercised locally against fixtures or the live
// store without a Netlify runtime.
//
// Data shape everywhere internally: { SKU: { 'YYYY-MM-DD': units } } — units
// are LineItem.currentQuantity (already net of refunded/removed items), days
// are STORE-LOCAL calendar days (Shopify reports/Better Reports bucket by the
// shop's timezone, not UTC — a UTC bucket came out 763 vs the true 753 on the
// Mystery Box check, and Melbourne's daylight-saving change is 4 Oct).

const DEFAULT_TZ = 'Australia/Melbourne';
// Line items that aren't products: order protection ("ORDPRO") and the
// returns-coverage line ("OS"). Deliberately a small BLOCK-list rather than an
// allow-list pattern — a strict SKU-shape regex silently dropped a real product
// with an odd SKU (W256A002ASSL, 187 units/yr) that the old CSV path counted.
// Anything else non-product that slips through is harmless: the app only adopts
// units for SKUs it already knows from its own catalogue. Gift cards have no
// SKU at all and are dropped by that rule.
const NON_PRODUCT_SKUS = new Set(['ORDPRO', 'OS']);

function makeDayOf(tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (isoOrDate) => f.format(new Date(isoOrDate)); // en-CA => YYYY-MM-DD
}
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function daysBetween(fromDay, toDay) { // inclusive list
  const out = [];
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) out.push(d);
  return out;
}

function newAggregate() { return { map: {}, price: {}, dropped: {}, droppedUnits: 0, keptUnits: 0 }; }
// gross/net are per-UNIT dollar prices: gross = the shelf price at checkout (a Hextom
// sale changes this), net = after every discount incl. order-level codes. Stored
// as cents x units in agg.price[sku][day] = [grossCents, netCents].
function addLine(agg, rawSku, qty, day, grossUnit, netUnit) {
  const sku = String(rawSku || '').trim().toUpperCase();
  const n = Number(qty) || 0;
  if (!day || n <= 0) return;
  if (!sku || NON_PRODUCT_SKUS.has(sku)) {
    agg.droppedUnits += n;
    const k = sku || '(no sku)';
    agg.dropped[k] = (agg.dropped[k] || 0) + n;
    return;
  }
  if (!agg.map[sku]) agg.map[sku] = {};
  agg.map[sku][day] = (agg.map[sku][day] || 0) + n;
  agg.keptUnits += n;
  const g = Number(grossUnit), nt = Number(netUnit);
  if (isFinite(g) && isFinite(nt) && grossUnit != null && netUnit != null) {
    if (!agg.price[sku]) agg.price[sku] = {};
    const cur = agg.price[sku][day] || [0, 0];
    agg.price[sku][day] = [cur[0] + Math.round(g * 100) * n, cur[1] + Math.round(nt * 100) * n];
  }
}
const moneyOf = set => (set && set.shopMoney ? set.shopMoney.amount : null);
const PRICE_FIELDS = 'originalUnitPriceSet { shopMoney { amount } } discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }';
function addNode(agg, node, day) {
  addLine(agg, node.sku, node.currentQuantity, day, moneyOf(node.originalUnitPriceSet), moneyOf(node.discountedUnitPriceAfterAllDiscountsSet));
}
function topDropped(agg, limit = 15) {
  return Object.entries(agg.dropped).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

// ── Bulk export (full rebuild) ────────────────────────────────────────────
// Shopify's bulk JSONL flattens nested connections into separate rows linked
// by __parentId, and does NOT guarantee a parent row precedes its children —
// learned the hard way (a single-pass parse returned zero from a 260k-row
// export). Index every order's date first, then resolve line items.
function parseBulkNdjson(text, dayOf) {
  // Two passes over the lines without keeping every parsed row: a 2-year export is
  // twice the objects, and holding them all as parsed objects risks the Lambda's memory.
  const lines = text.split('\n');
  const dayByOrder = {};
  let rows = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch (e) { continue; }
    rows++;
    if (!r.__parentId && r.id && r.createdAt) dayByOrder[r.id] = dayOf(r.createdAt);
  }
  const agg = newAggregate();
  let orders = 0, nodes = 0, unresolved = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch (e) { continue; }
    if (!r.__parentId) { orders++; continue; }
    nodes++;
    const day = dayByOrder[r.__parentId];
    if (!day) { unresolved++; continue; }
    addNode(agg, r, day);
  }
  return { ...agg, stats: { rows, orders, lines: nodes, unresolved } };
}

function bulkQuerySince(sinceDay) {
  return `mutation {
    bulkOperationRunQuery(query: """
      { orders(query: "created_at:>='${sinceDay}'") { edges { node {
          id createdAt
          lineItems { edges { node { sku currentQuantity ${PRICE_FIELDS} } } }
      } } } }
    """) { bulkOperation { id status } userErrors { field message } }
  }`;
}

async function runBulkFull({ gql, fetchText, dayOf, sinceDay, sleep = ms => new Promise(r => setTimeout(r, ms)), maxWaitMs = 12 * 60 * 1000, log = () => {} }) {
  // Pad the start by 2 days — the search's own timezone interpretation isn't
  // documented, and rows outside the real window are trimmed below anyway.
  const submit = await gql(bulkQuerySince(addDays(sinceDay, -2)));
  const res = submit.bulkOperationRunQuery;
  if (res.userErrors && res.userErrors.length) throw new Error('bulk submit: ' + res.userErrors.map(e => e.message).join('; '));
  const opId = res.bulkOperation.id;
  log('bulk submitted ' + opId);
  const start = Date.now();
  let url = null;
  for (;;) {
    if (Date.now() - start > maxWaitMs) throw new Error('bulk operation did not finish within ' + Math.round(maxWaitMs / 60000) + ' min');
    const d = await gql('{ currentBulkOperation { id status errorCode objectCount url partialDataUrl } }');
    const op = d.currentBulkOperation;
    if (!op) throw new Error('no bulk operation found');
    if (op.id !== opId) { // someone else's export replaced ours (only one per app at a time)
      throw new Error('bulk operation was replaced by another (' + op.id + ')');
    }
    if (op.status === 'COMPLETED') { url = op.url; log('bulk completed, objectCount ' + op.objectCount); break; }
    if (['FAILED', 'CANCELED', 'EXPIRED'].includes(op.status)) throw new Error('bulk ' + op.status + (op.errorCode ? ' (' + op.errorCode + ')' : ''));
    await sleep(3000);
  }
  if (!url) return { ...newAggregate(), stats: { rows: 0, orders: 0, lines: 0, unresolved: 0 } };
  const text = await fetchText(url);
  const parsed = parseBulkNdjson(text, dayOf);
  // Trim the padding days so a full rebuild covers exactly [sinceDay..today].
  for (const m of [parsed.map, parsed.price]) {
    for (const sku of Object.keys(m)) {
      for (const day of Object.keys(m[sku])) if (day < sinceDay) delete m[sku][day];
      if (!Object.keys(m[sku]).length) delete m[sku];
    }
  }
  return parsed;
}

// ── Incremental (trailing days) ───────────────────────────────────────────
async function fetchRecent({ gql, dayOf, startDay, sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {} }) {
  const q = `query($cursor:String,$q:String!){
    orders(first:50, after:$cursor, query:$q){
      pageInfo{hasNextPage endCursor}
      edges{node{ createdAt lineItems(first:100){ pageInfo{hasNextPage} edges{node{ sku currentQuantity ${PRICE_FIELDS} }} } }}
    }
  }`;
  const search = `created_at:>='${addDays(startDay, -2)}'`; // over-fetch; trimmed by store-day below
  const agg = newAggregate();
  let cursor = null, pages = 0, orders = 0, truncatedOrders = 0;
  do {
    const data = await gql(q, { cursor, q: search });
    const conn = data.orders;
    for (const e of conn.edges) {
      orders++;
      const day = dayOf(e.node.createdAt);
      if (e.node.lineItems.pageInfo && e.node.lineItems.pageInfo.hasNextPage) truncatedOrders++;
      if (day < startDay) continue;
      for (const li of e.node.lineItems.edges) addNode(agg, li.node, day);
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages++;
    if (cursor) await sleep(150);
  } while (cursor);
  log('recent: ' + pages + ' pages, ' + orders + ' orders');
  return { ...agg, stats: { pages, orders, truncatedOrders } };
}

// Replace (never merge) every day in `days` for every SKU: take `fresh` as the
// whole truth for those days, including "no sales" — an order cancelled or
// refunded since the last run must not linger from the old figure. This is
// the same lesson as the Mystery Box top-up bug (frozen partial days).
function replaceDays(existing, fresh, days) {
  const out = {};
  const skus = new Set([...Object.keys(existing), ...Object.keys(fresh)]);
  for (const sku of skus) {
    const cur = { ...(existing[sku] || {}) };
    for (const d of days) {
      const v = fresh[sku] && fresh[sku][d];
      if (v) cur[d] = v; else delete cur[d];
    }
    if (Object.keys(cur).length) out[sku] = cur;
  }
  return out;
}

// ── Compact wire format ({SKU:[dayIdx,units,dayIdx,units,...]}) ────────────
// Keeps a year of sales to ~1-2MB — a plain {sku:{day:units}} JSON is several
// times larger and Lambda hard-caps a function's response at 6MB (returns an
// opaque 502 past that, which already bit the bulk-download path once).
// fromDay (optional) drops older days — the units feed keeps 2 years server-side but
// the app is only ever served the trailing year, exactly as before.
// `width` is how many numbers each day carries (1 for units, 2 for price [gross,net]).
function encodeCompact(map, tz, fromDay, width = 1) {
  const keep = d => !fromDay || d >= fromDay;
  const daySet = new Set();
  for (const sku of Object.keys(map)) for (const d of Object.keys(map[sku])) if (keep(d)) daySet.add(d);
  const days = [...daySet].sort();
  const idx = Object.fromEntries(days.map((d, i) => [d, i]));
  const skus = {};
  for (const sku of Object.keys(map)) {
    const arr = [];
    for (const d of Object.keys(map[sku]).sort()) {
      if (!keep(d)) continue;
      if (width === 1) arr.push(idx[d], map[sku][d]); else arr.push(idx[d], ...map[sku][d]);
    }
    if (arr.length) skus[sku] = arr;
  }
  return { v: 1, tz: tz || DEFAULT_TZ, days, skus };
}
function decodeCompact(c, width = 1) {
  const map = {};
  for (const sku of Object.keys(c.skus)) {
    const arr = c.skus[sku]; map[sku] = {};
    for (let i = 0; i < arr.length; i += 1 + width) map[sku][c.days[arr[i]]] = width === 1 ? arr[i + 1] : arr.slice(i + 1, i + 1 + width);
  }
  return map;
}

module.exports = {
  DEFAULT_TZ, NON_PRODUCT_SKUS, makeDayOf, addDays, daysBetween,
  newAggregate, addLine, topDropped, parseBulkNdjson, runBulkFull, fetchRecent,
  replaceDays, encodeCompact, decodeCompact,
};
