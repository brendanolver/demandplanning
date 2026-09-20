// Orchestration for the server-side sales feed: decides full vs incremental,
// guards against overlapping/duplicate runs, and only ever overwrites stored
// data with a result that passed sanity checks. Takes its store/network as
// arguments so it can be tested with fakes (see the tests run before each
// deploy) — the function files are thin wrappers around this.

const S = require('./shopify-sales');

const SHOP_DOMAIN = 'thewndrr.myshopify.com';
const API_VERSION = '2025-10';

const MIN_INTERVAL_MS = 4 * 60 * 1000;          // don't re-run incrementals more often than this
const FULL_MAX_AGE_MS = 24 * 60 * 60 * 1000;    // full rebuild daily — picks up refunds on older orders
const FULL_FORCE_MIN_AGE_MS = 30 * 60 * 1000;   // an explicit "full" request is honoured at most this often
const RUNNING_STALE_MS = 20 * 60 * 1000;        // a lock older than this is a dead run, not a live one
const FULL_LOOKBACK_DAYS = 365;
const INCREMENTAL_DAYS = 5;                     // today + 4 trailing — a day is only final once it stops taking orders
const MIN_KEEP_RATIO = 0.5;                     // a full rebuild below half the stored total is treated as broken, not adopted

function makeClient(token, fetchImpl = fetch) {
  async function gql(query, variables) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await fetchImpl(`https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables: variables || {} }),
      });
      const d = await r.json();
      const throttled = d.errors && d.errors.some(e => /throttl/i.test(e.message || '') || (e.extensions && e.extensions.code === 'THROTTLED'));
      if (throttled) { await new Promise(res => setTimeout(res, 2000 * (attempt + 1))); continue; }
      if (d.errors) throw new Error('shopify: ' + d.errors.map(e => e.message).join('; '));
      if (!r.ok) throw new Error('shopify HTTP ' + r.status);
      return d.data;
    }
    throw new Error('shopify: throttled repeatedly');
  }
  async function fetchText(url) {
    const r = await fetchImpl(url);
    if (!r.ok) throw new Error('bulk result download failed: HTTP ' + r.status);
    return r.text();
  }
  return { gql, fetchText };
}

const totalUnits = map => Object.values(map).reduce((s, days) => s + Object.values(days).reduce((a, b) => a + b, 0), 0);

async function runSync({ store, gql, fetchText, requested, now = Date.now(), sleep, log = () => {} }) {
  let meta = (await store.get('meta', { type: 'json' })) || {};
  const save = async patch => { meta = { ...meta, ...patch }; await store.setJSON('meta', meta); };

  if (meta.running && now - meta.running.startedTs < RUNNING_STALE_MS) return { ran: false, reason: 'already running' };

  const fullDue = !meta.lastFullTs
    || now - meta.lastFullTs > FULL_MAX_AGE_MS
    || (requested === 'full' && now - meta.lastFullTs > FULL_FORCE_MIN_AGE_MS);
  const incrDue = !meta.lastSuccessTs || now - meta.lastSuccessTs > MIN_INTERVAL_MS;
  if (!fullDue && !incrDue) return { ran: false, reason: 'fresh' };
  const mode = fullDue ? 'full' : 'incremental';

  await save({ running: { mode, startedTs: now } });
  try {
    const tz = ((await gql('{ shop { ianaTimezone } }')).shop || {}).ianaTimezone || S.DEFAULT_TZ;
    const dayOf = S.makeDayOf(tz);
    const today = dayOf(new Date(now));
    let map, stats, dropped, droppedUnits, patch = {};
    if (mode === 'full') {
      const sinceDay = S.addDays(today, -(FULL_LOOKBACK_DAYS - 1));
      const res = await S.runBulkFull({ gql, fetchText, dayOf, sinceDay, sleep, log });
      map = res.map; stats = res.stats; dropped = S.topDropped(res); droppedUnits = res.droppedUnits;
      const oldMap = (await store.get('daily', { type: 'json' })) || {};
      const oldTotal = totalUnits(oldMap), newTotal = totalUnits(map);
      if (!Object.keys(map).length) throw new Error('full rebuild returned no sales at all — keeping existing data');
      if (oldTotal > 0 && newTotal < oldTotal * MIN_KEEP_RATIO) throw new Error(`full rebuild total ${newTotal} is under ${MIN_KEEP_RATIO * 100}% of stored ${oldTotal} — keeping existing data`);
      patch = { lastFullTs: now, coverageStart: sinceDay };
    } else {
      const startDay = S.addDays(today, -(INCREMENTAL_DAYS - 1));
      const res = await S.fetchRecent({ gql, dayOf, startDay, sleep, log });
      const existing = (await store.get('daily', { type: 'json' })) || {};
      map = S.replaceDays(existing, res.map, S.daysBetween(startDay, today));
      stats = res.stats; dropped = S.topDropped(res); droppedUnits = res.droppedUnits;
    }
    await store.setJSON('daily', map);
    await save({
      ...patch, tz, lastDay: today, lastSuccessTs: now, lastMode: mode, running: null,
      lastError: null, lastErrorTs: null,
      stats: { ...stats, skus: Object.keys(map).length, units: totalUnits(map), droppedUnits, dropped },
    });
    return { ran: true, mode, skus: Object.keys(map).length, units: totalUnits(map) };
  } catch (e) {
    await save({ running: null, lastError: String(e && e.message || e), lastErrorTs: now });
    return { ran: true, mode, error: String(e && e.message || e) };
  }
}

const MAX_RESPONSE_BYTES = 5.5 * 1024 * 1024; // Lambda hard-caps a function's response at 6MB
async function getPayload({ store, metaOnly, now = Date.now() }) {
  const meta = (await store.get('meta', { type: 'json' })) || {};
  const publicMeta = {
    tz: meta.tz, coverageStart: meta.coverageStart, lastDay: meta.lastDay,
    lastSuccessTs: meta.lastSuccessTs, lastFullTs: meta.lastFullTs, lastMode: meta.lastMode,
    lastError: meta.lastError, lastErrorTs: meta.lastErrorTs, stats: meta.stats,
    syncing: !!(meta.running && now - meta.running.startedTs < RUNNING_STALE_MS),
    ageSec: meta.lastSuccessTs ? Math.round((now - meta.lastSuccessTs) / 1000) : null,
  };
  if (metaOnly) return { status: 200, body: { ready: !!meta.lastFullTs, meta: publicMeta } };
  const daily = await store.get('daily', { type: 'json' });
  if (!daily || !meta.lastFullTs) return { status: 200, body: { ready: false, meta: publicMeta } };
  const body = { ready: true, meta: publicMeta, data: S.encodeCompact(daily, meta.tz) };
  const size = Buffer.byteLength(JSON.stringify(body));
  if (size > MAX_RESPONSE_BYTES) return { status: 500, body: { error: `sales payload is ${size} bytes — over the response limit, needs splitting`, meta: publicMeta } };
  return { status: 200, body };
}

module.exports = { makeClient, runSync, getPayload, totalUnits, MIN_INTERVAL_MS, FULL_MAX_AGE_MS, FULL_FORCE_MIN_AGE_MS };
