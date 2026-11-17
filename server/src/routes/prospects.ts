import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  CAPTURE_CHECKLIST, PARCEL_LAYERS, TERRITORY_LAYER_KEYS, parseCoordinates, LAND_TYPES, PROSPECT_SOURCES, PROSPECT_STAGES, UFS, VIABILITY, earthUrl, prospectScore, scoreMatch, toKml, formatArea,
  type MatchProfile,
} from '@dl/shared';
import { db } from '../db/knex.js';
import { authenticate, can, requireScope } from '../auth/auth.js';
import { ah, badRequest, conflict, notFound, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { encrypt, normalizePhone } from '../lib/crypto.js';
import { buildSlug, nextCode } from '../domain/opportunities.js';
import { saveGeometry, polygonsOf, parseGeoFile } from '../geo/geo.js';
import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });
import { environmentFor, featureById, getFeatures, layerStatus, loadedDatasets, lookupPoint, overlapFor, radarSearch, searchFeatures, toDxf } from '../integrations/territory.js';
import { recomputeMatchesForOpportunity } from './matching.js';

export const router = Router();
router.use(authenticate);

const keys = <T extends object>(o: T) => Object.keys(o) as [string, ...string[]];
const NONE = '00000000-0000-0000-0000-000000000000';

export const defaultChecklist = () => CAPTURE_CHECKLIST.map((category) => ({ category, status: 'pendente', note: null, updated_at: null }));

function scoped(req: Request, action: 'read' | 'create' | 'update' | 'delete' | 'approve') {
  const scope = requireScope(req, 'prospect', action);
  const u = req.user!;
  const qb = db('land_prospects as p').where('p.org_id', u.dataOrgId);
  if (scope === 'own') qb.andWhere((w) => w.where('p.created_by', u.id).orWhere('p.referred_by_broker_id', u.brokerId ?? NONE));
  return qb;
}
async function getProspect(req: Request, id: string, action: 'read' | 'update' | 'approve' = 'read') {
  const p = await scoped(req, action).where('p.id', id).select('p.*', db.raw('ST_AsGeoJSON(p.geom, 7)::json as geometry')).first();
  if (!p) throw notFound('Prospecção');
  return p;
}

/** Demanda: perfis de aquisição ativos que combinam com o que já se sabe da área (dados ausentes não pontuam). */
async function demandFor(orgId: string, p: any) {
  const profiles = await db('acquisition_profiles as ap').join('partner_companies as pc', 'pc.id', 'ap.partner_company_id').where({ 'ap.org_id': orgId, 'ap.active': true }).select('ap.*', 'pc.name as partner_name');
  const opp = {
    uf: p.uf, city: p.city, area_m2: p.area_m2, asking_price: p.asking_price_hint, modalities: [], swap_pct: null,
    tech: p.intended_uses?.length ? { viabilidade: { value: p.intended_uses, validation_status: 'declarado' } } : {},
  };
  return profiles.map((ap: any) => {
    const r = scoreMatch({ ufs: ap.ufs, cities: ap.cities, min_area_m2: ap.min_area_m2, max_area_m2: ap.max_area_m2, typologies: ap.typologies, budget_max: ap.budget_max,
      modalities: [], max_swap_pct: null, min_approval_stage: null, restrictions: ap.restrictions ?? {} } as MatchProfile, opp as any);
    return { profile_id: ap.id, profile: ap.name, partner: ap.partner_name, score: r.score, criteria: r.criteria, excluded: r.excluded };
  }).filter((d: any) => !d.excluded && d.score >= 45).sort((a: any, b: any) => b.score - a.score);
}

function withScore(p: any, demand: any[]) {
  const s = prospectScore({
    demand, checklist: p.checklist ?? [], hasRegistry: !!(p.matricula || p.sigef_code || p.car_code),
    hasOwnerContact: !!(p.owner_name && (p.owner_phone || p.owner_email)), hasGeometry: !!p.geometry || !!p.has_geom,
  });
  return { ...p, score: s.score, score_items: s.items };
}

