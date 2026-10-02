import { randomUUID } from 'node:crypto';

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

class DevelopmentMemoryMediaStorage implements MediaStorage {
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
    return object ? { bytes: Buffer.from(object.bytes), contentType: object.contentType } : null;
  }
}

let installedStorage: MediaStorage | null = null;
const developmentStorage = new DevelopmentMemoryMediaStorage();

export function installMediaStorage(storage: MediaStorage | null) {
  installedStorage = storage;
}

export function getMediaStorage(nodeEnv: string): MediaStorage {
  if (installedStorage) return installedStorage;
  if (nodeEnv === 'production') throw new MediaStorageUnavailableError();
  return developmentStorage;
}