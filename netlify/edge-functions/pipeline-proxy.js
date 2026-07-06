const PIPELINE_BASE = 'http://170.64.229.248:3000';
const PIPELINE_TOKEN = 'RsCdZC3-bkfKvEf2TKXI2bMRHDlECre3aWM9VuNDt60';

export default async (request) => {
  const url = new URL(request.url);
  const path = url.searchParams.get('path');
  if (!path || !path.startsWith('/api/reports/')) {
    return new Response(JSON.stringify({ error: 'invalid path' }), { status: 400 });
  }
  const refresh = url.searchParams.get('refresh');
  const targetUrl = PIPELINE_BASE + path + (refresh ? `?refresh=${encodeURIComponent(refresh)}` : '');
  try {
    const resp = await fetch(targetUrl, {
      headers: { Authorization: `Bearer ${PIPELINE_TOKEN}` },
    });
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
