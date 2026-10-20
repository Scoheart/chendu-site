// Reader documents: one JSON value per localStorage key, e.g. "chendu:notes:2026-10-19".
import { HttpError } from './http.js';

export const KEY_RE = /^chendu:(notes|tr|recall):(\d{4}-\d{2}-\d{2})$/;
export const MAX_DOC_BYTES = 256 * 1024;
export const MAX_DOCS_PER_USER = 5000;
const FIELD = { notes: 'notes', tr: 'items', recall: 'done' };

export function checkKey(key) {
  const m = typeof key === 'string' && key.match(KEY_RE);
  if (!m) throw new HttpError(400, 'bad_key', '数据键不合法');
  return m[1];
}

export function checkValue(kind, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'bad_value', '数据格式不对');
  const arr = value[FIELD[kind]];
  if (!Array.isArray(arr) || arr.length > 2000) throw new HttpError(400, 'bad_value', '数据格式不对');
  if (kind === 'recall' ? !arr.every((h) => typeof h === 'string' && h.length <= 500)
                        : !arr.every((x) => x && typeof x === 'object' && !Array.isArray(x)))
    throw new HttpError(400, 'bad_value', '数据格式不对');
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (size > MAX_DOC_BYTES) throw new HttpError(413, 'too_large', '这一期的数据太大了');
  return value;
}
