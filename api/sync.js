// GET  /api/sync[?issue=YYYY-MM-DD]  -> {docs:[{key, value, rev}]}
// PUT  /api/sync {docs:[{key, value, baseRev}]} -> {results:[{key, ok, rev} | {key, conflict, value, rev}]}
// Every query is scoped by the session's user id, so one account can never read or write another's rows.
// Writes are compare-and-swap on `rev`; on conflict the client merges and retries.
import { handler, readJson, send, HttpError } from '../lib/http.js';
import { requireUser } from '../lib/auth.js';
import { checkKey, checkValue, MAX_DOCS_PER_USER } from '../lib/docs.js';
import { q } from '../lib/db.js';

const ISSUE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default handler(['GET', 'PUT'], async (req, res) => {
  const user = await requireUser(req);
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const issue = url.searchParams.get('issue');
    let rows;
    if (issue) {
      if (!ISSUE_RE.test(issue)) throw new HttpError(400, 'bad_issue', '参数不对');
      rows = await q(`select key, value, rev from reader_docs where user_id = $1 and key = any($2::text[])`,
        [user.id, ['notes', 'tr', 'recall'].map((k) => `chendu:${k}:${issue}`)]);
    } else {
      rows = await q('select key, value, rev from reader_docs where user_id = $1 order by key', [user.id]);
    }
    return send(res, 200, { docs: rows.map((r) => ({ key: r.key, value: r.value, rev: r.rev })) });
  }

  const body = await readJson(req);
  const docs = Array.isArray(body.docs) ? body.docs : null;
  if (!docs || !docs.length || docs.length > 100) throw new HttpError(400, 'bad_docs', '数据格式不对');
  const results = [];
  for (const d of docs) {
    const kind = checkKey(d && d.key);
    const value = checkValue(kind, d.value);
    const baseRev = Number.isInteger(d.baseRev) && d.baseRev >= 0 ? d.baseRev : 0;
    const json = JSON.stringify(value);
    let rows;
    if (baseRev === 0) {
      const [{ n }] = await q('select count(*)::int as n from reader_docs where user_id = $1', [user.id]);
      if (n >= MAX_DOCS_PER_USER) throw new HttpError(413, 'too_many', '数据条目太多');
      rows = await q(`insert into reader_docs (user_id, key, value, rev) values ($1, $2, $3::jsonb, 1)
                      on conflict (user_id, key) do nothing returning rev`, [user.id, d.key, json]);
    } else {
      rows = await q(`update reader_docs set value = $3::jsonb, rev = rev + 1, updated_at = now()
                       where user_id = $1 and key = $2 and rev = $4 returning rev`, [user.id, d.key, json, baseRev]);
    }
    if (rows[0]) { results.push({ key: d.key, ok: true, rev: rows[0].rev }); continue; }
    const cur = await q('select value, rev from reader_docs where user_id = $1 and key = $2', [user.id, d.key]);
    results.push(cur[0] ? { key: d.key, conflict: true, value: cur[0].value, rev: cur[0].rev }
                        : { key: d.key, conflict: true, value: null, rev: 0 });
  }
  send(res, 200, { results });
});
