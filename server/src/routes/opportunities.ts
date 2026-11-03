import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { z } from 'zod';
import { LAND_TYPES, LAND_STATUS, MODALITIES, TECHNICAL_KEYS, UFS, VALIDATION_STATUS, CONFIDENTIALITY, DOC_CATEGORIES } from '@dl/shared';
import { db } from '../db/knex.js';
import { authenticate, can, requireScope } from '../auth/auth.js';
import { ah, badRequest, conflict, forbidden, notFound, parse } from '../lib/http.js';
import { audit, changed } from '../lib/audit.js';
import { encrypt } from '../lib/crypto.js';
import { newKey, processImage, sha256, signDocumentUrl, storage, validateDocument } from '../lib/storage.js';
import { buildSlug, getScopedOpportunity, internalView, loadRelations, nextCode, publicationChecklist, scopeOpportunities } from '../domain/opportunities.js';
import { parseGeoFile, saveGeometry } from '../geo/geo.js';
import { recomputeMatchesForOpportunity } from './matching.js';
import { overlapFor } from '../integrations/territory.js';
import { toKml, formatArea } from '@dl/shared';

export const router = Router();
router.use(authenticate);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 12 } });

const keys = <T extends object>(o: T) => Object.keys(o) as [string, ...string[]];
const num = z.coerce.number().finite().nonnegative().nullable().optional();

// ------------------------------------------------------------------ listagem operacional

router.get('/', ah(async (req, res) => {
  requireScope(req, 'opportunity', 'read');
  const q = req.query as Record<string, string>;
  const qb = scopeOpportunities(db('land_opportunities as o'), req)
    .leftJoin('land_commercial_terms as t', 't.opportunity_id', 'o.id')
    .leftJoin(
      db('broker_assignments as ba').join('land_brokers as b', 'b.id', 'ba.broker_id').join('users as u', 'u.id', 'b.user_id')
        .where({ 'ba.active': true, 'ba.role': 'primary' }).select('ba.opportunity_id', 'u.name as broker_name', 'b.id as broker_id').as('pb'),
      'pb.opportunity_id', 'o.id',
    );
  if (q.q) qb.where((w) => w.whereILike('o.internal_name', `%${q.q}%`).orWhereILike('o.public_title', `%${q.q}%`).orWhereILike('o.code', `%${q.q}%`).orWhereILike('o.city', `%${q.q}%`));
  if (q.status) qb.whereIn('o.status', q.status.split(','));
  if (q.publication) qb.whereIn('o.publication_status', q.publication.split(','));
  if (q.uf) qb.where('o.uf', q.uf);
  if (q.broker) qb.where('pb.broker_id', q.broker);
  if (q.stale) qb.where('o.updated_at', '<', db.raw(`now() - interval '30 days'`));
  const showPrice = can(req, 'commercial_terms', 'read');
  const rows = await qb
    .select('o.id', 'o.code', 'o.slug', 'o.internal_name', 'o.public_title', 'o.type', 'o.city', 'o.uf', 'o.area_m2', 'o.status', 'o.publication_status', 'o.visibility', 'o.featured', 'o.updated_at', 'o.created_at', 'pb.broker_name', 'pb.broker_id',
      showPrice ? 't.asking_price' : db.raw('null as asking_price'), 't.modalities')
    .orderBy(q.sort === 'code' ? 'o.code' : 'o.updated_at', q.sort === 'code' ? 'asc' : 'desc')
    .limit(Math.min(Number(q.limit ?? 200), 500));
  res.json({ items: rows });
}));

router.get('/export.csv', ah(async (req, res) => {
  requireScope(req, 'opportunity', 'export');
  const rows = await scopeOpportunities(db('land_opportunities as o'), req)
    .leftJoin('land_commercial_terms as t', 't.opportunity_id', 'o.id')
    .select('o.code', 'o.internal_name', 'o.public_title', 'o.type', 'o.city', 'o.uf', 'o.area_m2', 'o.status', 'o.publication_status', 't.asking_price', 'o.updated_at')
    .orderBy('o.code');
  await audit(req, 'export', 'land_opportunities', null, { count: rows.length });
  const head = Object.keys(rows[0] ?? { code: '' });
  const esc = (v: any) => (v == null ? '' : `"${String(v instanceof Date ? v.toISOString() : v).replace(/"/g, '""')}"`);
  res.type('text/csv').attachment('areas.csv').send('﻿' + [head.join(';'), ...rows.map((r: any) => head.map((h) => esc(r[h])).join(';'))].join('\n'));
}));

