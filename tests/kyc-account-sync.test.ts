// One verified identity per account: a user verified as a provider is
// verified on the customer side too (so the app stops asking them to verify),
// and an admin can approve a customer who never submitted.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';
import { kycService } from '../modules/kyc/kyc.service.js';

async function userWithProvider(kyc: 'VERIFIED' | 'UNDER_REVIEW') {
  const uid = String((await q<{ id: string }>(
    `INSERT INTO identity.users (email, role, name) VALUES ($1,'PROVIDER','Bola Fixes') RETURNING id`, [`sync-${randomUUID()}@kendibo.local`],
  ))[0].id);
  const pid = String((await q<{ id: string }>(
    `INSERT INTO provider.provider (user_id, kyc_status, kyc_tier, nin_masked, verified_legal_name, rating) VALUES ($1,$2,2,'123****8901','BOLA ADE FIXES',5) RETURNING id`,
    [uid, kyc],
  ))[0].id);
  return { uid, pid };
}

describe('KYC: one verified identity per account', () => {
  it('a verified provider reads as verified on the customer side, once', async () => {
    const { uid } = await userWithProvider('VERIFIED');
    const s = await kycService.userStatus(uid);
    assert.equal(s.status, 'VERIFIED');
    assert.equal(s.ninMasked, '123****8901');
    assert.equal(s.verifiedLegalName, 'BOLA ADE FIXES');
    assert.equal(await kycService.syncCustomerFromProvider({ userId: uid }), false, 'already in step');
  });

  it('an unverified provider is not marked verified', async () => {
    const { uid } = await userWithProvider('UNDER_REVIEW');
    assert.equal((await kycService.userStatus(uid)).status, 'PENDING');
  });

  it('admin approval of the provider syncs the customer side; a rejected customer row is upgraded', async () => {
    const { uid, pid } = await userWithProvider('UNDER_REVIEW');
    await q(`INSERT INTO kyc.customer (user_id, status, tier, rejection_reason) VALUES ($1,'REJECTED',1,'NAME_MISMATCH')`, [uid]);
    await kycService.markApproved(pid, 'admin-1');
    const s = await kycService.userStatus(uid);
    assert.equal(s.status, 'VERIFIED');
    assert.equal(s.rejectionReason, null);
  });

  it('an admin can approve a customer who never submitted', async () => {
    const uid = String((await q<{ id: string }>(`INSERT INTO identity.users (email) VALUES ($1) RETURNING id`, [`sync-${randomUUID()}@kendibo.local`]))[0].id);
    await kycService.userApprove(uid, 'admin-1');
    assert.equal((await kycService.userStatus(uid)).status, 'VERIFIED');
  });
});
