import { handler, send } from '../../lib/http.js';
import { destroySession } from '../../lib/auth.js';

export default handler(['POST'], async (req, res) => {
  await destroySession(req, res);
  send(res, 200, { ok: true });
});