// ------------------------------------------------------------------ listagem e funil

router.get('/', ah(async (req, res) => {
  const q = req.query as Record<string, string>;
  const qb = scoped(req, 'read').leftJoin('users as u', 'u.id', 'p.assigned_to');
  if (q.status) qb.whereIn('p.status', q.status.split(',')); else qb.where('p.status', 'open');
  if (q.stage) qb.whereIn('p.stage', q.stage.split(','));
  if (q.q) qb.where((w) => w.whereILike('p.title', `%${q.q}%`).orWhereILike('p.city', `%${q.q}%`).orWhereILike('p.code', `%${q.q}%`).orWhereILike('p.owner_name', `%${q.q}%`));
  const rows = await qb.select('p.id', 'p.code', 'p.title', 'p.source', 'p.stage', 'p.status', 'p.priority', 'p.uf', 'p.city', 'p.area_m2', 'p.intended_uses', 'p.owner_name', 'p.owner_phone', 'p.owner_email',
    'p.matricula', 'p.sigef_code', 'p.car_code', 'p.checklist', 'p.next_action', 'p.next_action_at', 'p.updated_at', 'p.created_at', 'p.opportunity_id', 'p.asking_price_hint',
    db.raw('p.geom IS NOT NULL as has_geom'), db.raw('ST_X(ST_PointOnSurface(p.geom)) as c_lng, ST_Y(ST_PointOnSurface(p.geom)) as c_lat'), 'p.lat', 'p.lng', 'u.name as assigned_name')
    .orderBy('p.updated_at', 'desc').limit(500);
  const orgId = req.user!.dataOrgId;
  const items = [];
  for (const r of rows) {
    const demand = await demandFor(orgId, r);
    const s = withScore(r, demand);
    if (!can(req, 'prospect', 'approve') && req.user!.role === 'broker') { delete s.owner_email; }
    items.push({ ...s, demand_count: demand.length });
  }
  res.json({ items, stages: PROSPECT_STAGES, sources: PROSPECT_SOURCES });
}));

// ------------------------------------------------------------------ criação

const createSchema = z.object({
  title: z.string().min(3).max(160),
  source: z.enum(keys(PROSPECT_SOURCES)).default('prospeccao_ativa'),
  land_type: z.enum(keys(LAND_TYPES)).nullable().optional(),
  uf: z.enum(UFS as unknown as [string, ...string[]]).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  lat: z.number().nullable().optional(), lng: z.number().nullable().optional(),
  geojson: z.any().optional(),
  territory: z.array(z.object({ layer: z.string(), source: z.string(), consulted_at: z.string(), properties: z.record(z.string(), z.any()) })).optional(),
  registry: z.record(z.string(), z.any()).nullable().optional(),
  owner_name: z.string().max(160).nullable().optional(),
  owner_phone: z.string().max(24).nullable().optional(),
  owner_email: z.string().email().nullable().optional().or(z.literal('')),
  intended_uses: z.array(z.enum(keys(VIABILITY))).default([]),
  notes: z.string().max(4000).optional(),
});

async function nextProspectCode(trx: any, orgId: string) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`prospect:${orgId}`]);
  const year = new Date().getFullYear();
  const row: any = await trx('land_prospects').where('org_id', orgId).andWhere('code', 'like', `CAP-${year}-%`).max({ m: trx.raw(`(regexp_replace(code, '^.*-', ''))::int`) }).first();
  return `CAP-${year}-${String((row?.m ?? 0) + 1).padStart(4, '0')}`;
}

