// WNDRR Demand Planning — "a new version is ready" check.
// A tab keeps running the version it loaded; pushing to V2 now deploys by itself, so an open tab can quietly fall
// behind the live site. The page asks the site for version.json every so often and uses this to decide whether to
// show the refresh banner. Pure functions only (no DOM, no network, no clock): the page loads it with a <script>
// tag (window.VersionCheck) and tests/version.test.js runs the same file under Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VersionCheck = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FIRST_CHECK_MS = 15 * 1000;        // shortly after load: catches a tab the browser restored from memory
  const CHECK_EVERY_MS = 10 * 60 * 1000;   // while the tab is visible
  const SNOOZE_MS = 30 * 60 * 1000;        // "Later" hides the banner for this long
  const RELOAD_GRACE_MS = 10 * 60 * 1000;  // after refreshing for a version, don't ask again for it this soon

  // 'v3.7.5' (or '3.7.5') → [3, 7, 5]; anything else → null.
  function parse(v) {
    const m = typeof v === 'string' ? /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim()) : null;
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }
  // Is `live` a later version than `mine`? Compared as numbers part by part (so 3.10.0 is after 3.9.9).
  // If either can't be read the answer is no — never prompt on a guess.
  function isNewer(live, mine) {
    const a = parse(live), b = parse(mine);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  }
  // Should the banner be showing? s = { mine, live, now, snoozedUntil, reloadedFor, reloadedAt }.
  //   - only when the site really is ahead of this tab (never when it is the same, behind, or unknown)
  //   - not while "Later" is in force
  //   - not straight after this tab already refreshed for that same version and still came back behind: that
  //     means refreshing didn't help, and asking again at once would trap the user in a refresh loop
  function shouldPrompt(s) {
    if (!s || !isNewer(s.live, s.mine)) return false;
    if (s.snoozedUntil && s.now < s.snoozedUntil) return false;
    if (s.reloadedFor === s.live && typeof s.reloadedAt === 'number' && s.now - s.reloadedAt < RELOAD_GRACE_MS) return false;
    return true;
  }

  return { parse, isNewer, shouldPrompt, FIRST_CHECK_MS, CHECK_EVERY_MS, SNOOZE_MS, RELOAD_GRACE_MS };
});
