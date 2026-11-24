import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { HttpError, Role, User } from './types';

const SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';

export function sign(u: User, expiresIn: string = '12h'): string {
  return jwt.sign(
    { id: u.id, email: u.email, role: u.role, name: u.name, patientId: u.patientId ?? null, doctorId: u.doctorId ?? null },
    SECRET,
    { expiresIn } as jwt.SignOptions,
  );
}

export function verify(token: string): User {
  return jwt.verify(token, SECRET) as User;
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return next(new HttpError(401, 'Missing bearer token'));
  try {
    req.user = verify(h.slice(7));
    next();
  } catch {
    next(new HttpError(401, 'Invalid or expired token'));
  }
}

/** admin and internal "system" callers can do everything. */
export function allow(user: User | undefined, roles: Role[]): boolean {
  if (!user) return false;
  return user.role === 'admin' || user.role === 'system' || roles.includes(user.role);
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) =>
    allow(req.user, roles) ? next() : next(new HttpError(403, 'Forbidden for role ' + req.user?.role));

export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);
