// Fraud engine — signals -> actions (FLAG/REVIEW/HOLD_PAYOUT/REQUIRE_VERIFICATION/RESTRICT/SUSPEND).
import { q } from '../../packages/database/db.js';

export type FraudAction = 'FLAG' | 'REVIEW' | 'HOLD_PAYOUT' | 'REQUIRE_VERIFICATION' | 'RESTRICT' | 'SUSPEND';

export const fraudService = {
  async signalDevice(userId: string, deviceId: string): Promise<FraudAction | null> {
    const rows = await q<{ count: string }>(`SELECT COUNT(DISTINCT user_id) as count FROM identity.refresh_token WHERE device_id=$1`, [deviceId]);
    if (Number(rows[0]?.count) >= 3) return 'REVIEW'; // multiple accounts, same device
    return null;
  },
  async signalRefund(userId: string): Promise<FraudAction | null> {
    const rows = await q<{ count: string }>(`
      SELECT COUNT(*) as count 
      FROM payment.refund r 
      JOIN booking.booking b ON r.booking_id = b.id 
      WHERE b.user_id = $1 AND r.created_at > now() - interval '30 days'
    `, [userId]);
    if (Number(rows[0]?.count) >= 4) return 'HOLD_PAYOUT';
    return null;
  },
  async signalBankChange(): Promise<FraudAction> { 
    return 'REQUIRE_VERIFICATION'; 
  },
};
