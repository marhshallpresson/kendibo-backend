/**
 * AI-Assisted CTA Campaigns & Customer Retainer Infrastructure Engine
 * Generates channel-native copy, conversion-optimized CTAs, deep-links,
 * WhatsApp conversational templates, Push payloads, and RCS Rich Cards + Suggestion Chips.
 *
 * Uses Gemini (GEMINI_API_KEY + GEMINI_MODEL, default gemini-3.8-flash) when configured,
 * with a deterministic Nigerian home-services copy & CTA synthesizer fallback.
 */
import { type SlingRcsStandaloneCard, type SlingRcsSuggestion } from './sling.client';

export type AiCtaCampaignGoal =
  | 'retainer_maintenance'
  | 'winback_inactive'
  | 'quote_followup'
  | 'seasonal_promo'
  | 'warranty_renewal'
  | 'loyalty_cashback'
  | 'operational_alert';

export interface AiCtaGenerateInput {
  goal: AiCtaCampaignGoal;
  customerName?: string;
  city?: string;
  serviceName?: string;
  discountPct?: number;
  cashbackNaira?: number;
  lastServiceDaysAgo?: number;
  customPrompt?: string;
  deepLinkRoute?: string;
  ctaUrl?: string;
}

export interface AiCtaGeneratedVariant {
  goal: AiCtaCampaignGoal;
  aiModel: string;
  aiGenerated: boolean;
  headline: string;
  ctaLabel: string;
  ctaUrl: string;
  deepLinkRoute: string;
  smsBody: string;
  whatsappBody: string;
  pushTitle: string;
  pushBody: string;
  emailSubject: string;
  rcsCard: SlingRcsStandaloneCard;
  rcsSuggestions: SlingRcsSuggestion[];
}

