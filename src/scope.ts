import type { RowScope } from './crud';
import type { Ctx, User } from './types';

const cache = new Map<string, { at: number; ids: string[] }>();

/**
 * Patients this doctor "has": anyone with an appointment, queue token, encounter or prescription under their doctor id.
 * Fails closed: a doctor login that is not linked to a doctor record sees nothing.
 */
export async function doctorPatientIds(ctx: Ctx, user: User): Promise<string[]> {
  if (!user.doctorId) return [];
  const hit = cache.get(user.doctorId);
  if (hit && Date.now() - hit.at < 5000) return hit.ids;
  const q = `?doctor_id=${user.doctorId}&limit=500`;
  const res = await Promise.allSettled([
    ctx.call('appointment-service', '/appointments' + q),
    ctx.call('queue-service', '/queue' + q),
    ctx.call('emr-service', '/encounters' + q),
    ctx.call('prescription-service', '/prescriptions' + q),
  ]);
  const ids = new Set<string>();
  for (const r of res) if (r.status === 'fulfilled') for (const row of r.value?.data ?? []) if (row.patient_id) ids.add(String(row.patient_id));
  const out = [...ids];
  cache.set(user.doctorId, { at: Date.now(), ids: out });
  return out;
}

/** doctors only see rows that carry their own doctor id (e.g. appointments, encounters, prescriptions) */
export const ownDoctorRows =
  (field = 'doctor_id', orNull = false) =>
  async (user: User): Promise<RowScope> =>
    user.role === 'doctor' ? { field, values: user.doctorId ? [user.doctorId] : [], orNull } : null;

/** doctors only see rows belonging to their own patients */
export const myPatientRows =
  (field = 'patient_id') =>
  async (user: User, ctx: Ctx): Promise<RowScope> =>
    user.role === 'doctor' ? { field, values: await doctorPatientIds(ctx, user) } : null;
