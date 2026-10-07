import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';

export interface MediaStorage {
  put(bytes: Buffer, contentType: string, ownerUserId?: string): Promise<{ key: string; publicUrl: string }>;
  setOwner(key: string, ownerUserId: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  get(key: string): Promise<{ bytes: Buffer; contentType: string; ownerUserId: string | null } | null>;
}

export class MediaStorageUnavailableError extends Error {
  constructor() {
    super('Persistent object storage is not configured.');
    this.name = 'MediaStorageUnavailableError';
  }
}

class MemoryMediaStorage implements MediaStorage {
  private readonly objects = new Map<string, { bytes: Buffer; contentType: string; ownerUserId: string | null }>();

  async put(bytes: Buffer, contentType: string, ownerUserId?: string) {
    const key = `${randomUUID()}.webp`;
    this.objects.set(key, { bytes: Buffer.from(bytes), contentType, ownerUserId: ownerUserId ?? null });
    return { key, publicUrl: `/api/media/avatars/${key}` };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  async setOwner(key: string, ownerUserId: string) {
    const object = this.objects.get(key);
    if (!object || object.ownerUserId !== null) return false;
    object.ownerUserId = ownerUserId;
    return true;
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      bytes: Buffer.from(object.bytes),
      contentType: object.contentType,
      ownerUserId: object.ownerUserId,
    };
  }
}

class DatabaseMediaStorage implements MediaStorage {
  async put(bytes: Buffer, contentType: string, ownerUserId?: string) {
    const key = `${randomUUID()}.webp`;

    await prisma.registrationMediaObject.create({
      data: {
        key,
        bytes: Buffer.from(bytes),
        contentType,
        ownerUserId,
      },
    });

    return {
      key,
      publicUrl: `/api/media/avatars/${key}`,
    };
  }

  async delete(key: string) {
    await prisma.registrationMediaObject.deleteMany({
      where: { key },
    });
  }

  async setOwner(key: string, ownerUserId: string) {
    const result = await prisma.registrationMediaObject.updateMany({
      where: { key, ownerUserId: null },
      data: { ownerUserId },
    });
    return result.count === 1;
  }

  async get(key: string) {
    const object = await prisma.registrationMediaObject.findUnique({
      where: { key },
      select: {
        bytes: true,
        contentType: true,
        ownerUserId: true,
      },
    });

    if (!object) return null;

    return {
      bytes: Buffer.from(object.bytes),
      contentType: object.contentType,
      ownerUserId: object.ownerUserId,
    };
  }
}

let installedStorage: MediaStorage | null = null;
const memoryStorage = new MemoryMediaStorage();
const databaseStorage = new DatabaseMediaStorage();

export function installMediaStorage(storage: MediaStorage | null) {
  installedStorage = storage;
}

export function getMediaStorage(nodeEnv: string): MediaStorage {
  if (nodeEnv === 'production') return databaseStorage;
  if (installedStorage) return installedStorage;
  if (nodeEnv === 'test' || process.env.VITEST === 'true') return memoryStorage;
  return databaseStorage;
}

export function mediaKeyFromUrl(url: string) {
  const match = /^\/api\/media\/avatars\/([0-9a-f-]{36}\.webp)$/.exec(url);
  return match?.[1] ?? null;
}

export async function uploadedMediaBelongsTo(url: string, userId: string, nodeEnv: string) {
  if (!url.startsWith('/api/media/')) return true;
  const key = mediaKeyFromUrl(url);
  if (!key) return false;
  const object = await getMediaStorage(nodeEnv).get(key);
  return object?.ownerUserId === userId;
}
