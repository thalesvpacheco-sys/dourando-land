import { Router, type Request } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { APPROVAL_ORDER, buildWhatsAppMessage, LAND_TYPES, MODALITIES, VIABILITY, type ApprovalStage } from '@dl/shared';
import { db } from '../db/knex.js';
import { config } from '../config.js';
import { optionalAuth } from '../auth/auth.js';
import { grant } from '../auth/permissions.js';
import { ah, badRequest, notFound, parse } from '../lib/http.js';
import { hashIp, intentToken, normalizePhone } from '../lib/crypto.js';
import { signDocumentUrl, storage, verifyDocumentToken } from '../lib/storage.js';
import { audit } from '../lib/audit.js';
import { loadRelations, publicView } from '../domain/opportunities.js';
import { routeInterest } from '../integrations/routing.js';
import { enqueue, processOutbox } from '../integrations/crm.js';

export const router = Router();
router.use(optionalAuth);

const interestLimiter = rateLimit({ windowMs: 60_000, limit: config.isTest ? 1000 : 12, standardHeaders: true, legacyHeaders: false });

/** Vitrine visível: publicadas e públicas; usuários logados com acesso à vitrine veem também as privadas. */
function visible(req: Request) {
  const qb = db('land_opportunities as o').where('o.publication_status', 'published');
  const seesPrivate = req.user && grant(req.user.role, 'opportunity', 'read');
  if (!seesPrivate) qb.andWhere('o.visibility', 'public');
  return qb;
}

const csv = (v?: string) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

function applyFilters(qb: ReturnType<typeof visible>, q: Record<string, string>) {
  qb.leftJoin('land_commercial_terms as t', 't.opportunity_id', 'o.id').leftJoin('publication_permissions as pp', 'pp.opportunity_id', 'o.id');
  if (q.q) qb.where((w) => w.whereILike('o.public_title', `%${q.q}%`).orWhereILike('o.city', `%${q.q}%`).orWhereILike('o.code', `%${q.q}%`).orWhereILike('o.region', `%${q.q}%`).orWhereILike('o.summary', `%${q.q}%`));
  if (q.uf) qb.whereIn('o.uf', csv(q.uf));
  if (q.city) qb.whereRaw('lower(o.city) = lower(?)', [q.city]);
  if (q.region) qb.whereILike('o.region', `%${q.region}%`);
  if (q.type) qb.whereIn('o.type', csv(q.type));
  if (q.status) qb.whereIn('o.status', csv(q.status));
  else qb.whereNotIn('o.status', ['concluida', 'suspensa']);
  if (q.area_min) qb.where('o.area_m2', '>=', Number(q.area_min));
  if (q.area_max) qb.where('o.area_m2', '<=', Number(q.area_max));
  // Filtros de valor só consideram áreas com valor público — não vazamos preço oculto por inferência.
  if (q.price_min || q.price_max) {
    qb.where('pp.show_price', true);
    if (q.price_min) qb.where('t.asking_price', '>=', Number(q.price_min));
    if (q.price_max) qb.where('t.asking_price', '<=', Number(q.price_max));
  }
  if (q.ppm2_min || q.ppm2_max) {
    qb.where('pp.show_price_per_m2', true).whereNotNull('o.area_m2');
    if (q.ppm2_min) qb.whereRaw('t.asking_price / nullif(o.area_m2,0) >= ?', [Number(q.ppm2_min)]);
    if (q.ppm2_max) qb.whereRaw('t.asking_price / nullif(o.area_m2,0) <= ?', [Number(q.ppm2_max)]);
  }
  if (q.modality) qb.whereRaw('t.modalities && ?::text[]', [csv(q.modality)]);
  const tech = (key: string, cond: string, bindings: any[]) =>
    qb.whereExists(db('land_technical_attributes as ta').whereRaw('ta.opportunity_id = o.id').andWhere('ta.key', key).andWhereRaw(cond, bindings));
  if (q.viability) tech('viabilidade', `ta.value \\?| ?::text[]`, [csv(q.viability)]);
  if (q.approval) {
    const idx = APPROVAL_ORDER.indexOf(q.approval as ApprovalStage);
    if (idx >= 0) tech('estagio_aprovacao', `ta.value #>> '{}' = ANY(?::text[])`, [APPROVAL_ORDER.slice(idx)]);
  }
  for (const k of csv(q.infra)) if (['agua', 'energia', 'esgoto'].includes(k)) tech(k, `ta.value = 'true'::jsonb`, []);
  if (q.featured === '1') qb.where('o.featured', true);
  if (q.bbox) {
    const b = csv(q.bbox).map(Number);
    if (b.length === 4 && b.every(Number.isFinite)) {
      qb.whereExists(db('land_geometries as g').whereRaw('g.opportunity_id = o.id AND g.is_current AND g.public_point && ST_MakeEnvelope(?,?,?,?,4326)', b));
    }
  }
  return qb;
}

