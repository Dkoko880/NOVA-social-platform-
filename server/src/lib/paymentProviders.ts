import { createHmac, timingSafeEqual } from 'node:crypto';

export type PaymentStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'REFUNDED' | 'DISPUTED';

export type PaymentIntentRequest = {
  reference: string;
  amountCents: number;
  currency: string;
  payerId: string;
};

export type PaymentWebhookPayload = {
  eventId: string;
  reference: string;
  status: PaymentStatus;
  providerReference?: string;
};

export interface PaymentProvider {
  readonly name: string;
  createIntent(request: PaymentIntentRequest): Promise<{ providerReference: string }>;
}

export interface PaymentWebhookVerifier {
  verify(provider: string, payload: PaymentWebhookPayload, signature: string): boolean;
}

const developmentSecret = 'nova-development-payment-webhook-secret';

function webhookSecret() {
  if (process.env.NODE_ENV === 'production') return process.env.PAYMENT_WEBHOOK_SECRET ?? '';
  return process.env.PAYMENT_WEBHOOK_SECRET ?? developmentSecret;
}

export function paymentWebhookSignature(provider: string, payload: PaymentWebhookPayload, secret = webhookSecret()) {
  const body = [provider, payload.eventId, payload.reference, payload.status, payload.providerReference ?? ''].join(':');
  return createHmac('sha256', secret).update(body).digest('hex');
}

export const manualPaymentProvider: PaymentProvider = {
  name: 'manual',
  async createIntent(request) {
    return { providerReference: `manual_${request.reference}` };
  },
};

export const hmacPaymentWebhookVerifier: PaymentWebhookVerifier = {
  verify(provider, payload, signature) {
    const secret = webhookSecret();
    if (!secret || !/^[a-f0-9]{64}$/i.test(signature)) return false;
    const expected = Buffer.from(paymentWebhookSignature(provider, payload, secret), 'hex');
    const received = Buffer.from(signature, 'hex');
    return expected.length === received.length && timingSafeEqual(expected, received);
  },
};
