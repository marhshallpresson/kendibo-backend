// Client surfaces — one backend, three versioned consumers (PRD App C + §54-55).
// All routes live under /v1; each surface gets its own auth policy + rate limit tier.
//   USER_APP      -> roles: CUSTOMER. Scope: own bookings/properties/wallet/quotes/reviews.
//   PROVIDER_APP  -> roles: PROVIDER (+PROVIDER_ADMIN), B2B_MEMBER/B2B_ADMIN/FACILITY_MANAGER.
//                    Scope: own offers/jobs/earnings + org work-orders/invoices.
//   ADMIN_CONSOLE -> roles: SUPER_ADMIN/OPERATIONS/DISPATCHER/CUSTOMER_SUPPORT/FINANCE/
//                    TRUST_SAFETY/CONTENT_MANAGER/ANALYST/READ_ONLY. Scope: everything, audited, 2FA.
export type ClientSurface = 'user_app' | 'provider_b2b_app' | 'admin_console';
export const SURFACE_ROLES: Record<ClientSurface, string[]> = {
  user_app: ['CUSTOMER'],
  provider_b2b_app: ['PROVIDER', 'PROVIDER_ADMIN', 'B2B_ADMIN', 'B2B_MEMBER', 'FACILITY_MANAGER', 'PROPERTY_MANAGER'],
  admin_console: ['SUPER_ADMIN', 'OPERATIONS', 'DISPATCHER', 'CUSTOMER_SUPPORT', 'FINANCE', 'TRUST_SAFETY', 'CONTENT_MANAGER', 'PROPERTY_MANAGER', 'ANALYST', 'READ_ONLY'],
};
// Route ownership (prefix -> surface). Enforced in docs + gateway rate-limit config.
export const ROUTE_SURFACE: [string, ClientSurface][] = [
  ['/v1/me', 'user_app'],
  ['/v1/addresses', 'user_app'],
  ['/v1/properties', 'user_app'],
  ['/v1/categories', 'user_app'],
  ['/v1/services', 'user_app'],
  ['/v1/pricing', 'user_app'],
  ['/v1/bookings', 'user_app'],
  ['/v1/quotes', 'user_app'],
  ['/v1/notify', 'user_app'],
  ['/v1/reviews', 'user_app'],
  ['/v1/warranties', 'user_app'],
  ['/v1/disputes', 'user_app'],
  ['/v1/provider/', 'provider_b2b_app'],
  ['/v1/dispatch/candidates', 'provider_b2b_app'],
  ['/v1/jobs', 'provider_b2b_app'],
  ['/v1/b2b', 'provider_b2b_app'],
  ['/v1/payouts', 'provider_b2b_app'],
  ['/v1/dispatch/assign', 'admin_console'],
  ['/v1/admin', 'admin_console'],
  ['/webhooks', 'admin_console'],
];
export function surfaceFor(path: string): ClientSurface {
  for (const [prefix, s] of ROUTE_SURFACE) if (path.startsWith(prefix)) return s;
  return 'user_app';
}
