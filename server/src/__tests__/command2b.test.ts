import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { commerceStore } from '../lib/commerceStore.js';
import { fallbackStore } from '../lib/fallbackStore.js';
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

describe('command 2b creator, business, and marketplace authorization', () => {
  beforeEach(() => { fallbackStore.clear(); socialStore.clear(); commerceStore.clear(); });

  it('isolates creator subscribers and earnings and restricts payout review', async () => {
    const creator = await register('Creator');
    const subscriber = await register('Subscriber');
    await request(app).put('/api/creators/me/profile').set('Cookie', creator.auth).send({ subscriptionPriceCents: 1200 });
    expect((await request(app).post(`/api/creators/${creator.user.id}/subscribe`).set('Cookie', subscriber.auth)).status).toBe(201);
    expect((await request(app).get('/api/creators/me/subscribers').set('Cookie', creator.auth)).body.subscriptions).toHaveLength(1);
    expect((await request(app).get('/api/creators/me/subscribers').set('Cookie', subscriber.auth)).body.subscriptions).toHaveLength(0);
    expect((await request(app).get(`/api/creators/${creator.user.id}/profile`)).status).toBe(200);
    expect((await request(app).get('/api/creators/me/earnings').set('Cookie', creator.auth)).body.balanceCents).toBe(1200);
    expect((await request(app).get('/api/creators/me/earnings').set('Cookie', subscriber.auth)).body.balanceCents).toBe(0);
    const payout = await request(app).post('/api/creators/me/payouts').set('Cookie', creator.auth).send({ amountCents: 500 });
    expect(payout.status).toBe(201);
    expect((await request(app).get('/api/admin/creator-payouts').set('Cookie', subscriber.auth)).status).toBe(403);
    const admin = await register('FinanceAdmin');
    fallbackStore.updateUser(admin.user.id, { role: 'ADMIN' });
    expect((await request(app).patch(`/api/admin/creator-payouts/${payout.body.payout.id}`).set('Cookie', admin.auth).send({ status: 'FAILED' })).status).toBe(200);
    expect((await request(app).get('/api/creators/me/earnings').set('Cookie', creator.auth)).body.balanceCents).toBe(1200);
    expect((await request(app).put(`/api/creators/${creator.user.id}/profile`).set('Cookie', subscriber.auth).send({ headline: 'Unauthorized' })).status).toBe(404);
  });

  it('enforces business ownership and rejects role escalation', async () => {
    const owner = await register('Owner');
    const member = await register('Member');
    const outsider = await register('Outsider');
    const created = await request(app).post('/api/businesses').set('Cookie', owner.auth).send({ name: 'North Market', category: 'Retail' });
    expect(created.status).toBe(201);
    const businessId = created.body.business.id;
    expect((await request(app).get(`/api/businesses/${businessId}/dashboard`).set('Cookie', outsider.auth)).status).toBe(404);
    expect((await request(app).put(`/api/businesses/${businessId}/team/${member.user.id}`).set('Cookie', owner.auth).send({ role: 'OWNER' })).status).toBe(400);
    expect((await request(app).put(`/api/businesses/${businessId}/team/${member.user.id}`).set('Cookie', owner.auth).send({ role: 'ANALYST' })).status).toBe(200);
    expect((await request(app).get(`/api/businesses/${businessId}/dashboard`).set('Cookie', member.auth)).status).toBe(200);
    expect((await request(app).put(`/api/businesses/${businessId}/team/${outsider.user.id}`).set('Cookie', member.auth).send({ role: 'ADMIN' })).status).toBe(404);
    expect(fallbackStore.listAdminActions().some((entry) => entry.actionType === 'BUSINESS_TEAM_ROLE_UPDATED')).toBe(true);
  });

  it('scopes marketplace product and order writes to their owner', async () => {
    const seller = await register('Seller');
    const otherSeller = await register('OtherSeller');
    const buyer = await register('Buyer');
    await request(app).put('/api/sellers/me/profile').set('Cookie', seller.auth).send({ displayName: 'Shop' });
    await request(app).put('/api/sellers/me/profile').set('Cookie', otherSeller.auth).send({ displayName: 'Other Shop' });
    const product = await request(app).post('/api/marketplace/products').set('Cookie', seller.auth).send({ title: 'Notebook', description: 'Hard cover', category: 'Stationery', priceCents: 800, stock: 2, status: 'ACTIVE', images: [{ url: 'https://example.com/item.jpg' }] });
    expect(product.status).toBe(201);
    expect((await request(app).patch(`/api/marketplace/products/${product.body.product.id}`).set('Cookie', otherSeller.auth).send({ priceCents: 1 })).status).toBe(404);
    const order = await request(app).post('/api/marketplace/orders').set('Cookie', buyer.auth).send({ items: [{ productId: product.body.product.id, quantity: 1 }] });
    expect(order.status).toBe(201);
    const orderId = order.body.order.id;
    expect((await request(app).patch(`/api/marketplace/orders/${orderId}/status`).set('Cookie', buyer.auth).send({ status: 'DELIVERED' })).status).toBe(404);
    expect((await request(app).patch(`/api/marketplace/orders/${orderId}/status`).set('Cookie', otherSeller.auth).send({ status: 'CONFIRMED' })).status).toBe(404);
    expect((await request(app).patch(`/api/marketplace/orders/${orderId}/status`).set('Cookie', seller.auth).send({ status: 'CONFIRMED' })).status).toBe(200);
    expect((await request(app).get('/api/marketplace/orders/me').set('Cookie', buyer.auth)).body.orders).toHaveLength(1);
    expect((await request(app).post(`/api/marketplace/orders/${orderId}/disputes`).set('Cookie', buyer.auth).send({ reason: 'Item arrived damaged.' })).status).toBe(201);

    const cancellableProduct = await request(app).post('/api/marketplace/products').set('Cookie', seller.auth).send({ title: 'Pencil', description: 'HB pencil', category: 'Stationery', priceCents: 100, stock: 1, status: 'ACTIVE' });
    const cancellableOrder = await request(app).post('/api/marketplace/orders').set('Cookie', buyer.auth).send({ items: [{ productId: cancellableProduct.body.product.id, quantity: 1 }] });
    expect((await request(app).post(`/api/marketplace/orders/${cancellableOrder.body.order.id}/cancel`).set('Cookie', otherSeller.auth)).status).toBe(404);
    const cancelled = await request(app).post(`/api/marketplace/orders/${cancellableOrder.body.order.id}/cancel`).set('Cookie', buyer.auth);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.order.status).toBe('CANCELLED');
    const restocked = await request(app).get('/api/marketplace/products').query({ q: 'Pencil' });
    expect(restocked.body.products[0].stock).toBe(1);
  });

  it('denies ordinary users admin finance and protects blocked or suspended marketplace actions', async () => {
    const buyer = await register('Buyer');
    const seller = await register('Seller');
    expect((await request(app).get('/api/admin/earnings').set('Cookie', buyer.auth)).status).toBe(403);
    await request(app).put('/api/sellers/me/profile').set('Cookie', seller.auth).send({ displayName: 'Shop' });
    const product = await request(app).post('/api/marketplace/products').set('Cookie', seller.auth).send({ title: 'Pen', description: 'Blue ink', category: 'Stationery', priceCents: 200, stock: 1, status: 'ACTIVE' });
    await request(app).post(`/api/users/${seller.user.id}/block`).set('Cookie', buyer.auth);
    expect((await request(app).post('/api/marketplace/orders').set('Cookie', buyer.auth).send({ items: [{ productId: product.body.product.id, quantity: 1 }] })).status).toBe(403);
    fallbackStore.updateUser(buyer.user.id, { status: 'SUSPENDED' });
    expect((await request(app).post('/api/marketplace/products/missing/inquiries').set('Cookie', buyer.auth).send({ message: 'Question' })).status).toBe(403);
  });
});
