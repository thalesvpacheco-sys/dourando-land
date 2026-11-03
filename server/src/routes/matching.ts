import { Router, type Request } from 'express';
import { z } from 'zod';
import { scoreMatch, MODALITIES, VIABILITY, APPROVAL_STAGES, type MatchOpportunity, type MatchProfile } from '@dl/shared';
import { db } from '../db/knex.js';
import { authenticate, requireScope } from '../auth/auth.js';
import { ah, forbidden, notFound, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { getScopedOpportunity } from '../domain/opportunities.js';

export const router = Router();
router.use(authenticate);

const MIN_SCORE = 40;

async function opportunityForMatch(id: string): Promise<(MatchOpportunity & { org_id: string; id: string }) | null> {
  const o = await db('land_opportunities').where({ id }).first();
  if (!o) return null;
  const t = await db('land_commercial_terms').where({ opportunity_id: id }).first();
  const tech = await db('land_technical_attributes').where({ opportunity_id: id });
  return {
    id, org_id: o.org_id, uf: o.uf, city: o.city, area_m2: o.area_m2,
    asking_price: t?.asking_price ?? null, modalities: t?.modalities ?? [], swap_pct: t?.swap_pct ?? null,
    tech: Object.fromEntries(tech.map((x) => [x.key, { value: x.value, validation_status: x.validation_status }])),
  };
}

const toProfile = (p: any): MatchProfile => ({
  ufs: p.ufs, cities: p.cities, min_area_m2: p.min_area_m2, max_area_m2: p.max_area_m2, typologies: p.typologies,
  budget_max: p.budget_max, modalities: p.modalities, max_swap_pct: p.max_swap_pct, min_approval_stage: p.min_approval_stage, restrictions: p.restrictions ?? {},
});

async function upsertMatch(orgId: string, oppId: string, profileId: string, r: ReturnType<typeof scoreMatch>) {
  if (r.excluded || r.score < MIN_SCORE) {
    await db('opportunity_matches').where({ opportunity_id: oppId, profile_id: profileId, status: 'suggested' }).del();
    return;
  }
  await db('opportunity_matches')
    .insert({ org_id: orgId, opportunity_id: oppId, profile_id: profileId, score: r.score, confidence: r.confidence, breakdown: JSON.stringify(r) })
    .onConflict(['opportunity_id', 'profile_id'])
    .merge({ score: r.score, confidence: r.confidence, breakdown: JSON.stringify(r), updated_at: db.fn.now() });
}

export async function recomputeMatchesForOpportunity(oppId: string) {
  const o = await opportunityForMatch(oppId);
  if (!o) return;
  const profiles = await db('acquisition_profiles').where({ org_id: o.org_id, active: true });
  for (const p of profiles) await upsertMatch(o.org_id, oppId, p.id, scoreMatch(toProfile(p), o));
}

export async function recomputeMatchesForProfile(profileId: string) {
  const p = await db('acquisition_profiles').where({ id: profileId }).first();
  if (!p) return;
  const opps = await db('land_opportunities').where({ org_id: p.org_id }).whereNotIn('status', ['concluida', 'suspensa']).pluck('id');
  for (const id of opps) {
    const o = await opportunityForMatch(id);
    if (o) await upsertMatch(p.org_id, id, p.id, scoreMatch(toProfile(p), o));
  }
}

// ------------------------------------------------------------------ empresas parceiras

const partnerSchema = z.object({
  name: z.string().min(2).max(160),
  kind: z.enum(['construtora', 'incorporadora', 'loteadora', 'investidor']),
  cnpj: z.string().max(20).nullable().optional(),
  contact_name: z.string().max(160).nullable().optional(),
  contact_email: z.string().email().nullable().optional().or(z.literal('')),
  contact_phone: z.string().max(20).nullable().optional(),
});

router.get('/partners', ah(async (req, res) => {
  const scope = requireScope(req, 'partner', 'read');
  const qb = db('partner_companies as p').where('p.org_id', req.user!.dataOrgId);
  if (scope === 'own') qb.whereIn('p.id', req.user!.partnerCompanyIds);
  const rows = await qb.select('p.*',
    db('acquisition_profiles').whereRaw('partner_company_id = p.id').count().as('profiles'),
    db('negotiations').whereRaw('partner_company_id = p.id').andWhere('status', 'open').count().as('open_negotiations'),
  ).orderBy('p.name');
  res.json({ items: rows });
}));

router.post('/partners', ah(async (req, res) => {
  requireScope(req, 'partner', 'create');
  const b = parse(partnerSchema, req.body);
  const [row] = await db('partner_companies').insert({ ...b, contact_email: b.contact_email || null, org_id: req.user!.dataOrgId }).returning('*');
  await audit(req, 'create', 'partner_companies', row.id, b);
  res.status(201).json(row);
}));

router.patch('/partners/:id', ah(async (req, res) => {
  requireScope(req, 'partner', 'update');
  const b = parse(partnerSchema.partial(), req.body);
  const n = await db('partner_companies').where({ id: String(req.params.id), org_id: req.user!.dataOrgId }).update({ ...b, updated_at: db.fn.now() });
  if (!n) throw notFound('Empresa');
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ perfis de aquisição

const keys = <T extends object>(o: T) => Object.keys(o) as [string, ...string[]];
const profileSchema = z.object({
  partner_company_id: z.string().uuid(),
  name: z.string().min(2).max(160),
  ufs: z.array(z.string().length(2)).default([]),
  cities: z.array(z.string().max(120)).default([]),
  min_area_m2: z.number().nonnegative().nullable().optional(),
  max_area_m2: z.number().nonnegative().nullable().optional(),
  typologies: z.array(z.enum(keys(VIABILITY))).default([]),
  budget_max: z.number().nonnegative().nullable().optional(),
  modalities: z.array(z.enum(keys(MODALITIES))).default([]),
  max_swap_pct: z.number().min(0).max(100).nullable().optional(),
  vgv_target: z.number().nonnegative().nullable().optional(),
  min_approval_stage: z.enum(keys(APPROVAL_STAGES)).nullable().optional(),
  restrictions: z.object({ no_app: z.boolean(), require_water: z.boolean(), require_energy: z.boolean(), require_sewer: z.boolean(), urban_only: z.boolean() }).partial().default({}),
  briefing: z.string().max(4000).nullable().optional(),
  active: z.boolean().optional(),
});

function profileQuery(req: Request, action: 'read' | 'update' | 'create' | 'delete') {
  const scope = requireScope(req, 'profile', action);
  const qb = db('acquisition_profiles as ap').where('ap.org_id', req.user!.dataOrgId);
  if (scope === 'own') qb.whereIn('ap.partner_company_id', req.user!.partnerCompanyIds);
  return qb;
}

router.get('/profiles', ah(async (req, res) => {
  const rows = await profileQuery(req, 'read').join('partner_companies as p', 'p.id', 'ap.partner_company_id')
    .select('ap.*', 'p.name as partner_name', 'p.kind as partner_kind',
      db('opportunity_matches').whereRaw('profile_id = ap.id').count().as('match_count'))
    .orderBy('ap.updated_at', 'desc');
  res.json({ items: rows });
}));

router.post('/profiles', ah(async (req, res) => {
  const scope = requireScope(req, 'profile', 'create');
  const b = parse(profileSchema, req.body);
  if (scope === 'own' && !req.user!.partnerCompanyIds.includes(b.partner_company_id)) throw forbidden();
  const partner = await db('partner_companies').where({ id: b.partner_company_id, org_id: req.user!.dataOrgId }).first();
  if (!partner) throw notFound('Empresa');
  const [row] = await db('acquisition_profiles').insert({ ...b, restrictions: JSON.stringify(b.restrictions), org_id: req.user!.dataOrgId }).returning('*');
  await recomputeMatchesForProfile(row.id);
  await audit(req, 'create', 'acquisition_profiles', row.id, { name: b.name });
  res.status(201).json(row);
}));

router.patch('/profiles/:id', ah(async (req, res) => {
  const b = parse(profileSchema.partial().omit({ partner_company_id: true }), req.body);
  const p = await profileQuery(req, 'update').where('ap.id', String(req.params.id)).first();
  if (!p) throw notFound('Perfil');
  const upd: any = { ...b, updated_at: db.fn.now() };
  if (b.restrictions) upd.restrictions = JSON.stringify(b.restrictions);
  await db('acquisition_profiles').where({ id: p.id }).update(upd);
  await recomputeMatchesForProfile(p.id);
  res.json({ ok: true });
}));

router.delete('/profiles/:id', ah(async (req, res) => {
  const p = await profileQuery(req, 'delete').where('ap.id', String(req.params.id)).first();
  if (!p) throw notFound('Perfil');
  await db('acquisition_profiles').where({ id: p.id }).del();
  res.status(204).end();
}));

// ------------------------------------------------------------------ recomendações

router.get('/matches', ah(async (req, res) => {
  const scope = requireScope(req, 'match', 'read');
  const q = req.query as Record<string, string>;
  const qb = db('opportunity_matches as m')
    .join('land_opportunities as o', 'o.id', 'm.opportunity_id')
    .join('acquisition_profiles as ap', 'ap.id', 'm.profile_id')
    .join('partner_companies as p', 'p.id', 'ap.partner_company_id')
    .where('m.org_id', req.user!.dataOrgId)
    .whereNot('m.status', 'dismissed');
  if (scope === 'own') qb.whereIn('ap.partner_company_id', req.user!.partnerCompanyIds).andWhere('o.publication_status', 'published');
  if (scope === 'assigned') qb.whereExists(db('broker_assignments as ba').whereRaw('ba.opportunity_id = o.id').andWhere({ 'ba.active': true, 'ba.broker_id': req.user!.brokerId }));
  if (q.opportunity_id) qb.where('m.opportunity_id', (await getScopedOpportunity(req, q.opportunity_id)).id);
  if (q.profile_id) qb.where('m.profile_id', q.profile_id);
  const rows = await qb
    .select('m.*', 'o.code', 'o.slug', 'o.public_title', 'o.internal_name', 'o.city', 'o.uf', 'o.area_m2', 'o.publication_status', 'ap.name as profile_name', 'p.name as partner_name', 'p.id as partner_id')
    .orderBy('m.score', 'desc').limit(100);
  res.json({ items: rows });
}));

router.post('/matches/recompute', ah(async (req, res) => {
  requireScope(req, 'match', 'create');
  const opps = await db('land_opportunities').where({ org_id: req.user!.dataOrgId }).pluck('id');
  for (const id of opps) await recomputeMatchesForOpportunity(id);
  res.json({ ok: true, opportunities: opps.length });
}));

router.patch('/matches/:id', ah(async (req, res) => {
  requireScope(req, 'match', 'create');
  const b = parse(z.object({ status: z.enum(['suggested', 'sent', 'dismissed']) }), req.body);
  const n = await db('opportunity_matches').where({ id: String(req.params.id), org_id: req.user!.dataOrgId }).update({ status: b.status, updated_at: db.fn.now() });
  if (!n) throw notFound('Recomendação');
  res.json({ ok: true });
}));
