import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  list: vi.fn(),
}));

vi.mock('livekit-server-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('livekit-server-sdk')>();
  return {
    ...actual,
    EgressClient: class {
      constructor(...args: unknown[]) {
        mocks.constructor(...args);
      }

      startRoomCompositeEgress(...args: unknown[]) {
        return mocks.start(...args);
      }

      stopEgress(...args: unknown[]) {
        return mocks.stop(...args);
      }

      listEgress(...args: unknown[]) {
        return mocks.list(...args);
      }
    },
  };
});

const configuration = {
  LIVEKIT_URL: process.env.LIVEKIT_URL,
  LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
  LIVEKIT_EGRESS_WEBHOOK_URL: process.env.LIVEKIT_EGRESS_WEBHOOK_URL,
  LIVEKIT_EGRESS_S3_BUCKET: process.env.LIVEKIT_EGRESS_S3_BUCKET,
  LIVEKIT_EGRESS_S3_REGION: process.env.LIVEKIT_EGRESS_S3_REGION,
  LIVEKIT_EGRESS_S3_ACCESS_KEY: process.env.LIVEKIT_EGRESS_S3_ACCESS_KEY,
  LIVEKIT_EGRESS_S3_SECRET: process.env.LIVEKIT_EGRESS_S3_SECRET,
};

beforeEach(() => {
  process.env.LIVEKIT_URL = 'wss://media.example.test';
  process.env.LIVEKIT_API_KEY = 'test-livekit-key';
  process.env.LIVEKIT_API_SECRET = 'test-livekit-secret-with-adequate-length';
  process.env.LIVEKIT_EGRESS_WEBHOOK_URL = 'https://api.example.test/api/livekit/webhook';
  process.env.LIVEKIT_EGRESS_S3_BUCKET = 'test-live-recordings';
  process.env.LIVEKIT_EGRESS_S3_REGION = 'us-east-1';
  process.env.LIVEKIT_EGRESS_S3_ACCESS_KEY = 'test-egress-access-key';
  process.env.LIVEKIT_EGRESS_S3_SECRET = 'test-egress-secret';
  mocks.constructor.mockReset();
  mocks.start.mockReset();
  mocks.stop.mockReset();
  mocks.list.mockReset();
  vi.resetModules();
});

afterEach(() => {
  for (const [key, value] of Object.entries(configuration)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('LiveKit Egress integration', () => {
  it('starts a room-composite MP4 in the configured S3 output and validates room identity', async () => {
    mocks.start.mockResolvedValue({
      egressId: 'egress-1',
      roomName: 'nova-live-live-1',
      status: 0,
      error: '',
    });
    const { startLiveKitRoomEgress } = await import('../lib/livekitEgress.js');

    await startLiveKitRoomEgress('nova-live-live-1', 'live-recordings/live-1/recording.mp4');

    expect(mocks.constructor).toHaveBeenCalledWith(
      'https://media.example.test/',
      'test-livekit-key',
      'test-livekit-secret-with-adequate-length',
    );
    const [roomName, output, options] = mocks.start.mock.calls[0] as [string, {
      fileType: number;
      filepath: string;
      output: { case: string; value: { bucket: string; region: string } };
    }, { webhooks: Array<{ url: string; signingKey: string }> }];
    expect(roomName).toBe('nova-live-live-1');
    expect(output).toMatchObject({
      fileType: 1,
      filepath: 'live-recordings/live-1/recording.mp4',
      output: { case: 's3', value: { bucket: 'test-live-recordings', region: 'us-east-1' } },
    });
    expect(options.webhooks).toEqual([{
      url: 'https://api.example.test/api/livekit/webhook',
      signingKey: 'test-livekit-key',
    }]);

    mocks.start.mockResolvedValue({ egressId: 'egress-2', roomName: 'another-room', status: 0, error: '' });
    await expect(startLiveKitRoomEgress('nova-live-live-1', 'output.mp4')).rejects.toThrow('expected live room');
  });

  it('reports the exact missing storage settings rather than treating Egress as available', async () => {
    delete process.env.LIVEKIT_EGRESS_S3_BUCKET;
    delete process.env.LIVEKIT_EGRESS_S3_REGION;
    delete process.env.LIVEKIT_EGRESS_S3_ACCESS_KEY;
    delete process.env.LIVEKIT_EGRESS_S3_SECRET;
    vi.resetModules();
    const { isLiveKitEgressConfigured, liveKitEgressMissingConfiguration } = await import('../lib/livekitEgress.js');

    expect(isLiveKitEgressConfigured()).toBe(false);
    expect(liveKitEgressMissingConfiguration()).toContain('LIVEKIT_EGRESS_S3_BUCKET');
  });

  it('treats a terminal Egress as already stopped when a stop request is retried', async () => {
    mocks.stop.mockRejectedValue(new Error('Egress already stopped'));
    mocks.list.mockResolvedValue([{ status: 3 }]);
    const { stopLiveKitEgress } = await import('../lib/livekitEgress.js');

    await expect(stopLiveKitEgress('egress-1')).resolves.toMatchObject({ status: 3 });
    expect(mocks.stop).toHaveBeenCalledWith('egress-1');
    expect(mocks.list).toHaveBeenCalledWith({ egressId: 'egress-1' });
  });
});
