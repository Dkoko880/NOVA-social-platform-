import { describe, expect, it } from 'vitest';
import { getOtpProvider, OtpProviderUnavailableError } from '../lib/otpProvider.js';

describe('OTP provider configuration', () => {
  it('never falls back to the predictable development code in production', () => {
    expect(() => getOtpProvider('production')).toThrow(OtpProviderUnavailableError);
  });

  it('keeps the non-delivering provider limited to non-production environments', async () => {
    const provider = getOtpProvider('test');
    expect(provider.mode).toBe('development');
    expect(provider.generateCode()).toBe('123456');
    await expect(provider.sendCode('+15555550123', '123456')).resolves.toBeUndefined();
  });
});
