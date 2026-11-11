import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import env from '../config/env.js';

export function isLiveKitConfigured() {
  return Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
}

export function liveKitUrl() {
  return env.LIVEKIT_URL;
}

function roomServiceClient() {
  if (!isLiveKitConfigured() || !env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    throw new Error('LiveKit is not configured.');
  }
  const serviceUrl = new URL(env.LIVEKIT_URL);
  serviceUrl.protocol = serviceUrl.protocol === 'wss:' ? 'https:' : 'http:';
  return new RoomServiceClient(serviceUrl.toString(), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
}

export async function createLiveKitToken(input: {
  identity: string;
  name: string;
  room: string;
  canPublish: boolean;
  canPublishSources?: TrackSource[];
}) {
  if (!isLiveKitConfigured() || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    throw new Error('LiveKit is not configured.');
  }

  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: input.identity,
    name: input.name,
    ttl: '10m',
  });
  token.addGrant({
    roomJoin: true,
    room: input.room,
    canPublish: input.canPublish,
    ...(input.canPublishSources ? { canPublishSources: input.canPublishSources } : {}),
    canSubscribe: true,
    canPublishData: false,
  });
  return token.toJwt();
}

export async function getLiveKitParticipants(room: string) {
  return roomServiceClient().listParticipants(room);
}

export async function removeLiveKitParticipant(room: string, identity: string) {
  const service = roomServiceClient();
  if ((await service.listParticipants(room)).some((participant) => participant.identity === identity)) {
    await service.removeParticipant(room, identity);
  }
}

export async function endLiveKitRoom(room: string) {
  const service = roomServiceClient();
  if ((await service.listRooms([room])).some((activeRoom) => activeRoom.name === room)) {
    await service.deleteRoom(room);
  }
}

export function callRoomName(callId: string) {
  return `nova-call-${callId}`;
}

export function liveRoomName(liveId: string) {
  return `nova-live-${liveId}`;
}
