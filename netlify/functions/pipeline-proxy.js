const PIPELINE_BASE = 'http://170.64.229.248:3000';
const PIPELINE_TOKEN = 'RsCdZC3-bkfKvEf2TKXI2bMRHDlECre3aWM9VuNDt60';

exports.handler = async (event) => {
  const params = { ...(event.queryStringParameters || {}) };
  const path = params.path;
  if (!path || !path.startsWith('/api/reports/')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid path' }) };
  }
  const url = `${PIPELINE_BASE}${path}`;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${PIPELINE_TOKEN}` } });
    const text = await resp.text();
    return {
      statusCode: resp.status,
      headers: {
        'Content-Type': resp.headers.get('content-type') || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      },
      body: text,
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
