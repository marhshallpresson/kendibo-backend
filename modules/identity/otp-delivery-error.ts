/**
 * Classifies OTP delivery errors into safe, client-facing error codes
 * without leaking raw provider errors or secrets.
 */
export function classifyOtpDeliveryError(err: unknown): string {
  if (!err) return 'DELIVERY_ERROR';
  
  const error = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  const name = error.name || '';
  const code = error.code || error.cause?.code || '';
  const message = (error.message || '').toLowerCase();

  if (name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT' || /timeout/i.test(message)) {
    return 'PROVIDER_TIMEOUT';
  }
  if (code === 'EAUTH' || /authentication failed|unauthorized/i.test(message)) {
    return 'PROVIDER_AUTH_FAILED';
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND') {
    return 'PROVIDER_CONNECTION_FAILED';
  }
  if (/cannot send a (otp|transactional) with this sender/i.test(message)) {
    return 'SENDER_ROUTE_NOT_ALLOWED';
  }
  if (/(email|sms|provider)_not_configured/i.test(message)) {
    return 'PROVIDER_NOT_CONFIGURED';
  }

  return 'DELIVERY_ERROR';
}