export class AiCtaRetainerService {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.apiKey = (opts?.apiKey ?? process.env.GEMINI_API_KEY ?? '').trim();
    this.model = (opts?.model ?? process.env.GEMINI_MODEL ?? 'gemini-3.8-flash').trim();
  }

  public isLiveAiConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  public async generateOmnichannelCta(input: AiCtaGenerateInput): Promise<AiCtaGeneratedVariant> {
    const base = this.buildDeterministicVariant(input);
    if (!this.isLiveAiConfigured()) {
      return base;
    }

    try {
      const prompt = [
        'You are the Kendibo AI Growth & Retention Copywriter for Nigeria’s premier verified home cleaning & maintenance marketplace.',
        `Goal: ${input.goal}`,
        `Customer Name: ${input.customerName || 'Valued Homeowner'}`,
        `City: ${input.city || 'Lagos'}`,
        `Service: ${input.serviceName || 'Home Deep Cleaning & AC Maintenance'}`,
        input.discountPct ? `Discount: ${input.discountPct}% OFF` : '',
        input.cashbackNaira ? `Cashback: ₦${input.cashbackNaira.toLocaleString()} wallet credit` : '',
        input.lastServiceDaysAgo ? `Days since last booking: ${input.lastServiceDaysAgo}` : '',
        input.customPrompt ? `Additional Context: ${input.customPrompt}` : '',
        'Return strict JSON with keys: headline, ctaLabel, smsBody (<=155 chars), whatsappBody, pushTitle (<=48 chars), pushBody (<=110 chars), emailSubject.',
      ]
        .filter(Boolean)
        .join('\n');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
          {
            method: 'POST',
            signal: controller.signal,
            // Key in a header, not the query string, so it never lands in proxy/access logs.
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0.4,
              },
            }),
          },
        );
        if (res.ok) {
          const data = (await res.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawText) {
            const parsed = JSON.parse(rawText) as Partial<AiCtaGeneratedVariant>;
            return {
              ...base,
              aiModel: this.model,
              aiGenerated: true,
              headline: parsed.headline || base.headline,
              ctaLabel: parsed.ctaLabel || base.ctaLabel,
              smsBody: (parsed.smsBody || base.smsBody).slice(0, 160),
              whatsappBody: parsed.whatsappBody || base.whatsappBody,
              pushTitle: parsed.pushTitle || base.pushTitle,
              pushBody: parsed.pushBody || base.pushBody,
              emailSubject: parsed.emailSubject || base.emailSubject,
              rcsCard: {
                ...base.rcsCard,
                title: parsed.headline || base.rcsCard.title,
                description: parsed.pushBody || base.rcsCard.description,
              },
            };
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // Fallback cleanly to deterministic Nigerian home-service copy
    }

    return base;
  }

  private buildDeterministicVariant(input: AiCtaGenerateInput): AiCtaGeneratedVariant {
    const firstName = (input.customerName || 'there').split(' ')[0] || 'there';
    const city = input.city || 'Lagos';
    const service = input.serviceName || 'Preventive Home & AC Maintenance';
    const discountTag = input.discountPct
      ? `${input.discountPct}% OFF`
      : input.cashbackNaira
        ? `₦${input.cashbackNaira.toLocaleString()} Cashback`
        : 'Priority Slot';
    const deepLinkRoute = input.deepLinkRoute || '/(tabs)/bookings';
    const ctaUrl = input.ctaUrl || `https://kendibo.com/book?ref=ai_${input.goal}`;

    let headline = `Keep your ${city} home running smoothly`;
    let ctaLabel = 'Book 1-Tap Retainer Slot';
    let smsBody = `Kendibo: Hi ${firstName}, your ${service} checkup is due! Claim your ${discountTag} today: ${ctaUrl}`;
    let whatsappBody = `Hi *${firstName}* 👋,\n\nYour scheduled *${service}* retainer window in ${city} is open.\n\n✅ Verified & background-checked technician\n✅ 7-day workmanship warranty\n🎁 *${discountTag}* unlocked on your account\n\nTap below to confirm your preferred time slot:\n👉 ${ctaUrl}`;
    let pushTitle = `${service} Due (${discountTag})`;
    let pushBody = `Hi ${firstName}, confirm your verified Kendibo pro in 1 tap with ${discountTag}.`;
    let emailSubject = `${firstName}, your ${service} retainer slot (${discountTag}) is ready`;

    switch (input.goal) {
      case 'winback_inactive': {
        const days = input.lastServiceDaysAgo ?? 30;
        headline = `We miss you, ${firstName}! Enjoy ${discountTag} on your next home service`;
        ctaLabel = `Claim ${discountTag} Now`;
        smsBody = `Kendibo: Hi ${firstName}, it's been ${days} days! Book ${service} this week & get ${discountTag}: ${ctaUrl}`;
        whatsappBody = `Hello *${firstName}* ✨,\n\nIt’s been ${days} days since your last Kendibo home service in ${city}. Keep your appliances and living space spotless with a verified pro!\n\n🎁 Special Win-Back Offer: *${discountTag}*\n👉 Book in 60 seconds: ${ctaUrl}`;
        pushTitle = `Unlock ${discountTag} on ${service}`;
        pushBody = `It's been ${days} days! Schedule a verified Kendibo technician today.`;
        emailSubject = `We reserved ${discountTag} for your next ${service} booking`;
        break;
      }
      case 'quote_followup': {
        headline = `Your verified inspection quote for ${service} is ready`;
        ctaLabel = 'Review & Approve Quote';
        smsBody = `Kendibo: Hi ${firstName}, your itemized quote for ${service} is ready. Approve in escrow to start work: ${ctaUrl}`;
        whatsappBody = `Hi *${firstName}* 🛠️,\n\nYour technician has submitted the transparent, itemized quote for *${service}*.\n\n🔒 Protected by Kendibo Escrow & 7-Day Warranty.\n👉 Review & approve now: ${ctaUrl}`;
        pushTitle = `Quote Ready: ${service}`;
        pushBody = `Review your itemized quote and approve in escrow to begin work.`;
        emailSubject = `Action Required: Approve your ${service} quote on Kendibo`;
        break;
      }
      case 'warranty_renewal': {
        headline = `Extend protection on your ${service}`;
        ctaLabel = 'Schedule Preventive Check';
        smsBody = `Kendibo: Hi ${firstName}, your ${service} warranty window is closing soon. Book a preventive tune-up: ${ctaUrl}`;
        whatsappBody = `Hi *${firstName}* 🛡️,\n\nYour warranty coverage on *${service}* is approaching renewal. A quick preventive tune-up prevents costly breakdowns.\n\n👉 Lock in your tune-up (${discountTag}): ${ctaUrl}`;
        pushTitle = `Warranty Tune-Up: ${service}`;
        pushBody = `Keep your ${service} covered with a preventive checkup (${discountTag}).`;
        emailSubject = `Protect your home: ${service} warranty & preventive checkup`;
        break;
      }
      case 'loyalty_cashback': {
        headline = `${discountTag} credited to your Kendibo Wallet`;
        ctaLabel = 'Use Wallet Cashback';
        smsBody = `Kendibo: Congrats ${firstName}! ${discountTag} is waiting in your wallet for ${service}. Redeem now: ${ctaUrl}`;
        whatsappBody = `🎉 *Wallet Reward Unlocked, ${firstName}!*\n\nYou have *${discountTag}* ready to apply toward *${service}* in ${city}.\n\n👉 Redeem before it expires: ${ctaUrl}`;
        pushTitle = `🎁 ${discountTag} Ready to Use`;
        pushBody = `Apply your reward toward ${service} in 1 tap.`;
        emailSubject = `You unlocked ${discountTag} on Kendibo!`;
        break;
      }
      case 'seasonal_promo': {
        headline = `${city} Home Care Promo: ${discountTag} on ${service}`;
        ctaLabel = `Book with ${discountTag}`;
        smsBody = `Kendibo: ${discountTag} on ${service} in ${city}! Verified pros, escrow protection. Book now: ${ctaUrl}`;
        whatsappBody = `🏡 *${city} Home Care Flash Offer!*\n\nHi *${firstName}*, get *${discountTag}* when you book *${service}* with a verified Kendibo pro.\n\n${input.customPrompt ? `📌 ${input.customPrompt}\n\n` : ''}👉 Reserve your slot: ${ctaUrl}`;
        pushTitle = `Flash Offer: ${discountTag} on ${service}`;
        pushBody = `Verified Kendibo pros available in ${city}. Tap to reserve your slot.`;
        emailSubject = `${discountTag} on ${service} — Limited slots in ${city}`;
        break;
      }
      case 'operational_alert': {
        headline = `Important Service Update for ${service}`;
        ctaLabel = 'View Live Status';
        smsBody = `Kendibo ALERT: Hi ${firstName}, ${input.customPrompt || `update on your ${service} booking`}. Track live: ${ctaUrl}`;
        whatsappBody = `🔔 *Kendibo Operational Update*\n\nHi *${firstName}*,\n${input.customPrompt || `There is a real-time status update on your ${service} booking.`}\n\n👉 Open live tracker: ${ctaUrl}`;
        pushTitle = `Service Update: ${service}`;
        pushBody = input.customPrompt || `Tap to view the latest status on your ${service} booking.`;
        emailSubject = `Kendibo Service Alert: ${service}`;
        break;
      }
      default:
        break;
    }

    const rcsCard: SlingRcsStandaloneCard = {
      title: headline.slice(0, 100),
      description: pushBody.slice(0, 180),
      image: 'https://kendibo.com/assets/rcs-home-care-banner.png',
      orientation: 'VERTICAL',
      alignment: 'LEFT',
    };

    const rcsSuggestions: SlingRcsSuggestion[] = [
      {
        type: 'open_url',
        text: ctaLabel.slice(0, 25),
        url: ctaUrl,
        postback_data: `cta:${input.goal}:open`,
      },
      {
        type: 'reply',
        text: 'Book Morning Slot',
        postback_data: `cta:${input.goal}:slot_morning`,
      },
      {
        type: 'dial',
        text: 'Call Kendibo Concierge',
        phone_number: '+2348005363426',
        postback_data: `cta:${input.goal}:call`,
      },
    ];

    return {
      goal: input.goal,
      aiModel: 'kendibo-deterministic-cta-v2',
      aiGenerated: false,
      headline,
      ctaLabel,
      ctaUrl,
      deepLinkRoute,
      smsBody: smsBody.slice(0, 160),
      whatsappBody,
      pushTitle,
      pushBody,
      emailSubject,
      rcsCard,
      rcsSuggestions,
    };
  }
}

export const aiCtaService = new AiCtaRetainerService();
