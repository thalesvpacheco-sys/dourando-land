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
import { layerStatus, loadedDatasets } from '../integrations/territory.js';
import { createAuthLink, inviteText, resetText } from '../auth/links.js';
import { mailEnabled, sendMail } from '../lib/mailer.js';
import { HttpError, forbidden } from '../lib/http.js';
import type { Request } from 'express';
import crypto from 'node:crypto';

export const router = Router();
router.use(authenticate);

router.get('/me', ah(async (req, res) => {
  const org = await db('organizations').where({ id: req.user!.orgId }).select('id', 'name', 'slug', 'kind', 'central_whatsapp').first();
  res.json({ user: req.user, org, permissions: MATRIX[req.user!.role] });
}));

// ------------------------------------------------------------------ minha conta (dados do próprio usuário)

async function ownProfile(userId: string) {
  const u = await db('users').where({ id: userId }).select('id', 'name', 'email', 'phone', 'role').first();
  const b = await db('land_brokers').where({ user_id: userId }).select('id', 'creci', 'creci_uf', 'creci_status', 'creci_checked_at', 'whatsapp', 'active').first();
  return { ...u, broker: b ?? null };
}

router.get('/me/profile', ah(async (req, res) => {
  res.json(await ownProfile(req.user!.id));
}));

/** A própria pessoa edita nome, telefone, CRECI e WhatsApp. A situação do CRECI só o administrador valida. */
router.patch('/me/profile', ah(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2).max(160).optional(), phone: z.string().trim().max(20).nullable().optional(),
    creci: z.string().trim().max(20).nullable().optional(), creci_uf: z.string().length(2).nullable().optional(), whatsapp: z.string().trim().max(20).nullable().optional(),
  }), req.body);
  await db.transaction(async (trx) => {
    const userUpd = Object.fromEntries(Object.entries({ name: b.name, phone: b.phone }).filter(([, v]) => v !== undefined));
    if (Object.keys(userUpd).length) await trx('users').where({ id: req.user!.id }).update({ ...userUpd, updated_at: trx.fn.now() });
    const broker = await trx('land_brokers').where({ user_id: req.user!.id }).first();
    if (broker) await trx('land_brokers').where({ id: broker.id }).update(brokerUpdate(broker, { creci: b.creci, creci_uf: b.creci_uf, whatsapp: b.whatsapp }, false));
  });
  await audit(req, 'user.profile', 'users', req.user!.id, b);
  res.json(await ownProfile(req.user!.id));
}));

// ------------------------------------------------------------------ usuários e intermediadores

router.get('/users', ah(async (req, res) => {
  const scope = requireScope(req, 'user', 'read');
  const qb = db('users as u').leftJoin('land_brokers as b', 'b.user_id', 'u.id').leftJoin('organizations as o', 'o.id', 'u.org_id');
  if (scope === 'org') qb.where('u.org_id', req.user!.orgId);
  const rows = await qb.select('u.id', 'u.name', 'u.email', 'u.phone', 'u.role', 'u.active', 'u.mfa_enabled', 'u.last_login_at', 'u.locked_until', 'o.name as org_name',
    db.raw('u.password_hash IS NOT NULL as has_password'),
    'b.id as broker_id', 'b.creci', 'b.creci_uf', 'b.creci_status', 'b.whatsapp', 'b.active as broker_active').orderBy('u.name');
  res.json({ items: rows, roles: ROLES, mail_enabled: mailEnabled() });
}));

// Quem pode conceder o quê: ninguém concede acima do próprio nível.
const ASSIGNABLE: Partial<Record<string, string[]>> = {
  platform_admin: ['platform_admin', 'dourado_admin', 'capture_manager', 'broker', 'owner', 'buyer'],
  dourado_admin: ['dourado_admin', 'capture_manager', 'broker', 'owner', 'buyer'],
};
function assertAssignable(req: Request, role: string) {
  if (!ASSIGNABLE[req.user!.role]?.includes(role)) throw forbidden('Seu perfil não pode conceder este acesso');
}
async function targetUser(req: Request, scope: string) {
  const qb = db('users').where({ id: String(req.params.id) });
  if (scope === 'org') qb.andWhere((w) => w.where('org_id', req.user!.orgId).orWhereIn('org_id', db('partner_companies').where({ org_id: req.user!.orgId }).whereNotNull('partner_org_id').select('partner_org_id')));
  const u = await qb.first();
  if (!u) throw notFound('Usuário');
  return u;
}
/** Último administrador ativo não pode perder o acesso: a plataforma ficaria sem quem convide. */
async function assertNotLastAdmin(u: any) {
  if (u.role !== 'dourado_admin') return;
  const others = await db('users').where({ org_id: u.org_id, role: 'dourado_admin', active: true }).whereNot({ id: u.id }).whereNotNull('password_hash').count({ n: '*' }).first();
  if (!Number(others?.n)) throw badRequest('Este é o último administrador ativo. Cadastre outro antes de alterar este acesso.');
}

