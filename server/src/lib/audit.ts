import type { Request } from 'express';
import type { Knex } from 'knex';
import { db } from '../db/knex.js';
import { hashIp } from './crypto.js';

export async function audit(
  req: Request | null,
  action: string,
  entity: string,
  entityId: string | null,
  diff?: unknown,
  trx: Knex = db,
) {
  await trx('audit_logs').insert({
    org_id: req?.user?.orgId ?? null,
    user_id: req?.user?.id ?? null,
    action,
    entity,
    entity_id: entityId,
    diff: diff === undefined ? null : JSON.stringify(diff),
    ip_hash: req ? hashIp(req.ip) : null,
  });
}

/** Retorna apenas os campos que mudaram (para auditoria compacta). */
export function changed(before: Record<string, any>, after: Record<string, any>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after)) {
    if (k === 'updated_at') continue;
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after[k])) out[k] = { from: before?.[k], to: after[k] };
  }
  return out;
}
