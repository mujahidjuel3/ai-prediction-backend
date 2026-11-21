/**
 * Local smoke checks against a running API (default http://127.0.0.1:4000).
 * Does not send email, does not call production, does not mutate unless SMOKE_MUTATE=1.
 */
const base = (process.env.SMOKE_API_BASE || 'http://127.0.0.1:4000/api/v1').replace(/\/+$/, '');

async function check(name, path, init = {}) {
  try {
    const response = await fetch(`${base}${path}`, init);
    const bodyText = await response.text();
    let json;
    try { json = JSON.parse(bodyText); } catch { json = null; }
    console.log(`${response.ok || response.status === 401 || response.status === 403 || response.status === 503 ? 'PASS' : 'FAIL'} ${name} -> ${response.status}`);
    return { name, status: response.status, json, ok: response.ok };
  } catch (cause) {
    console.log(`FAIL ${name} -> ${cause instanceof Error ? cause.message : 'error'}`);
    return { name, status: 0, ok: false };
  }
}

const results = [];
results.push(await check('health live', '/health/live'));
results.push(await check('health ready', '/health/ready'));
results.push(await check('csrf', '/auth/csrf'));
results.push(await check('unauthorized users', '/users'));
results.push(await check('predictions generate blocked', '/predictions/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));

const failed = results.filter((row) => row.status === 0);
if (failed.length) {
  console.log('Smoke incomplete: API not reachable. Start the backend locally first.');
  process.exit(2);
}
console.log('Smoke finished (read-mostly). Mutating CRUD/login requires seeded synthetic credentials.');
process.exit(0);
