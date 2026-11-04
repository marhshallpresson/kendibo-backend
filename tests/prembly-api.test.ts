import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectKycAdapter } from '../modules/kyc/kyc.service.js';

test('Prembly NIN and BVN use the current API-key-only server contract', async () => {
  const keys = ['KYC_PROVIDER', 'PREMBLY_SECRET_KEY', 'PREMBLY_API_KEY', 'PREMBLY_APP_ID', 'PREMBLY_PUBLIC_KEY', 'PREMBLY_BASE_URL'] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const requests: { url: string; init: RequestInit }[] = [];

  try {
    process.env.KYC_PROVIDER = 'prembly';
    process.env.PREMBLY_SECRET_KEY = 'unit-test-secret';
    process.env.PREMBLY_API_KEY = '';
    process.env.PREMBLY_APP_ID = 'must-not-be-sent';
    process.env.PREMBLY_PUBLIC_KEY = 'client-only-public-key';
    process.env.PREMBLY_BASE_URL = 'https://api.prembly.com';
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ data: { firstname: 'Test' }, status: true, response_code: '00' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const adapter = selectKycAdapter();
    assert.equal((await adapter.verifyNin('00000000000')).passed, true);
    assert.equal((await adapter.verifyBvn('11111111111')).passed, true);

    assert.deepEqual(requests.map(({ url }) => url), [
      'https://api.prembly.com/verification/vnin',
      'https://api.prembly.com/verification/bvn_validation',
    ]);
    assert.deepEqual(requests.map(({ init }) => JSON.parse(String(init.body))), [
      { number_nin: '00000000000' },
      { number: '11111111111' },
    ]);
    for (const { init } of requests) {
      const headers = new Headers(init.headers);
      assert.equal(headers.get('x-api-key'), 'unit-test-secret');
      assert.equal(headers.get('app-id'), null);
      assert.equal(headers.get('authorization'), null);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
