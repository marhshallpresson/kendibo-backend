/**
 * Kendibo Backend Modular Monolith Barrel Index
 * Re-exports domain modules located in ../../modules
 */
export const Kendibo_MODULES_READY = true;
export { SlingClient, slingClient, normalizeNigerianPhone, detectNigerianCarrier } from '../../modules/notifications/sling.client.js';
export { AiCtaRetainerService, aiCtaService } from '../../modules/notifications/ai-cta.service.js';
export { SlingAutomationService, slingAutomationService } from '../../modules/notifications/automation.service.js';
export { NotificationService, notificationService, TEMPLATES } from '../../modules/notifications/notification.service.js';
