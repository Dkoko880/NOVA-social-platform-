import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';

export interface MediaStorage {
  put(bytes: Buffer, contentType: string): Promise<{ key: string; publicUrl: string }>;
  delete(key: string): Promise<void>;
  get(key: string): Promise<{ bytes: Buffer; contentType: string } | null>;
}

export class MediaStorageUnavailableError extends Error {
  constructor() {
    super('Persistent object storage is not configured.');
    this.name = 'MediaStorageUnavailableError';
  }
}

class MemoryMediaStorage implements MediaStorage {
  private readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();

  async put(bytes: Buffer, contentType: string) {
    const key = `${randomUUID()}.webp`;
    this.objects.set(key, { bytes: Buffer.from(bytes), contentType });
    return { key, publicUrl: `/api/media/avatars/${key}` };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      bytes: Buffer.from(object.bytes),
      contentType: object.contentType,
    };
  }
}

class DatabaseMediaStorage implements MediaStorage {
  async put(bytes: Buffer, contentType: string) {
    const key = `${randomUUID()}.webp`;

    await prisma.registrationMediaObject.create({
      data: {
        key,
        bytes: Buffer.from(bytes),
        contentType,
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

  async get(key: string) {
    const object = await prisma.registrationMediaObject.findUnique({
      where: { key },
      select: {
        bytes: true,
        contentType: true,
      },
    });

    if (!object) return null;

    return {
      bytes: Buffer.from(object.bytes),
      contentType: object.contentType,
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
