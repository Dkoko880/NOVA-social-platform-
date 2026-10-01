export type CreatorPaymentRequest = {
  creatorId: string;
  subscriberId: string;
  amountCents: number;
  currency: string;
};

export type CreatorPayoutRequest = {
  creatorId: string;
  amountCents: number;
  currency: string;
};

export interface CreatorPaymentProvider {
  readonly name: string;
  chargeSubscription(request: CreatorPaymentRequest): Promise<{ reference: string | null; status: 'PAID' | 'PENDING' }>;
}

export interface CreatorPayoutProvider {
  readonly name: string;
  requestPayout(request: CreatorPayoutRequest): Promise<{ reference: string | null; status: 'PENDING' }>;
}

export const manualCreatorPaymentProvider: CreatorPaymentProvider = {
  name: 'manual',
  async chargeSubscription() {
    return { reference: null, status: 'PAID' };
  },
};

export const manualCreatorPayoutProvider: CreatorPayoutProvider = {
  name: 'manual',
  async requestPayout() {
    return { reference: null, status: 'PENDING' };
  },
};