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
  return (ROLE_PERMS[role] ?? []).includes(permission);
}
