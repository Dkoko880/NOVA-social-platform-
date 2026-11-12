import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { EncodedFileOutput, EncodedFileType, EgressClient, EgressStatus, S3Upload, WebhookConfig } from 'livekit-server-sdk';
import env from '../config/env.js';

export const MAX_EGRESS_REPLAY_BYTES = 100 * 1024 * 1024;

export class InvalidEgressRecordingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEgressRecordingError';
  }
}

export function liveKitEgressMissingConfiguration() {
  const missing: string[] = [];
  if (!env.LIVEKIT_URL) missing.push('LIVEKIT_URL');
  if (!env.LIVEKIT_API_KEY) missing.push('LIVEKIT_API_KEY');
  if (!env.LIVEKIT_API_SECRET) missing.push('LIVEKIT_API_SECRET');
  if (!env.LIVEKIT_EGRESS_WEBHOOK_URL) missing.push('LIVEKIT_EGRESS_WEBHOOK_URL');
  if (!env.LIVEKIT_EGRESS_S3_BUCKET) missing.push('LIVEKIT_EGRESS_S3_BUCKET');
  if (!env.LIVEKIT_EGRESS_S3_REGION) missing.push('LIVEKIT_EGRESS_S3_REGION');
  if (!env.LIVEKIT_EGRESS_S3_ACCESS_KEY) missing.push('LIVEKIT_EGRESS_S3_ACCESS_KEY');
  if (!env.LIVEKIT_EGRESS_S3_SECRET) missing.push('LIVEKIT_EGRESS_S3_SECRET');
  return missing;
}

export function isLiveKitEgressConfigured() {
  return liveKitEgressMissingConfiguration().length === 0;
}

function egressClient() {
  const missing = liveKitEgressMissingConfiguration();
  if (missing.length) {
    throw new Error(`LiveKit Egress is not configured. Missing: ${missing.join(', ')}.`);
  }
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    throw new Error('LiveKit Egress is not configured.');
  }
  const serviceUrl = new URL(env.LIVEKIT_URL);
  serviceUrl.protocol = serviceUrl.protocol === 'wss:' ? 'https:' : 'http:';
  return new EgressClient(serviceUrl.toString(), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
}

function egressS3Client() {
  const missing = liveKitEgressMissingConfiguration();
  if (missing.length) throw new Error(`LiveKit Egress storage is not configured. Missing: ${missing.join(', ')}.`);
  if (!env.LIVEKIT_EGRESS_S3_REGION || !env.LIVEKIT_EGRESS_S3_ACCESS_KEY || !env.LIVEKIT_EGRESS_S3_SECRET) {
    throw new Error('LiveKit Egress storage is not configured.');
  }
  return new S3Client({
    region: env.LIVEKIT_EGRESS_S3_REGION,
    ...(env.LIVEKIT_EGRESS_S3_ENDPOINT ? { endpoint: env.LIVEKIT_EGRESS_S3_ENDPOINT } : {}),
    forcePathStyle: env.LIVEKIT_EGRESS_S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.LIVEKIT_EGRESS_S3_ACCESS_KEY,
      secretAccessKey: env.LIVEKIT_EGRESS_S3_SECRET,
    },
  });
}

export async function startLiveKitRoomEgress(roomName: string, outputKey: string) {
  if (!env.LIVEKIT_EGRESS_S3_BUCKET || !env.LIVEKIT_EGRESS_S3_REGION || !env.LIVEKIT_EGRESS_S3_ACCESS_KEY || !env.LIVEKIT_EGRESS_S3_SECRET) {
    throw new Error('LiveKit Egress storage is not configured.');
  }
  const file = new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath: outputKey,
    output: {
      case: 's3',
      value: new S3Upload({
        accessKey: env.LIVEKIT_EGRESS_S3_ACCESS_KEY,
        secret: env.LIVEKIT_EGRESS_S3_SECRET,
        region: env.LIVEKIT_EGRESS_S3_REGION,
        bucket: env.LIVEKIT_EGRESS_S3_BUCKET,
        ...(env.LIVEKIT_EGRESS_S3_ENDPOINT ? { endpoint: env.LIVEKIT_EGRESS_S3_ENDPOINT } : {}),
        forcePathStyle: env.LIVEKIT_EGRESS_S3_FORCE_PATH_STYLE,
      }),
    },
  });
  if (!env.LIVEKIT_EGRESS_WEBHOOK_URL || !env.LIVEKIT_API_KEY) {
    throw new Error('LiveKit Egress webhook is not configured.');
  }
  const info = await egressClient().startRoomCompositeEgress(roomName, file, {
    webhooks: [new WebhookConfig({
      url: env.LIVEKIT_EGRESS_WEBHOOK_URL,
      signingKey: env.LIVEKIT_API_KEY,
    })],
  });
  if (!info.egressId || info.roomName !== roomName || [EgressStatus.EGRESS_FAILED, EgressStatus.EGRESS_ABORTED].includes(info.status)) {
    throw new Error(info.error || 'LiveKit did not start Egress for the expected live room.');
  }
  return info;
}

export async function stopLiveKitEgress(egressId: string) {
  const client = egressClient();
  try {
    return await client.stopEgress(egressId);
  } catch (stopError) {
    const [existing] = await client.listEgress({ egressId });
    if (existing && [
      EgressStatus.EGRESS_ENDING,
      EgressStatus.EGRESS_COMPLETE,
      EgressStatus.EGRESS_FAILED,
      EgressStatus.EGRESS_ABORTED,
      EgressStatus.EGRESS_LIMIT_REACHED,
    ].includes(existing.status)) return existing;
    throw stopError;
  }
}

export async function downloadLiveKitEgressFile(key: string) {
  if (!env.LIVEKIT_EGRESS_S3_BUCKET) throw new Error('LiveKit Egress storage bucket is not configured.');
  const client = egressS3Client();
  const response = await client.send(new GetObjectCommand({ Bucket: env.LIVEKIT_EGRESS_S3_BUCKET, Key: key }));
  if (response.ContentLength !== undefined && response.ContentLength > MAX_EGRESS_REPLAY_BYTES) {
    throw new InvalidEgressRecordingError('The LiveKit Egress recording exceeds the 100 MB replay storage limit.');
  }
  if (!response.Body) throw new Error('The LiveKit Egress recording has no file body.');
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  if (!bytes.length) throw new InvalidEgressRecordingError('The LiveKit Egress recording is empty.');
  if (bytes.length > MAX_EGRESS_REPLAY_BYTES) {
    throw new InvalidEgressRecordingError('The LiveKit Egress recording exceeds the 100 MB replay storage limit.');
  }
  if (bytes.subarray(4, 8).toString() !== 'ftyp') {
    throw new InvalidEgressRecordingError('The LiveKit Egress output is not a valid MP4 recording.');
  }
  return bytes;
}

export async function deleteLiveKitEgressFile(key: string) {
  if (!env.LIVEKIT_EGRESS_S3_BUCKET) throw new Error('LiveKit Egress storage bucket is not configured.');
  await egressS3Client().send(new DeleteObjectCommand({ Bucket: env.LIVEKIT_EGRESS_S3_BUCKET, Key: key }));
}