// ------------------------------------------------------------------ criação

const createSchema = z.object({
  internal_name: z.string().min(3).max(160),
  type: z.enum(keys(LAND_TYPES)),
  uf: z.enum(UFS as unknown as [string, ...string[]]),
  city: z.string().min(2).max(120),
});

router.post('/', ah(async (req, res) => {
  requireScope(req, 'opportunity', 'create');
  const body = parse(createSchema, req.body);
  const out = await db.transaction(async (trx) => {
    const code = await nextCode(trx, req.user!.orgId, body.uf);
    const [o] = await trx('land_opportunities')
      .insert({ ...body, org_id: req.user!.orgId, code, slug: buildSlug({ code, ...body }), internal_owner_id: req.user!.id, created_by: req.user!.id })
      .returning('*');
    await trx('land_commercial_terms').insert({ opportunity_id: o.id });
    await trx('publication_permissions').insert({ opportunity_id: o.id });
    await audit(req, 'create', 'land_opportunities', o.id, body, trx);
    return o;
  });
  res.status(201).json(out);
}));

// ------------------------------------------------------------------ leitura

router.get('/:id', ah(async (req, res) => {
  requireScope(req, 'opportunity', 'read');
  const o = await getScopedOpportunity(req, String(req.params.id));
  const rel = (await loadRelations([o.id])).get(o.id);
  res.json({ ...internalView(o, rel, req.user!.role, req.user!.brokerId), checklist: publicationChecklist(o, rel) });
}));

router.get('/:id/history', ah(async (req, res) => {
  requireScope(req, 'opportunity', 'update');
  const o = await getScopedOpportunity(req, String(req.params.id));
  const rows = await db('audit_logs as a').leftJoin('users as u', 'u.id', 'a.user_id')
    .where('a.entity_id', o.id).orWhere((w) => w.where('a.entity', 'like', 'land_%').whereRaw(`a.diff->>'opportunity_id' = ?`, [o.id]))
    .select('a.*', 'u.name as user_name').orderBy('a.created_at', 'desc').limit(200);
  res.json({ items: rows });
}));

// ------------------------------------------------------------------ edição (rascunho automático)

const techItem = z.object({
  value: z.any(),
  source: z.string().max(240).nullable().optional(),
  consulted_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  responsible: z.string().max(120).nullable().optional(),
  validation_status: z.enum(keys(VALIDATION_STATUS)).optional(),
});

const patchSchema = z.object({
  version: z.number().int(),
  draft_step: z.number().int().min(1).max(8).optional(),
  fields: z.object({
    internal_name: z.string().min(3).max(160),
    public_title: z.string().max(140).nullable(),
    type: z.enum(keys(LAND_TYPES)),
    city: z.string().max(120),
    uf: z.enum(UFS as unknown as [string, ...string[]]),
    neighborhood: z.string().max(120).nullable(),
    region: z.string().max(120).nullable(),
    address: z.string().max(240).nullable(),
    lat: z.number().min(-34).max(6).nullable(),
    lng: z.number().min(-75).max(-28).nullable(),
    area_m2: num, usable_area_m2: num, frontage_m: num, depth_m: num,
    topography: z.string().max(120).nullable(),
    status: z.enum(keys(LAND_STATUS)),
    visibility: z.enum(['public', 'private']),
    summary: z.string().max(400).nullable(),
    strategic_description: z.string().max(6000).nullable(),
    featured: z.boolean(),
    internal_owner_id: z.string().uuid().nullable(),
  }).partial().optional(),
  terms: z.object({
    modalities: z.array(z.enum(keys(MODALITIES))),
    asking_price: num, swap_pct: z.coerce.number().min(0).max(100).nullable().optional(), down_payment: num,
    payment_terms: z.string().max(2000).nullable(),
    expected_units: z.coerce.number().int().nonnegative().nullable().optional(),
    vgv_preliminary: num, constructive_potential_m2: num,
    commission_total_pct: z.coerce.number().min(0).max(100).nullable().optional(),
    commission_split: z.array(z.object({ party: z.string(), pct: z.number().min(0).max(100), note: z.string().optional() })),
    exclusivity: z.boolean(), exclusivity_until: z.string().nullable(),
    negotiable: z.boolean(), internal_notes: z.string().max(4000).nullable(),
  }).partial().optional(),
  publication: z.object({
    show_price: z.boolean(), show_price_per_m2: z.boolean(), show_owner: z.boolean(),
    location_precision: z.enum(['exact', 'approximate', 'region']),
    show_public_documents: z.boolean(),
    legal_basis: z.string().max(600).nullable(),
  }).partial().optional(),
  technical: z.partialRecord(z.enum(keys(TECHNICAL_KEYS)), techItem).optional(),
});

