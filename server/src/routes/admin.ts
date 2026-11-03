import { Router } from 'express';
import { z } from 'zod';
import { ROLES } from '@dl/shared';
import { db } from '../db/knex.js';
import { config } from '../config.js';
import { authenticate, requireScope } from '../auth/auth.js';
import { MATRIX } from '../auth/permissions.js';
import { ah, notFound, parse, badRequest } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { crmMode } from '../integrations/crm.js';
import { layerStatus } from '../integrations/territory.js';

export const router = Router();
router.use(authenticate);

router.get('/me', ah(async (req, res) => {
  const org = await db('organizations').where({ id: req.user!.orgId }).select('id', 'name', 'slug', 'kind', 'central_whatsapp').first();
  res.json({ user: req.user, org, permissions: MATRIX[req.user!.role] });
}));

// ------------------------------------------------------------------ usuários e intermediadores

router.get('/users', ah(async (req, res) => {
  const scope = requireScope(req, 'user', 'read');
  const qb = db('users as u').leftJoin('land_brokers as b', 'b.user_id', 'u.id').leftJoin('organizations as o', 'o.id', 'u.org_id');
  if (scope === 'org') qb.where('u.org_id', req.user!.orgId);
  const rows = await qb.select('u.id', 'u.name', 'u.email', 'u.phone', 'u.role', 'u.active', 'u.mfa_enabled', 'o.name as org_name',
    'b.id as broker_id', 'b.creci', 'b.creci_uf', 'b.creci_status', 'b.whatsapp', 'b.active as broker_active').orderBy('u.name');
  res.json({ items: rows, roles: ROLES });
}));

router.get('/brokers', ah(async (req, res) => {
  requireScope(req, 'opportunity', 'read');
  const rows = await db('land_brokers as b').join('users as u', 'u.id', 'b.user_id').where('b.org_id', req.user!.orgId)
    .select('b.*', 'u.name', 'u.email',
      db.raw(`(SELECT count(*)::int FROM broker_assignments ba WHERE ba.broker_id = b.id AND ba.active) as assignments`),
      db.raw(`(SELECT count(*)::int FROM opportunity_interests i WHERE i.broker_id = b.id AND i.created_at > now() - interval '30 days') as interests_30d`))
    .orderBy('u.name');
  res.json({ items: rows });
}));

