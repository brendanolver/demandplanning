// Cloud copy of the Markdown Planner's sale plans, so a sale can be opened and worked on from any device.
// One blob holds the whole planner state ({v, activeId, order, plans}) plus a revision number. Saves are optimistic AND atomic:
//   - "ifRev": a device that saved against an out-of-date revision is told so (409) and must merge, never silently overwrite;
//   - the write itself is conditional on the blob's ETag (Netlify Blobs onlyIfMatch), so two saves landing in the same instant can't both pass
//     the revision check — the loser gets a 409 as well.
// Safety nets: a save that would drop a plan the cloud already has is refused (plans are archived, never deleted); the previous version is kept
// (plans-prev); and a rolling VERSION HISTORY keeps a snapshot of the state before a burst of edits (at most one every 5 minutes), all of the last
// 48 hours, then one per day for 30 days, so any mistake can be undone from the History screen.
// Pure module (the store is injected) so it can be tested without Netlify.
const KEY = 'plans', PREV_KEY = 'plans-prev', HIST_INDEX = 'hist-index', HIST_PREFIX = 'hist/', MAX_BYTES = 4 * 1024 * 1024;
const SNAP_EVERY_MS = 5 * 60 * 1000, KEEP_ALL_MS = 48 * 3600 * 1000, KEEP_DAYS = 30, MAX_SNAPS = 400, DAY = 86400000;

function shapeOk(state) {
  return !!state && typeof state === 'object' && state.plans && typeof state.plans === 'object' && !Array.isArray(state.plans)
    && Array.isArray(state.order) && Object.keys(state.plans).length <= 200
    && Object.values(state.plans).every(p => p && typeof p === 'object' && typeof p.id === 'string' && p.setup && p.settings);
}
const json = (status, body) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

// What a History row says about each plan, so you can tell versions apart without opening them.
function summarise(state) {
  return Object.values((state && state.plans) || {}).slice(0, 12).map(p => ({
    id: p.id, name: String(p.name || '').slice(0, 60), archived: !!p.archived, rev: p.rev || 0,
    decisions: Object.keys(p.overrides || {}).length, approved: Object.values(p.catApprovals || {}).filter(a => a && a.approved).length, offers: (p.offers || []).length,
  }));
}

async function readCur(store) {
  const r = await store.getWithMetadata(KEY, { type: 'json' });
  return r ? { cur: r.data, etag: r.etag } : { cur: null, etag: null };
}

// Snapshot the state that is about to be replaced, unless one was taken in the last 5 minutes. Best effort: history must never stop a save.
async function maybeSnapshot(store, cur, now) {
  try {
    let index = (await store.get(HIST_INDEX, { type: 'json' })) || [];
    if (index[0] && now - index[0].savedAt < SNAP_EVERY_MS) return;
    const id = HIST_PREFIX + String(cur.updatedAt || now).padStart(14, '0') + '-' + cur.rev;
    await store.setJSON(id, cur);
    index = [{ id, ts: cur.updatedAt || now, savedAt: now, rev: cur.rev, device: cur.device || null, plans: summarise(cur.state) }].concat(index.filter(e => e.id !== id));
    // retention: everything from the last 48h, then the newest per day for 30 days, capped overall
    const keep = [], seenDay = new Set();
    for (const e of index) {
      const age = now - e.savedAt, day = Math.floor(e.savedAt / DAY);
      if (age <= KEEP_ALL_MS) keep.push(e);
      else if (age <= KEEP_DAYS * DAY && !seenDay.has(day)) { seenDay.add(day); keep.push(e); }
    }
    const kept = keep.slice(0, MAX_SNAPS), keptIds = new Set(kept.map(e => e.id));
    for (const e of index) if (!keptIds.has(e.id)) { try { await store.delete(e.id); } catch (err) { /* already gone */ } }
    await store.setJSON(HIST_INDEX, kept);
  } catch (err) { console.error('[plans-store] history snapshot failed', err && err.message); }
}

async function handle(method, rawBody, store, query) {
  query = query || {};
  if (method === 'GET') {
    if (query.history) return json(200, { ok: true, history: (await store.get(HIST_INDEX, { type: 'json' })) || [] });
    if (query.version) {
      const id = String(query.version);
      if (!id.startsWith(HIST_PREFIX)) return json(400, { error: 'not a version id' });
      const v = await store.get(id, { type: 'json' });
      return v ? json(200, { ok: true, id, rev: v.rev, ts: v.updatedAt, device: v.device || null, state: v.state }) : json(404, { error: 'that version is no longer kept' });
    }
    const { cur } = await readCur(store);
    return json(200, cur ? { ok: true, rev: cur.rev, updatedAt: cur.updatedAt, device: cur.device || null, state: cur.state } : { ok: true, rev: 0, updatedAt: null, device: null, state: null });
  }
  if (method === 'PUT' || method === 'POST') {
    if (Buffer.byteLength(rawBody || '', 'utf8') > MAX_BYTES) return json(413, { error: 'state is too large to save' });
    let body; try { body = JSON.parse(rawBody || '{}'); } catch (e) { return json(400, { error: 'invalid JSON' }); }
    if (!shapeOk(body.state)) return json(400, { error: 'not a planner state' });
    const { cur, etag } = await readCur(store), curRev = cur ? cur.rev : 0;
    const conflict = (c) => json(409, { conflict: true, rev: c ? c.rev : 0, updatedAt: c ? c.updatedAt : null, state: c ? c.state : null });
    if (body.ifRev != null && Number(body.ifRev) !== curRev) return conflict(cur);
    if (cur && body.allowRemove !== true) {
      const missing = Object.values(cur.state.plans).filter(p => !body.state.plans[p.id]);
      if (missing.length) return json(422, { error: 'that save would delete ' + missing.length + ' plan' + (missing.length === 1 ? '' : 's') + ' (' + missing.map(p => p.name).slice(0, 3).join(', ') + '). Plans are archived, never deleted, so it was refused.', missing: missing.map(p => p.id) });
    }
    const now = Date.now();
    if (cur) { await maybeSnapshot(store, cur, now); await store.setJSON(PREV_KEY, cur); }    // history + one-step backup of what we're about to replace
    const next = { rev: curRev + 1, updatedAt: now, device: String(body.device || '').slice(0, 40), state: body.state };
    const res = await store.setJSON(KEY, next, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (res && res.modified === false) { const fresh = (await readCur(store)).cur; return conflict(fresh); }   // someone else saved in the same instant: merge again
    return json(200, { ok: true, rev: next.rev, updatedAt: next.updatedAt });
  }
  return json(405, { error: 'method not allowed' });
}
module.exports = { handle, shapeOk, summarise, KEY, PREV_KEY, HIST_INDEX, HIST_PREFIX, MAX_BYTES, SNAP_EVERY_MS };
