import type { Pool, PoolClient } from 'pg';
import type { Bus } from './bus';

export const ROLES = [
  'admin', 'doctor', 'nurse', 'receptionist', 'pharmacist',
  'lab_tech', 'radiologist', 'accountant', 'patient', 'system',
] as const;
export type Role = (typeof ROLES)[number];
export const STAFF_ROLES: Role[] = ROLES.filter((r) => r !== 'patient' && r !== 'system');

export interface User {
  id: string;
  email: string;
  role: Role;
  name?: string;
  patientId?: string | null;
  /** set for role=doctor: id of the matching row in doctor-service (linked through doctors.user_id) */
  doctorId?: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  user?: User;
}

export interface Ctx {
  name: string;
  db: Pool;
  bus: Bus;
  tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>;
  q<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  call<T = any>(service: string, path: string, opts?: CallOptions): Promise<T>;
  log(msg: string, extra?: Record<string, unknown>): void;
}
