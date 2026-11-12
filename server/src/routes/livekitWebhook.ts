import type { Request, Response } from 'express';
import { EgressStatus, WebhookReceiver } from 'livekit-server-sdk';
import env from '../config/env.js';
import { isDatabaseAvailable, prisma } from '../lib/prisma.js';
import { deleteLiveKitEgressFile, downloadLiveKitEgressFile, InvalidEgressRecordingError } from '../lib/livekitEgress.js';
import { liveReplayMediaKey, getMediaStorage } from '../lib/mediaStorage.js';
import { liveRoomName } from '../lib/livekit.js';

export async function receiveLiveKitWebhook(req: Request, res: Response) {
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    return res.status(503).json({ message: 'LiveKit webhook verification is not configured.' });
  }
  if (!Buffer.isBuffer(req.body)) {
    return res.status(400).json({ message: 'LiveKit webhook body must be raw JSON.' });
  }

  let event;
  try {
    event = await new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET)
      .receive(req.body.toString('utf8'), req.header('Authorization'));
  } catch {
    return res.status(401).json({ message: 'LiveKit webhook signature is invalid.' });
  }

  if (!event.event.startsWith('egress_')) return res.status(200).json({ received: true });
  const info = event.egressInfo;
  if (!info?.egressId) return res.status(400).json({ message: 'LiveKit Egress webhook is missing its Egress identity.' });

  try {
    if (!(await isDatabaseAvailable())) {
      return res.status(503).json({ message: 'LiveKit Egress status cannot be persisted because PostgreSQL is unavailable.' });
    }
    const live = await prisma.liveBroadcast.findFirst({ where: { egressId: info.egressId } })
      ?? (info.roomName.startsWith('nova-live-')
        ? await prisma.liveBroadcast.findUnique({ where: { id: info.roomName.slice('nova-live-'.length) } })
        : null);
    if (!live) return res.status(200).json({ received: true, ignored: true });
    if (info.roomName !== liveRoomName(live.id)) {
      return res.status(200).json({ received: true, ignored: true });
    }
    if (live.egressId && live.egressId !== info.egressId) return res.status(200).json({ received: true, ignored: true });
    if (!live.egressOutputKey) return res.status(200).json({ received: true, ignored: true });

    if (event.event === 'egress_started' || event.event === 'egress_updated') {
      if (!live.egressId) {
        await prisma.liveBroadcast.updateMany({
          where: { id: live.id, egressId: null, egressOutputKey: live.egressOutputKey },
          data: {
            egressId: info.egressId,
            ...(event.event === 'egress_started' ? { recordingStatus: 'RECORDING' } : {}),
          },
        });
      }
      return res.status(200).json({ received: true });
    }
    if (event.event !== 'egress_ended') return res.status(200).json({ received: true });

    if ([EgressStatus.EGRESS_FAILED, EgressStatus.EGRESS_ABORTED, EgressStatus.EGRESS_LIMIT_REACHED].includes(info.status)) {
      const failure = info.error || `LiveKit Egress ended with status ${info.status}.`;
      await prisma.liveBroadcast.update({
        where: { id: live.id },
        data: { recordingStatus: 'UNAVAILABLE', egressError: failure },
      });
      await deleteLiveKitEgressFile(live.egressOutputKey);
      await prisma.liveBroadcast.update({
        where: { id: live.id },
        data: { egressId: null, egressOutputKey: null },
      });
      return res.status(200).json({ received: true });
    }
    if (info.status !== EgressStatus.EGRESS_COMPLETE) {
      return res.status(503).json({ message: 'LiveKit Egress has not reached a final status.' });
    }
    if (!live.egressOutputKey) {
      return res.status(503).json({ message: 'The expected LiveKit Egress output key is not persisted.' });
    }
    const output = info.fileResults.find((file) =>
      file.filename === live.egressOutputKey || file.location.endsWith(`/${live.egressOutputKey}`),
    );
    if (!output) return res.status(503).json({ message: 'The completed LiveKit Egress output does not match the requested recording.' });

    const replay = await prisma.liveReplay.findUnique({ where: { id: live.id } });
    if (!replay || !['READY', 'PUBLISHED'].includes(replay.status)) {
      let bytes: Buffer;
      try {
        bytes = await downloadLiveKitEgressFile(live.egressOutputKey);
      } catch (downloadError) {
        if (!(downloadError instanceof InvalidEgressRecordingError)) throw downloadError;
        await prisma.liveBroadcast.update({
          where: { id: live.id },
          data: {
            recordingStatus: 'UNAVAILABLE',
            egressError: downloadError.message,
          },
        });
        await deleteLiveKitEgressFile(live.egressOutputKey);
        await prisma.liveBroadcast.update({
          where: { id: live.id },
          data: { egressId: null, egressOutputKey: null },
        });
        return res.status(200).json({ received: true });
      }
      const media = await getMediaStorage(env.NODE_ENV).putAttachment(
        bytes,
        'video/mp4',
        'mp4',
        live.hostId,
        liveReplayMediaKey(live.id, 'mp4'),
      );
      const durationSeconds = Math.floor(Number(output.duration) / 1_000_000_000);
      if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 86_400) {
        await getMediaStorage(env.NODE_ENV).delete(media.key);
        await prisma.liveBroadcast.update({
          where: { id: live.id },
          data: { recordingStatus: 'UNAVAILABLE', egressError: 'The Egress recording duration is invalid.' },
        });
        await deleteLiveKitEgressFile(live.egressOutputKey);
        await prisma.liveBroadcast.update({
          where: { id: live.id },
          data: { egressId: null, egressOutputKey: null },
        });
        return res.status(200).json({ received: true });
      }
      await prisma.liveReplay.upsert({
        where: { id: live.id },
        create: {
          id: live.id,
          hostId: live.hostId,
          title: live.title,
          mediaUrl: media.publicUrl,
          contentType: 'video/mp4',
          durationSeconds,
          status: 'READY',
        },
        update: {
          hostId: live.hostId,
          title: live.title,
          mediaUrl: media.publicUrl,
          contentType: 'video/mp4',
          durationSeconds,
          status: 'READY',
          publishedPostId: null,
        },
      });
    }

    const savedReplay = await prisma.liveReplay.findUnique({ where: { id: live.id } });
    if (!savedReplay || !['READY', 'PUBLISHED'].includes(savedReplay.status)) {
      return res.status(503).json({ message: 'The completed LiveKit Egress replay could not be persisted.' });
    }
    await prisma.liveBroadcast.update({
      where: { id: live.id },
      data: {
        recordingStatus: 'READY',
        replayUrl: savedReplay.mediaUrl,
        egressError: null,
      },
    });
    await deleteLiveKitEgressFile(live.egressOutputKey);
    await prisma.liveBroadcast.update({
      where: { id: live.id },
      data: { egressId: null, egressOutputKey: null },
    });
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('LiveKit Egress webhook processing failed.', error instanceof Error ? error.name : 'Unknown error');
    return res.status(503).json({ message: 'LiveKit Egress finalization failed and can be retried.' });
  }
}
