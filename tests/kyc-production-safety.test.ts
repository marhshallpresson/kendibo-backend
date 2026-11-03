import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectKycAdapter, verifyNameAlignment } from '../modules/kyc/kyc.service.js';

test('production never approves identity using the sandbox adapter', async () => {
  const oldEnv = process.env.NODE_ENV;
  const oldProvider = process.env.KYC_PROVIDER;
  process.env.NODE_ENV = 'production';
  process.env.KYC_PROVIDER = 'stub';
  try {
    const result = await selectKycAdapter().verifyNin('12345678901');
    assert.equal(result.passed, false);
    assert.equal(result.reason, 'KYC_PROVIDER_UNCONFIGURED');
  } finally {
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    if (oldProvider === undefined) delete process.env.KYC_PROVIDER; else process.env.KYC_PROVIDER = oldProvider;
  }
});

test('a submitted name is not treated as a verified identity', () => {
  const result = verifyNameAlignment({ submittedName: 'Example Customer', businessName: 'Example Business' });
  assert.equal(result.verifiedLegalName, null);
  assert.equal(result.verifiedCacName, null);
  assert.equal(result.aligned, false);
});
