// End-to-end API checks against a running server (npm run dev:local or vercel dev).
//   BASE=http://localhost:3000 npm run test:api
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:3000';
const uniq = Date.now().toString(36);
let passed = 0;

function client() {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const h = { Accept: 'application/json', ...headers };
    if (body !== undefined) h['Content-Type'] ??= 'application/json';
    if (cookie) h.Cookie = cookie;
    const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null), setCookie: sc };
  };
}
async function t(name, fn) { await fn(); passed++; console.log('ok -', name); }

const A = client(), B = client(), anon = client();
const ea = `a-${uniq}@example.com`, eb = `b-${uniq}@example.com`, pw = 'correct horse 1';
const key = 'chendu:notes:2026-10-19';
const doc = { v: 1, notes: [{ id: 'n1', quote: 'surge', text: '激增', created: 1, updated: 1 }] };

await t('me is null when logged out', async () => {
  const r = await anon('GET', '/api/auth/me'); assert.equal(r.status, 200); assert.equal(r.body.user, null);
});
await t('register validates input', async () => {
  assert.equal((await anon('POST', '/api/auth/register', { email: 'nope', password: pw })).status, 400);
  assert.equal((await anon('POST', '/api/auth/register', { email: ea, password: 'short' })).status, 400);
  assert.equal((await anon('POST', '/api/auth/register', 'email=x', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
});
await t('register sets an httpOnly Secure SameSite cookie', async () => {
  const r = await A('POST', '/api/auth/register', { email: ea.toUpperCase(), password: pw });
  assert.equal(r.status, 201); assert.equal(r.body.user.email, ea);
  assert.match(r.setCookie, /HttpOnly/); assert.match(r.setCookie, /Secure/); assert.match(r.setCookie, /SameSite=Lax/);
});
await t('duplicate email is rejected', async () => {
  assert.equal((await anon('POST', '/api/auth/register', { email: ea, password: pw })).status, 409);
});
await t('cross-origin POST is rejected', async () => {
  assert.equal((await anon('POST', '/api/auth/login', { email: ea, password: pw }, { Origin: 'https://evil.example' })).status, 403);
});
await t('sync requires login', async () => {
  assert.equal((await anon('GET', '/api/sync')).status, 401);
  assert.equal((await anon('PUT', '/api/sync', { docs: [{ key, value: doc, baseRev: 0 }] })).status, 401);
});
await t('create, read, compare-and-swap', async () => {
  let r = await A('PUT', '/api/sync', { docs: [{ key, value: doc, baseRev: 0 }] });
  assert.deepEqual(r.body.results[0], { key, ok: true, rev: 1 });
  r = await A('PUT', '/api/sync', { docs: [{ key, value: doc, baseRev: 0 }] });
  assert.equal(r.body.results[0].conflict, true); assert.equal(r.body.results[0].rev, 1);
  r = await A('PUT', '/api/sync', { docs: [{ key, value: { ...doc, notes: [] }, baseRev: 1 }] });
  assert.deepEqual(r.body.results[0], { key, ok: true, rev: 2 });
  r = await A('PUT', '/api/sync', { docs: [{ key, value: doc, baseRev: 1 }] });
  assert.equal(r.body.results[0].conflict, true); assert.deepEqual(r.body.results[0].value, { v: 1, notes: [] });
  r = await A('GET', '/api/sync?issue=2026-10-19');
  assert.equal(r.body.docs.length, 1); assert.equal(r.body.docs[0].rev, 2);
});
await t('validates keys and values', async () => {
  assert.equal((await A('PUT', '/api/sync', { docs: [{ key: 'chendu:sync:meta', value: doc }] })).status, 400);
  assert.equal((await A('PUT', '/api/sync', { docs: [{ key, value: { v: 1, notes: 'x' } }] })).status, 400);
  assert.equal((await A('PUT', '/api/sync', { docs: [{ key, value: { v: 1, notes: [{ text: 'x'.repeat(300 * 1024) }] } }] })).status, 413);
});
await t('accounts are isolated', async () => {
  assert.equal((await B('POST', '/api/auth/register', { email: eb, password: pw })).status, 201);
  let r = await B('GET', '/api/sync'); assert.deepEqual(r.body.docs, []);
  r = await B('PUT', '/api/sync', { docs: [{ key, value: doc, baseRev: 2 }] }); // A's rev: must not touch A's row
  assert.equal(r.body.results[0].conflict, true); assert.equal(r.body.results[0].rev, 0);
  r = await A('GET', '/api/sync'); assert.deepEqual(r.body.docs[0].value, { v: 1, notes: [] });
});
await t('logout ends the session', async () => {
  assert.equal((await A('POST', '/api/auth/logout', {})).status, 200);
  assert.equal((await A('GET', '/api/auth/me')).body.user, null);
  assert.equal((await A('GET', '/api/sync')).status, 401);
});
await t('login: wrong password, then right password', async () => {
  assert.equal((await A('POST', '/api/auth/login', { email: ea, password: 'wrong password' })).status, 401);
  assert.equal((await A('POST', '/api/auth/login', { email: `x-${uniq}@example.com`, password: pw })).status, 401);
  const r = await A('POST', '/api/auth/login', { email: ea, password: pw });
  assert.equal(r.status, 200); assert.equal((await A('GET', '/api/auth/me')).body.user.email, ea);
});
await t('failed logins are rate limited per email', async () => {
  const C = client(); let last;
  for (let i = 0; i < 11; i++) last = await C('POST', '/api/auth/login', { email: eb, password: 'wrong password' }, { 'X-Forwarded-For': `10.9.${i}.1` });
  assert.equal(last.status, 429);
  assert.equal((await C('POST', '/api/auth/login', { email: eb, password: pw }, { 'X-Forwarded-For': '10.9.99.1' })).status, 429);
});
console.log(`\n${passed} checks passed`);
