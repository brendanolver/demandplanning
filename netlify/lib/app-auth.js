// Sign-in for this site's own functions. Until v3.7.5 the password was compared in the browser and every function
// answered anyone who knew its URL — including the Apparel Magic order push and the Shopify proxy. Now the server
// checks the password (app-login.js) and hands back a signed session token; every other function calls guard()
// first and refuses a request that doesn't carry a valid one in the X-App-Token header.
//
// Two Netlify environment variables, never in source:
//   APP_PASSWORD        what you type on the sign-in screen
//   APP_SESSION_SECRET  random signing key (32+ characters). Changing it signs every device out.
// Missing either one fails CLOSED (503), never open.
//
// Token = "v1.<expiry ms>.<HMAC-SHA256 of 'v1.<expiry ms>'>". netlify/lib/edge-token.mjs checks the same format for
// the edge function; tests/app-auth.test.js proves the two agree. Pure (env and the clock are passed in).
const crypto = require('crypto');

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // how long a sign-in lasts
const FAIL_DELAY_MS = 600;                        // a wrong password answers slowly, to blunt guessing
const TOKEN_RE = /^v1\.(\d{13})\.([A-Za-z0-9_-]{43})$/;

const reply = (statusCode, obj, extra) => ({ statusCode, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extra), body: JSON.stringify(obj) });
// The header is how the page tells "you need to sign in" apart from an upstream 401 passed through by a proxy.
const signInRequired = () => reply(401, { error: 'Sign in required.', auth: 'required' }, { 'X-App-Auth': 'required' });
const notSetUp = () => reply(503, { error: 'Sign-in isn\'t set up on the server: add APP_PASSWORD and APP_SESSION_SECRET to this site\'s Netlify environment variables, then redeploy.' });

function configured(env) {
  return !!env && typeof env.APP_PASSWORD === 'string' && env.APP_PASSWORD.trim().length >= 8
    && typeof env.APP_SESSION_SECRET === 'string' && env.APP_SESSION_SECRET.length >= 32;
}
const sign = (secret, exp) => crypto.createHmac('sha256', secret).update('v1.' + exp).digest('base64url');

function mint(secret, now, ttlMs) {
  const exp = (now == null ? Date.now() : now) + (ttlMs == null ? TOKEN_TTL_MS : ttlMs);
  return { token: 'v1.' + exp + '.' + sign(secret, exp), exp };
}
function verify(token, secret, now) {
  const m = typeof token === 'string' ? TOKEN_RE.exec(token) : null;
  if (!m || !(Number(m[1]) > (now == null ? Date.now() : now))) return false;
  const given = Buffer.from(m[2]), want = Buffer.from(sign(secret, m[1]));
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
// Compared as fixed-length digests so neither the length nor the position of a wrong character leaks through timing.
function samePassword(input, expected) {
  const h = s => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(input), h(expected));
}
function headerOf(headers, name) {
  if (!headers) return undefined;
  if (headers[name] != null) return headers[name];
  const k = Object.keys(headers).find(x => x.toLowerCase() === name);
  return k ? headers[k] : undefined;
}

// Call first in every function: returns null when the request is signed in, otherwise the response to send back.
function guard(event, env, now) {
  if (!configured(env)) return notSetUp();
  return verify(headerOf(event && event.headers, 'x-app-token'), env.APP_SESSION_SECRET, now) ? null : signInRequired();
}

// POST {password} -> {ok, token, exp} | 401.   GET (with a token) -> {ok} | 401, so a remembered device can check its session before loading.
async function login({ method, headers, body, env, now, sleep }) {
  if (!configured(env)) return notSetUp();
  if (method === 'GET') return verify(headerOf(headers, 'x-app-token'), env.APP_SESSION_SECRET, now) ? reply(200, { ok: true }) : signInRequired();
  if (method !== 'POST') return reply(405, { ok: false, error: 'Method not allowed.' });
  let b = null;
  if (String(body || '').length <= 2000) { try { b = JSON.parse(body || ''); } catch (e) { /* treated as a wrong password below */ } }
  const given = b && typeof b.password === 'string' ? b.password.trim() : '';
  if (!samePassword(given, env.APP_PASSWORD.trim())) {
    await (sleep || (ms => new Promise(r => setTimeout(r, ms))))(FAIL_DELAY_MS);
    return reply(401, { ok: false, error: 'Incorrect password.' });
  }
  const t = mint(env.APP_SESSION_SECRET, now);
  return reply(200, { ok: true, token: t.token, exp: t.exp });
}

module.exports = { guard, login, mint, verify, configured, samePassword, TOKEN_TTL_MS, FAIL_DELAY_MS };
