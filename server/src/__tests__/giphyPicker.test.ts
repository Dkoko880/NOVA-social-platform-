import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.stubEnv('GIPHY_API_KEY', 'giphy-test-key');

const { app } = await import('../app.js');
const { fallbackStore } = await import('../lib/fallbackStore.js');
const { socialStore } = await import('../lib/socialStore.js');
const { clearCommand2AStores } = await import('../lib/platform.js');

function cookie(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.join('; ') : value ?? '';
}

async function registerPickerUser() {
  const credentials = { email: 'giphy-picker@example.com', password: 'Password123' };
  await request(app).post('/api/auth/register').send({
    name: 'GiphyPicker',
    ...credentials,
    communityRulesAccepted: true,
  });
  const login = await request(app).post('/api/auth/login').send(credentials);
  return cookie(login);
}

describe('server-side GIPHY picker integration', () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    fallbackStore.clear();
    socialStore.clear();
    clearCommand2AStores();
  });

  it('uses the server key for GIF and sticker searches and maps safe media URLs', async () => {
    const auth = await registerPickerUser();
    const fetchGiphy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          id: 'party-gif',
          title: 'Party GIF',
          images: {
            original: { url: 'https://media.giphy.com/media/party/giphy.gif' },
            fixed_height_still: { url: 'https://media.giphy.com/media/party/200_s.gif' },
          },
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          id: 'wave-sticker',
          title: 'Wave sticker',
          images: {
            original: { url: 'https://media.giphy.com/media/wave/giphy.webp' },
            fixed_height_still: { url: 'https://media.giphy.com/media/wave/200_s.webp' },
          },
        }],
      }), { status: 200 }));

    const gifResponse = await request(app).get('/api/media-picker/gif?q=party').set('Cookie', auth);
    const stickerResponse = await request(app).get('/api/media-picker/sticker?q=wave').set('Cookie', auth);

    expect(gifResponse.status).toBe(200);
    expect(gifResponse.body).toEqual({
      items: [{
        id: 'party-gif',
        title: 'Party GIF',
        mediaUrl: 'https://media.giphy.com/media/party/giphy.gif',
        previewUrl: 'https://media.giphy.com/media/party/200_s.gif',
      }],
      attribution: 'Powered by GIPHY',
    });
    expect(stickerResponse.status).toBe(200);
    expect(stickerResponse.body.items[0]).toMatchObject({
      id: 'wave-sticker',
      mediaUrl: 'https://media.giphy.com/media/wave/giphy.webp',
      previewUrl: 'https://media.giphy.com/media/wave/200_s.webp',
    });
    expect(fetchGiphy).toHaveBeenCalledTimes(2);
    for (const [providerUrl] of fetchGiphy.mock.calls) {
      const url = new URL(String(providerUrl));
      expect(url.hostname).toBe('api.giphy.com');
      expect(url.searchParams.get('api_key')).toBe('giphy-test-key');
    }

  });
});
