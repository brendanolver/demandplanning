// 1. Every place the app's version is written must agree — a missed one is invisible until it bites: a stale
//    cache-buster leaves browsers on an old module, and a stale version.json makes the "new version" banner lie.
// 2. Tests for the banner's rules (version-check.js).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const V = require('../version-check.js');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// ── 1. one version, everywhere ────────────────────────────────────────────────
const m = /^const APP_VERSION='(v\d+\.\d+\.\d+)';$/m.exec(html);
assert.ok(m, "index.html: const APP_VERSION='vX.Y.Z'; not found");
const version = m[1], bare = version.slice(1);
assert.equal(html.split("const APP_VERSION='").length, 2, 'APP_VERSION is defined more than once');

// every local module is loaded with a ?v= cache-buster at the current version, and the file exists
const localScripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(x => x[1]).filter(src => !/^https?:\/\//.test(src));
assert.ok(localScripts.length >= 5, 'expected the app\'s own modules to be loaded with <script src>, found ' + localScripts.length);
for (const src of localScripts) {
  const s = /^([\w.-]+\.js)\?v=(\d+\.\d+\.\d+)$/.exec(src);
  assert.ok(s, '<script src="' + src + '"> needs a ?v=' + bare + ' cache-buster');
  assert.equal(s[2], bare, src + ' is cache-busted at ' + s[2] + ' but the app is ' + version + ' — browsers would keep the old ' + s[1]);
  assert.ok(fs.existsSync(path.join(root, s[1])), s[1] + ' is loaded by index.html but does not exist');
}
for (const mod of ['markdown-engine.js', 'markdown-plans.js', 'sales-cadence-pdf.js', 'date-range.js', 'version-check.js']) assert.ok(localScripts.some(s => s.startsWith(mod + '?')), mod + ' is not loaded by index.html');

// version.json is what an open tab compares itself against
const vj = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'));
assert.equal(vj.version, version, 'version.json says ' + vj.version + ' but the app is ' + version + ' — bump them together');
assert.deepEqual(Object.keys(vj), ['version']);

// the changelog has an entry for this version, and none for a later one
const logged = [...html.matchAll(/^\/\/ (v\d+\.\d+\.\d+) — /gm)].map(x => x[1]);
assert.ok(logged.includes(version), 'no "// ' + version + ' — …" changelog entry in index.html');
assert.equal(logged.filter(v => v === version).length, 1, 'more than one changelog entry for ' + version);
const later = logged.filter(v => V.isNewer(v, version));
assert.deepEqual(later, [], 'changelog has entries newer than APP_VERSION: ' + later.join(', '));

// odometer numbering: each of the last two places runs 0–9, then rolls the one to its left (3.7.9 → 3.8.0)
const [, minor, patch] = bare.split('.').map(Number);
assert.ok(minor <= 9 && patch <= 9, version + ' breaks the odometer rule (after x.y.9 comes x.(y+1).0; after x.9.9 comes (x+1).0.0)');

// ── 2. the banner's rules ─────────────────────────────────────────────────────
assert.deepEqual(V.parse('v3.7.5'), [3, 7, 5]); assert.deepEqual(V.parse('3.7.5'), [3, 7, 5]); assert.deepEqual(V.parse(' v10.0.12 '), [10, 0, 12]);
for (const bad of ['', 'v3.7', '3.7.5.1', 'v3.7.x', 'latest', '<b>v3.7.5</b>', 'v3.7.5-beta', null, undefined, 375, {}, ['v3.7.5']]) assert.equal(V.parse(bad), null, String(bad));

const newer = [['v3.7.6', 'v3.7.5'], ['v3.8.0', 'v3.7.9'], ['v4.0.0', 'v3.9.9'], ['v3.10.0', 'v3.9.9'], ['v3.7.10', 'v3.7.9'], ['3.7.6', 'v3.7.5'], ['v10.0.0', 'v9.9.9']];
for (const [live, mine] of newer) { assert.equal(V.isNewer(live, mine), true, live + ' > ' + mine); assert.equal(V.isNewer(mine, live), false, mine + ' is not > ' + live); }
assert.equal(V.isNewer('v3.7.5', 'v3.7.5'), false);                       // same version
for (const [live, mine] of [['', 'v3.7.5'], ['v3.7.6', ''], [null, 'v3.7.5'], ['nonsense', 'v3.7.5'], ['v3.7.6', undefined], ['v9', 'v3.7.5']]) assert.equal(V.isNewer(live, mine), false);   // unknown = no

const NOW = 1800000000000, base = { mine: 'v3.7.5', live: 'v3.7.6', now: NOW, snoozedUntil: 0 };
const ask = extra => V.shouldPrompt(Object.assign({}, base, extra));
assert.equal(ask(), true);                                                 // the site is ahead of this tab
assert.equal(ask({ live: 'v3.7.5' }), false);                              // up to date
assert.equal(ask({ live: 'v3.7.4' }), false);                              // site behind the tab (a rollback, or version.json not bumped): never prompt
assert.equal(ask({ live: '' }), false); assert.equal(ask({ live: 'oops' }), false); assert.equal(V.shouldPrompt(null), false); assert.equal(V.shouldPrompt({}), false);
// "Later" hides it for 30 minutes, then it comes back
assert.equal(ask({ snoozedUntil: NOW + V.SNOOZE_MS }), false); assert.equal(ask({ snoozedUntil: NOW + 1 }), false);
assert.equal(ask({ snoozedUntil: NOW }), true); assert.equal(ask({ snoozedUntil: NOW - 1 }), true);
assert.equal(ask({ now: NOW + V.SNOOZE_MS, snoozedUntil: NOW + V.SNOOZE_MS }), true);
// just refreshed for this very version and still behind: wait rather than loop
assert.equal(ask({ reloadedFor: 'v3.7.6', reloadedAt: NOW - 1000 }), false);
assert.equal(ask({ reloadedFor: 'v3.7.6', reloadedAt: NOW - V.RELOAD_GRACE_MS + 1 }), false);
assert.equal(ask({ reloadedFor: 'v3.7.6', reloadedAt: NOW - V.RELOAD_GRACE_MS }), true);     // …but not forever
assert.equal(ask({ reloadedFor: 'v3.7.5', reloadedAt: NOW - 1000 }), true);                  // refreshed for an older version; a newer one has shipped since
assert.equal(ask({ reloadedFor: 'v3.7.6' }), true);                                          // no time recorded: don't suppress
assert.equal(ask({ live: 'v3.7.7', reloadedFor: 'v3.7.6', reloadedAt: NOW - 1000 }), true);
assert.ok(V.FIRST_CHECK_MS < V.CHECK_EVERY_MS && V.RELOAD_GRACE_MS <= V.SNOOZE_MS);

console.log('version tests: all passed (' + version + ', ' + localScripts.length + ' modules)');