export async function createProspect(trx: any, orgId: string, userId: string | null, b: any) {
  const code = await nextProspectCode(trx, orgId);
  const terr = b.territory ?? [];
  const sigef = terr.find((t: any) => t.layer === 'sigef')?.properties;
  const car = terr.find((t: any) => t.layer === 'car')?.properties;
  const [p] = await trx('land_prospects').insert({
    org_id: orgId, code, title: b.title, source: b.source ?? 'prospeccao_ativa', land_type: b.land_type ?? null, uf: b.uf ?? null, city: b.city ?? null,
    lat: b.lat ?? null, lng: b.lng ?? null, intended_uses: b.intended_uses ?? [],
    owner_name: b.owner_name || null, owner_phone: normalizePhone(b.owner_phone) ?? (b.owner_phone || null), owner_email: b.owner_email || null, owner_notes: b.notes ?? null,
    legal_basis: b.legal_basis ?? (b.owner_name ? 'legitimo_interesse' : null),
    sigef_code: sigef?.codigo ?? null, car_code: car?.codigo ?? null,
    matricula: b.registry?.matriculas?.[0] ?? sigef?.matricula ?? null, cns_serventia: b.registry?.cns_serventia ?? sigef?.cns_serventia ?? null,
    cartorio: b.registry?.cartorio ?? null,
    territory_snapshot: JSON.stringify([...terr, ...(b.registry ? [{ layer: 'onr', source: b.registry.source, consulted_at: b.registry.consulted_at, properties: b.registry }] : [])]),
    checklist: JSON.stringify(defaultChecklist()), assigned_to: b.assigned_to ?? userId, referred_by_broker_id: b.referred_by_broker_id ?? null, created_by: userId,
    next_action: b.owner_name ? 'Primeiro contato com o proprietário' : 'Identificar proprietário', next_action_at: trx.raw(`now() + interval '2 days'`),
  }).returning('*');
  if (b.geojson) {
    const polys = polygonsOf(b.geojson);
    if (polys.length) {
      await trx.raw(
        `UPDATE land_prospects SET geom = sub.g, area_m2 = ST_Area(sub.g::geography), lat = ST_Y(ST_PointOnSurface(sub.g)), lng = ST_X(ST_PointOnSurface(sub.g))
         FROM (SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Union(ST_SetSRID(ST_GeomFromGeoJSON(x), 4326))), 3)) AS g FROM unnest(?::text[]) x) sub WHERE id = ?`,
        [polys.map((x) => JSON.stringify(x)), p.id],
      );
    }
  }
  await trx('activities').insert({ org_id: orgId, prospect_id: p.id, type: 'system', subject: `Prospecção criada (${PROSPECT_SOURCES[p.source as keyof typeof PROSPECT_SOURCES]})`, body: b.notes ?? null, user_id: userId });
  return p;
}

router.post('/', ah(async (req, res) => {
  requireScope(req, 'prospect', 'create');
  const b = parse(createSchema, req.body);
  const p = await db.transaction(async (trx) => {
    const extra = req.user!.role === 'broker' ? { referred_by_broker_id: req.user!.brokerId, source: 'indicacao_parceiro', assigned_to: null } : {};
    const p = await createProspect(trx, req.user!.dataOrgId, req.user!.id, { ...b, ...extra });
    await audit(req, 'create', 'land_prospects', p.id, { title: b.title, source: b.source }, trx);
    return p;
  });
  res.status(201).json(p);
}));

// ------------------------------------------------------------------ detalhe

router.get('/:id', ah(async (req, res) => {
  const p = await getProspect(req, String(req.params.id));
  const demand = await demandFor(req.user!.dataOrgId, p);
  const activities = await db('activities as a').leftJoin('users as u', 'u.id', 'a.user_id').where('a.prospect_id', p.id).select('a.*', 'u.name as user_name').orderBy('a.created_at', 'desc');
  const assigned = p.assigned_to ? await db('users').where({ id: p.assigned_to }).select('id', 'name').first() : null;
  const broker = p.referred_by_broker_id ? await db('land_brokers as b').join('users as u', 'u.id', 'b.user_id').where('b.id', p.referred_by_broker_id).select('b.id', 'u.name').first() : null;
  const center = p.lat != null ? { lat: p.lat, lng: p.lng } : null;
  res.json({
    ...withScore(p, demand), demand, activities, assigned, referred_by: broker,
    links: center ? { earth: earthUrl(center.lat, center.lng, p.area_m2 ? Math.max(800, Math.sqrt(p.area_m2) * 4) : 2500), onr: 'https://mapa.onr.org.br/' } : null,
    permissions: { update: can(req, 'prospect', 'update'), convert: can(req, 'prospect', 'approve') },
  });
}));

