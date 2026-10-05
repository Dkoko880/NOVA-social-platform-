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
const databaseStorage = new DatabaseMediaStorage();

export function installMediaStorage(storage: MediaStorage | null) {
  installedStorage = storage;
}

export function getMediaStorage(nodeEnv: string): MediaStorage {
  if (installedStorage) return installedStorage;
  if (nodeEnv === 'production') return databaseStorage;
  return databaseStorage;
}
