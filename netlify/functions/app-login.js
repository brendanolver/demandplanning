const { login } = require('../lib/app-auth');

// The sign-in screen posts the password here; see netlify/lib/app-auth.js. This is the only function that answers
// without a session token. Needs the Netlify environment variables APP_PASSWORD and APP_SESSION_SECRET.
exports.handler = async (event) => login({
  method: event.httpMethod || 'GET',
  headers: event.headers,
  body: event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body,
  env: process.env,
});