/**
 * Perfis da equipe que podem ser responsáveis por áreas. O intermediador sempre é; administrador e gestor de captação
 * passam a ser quando marcados como "atua como intermediador" (ganham uma linha em land_brokers, com CRECI e WhatsApp).
 */
const BROKER_CAPABLE = ['dourado_admin', 'capture_manager', 'broker'];

const CRECI_STATUS = ['nao_verificado', 'ativo', 'irregular', 'nao_aplicavel'] as const;
const brokerFieldsSchema = {
  creci: z.string().trim().max(20).nullable().optional(), creci_uf: z.string().length(2).nullable().optional(),
  creci_status: z.enum(CRECI_STATUS).optional(), whatsapp: z.string().trim().max(20).nullable().optional(),
};
type BrokerFields = { creci?: string | null; creci_uf?: string | null; creci_status?: (typeof CRECI_STATUS)[number]; whatsapp?: string | null };

/** Monta a alteração de land_brokers. Mudou o número ou a UF do CRECI sem nova validação: volta para "não verificado". */
function brokerUpdate(cur: any | null, f: BrokerFields, canValidate: boolean) {
  const upd: any = {};
  for (const k of ['creci', 'creci_uf', 'whatsapp'] as const) if (f[k] !== undefined) upd[k] = f[k] || null;
  if (canValidate && f.creci_status) { upd.creci_status = f.creci_status; upd.creci_checked_at = db.fn.now(); }
  else if (cur && ((upd.creci !== undefined && upd.creci !== cur.creci) || (upd.creci_uf !== undefined && upd.creci_uf !== cur.creci_uf))) upd.creci_status = 'nao_verificado';
  if (Object.keys(upd).length) upd.updated_at = db.fn.now();
  return upd;
}

const inviteSchema = z.object({
  name: z.string().min(2).max(160), email: z.string().email().max(200), phone: z.string().max(20).nullable().optional(),
  role: z.enum(Object.keys(ROLES) as [string, ...string[]]),
  partner_company_id: z.string().uuid().optional(),   // comprador: empresa parceira
  opportunity_code: z.string().max(30).optional(),    // proprietário: área dele
  acts_as_broker: z.boolean().optional(),             // administrador/gestor que também atende áreas
  ...brokerFieldsSchema,
});

router.post('/users', ah(async (req, res) => {
  requireScope(req, 'user', 'create');
  const b = parse(inviteSchema, req.body);
  assertAssignable(req, b.role);
  const email = b.email.trim().toLowerCase();
  if (await db('users').whereRaw('lower(email) = ?', [email]).first()) throw new HttpError(409, 'Já existe um usuário com este e-mail.');
  const out = await db.transaction(async (trx) => {
    let orgId = req.user!.orgId;
    if (b.role === 'buyer') {
      if (!b.partner_company_id) throw badRequest('Informe a empresa parceira do comprador.');
      const pc = await trx('partner_companies').where({ id: b.partner_company_id, org_id: req.user!.orgId }).first();
      if (!pc) throw notFound('Empresa parceira');
      if (!pc.partner_org_id) {
        const [org] = await trx('organizations').insert({ name: pc.name, slug: `parceiro-${pc.id.slice(0, 8)}`, kind: 'partner' }).returning('*');
        await trx('partner_companies').where({ id: pc.id }).update({ partner_org_id: org.id });
        pc.partner_org_id = org.id;
      }
      orgId = pc.partner_org_id;
    }
    const opp = b.role === 'owner'
      ? await trx('land_opportunities').where({ code: (b.opportunity_code ?? '').trim().toUpperCase(), org_id: req.user!.orgId }).first()
      : null;
    if (b.role === 'owner' && !opp) throw badRequest('Informe o código de uma área existente (ex.: DOU-GO-0001) para o proprietário.');
    const [u] = await trx('users').insert({ org_id: orgId, external_id: `local_${crypto.randomUUID()}`, name: b.name.trim(), email, phone: b.phone ?? null, role: b.role }).returning('*');
    if (b.role === 'broker' || (b.acts_as_broker && BROKER_CAPABLE.includes(b.role))) {
      await trx('land_brokers').insert({ org_id: orgId, user_id: u.id, whatsapp: b.phone ?? null, ...brokerUpdate(null, { creci: b.creci, creci_uf: b.creci_uf, creci_status: b.creci_status, whatsapp: b.whatsapp ?? b.phone }, true) });
    }
    if (opp) {
      const n = await trx('land_owners').where({ opportunity_id: opp.id }).whereRaw('lower(email) = ?', [email]).update({ user_id: u.id });
      if (!n) await trx('land_owners').insert({ opportunity_id: opp.id, kind: 'pf', name: b.name.trim(), email, phone: b.phone ?? null, user_id: u.id });
    }
    return { u, link: await createAuthLink(u.id, 'invite', req.user!.id, trx) };
  });
  const emailed = await sendMail(email, 'Convite — Quero Área', inviteText(out.u.name, out.link.url));
  await audit(req, 'user.invite', 'users', out.u.id, { role: b.role, email_sent: emailed });
  res.status(201).json({ id: out.u.id, invite_url: out.link.url, expires_at: out.link.expires_at, email_sent: emailed });
}));

