// Usage: DATABASE_URL=postgres://... npm run db:migrate
import { readFile } from 'node:fs/promises';
import { q } from '../lib/db.js';

const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
// Neon's HTTP driver runs one statement per call, so split on top-level semicolons.
const stmts = sql.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
for (const s of stmts) await q(s);
console.log(`migrated: ${stmts.length} statements OK`);
process.exit(0);