router.patch('/:id', ah(async (req, res) => {
  requireScope(req, 'opportunity', 'update');
  const body = parse(patchSchema, req.body);
  const o = await getScopedOpportunity(req, String(req.params.id), 'update');
  if (body.terms && !can(req, 'commercial_terms', 'update')) throw forbidden('Sem permissão para condições comerciais');
  if (body.terms && ('commission_total_pct' in body.terms || 'commission_split' in body.terms) && !can(req, 'commission', 'update'))
    throw forbidden('Sem permissão para comissionamento');
  if (body.fields && ('lat' in body.fields || 'lng' in body.fields || 'address' in body.fields) && !can(req, 'exact_location', 'update'))
    throw forbidden('Sem permissão para localização exata');
  if (body.publication && !can(req, 'publication', 'create')) throw forbidden('Sem permissão para configurar publicação');
  if (body.fields?.featured !== undefined && !can(req, 'publication', 'approve')) throw forbidden('Somente administradores definem destaques');

  const result = await db.transaction(async (trx) => {
    // bloqueio otimista: impede que dois rascunhos automáticos se sobrescrevam
    const fresh = await trx('land_opportunities').where({ id: o.id }).forUpdate().first();
    if (fresh.version !== body.version) throw conflict('A área foi alterada por outra pessoa. Recarregue para continuar.', { current_version: fresh.version });
    const diff: Record<string, unknown> = {};
    const upd: Record<string, any> = { version: fresh.version + 1, updated_at: trx.fn.now() };
    if (body.draft_step) upd.draft_step = Math.max(fresh.draft_step, body.draft_step);
    if (body.fields) {
      Object.assign(upd, body.fields);
      Object.assign(diff, changed(fresh, body.fields));
      if (fresh.publication_status !== 'published' && (body.fields.public_title !== undefined || body.fields.city || body.fields.type)) {
        upd.slug = buildSlug({ ...fresh, ...body.fields });
      }
    }
    await trx('land_opportunities').where({ id: o.id }).update(upd);
    if (body.terms) {
      const before = await trx('land_commercial_terms').where({ opportunity_id: o.id }).first();
      const t: any = { ...body.terms, updated_at: trx.fn.now() };
      if (t.commission_split) t.commission_split = JSON.stringify(t.commission_split);
      await trx('land_commercial_terms').where({ opportunity_id: o.id }).update(t);
      Object.assign(diff, Object.fromEntries(Object.entries(changed(before, body.terms)).map(([k, v]) => [`terms.${k}`, v])));
    }
    if (body.publication) {
      const before = await trx('publication_permissions').where({ opportunity_id: o.id }).first();
      await trx('publication_permissions').where({ opportunity_id: o.id }).update({ ...body.publication, updated_at: trx.fn.now() });
      Object.assign(diff, Object.fromEntries(Object.entries(changed(before, body.publication)).map(([k, v]) => [`publication.${k}`, v])));
    }
    if (body.technical) {
      for (const [key, item] of Object.entries(body.technical)) {
        if (!item) continue;
        await trx('land_technical_attributes')
          .insert({ opportunity_id: o.id, key, ...item, value: JSON.stringify(item.value ?? null) })
          .onConflict(['opportunity_id', 'key'])
          .merge({ ...item, value: JSON.stringify(item.value ?? null), updated_at: trx.fn.now() });
        diff[`tech.${key}`] = item;
      }
    }
    if (Object.keys(diff).length) await audit(req, 'update', 'land_opportunities', o.id, diff, trx);
    return upd.version;
  });
  if (body.technical || body.terms || body.fields?.area_m2 !== undefined) recomputeMatchesForOpportunity(o.id).catch(() => {});
  res.json({ version: result, saved_at: new Date().toISOString() });
}));