router.get('/opportunities', ah(async (req, res) => {
  const q = req.query as Record<string, string>;
  const page = Math.max(1, Number(q.page ?? 1));
  const per = Math.min(48, Number(q.per ?? 24));
  const base = applyFilters(visible(req), q);
  const [{ count }] = await base.clone().clearSelect().count({ count: 'o.id' });
  const order: Record<string, [string, string]> = {
    recent: ['o.published_at', 'desc'], area_desc: ['o.area_m2', 'desc'], area_asc: ['o.area_m2', 'asc'],
  };
  const [col, dir] = order[q.sort] ?? ['o.featured', 'desc'];
  const rows = await base.select('o.*').orderBy(col, dir).orderBy('o.published_at', 'desc').limit(per).offset((page - 1) * per);
  const rel = await loadRelations(rows.map((r) => r.id));
  res.json({ total: Number(count), page, per, items: rows.map((o) => publicView(o, rel.get(o.id))) });
}));

router.get('/map', ah(async (req, res) => {
  const rows = await applyFilters(visible(req), req.query as Record<string, string>).select('o.*').limit(1000);
  const rel = await loadRelations(rows.map((r) => r.id));
  const features = rows
    .map((o) => publicView(o, rel.get(o.id)))
    .filter((v) => v.location?.point)
    .map((v) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: v.location!.point },
      properties: {
        code: v.code, slug: v.slug, title: v.title, city: v.city, uf: v.uf, area_m2: v.area_m2, type: v.type,
        precision: v.location!.precision, radius_m: v.location!.radius_m, cover: v.media[0]?.url ?? null,
        modalities: v.commercial.modalities.join(','), polygon: (v.location as any).polygon ? JSON.stringify((v.location as any).polygon) : null,
      },
    }));
  res.json({ type: 'FeatureCollection', features });
}));

router.get('/meta', ah(async (req, res) => {
  const base = visible(req).whereNotIn('o.status', ['concluida', 'suspensa']);
  const [ufs, cities, types, totals] = await Promise.all([
    base.clone().select('o.uf').count({ n: '*' }).groupBy('o.uf').orderBy('o.uf'),
    base.clone().select('o.city', 'o.uf').count({ n: '*' }).groupBy('o.city', 'o.uf').orderBy('o.city'),
    base.clone().select('o.type').count({ n: '*' }).groupBy('o.type'),
    base.clone().select(db.raw('count(*)::int as n, coalesce(sum(o.area_m2),0)::float as area, count(distinct o.city)::int as cities')).first(),
  ]);
  // Número central do atendimento (Atendimento e WhatsApp). Sem número configurado, o portal não mostra o botão.
  const org = await db('organizations').where({ kind: 'manager' }).orderBy('created_at').select('central_whatsapp').first();
  res.json({ ufs, cities, types, totals, central_whatsapp: normalizePhone(org?.central_whatsapp) || null, labels: { types: LAND_TYPES, modalities: MODALITIES, viability: VIABILITY } });
}));

async function findBySlug(req: Request, slug: string) {
  const m = /^([a-z]{2,6}-[a-z]{2}-\d{4})/i.exec(slug);
  if (!m) throw notFound('Oportunidade');
  const o = await visible(req).where('o.code', m[1].toUpperCase()).select('o.*').first();
  if (!o) throw notFound('Oportunidade');
  return o;
}