router.patch('/users/:id', ah(async (req, res) => {
  const scope = requireScope(req, 'user', 'update');
  const { acts_as_broker: actsAsBroker, creci, creci_uf, creci_status, whatsapp, ...b } = parse(z.object({
    name: z.string().min(2).max(160).optional(), phone: z.string().max(20).nullable().optional(), role: z.enum(Object.keys(ROLES) as [string, ...string[]]).optional(), active: z.boolean().optional(),
    email: z.string().trim().toLowerCase().email().max(200).optional(),
    acts_as_broker: z.boolean().optional(), ...brokerFieldsSchema,
  }), req.body);
  const u = await targetUser(req, scope);
  // E-mail digitado errado no convite: corrige enquanto a pessoa não definiu senha (depois, o e-mail é o login dela).
  const emailChanged = b.email !== undefined && b.email !== String(u.email).toLowerCase();
  if (!emailChanged) delete b.email;
  else {
    if (u.password_hash) throw badRequest('Só dá para corrigir o e-mail enquanto o convite está pendente.');
    if (await db('users').whereRaw('lower(email) = ?', [b.email!]).whereNot({ id: u.id }).first()) throw new HttpError(409, 'Já existe um usuário com este e-mail.');
  }
  if (!ASSIGNABLE[req.user!.role]?.includes(u.role)) throw forbidden('Seu perfil não pode alterar este usuário');
  if (b.role) {
    assertAssignable(req, b.role);
    if (['owner', 'buyer'].includes(b.role) !== ['owner', 'buyer'].includes(u.role)) throw badRequest('Para trocar entre equipe e proprietário/comprador, desative este acesso e convide de novo.');
  }
  if (u.id === req.user!.id && (b.active === false || (b.role && b.role !== u.role))) throw badRequest('Você não pode alterar o próprio perfil ou desativar a si mesmo.');
  if (b.active === false || (b.role && b.role !== 'dourado_admin')) await assertNotLastAdmin(u);
  const upd: any = { ...b, updated_at: db.fn.now() };
  // perfil ou situação mudaram: as sessões abertas deixam de valer
  if (b.active === false || (b.role && b.role !== u.role)) upd.session_version = u.session_version + 1;
  const role = b.role ?? u.role;
  const active = b.active ?? u.active;
  await db.transaction(async (trx) => {
    await trx('users').where({ id: u.id }).update(upd);
    const broker = await trx('land_brokers').where({ user_id: u.id }).first();
    const fields = brokerUpdate(broker, { creci, creci_uf, creci_status, whatsapp }, true);
    // Só mexe em "pode ser responsável" quando perfil, situação ou a própria opção mudaram:
    // editar só o nome não reativa quem foi tirado do atendimento em Atendimento e WhatsApp.
    const touchesRole = b.active !== undefined || b.role !== undefined || actsAsBroker !== undefined;
    const wantsBroker = active && (role === 'broker' || (BROKER_CAPABLE.includes(role) && (actsAsBroker ?? !!broker?.active)));
    if (!broker) {
      if (touchesRole && wantsBroker) await trx('land_brokers').insert({ org_id: u.org_id, user_id: u.id, whatsapp: b.phone ?? u.phone, ...fields });
    } else {
      const brokerUpd = { ...fields, ...(touchesRole && broker.active !== wantsBroker ? { active: wantsBroker, updated_at: trx.fn.now() } : {}) };
      if (Object.keys(brokerUpd).length) await trx('land_brokers').where({ id: broker.id }).update(brokerUpd);
    }
    // desativado, ou e-mail corrigido (o link antigo foi para o endereço errado): links pendentes deixam de valer
    if (b.active === false || emailChanged) await trx('auth_tokens').where({ user_id: u.id }).whereNull('used_at').update({ used_at: trx.fn.now() });
  });
  await audit(req, 'user.update', 'users', u.id, { ...b, acts_as_broker: actsAsBroker, creci, creci_uf, creci_status, whatsapp });
  res.json({ ok: true });
}));

