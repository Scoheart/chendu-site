import { handler, send } from '../../lib/http.js';
import { currentUser } from '../../lib/auth.js';

export default handler(['GET'], async (req, res) => {
  const u = await currentUser(req);
  send(res, 200, { user: u ? { email: u.email } : null });
});
