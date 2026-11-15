// Orchestration for the server-side sales feed: decides full vs incremental,
// guards against overlapping/duplicate runs, and only ever overwrites stored
// data with a result that passed sanity checks. Takes its store/network as
// arguments so it can be tested with fakes (tests/sales-feed.test.js, run with
// `npm test`) — the function files are thin wrappers around this.

const S = require('./shopify-sales');

const SHOP_DOMAIN = 'thewndrr.myshopify.com';
const API_VERSION = '2025-10';

const QUICK_INTERVAL_MS = 45 * 1000;            // a 'quick' (today only) refresh is due when the stored data is older than this
const TRAILING_EVERY_MS = 10 * 60 * 1000;       // the 5-day trailing refresh (catches refunds / cancellations on recent days) runs this often
const FULL_MAX_AGE_MS = 24 * 60 * 60 * 1000;    // full rebuild daily — picks up refunds on older orders
const FULL_FORCE_MIN_AGE_MS = 30 * 60 * 1000;   // an explicit "full" request is honoured at most this often
const RUNNING_STALE_MS = 20 * 60 * 1000;        // a lock older than this is a dead run, not a live one
const FULL_LOOKBACK_DAYS = 730;                  // stored history — 2 years, so last year's promos stay comparable
const SERVE_DAYS = 365;                         // the units feed the app merges is still served as the trailing year only
const ERROR_BACKOFF_MS = 10 * 60 * 1000;        // after a failed FULL rebuild, don't re-attempt (it is minutes of Shopify work) for this long
const WEBHOOK_MIN_GAP_MS = 2 * 1000;            // a Shopify order notification skips the 45 s quick interval, but not a run that finished a moment ago
const MAX_POKE_ROUNDS = 4;                      // re-runs in one worker invocation when more order notifications land mid-sync
const QUICK_ERROR_BACKOFF_MS = 2 * 60 * 1000;   // a failed quick / trailing run is cheap to retry, so a Shopify blip doesn't freeze sales for 10 minutes
// Bump whenever what gets stored changes (filters, bucketing, shape): a stored
// feed built under older rules is rebuilt in full on the next run instead of
// waiting up to a day for the scheduled rebuild.
const FEED_VERSION = 3;
const INCREMENTAL_DAYS = 5;                     // today + 4 trailing — a day is only final once it stops taking orders
// Three kinds of run, cheapest first:
//   quick        today only. Reads just the orders since a few hours before the shop's midnight (a handful of pages, seconds).
//                This is what makes today's sales appear within a minute or two.
//   incremental  the trailing 5 days (reads ~a week of orders: ~1 minute). Runs at most every 10 minutes, and at once when the
//                shop's day has rolled over (so yesterday is finalised from the full day's orders).
//   full         everything, daily (or when the stored rules are out of date).
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

// A small snapshot of the last few days: per SKU per day, the units AND what they sold for, taken from the same
// run so the two always agree ({SKU:[dayIdx, units, grossCents, netCents, ...]}; gross = shelf price x units,
// net = what was actually paid after every discount; both null where Shopify recorded no price). Kilobytes rather
// than the megabytes of the full price history, so the dashboard can afford to fetch it on every refresh —
// "Today's Margin" is worked out from it.
function buildRecent(map, priceMap, days, tz, today, now) {
  const merged = {};
  for (const sku of Object.keys(map)) {
    for (const d of days) {
      const units = map[sku][d];
      if (!units) continue;
      const p = priceMap && priceMap[sku] && priceMap[sku][d];
      (merged[sku] = merged[sku] || {})[d] = [units, p ? p[0] : null, p ? p[1] : null];
    }
  }
  return { ...S.encodeCompact(merged, tz, null, 3), lastDay: today, syncTs: now };
}

