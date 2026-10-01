import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { commerceStore } from '../lib/commerceStore.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { paymentWebhookSignature } from '../lib/paymentProviders.js';
import { socialStore } from '../lib/socialStore.js';

function cookie(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.join('; ') : value ?? '';
}

async function register(name: string) {
  const email = `${name.toLowerCase()}@example.com`;
  const registered = await request(app).post('/api/auth/register').send({ name, email, password: 'Password123', communityRulesAccepted: true });
  expect(registered.status).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'Password123' });
  return { user: registered.body.user, auth: cookie(login) };
}

async function createIntent(auth: string, purpose: string, targetId: string, key = `intent-key-${targetId}`) {
  return request(app).post('/api/payments/intents').set('Cookie', auth).set('Idempotency-Key', key).send({ purpose, targetId });
}

async function sendWebhook(reference: string, status: 'SUCCESS' | 'FAILED' | 'REFUNDED' | 'DISPUTED', eventId: string, providerReference?: string) {
  const payload = { eventId, reference, status, ...(providerReference ? { providerReference } : {}) };
  return request(app).post('/api/payments/webhooks/manual').set('x-payment-signature', paymentWebhookSignature('manual', payload)).send(payload);
}

describe('command 2b-2 payment and finance security', () => {
  beforeEach(() => { fallbackStore.clear(); socialStore.clear(); commerceStore.clear(); });

  it('denies ordinary users and moderators access to admin finance', async () => {
    const user = await register('FinanceUser');
    const moderator = await register('FinanceModerator');
    const suspendedAdmin = await register('SuspendedFinanceAdmin');
    fallbackStore.updateUser(moderator.user.id, { role: 'MODERATOR' });
    fallbackStore.updateUser(suspendedAdmin.user.id, { role: 'ADMIN', status: 'SUSPENDED' });
    expect((await request(app).get('/api/admin/finance/dashboard').set('Cookie', user.auth)).status).toBe(403);
    expect((await request(app).get('/api/admin/finance/dashboard').set('Cookie', moderator.auth)).status).toBe(403);
    expect((await request(app).get('/api/admin/finance/dashboard').set('Cookie', suspendedAdmin.auth)).status).toBe(403);
  });

  it('does not allow a user to change their own financial role', async () => {
    const user = await register('NoRoleEscalation');
    await request(app).put('/api/creators/me/profile').set('Cookie', user.auth).send({ subscriptionPriceCents: 900, role: 'ADMIN' });
    expect(fallbackStore.findById(user.user.id)?.role).toBe('USER');
    expect((await request(app).get('/api/admin/finance/dashboard').set('Cookie', user.auth)).status).toBe(403);
  });

  it('rejects client-supplied success and prevents duplicate payment references', async () => {
    const creator = await register('IntentCreator');
    const subscriber = await register('IntentSubscriber');
    await request(app).put('/api/creators/me/profile').set('Cookie', creator.auth).send({ subscriptionPriceCents: 1200 });
    const forged = await request(app).post('/api/payments/intents').set('Cookie', subscriber.auth).set('Idempotency-Key', 'forged-status-key').send({ purpose: 'CREATOR_SUBSCRIPTION', targetId: creator.user.id, status: 'SUCCESS' });
    expect(forged.status).toBe(400);
    const forgedReference = await request(app).post('/api/payments/intents').set('Cookie', subscriber.auth).set('Idempotency-Key', 'forged-reference-key').send({ purpose: 'CREATOR_SUBSCRIPTION', targetId: creator.user.id, reference: 'chosen-reference' });
    expect(forgedReference.status).toBe(400);
    const first = await createIntent(subscriber.auth, 'CREATOR_SUBSCRIPTION', creator.user.id, 'same-payment-key');
    const retry = await createIntent(subscriber.auth, 'CREATOR_SUBSCRIPTION', creator.user.id, 'same-payment-key');
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(first.body.paymentIntent.reference).toBe(retry.body.paymentIntent.reference);
    expect(commerceStore.state.paymentIntents).toHaveLength(1);
    expect(first.body.paymentIntent.status).toBe('PENDING');
  });

  it('requires a signed webhook and applies duplicate creator payment events once', async () => {
    const creator = await register('PaidCreator');
    const subscriber = await register('PaidSubscriber');
    await request(app).put('/api/creators/me/profile').set('Cookie', creator.auth).send({ subscriptionPriceCents: 1200 });
    const intentResponse = await createIntent(subscriber.auth, 'CREATOR_SUBSCRIPTION', creator.user.id);
    const reference = intentResponse.body.paymentIntent.reference as string;
    const payload = { eventId: 'bad-signature', reference, status: 'SUCCESS' as const };
    expect((await request(app).post('/api/payments/webhooks/manual').send(payload)).status).toBe(401);
    const first = await sendWebhook(reference, 'SUCCESS', 'creator-charge-event', 'provider-charge-1');
    const retry = await sendWebhook(reference, 'SUCCESS', 'creator-charge-event', 'provider-charge-1');
    const secondEvent = await sendWebhook(reference, 'SUCCESS', 'creator-charge-event-2', 'provider-charge-1');
    const collidingEvent = await sendWebhook(reference, 'FAILED', 'creator-charge-event', 'provider-charge-1');
    expect(first.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);
    expect(secondEvent.body.duplicate).toBe(false);
    expect(collidingEvent.status).toBe(409);
    expect((await request(app).get('/api/creators/me/earnings').set('Cookie', creator.auth)).body.balanceCents).toBe(1080);
    expect(commerceStore.state.financialLedger.filter((entry) => entry.ownerId === creator.user.id)).toHaveLength(1);
    expect(commerceStore.state.financialLedger.filter((entry) => entry.ownerId === 'platform')).toHaveLength(1);
  });

  it('protects payment status from IDOR and leaves failed marketplace orders unpaid', async () => {
    const seller = await register('FinanceSeller');
    const buyer = await register('FinanceBuyer');
    const outsider = await register('FinanceOutsider');
    await request(app).put('/api/sellers/me/profile').set('Cookie', seller.auth).send({ displayName: 'Finance Shop' });
    const product = await request(app).post('/api/marketplace/products').set('Cookie', seller.auth).send({ title: 'Finance Item', description: 'Item', category: 'Goods', priceCents: 1000, stock: 2, status: 'ACTIVE' });
    const order = await request(app).post('/api/marketplace/orders').set('Cookie', buyer.auth).send({ items: [{ productId: product.body.product.id, quantity: 1 }] });
    const intent = await createIntent(buyer.auth, 'MARKETPLACE_ORDER', order.body.order.id);
    expect(intent.status).toBe(201);
    expect((await request(app).get(`/api/payments/${intent.body.paymentIntent.reference}`).set('Cookie', outsider.auth)).status).toBe(404);
    expect((await sendWebhook(intent.body.paymentIntent.reference, 'FAILED', 'failed-order-event')).status).toBe(200);
    expect(commerceStore.state.orders[0].paymentStatus).toBe('FAILED');
    expect(commerceStore.state.financialLedger).toHaveLength(0);
    expect((await request(app).patch(`/api/marketplace/orders/${order.body.order.id}/status`).set('Cookie', buyer.auth).send({ status: 'PAID' })).status).toBe(400);
  });

  it('credits seller net and platform fee only after successful marketplace settlement', async () => {
    const seller = await register('NetSeller');
    const buyer = await register('NetBuyer');
    await request(app).put('/api/sellers/me/profile').set('Cookie', seller.auth).send({ displayName: 'Net Shop' });
    const product = await request(app).post('/api/marketplace/products').set('Cookie', seller.auth).send({ title: 'Net Item', description: 'Item', category: 'Goods', priceCents: 1001, stock: 1, status: 'ACTIVE' });
    const order = await request(app).post('/api/marketplace/orders').set('Cookie', buyer.auth).send({ items: [{ productId: product.body.product.id, quantity: 1 }] });
    const intent = await createIntent(buyer.auth, 'MARKETPLACE_ORDER', order.body.order.id);
    await sendWebhook(intent.body.paymentIntent.reference, 'SUCCESS', 'seller-sale-event');
    expect(commerceStore.state.orders[0].paymentStatus).toBe('PAID');
    expect(commerceStore.state.financialLedger.find((entry) => entry.ownerId === seller.user.id)?.amountCents).toBe(901);
    expect(commerceStore.state.financialLedger.find((entry) => entry.ownerId === 'platform')?.amountCents).toBe(100);
    expect((await request(app).get('/api/marketplace/seller/transactions').set('Cookie', seller.auth)).body.transactions).toHaveLength(1);
  });

  it('limits refund requests to the payer, prevents duplicates, and reserves review for admins', async () => {
    const creator = await register('RefundCreator');
    const payer = await register('RefundPayer');
    const outsider = await register('RefundOutsider');
    const admin = await register('RefundAdmin');
    fallbackStore.updateUser(admin.user.id, { role: 'ADMIN' });
    await request(app).put('/api/creators/me/profile').set('Cookie', creator.auth).send({ subscriptionPriceCents: 600 });
    const intent = await createIntent(payer.auth, 'CREATOR_SUBSCRIPTION', creator.user.id);
    const reference = intent.body.paymentIntent.reference as string;
    await sendWebhook(reference, 'SUCCESS', 'refund-source-event');
    expect((await request(app).post(`/api/payments/${reference}/refunds`).set('Cookie', outsider.auth).send({ reason: 'Please refund this charge.' })).status).toBe(404);
    const refund = await request(app).post(`/api/payments/${reference}/refunds`).set('Cookie', payer.auth).send({ reason: 'Please refund this charge.' });
    expect(refund.status).toBe(201);
    expect((await request(app).post(`/api/payments/${reference}/refunds`).set('Cookie', payer.auth).send({ reason: 'Duplicate refund request.' })).status).toBe(409);
    expect((await request(app).patch(`/api/admin/finance/refunds/${refund.body.refund.id}`).set('Cookie', outsider.auth).send({ status: 'APPROVED', reason: 'Reviewed by staff.' })).status).toBe(403);
    expect((await request(app).patch(`/api/admin/finance/refunds/${refund.body.refund.id}`).set('Cookie', admin.auth).send({ status: 'APPROVED', reason: 'Reviewed by staff.' })).status).toBe(200);
    expect((await sendWebhook(reference, 'REFUNDED', 'refund-provider-event')).status).toBe(200);
    expect((await sendWebhook(reference, 'REFUNDED', 'refund-provider-event')).body.duplicate).toBe(true);
    expect(commerceStore.state.paymentIntents.find((entry) => entry.reference === reference)?.status).toBe('REFUNDED');
    expect((await request(app).get('/api/creators/me/earnings').set('Cookie', creator.auth)).body.balanceCents).toBe(0);
    expect(commerceStore.state.financialLedger.filter((entry) => entry.type === 'REFUND')).toHaveLength(3);
  });

  it('keeps business payment amount server-calculated and restricts transaction visibility', async () => {
    const owner = await register('BusinessFinanceOwner');
    const outsider = await register('BusinessFinanceOutsider');
    const created = await request(app).post('/api/businesses').set('Cookie', owner.auth).send({ name: 'Ledger House', category: 'Retail' });
    const intent = await createIntent(owner.auth, 'BUSINESS_VERIFICATION', created.body.business.id);
    expect(intent.body.paymentIntent.amountCents).toBe(2500);
    expect((await request(app).get(`/api/businesses/${created.body.business.id}/transactions`).set('Cookie', owner.auth)).body.transactions).toHaveLength(1);
    expect((await request(app).get(`/api/businesses/${created.body.business.id}/transactions`).set('Cookie', outsider.auth)).status).toBe(404);
    expect((await createIntent(outsider.auth, 'BUSINESS_VERIFICATION', created.body.business.id)).status).toBe(404);
    expect((await request(app).post('/api/payments/intents').set('Cookie', owner.auth).set('Idempotency-Key', 'business-amount-key').send({ purpose: 'BUSINESS_VERIFICATION', targetId: created.body.business.id, amountCents: 1 })).status).toBe(400);
  });

  it('allows only administrators to view finance monitoring and audit successful access', async () => {
    const admin = await register('AuthorizedFinanceAdmin');
    fallbackStore.updateUser(admin.user.id, { role: 'ADMIN' });
    const response = await request(app).get('/api/admin/finance/dashboard').set('Cookie', admin.auth);
    expect(response.status).toBe(200);
    expect(response.body.summary).toMatchObject({ grossRevenueCents: 0, platformFeesCents: 0 });
  });

  it('settles legacy platform subscriptions only from provider events', async () => {
    const subscriber = await register('PlatformSubscriber');
    socialStore.state.subscriptionPlans.push({ id: 'plan_monthly', slug: 'monthly', name: 'Monthly', priceCents: 700, currency: 'USD', interval: 'month', description: null, isActive: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const invalid = await request(app).post('/api/subscriptions').set('Cookie', subscriber.auth).set('Idempotency-Key', 'platform-monthly-key').send({ planId: 'plan_monthly', provider: 'paid' });
    expect(invalid.status).toBe(400);
    const checkout = await request(app).post('/api/subscriptions').set('Cookie', subscriber.auth).set('Idempotency-Key', 'platform-monthly-key').send({ planId: 'plan_monthly' });
    expect(checkout.status).toBe(201);
    expect(checkout.body.subscription.status).toBe('PENDING');
    expect(checkout.body.payment.status).toBe('PENDING');
    const event = { eventId: 'platform-plan-paid', reference: checkout.body.paymentIntent.reference, status: 'SUCCESS' as const };
    await request(app).post('/api/payments/webhooks/manual').set('x-payment-signature', paymentWebhookSignature('manual', event)).send(event);
    expect(socialStore.state.subscriptions[0].status).toBe('ACTIVE');
    expect(socialStore.state.payments[0].status).toBe('PAID');
  });
});
