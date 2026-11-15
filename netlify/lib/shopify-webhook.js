// Receives Shopify "an order was placed / changed" notifications and turns them into an immediate sales refresh.
//
// The notification body is never used for data. It only proves "something changed", and the sync then reads the orders
// itself with its own token — so a forged or replayed notification can do no more than request a refresh (and the sync
// throttles those). It is still signature-checked (HMAC-SHA256 of the raw body, base64, in X-Shopify-Hmac-Sha256),
// because there is no reason to accept calls from anyone but Shopify.
//
// Shopify gives up on a delivery that takes over 5 seconds and retries (and removes the subscription after repeated
// failures), so this does the minimum — verify, record, nudge the worker — and answers.
const crypto = require('crypto');

const SHOP_DOMAIN = 'thewndrr.myshopify.com';

function validSignature(rawBody, headerValue, secret) {
  if (!secret || !headerValue) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let given;
  try { given = Buffer.from(String(headerValue).trim(), 'base64'); } catch (e) { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// headers: lower-cased names. trigger(): starts the background sync (resolves quickly). Returns { status, body }.
async function handleWebhook({ method, rawBody, headers, secret, store, trigger, now = Date.now(), log = () => {} }) {
  if ((method || 'POST') !== 'POST') return { status: 405, body: 'method not allowed' };
  if (!secret) { log('SHOPIFY_WEBHOOK_SECRET is not set — refusing notifications'); return { status: 503, body: 'webhook not configured' }; }
  if (!validSignature(rawBody, headers['x-shopify-hmac-sha256'], secret)) { log('bad or missing signature'); return { status: 401, body: 'bad signature' }; }
  const topic = String(headers['x-shopify-topic'] || '');
  const shop = String(headers['x-shopify-shop-domain'] || '');
  if (shop && shop !== SHOP_DOMAIN) { log('notification for another shop: ' + shop); return { status: 200, body: 'ignored' }; }
  if (!/^orders\//.test(topic)) return { status: 200, body: 'ignored' };           // a store-level subscription could carry anything; only order changes matter
  // Recorded first, so a run already in progress (which checks this when it finishes) will go round again.
  try { await store.setJSON('poke', { ts: now, topic }); } catch (e) { log('could not record the notification: ' + (e && e.message || e)); }
  try { await trigger(); } catch (e) { log('could not start the sync: ' + (e && e.message || e)); }   // the 2-minute timer still catches it
  return { status: 200, body: 'ok' };
}

module.exports = { handleWebhook, validSignature, SHOP_DOMAIN };