const patchSchema = z.object({
  version: z.number().int(),
  title: z.string().min(3).max(160).optional(),
  stage: z.enum(keys(PROSPECT_STAGES)).optional(),
  priority: z.enum(['alta', 'media', 'baixa']).optional(),
  land_type: z.enum(keys(LAND_TYPES)).nullable().optional(),
  uf: z.enum(UFS as unknown as [string, ...string[]]).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  region: z.string().max(120).nullable().optional(),
  intended_uses: z.array(z.enum(keys(VIABILITY))).optional(),
  asking_price_hint: z.number().nonnegative().nullable().optional(),
  owner_name: z.string().max(160).nullable().optional(),
  owner_phone: z.string().max(24).nullable().optional(),
  owner_email: z.string().email().nullable().optional().or(z.literal('')),
  owner_notes: z.string().max(4000).nullable().optional(),
  matricula: z.string().max(60).nullable().optional(),
  cartorio: z.string().max(160).nullable().optional(),
  cns_serventia: z.string().max(20).nullable().optional(),
  sigef_code: z.string().max(80).nullable().optional(),
  car_code: z.string().max(80).nullable().optional(),
  ccir: z.string().max(40).nullable().optional(),
  checklist: z.array(z.object({ category: z.string(), status: z.enum(['pendente', 'solicitado', 'recebido', 'nao_aplicavel']), note: z.string().max(300).nullable().optional(), updated_at: z.string().nullable().optional() })).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  next_action: z.string().max(200).nullable().optional(),
  next_action_at: z.string().nullable().optional(),
});

router.patch('/:id', ah(async (req, res) => {
  const b = parse(patchSchema, req.body);
  const p = await getProspect(req, String(req.params.id), 'update');
  if (p.status !== 'open') throw conflict('Prospecção encerrada');
  if (p.version !== b.version) throw conflict('A prospecção foi alterada por outra pessoa. Recarregue.', { current_version: p.version });
  const { version, ...upd } = b;
  const row: any = { ...upd, version: p.version + 1, updated_at: db.fn.now() };
  if (b.owner_phone !== undefined) row.owner_phone = normalizePhone(b.owner_phone) ?? b.owner_phone;
  if (b.owner_email === '') row.owner_email = null;
  if (b.checklist) row.checklist = JSON.stringify(b.checklist.map((c) => ({ ...c, updated_at: c.updated_at ?? new Date().toISOString() })));
  await db.transaction(async (trx) => {
    await trx('land_prospects').where({ id: p.id }).update(row);
    if (b.stage && b.stage !== p.stage) {
      await trx('activities').insert({ org_id: p.org_id, prospect_id: p.id, type: 'stage_change', subject: `${PROSPECT_STAGES[p.stage as keyof typeof PROSPECT_STAGES]} → ${PROSPECT_STAGES[b.stage as keyof typeof PROSPECT_STAGES]}`, user_id: req.user!.id });
    }
    await audit(req, 'update', 'land_prospects', p.id, Object.keys(upd), trx);
  });
  res.json({ version: p.version + 1 });
}));

router.post('/:id/geometry/import', upload.single('file'), ah(async (req, res) => {
  await getProspect(req, String(req.params.id), 'update');
  if (!req.file) throw badRequest('Envie um arquivo');
  res.json({ geojson: await parseGeoFile(req.file.originalname, req.file.buffer), source: req.file.originalname.split('.').pop()?.toLowerCase() });
}));

