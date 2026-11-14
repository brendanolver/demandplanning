// Keeps the Shopify sales feed fresh without anyone having the app open.
//
// Netlify runs this on a timer (the `schedule` below). All it does is poke the real worker, sales-sync-background, exactly
// as an open browser tab does. The worker decides what is due — a quick "today only" refresh (seconds), the 5-day trailing
// refresh every 10 minutes, the daily full rebuild — and does nothing if the data is already fresh or a run is in progress,
// so an extra poke costs next to nothing. (A scheduled function itself only gets seconds to run, which is why the work
// stays in the background function and this one just triggers it.)
//
// Cost: one tiny invocation per tick plus one for the worker. Every 2 minutes is ~21,600 + ~21,600 a month. Change the
// cron below to `* * * * *` for a refresh every minute, or `*/5 * * * *` to ease off.
export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (!base) {
    console.log('[sales-sync-scheduled] no site URL in the environment — nothing to trigger');
    return new Response('no site url', { status: 500 });
  }
  try {
    const r = await fetch(`${base}/.netlify/functions/sales-sync-background`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    console.log('[sales-sync-scheduled] triggered the sales sync:', r.status);
    return new Response(String(r.status), { status: 200 });
  } catch (e) {
    console.log('[sales-sync-scheduled] could not reach the sales sync:', e && e.message || e);
    return new Response('trigger failed', { status: 502 });
  }
};

export const config = { schedule: '*/2 * * * *' };
