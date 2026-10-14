// Cloud copy of the Markdown Planner's sale plans, so a sale can be opened and worked on from any device.
// One blob holds the whole planner state ({v, activeId, order, plans}) plus a revision number; writes are optimistic
// ("ifRev"): a device that wrote against an out-of-date revision is told so (409) and must merge, never silently overwrite.
// The previous version is kept as a one-step backup. Pure module (the store is injected) so it can be tested without Netlify.
const KEY = 'plans', PREV_KEY = 'plans-prev', MAX_BYTES = 4 * 1024 * 1024;

function shapeOk(state) {
  return !!state && typeof state === 'object' && state.plans && typeof state.plans === 'object' && !Array.isArray(state.plans)
    && Array.isArray(state.order) && Object.keys(state.plans).length <= 200
    && Object.values(state.plans).every(p => p && typeof p === 'object' && typeof p.id === 'string' && p.setup && p.settings);
}
const json = (status, body) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

async function handle(method, rawBody, store) {
  if (method === 'GET') {
    const cur = await store.get(KEY, { type: 'json' });
    return json(200, cur ? { ok: true, rev: cur.rev, updatedAt: cur.updatedAt, device: cur.device || null, state: cur.state } : { ok: true, rev: 0, updatedAt: null, state: null });
  }
  if (method === 'PUT' || method === 'POST') {
    if (Buffer.byteLength(rawBody || '', 'utf8') > MAX_BYTES) return json(413, { error: 'state is too large to save' });
    let body; try { body = JSON.parse(rawBody || '{}'); } catch (e) { return json(400, { error: 'invalid JSON' }); }
    if (!shapeOk(body.state)) return json(400, { error: 'not a planner state' });
    const cur = await store.get(KEY, { type: 'json' }), curRev = cur ? cur.rev : 0;
    if (body.ifRev != null && Number(body.ifRev) !== curRev) return json(409, { conflict: true, rev: curRev, updatedAt: cur ? cur.updatedAt : null, state: cur ? cur.state : null });
    if (cur) await store.setJSON(PREV_KEY, cur);                          // one-step backup of what we're about to replace
    const next = { rev: curRev + 1, updatedAt: Date.now(), device: String(body.device || '').slice(0, 40), state: body.state };
    await store.setJSON(KEY, next);
    return json(200, { ok: true, rev: next.rev, updatedAt: next.updatedAt });
  }
  return json(405, { error: 'method not allowed' });
}
module.exports = { handle, shapeOk, KEY, PREV_KEY, MAX_BYTES };
