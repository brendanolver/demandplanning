const PIPELINE_BASE = 'http://170.64.229.248:3000';
const PIPELINE_TOKEN = 'RsCdZC3-bkfKvEf2TKXI2bMRHDlECre3aWM9VuNDt60';

export default async (request, context) => {
  const url = new URL(request.url);
  const path = url.searchParams.get('path');
  if (!path || !path.startsWith('/api/reports/')) {
    return new Response(JSON.stringify({ error: 'invalid path' }), { status: 400 });
  }
  const refresh = url.searchParams.get('refresh');
  const targetUrl = PIPELINE_BASE + path + (refresh ? `?refresh=${encodeURIComponent(refresh)}` : '');
  const headers = { Authorization: `Bearer ${PIPELINE_TOKEN}` };

  if (refresh) {
    // Refresh regenerates the report server-side and can take ~40s — longer than
    // this edge function's execution budget. Race a short window; if it hasn't
    // finished, hand the in-flight request off to waitUntil (best-effort — the
    // pipeline job itself keeps running server-side regardless) and tell the
    // client to poll the plain manifest for the updated modifiedTime instead.
    const fetchPromise = fetch(targetUrl, { headers });
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000));
    const result = await Promise.race([fetchPromise, timeout]);
    if (result === 'timeout') {
      if (context?.waitUntil) context.waitUntil(fetchPromise.catch(() => {}));
      return new Response(JSON.stringify({ started: true, message: 'Refresh in progress — poll manifest for completion' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    const text = await result.text();
    return new Response(text, {
      status: result.status,
      headers: { 'Content-Type': result.headers.get('content-type') || 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const resp = await fetch(targetUrl, { headers });
    return new Response(resp.body, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('content-type') || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = { path: '/pipeline-edge-proxy' };
