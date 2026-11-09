// Schema audit: finds every SQL statement in the code and asks the real
// database to EXPLAIN it (EXPLAIN plans a query without running it), inside a
// read-only transaction that is rolled back. Any statement naming a table or
// column that doesn't exist is reported, e.g. the missing kyc.verification_check.
//   npx tsx --env-file=.env scripts/schema-audit.ts
// Exit code 1 when anything is missing. Dynamic SQL fragments that can't be
// planned on their own (syntax errors, untyped NULLs) are ignored; only
// "relation/column/schema/function does not exist" errors are reported.
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const ROOTS = ['apps', 'modules', 'packages'];
const SQL_START = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;
const MISSING = new Set(['42P01', '42703', '3F000', '42883']); // table, column, schema, function

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === 'node_modules' || name === 'dist') continue;
    if (statSync(p).isDirectory()) files(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.includes(`${path.sep}local.ts`)) out.push(p);
  }
  return out;
}

interface Stmt { file: string; line: number; sql: string }
function extract(file: string): Stmt[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: Stmt[] = [];
  const visit = (n: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n)) {
      // Interpolations become NULL: enough to check the tables and columns around them.
      text = n.head.text + n.templateSpans.map((s) => ' NULL ' + s.literal.text).join('');
    }
    if (text && SQL_START.test(text) && /\b(FROM|INTO|UPDATE|JOIN)\b/i.test(text)) {
      found.push({ file, line: src.getLineAndCharacterOfPosition(n.getStart()).line + 1, sql: text });
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return found;
}

(async () => {
  const stmts = ROOTS.flatMap((r) => files(r)).flatMap(extract);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const local = /[?&]host=\//.test(url) || process.env.DATABASE_SSL === 'false';
  const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  await client.connect();
  const problems = new Map<string, string[]>();
  let checked = 0;
  for (const s of stmts) {
    const sql = s.sql.replace(/\$\d+/g, 'NULL').replace(/;\s*$/, '');
    await client.query('BEGIN READ ONLY');
    try {
      await client.query(`EXPLAIN ${sql}`);
      checked++;
    } catch (e) {
      const err = e as { code?: string; message: string };
      const where = `${path.relative('.', s.file)}:${s.line}`;
      if (err.code && MISSING.has(err.code)) {
        problems.set(err.message, [...(problems.get(err.message) || []), where]);
      } else if (process.argv.includes('--all')) {
        console.log(`  (not plannable alone) ${where} [${err.code}] ${err.message}`);
      }
    } finally {
      await client.query('ROLLBACK');
    }
  }
  await client.end();
  console.log(`schema-audit: ${stmts.length} SQL statements found, ${checked} planned cleanly against the live database`);
  if (!problems.size) { console.log('schema-audit: nothing missing'); return; }
  console.log(`schema-audit: ${problems.size} missing object(s):`);
  for (const [msg, where] of problems) console.log(`  - ${msg}\n      used at: ${[...new Set(where)].join(', ')}`);
  process.exitCode = 1;
})().catch((e) => { console.error('schema-audit FAILED', (e as Error).message); process.exit(2); });
