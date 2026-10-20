import { handler, readJson, send, HttpError, clientIp } from '../../lib/http.js';
import { normEmail, verifyPassword, burnHash, createSession, assertNotLimited, hit, clearHits } from '../../lib/auth.js';
import { q } from '../../lib/db.js';

export default handler(['POST'], async (req, res) => {
  const ip = clientIp(req);
  await assertNotLimited('ip', ip);
  const body = await readJson(req);
  const email = normEmail(body.email);
  const password = typeof body.password === 'string' ? body.password.slice(0, 128) : '';
  await assertNotLimited('email', email);
  await hit('ip', ip);
  const rows = await q('select id, email, password_hash from users where email = $1', [email]);
  const ok = rows[0] ? await verifyPassword(password, rows[0].password_hash) : (await burnHash(password), false);
  if (!ok) {
    await hit('email', email);
    throw new HttpError(401, 'bad_credentials', '邮箱或密码不对');
  }
  await clearHits('email', email);
  await createSession(res, rows[0].id);
  send(res, 200, { user: { email: rows[0].email } });
});