router.put('/:id/geometry', ah(async (req, res) => {
  const b = parse(z.object({ geojson: z.any(), source: z.string().max(20) }), req.body);
  const p = await getProspect(req, String(req.params.id), 'update');
  const polys = polygonsOf(b.geojson);
  if (!polys.length) throw badRequest('Nenhum polígono encontrado');
  const { rows } = await db.raw(
    `UPDATE land_prospects SET geom = sub.g, area_m2 = ST_Area(sub.g::geography), lat = ST_Y(ST_PointOnSurface(sub.g)), lng = ST_X(ST_PointOnSurface(sub.g)), version = version + 1, updated_at = now()
     FROM (SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Union(ST_SetSRID(ST_GeomFromGeoJSON(x), 4326))), 3)) AS g FROM unnest(?::text[]) x) sub WHERE id = ? RETURNING area_m2, version`,
    [polys.map((x) => JSON.stringify(x)), p.id],
  );
  await audit(req, 'geometry.update', 'land_prospects', p.id, { source: b.source, area_m2: rows[0].area_m2 });
  res.json(rows[0]);
}));

router.post('/:id/activities', ah(async (req, res) => {
  const b = parse(z.object({ type: z.enum(['note', 'call', 'meeting', 'visit', 'whatsapp', 'email', 'task']), subject: z.string().min(2).max(200), body: z.string().max(4000).optional() }), req.body);
  const p = await getProspect(req, String(req.params.id), 'update');
  const [a] = await db('activities').insert({ org_id: p.org_id, prospect_id: p.id, ...b, done_at: db.fn.now(), user_id: req.user!.id }).returning('*');
  await db('land_prospects').where({ id: p.id }).update({ updated_at: db.fn.now() });
  res.status(201).json(a);
}));

router.post('/:id/discard', ah(async (req, res) => {
  const b = parse(z.object({ reason: z.string().min(3).max(240) }), req.body);
  const p = await getProspect(req, String(req.params.id), 'update');
  await db('land_prospects').where({ id: p.id }).update({ status: 'discarded', discard_reason: b.reason, updated_at: db.fn.now(), version: p.version + 1 });
  await db('activities').insert({ org_id: p.org_id, prospect_id: p.id, type: 'system', subject: `Prospecção descartada: ${b.reason}`, user_id: req.user!.id });
  res.json({ ok: true });
}));

router.get('/:id/overlap', ah(async (req, res) => {
  const p = await getProspect(req, String(req.params.id));
  res.json(await overlapFor({ table: 'land_prospects', id: p.id }, p.uf));
}));

router.get('/:id/environment', ah(async (req, res) => {
  requireScope(req, 'territory', 'read');
  const p = await getProspect(req, String(req.params.id));
  res.json(await environmentFor({ table: 'land_prospects', id: p.id }));
}));

router.get('/:id/dxf', ah(async (req, res) => {
  const p = await getProspect(req, String(req.params.id));
  if (!p.geometry) throw badRequest('Sem perímetro cadastrado');
  const dxf = await toDxf({ sql: 'SELECT geom FROM land_prospects WHERE id = ?', bindings: [p.id] }, p.code);
  await audit(req, 'export.dxf', 'land_prospects', p.id);
  res.type('application/dxf').attachment(`${p.code}.dxf`).send(dxf);
}));

router.get('/:id/kml', ah(async (req, res) => {
  const p = await getProspect(req, String(req.params.id));
  const kml = toKml({ name: `${p.code} — ${p.title}`, description: `Prospecção Quero Área. ${p.city ?? ''}/${p.uf ?? ''} ${p.area_m2 ? formatArea(p.area_m2) : ''}`, geometry: p.geometry, point: p.lng != null ? [p.lng, p.lat] : undefined });
  await audit(req, 'export.kml', 'land_prospects', p.id);
  res.type('application/vnd.google-earth.kml+xml').attachment(`${p.code}.kml`).send(kml);
}));

