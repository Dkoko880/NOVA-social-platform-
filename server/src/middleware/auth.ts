import type { NextFunction, Request, Response } from 'express';
import env from '../config/env.js';
import { hashSessionToken, verifyAccessToken } from '../lib/auth.js';
import { fallbackStore, findUserById } from '../lib/fallbackStore.js';
import { prisma, isDatabaseAvailable } from '../lib/prisma.js';

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    const cookieToken = req.cookies?.[env.COOKIE_NAME];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : cookieToken;

    if (!token) {
      return res.status(401).json({ message: 'Authentication required.' });
    }

    const decoded = verifyAccessToken(token);
    const dbAvailable = await isDatabaseAvailable();
    if (dbAvailable) {
      const session = await prisma.session.findFirst({
        where: {
          tokenHash: hashSessionToken(token),
          revokedAt: null,
          expiresAt: { gt: new Date() },
          userId: decoded.sub,
        },
        select: { id: true },
      });

      if (!session) {
        return res.status(401).json({ message: 'User session is invalid or expired.' });
      }
    } else if (!fallbackStore.findSessionByTokenHash(hashSessionToken(token))) {
      return res.status(401).json({ message: 'User session is invalid or expired.' });
    }
    let user = null as { id: string; email: string | null; name: string; role: string; status: string } | null;

    if (dbAvailable) {
      user = await prisma.user.findUnique({
        where: { id: decoded.sub },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
        },
      });
    } else {
      const fallbackUser = findUserById(decoded.sub);
      if (fallbackUser) {
        user = {
          id: fallbackUser.id,
          email: fallbackUser.email,
          name: fallbackUser.name,
          role: fallbackUser.role,
          status: fallbackUser.status,
        };
      }
    }

    if (!user) {
      return res.status(401).json({ message: 'User session is invalid.' });
    }

    req.user = user;
    return next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

export function requireRole(allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required.' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission to access this resource.' });
    }

    return next();
  };
}

export function requireAdminAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  if (!['ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Only administrators can access this area.' });
  }

  return next();
}

export function requireModeratorAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  if (!['MODERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Moderation access requires a moderator or administrator role.' });
  }

  return next();
}

export async function requireActiveAccountIfAuthenticated(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.cookies?.[env.COOKIE_NAME];

  if (!token) {
    return next();
  }

  try {
    const decoded = verifyAccessToken(token);
    const dbAvailable = await isDatabaseAvailable();
    if (dbAvailable) {
      const session = await prisma.session.findFirst({
        where: {
          tokenHash: hashSessionToken(token),
          revokedAt: null,
          expiresAt: { gt: new Date() },
          userId: decoded.sub,
        },
        select: { id: true },
      });

      if (!session) {
        return res.status(401).json({ message: 'User session is invalid or expired.' });
      }
    } else if (!fallbackStore.findSessionByTokenHash(hashSessionToken(token))) {
      return res.status(401).json({ message: 'User session is invalid or expired.' });
    }
    const user = dbAvailable
      ? await prisma.user.findUnique({
          where: { id: decoded.sub },
          select: { id: true, email: true, name: true, role: true, status: true },
        })
      : findUserById(decoded.sub);

    if (user && ['BANNED', 'SUSPENDED', 'DEACTIVATED'].includes(user.status)) {
      const isAppealReview = req.method === 'POST' && /^\/appeals\/[^/]+\/(approve|reject)$/.test(req.path);
      const message = isAppealReview
        ? 'Your account is restricted and cannot approve or reject appeals.'
        : 'Your account is restricted and cannot access the platform.';
      return res.status(403).json({ message });
    }

    if (user) {
      req.user = {
        id: user.id,
        email: user.email ?? null,
        name: user.name,
        role: user.role,
        status: user.status,
      };
    }

    return next();
  } catch {
    if (env.NODE_ENV === 'production') {
      return res.status(503).json({ message: 'Account status could not be verified.' });
    }

    return next();
  }
}

