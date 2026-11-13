import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { socialStore } from '../lib/socialStore.js';
import { clearCommand2AStores } from '../lib/platform.js';
import { registerRealtimeConnection, subscribeToUserEvents } from '../lib/realtime.js';

function cookie(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.join('; ') : value ?? '';
}

async function register(name: string) {
  const email = `${name.toLowerCase()}@example.com`;
  await request(app).post('/api/auth/register').send({ name, email, password: 'Password123', communityRulesAccepted: true });
  const login = await request(app).post('/api/auth/login').send({ email, password: 'Password123' });
  return { auth: cookie(login), user: login.body.user as { id: string; name: string } };
}

describe('completed NOVACHAT messaging features', () => {
  beforeEach(() => {
    fallbackStore.clear();
    socialStore.clear();
    clearCommand2AStores();
  });

  it('persists per-recipient group delivery/read receipts and hides disabled read timestamps', async () => {
    const alice = await register('ReceiptAlice');
    const bob = await register('ReceiptBob');
    const charlie = await register('ReceiptCharlie');
    const outsider = await register('ReceiptOutsider');
    const created = await request(app).post('/api/conversations').set('Cookie', alice.auth)
      .send({ participantIds: [bob.user.id, charlie.user.id], isGroup: true, name: 'Receipts' });
    const conversationId = created.body.conversation.id;
    await request(app).patch('/api/messaging/preferences').set('Cookie', bob.auth).send({ readReceiptsEnabled: false });

    const aliceEvents: Array<Record<string, unknown>> = [];
    const stopListening = subscribeToUserEvents(alice.user.id, (event) => { aliceEvents.push(event as Record<string, unknown>); });
    const sent = await request(app).post(`/api/conversations/${conversationId}/messages`).set('Cookie', alice.auth).send({ text: 'Group update' });
    expect(sent.status).toBe(201);
    const messageId = sent.body.message.id;

    expect((await request(app).get(`/api/conversations/${conversationId}/messages`).set('Cookie', bob.auth)).status).toBe(200);
    expect((await request(app).post(`/api/conversations/${conversationId}/read`).set('Cookie', bob.auth)).status).toBe(200);
    expect((await request(app).get(`/api/conversations/${conversationId}/messages`).set('Cookie', charlie.auth)).status).toBe(200);
    expect((await request(app).post(`/api/conversations/${conversationId}/read`).set('Cookie', charlie.auth)).status).toBe(200);

    const details = await request(app).get(`/api/messages/${messageId}/receipts`).set('Cookie', alice.auth);
    expect(details.status).toBe(200);
    expect(details.body.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipientId: bob.user.id, deliveredAt: expect.any(String), readAt: null }),
      expect.objectContaining({ recipientId: charlie.user.id, deliveredAt: expect.any(String), readAt: expect.any(String) }),
    ]));
    expect((await request(app).get(`/api/messages/${messageId}/receipts`).set('Cookie', outsider.auth)).status).toBe(403);

    const freshMessages = await request(app).get(`/api/conversations/${conversationId}/messages`).set('Cookie', alice.auth);
    expect(freshMessages.body.messages.find((message: { id: string }) => message.id === messageId)).toMatchObject({ status: 'DELIVERED', readAt: null });
    expect(aliceEvents.filter((event) => event.event === 'message:read')).toEqual([
      expect.objectContaining({ messageId, recipientId: charlie.user.id }),
    ]);
    stopListening();
  });

  it('persists unread markers and clears them when the conversation is opened', async () => {
    const alice = await register('UnreadAlice');
    const bob = await register('UnreadBob');
    const created = await request(app).post('/api/conversations').set('Cookie', alice.auth).send({ participantId: bob.user.id });
    const conversationId = created.body.conversation.id;
    const sent = await request(app).post(`/api/conversations/${conversationId}/messages`).set('Cookie', alice.auth).send({ text: 'Unread me' });
    await request(app).get(`/api/conversations/${conversationId}/messages`).set('Cookie', bob.auth);
    await request(app).post(`/api/conversations/${conversationId}/read`).set('Cookie', bob.auth);

    expect((await request(app).get('/api/conversations').set('Cookie', bob.auth)).body.conversations[0].unreadCount).toBe(0);
    expect((await request(app).post(`/api/conversations/${conversationId}/unread`).set('Cookie', bob.auth)).status).toBe(200);
    expect((await request(app).get('/api/conversations').set('Cookie', bob.auth)).body.conversations[0].unreadCount).toBe(1);
    expect((await request(app).get(`/api/conversations/${conversationId}/messages`).set('Cookie', bob.auth)).status).toBe(200);
    await request(app).post(`/api/conversations/${conversationId}/read`).set('Cookie', bob.auth);
    expect((await request(app).get('/api/conversations').set('Cookie', bob.auth)).body.conversations[0].unreadCount).toBe(0);
    expect(sent.body.message.status).toBe('SENT');
  });

  it('limits recording indicators to conversation members and clears them on stop or disconnect', async () => {
    const alice = await register('RecordingAlice');
    const bob = await register('RecordingBob');
    const outsider = await register('RecordingOutsider');
    const created = await request(app).post('/api/conversations').set('Cookie', alice.auth)
      .send({ participantIds: [bob.user.id], isGroup: true, name: 'Voice group' });
    const conversationId = created.body.conversation.id;
    const aliceEvents: Array<Record<string, unknown>> = [];
    const outsiderEvents: Array<Record<string, unknown>> = [];
    const stopAlice = subscribeToUserEvents(alice.user.id, (event) => { aliceEvents.push(event as Record<string, unknown>); });
    const stopOutsider = subscribeToUserEvents(outsider.user.id, (event) => { outsiderEvents.push(event as Record<string, unknown>); });

    expect((await request(app).post(`/api/conversations/${conversationId}/recording`).set('Cookie', outsider.auth).send({ recording: true })).status).toBe(403);
    expect((await request(app).post(`/api/conversations/${conversationId}/recording`).set('Cookie', bob.auth).send({ recording: true })).status).toBe(200);
    expect(aliceEvents).toContainEqual(expect.objectContaining({ event: 'recording:change', userId: bob.user.id, recording: true }));
    expect(outsiderEvents).toHaveLength(0);
    expect((await request(app).post(`/api/conversations/${conversationId}/recording`).set('Cookie', bob.auth).send({ recording: false })).status).toBe(200);
    expect(aliceEvents).toContainEqual(expect.objectContaining({ event: 'recording:change', userId: bob.user.id, recording: false }));

    const disconnect = registerRealtimeConnection(bob.user.id, () => undefined);
    await request(app).post(`/api/conversations/${conversationId}/recording`).set('Cookie', bob.auth).send({ recording: true });
    disconnect();
    expect(aliceEvents.filter((event) => event.event === 'recording:change' && event.recording === false)).toHaveLength(2);
    stopAlice();
    stopOutsider();
  });

  it('rejects spoofed presence and prevents presence lookup outside authorized conversations or privacy settings', async () => {
    const alice = await register('PresenceAlice');
    const bob = await register('PresenceBob');
    const charlie = await register('PresenceCharlie');
    const outsider = await register('PresenceOutsider');
    const created = await request(app).post('/api/conversations').set('Cookie', alice.auth).send({ participantId: bob.user.id });
    await request(app).post('/api/conversations').set('Cookie', alice.auth)
      .send({ participantIds: [bob.user.id, charlie.user.id], isGroup: true, name: 'Group presence' });

    expect((await request(app).post('/api/presence').set('Cookie', alice.auth).send({ online: true })).status).toBe(410);
    expect((await request(app).get(`/api/presence/${alice.user.id}`).set('Cookie', outsider.auth)).status).toBe(404);
    await request(app).patch('/api/messaging/preferences').set('Cookie', alice.auth).send({ presenceVisibility: 'MY_CONTACTS' });
    expect((await request(app).get(`/api/presence/${alice.user.id}`).set('Cookie', charlie.auth)).status).toBe(404);

    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const { port } = server.address() as AddressInfo;
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${port}/api/realtime`, {
        headers: { Cookie: alice.auth },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read();
      const visible = await request(app).get(`/api/presence/${alice.user.id}`).set('Cookie', bob.auth);
      expect(visible.body.presence.online).toBe(true);
      controller.abort();
      await reader.cancel().catch(() => undefined);
      let offline = await request(app).get(`/api/presence/${alice.user.id}`).set('Cookie', bob.auth);
      for (let attempt = 0; attempt < 20 && !offline.body.presence?.lastSeenAt; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        offline = await request(app).get(`/api/presence/${alice.user.id}`).set('Cookie', bob.auth);
      }
      expect(offline.body.presence).toMatchObject({ online: false, lastSeenAt: expect.any(String) });
      await request(app).patch('/api/messaging/preferences').set('Cookie', alice.auth).send({ presenceVisibility: 'NOBODY' });
      expect((await request(app).get(`/api/presence/${alice.user.id}`).set('Cookie', bob.auth)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    expect((await request(app).get(`/api/conversations/${created.body.conversation.id}`).set('Cookie', bob.auth)).status).toBe(200);
  });

  it('reports the exact server configuration needed when GIPHY is unavailable', async () => {
    const user = await register('PickerUser');
    const response = await request(app).get('/api/media-picker/gif?q=party').set('Cookie', user.auth);
    if (response.status === 503) {
      expect(response.body.message).toContain('GIPHY_API_KEY');
    } else {
      expect(response.status).toBe(200);
      expect(response.body.items).toBeInstanceOf(Array);
    }
  });
});
