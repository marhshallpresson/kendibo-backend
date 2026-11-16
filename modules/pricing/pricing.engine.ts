// Pricing engine — PRD §21-22. Server-authoritative, integer kobo, versioned rules
// frozen into booking snapshot. Formula (config-driven):
// base + units + addOns + labour + materials + inspection + callout + distance + urgency +
// weekend + platformFee + tip + warrantyAdj + tax − discount − promo = customerTotal.
// Provider payout computed alongside: total − platformFee − taxHold − provision.
import { catalogService } from '../catalog/catalog.service.js';
import { pricingConfig } from './pricing.config.js';

export interface PriceInput {
  serviceId: string; addOnIds?: string[]; quantity?: number;
  labourKobo?: bigint; materialsKobo?: bigint; inspectionKobo?: bigint; calloutKobo?: bigint;
  distanceKm?: number; urgent?: boolean; weekend?: boolean; holiday?: boolean;
  tipKobo?: bigint; warrantyAdjKobo?: bigint; discountKobo?: bigint; promoKobo?: bigint;
}
export interface PriceBreakdown {
  baseKobo: bigint; addOnsKobo: bigint; labourKobo: bigint; materialsKobo: bigint;
  inspectionKobo: bigint; calloutKobo: bigint; distanceKobo: bigint; urgencyKobo: bigint;
  weekendKobo: bigint; platformFeeKobo: bigint; tipKobo: bigint; warrantyAdjKobo: bigint;
  discountKobo: bigint; vatKobo: bigint; totalKobo: bigint;
  providerPayoutKobo: bigint; ruleVersion: string; snapshot: object;
}
/** Fallback version label; the live one comes from the latest catalog.pricebook row. */
export const RULE_VERSION = 'pricebook_2026-10-06';

export async function price(input: PriceInput): Promise<PriceBreakdown> {
  const svc = await catalogService.get(input.serviceId);
  if (!svc) throw new Error('SERVICE_NOT_FOUND');
  if (svc.bookingMode === 'quote') throw new Error('QUOTE_REQUIRED');
  // VAT, platform fee, per-km and surcharges: admin-editable (pricing.config.ts).
  const cfg = await pricingConfig();
  const ruleVersion = cfg.version;
  const qty = input.quantity ?? 1;
  const baseKobo = svc.baseKobo * BigInt(qty);
  const aoList = await catalogService.addOns(input.serviceId);
  const addOnsKobo = (input.addOnIds ?? []).reduce((s, id) => {
    const ao = aoList.find((a) => a.id === id);
    return s + (ao ? ao.priceKobo : 0n);
  }, 0n);
  const labourKobo = input.labourKobo ?? 0n;
  const materialsKobo = input.materialsKobo ?? 0n;
  const inspectionKobo = input.inspectionKobo ?? 0n;
  const calloutKobo = input.calloutKobo ?? 0n;
  const distanceKobo = BigInt(Math.round((input.distanceKm ?? 0) * cfg.perKmKobo));
  const urgencyKobo = input.urgent ? (baseKobo * BigInt(cfg.urgencyBps)) / 10000n : 0n;
  const weekendKobo = input.weekend || input.holiday ? (baseKobo * BigInt(cfg.weekendBps)) / 10000n : 0n;
  const platformFeeKobo = ((baseKobo + addOnsKobo + labourKobo) * BigInt(cfg.platformFeeBps)) / 10000n;
  const tipKobo = input.tipKobo ?? 0n; // 100% to provider, outside commission
  const warrantyAdjKobo = input.warrantyAdjKobo ?? 0n;
  const discountKobo = (input.discountKobo ?? 0n) + (input.promoKobo ?? 0n);
  const preVat = baseKobo + addOnsKobo + labourKobo + materialsKobo + inspectionKobo
    + calloutKobo + distanceKobo + urgencyKobo + weekendKobo + platformFeeKobo
    + tipKobo + warrantyAdjKobo - discountKobo;
  const vatKobo = (preVat * BigInt(cfg.vatBps)) / 10000n;
  const totalKobo = preVat + vatKobo;
  if (totalKobo <= 0n) throw new Error('AMOUNT_MUST_BE_POSITIVE');
  // PRD App G economics: provider gets total − platformFee − vat − provisions; tip passes through.
  const providerPayoutKobo = totalKobo - platformFeeKobo - vatKobo;
  return {
    baseKobo, addOnsKobo, labourKobo, materialsKobo, inspectionKobo, calloutKobo,
    distanceKobo, urgencyKobo, weekendKobo, platformFeeKobo, tipKobo, warrantyAdjKobo,
    discountKobo, vatKobo, totalKobo, providerPayoutKobo, ruleVersion,
    snapshot: { ...input, labourKobo: String(labourKobo), materialsKobo: String(materialsKobo), tipKobo: String(tipKobo), discountKobo: String(discountKobo), ruleVersion },
  };
}
