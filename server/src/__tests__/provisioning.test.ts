import { describe, expect, it } from 'vitest';
import { readLocalProvisioningConfig } from '../scripts/provision-local.js';

const validEnvironment = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/nova',
  ADMIN_NAME: 'NOVA Admin',
  ADMIN_EMAIL: 'ADMIN@example.com',
  ADMIN_PASSWORD: 'a-strong-admin-password',
  MODERATOR_NAME: 'NOVA Moderator',
  MODERATOR_EMAIL: 'MODERATOR@example.com',
  MODERATOR_PASSWORD: 'a-strong-moderator-password',
};

describe('local account provisioning configuration', () => {
  it('normalizes role account emails without connecting to the database', () => {
    const config = readLocalProvisioningConfig(validEnvironment);

    expect(config.admin.email).toBe('admin@example.com');
    expect(config.moderator.email).toBe('moderator@example.com');
  });

  it('rejects production provisioning without explicit confirmation', () => {
    expect(() => readLocalProvisioningConfig({
      ...validEnvironment,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://neon.example/nova',
    })).toThrow('explicit confirmation');
  });

  it('allows an explicitly confirmed production database without weakening local checks', () => {
    const config = readLocalProvisioningConfig({
      ...validEnvironment,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://neon.example/nova',
      PROVISION_PRODUCTION_CONFIRM: 'I_UNDERSTAND_PRODUCTION_PROVISIONING',
    });

    expect(config.admin.email).toBe('admin@example.com');
  });

  it('rejects non-loopback databases', () => {
    expect(() => readLocalProvisioningConfig({ ...validEnvironment, DATABASE_URL: 'postgresql://db.example/nova' })).toThrow(
      'loopback DATABASE_URL',
    );
  });
});