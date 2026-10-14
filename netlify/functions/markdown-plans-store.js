const { connectLambda, getStore } = require('@netlify/blobs');
const { handle } = require('../lib/plans-store');

// GET -> { rev, state } · PUT { state, ifRev, device } -> { rev } | 409 { conflict, rev, state }. See netlify/lib/plans-store.js.
// Same trust model as planning-globals: no secrets are stored here (sale plans only).
exports.handler = async (event) => {
  let store;
  try { connectLambda(event); store = getStore('markdown-planner'); }
  catch (err) { return { statusCode: 500, body: JSON.stringify({ error: 'Netlify Blobs unavailable: ' + err.message }) }; }
  try { return await handle(event.httpMethod || 'GET', event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body, store); }
  catch (err) { return { statusCode: 500, body: JSON.stringify({ error: err.message }) }; }
};
