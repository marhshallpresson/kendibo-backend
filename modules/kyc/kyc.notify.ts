// Customer-facing KYC notification: tells the user they are verified so the
// app's "we're verifying your details" notice can go away. Best-effort only:
// a failed message never blocks an approval.
export async function notifyCustomerVerified(userId: string): Promise<void> {
  try {
    const { notificationService } = await import('../notifications/notification.service.js');
    await notificationService.sendOmnichannel({
      recipientId: userId, channels: ['inapp', 'push'], template: 'kyc.user.verified',
      vars: { title: "You're verified", body: 'Your identity has been verified. Thanks for helping keep Kendibo safe.' },
      msgType: 'transactional', route: '/(tabs)',
    });
  } catch (e) {
    console.warn(`[kyc] verified notice failed: ${(e as Error).message}`);
  }
}

/** Tells the customer an admin could not verify them, so they can fix their details. */
export async function notifyCustomerRejected(userId: string): Promise<void> {
  try {
    const { notificationService } = await import('../notifications/notification.service.js');
    await notificationService.sendOmnichannel({
      recipientId: userId, channels: ['inapp', 'push'], template: 'kyc.user.rejected',
      vars: { title: "We couldn't verify your details", body: 'Please check your name, date of birth and BVN/NIN in the app and try again.' },
      msgType: 'transactional', route: '/(tabs)/verify',
    });
  } catch (e) {
    console.warn(`[kyc] rejected notice failed: ${(e as Error).message}`);
  }
}
