// Email + password accounts on Node's built-in crypto (scrypt), opaque session tokens
// stored only as SHA-256 hashes, httpOnly cookies. No third-party auth dependency.
import { scrypt as _scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { q } from './db.js';
import { HttpError, clientIp } from './http.js';

const scrypt = promisify(_scrypt);
// OWASP-recommended scrypt floor is N=2^17,r=8,p=1; N=2^15 keeps a cold serverless call fast
// (~100 ms, 32 MiB). Parameters are stored with each hash so they can be raised later.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 };
const COOKIE = 'chendu_sid';
const SESSION_DAYS = 30;

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

export function normEmail(v) {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!e || e.length > 254 || !EMAIL_RE.test(e)) throw new HttpError(400, 'bad_email', '邮箱格式不对');
  return e;
}
export function checkPassword(v) {
  if (typeof v !== 'string' || v.length < 8) throw new HttpError(400, 'weak_password', '密码至少 8 位');
  if (v.length > 128) throw new HttpError(400, 'long_password', '密码最多 128 位');
  return v;
}

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const key = await scrypt(pw.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const want = Buffer.from(keyB64, 'base64');
  const got = await scrypt(pw.normalize('NFKC'), Buffer.from(saltB64, 'base64'), want.length,
    { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return got.length === want.length && timingSafeEqual(got, want);
}

// A valid hash to burn the same time when the email does not exist (limits user enumeration by timing).
let dummyHash = null;
export async function burnHash(pw) {
  if (!dummyHash) dummyHash = await hashPassword('dummy-password-for-timing');
  await verifyPassword(pw, dummyHash);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}

function cookie(value, maxAge) {
  // Secure is always set; browsers accept Secure cookies on http://localhost for local testing.
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function createSession(res, userId) {
  const token = randomBytes(32).toString('base64url');
  await q(`insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + ($3 || ' days')::interval)`,
    [sha256(token), userId, String(SESSION_DAYS)]);
  res.setHeader('Set-Cookie', cookie(token, SESSION_DAYS * 86400));
}

export async function destroySession(req, res) {
  const t = parseCookies(req)[COOKIE];
  if (t) await q('delete from sessions where token_hash = $1', [sha256(t)]);
  res.setHeader('Set-Cookie', cookie('', 0));
}

/** Returns {id, email} for a valid session, or null. */
export async function currentUser(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t || t.length > 100) return null;
  const rows = await q(
    `select u.id, u.email from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`, [sha256(t)]);
  return rows[0] ? { id: String(rows[0].id), email: rows[0].email } : null;
}

export async function requireUser(req) {
  const u = await currentUser(req);
  if (!u) throw new HttpError(401, 'unauthorized', '请先登录');
  return u;
}

/* ---------------- rate limiting (fixed window, stored in Postgres so it works across instances) */
const LIMITS = {
  ip: { max: 30, minutes: 15 },     // auth attempts per IP
  email: { max: 10, minutes: 15 },  // failed logins per email
  register: { max: 5, minutes: 60 },// new accounts per IP
};

export async function hit(kind, id) {
  await q('insert into auth_attempts (bucket) values ($1)', [`${kind}:${sha256(String(id))}`]);
  // opportunistic cleanup
  if (Math.random() < 0.05) {
    await q(`delete from auth_attempts where created_at < now() - interval '1 day'`);
    await q('delete from sessions where expires_at < now()');
  }
}

export async function assertNotLimited(kind, id) {
  const { max, minutes } = LIMITS[kind];
  const rows = await q(
    `select count(*)::int as n from auth_attempts where bucket = $1 and created_at > now() - ($2 || ' minutes')::interval`,
    [`${kind}:${sha256(String(id))}`, String(minutes)]);
  if (rows[0].n >= max) throw new HttpError(429, 'rate_limited', '尝试次数太多，请过一会儿再试');
}

export async function clearHits(kind, id) {
  await q('delete from auth_attempts where bucket = $1', [`${kind}:${sha256(String(id))}`]);
}

export { clientIp };
