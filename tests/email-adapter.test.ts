import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmailFrom } from '../modules/notifications/channels.js';

test('SMTP sender settings override the legacy email sender', () => {
  assert.equal(resolveEmailFrom({
    SMTP_FROM: 'kendibohomes@gmail.com',
    SMTP_FROM_NAME: 'Kendibo',
    EMAIL_FROM: 'no-reply@kendibo.ng',
  }), 'Kendibo <kendibohomes@gmail.com>');
});

test('legacy EMAIL_FROM remains a fallback when SMTP_FROM is absent', () => {
  assert.equal(resolveEmailFrom({ EMAIL_FROM: 'Kendibo <hello@kendibo.com>' }), 'Kendibo <hello@kendibo.com>');
});