router.get('/opportunities/:slug', ah(async (req, res) => {
  const o = await findBySlug(req, String(req.params.slug));
  const rel = (await loadRelations([o.id])).get(o.id);
  const view = publicView(o, rel);
  const sim = await visible(req)
    .whereNot('o.id', o.id).whereNotIn('o.status', ['concluida', 'suspensa'])
    .andWhere((w) => w.where('o.uf', o.uf).orWhere('o.type', o.type))
    .select('o.*', db.raw('(CASE WHEN o.city = ? THEN 2 ELSE 0 END + CASE WHEN o.type = ? THEN 2 ELSE 0 END + CASE WHEN o.uf = ? THEN 1 ELSE 0 END) as rel', [o.city, o.type, o.uf]))
    .orderBy('rel', 'desc').limit(4);
  const srel = await loadRelations(sim.map((s) => s.id));
  let favorite = false;
  if (req.user) favorite = !!(await db('favorites').where({ user_id: req.user.id, opportunity_id: o.id }).first());
  res.json({ ...view, canonical_slug: o.slug, similar: sim.map((s) => publicView(s, srel.get(s.id))), favorite });
}));

// ------------------------------------------------------------------ interesse → CRM → WhatsApp

const interestSchema = z.object({
  kind: z.enum(['whatsapp', 'form']),
  name: z.string().trim().max(120).optional().or(z.literal('')),
  email: z.string().trim().email().max(160).optional().or(z.literal('')),
  phone: z.string().trim().max(24).optional().or(z.literal('')),
  company: z.string().trim().max(160).optional().or(z.literal('')),
  message: z.string().trim().max(2000).optional().or(z.literal('')),
  consent: z.boolean().optional(),
  channel: z.string().max(60).optional(),
  attribution: z.record(z.string(), z.string().max(300)).optional(),
});

const ATTR_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id', 'referrer', 'landing_url'];

function deriveChannel(a: Record<string, string>) {
  if (a.gclid || a.gbraid || a.wbraid) return 'google_ads';
  if (a.fbclid) return a.utm_medium?.includes('paid') || a.utm_medium === 'cpc' ? 'meta_ads' : 'social';
  if (a.utm_medium) return a.utm_medium.toLowerCase();
  if (a.referrer && !/wingsbr|dourado|localhost/.test(a.referrer)) return 'referral';
  return 'direct';
}