/** Converte a prospecção em área do banco (rascunho), levando perímetro, proprietário e a identificação registral com fonte. */
router.post('/:id/convert', ah(async (req, res) => {
  requireScope(req, 'prospect', 'approve');
  requireScope(req, 'opportunity', 'create');
  const p = await getProspect(req, String(req.params.id), 'approve');
  if (p.status !== 'open') throw conflict('Prospecção já encerrada');
  const missing = [!p.uf && 'UF', !p.city && 'Cidade', !p.land_type && 'Tipo da área', !p.owner_name && 'Proprietário', !(p.geometry || p.lat != null) && 'Localização ou perímetro'].filter(Boolean);
  if (missing.length) throw badRequest('Complete a prospecção antes de converter', { missing });
  const o = await db.transaction(async (trx) => {
    const code = await nextCode(trx, req.user!.orgId, p.uf);
    const [o] = await trx('land_opportunities').insert({
      org_id: req.user!.orgId, code, slug: buildSlug({ code, type: p.land_type, city: p.city }), internal_name: p.title, type: p.land_type, uf: p.uf, city: p.city, region: p.region,
      lat: p.lat, lng: p.lng, area_m2: p.area_m2 ? Math.round(p.area_m2) : null, status: 'captacao', internal_owner_id: req.user!.id, created_by: req.user!.id,
    }).returning('*');
    const notes = [`Origem: captação ${p.code} (${PROSPECT_SOURCES[p.source as keyof typeof PROSPECT_SOURCES]}).`,
      p.matricula && `Matrícula ${p.matricula}${p.cartorio ? ` — ${p.cartorio}` : ''}${p.cns_serventia ? ` (CNS ${p.cns_serventia})` : ''}.`,
      p.sigef_code && `SIGEF ${p.sigef_code}.`, p.car_code && `CAR ${p.car_code}.`].filter(Boolean).join(' ');
    await trx('land_commercial_terms').insert({ opportunity_id: o.id, asking_price: p.asking_price_hint, internal_notes: notes });
    await trx('publication_permissions').insert({ opportunity_id: o.id });
    if (p.geometry) await saveGeometry(trx, o.id, p.geometry, 'draw', req.user!.id);
    await trx('land_owners').insert({ opportunity_id: o.id, kind: 'pf', name: p.owner_name, email: p.owner_email, phone: p.owner_phone, document_enc: encrypt(null) });
    if (p.intended_uses?.length) {
      await trx('land_technical_attributes').insert({ opportunity_id: o.id, key: 'viabilidade', value: JSON.stringify(p.intended_uses), source: `Captação ${p.code}`, responsible: req.user!.name, validation_status: 'declarado', consulted_at: new Date().toISOString().slice(0, 10) });
    }
    const sig = (p.territory_snapshot ?? []).find((t: any) => t.layer === 'sigef');
    if (sig) {
      await trx('land_technical_attributes').insert({ opportunity_id: o.id, key: 'situacao', value: JSON.stringify('rural'), source: sig.source, consulted_at: String(sig.consulted_at).slice(0, 10), responsible: req.user!.name, validation_status: sig.properties?.ficticio ? 'nao_verificado' : 'oficial' });
    }
    if (p.referred_by_broker_id) await trx('broker_assignments').insert({ opportunity_id: o.id, broker_id: p.referred_by_broker_id, role: 'primary', assigned_by: req.user!.id, reason: 'Parceiro que indicou a área' });
    // documentos trazidos pela importação do inventário entram na área agora
    const { attachPendingImportFiles } = await import('../import/apply.js');
    await attachPendingImportFiles(trx, p.id, o.id, req.user!.id);
    await trx('land_prospects').where({ id: p.id }).update({ status: 'converted', opportunity_id: o.id, stage: 'contratada', updated_at: trx.fn.now(), version: p.version + 1 });
    await trx('activities').insert({ org_id: p.org_id, prospect_id: p.id, opportunity_id: o.id, type: 'system', subject: `Convertida na área ${code}`, user_id: req.user!.id });
    await audit(req, 'prospect.convert', 'land_prospects', p.id, { opportunity_id: o.id, code }, trx);
    return o;
  });
  recomputeMatchesForOpportunity(o.id).catch(() => {});
  res.status(201).json({ opportunity_id: o.id, code: o.code });
}));

