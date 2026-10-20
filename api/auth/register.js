import { handler, readJson, send, HttpError, clientIp } from '../../lib/http.js';
import { normEmail, checkPassword, hashPassword, createSession, assertNotLimited, hit } from '../../lib/auth.js';
import { q } from '../../lib/db.js';

export default handler(['POST'], async (req, res) => {
  const ip = clientIp(req);
  await assertNotLimited('ip', ip);
  await assertNotLimited('register', ip);
  const body = await readJson(req);
  const email = normEmail(body.email);
  const password = checkPassword(body.password);
  await hit('ip', ip);
  const hash = await hashPassword(password);
  const rows = await q(
    'insert into users (email, password_hash) values ($1, $2) on conflict (email) do nothing returning id, email',
    [email, hash]);
  if (!rows[0]) throw new HttpError(409, 'email_taken', '这个邮箱已经注册过了，请直接登录');
  await hit('register', ip);
  await createSession(res, rows[0].id);
  send(res, 201, { user: { email: rows[0].email } });
});