// ------------------------------------------------------------------ geometria

router.post('/:id/geometry/import', upload.single('file'), ah(async (req, res) => {
  requireScope(req, 'opportunity', 'update');
  await getScopedOpportunity(req, String(req.params.id), 'update');
  if (!req.file) throw badRequest('Envie um arquivo');
  const gj = await parseGeoFile(req.file.originalname, req.file.buffer);
  res.json({ geojson: gj, source: req.file.originalname.split('.').pop()?.toLowerCase() });
}));

router.put('/:id/geometry', ah(async (req, res) => {
  requireScope(req, 'exact_location', 'update');
  const body = parse(z.object({ geojson: z.any(), source: z.enum(['draw', 'geojson', 'json', 'kml', 'kmz', 'zip', 'shp']) }), req.body);
  const o = await getScopedOpportunity(req, String(req.params.id), 'update');
  const g = await db.transaction(async (trx) => {
    const g = await saveGeometry(trx, o.id, body.geojson, body.source === 'zip' ? 'shp' : body.source, req.user!.id);
    await trx('land_opportunities').where({ id: o.id }).increment('version', 1);
    await audit(req, 'geometry.update', 'land_geometries', g.id, { opportunity_id: o.id, area_m2: g.area_m2, version: g.version, source: body.source }, trx);
    return g;
  });
  res.json(g);
}));

router.get('/:id/kml', ah(async (req, res) => {
  requireScope(req, 'exact_location', 'read');
  const o = await getScopedOpportunity(req, String(req.params.id));
  const g = await db('land_geometries').where({ opportunity_id: o.id, is_current: true }).select(db.raw('ST_AsGeoJSON(geom, 7)::json as geometry')).first();
  const kml = toKml({ name: `${o.code} — ${o.public_title ?? o.internal_name}`, description: `Dourado Real Estate Partners. ${o.city}/${o.uf}, ${formatArea(o.area_m2)}.`, geometry: g?.geometry, point: o.lng != null ? [o.lng, o.lat] : undefined });
  await audit(req, 'export.kml', 'land_opportunities', o.id);
  res.type('application/vnd.google-earth.kml+xml').attachment(`${o.code}.kml`).send(kml);
}));

router.get('/:id/overlap', ah(async (req, res) => {
  requireScope(req, 'territory', 'read');
  const o = await getScopedOpportunity(req, String(req.params.id));
  res.json(await overlapFor({ table: 'land_geometries', id: o.id }, o.uf));
}));

// ------------------------------------------------------------------ proprietários (privado)

const ownerSchema = z.object({
  kind: z.enum(['pf', 'pj']), name: z.string().min(2).max(160),
  document: z.string().max(20).nullable().optional(),
  email: z.string().email().nullable().optional().or(z.literal('')),
  phone: z.string().max(20).nullable().optional(),
  representative: z.string().max(160).nullable().optional(),
  share_pct: z.coerce.number().min(0).max(100).nullable().optional(),
});

router.post('/:id/owners', ah(async (req, res) => {
  requireScope(req, 'owner_data', 'create');
  const o = await getScopedOpportunity(req, String(req.params.id), 'update');
  const { document, ...b } = parse(ownerSchema, req.body);
  const [row] = await db('land_owners').insert({ ...b, email: b.email || null, opportunity_id: o.id, document_enc: encrypt(document) }).returning('id');
  await audit(req, 'create', 'land_owners', row.id, { opportunity_id: o.id, name: b.name });
  res.status(201).json(row);
}));

