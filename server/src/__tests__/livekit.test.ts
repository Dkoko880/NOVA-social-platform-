import { describe, expect, it } from 'vitest';
import { envSchema } from '../config/env.js';

describe('LiveKit environment configuration', () => {
  const completeConfig = {
    NODE_ENV: 'test',
    LIVEKIT_URL: 'wss://media.example.test',
    LIVEKIT_API_KEY: 'livekit-test-key',
    LIVEKIT_API_SECRET: 'livekit-test-secret-with-adequate-length',
  };

  it('accepts a complete secure LiveKit configuration', () => {
    expect(envSchema.safeParse(completeConfig).success).toBe(true);
    expect(envSchema.safeParse({
      ...completeConfig,
      LIVEKIT_EGRESS_WEBHOOK_URL: 'https://api.example.test/api/livekit/webhook',
      LIVEKIT_EGRESS_S3_BUCKET: 'live-recordings',
      LIVEKIT_EGRESS_S3_REGION: 'us-east-1',
      LIVEKIT_EGRESS_S3_ACCESS_KEY: 'test-egress-key',
      LIVEKIT_EGRESS_S3_SECRET: 'test-egress-secret',
    }).success).toBe(true);
    expect(envSchema.safeParse({
      NODE_ENV: 'test',
      LIVEKIT_URL: '',
      LIVEKIT_API_KEY: '',
      LIVEKIT_API_SECRET: '',
    }).success).toBe(true);
  });

  it('rejects incomplete credentials, non-WebSocket URLs, embedded credentials, whitespace, and short secrets', () => {
    expect(envSchema.safeParse({ ...completeConfig, LIVEKIT_API_SECRET: undefined }).success).toBe(false);
    expect(envSchema.safeParse({ ...completeConfig, LIVEKIT_URL: '' }).success).toBe(false);
    expect(envSchema.safeParse({ ...completeConfig, LIVEKIT_API_KEY: '' }).success).toBe(false);
    expect(envSchema.safeParse({ ...completeConfig, LIVEKIT_API_SECRET: '' }).success).toBe(false);
    expect(envSchema.safeParse({ ...completeConfig, LIVEKIT_URL: 'https://media.example.test' }).success).toBe(false);
    expect(envSchema.safeParse({ ...completeConfig, LIVEKIT_URL: '******media.example.test' }).success).toBe(false);
    expect(envSchema.safeParse({ ...completeConfig, LIVEKIT_URL: ' wss://media.example.test ' }).success).toBe(false);
    expect(envSchema.safeParse({ ...completeConfig, LIVEKIT_API_KEY: ' livekit-test-key ' }).success).toBe(false);
    expect(envSchema.safeParse({ ...completeConfig, LIVEKIT_API_SECRET: 'too-short' }).success).toBe(false);
    expect(envSchema.safeParse({
      ...completeConfig,
      LIVEKIT_EGRESS_WEBHOOK_URL: 'ftp://api.example.test/api/livekit/webhook',
    }).success).toBe(false);
    expect(envSchema.safeParse({ ...completeConfig, LIVEKIT_EGRESS_S3_BUCKET: 'live-recordings' }).success).toBe(true);
    expect(envSchema.safeParse({
      ...completeConfig,
      LIVEKIT_EGRESS_S3_BUCKET: 'live-recordings',
      LIVEKIT_EGRESS_S3_REGION: 'us-east-1',
      LIVEKIT_EGRESS_S3_ACCESS_KEY: 'test-egress-key',
      LIVEKIT_EGRESS_S3_SECRET: 'test-egress-secret',
      LIVEKIT_EGRESS_S3_ENDPOINT: 'ftp://storage.example.test',
    }).success).toBe(false);
  });
});
