// Create (or promote) a console admin directly in the database.
// No passwords: admins sign in with a one-time code emailed to this address.
//
//   npx tsx --env-file=.env scripts/create-admin.ts admin@kendibo.ng [ROLE]
//
// ROLE defaults to SUPER_ADMIN and must be one of ADMIN_ROLES. Safe to re-run:
// an existing account keeps its id and history and only its role changes.
import { q } from '../packages/database/db.js';
import { ADMIN_ROLES } from '../modules/authorization/rbac.js';

async function main() {
  const email = String(process.argv[2] ?? '').trim().toLowerCase();
  const role = String(process.argv[3] ?? 'SUPER_ADMIN').trim().toUpperCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Usage: create-admin.ts <email> [ROLE]');
  if (!(ADMIN_ROLES as readonly string[]).includes(role)) throw new Error(`ROLE must be one of: ${ADMIN_ROLES.join(', ')}`);

  const existing = await q<{ id: string; role: string }>(`SELECT id, role FROM identity.users WHERE lower(email)=$1`, [email]);
  if (existing[0]) {
    await q(`UPDATE identity.users SET role=$2, updated_at=now() WHERE id=$1`, [existing[0].id, role]);
    console.log(`Updated ${email}: ${existing[0].role} -> ${role} (id ${existing[0].id})`);
  } else {
    const rows = await q<{ id: string }>(
      `INSERT INTO identity.users (email, name, role) VALUES ($1, $2, $3) RETURNING id`,
      [email, 'Kendibo Admin', role],
    );
    console.log(`Created ${email} as ${role} (id ${rows[0].id})`);
  }
  const check = await q<{ email: string; role: string }>(`SELECT email, role FROM identity.users WHERE lower(email)=$1`, [email]);
  console.log(`Now: ${check[0]?.email} is ${check[0]?.role}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error((e as Error).message); process.exit(1); });