router.post('/opportunities/:slug/interest', interestLimiter, ah(async (req, res) => {
  const b = parse(interestSchema, req.body);
  const o = await findBySlug(req, String(req.params.slug));
  const attribution: Record<string, string> = Object.fromEntries(Object.entries(b.attribution ?? {}).filter(([k]) => ATTR_KEYS.includes(k)));

  // Recupera dados do usuário logado; visitante informa os próprios.
  const u = req.user;
  const name = b.name || u?.name || null;
  const email = (b.email || u?.email || '').toLowerCase() || null;
  const phone = normalizePhone(b.phone);
  const hasPersonal = !!(b.name || b.email || b.phone || b.company);
  if (b.kind === 'form' && (!name || (!email && !phone))) throw badRequest('Informe nome e e-mail ou telefone');
  if (hasPersonal && !b.consent && !u) throw badRequest('É necessário aceitar o uso dos dados para contato (LGPD)');
  if (b.phone && !phone) throw badRequest('Telefone inválido — use DDD + número');
  const identified = !!(name && (email || phone));
  const legalBasis = !identified ? null : u && !hasPersonal ? 'cadastro_plataforma' : 'consentimento';

  const rel = (await loadRelations([o.id])).get(o.id);
  const view = publicView(o, rel);

  const result = await db.transaction(async (trx) => {
    const route = await routeInterest(trx, o);
    const token = intentToken();
    const [interest] = await trx('opportunity_interests').insert({
      org_id: o.org_id, opportunity_id: o.id, intent_token: token,
      status: b.kind === 'form' ? 'form_submitted' : 'clicked', kind: b.kind,
      channel: b.channel ?? deriveChannel(attribution), attribution: JSON.stringify(attribution),
      name: identified ? name : null, email: identified ? email : null, phone: identified ? phone : null,
      company: b.company || null, message: b.message || null, consent: !!b.consent, legal_basis: legalBasis,
      user_id: u?.id ?? null, broker_id: route.broker_id, routed_to_number: route.number, routed_via: route.via, rule_id: route.rule_id,
      sla_due_at: trx.raw(`now() + (? * interval '1 minute')`, [route.sla_minutes]),
      crm_sync_status: identified ? 'pending' : 'not_applicable', ip_hash: hashIp(req.ip),
    }).returning('*');
    await trx('interest_events').insert([
      { interest_id: interest.id, type: b.kind === 'form' ? 'form' : 'click', payload: JSON.stringify({ channel: interest.channel }) },
      { interest_id: interest.id, type: 'routed', payload: JSON.stringify({ via: route.via, broker: route.broker_name }) },
    ]);

    let outboxIds: (string | undefined)[] = [];
    if (identified) {
      const tags = ['dourado-land', `area:${o.code}`, `canal:${interest.channel}`];
      outboxIds = [
        await enqueue(trx, o.org_id, 'contact.upsert', { interest_id: interest.id, name, email, phone, company: b.company || null, tags, legal_basis: legalBasis }, `contact:${interest.id}`),
        await enqueue(trx, o.org_id, 'lead.create', {
          interest_id: interest.id, source: 'dourado-land', opportunity_code: o.code, opportunity_title: view.title,
          channel: interest.channel, attribution, intent_token: token, broker: route.broker_name, message: b.message || null,
        }, `lead:${interest.id}`),
      ];
      // Interesse identificado abre negociação na etapa "Interesse recebido"
      const [neg] = await trx('negotiations').insert({
        org_id: o.org_id, opportunity_id: o.id, interest_id: interest.id, contact_name: name, contact_email: email, contact_phone: phone,
        stage: 'interesse_recebido', owner_id: route.broker_id ? (await trx('land_brokers').where({ id: route.broker_id }).first())?.user_id : null,
        next_activity: 'Primeiro contato', next_activity_at: trx.raw(`now() + (? * interval '1 minute')`, [route.sla_minutes]),
      }).returning('id');
      if (route.broker_id) await trx('negotiation_participants').insert({ negotiation_id: neg.id, broker_id: route.broker_id });
      await trx('opportunity_interests').where({ id: interest.id }).update({ negotiation_id: neg.id });
      await trx('activities').insert({ org_id: o.org_id, opportunity_id: o.id, negotiation_id: neg.id, type: 'system', subject: `Interesse recebido via ${b.kind === 'form' ? 'formulário' : 'WhatsApp'} (${token})`, body: b.message || null });
    }
    return { interest, route, token, outboxIds: outboxIds.filter(Boolean) as string[] };
  });

  // tentativa imediata de entrega ao CRM (o worker reprocessa em caso de falha)
  if (result.outboxIds.length) await processOutbox(5, result.outboxIds).catch(() => {});
  const fresh = await db('opportunity_interests').where({ id: result.interest.id }).first();

  const message = buildWhatsAppMessage({ code: o.code, title: view.title, city: o.city, uf: o.uf, areaM2: o.area_m2, token: result.token });
  res.status(201).json({
    token: result.token,
    status: fresh.status,
    routed_to: result.route.broker_name,
    whatsapp_url: result.route.number ? `https://wa.me/${result.route.number}?text=${encodeURIComponent(message)}` : null,
    message,
    crm: { status: fresh.crm_sync_status, contact_id: fresh.crm_contact_id },
  });
}));

// ------------------------------------------------------------------ documentos públicos e arquivos

