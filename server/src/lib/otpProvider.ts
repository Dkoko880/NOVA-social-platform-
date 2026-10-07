export interface OtpProvider {
  readonly mode: string;
  generateCode(): string;
  sendCode(phoneE164: string, code: string): Promise<void>;
}

export class OtpProviderUnavailableError extends Error {
  constructor() {
    super('A production SMS OTP provider is not configured.');
    this.name = 'OtpProviderUnavailableError';
  }
}

class DevelopmentOtpProvider implements OtpProvider {
  readonly mode = 'development';

  generateCode() {
    return '123456';
  }

  async sendCode(_phoneE164: string, _code: string) {
    // Development provider deliberately does not send or log messages.
  }
}

let installedProvider: OtpProvider | null = null;

export function installOtpProvider(provider: OtpProvider | null) {
  installedProvider = provider;
}

export function getOtpProvider(nodeEnv: string): OtpProvider {
  if (installedProvider) return installedProvider;
  if (nodeEnv === 'production') throw new OtpProviderUnavailableError();
  return new DevelopmentOtpProvider();
}