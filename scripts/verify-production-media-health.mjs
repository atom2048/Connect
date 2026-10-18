const workerHealthURL = process.env.CONNECT_WORKER_HEALTH_URL || 'https://connect-social-standalone.quest-live.workers.dev/api/health';
const appHealthURL = process.env.CONNECT_APP_HEALTH_URL || 'https://sns-app-ashen.vercel.app/api/health';

async function verifyHealth(label, value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.pathname !== '/api/health') {
      throw new Error('health_url_invalid');
    }
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.ok === true && payload.architecture === 'cloudflare-workers' && payload.d1 === true && payload.r2 === true) {
      console.log(JSON.stringify({
        event: 'media_release_health_passed',
        target: label,
        status: response.status,
        architecture: payload.architecture,
        d1: payload.d1,
        r2: payload.r2,
      }));
      return true;
    }
    console.error(JSON.stringify({
      event: 'media_release_health_failed',
      target: label,
      status: response.status,
      responseCode: payload && typeof payload.error === 'string' ? payload.error : null,
      workerArchitecture: payload && typeof payload.architecture === 'string' ? payload.architecture : null,
      d1Ready: payload && typeof payload.d1 === 'boolean' ? payload.d1 : null,
      r2Ready: payload && typeof payload.r2 === 'boolean' ? payload.r2 : null,
    }));
    return false;
  } catch (error) {
    console.error(JSON.stringify({
      event: 'media_release_health_failed',
      target: label,
      reason: error instanceof Error ? error.name + ':' + error.message : 'unknown',
    }));
    return false;
  }
}

const healthResults = await Promise.all([
  verifyHealth('cloudflare_worker', workerHealthURL),
  verifyHealth('vercel_rewrite', appHealthURL),
]);
if (healthResults.some(result => !result)) process.exitCode = 1;