router.patch('/brokers/:id', ah(async (req, res) => {
  requireScope(req, 'routing', 'update');
  const b = parse(z.object({
    creci: z.string().max(20).nullable().optional(), creci_uf: z.string().length(2).nullable().optional(),
    creci_status: z.enum(['nao_verificado', 'ativo', 'irregular', 'nao_aplicavel']).optional(),
    whatsapp: z.string().max(20).nullable().optional(), active: z.boolean().optional(),
  }), req.body);
  const upd: any = { ...b, updated_at: db.fn.now() };
  if (b.creci_status) upd.creci_checked_at = db.fn.now();
  const n = await db('land_brokers').where({ id: String(req.params.id), org_id: req.user!.orgId }).update(upd);
  if (!n) throw notFound('Intermediador');
  await audit(req, 'update', 'land_brokers', String(req.params.id), b);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ regras de roteamento WhatsApp

const ruleSchema = z.object({
  name: z.string().min(2).max(120),
  priority: z.number().int().min(1).max(1000),
  criteria: z.object({ ufs: z.array(z.string().length(2)).optional(), cities: z.array(z.string()).optional(), types: z.array(z.string()).optional() }).default({}),
  target: z.enum(['assigned_broker', 'round_robin', 'central']),
  broker_ids: z.array(z.string().uuid()).default([]),
  sla_minutes: z.number().int().min(5).max(10080),
  active: z.boolean().default(true),
});

router.get('/routing-rules', ah(async (req, res) => {
  requireScope(req, 'routing', 'read');
  const org = await db('organizations').where({ id: req.user!.orgId }).first();
  res.json({ items: await db('whatsapp_routing_rules').where({ org_id: req.user!.orgId }).orderBy('priority'), central_whatsapp: org.central_whatsapp });
}));
router.post('/routing-rules', ah(async (req, res) => {
  requireScope(req, 'routing', 'create');
  const b = parse(ruleSchema, req.body);
  if (b.target === 'round_robin' && !b.broker_ids.length) throw badRequest('Selecione os intermediadores do rodízio');
  const [r] = await db('whatsapp_routing_rules').insert({ ...b, criteria: JSON.stringify(b.criteria), org_id: req.user!.orgId }).returning('*');
  await audit(req, 'create', 'whatsapp_routing_rules', r.id, b);
  res.status(201).json(r);
}));
router.patch('/routing-rules/:id', ah(async (req, res) => {
  requireScope(req, 'routing', 'update');
  const b = parse(ruleSchema.partial(), req.body);
  const upd: any = { ...b, updated_at: db.fn.now() };
  if (b.criteria) upd.criteria = JSON.stringify(b.criteria);
  const n = await db('whatsapp_routing_rules').where({ id: String(req.params.id), org_id: req.user!.orgId }).update(upd);
  if (!n) throw notFound('Regra');
  await audit(req, 'update', 'whatsapp_routing_rules', String(req.params.id), b);
  res.json({ ok: true });
}));
router.delete('/routing-rules/:id', ah(async (req, res) => {
  requireScope(req, 'routing', 'delete');
  const n = await db('whatsapp_routing_rules').where({ id: String(req.params.id), org_id: req.user!.orgId }).del();
  if (!n) throw notFound('Regra');
  await audit(req, 'delete', 'whatsapp_routing_rules', String(req.params.id));
  res.status(204).end();
}));
router.put('/central-whatsapp', ah(async (req, res) => {
  requireScope(req, 'routing', 'update');
  const b = parse(z.object({ central_whatsapp: z.string().max(20).nullable() }), req.body);
  await db('organizations').where({ id: req.user!.orgId }).update(b);
  await audit(req, 'update', 'organizations', req.user!.orgId, b);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ auditoria

router.get('/audit', ah(async (req, res) => {
  const scope = requireScope(req, 'audit', 'read');
  const q = req.query as Record<string, string>;
  const qb = db('audit_logs as a').leftJoin('users as u', 'u.id', 'a.user_id');
  if (scope === 'org') qb.where('a.org_id', req.user!.orgId);
  if (q.entity) qb.where('a.entity', q.entity);
  if (q.action) qb.whereILike('a.action', `${q.action}%`);
  const rows = await qb.select('a.id', 'a.action', 'a.entity', 'a.entity_id', 'a.diff', 'a.created_at', 'u.name as user_name').orderBy('a.created_at', 'desc').limit(300);
  res.json({ items: rows });
}));

// ------------------------------------------------------------------ integrações (o que é real, simulado ou pendente)

router.get('/integrations/status', ah(async (req, res) => {
  requireScope(req, 'integration', 'read');
  const outbox = await db('crm_outbox').where({ org_id: req.user!.orgId }).select('status').count({ n: '*' }).groupBy('status');
  res.json({
    items: [
      { key: 'identity', name: 'WingsBr Identidade (JWT)', status: 'implemented', detail: config.enableDevLogin ? 'Login de demonstração ativo (somente desenvolvimento)' : 'Somente tokens WingsBr' },
      { key: 'crm', name: 'WingsBr CRM / Leads Hub', status: crmMode() === 'http' ? 'implemented' : 'simulated', detail: crmMode() === 'http' ? 'Entrega HTTP assinada com outbox' : 'Modo embutido: sem WINGSBR_CRM_URL, contatos ficam em espelho local de desenvolvimento' },
      { key: 'whatsapp_link', name: 'WhatsApp — link contextual', status: 'implemented', detail: 'wa.me com mensagem e token de referência' },
      { key: 'whatsapp_webhook', name: 'WhatsApp Business Platform — webhook', status: config.waAppSecret === 'dev-app-secret' ? 'pending' : 'implemented', detail: 'Endpoint /webhooks/whatsapp pronto; requer app e número oficiais da Dourado' },
      { key: 'postgis', name: 'PostGIS', status: 'implemented', detail: 'Área/perímetro geodésicos, ponto público ofuscado, filtro por região' },
      { key: 'maps', name: 'Provedor cartográfico', status: 'pending', detail: 'Estilo de demonstração; configurar provedor licenciado (VITE_MAP_STYLE_URL)' },
      { key: 'storage', name: 'Storage S3', status: 'pending', detail: `Driver local em ${config.storageDir}` },
      { key: 'ai', name: 'IA assistiva', status: config.anthropicKey ? 'implemented' : 'simulated', detail: config.anthropicKey ? `Anthropic ${config.anthropicModel}` : 'Heurísticas determinísticas (sem ANTHROPIC_API_KEY)' },
      { key: 'ga4', name: 'Google Analytics 4 / Meta CAPI', status: 'pending', detail: 'Eventos enviados ao dataLayer com consentimento; tags não configuradas' },
      { key: 'email', name: 'E-mail transacional', status: 'pending', detail: 'Reutilizar módulo de E-mail Marketing (SES)' },
      { key: 'esign', name: 'Assinatura eletrônica', status: 'pending', detail: '' },
      { key: 'creci', name: 'Validação de CRECI', status: 'pending', detail: 'Status manual; consulta automática exige convênio' },
      ...(() => { const t = layerStatus(); return [
        ...t.layers.map((l) => ({ key: `territory_${l.key}`, name: l.name, status: l.status, detail: t.mode === 'demo' ? 'Modo demonstração: parcelas fictícias (TERRITORY_MODE=demo)' : l.status === 'pending' ? `Configurar TERRITORY_${l.key.toUpperCase()}_WFS_URL e _LAYER (serviço WFS oficial)` : 'Serviço WFS oficial, cache de 24 h' })),
        { key: 'onr', name: t.registry.name, status: t.registry.status, detail: t.mode === 'demo' ? 'Consulta registral fictícia' : t.registry.status === 'pending' ? 'Sem API pública do ONR: contratar provedor que consulta o Mapa (ONR_PROVIDER_URL / ONR_PROVIDER_TOKEN). Link direto ao Mapa disponível.' : 'Consulta registral via provedor contratado' },
        { key: 'earth', name: 'Google Earth', status: 'implemented', detail: 'Abrir no Google Earth Web e exportar KML para projetos do Earth' },
        { key: 'maps3d', name: 'Vista 3D (Google 3D Maps)', status: process.env.GOOGLE_MAPS_3D_ENABLED === 'true' ? 'implemented' : 'pending', detail: 'Requer chave da Google Maps Platform com Maps JavaScript API (VITE_GOOGLE_MAPS_API_KEY no front)' },
      ]; })(),
    ],
    outbox,
  });
}));