async function runSync({ store, gql, fetchText, requested, now = Date.now(), sleep, log = () => {} }) {
  let meta = (await store.get('meta', { type: 'json' })) || {};
  const save = async patch => { meta = { ...meta, ...patch }; await store.setJSON('meta', meta); };

  if (meta.running && now - meta.running.startedTs < RUNNING_STALE_MS) return { ran: false, reason: 'already running' };
  if (meta.lastErrorTs && now - meta.lastErrorTs < (meta.lastErrorMode === 'full' ? ERROR_BACKOFF_MS : QUICK_ERROR_BACKOFF_MS)) return { ran: false, reason: 'recent error' };

  const fullDue = !meta.lastFullTs
    || meta.feedVersion !== FEED_VERSION
    || now - meta.lastFullTs > FULL_MAX_AGE_MS
    || (requested === 'full' && now - meta.lastFullTs > FULL_FORCE_MIN_AGE_MS);
  const dayNow = S.makeDayOf(meta.tz || S.DEFAULT_TZ)(new Date(now));
  const lastTrailing = meta.lastTrailingTs || meta.lastSuccessTs || 0;      // a feed written before quick runs existed: its last run was a trailing one
  // requested === 'webhook': Shopify just told us an order was placed / changed. Refresh today at once (the 10-minute trailing run is left
  // to the timer, which keeps running alongside), unless the shop's day has rolled over, which still needs its trailing run first.
  const hook = requested === 'webhook';
  const dayRolled = !!meta.lastDay && meta.lastDay !== dayNow;
  const trailingDue = !meta.lastSuccessTs || dayRolled || (!hook && now - lastTrailing >= TRAILING_EVERY_MS);
  const quickDue = !meta.lastSuccessTs || now - meta.lastSuccessTs >= (hook ? WEBHOOK_MIN_GAP_MS : QUICK_INTERVAL_MS);
  if (!fullDue && !trailingDue && !quickDue) return { ran: false, reason: 'fresh' };
  const mode = fullDue ? 'full' : trailingDue ? 'incremental' : 'quick';

  await save({ running: { mode, startedTs: now } });
  try {
    const tz = ((await gql('{ shop { ianaTimezone } }')).shop || {}).ianaTimezone || S.DEFAULT_TZ;
    const dayOf = S.makeDayOf(tz);
    const today = dayOf(new Date(now));
    let map, priceMap, stats, dropped, droppedUnits, patch = {};
    if (mode === 'full') {
      const sinceDay = S.addDays(today, -(FULL_LOOKBACK_DAYS - 1));
      const res = await S.runBulkFull({ gql, fetchText, dayOf, sinceDay, sleep, log });
      map = res.map; priceMap = res.price; stats = res.stats; dropped = S.topDropped(res); droppedUnits = res.droppedUnits;
      const oldMap = (await store.get('daily', { type: 'json' })) || {};
      const oldTotal = totalUnits(oldMap), newTotal = totalUnits(map);
      if (!Object.keys(map).length) throw new Error('full rebuild returned no sales at all — keeping existing data');
      if (oldTotal > 0 && newTotal < oldTotal * MIN_KEEP_RATIO) throw new Error(`full rebuild total ${newTotal} is under ${MIN_KEEP_RATIO * 100}% of stored ${oldTotal} — keeping existing data`);
      patch = { lastFullTs: now, lastTrailingTs: now, coverageStart: S.addDays(today, -(SERVE_DAYS - 1)), storedStart: sinceDay, feedVersion: FEED_VERSION };
    } else {
      const quick = mode === 'quick';
      // quick: today only, read from 09:00Z the day before — earlier than the shop's local midnight in any timezone; the day trim drops the overlap
      const startDay = quick ? today : S.addDays(today, -(INCREMENTAL_DAYS - 1));
      const res = await S.fetchRecent({ gql, dayOf, startDay, searchSince: quick ? S.addDays(today, -1) + 'T09:00:00Z' : undefined, sleep, log });
      if (!quick) patch = { lastTrailingTs: now };
      const existing = (await store.get('daily', { type: 'json' })) || {};
      const days = S.daysBetween(startDay, today);
      map = S.replaceDays(existing, res.map, days);
      const existingPrice = (await store.get('price', { type: 'json' })) || {};
      priceMap = S.replaceDays(existingPrice, res.price, days);
      stats = res.stats; dropped = S.topDropped(res); droppedUnits = res.droppedUnits;
      if (quick) stats = null;                                                  // a quick run only sees today, so its counts must not replace the trailing run's
    }
    await store.setJSON('daily', map);
    await store.setJSON('price', priceMap);
    // Convenience copy for the dashboard. It must never be able to fail the sync that feeds everything else.
    try { await store.setJSON('recent', buildRecent(map, priceMap, S.daysBetween(S.addDays(today, -(INCREMENTAL_DAYS - 1)), today), tz, today, now)); }
    catch (e) { log('recent snapshot not written: ' + (e && e.message || e)); }
    await save({
      ...patch, tz, lastDay: today, lastSuccessTs: now, lastMode: mode, running: null,
      lastError: null, lastErrorTs: null,
      ...(stats ? { stats: { ...stats, skus: Object.keys(map).length, units: totalUnits(map), droppedUnits, dropped } } : {}),
    });
    return { ran: true, mode, skus: Object.keys(map).length, units: totalUnits(map) };
  } catch (e) {
    await save({ running: null, lastError: String(e && e.message || e), lastErrorTs: now, lastErrorMode: mode });
    return { ran: true, mode, error: String(e && e.message || e) };
  }
}

