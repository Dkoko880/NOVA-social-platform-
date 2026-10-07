import bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import env from '../config/env.js';

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

export function signAccessToken(payload: { sub: string; email?: string | null; role: string }) {
  return jwt.sign(payload, env.JWT_SECRET as jwt.Secret, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    jwtid: randomUUID(),
  });
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, env.JWT_SECRET as jwt.Secret) as {
    sub: string;
    email?: string;
    role: string;
  };
}

export function getAccessTokenExpiration(token: string) {
  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded === 'string' || typeof decoded.exp !== 'number') {
    throw new Error('Access token does not contain a valid expiration.');
  }
  return new Date(decoded.exp * 1000);
}

export function hashSessionToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function sanitizeUser<T extends Record<string, unknown>>(user: T) {
  const { passwordHash: _passwordHash, ...safeUser } = user as T & { passwordHash?: string; addressCiphertext?: string; addressIv?: string; addressTag?: string };
  delete (safeUser as Record<string, unknown>).addressCiphertext;
  delete (safeUser as Record<string, unknown>).addressIv;
  delete (safeUser as Record<string, unknown>).addressTag;
  return safeUser;
}
