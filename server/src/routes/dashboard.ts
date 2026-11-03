import { Router } from 'express';
import { db } from '../db/knex.js';
import { authenticate, can, requireScope } from '../auth/auth.js';
import { ah } from '../lib/http.js';

export const router = Router();
router.use(authenticate);

router.get('/', ah(async (req, res) => {
  requireScope(req, 'dashboard', 'read');
  const org = req.user!.orgId;
  const days = Math.min(365, Math.max(7, Number(req.query.days ?? 90)));
  const since = db.raw(`now() - (? * interval '1 day')`, [days]);
  const O = () => db('land_opportunities').where({ org_id: org });

  const [areas, byUf, byModality, byStatus, newCaptures, stale, interests, byChannel, byBroker, byCity, negs, byStage, proposals, won, pending, slaOver, expiringDocs, weekly] = await Promise.all([
    O().select(
      db.raw('count(*)::int as total'),
      db.raw(`count(*) FILTER (WHERE status = 'disponivel')::int as available`),
      db.raw(`count(*) FILTER (WHERE publication_status = 'published')::int as published`),
      db.raw('coalesce(sum(area_m2),0)::float as total_area_m2'),
    ).first(),
    O().select('uf').count({ n: '*' }).sum({ area: 'area_m2' }).groupBy('uf').orderBy('n', 'desc'),
    db('land_commercial_terms as t').join('land_opportunities as o', 'o.id', 't.opportunity_id').where('o.org_id', org)
      .select(db.raw('unnest(t.modalities) as modality')).count({ n: '*' }).groupBy('modality').orderBy('n', 'desc'),
    O().select('status').count({ n: '*' }).groupBy('status'),
    O().where('created_at', '>=', since).count({ n: '*' }).first(),
    O().where('updated_at', '<', db.raw(`now() - interval '30 days'`)).whereNotIn('status', ['concluida']).select('id', 'code', 'internal_name', 'updated_at').orderBy('updated_at').limit(10),
    db('opportunity_interests').where({ org_id: org }).andWhere('created_at', '>=', since).select(
      db.raw('count(*)::int as total'),
      db.raw(`count(*) FILTER (WHERE kind = 'whatsapp')::int as whatsapp_clicks`),
      db.raw(`count(*) FILTER (WHERE status IN ('message_received','qualified'))::int as confirmed_conversations`),
      db.raw(`count(*) FILTER (WHERE kind = 'form')::int as forms`),
      db.raw(`count(*) FILTER (WHERE name IS NOT NULL)::int as identified`),
    ).first(),
    db('opportunity_interests').where({ org_id: org }).andWhere('created_at', '>=', since).select('channel').count({ n: '*' }).groupBy('channel').orderBy('n', 'desc'),
    db('opportunity_interests as i').leftJoin('land_brokers as b', 'b.id', 'i.broker_id').leftJoin('users as u', 'u.id', 'b.user_id')
      .where('i.org_id', org).andWhere('i.created_at', '>=', since).select(db.raw(`coalesce(u.name, 'Central') as broker`)).count({ n: '*' }).groupBy('broker').orderBy('n', 'desc'),
    db('opportunity_interests as i').join('land_opportunities as o', 'o.id', 'i.opportunity_id').where('i.org_id', org).andWhere('i.created_at', '>=', since)
      .select(db.raw(`o.city || '/' || o.uf as city`)).count({ n: '*' }).groupBy('o.city', 'o.uf').orderBy('n', 'desc').limit(8),
    db('negotiations').where({ org_id: org, status: 'open' }).count({ n: '*' }).first(),
    db('negotiations').where({ org_id: org, status: 'open' }).select('stage').count({ n: '*' }).groupBy('stage'),
    db('proposals').where({ org_id: org }).andWhere('created_at', '>=', since).count({ n: '*' }).first(),
    db('negotiations').where({ org_id: org, status: 'won' }).andWhere('updated_at', '>=', since).count({ n: '*' }).first(),
    O().where('publication_status', 'pending_review').select('id', 'code', 'internal_name', 'updated_at'),
    db('opportunity_interests').where({ org_id: org }).whereNull('first_response_at').whereNotNull('name').whereNot('status', 'discarded').andWhere('sla_due_at', '<', db.fn.now()).count({ n: '*' }).first(),
    db('land_documents as d').join('land_opportunities as o', 'o.id', 'd.opportunity_id').where('o.org_id', org).andWhere('d.is_current', true)
      .whereBetween('d.valid_until', [db.raw('current_date'), db.raw(`current_date + 30`)]).select('d.id', 'd.title', 'd.valid_until', 'o.code', 'o.id as opportunity_id'),
    db.raw(
      `SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') as week, count(*)::int as interests,
              count(*) FILTER (WHERE name IS NOT NULL)::int as identified
       FROM opportunity_interests WHERE org_id = ? AND created_at >= now() - (? * interval '1 day') GROUP BY 1 ORDER BY 1`, [org, days]),
  ]);

  const potential = await db('land_commercial_terms as t').join('land_opportunities as o', 'o.id', 't.opportunity_id')
    .where('o.org_id', org).whereNotIn('o.status', ['concluida', 'suspensa']).sum({ v: 't.asking_price' }).sum({ vgv: 't.vgv_preliminary' }).first();

  let commission = null;
  if (can(req, 'commission', 'read') && req.user!.role === 'dourado_admin') {
    commission = await db('commissions').where({ org_id: org }).select(
      db.raw(`coalesce(sum(amount) FILTER (WHERE status IN ('prevista','contratada','exigivel')),0)::float as forecast`),
      db.raw(`coalesce(sum(amount) FILTER (WHERE status = 'paga'),0)::float as realized`),
      db.raw(`coalesce(sum(amount) FILTER (WHERE status = 'exigivel'),0)::float as receivable`),
    ).first();
  }

  const prospects = await db('land_prospects').where({ org_id: org }).select(
    db.raw(`count(*) FILTER (WHERE status = 'open')::int as open`),
    db.raw(`count(*) FILTER (WHERE status = 'converted' AND updated_at >= now() - (? * interval '1 day'))::int as converted`, [days]),
    db.raw(`count(*) FILTER (WHERE created_at >= now() - (? * interval '1 day'))::int as created`, [days]),
    db.raw(`coalesce(sum(area_m2) FILTER (WHERE status = 'open'),0)::float as open_area_m2`),
  ).first();
  const prospectsByStage = await db('land_prospects').where({ org_id: org, status: 'open' }).select('stage').count({ n: '*' }).groupBy('stage');
  res.json({
    prospects: { ...prospects, by_stage: prospectsByStage },
    period_days: days,
    areas: { ...areas, new_captures: Number(newCaptures?.n ?? 0) },
    potential_value: Number(potential?.v ?? 0), potential_vgv: Number(potential?.vgv ?? 0),
    by_uf: byUf, by_modality: byModality, by_status: byStatus,
    interests: { ...interests, by_channel: byChannel, by_broker: byBroker, by_city: byCity, weekly: weekly.rows },
    negotiations: { active: Number(negs?.n ?? 0), by_stage: byStage, proposals: Number(proposals?.n ?? 0), won: Number(won?.n ?? 0) },
    commission,
    alerts: { stale, pending_review: pending, sla_overdue: Number(slaOver?.n ?? 0), expiring_documents: expiringDocs },
  });
}));