router.get('/documents/:id/url', ah(async (req, res) => {
  const d = await db('land_documents as d').join('publication_permissions as pp', 'pp.opportunity_id', 'd.opportunity_id')
    .join('land_opportunities as o', 'o.id', 'd.opportunity_id')
    .where({ 'd.id': String(req.params.id), 'd.confidentiality': 'public', 'd.is_current': true, 'o.publication_status': 'published', 'pp.show_public_documents': true })
    .select('d.id').first();
  if (!d) throw notFound('Documento');
  res.json(signDocumentUrl(d.id, req.user?.id ?? 'public'));
}));

export const filesRouter = Router();
filesRouter.get('/:token', ah(async (req, res) => {
  const v = verifyDocumentToken(String(req.params.token));
  if (!v) throw notFound('Link expirado ou inválido');
  const d = await db('land_documents').where({ id: v.docId }).first();
  if (!d) throw notFound('Documento');
  const data = await storage.get(d.storage_key);
  await audit(null, 'document.download', 'land_documents', d.id, { user_id: v.userId === 'public' ? null : v.userId });
  res.setHeader('Content-Type', d.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(d.original_name)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(data);
}));

// ------------------------------------------------------------------ book em PDF (Chromium via Playwright, opcional)

router.get('/opportunities/:slug/book.pdf', ah(async (req, res) => {
  const o = await findBySlug(req, String(req.params.slug));
  let chromium: any;
  try {
    ({ chromium } = await import(/* @vite-ignore */ 'playwright' as string));
  } catch {
    return res.status(501).json({ error: 'Geração de PDF no servidor indisponível. Use "Imprimir / salvar PDF" no book.' });
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${config.publicWebUrl}/areas/${o.slug}/book?print=1`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('[data-book-ready]', { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } });
    res.type('application/pdf').attachment(`${o.code}.pdf`).send(pdf);
  } finally {
    await browser.close();
  }
}));

// ------------------------------------------------------------------ formulários institucionais (proprietários, parceiros, contato) → CRM

router.post('/contact', interestLimiter, ah(async (req, res) => {
  const b = parse(z.object({
    kind: z.enum(['proprietario', 'parceiro', 'construtora', 'contato']),
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(160).optional().or(z.literal('')),
    phone: z.string().trim().max(24).optional().or(z.literal('')),
    company: z.string().trim().max(160).optional().or(z.literal('')),
    creci: z.string().trim().max(20).optional().or(z.literal('')),
    city: z.string().trim().max(120).optional().or(z.literal('')),
    message: z.string().trim().max(3000).optional().or(z.literal('')),
    consent: z.literal(true, { message: 'É necessário aceitar o uso dos dados para contato (LGPD)' }),
  }), req.body);
  const phone = normalizePhone(b.phone);
  if (!b.email && !phone) throw badRequest('Informe e-mail ou telefone');
  const org = await db('organizations').where({ kind: 'manager' }).orderBy('created_at').first();
  const key = crypto.randomUUID();
  const ids = await db.transaction(async (trx) => [
    await enqueue(trx, org.id, 'contact.upsert', { name: b.name, email: b.email?.toLowerCase() || null, phone, company: b.company || null, tags: ['dourado-land', `form:${b.kind}`], legal_basis: 'consentimento' }, `contact:form:${key}`),
    await enqueue(trx, org.id, 'lead.create', { source: 'dourado-land', form: b.kind, name: b.name, email: b.email || null, phone, company: b.company || null, creci: b.creci || null, city: b.city || null, message: b.message || null }, `lead:form:${key}`),
  ]);
  await processOutbox(5, ids.filter(Boolean) as string[]).catch(() => {});
  // proprietário que oferece uma área entra direto no funil de captação
  if (b.kind === 'proprietario') {
    const { createProspect } = await import('./prospects.js');
    await db.transaction((trx) => createProspect(trx, org.id, null, {
      title: `Área oferecida por ${b.name}${b.city ? ` — ${b.city}` : ''}`, source: 'site_proprietario', city: b.city || null,
      owner_name: b.name, owner_phone: b.phone || null, owner_email: b.email || null, notes: b.message || null, legal_basis: 'consentimento', assigned_to: null,
    }));
  }
  res.status(201).json({ ok: true });
}));
