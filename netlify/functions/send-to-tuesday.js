const { handle } = require('../lib/send-to-tuesday');
const { guard } = require('../lib/app-auth');

// See netlify/lib/send-to-tuesday.js. Needs the Netlify environment variable MARKDOWNS_API_KEY (Tuesday's key); TUESDAY_URL and SEND_ALLOWED_ORIGINS are optional.
// Signed-in app sessions only (netlify/lib/app-auth.js): the origin check inside handle() only stops other websites, since a
// caller that isn't a browser simply doesn't name an origin.
exports.handler = async (event) => guard(event, process.env) || handle({
  method: event.httpMethod,
  query: event.queryStringParameters,
  body: event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body,
  headers: event.headers,
  env: process.env,
});
