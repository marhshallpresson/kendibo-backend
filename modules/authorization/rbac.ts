// Authorization — permission-based, never `if (role === 'admin')`.
export const PERMISSIONS = [
  'booking:create', 'booking:view:self', 'booking:view:any', 'booking:cancel', 'booking:override',
  'provider:verify', 'provider:suspend', 'payment:view', 'payment:refund',
  'ledger:view', 'payout:approve', 'pricing:publish', 'configuration:edit', 'audit:view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMS: Record<string, Permission[]> = {
  CUSTOMER: ['booking:create', 'booking:view:self', 'booking:cancel'],
  PROVIDER: ['booking:view:self'],
  DISPATCHER: ['booking:view:any', 'booking:override'],
  OPERATIONS: ['booking:view:any', 'booking:override', 'provider:verify'],
  CUSTOMER_SUPPORT: ['booking:view:any', 'payment:view'],
  FINANCE: ['payment:view', 'payment:refund', 'ledger:view', 'payout:approve'],
  TRUST_SAFETY: ['provider:verify', 'provider:suspend', 'audit:view'],
  SUPER_ADMIN: [...PERMISSIONS],
};
export function authorize(role: string, permission: Permission): boolean {
  return (ROLE_PERMS[String(role).toUpperCase()] ?? []).includes(permission);
}

// Roles that may hold a console seat. OTP signup never assigns these (it only
// ever yields CUSTOMER/PROVIDER) — they are granted out-of-band via the
// ADMIN_BOOTSTRAP allowlist or the /v1/admin/roles endpoint.
export const ADMIN_ROLES = [
  'SUPER_ADMIN', 'OPERATIONS', 'DISPATCHER', 'CUSTOMER_SUPPORT', 'FINANCE', 'TRUST_SAFETY',
] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export const ADMIN_PERMISSIONS: Permission[] = [...PERMISSIONS];

/**
 * True when a role may sign in to the admin console. SUPER_ADMIN passes for
 * every permission (it holds them all); every other admin role is checked
 * against the permission matrix. Case-insensitive because identity rows store
 * the role however the granting path wrote it.
 */
export function isAdminRole(role: string | null | undefined): role is AdminRole {
  return !!role && (ADMIN_ROLES as readonly string[]).includes(String(role).toUpperCase());
}

export function adminCan(role: string | null | undefined, permission: Permission): boolean {
  if (!isAdminRole(role)) return false;
  return authorize(role, permission);
}

export const rolePerms = (role: string): readonly Permission[] =>
  ROLE_PERMS[String(role).toUpperCase()] ?? [];