router.delete('/:id/owners/:ownerId', ah(async (req, res) => {
  requireScope(req, 'owner_data', 'update');
  const o = await getScopedOpportunity(req, String(req.params.id), 'update');
  const n = await db('land_owners').where({ id: String(req.params.ownerId), opportunity_id: o.id }).del();
  if (!n) throw notFound('Proprietário');
  await audit(req, 'delete', 'land_owners', String(req.params.ownerId), { opportunity_id: o.id });
  res.status(204).end();
}));

// ------------------------------------------------------------------ mídia

router.post('/:id/media', upload.array('files', 12), ah(async (req, res) => {
  requireScope(req, 'opportunity', 'update');
  const o = await getScopedOpportunity(req, String(req.params.id), 'update');
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) throw badRequest('Envie ao menos uma imagem');
  const hasCover = await db('land_media').where({ opportunity_id: o.id, is_cover: true }).first();
  const base = (await db('land_media').where({ opportunity_id: o.id }).max({ m: 'sort' }).first())?.m ?? 0;
  const out = [];
  for (const [i, f] of files.entries()) {
    const img = await processImage(f.buffer);
    const key = newKey('media', 'webp');
    await storage.put(key, img.data);
    const [m] = await db('land_media').insert({ opportunity_id: o.id, storage_key: key, width: img.width, height: img.height, sort: base + i + 1, is_cover: !hasCover && i === 0 }).returning('*');
    out.push(m);
  }
  await audit(req, 'upload', 'land_media', null, { opportunity_id: o.id, count: out.length });
  res.status(201).json({ items: out });
}));

router.patch('/:id/media/:mediaId', ah(async (req, res) => {
  requireScope(req, 'opportunity', 'update');
  const o = await getScopedOpportunity(req, String(req.params.id), 'update');
  const b = parse(z.object({ caption: z.string().max(200).nullable().optional(), is_cover: z.boolean().optional(), sort: z.number().int().optional() }), req.body);
  await db.transaction(async (trx) => {
    if (b.is_cover) await trx('land_media').where({ opportunity_id: o.id }).update({ is_cover: false });
    const n = await trx('land_media').where({ id: String(req.params.mediaId), opportunity_id: o.id }).update(b);
    if (!n) throw notFound('Imagem');
  });
  res.json({ ok: true });
}));

router.delete('/:id/media/:mediaId', ah(async (req, res) => {
  requireScope(req, 'opportunity', 'update');
  const o = await getScopedOpportunity(req, String(req.params.id), 'update');
  const n = await db('land_media').where({ id: String(req.params.mediaId), opportunity_id: o.id }).del();
  if (!n) throw notFound('Imagem');
  res.status(204).end();
}));

// ------------------------------------------------------------------ documentos (versionados)

const docMeta = z.object({
  category: z.enum(keys(DOC_CATEGORIES)),
  title: z.string().min(2).max(160),
  confidentiality: z.enum(keys(CONFIDENTIALITY)).default('confidential'),
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  group_id: z.string().uuid().optional().or(z.literal('')), // presente = nova versão de um documento existente
});

