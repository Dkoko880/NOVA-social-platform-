import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  databaseAvailable: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  replayFindUnique: vi.fn(),
  replayUpsert: vi.fn(),
  download: vi.fn(),
  deleteEgressFile: vi.fn(),
  putAttachment: vi.fn(),
  deleteMedia: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  isDatabaseAvailable: mocks.databaseAvailable,
  prisma: {
    liveBroadcast: {
      findFirst: mocks.findFirst,
      findUnique: mocks.findUnique,
      updateMany: mocks.updateMany,
      update: mocks.update,
    },
    liveReplay: {
      findUnique: mocks.replayFindUnique,
      upsert: mocks.replayUpsert,
    },
  },
}));

vi.mock('../lib/livekitEgress.js', () => ({
  deleteLiveKitEgressFile: mocks.deleteEgressFile,
  downloadLiveKitEgressFile: mocks.download,
  InvalidEgressRecordingError: class extends Error {},
}));

vi.mock('../lib/mediaStorage.js', () => ({
  getMediaStorage: () => ({
    putAttachment: mocks.putAttachment,
    delete: mocks.deleteMedia,
  }),
  liveReplayMediaKey: vi.fn(() => '12345678-1234-5234-a234-123456789012.mp4'),
}));

import { receiveLiveKitWebhook } from '../routes/livekitWebhook.js';

function responseMock() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return response as unknown as Response & typeof response;
}

async function signedRequest(body: string) {
  const token = new AccessToken('test-livekit-key', 'test-livekit-secret-that-is-only-used-in-tests');
  token.sha256 = createHash('sha256').update(body).digest('base64');
  const authorization = await token.toJwt();
  return {
    body: Buffer.from(body),
    header: (name: string) => name === 'Authorization' ? authorization : undefined,
  } as unknown as Request;
}

describe('LiveKit Egress webhook handling', () => {
  beforeEach(() => {
    mocks.databaseAvailable.mockReset().mockResolvedValue(true);
    mocks.findFirst.mockReset().mockResolvedValue(null);
    mocks.findUnique.mockReset().mockResolvedValue({
      id: 'live-1',
      egressId: null,
      egressOutputKey: 'live-recordings/live-1/recording.mp4',
    });
    mocks.updateMany.mockReset().mockResolvedValue({ count: 1 });
    mocks.update.mockReset().mockResolvedValue({});
    mocks.replayFindUnique.mockReset().mockResolvedValue(null);
    mocks.replayUpsert.mockReset().mockResolvedValue({});
    mocks.download.mockReset().mockResolvedValue(Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]));
    mocks.deleteEgressFile.mockReset().mockResolvedValue(undefined);
    mocks.putAttachment.mockReset().mockResolvedValue({
      key: '12345678-1234-5234-a234-123456789012.mp4',
      publicUrl: '/api/media/files/12345678-1234-5234-a234-123456789012.mp4',
    });
    mocks.deleteMedia.mockReset().mockResolvedValue(undefined);
  });

  it('verifies the signature and persists the Egress ID for its exact Live room', async () => {
    const body = JSON.stringify({
      event: 'egress_started',
      egressInfo: { egressId: 'egress-1', roomName: 'nova-live-live-1', status: 1 },
    });
    const res = responseMock();

    await receiveLiveKitWebhook(await signedRequest(body), res);

    expect(res.statusCode).toBe(200);
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { id: 'live-1' } });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'live-1',
        egressId: null,
        egressOutputKey: 'live-recordings/live-1/recording.mp4',
      },
      data: { egressId: 'egress-1', recordingStatus: 'RECORDING' },
    });
  });

  it('stores the completed MP4, marks its replay ready, and removes the temporary S3 object', async () => {
    const outputKey = 'live-recordings/live-1/recording.mp4';
    const replay = {
      id: 'live-1',
      hostId: 'host-1',
      title: 'Town hall',
      mediaUrl: '/api/media/files/12345678-1234-5234-a234-123456789012.mp4',
      contentType: 'video/mp4',
      durationSeconds: 30,
      status: 'READY',
    };
    mocks.findFirst.mockResolvedValue({
      id: 'live-1',
      hostId: 'host-1',
      title: 'Town hall',
      egressId: 'egress-1',
      egressOutputKey: outputKey,
    });
    mocks.replayFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(replay);
    const body = JSON.stringify({
      event: 'egress_ended',
      egressInfo: {
        egressId: 'egress-1',
        roomName: 'nova-live-live-1',
        status: 3,
        fileResults: [{ filename: outputKey, duration: '30000000000' }],
      },
    });
    const res = responseMock();

    await receiveLiveKitWebhook(await signedRequest(body), res);

    expect(res.statusCode).toBe(200);
    expect(mocks.download).toHaveBeenCalledWith(outputKey);
    expect(mocks.putAttachment).toHaveBeenCalledWith(
      expect.any(Buffer),
      'video/mp4',
      'mp4',
      'host-1',
      '12345678-1234-5234-a234-123456789012.mp4',
    );
    expect(mocks.replayUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'live-1' },
      create: expect.objectContaining({ status: 'READY', contentType: 'video/mp4', durationSeconds: 30 }),
    }));
    expect(mocks.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: { recordingStatus: 'READY', replayUrl: replay.mediaUrl, egressError: null },
    }));
    expect(mocks.deleteEgressFile).toHaveBeenCalledWith(outputKey);
    expect(mocks.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: { egressId: null, egressOutputKey: null },
    }));
  });
});
