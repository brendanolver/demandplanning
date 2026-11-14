// Tests for the server-side sign-in (netlify/lib/app-auth.js) and its edge twin (netlify/lib/edge-token.mjs).
const assert = require('assert');
const A = require('../netlify/lib/app-auth.js');
(async () => {
  const { verifyToken } = await import('../netlify/lib/edge-token.mjs');
  const SECRET = 'test-secret-'.repeat(4), OTHER = 'other-secret-'.repeat(4), PW = 'fixture-password-1';
  const env = { APP_PASSWORD: PW, APP_SESSION_SECRET: SECRET };
  const NOW = 1800000000000, DAY = 86400000;
  const parse = r => ({ s: r.statusCode, b: JSON.parse(r.body), h: r.headers });
  const waits = []; const sleep = async ms => { waits.push(ms); };
  const post = (password, e, extra) => A.login(Object.assign({ method: 'POST', body: JSON.stringify({ password }), env: e || env, now: NOW, sleep }, extra)).then(parse);

  // ── set-up check: anything missing or too short counts as not set up
  assert.equal(A.configured(env), true);
  for (const bad of [null, {}, { APP_PASSWORD: PW }, { APP_SESSION_SECRET: SECRET }, { APP_PASSWORD: 'short', APP_SESSION_SECRET: SECRET }, { APP_PASSWORD: PW, APP_SESSION_SECRET: 'tooshort' }, { APP_PASSWORD: '         ', APP_SESSION_SECRET: SECRET }]) assert.equal(A.configured(bad), false);

  // ── tokens
  const t = A.mint(SECRET, NOW);
  assert.equal(t.exp, NOW + A.TOKEN_TTL_MS); assert.match(t.token, /^v1\.\d{13}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(A.verify(t.token, SECRET, NOW), true);
  assert.equal(A.verify(t.token, SECRET, t.exp - 1), true);
  assert.equal(A.verify(t.token, SECRET, t.exp), false);                                    // expired exactly at exp
  assert.equal(A.verify(t.token, OTHER, NOW), false);                                       // signed with a different key
  const [v, exp, sig] = t.token.split('.');
  assert.equal(A.verify([v, Number(exp) + DAY, sig].join('.'), SECRET, NOW), false);        // expiry pushed out: signature no longer matches
  assert.equal(A.verify([v, exp, sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A')].join('.'), SECRET, NOW), false);
  for (const junk of [undefined, null, '', 'v1', 'v1..', 'v2.' + exp + '.' + sig, t.token + 'x', 12345, {}, 'v1.' + exp + '.' + 'A'.repeat(43)]) assert.equal(A.verify(junk, SECRET, NOW), false);

  // ── the edge function's check agrees with the Node one on every case
  const cases = [[t.token, SECRET, NOW], [t.token, SECRET, t.exp], [t.token, OTHER, NOW], [[v, Number(exp) + DAY, sig].join('.'), SECRET, NOW], ['', SECRET, NOW], [undefined, SECRET, NOW], ['v1.' + exp + '.' + 'A'.repeat(43), SECRET, NOW], [A.mint(OTHER, NOW).token, OTHER, NOW]];
  for (const [tok, sec, now] of cases) assert.equal(await verifyToken(tok, sec, now), A.verify(tok, sec, now), 'edge and node disagree on ' + tok);
  assert.equal(await verifyToken(t.token, SECRET, NOW), true);
  assert.equal(await verifyToken(t.token, 'tooshort', NOW), false);

  // ── guard: what every function calls first
  const ev = headers => ({ headers });
  assert.equal(A.guard(ev({ 'x-app-token': t.token }), env, NOW), null);
  assert.equal(A.guard(ev({ 'X-App-Token': t.token }), env, NOW), null);                    // header name in any case
  let r = parse(A.guard(ev({}), env, NOW)); assert.equal(r.s, 401); assert.equal(r.h['X-App-Auth'], 'required'); assert.equal(r.b.auth, 'required');
  assert.equal(parse(A.guard(undefined, env, NOW)).s, 401);
  assert.equal(parse(A.guard(ev({ 'x-app-token': t.token }), env, t.exp + 1)).s, 401);      // expired
  assert.equal(parse(A.guard(ev({ 'x-app-token': A.mint(OTHER, NOW).token }), env, NOW)).s, 401);
  r = parse(A.guard(ev({ 'x-app-token': t.token }), {}, NOW)); assert.equal(r.s, 503);      // not set up fails closed, even with a token
  assert.equal(parse(A.guard(ev({ 'x-app-token': t.token }), { APP_PASSWORD: PW }, NOW)).s, 503);

  // ── signing in
  r = await post(PW); assert.equal(r.s, 200); assert.equal(r.b.ok, true); assert.equal(r.b.exp, NOW + A.TOKEN_TTL_MS);
  assert.equal(A.guard(ev({ 'x-app-token': r.b.token }), env, NOW), null);                  // the token it hands out opens the functions
  assert.equal(waits.length, 0);                                                            // a correct password isn't slowed down
  assert.equal((await post('  ' + PW + ' \n')).s, 200);                                     // stray whitespace around what was typed
  r = await post('wrong-password'); assert.equal(r.s, 401); assert.equal(r.b.ok, false); assert.equal(r.b.token, undefined); assert.deepEqual(waits, [A.FAIL_DELAY_MS]);
  assert.equal(r.h['X-App-Auth'], undefined);                                               // a wrong password is not a "session ended" signal
  for (const bad of ['', '   ', PW + 'x', PW.slice(0, -1), PW.toUpperCase(), null, 12345, { $ne: '' }, [PW]]) assert.equal((await post(bad)).s, 401);
  assert.equal(parse(await A.login({ method: 'POST', body: '{not json', env, now: NOW, sleep })).s, 401);
  assert.equal(parse(await A.login({ method: 'POST', body: null, env, now: NOW, sleep })).s, 401);
  assert.equal(parse(await A.login({ method: 'POST', body: JSON.stringify({ password: PW, pad: 'x'.repeat(3000) }), env, now: NOW, sleep })).s, 401);   // oversized body is never parsed
  assert.equal(parse(await A.login({ method: 'PUT', body: JSON.stringify({ password: PW }), env, now: NOW, sleep })).s, 405);
  assert.equal((await post(PW, {})).s, 503); assert.equal((await post(PW, { APP_PASSWORD: PW })).s, 503);
  assert.ok(!JSON.stringify(await post('wrong-password')).includes(PW) && !JSON.stringify(await post(PW, {})).includes(SECRET));   // nothing secret echoed back

  // ── session check (GET): how a remembered device confirms it is still signed in
  assert.equal(parse(await A.login({ method: 'GET', headers: { 'x-app-token': t.token }, env, now: NOW })).s, 200);
  r = parse(await A.login({ method: 'GET', headers: {}, env, now: NOW })); assert.equal(r.s, 401); assert.equal(r.h['X-App-Auth'], 'required');
  assert.equal(parse(await A.login({ method: 'GET', headers: { 'x-app-token': t.token }, env, now: t.exp + 1 })).s, 401);
  assert.equal(parse(await A.login({ method: 'GET', headers: { 'x-app-token': t.token }, env: {}, now: NOW })).s, 503);

  console.log('app auth tests: all passed');
})().catch(e => { console.error(e); process.exit(1); });