/** Novo link de convite (quem nunca definiu senha) ou de redefinição (quem já tem senha). */
router.post('/users/:id/link', ah(async (req, res) => {
  const scope = requireScope(req, 'user', 'update');
  const u = await targetUser(req, scope);
  if (!u.active) throw badRequest('Reative o usuário antes de gerar um link.');
  if (!ASSIGNABLE[req.user!.role]?.includes(u.role)) throw forbidden('Seu perfil não pode alterar este usuário');
  const kind = u.password_hash ? 'reset' : 'invite';
  const link = await createAuthLink(u.id, kind, req.user!.id);
  const emailed = await sendMail(u.email, kind === 'invite' ? 'Convite — Quero Área' : 'Redefinir senha — Quero Área', (kind === 'invite' ? inviteText : resetText)(u.name, link.url));
  await audit(req, `user.${kind}_link`, 'users', u.id, { email_sent: emailed });
  res.json({ kind, url: link.url, expires_at: link.expires_at, email_sent: emailed });
}));

/** Celular perdido: zera a segunda etapa e encerra as sessões. A pessoa configura de novo no próximo acesso. */
router.post('/users/:id/reset-mfa', ah(async (req, res) => {
  const scope = requireScope(req, 'user', 'update');
  const u = await targetUser(req, scope);
  if (!ASSIGNABLE[req.user!.role]?.includes(u.role)) throw forbidden('Seu perfil não pode alterar este usuário');
  if (u.id === req.user!.id) throw badRequest('Peça a outro administrador para fazer isso por você.');
  await db('users').where({ id: u.id }).update({ mfa_enabled: false, mfa_secret_enc: null, mfa_recovery_hashes: '[]', mfa_last_step: 0, session_version: u.session_version + 1, locked_until: null, failed_logins: 0 });
  await audit(req, 'user.mfa_reset', 'users', u.id);
  res.json({ ok: true });
}));

router.get('/brokers', ah(async (req, res) => {
  requireScope(req, 'opportunity', 'read');
  const rows = await db('land_brokers as b').join('users as u', 'u.id', 'b.user_id').where('b.org_id', req.user!.orgId)
    .select('b.*', 'u.name', 'u.email', 'u.role', 'u.active as user_active',
      db.raw(`(SELECT count(*)::int FROM broker_assignments ba WHERE ba.broker_id = b.id AND ba.active) as assignments`),
      db.raw(`(SELECT count(*)::int FROM opportunity_interests i WHERE i.broker_id = b.id AND i.created_at > now() - interval '30 days') as interests_30d`))
    .orderBy('u.name');
  res.json({ items: rows });
}));

