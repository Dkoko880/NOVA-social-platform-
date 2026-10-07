import type { NextFunction, Request, Response } from 'express';

const MAX_HEADER_LENGTH = 100;
const MAX_PATH_LENGTH = 200;
const SAFE_API_PREFIXES = new Set([
  'admin',
  'auth',
  'communities',
  'health',
  'media',
  'messages',
  'payments',
  'subscriptions',
]);

function sanitizeHeader(value: string | undefined) {
  const sanitized = value?.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, MAX_HEADER_LENGTH);
  return sanitized || 'NONE';
}

function getSanitizedPath(req: Request) {
  if (typeof req.route?.path === 'string') {
    const routePath = `${req.baseUrl}${req.route.path}`.split(/[?#]/, 1)[0];
    const sanitizedRoutePath = routePath
      .split('/')
      .map((segment) => /^:[a-zA-Z][a-zA-Z0-9_]*$/.test(segment) || /^[a-zA-Z0-9._~-]*$/.test(segment)
        ? segment
        : '[redacted]')
      .join('/');
    return (sanitizedRoutePath.slice(0, MAX_PATH_LENGTH) || '/');
  }

  const segments = req.path.split('/').filter(Boolean);
  if (segments[0] === 'api' && SAFE_API_PREFIXES.has(segments[1] ?? '')) {
    return `/api/${segments[1]}`;
  }
  if (segments[0] === 'health') return '/health';
  if (segments[0] === 'api') return '/api';
  return '/[redacted]';
}

export function cfRayDiagnostic(req: Request, res: Response, next: NextFunction) {
  const cfRay = sanitizeHeader(req.get('cf-ray'));
  const cfMitigated = sanitizeHeader(req.get('cf-mitigated'));
  const server = sanitizeHeader(req.get('server'));
  const requestId = sanitizeHeader(req.get('x-request-id'));

  res.once('finish', () => {
    console.info(
      `[CF-RAY-DIAGNOSTIC] TIMESTAMP=${new Date().toISOString()} METHOD=${sanitizeHeader(req.method)} PATH=${getSanitizedPath(req)} STATUS=${res.statusCode} CF-RAY=${cfRay} CF-MITIGATED=${cfMitigated} SERVER=${server} REQUEST-ID=${requestId}`,
    );
  });

  next();
}