const { connectLambda, getStore } = require('@netlify/blobs');
const { handle } = require('../lib/plans-store');
const { guard } = require('../lib/app-auth');

// GET -> { rev, state } · PUT { state, ifRev, device } -> { rev } | 409 { conflict, rev, state }. See netlify/lib/plans-store.js.
// Signed-in app sessions only (netlify/lib/app-auth.js): until v3.7.5 anyone with the URL could read or overwrite the plans.
exports.handler = async (event) => {
  const denied = guard(event, process.env);
  if (denied) return denied;
  let store;
  try { connectLambda(event); store = getStore('markdown-planner'); }
  catch (err) { return { statusCode: 500, body: JSON.stringify({ error: 'Netlify Blobs unavailable: ' + err.message }) }; }
  try { return await handle(event.httpMethod || 'GET', event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body, store); }
  catch (err) { return { statusCode: 500, body: JSON.stringify({ error: err.message }) }; }
};
