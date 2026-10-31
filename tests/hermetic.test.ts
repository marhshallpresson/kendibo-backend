// Guard: proves the setup-env preload reached this test process. If it ever
// stops applying (script changed, runner changed), this fails loudly instead of
// the suite silently running against a real database.
import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('tests run hermetically (no real database, no live credentials)', () => {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.DATABASE_URL, '');
  assert.equal(process.env.TERMII_API_KEY, '');
  assert.equal(process.env.BACHS_API_KEY, '');
  assert.equal(process.env.WHATSAPP_ACCESS_TOKEN, '');
});
