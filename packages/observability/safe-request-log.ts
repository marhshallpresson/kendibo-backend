/** Keep bearer-style query parameters and signed links out of request logs. */
export function safeRequestLog(req: { method?: string; url?: string; hostname?: string; ip?: string }) {
  return {
    method: req.method,
    url: (req.url ?? '').split('?', 1)[0],
    hostname: req.hostname,
    remoteAddress: req.ip,
  };
}
