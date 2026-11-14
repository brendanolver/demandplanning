import { verifyToken } from '../lib/edge-token.mjs';

const PIPELINE_BASE = 'http://170.64.229.248:3000';

const json = (status, obj, extra) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
});

export default async (request, context) => {
  // Both live in this site's Netlify environment variables, never in source: PIPELINE_TOKEN is the report
  // pipeline's own bearer token; APP_SESSION_SECRET is the key the app's sign-in tokens are signed with.
  const pipelineToken = Netlify.env.get('PIPELINE_TOKEN');
  const sessionSecret = Netlify.env.get('APP_SESSION_SECRET');
  if (!pipelineToken || !sessionSecret) {
    return json(503, { error: 'The report pipeline proxy isn\'t set up: add PIPELINE_TOKEN and APP_SESSION_SECRET to this site\'s Netlify environment variables, then redeploy.' });
  }
  // Signed-in app sessions only — same token every other function checks (netlify/lib/app-auth.js). The header
  // lets the page tell this apart from a 401 the pipeline itself might send, which is passed through below.
  if (!(await verifyToken(request.headers.get('x-app-token'), sessionSecret))) {
    return json(401, { error: 'Sign in required.', auth: 'required' }, { 'X-App-Auth': 'required' });
  }

  const url = new URL(request.url);
  const path = url.searchParams.get('path');
  if (!path || !path.startsWith('/api/reports/')) {
    return json(400, { error: 'invalid path' });
  }
  const refresh = url.searchParams.get('refresh');
  const targetUrl = PIPELINE_BASE + path + (refresh ? `?refresh=${encodeURIComponent(refresh)}` : '');
  const headers = { Authorization: `Bearer ${pipelineToken}` };

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
      return json(202, { started: true, message: 'Refresh in progress — poll manifest for completion' });
    }
    const text = await result.text();
    return new Response(text, {
      status: result.status,
      headers: { 'Content-Type': result.headers.get('content-type') || 'application/json' },
    });
  }

  try {
    const resp = await fetch(targetUrl, { headers });
    return new Response(resp.body, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('content-type') || 'application/octet-stream' },
    });
  } catch (err) {
    return json(500, { error: err.message });
  }
};

export const config = { path: '/pipeline-edge-proxy' };
