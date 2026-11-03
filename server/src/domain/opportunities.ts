import type { Request } from 'express';
import type { Knex } from 'knex';
import { db } from '../db/knex.js';
import { grant, type Action } from '../auth/permissions.js';
import { HttpError, notFound } from '../lib/http.js';
import { decrypt } from '../lib/crypto.js';
import { internalView as internalViewPure } from './views.js';
export { buildSlug, publicView, publicationChecklist, approxPoint } from './views.js';

type QB = Knex.QueryBuilder;

/** Aplica o escopo do usuário a uma consulta sobre land_opportunities (alias "o"). */
export function scopeOpportunities(qb: QB, req: Request, action: Action = 'read'): QB {
  const u = req.user;
  if (!u) throw new HttpError(401, 'Autenticação necessária');
  const scope = grant(u.role, 'opportunity', action);
  if (!scope) return qb.whereRaw('false');
  switch (scope) {
    case 'org':
      return qb.where('o.org_id', u.orgId);
    case 'assigned':
      return qb.where('o.org_id', u.orgId).whereExists(
        db('broker_assignments as ba').whereRaw('ba.opportunity_id = o.id').andWhere({ 'ba.active': true, 'ba.broker_id': u.brokerId ?? '00000000-0000-0000-0000-000000000000' }),
      );
    case 'own':
      return qb.whereExists(db('land_owners as lo').whereRaw('lo.opportunity_id = o.id').andWhere('lo.user_id', u.id));
    case 'published':
      return qb.where('o.publication_status', 'published');
    default:
      return qb.whereRaw('false');
  }
}

/** Busca uma oportunidade respeitando o escopo; responde 404 (não 403) para não revelar existência — proteção contra IDOR. */
export async function getScopedOpportunity(req: Request, idOrCode: string, action: Action = 'read') {
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrCode);
  const row = await scopeOpportunities(db('land_opportunities as o').select('o.*'), req, action)
    .where(isUuid ? { 'o.id': idOrCode } : { 'o.code': idOrCode.toUpperCase() })
    .first();
  if (!row) throw notFound('Oportunidade');
  return row;
}

export async function nextCode(trx: Knex, orgId: string, uf: string): Promise<string> {
  const org = await trx('organizations').where({ id: orgId }).first();
  const prefix = (org?.code_prefix ?? 'DOU').toUpperCase();
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`code:${orgId}:${uf}`]);
  const row: any = await trx('land_opportunities')
    .where('org_id', orgId)
    .andWhere('code', 'like', `${prefix}-${uf}-%`)
    .max({ max: trx.raw(`(regexp_replace(code, '^.*-', ''))::int`) })
    .first();
  return `${prefix}-${uf}-${String((row?.max ?? 0) + 1).padStart(4, '0')}`;
}

// ------------------------------------------------------------------------- carregamento completo

export async function loadRelations(ids: string[]) {
  if (!ids.length) return new Map<string, any>();
  const [geoms, tech, terms, pubs, media, owners, docs, assigns] = await Promise.all([
    db('land_geometries')
      .whereIn('opportunity_id', ids)
      .andWhere('is_current', true)
      .select(
        'opportunity_id', 'area_m2', 'perimeter_m', 'source', 'version',
        db.raw('ST_AsGeoJSON(geom, 7)::json as geometry'),
        db.raw('ST_X(centroid) as c_lng, ST_Y(centroid) as c_lat'),
        db.raw('ST_X(public_point) as p_lng, ST_Y(public_point) as p_lat'),
      ),
    db('land_technical_attributes').whereIn('opportunity_id', ids),
    db('land_commercial_terms').whereIn('opportunity_id', ids),
    db('publication_permissions').whereIn('opportunity_id', ids),
    db('land_media').whereIn('opportunity_id', ids).orderBy([{ column: 'is_cover', order: 'desc' }, 'sort']),
    db('land_owners').whereIn('opportunity_id', ids),
    db('land_documents').whereIn('opportunity_id', ids).andWhere('is_current', true).orderBy('created_at', 'desc'),
    db('broker_assignments as ba')
      .join('land_brokers as b', 'b.id', 'ba.broker_id')
      .join('users as u', 'u.id', 'b.user_id')
      .whereIn('ba.opportunity_id', ids)
      .andWhere('ba.active', true)
      .select('ba.opportunity_id', 'ba.role', 'b.id as broker_id', 'u.name', 'b.whatsapp', 'b.creci', 'b.creci_uf', 'b.creci_status'),
  ]);
  const by = <T extends { opportunity_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) (m.get(r.opportunity_id) ?? m.set(r.opportunity_id, []).get(r.opportunity_id)!).push(r);
    return m;
  };
  const g = by(geoms as any[]), t = by(tech), c = by(terms), p = by(pubs), me = by(media), ow = by(owners), d = by(docs), a = by(assigns as any[]);
  const out = new Map<string, any>();
  for (const id of ids) {
    out.set(id, {
      geometry: g.get(id)?.[0] ?? null,
      tech: Object.fromEntries((t.get(id) ?? []).map((x: any) => [x.key, x])),
      terms: c.get(id)?.[0] ?? null,
      pub: p.get(id)?.[0] ?? null,
      media: me.get(id) ?? [],
      owners: ow.get(id) ?? [],
      documents: d.get(id) ?? [],
      assignments: a.get(id) ?? [],
    });
  }
  return out;
}


export const internalView = (o: any, rel: any, role: import('@dl/shared').Role, brokerId: string | null) => internalViewPure(o, rel, role, brokerId, decrypt);