// What the background worker calls. One runSync, then: if a Shopify order notification arrived while it was working (its
// 'poke' timestamp is later than this run's start), that run may have read the orders just before the new one existed, so
// go round again — up to MAX_POKE_ROUNDS times. Notifications that find a run in progress or a very recent one simply
// record their poke and rely on this check (or the 2-minute timer, whichever comes first).
async function syncWithPokes({ store, gql, fetchText, requested, sleep, log = () => {}, clock = Date.now }) {
  let result, rounds = 0;
  for (;;) {
    const startedAt = clock();
    result = await runSync({ store, gql, fetchText, requested: rounds ? 'webhook' : requested, now: startedAt, sleep, log });
    rounds++;
    if (!result.ran || result.error || rounds >= MAX_POKE_ROUNDS) break;
    const poke = await store.get('poke', { type: 'json' });
    if (!(poke && poke.ts > startedAt)) break;
    log('order notification arrived during the run — syncing again');
  }
  return { ...result, rounds };
}

const MAX_RESPONSE_BYTES = 5.5 * 1024 * 1024; // Lambda hard-caps a function's response at 6MB
async function getPayload({ store, metaOnly, now = Date.now() }) {
  const meta = (await store.get('meta', { type: 'json' })) || {};
  const poke = metaOnly ? await store.get('poke', { type: 'json' }).catch(() => null) : null;
  const publicMeta = {
    lastWebhookTs: poke && poke.ts || null,
    tz: meta.tz, coverageStart: meta.coverageStart, storedStart: meta.storedStart, lastDay: meta.lastDay,
    lastSuccessTs: meta.lastSuccessTs, lastFullTs: meta.lastFullTs, lastMode: meta.lastMode,
    lastError: meta.lastError, lastErrorTs: meta.lastErrorTs, stats: meta.stats,
    syncing: !!(meta.running && now - meta.running.startedTs < RUNNING_STALE_MS),
    ageSec: meta.lastSuccessTs ? Math.round((now - meta.lastSuccessTs) / 1000) : null,
  };
  if (metaOnly) return { status: 200, body: { ready: !!meta.lastFullTs, meta: publicMeta } };
  const daily = await store.get('daily', { type: 'json' });
  if (!daily || !meta.lastFullTs) return { status: 200, body: { ready: false, meta: publicMeta } };
  const body = { ready: true, meta: publicMeta, data: S.encodeCompact(daily, meta.tz, meta.coverageStart) };
  const size = Buffer.byteLength(JSON.stringify(body));
  if (size > MAX_RESPONSE_BYTES) return { status: 500, body: { error: `sales payload is ${size} bytes — over the response limit, needs splitting`, meta: publicMeta } };
  return { status: 200, body };
}

