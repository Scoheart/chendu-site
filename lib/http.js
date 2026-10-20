// Small helpers so the handlers run the same on Vercel's Node runtime and in the local harness.
const MAX_BODY = 512 * 1024;

export function send(res, status, obj, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

export class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

export async function readJson(req) {
  const ct = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, 'bad_content_type', '请求格式不对');
  // Vercel's Node runtime parses JSON lazily via a req.body getter, which throws on invalid JSON.
  let pre;
  try { pre = req.body; } catch { throw new HttpError(400, 'bad_json', '请求格式不对'); }
  if (pre !== undefined && pre !== null && typeof pre === 'object' && !Buffer.isBuffer(pre)) return pre;
  let raw = typeof pre === 'string' ? pre : Buffer.isBuffer(pre) ? pre.toString('utf8') : null;
  if (raw === null) {
    raw = await new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, 'too_large', '内容太大')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  if (raw.length > MAX_BODY) throw new HttpError(413, 'too_large', '内容太大');
  try { const v = JSON.parse(raw || '{}'); if (v && typeof v === 'object') return v; } catch {}
  throw new HttpError(400, 'bad_json', '请求格式不对');
}

/** Same-origin check for state-changing requests (defence in depth on top of SameSite cookies). */
export function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return; // non-browser clients and some same-origin requests omit it
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  let oh;
  try { oh = new URL(origin).host; } catch { throw new HttpError(403, 'bad_origin', '来源不被允许'); }
  if (oh !== host) throw new HttpError(403, 'bad_origin', '来源不被允许');
}

export function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

export function handler(methods, fn) {
  return async (req, res) => {
    try {
      if (!methods.includes(req.method)) { res.setHeader('Allow', methods.join(', ')); return send(res, 405, { error: 'method_not_allowed' }); }
      if (req.method !== 'GET') checkOrigin(req);
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
      console.error(e);
      return send(res, 500, { error: 'server_error', message: '服务器出错了，请稍后再试' });
    }
  };
}
