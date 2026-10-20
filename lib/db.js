// Database access. Production (Vercel + Neon) uses Neon's serverless HTTP driver.
// Local development and tests can point DATABASE_URL at any plain Postgres; set
// DB_DRIVER=pg (or use a localhost URL) to use node-postgres instead.
import { neon } from '@neondatabase/serverless';

let queryFn = null;

function isLocal(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '';
  } catch { return false; }
}

async function init() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  if (process.env.DB_DRIVER === 'pg' || isLocal(url)) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    return async (text, params = []) => (await pool.query(text, params)).rows;
  }
  const sql = neon(url);
  return (text, params = []) => sql.query(text, params);
}

/** Run a parameterized query and return the rows. Never interpolate user input into `text`. */
export async function q(text, params) {
  if (!queryFn) queryFn = await init();
  return queryFn(text, params);
}