// The stored year BEFORE the one getPayload serves: units for storedStart <= day < coverageStart, same compact
// format. Together the two cover every stored day exactly once. Own request so ordinary app loads never
// download it — only a last-year / previous-period comparison (Sales Cadence) asks for it.
async function getOlderPayload({ store, now = Date.now() }) {
  const meta = (await store.get('meta', { type: 'json' })) || {};
  const publicMeta = {
    tz: meta.tz, from: meta.storedStart || null, to: meta.coverageStart ? S.addDays(meta.coverageStart, -1) : null,
    lastSuccessTs: meta.lastSuccessTs, ageSec: meta.lastSuccessTs ? Math.round((now - meta.lastSuccessTs) / 1000) : null,
  };
  const daily = await store.get('daily', { type: 'json' });
  const ready = !!daily && !!meta.lastFullTs && meta.feedVersion === FEED_VERSION && !!meta.storedStart && !!meta.coverageStart && meta.storedStart < meta.coverageStart;
  if (!ready) return { status: 200, body: { ready: false, meta: publicMeta } };
  const body = { ready: true, meta: publicMeta, data: S.encodeCompact(daily, meta.tz, meta.storedStart, 1, meta.coverageStart) };
  const size = Buffer.byteLength(JSON.stringify(body));
  if (size > MAX_RESPONSE_BYTES) return { status: 500, body: { error: `older sales payload is ${size} bytes — over the response limit, needs splitting`, meta: publicMeta } };
  return { status: 200, body };
}

// The last few days' units and takings (see buildRecent). ready:false until the first sync after this shipped.
async function getRecentPayload({ store, now = Date.now() }) {
  const recent = await store.get('recent', { type: 'json' });
  const ok = !!recent && Array.isArray(recent.days) && !!recent.skus && !!recent.syncTs;
  const meta = { tz: ok ? recent.tz : null, lastDay: ok ? recent.lastDay : null, syncTs: ok ? recent.syncTs : null, ageSec: ok ? Math.round((now - recent.syncTs) / 1000) : null };
  if (!ok) return { status: 200, body: { ready: false, meta } };
  return { status: 200, body: { ready: true, meta, data: { v: recent.v, tz: recent.tz, days: recent.days, skus: recent.skus } } };
}

// Selling-price history ({SKU:[dayIdx,grossCents,netCents,...]}), all stored days. Own
// endpoint so ordinary app loads never download it — only the markdown planner does.
async function getPricePayload({ store, now = Date.now() }) {
  const meta = (await store.get('meta', { type: 'json' })) || {};
  const publicMeta = { tz: meta.tz, storedStart: meta.storedStart, lastDay: meta.lastDay, lastSuccessTs: meta.lastSuccessTs, ageSec: meta.lastSuccessTs ? Math.round((now - meta.lastSuccessTs) / 1000) : null };
  const price = await store.get('price', { type: 'json' });
  if (!price || !meta.lastFullTs || meta.feedVersion !== FEED_VERSION) return { status: 200, body: { ready: false, meta: publicMeta } };
  const body = { ready: true, meta: publicMeta, data: S.encodeCompact(price, meta.tz, null, 2) };
  const size = Buffer.byteLength(JSON.stringify(body));
  if (size > MAX_RESPONSE_BYTES) return { status: 500, body: { error: `price payload is ${size} bytes — over the response limit, needs splitting`, meta: publicMeta } };
  return { status: 200, body };
}

module.exports = { makeClient, runSync, getPayload, getOlderPayload, getPricePayload, getRecentPayload, buildRecent, totalUnits, syncWithPokes, WEBHOOK_MIN_GAP_MS, QUICK_INTERVAL_MS, TRAILING_EVERY_MS, FULL_MAX_AGE_MS, FULL_FORCE_MIN_AGE_MS };
