/** Classify provider failures without recording messages, credentials or identities. */
export function classifyOtpDeliveryError(cause: unknown): string {
  if (!(cause instanceof Error)) return 'DELIVERY_ERROR';
  const nested = (cause as Error & { cause?: { code?: unknown } }).cause;
  const code = (cause as Error & { code?: unknown }).code ?? nested?.code;
  if (/you cannot send a (otp|transactional) with this sender/i.test(cause.message)) return 'SENDER_ROUTE_NOT_ALLOWED';
  if (cause.name === 'AbortError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || /timed?\s*out/i.test(cause.message)) return 'PROVIDER_TIMEOUT';
  if (code === 'EAUTH') return 'PROVIDER_AUTH_FAILED';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENETUNREACH' || code === 'ESOCKET') return 'PROVIDER_CONNECTION_FAILED';
  if (/^(SMS_NOT_CONFIGURED|SLING_NOT_CONFIGURED|EMAIL_NOT_CONFIGURED)$/.test(cause.message)) return 'PROVIDER_NOT_CONFIGURED';
  return 'DELIVERY_ERROR';
}