router.post('/:id/documents', upload.single('file'), ah(async (req, res) => {
  const scope = requireScope(req, 'document', 'create');
  const o = await getScopedOpportunity(req, String(req.params.id), scope === 'own' ? 'read' : 'update');
  if (!req.file) throw badRequest('Envie um arquivo');
  const meta = parse(docMeta, req.body);
  // proprietário só envia como confidencial (a equipe reclassifica após validação)
  if (req.user!.role === 'owner') meta.confidentiality = 'confidential';
  const mime = await validateDocument(req.file.originalname, req.file.buffer);
  const ext = (req.file.originalname.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const key = newKey('docs', ext);
  await storage.put(key, req.file.buffer);
  const doc = await db.transaction(async (trx) => {
    let groupId = meta.group_id || null;
    let version = 1;
    if (groupId) {
      const prev = await trx('land_documents').where({ group_id: groupId, opportunity_id: o.id }).max({ v: 'version' }).first();
      if (!prev?.v) throw notFound('Documento');
      version = prev.v + 1;
      await trx('land_documents').where({ group_id: groupId }).update({ is_current: false });
    } else groupId = crypto.randomUUID();
    const [d] = await trx('land_documents').insert({
      opportunity_id: o.id, group_id: groupId, version, category: meta.category, title: meta.title,
      confidentiality: meta.confidentiality, storage_key: key, mime, original_name: req.file!.originalname.slice(0, 200),
      size: req.file!.size, sha256: sha256(req.file!.buffer), valid_until: meta.valid_until || null, uploaded_by: req.user!.id,
    }).returning('*');
    await audit(req, 'upload', 'land_documents', d.id, { opportunity_id: o.id, title: d.title, version, confidentiality: d.confidentiality }, trx);
    return d;
  });
  res.status(201).json({ ...doc, storage_key: undefined });
}));

router.patch('/:id/documents/:docId', ah(async (req, res) => {
  requireScope(req, 'document', 'update');
  const o = await getScopedOpportunity(req, String(req.params.id), 'update');
  const b = parse(z.object({ confidentiality: z.enum(keys(CONFIDENTIALITY)).optional(), title: z.string().min(2).max(160).optional(), valid_until: z.string().nullable().optional() }), req.body);
  const n = await db('land_documents').where({ id: String(req.params.docId), opportunity_id: o.id }).update({ ...b, updated_at: db.fn.now() });
  if (!n) throw notFound('Documento');
  await audit(req, 'update', 'land_documents', String(req.params.docId), { opportunity_id: o.id, ...b });
  res.json({ ok: true });
}));

router.get('/:id/documents/:groupId/versions', ah(async (req, res) => {
  requireScope(req, 'document', 'read');
  const o = await getScopedOpportunity(req, String(req.params.id));
  const rows = await db('land_documents').where({ opportunity_id: o.id, group_id: String(req.params.groupId) }).orderBy('version', 'desc')
    .select('id', 'version', 'title', 'confidentiality', 'original_name', 'size', 'sha256', 'valid_until', 'created_at', 'is_current');
  res.json({ items: rows });
}));

// ------------------------------------------------------------------ intermediadores

router.post('/:id/assignments', ah(async (req, res) => {
  requireScope(req, 'routing', 'update');
  const o = await getScopedOpportunity(req, String(req.params.id), 'update');
  const b = parse(z.object({ broker_id: z.string().uuid(), role: z.enum(['primary', 'support']).default('primary'), reason: z.string().max(240).optional() }), req.body);
  const broker = await db('land_brokers').where({ id: b.broker_id, org_id: req.user!.orgId, active: true }).first();
  if (!broker) throw notFound('Intermediador');
  await db.transaction(async (trx) => {
    if (b.role === 'primary') {
      await trx('broker_assignments').where({ opportunity_id: o.id, role: 'primary', active: true }).update({ active: false, ended_at: trx.fn.now(), reason: b.reason ?? 'Substituição' });
    }
    await trx('broker_assignments').where({ opportunity_id: o.id, broker_id: b.broker_id, active: true }).update({ active: false, ended_at: trx.fn.now() });
    await trx('broker_assignments').insert({ opportunity_id: o.id, broker_id: b.broker_id, role: b.role, assigned_by: req.user!.id, reason: b.reason });
    await audit(req, 'assign', 'broker_assignments', o.id, b, trx);
  });
  res.status(201).json({ ok: true });
}));

router.get('/:id/assignments/history', ah(async (req, res) => {
  requireScope(req, 'opportunity', 'read');
  const o = await getScopedOpportunity(req, String(req.params.id));
  const rows = await db('broker_assignments as ba').join('land_brokers as b', 'b.id', 'ba.broker_id').join('users as u', 'u.id', 'b.user_id')
    .leftJoin('users as by', 'by.id', 'ba.assigned_by')
    .where('ba.opportunity_id', o.id).select('ba.*', 'u.name as broker_name', 'by.name as assigned_by_name').orderBy('ba.created_at', 'desc');
  res.json({ items: rows });
}));

// ------------------------------------------------------------------ publicação (revisão obrigatória)

router.post('/:id/submit-review', ah(async (req, res) => {
  requireScope(req, 'publication', 'create');
  const o = await getScopedOpportunity(req, String(req.params.id), 'update');
  const rel = (await loadRelations([o.id])).get(o.id);
  const missing = publicationChecklist(o, rel);
  if (missing.length) throw badRequest('Há pendências para publicação', { missing });
  await db.transaction(async (trx) => {
    await trx('land_opportunities').where({ id: o.id }).update({ publication_status: 'pending_review', updated_at: trx.fn.now() }).increment('version', 1);
    await trx('publication_permissions').where({ opportunity_id: o.id }).update({ submitted_by: req.user!.id, submitted_at: trx.fn.now(), review_notes: null });
    await audit(req, 'publication.submit', 'land_opportunities', o.id, null, trx);
  });
  res.json({ publication_status: 'pending_review' });
}));

router.post('/:id/review', ah(async (req, res) => {
  requireScope(req, 'publication', 'approve');
  const b = parse(z.object({ decision: z.enum(['approve', 'reject']), notes: z.string().max(2000).optional() }), req.body);
  const o = await getScopedOpportunity(req, String(req.params.id), 'update');
  if (o.publication_status !== 'pending_review') throw conflict('A área não está aguardando aprovação');
  const rel = (await loadRelations([o.id])).get(o.id);
  if (b.decision === 'approve') {
    const missing = publicationChecklist(o, rel);
    if (missing.length) throw badRequest('Há pendências para publicação', { missing });
  }
  const status = b.decision === 'approve' ? 'published' : 'rejected';
  await db.transaction(async (trx) => {
    await trx('land_opportunities').where({ id: o.id }).update({
      publication_status: status,
      published_at: status === 'published' ? trx.fn.now() : o.published_at,
      status: status === 'published' && ['captacao', 'analise', 'qualificada'].includes(o.status) ? 'disponivel' : o.status,
      updated_at: trx.fn.now(),
    }).increment('version', 1);
    await trx('publication_permissions').where({ opportunity_id: o.id }).update({ reviewed_by: req.user!.id, reviewed_at: trx.fn.now(), review_notes: b.notes ?? null });
    await audit(req, `publication.${b.decision}`, 'land_opportunities', o.id, { notes: b.notes }, trx);
  });
  if (status === 'published') recomputeMatchesForOpportunity(o.id).catch(() => {});
  res.json({ publication_status: status });
}));

router.post('/:id/unpublish', ah(async (req, res) => {
  requireScope(req, 'publication', 'approve');
  const o = await getScopedOpportunity(req, String(req.params.id), 'update');
  await db('land_opportunities').where({ id: o.id }).update({ publication_status: 'unpublished', updated_at: db.fn.now() }).increment('version', 1);
  await audit(req, 'publication.unpublish', 'land_opportunities', o.id, null);
  res.json({ publication_status: 'unpublished' });
}));

// ------------------------------------------------------------------ favoritos (compradores)

router.post('/:id/favorite', ah(async (req, res) => {
  const o = await getScopedOpportunity(req, String(req.params.id));
  await db('favorites').insert({ user_id: req.user!.id, opportunity_id: o.id }).onConflict(['user_id', 'opportunity_id']).ignore();
  res.json({ favorite: true });
}));
router.delete('/:id/favorite', ah(async (req, res) => {
  const o = await getScopedOpportunity(req, String(req.params.id));
  await db('favorites').where({ user_id: req.user!.id, opportunity_id: o.id }).del();
  res.json({ favorite: false });
}));

// ------------------------------------------------------------------ documentos: URL temporária

export const documentsRouter = Router();
documentsRouter.get('/:docId/url', authenticate, ah(async (req, res) => {
  requireScope(req, 'document', 'read');
  const d = await db('land_documents').where({ id: String(req.params.docId) }).first();
  if (!d) throw notFound('Documento');
  await getScopedOpportunity(req, d.opportunity_id); // escopo da área
  const { DOC_VISIBILITY } = await import('../auth/permissions.js');
  if (!DOC_VISIBILITY[req.user!.role].includes(d.confidentiality)) throw notFound('Documento');
  await audit(req, 'document.access', 'land_documents', d.id, { opportunity_id: d.opportunity_id });
  res.json(signDocumentUrl(d.id, req.user!.id));
}));
