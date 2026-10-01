import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { commerceStore } from '../lib/commerceStore.js';
import { prisma, isDatabaseAvailable } from '../lib/prisma.js';
import { socialStore } from '../lib/socialStore.js';
import { requireAuth } from '../middleware/auth.js';
import { createPlatformSubscriptionIntent } from './payments.js';

const planSchema = z.object({
  slug: z.string().trim().min(2).max(64),
  name: z.string().trim().min(2).max(120),
  priceCents: z.number().int().min(0),
  currency: z.string().trim().length(3).optional(),
  interval: z.enum(['month', 'year']).optional(),
  description: z.string().trim().max(500).optional(),
  isActive: z.boolean().optional(),
});

const checkoutSchema = z.object({
  planId: z.string().min(1),
}).strict();

const subscriptionRouter = Router();

subscriptionRouter.get('/plans', async (_req, res) => {
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { priceCents: 'asc' },
    });

    return res.json({ plans });
  }

  return res.json({
    plans: socialStore.state.subscriptionPlans.filter((plan) => plan.isActive).map((plan) => ({
      ...plan,
    })),
  });
});

subscriptionRouter.post('/plans', requireAuth, async (req, res) => {
  const currentUser = req.user!;
  if (!['ADMIN', 'SUPER_ADMIN'].includes(currentUser.role)) {
    return res.status(403).json({ message: 'Only administrators can configure plans.' });
  }

  const payload = planSchema.parse(req.body ?? {});
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const plan = await prisma.subscriptionPlan.create({
      data: {
        slug: payload.slug,
        name: payload.name,
        priceCents: payload.priceCents,
        currency: payload.currency ?? 'USD',
        interval: payload.interval ?? 'month',
        description: payload.description ?? null,
        isActive: payload.isActive ?? true,
      },
    });

    return res.status(201).json({ plan });
  }

  const plan = {
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    slug: payload.slug,
    name: payload.name,
    priceCents: payload.priceCents,
    currency: payload.currency ?? 'USD',
    interval: payload.interval ?? 'month',
    description: payload.description ?? null,
    isActive: payload.isActive ?? true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  socialStore.state.subscriptionPlans.push(plan);
  return res.status(201).json({ plan });
});

subscriptionRouter.get('/subscriptions/me', requireAuth, async (req, res: Response) => {
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const subscriptions = await prisma.subscription.findMany({
      where: { userId },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ subscriptions });
  }

  return res.json({
    subscriptions: socialStore.state.subscriptions.filter((subscription) => subscription.userId === userId),
  });
});

subscriptionRouter.post('/subscriptions', requireAuth, async (req, res) => {
  const parsed = checkoutSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: 'Invalid subscription checkout request.' });
  const payload = parsed.data;
  const userId = req.user!.id;
  const idempotencyKey = z.string().trim().min(8).max(120).safeParse(req.header('Idempotency-Key'));
  if (!idempotencyKey.success) return res.status(400).json({ message: 'An Idempotency-Key header is required.' });
  try {
    const result = await createPlatformSubscriptionIntent(userId, payload.planId, idempotencyKey.data);
    return res.status(201).json({ subscription: result.subscription, paymentIntent: result.intent, payment: result.payment });
  } catch (error) {
    if (error instanceof Error && error.message === 'PLAN_NOT_FOUND') return res.status(404).json({ message: 'Subscription plan not found or inactive.' });
    if (error instanceof Error && error.message === 'SUBSCRIPTION_ACTIVE') return res.status(409).json({ message: 'You already have an active subscription for this plan.' });
    if (error instanceof Error && error.message === 'PAYMENT_PENDING') return res.status(409).json({ message: 'A payment is already pending for this subscription.' });
    if (error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT') return res.status(409).json({ message: 'Idempotency key was already used for a different payment.' });
    if (error instanceof Error && error.message === 'INVALID_AMOUNT') return res.status(409).json({ message: 'This plan must have a positive amount to require payment.' });
    throw error;
  }
});

subscriptionRouter.post('/subscriptions/:id/cancel', requireAuth, async (req: Request, res) => {
  const subscriptionId = String(req.params.id);
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const subscription = await prisma.subscription.findFirst({ where: { id: subscriptionId, userId } });
    if (!subscription) return res.status(404).json({ message: 'Subscription not found.' });
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.subscription.update({ where: { id: subscriptionId }, data: { status: 'CANCELLED', currentPeriodEnd: subscription.currentPeriodEnd ?? new Date() }, include: { plan: true } });
      await tx.paymentIntent.updateMany({ where: { purpose: 'PLATFORM_SUBSCRIPTION', targetId: subscriptionId, payerId: userId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      await tx.payment.updateMany({ where: { subscriptionId, userId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      return result;
    });
    return res.json({ subscription: updated });
  }

  const subscription = socialStore.state.subscriptions.find((entry) => entry.id === subscriptionId && entry.userId === userId);
  if (!subscription) return res.status(404).json({ message: 'Subscription not found.' });
  subscription.status = 'CANCELLED';
  subscription.currentPeriodEnd = subscription.currentPeriodEnd ?? new Date().toISOString();
  subscription.updatedAt = new Date().toISOString();
  for (const intent of commerceStore.state.paymentIntents) if (intent.targetId === subscriptionId && intent.purpose === 'PLATFORM_SUBSCRIPTION' && intent.status === 'PENDING') intent.status = 'CANCELLED';
  for (const payment of socialStore.state.payments) if (payment.subscriptionId === subscriptionId && payment.status === 'PENDING') payment.status = 'CANCELLED';
  return res.json({ subscription });
});

export { subscriptionRouter };
