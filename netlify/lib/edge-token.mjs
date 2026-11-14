// The same session-token check as netlify/lib/app-auth.js, for the edge runtime (Web Crypto only, no Node APIs).
// Used by netlify/edge-functions/pipeline-proxy.js. tests/app-auth.test.js runs both against the same tokens.
const TOKEN_RE = /^v1\.(\d{13})\.([A-Za-z0-9_-]{43})$/;

export async function verifyToken(token, secret, now = Date.now()) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const m = typeof token === 'string' ? TOKEN_RE.exec(token) : null;
  if (!m || !(Number(m[1]) > now)) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sig = Uint8Array.from(atob(m[2].replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0));
  return crypto.subtle.verify('HMAC', key, sig, enc.encode('v1.' + m[1]));   // constant-time by definition
}
