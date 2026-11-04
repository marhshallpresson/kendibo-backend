import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOtpDeliveryError } from '../modules/identity/otp-delivery-error.js';

test('OTP failures are classified without returning provider content', () => {
  assert.equal(classifyOtpDeliveryError(Object.assign(new Error('private provider details'), { name: 'AbortError' })), 'PROVIDER_TIMEOUT');
  assert.equal(classifyOtpDeliveryError(Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })), 'PROVIDER_TIMEOUT');
  assert.equal(classifyOtpDeliveryError(Object.assign(new Error('private provider details'), { code: 'EAUTH' })), 'PROVIDER_AUTH_FAILED');
  assert.equal(classifyOtpDeliveryError(Object.assign(new Error('private provider details'), { code: 'ECONNREFUSED' })), 'PROVIDER_CONNECTION_FAILED');
  assert.equal(classifyOtpDeliveryError(new Error('you cannot send a otp with this sender')), 'SENDER_ROUTE_NOT_ALLOWED');
  assert.equal(classifyOtpDeliveryError(new Error('EMAIL_NOT_CONFIGURED')), 'PROVIDER_NOT_CONFIGURED');
  assert.equal(classifyOtpDeliveryError(new Error('private provider details')), 'DELIVERY_ERROR');
});
