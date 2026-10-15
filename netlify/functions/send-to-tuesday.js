const { handle } = require('../lib/send-to-tuesday');

// See netlify/lib/send-to-tuesday.js. Needs the Netlify environment variable MARKDOWNS_API_KEY (Tuesday's key); TUESDAY_URL and SEND_ALLOWED_ORIGINS are optional.
exports.handler = async (event) => handle({
  method: event.httpMethod,
  query: event.queryStringParameters,
  body: event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body,
  headers: event.headers,
  env: process.env,
});
