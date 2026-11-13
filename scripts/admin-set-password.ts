// Set (or reset) an admin console password from the server, for when email
// can't be used. Prints a one-time password once; the admin must change it
// after signing in (must_change). Run on the server:
//   GOMAXPROCS=1 node --env-file=.env --import tsx scripts/admin-set-password.ts admin@kendibo.ng
import crypto from 'node:crypto';
import { adminPassword } from '../modules/identity/admin-password.js';

const email = process.argv[2];
if (!email) { console.error('usage: admin-set-password.ts <admin email>'); process.exit(2); }
const seat = await adminPassword.find(email);
if (!seat) { console.error(`No admin seat with email ${email}.`); process.exit(1); }
// 16 chars from an unambiguous alphabet, always with letters and digits.
const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
let pw = '';
while (!(/[a-zA-Z]/.test(pw) && /[0-9]/.test(pw))) pw = Array.from(crypto.randomBytes(16), (b) => alphabet[b % alphabet.length]).join('');
await adminPassword.set(String(seat.user.id), pw, true);
console.log(`One-time password for ${email}: ${pw}`);
console.log('Sign in at the admin console, then change it (Settings → Password). It is not stored anywhere in plain text.');
process.exit(0);