// ------------------------------------------------------------------ camadas territoriais

export const territoryRouter = Router();
territoryRouter.use(authenticate);

territoryRouter.get('/layers', ah(async (req, res) => {
  requireScope(req, 'territory', 'read');
  res.json(layerStatus(await loadedDatasets()));
}));

territoryRouter.get('/features', ah(async (req, res) => {
  requireScope(req, 'territory', 'read');
  const q = parse(z.object({ layer: z.enum(TERRITORY_LAYER_KEYS as [string, ...string[]]), bbox: z.string(), uf: z.string().length(2).optional() }), req.query);
  const b = q.bbox.split(',').map(Number);
  if (b.length !== 4 || !b.every(Number.isFinite)) throw badRequest('bbox inválido');
  try {
    res.json(await getFeatures(q.layer, b as any, q.uf ?? null));
  } catch (e: any) {
    res.status(e.status ?? 502).json({ error: e.message });
  }
}));

// Busca única: coordenadas (decimal, GMS, UTM), códigos das bases oficiais e áreas já cadastradas
territoryRouter.get('/search', ah(async (req, res) => {
  requireScope(req, 'territory', 'read');
  const q = parse(z.object({ q: z.string().min(2).max(120), uf: z.string().length(2).optional() }), req.query);
  const point = parseCoordinates(q.q);
  if (point) return void res.json({ point, features: [], internal: [] });
  const features = await searchFeatures(q.q, q.uf ?? null);
  const clean = q.q.trim().replace(/[%_\\]/g, '');
  if (clean.length < 2) return void res.json({ point: null, features, internal: [] });
  const like = `%${clean}%`;
  const scope = requireScope(req, 'prospect', 'read');
  const prospects = db('land_prospects').where({ org_id: req.user!.dataOrgId }).where((w) => w.whereILike('code', like).orWhereILike('title', like))
    .select(db.raw(`'prospect' as kind`), 'id', 'code', 'title', 'city', 'uf', 'lat', 'lng').limit(10);
  if (scope === 'own') prospects.andWhere((w) => w.where('created_by', req.user!.id).orWhere('referred_by_broker_id', req.user!.brokerId ?? NONE));
  const items: any[] = await prospects;
  if (can(req, 'exact_location', 'read')) {
    items.push(...await db('land_opportunities').where({ org_id: req.user!.dataOrgId }).where((w) => w.whereILike('code', like).orWhereILike('internal_name', like))
      .select(db.raw(`'opportunity' as kind`), 'id', 'code', 'internal_name as title', 'city', 'uf', 'lat', 'lng').limit(10));
  }
  res.json({ point: null, features, internal: items });
}));