router.patch('/brokers/:id', ah(async (req, res) => {
  requireScope(req, 'routing', 'update');
  const b = parse(z.object({ ...brokerFieldsSchema, active: z.boolean().optional() }), req.body);
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
  const loaded = await loadedDatasets();
  const outbox = await db('crm_outbox').where({ org_id: req.user!.orgId }).select('status').count({ n: '*' }).groupBy('status');
  res.json({
    items: [
      { key: 'identity', name: 'Login e usuários', status: 'implemented', detail: config.enableDevLogin ? 'Login próprio; seletor de demonstração ativo (somente desenvolvimento)' : `Login próprio com senha${config.requireMfa ? ' e duas etapas para administradores' : ''}` },
      { key: 'crm', name: 'WingsBr CRM / Leads Hub', status: crmMode() === 'http' ? 'implemented' : 'simulated', detail: crmMode() === 'http' ? 'Entrega HTTP assinada com outbox' : 'Modo embutido: sem WINGSBR_CRM_URL, contatos ficam em espelho local de desenvolvimento' },
      { key: 'whatsapp_link', name: 'WhatsApp — link contextual', status: 'implemented', detail: 'wa.me com mensagem e token de referência' },
      { key: 'whatsapp_webhook', name: 'WhatsApp Business Platform — webhook', status: config.waAppSecret === 'dev-app-secret' ? 'pending' : 'implemented', detail: 'Endpoint /webhooks/whatsapp pronto; requer app e número oficiais da Quero Área' },
      { key: 'postgis', name: 'PostGIS', status: 'implemented', detail: 'Área/perímetro geodésicos, ponto público ofuscado, filtro por região' },
      { key: 'maps', name: 'Mapa de satélite', status: process.env.VITE_SATELLITE_TILES || process.env.MAPBOX_TOKEN ? 'implemented' : 'pending', detail: process.env.VITE_SATELLITE_TILES ? 'Provedor configurado' : process.env.MAPBOX_TOKEN ? `Mapbox Satellite pelo servidor (token protegido, teto de ${Number(process.env.MAPBOX_DAILY_LIMIT ?? 6000).toLocaleString('pt-BR')} blocos/dia)` : 'Criar conta na Mapbox e preencher MAPBOX_TOKEN. Até lá, o mapa usa a base própria (contornos de UF).' },
      { key: 'terrain3d', name: 'Relevo 3D nos mapas', status: 'implemented', detail: 'Botão 2D/3D em todos os mapas, com modelo de elevação aberto (AWS Terrain Tiles), sem custo' },
      { key: 'storage', name: 'Storage S3', status: 'pending', detail: `Driver local em ${config.storageDir}` },
      { key: 'ai', name: 'IA assistiva', status: config.anthropicKey ? 'implemented' : 'simulated', detail: config.anthropicKey ? `Anthropic ${config.anthropicModel}` : 'Heurísticas determinísticas (sem ANTHROPIC_API_KEY)' },
      { key: 'ga4', name: 'Google Analytics 4 / Meta CAPI', status: 'pending', detail: 'Eventos enviados ao dataLayer com consentimento; tags não configuradas' },
      { key: 'email', name: 'E-mail transacional', status: mailEnabled() ? 'implemented' : 'pending', detail: mailEnabled() ? 'Convites e redefinição de senha por SMTP' : 'Sem SMTP_URL: o administrador copia o link de convite e envia pelo canal que preferir. "Esqueci a senha" depende de SMTP.' },
      { key: 'esign', name: 'Assinatura eletrônica', status: 'pending', detail: '' },
      { key: 'creci', name: 'Validação de CRECI', status: 'pending', detail: 'Status manual; consulta automática exige convênio' },
      ...(() => { const t = layerStatus(loaded); return [
        ...t.layers.map((l) => ({ key: `territory_${l.key}`, name: l.name, status: l.status, detail: t.mode === 'demo' ? (l.status === 'simulated' ? 'Modo demonstração: parcelas fictícias (TERRITORY_MODE=demo)' : 'Disponível com TERRITORY_MODE=live') : l.features ? `${l.features.toLocaleString('pt-BR')} registros (${l.ufs.join(', ')}). Fonte: ${l.loaded_sources.join('; ')}. Carregada em ${new Date(l.loaded_at!).toLocaleDateString('pt-BR')}; atualize com scripts/atualizar-bases.sh.` : l.status === 'implemented' ? 'Consulta ao vivo no serviço oficial (WFS), sem carga local.' : `Não carregada. Fonte: ${l.source}. Carregue com territory:import (docs/PUBLICAR.md).` })),
        { key: 'onr', name: t.registry.name, status: t.registry.status, detail: t.mode === 'demo' ? 'Consulta registral fictícia' : t.registry.status === 'pending' ? 'Sem API pública do ONR: contratar provedor que consulta o Mapa (ONR_PROVIDER_URL / ONR_PROVIDER_TOKEN). Link direto ao Mapa disponível.' : 'Consulta registral via provedor contratado' },
        { key: 'earth', name: 'Google Earth', status: 'implemented', detail: 'Abrir no Google Earth Web e exportar KML para projetos do Earth' },
        { key: 'maps3d', name: 'Vista 3D (Google 3D Maps)', status: config.googleMaps3d ? 'implemented' : 'pending', detail: config.googleMaps3d ? 'Ativa: vista 3D fotorrealista na página de cada área e no painel' : 'Falta a chave da Google Maps Platform (Map Tiles API + Maps JavaScript API) em VITE_GOOGLE_MAPS_API_KEY no .env do servidor; depois, docker compose up -d --build' },
      ]; })(),
    ],
    outbox,
  });
}));