territoryRouter.get('/radar', ah(async (req, res) => {
  requireScope(req, 'prospect', 'create');
  const q = parse(z.object({
    uf: z.string().length(2).optional(), municipio: z.string().max(120).optional(), min_ha: z.coerce.number().min(0).optional(), max_ha: z.coerce.number().min(0).optional(),
    layer: z.enum(PARCEL_LAYERS as [string, ...string[]]).default('sigef'), exclude_restrictions: z.enum(['0', '1']).default('1'), profile_id: z.string().uuid().optional(),
  }), req.query);
  const orgId = req.user!.dataOrgId;
  let { uf, min_ha, max_ha } = q;
  let municipios = q.municipio ? [q.municipio.trim()] : undefined;
  if (q.profile_id) {
    const ap = await db('acquisition_profiles').where({ id: q.profile_id, org_id: orgId }).first();
    if (!ap) throw notFound('Perfil de aquisição');
    uf ??= ap.ufs?.[0];
    municipios ??= ap.cities?.length ? ap.cities : undefined;
    min_ha ??= ap.min_area_m2 != null ? ap.min_area_m2 / 10000 : undefined;
    max_ha ??= ap.max_area_m2 != null ? ap.max_area_m2 / 10000 : undefined;
  }
  if (!uf) throw badRequest('Informe a UF');
  const r = await radarSearch({ uf, municipios, min_ha, max_ha, layer: q.layer, exclude_restrictions: q.exclude_restrictions === '1', orgId, limit: 100 });
  // demanda: quantos perfis ativos combinam com cada candidata
  const items = [];
  for (const f of r.items) {
    const p = f.properties;
    const demand = await demandFor(orgId, { uf: p.uf, city: p.municipio, area_m2: p.area_ha != null ? p.area_ha * 10000 : null, asking_price_hint: null, intended_uses: [] });
    const compatible = demand.filter((d: any) => !d.excluded && d.score >= 40);
    items.push({ ...f, demand: compatible.slice(0, 3).map((d: any) => ({ profile: d.profile, partner: d.partner, score: d.score })), demand_count: compatible.length });
  }
  items.sort((a, b) => b.demand_count - a.demand_count || (b.properties.area_ha ?? 0) - (a.properties.area_ha ?? 0));
  res.json({ ...r, filter: { uf, municipios, min_ha, max_ha, layer: q.layer }, items });
}));

territoryRouter.get('/features/:id/dxf', ah(async (req, res) => {
  requireScope(req, 'territory', 'read');
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw notFound('Parcela');
  const f = await featureById(id);
  if (!f) throw notFound('Parcela');
  const dxf = await toDxf({ sql: 'SELECT geom FROM territory_features WHERE id = ?', bindings: [id] }, `${f.layer}_${f.code ?? id}`);
  await audit(req, 'export.dxf', 'territory_features', null, { id, layer: f.layer, code: f.code });
  res.type('application/dxf').attachment(`${f.layer}-${String(f.code ?? id).slice(0, 40)}.dxf`).send(dxf);
}));

territoryRouter.get('/features/:id/kml', ah(async (req, res) => {
  requireScope(req, 'territory', 'read');
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw notFound('Parcela');
  const f = await featureById(id);
  if (!f) throw notFound('Parcela');
  await audit(req, 'export.kml', 'territory_features', null, { id, layer: f.layer, code: f.code });
  res.type('application/vnd.google-earth.kml+xml').attachment(`${f.layer}-${String(f.code ?? id).slice(0, 40)}.kml`).send(toKml({ name: f.name ?? f.code ?? `Parcela ${id}`, description: `${f.layer.toUpperCase()} ${f.code ?? ''}`, geometry: f.geometry }));
}));

territoryRouter.get('/lookup', ah(async (req, res) => {
  requireScope(req, 'territory', 'read');
  const q = parse(z.object({ lat: z.coerce.number().min(-34).max(6), lng: z.coerce.number().min(-75).max(-28), uf: z.string().length(2).optional() }), req.query);
  const r = await lookupPoint(q.lat, q.lng, q.uf ?? null);
  // prospecções e áreas já existentes no ponto (evita captação duplicada)
  const { rows } = await db.raw(
    `SELECT 'prospect' AS kind, id, code, title, status FROM land_prospects WHERE org_id = ? AND geom IS NOT NULL AND ST_Contains(geom, ST_SetSRID(ST_MakePoint(?, ?), 4326))
     UNION ALL
     SELECT 'opportunity', o.id, o.code, coalesce(o.public_title, o.internal_name), o.status FROM land_geometries g JOIN land_opportunities o ON o.id = g.opportunity_id
     WHERE o.org_id = ? AND g.is_current AND ST_Contains(g.geom, ST_SetSRID(ST_MakePoint(?, ?), 4326))`,
    [req.user!.dataOrgId, q.lng, q.lat, req.user!.dataOrgId, q.lng, q.lat],
  );
  res.json({ ...r, existing: rows });
}));
