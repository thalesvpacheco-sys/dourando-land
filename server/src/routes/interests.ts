import { Router, type Request } from 'express';
import express from 'express';
import { z } from 'zod';
import { INTENT_TOKEN_RE } from '@dl/shared';
import { db } from '../db/knex.js';
import { config } from '../config.js';
import { authenticate, requireScope } from '../auth/auth.js';
import { ah, badRequest, notFound, parse, conflict } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { hmac, maskPhone, normalizePhone, safeEqual, sha256 } from '../lib/crypto.js';
import { enqueue } from '../integrations/crm.js';

export const router = Router();
router.use(authenticate);

function scoped(req: Request, action: 'read' | 'update') {
  const scope = requireScope(req, 'interest', action);
  const qb = db('opportunity_interests as i').where('i.org_id', req.user!.orgId);
  if (scope === 'assigned') {
    const bid = req.user!.brokerId ?? '00000000-0000-0000-0000-000000000000';
    qb.andWhere((w) => w.where('i.broker_id', bid).orWhereExists(
      db('broker_assignments as ba').whereRaw('ba.opportunity_id = i.opportunity_id').andWhere({ 'ba.active': true, 'ba.broker_id': bid }),
    ));
  }
  return qb;
}

router.get('/', ah(async (req, res) => {
  const q = req.query as Record<string, string>;
  const qb = scoped(req, 'read')
    .join('land_opportunities as o', 'o.id', 'i.opportunity_id')
    .leftJoin('land_brokers as b', 'b.id', 'i.broker_id').leftJoin('users as u', 'u.id', 'b.user_id');
  if (q.status) qb.whereIn('i.status', q.status.split(','));
  if (q.opportunity_id) qb.where('i.opportunity_id', q.opportunity_id);
  if (q.overdue === '1') qb.whereNull('i.first_response_at').where('i.sla_due_at', '<', db.fn.now()).whereNotNull('i.name');
  const rows = await qb.select('i.*', 'o.code', 'o.public_title', 'o.internal_name', 'o.city', 'o.uf', 'u.name as broker_name',
    db.raw(`(i.first_response_at IS NULL AND i.sla_due_at < now() AND i.status NOT IN ('discarded')) as sla_breached`))
    .orderBy('i.created_at', 'desc').limit(300);
  res.json({ items: rows.map((r: any) => ({ ...r, ip_hash: undefined })) });
}));

router.get('/:id', ah(async (req, res) => {
  const i = await scoped(req, 'read').where('i.id', String(req.params.id)).select('i.*').first();
  if (!i) throw notFound('Interesse');
  const events = await db('interest_events as e').leftJoin('users as u', 'u.id', 'e.user_id').where('e.interest_id', i.id).select('e.*', 'u.name as user_name').orderBy('e.created_at');
  const inbound = await db('whatsapp_inbound').where('interest_id', i.id).select('id', 'from_masked', 'text', 'received_at', 'link_status');
  res.json({ ...i, ip_hash: undefined, events, inbound });
}));

router.post('/:id/first-response', ah(async (req, res) => {
  const i = await scoped(req, 'update').where('i.id', String(req.params.id)).select('i.*').first();
  if (!i) throw notFound('Interesse');
  if (i.first_response_at) throw conflict('Primeiro atendimento já registrado');
  await db('opportunity_interests').where({ id: i.id }).update({ first_response_at: db.fn.now(), status: i.status === 'clicked' ? 'qualified' : i.status, updated_at: db.fn.now() });
  await db('interest_events').insert({ interest_id: i.id, type: 'first_response', user_id: req.user!.id, payload: '{}' });
  res.json({ ok: true });
}));

router.post('/:id/reassign', ah(async (req, res) => {
  requireScope(req, 'routing', 'update');
  const b = parse(z.object({ broker_id: z.string().uuid().nullable(), reason: z.string().min(3).max(240) }), req.body);
  const i = await scoped(req, 'update').where('i.id', String(req.params.id)).select('i.*').first();
  if (!i) throw notFound('Interesse');
  let number: string | null = null, name = 'Atendimento Quero Área';
  if (b.broker_id) {
    const br = await db('land_brokers as b').join('users as u', 'u.id', 'b.user_id').where({ 'b.id': b.broker_id, 'b.org_id': req.user!.orgId, 'b.active': true }).select('b.*', 'u.name').first();
    if (!br) throw notFound('Intermediador');
    number = normalizePhone(br.whatsapp); name = br.name;
  } else {
    number = normalizePhone((await db('organizations').where({ id: req.user!.orgId }).first())?.central_whatsapp);
  }
  await db.transaction(async (trx) => {
    await trx('opportunity_interests').where({ id: i.id }).update({ broker_id: b.broker_id, routed_to_number: number, routed_via: 'transferência manual', updated_at: trx.fn.now() });
    await trx('interest_events').insert({ interest_id: i.id, type: 'reassigned', user_id: req.user!.id, payload: JSON.stringify({ from: i.broker_id, to: b.broker_id, to_name: name, reason: b.reason }) });
    if (i.negotiation_id && b.broker_id) await trx('negotiation_participants').insert({ negotiation_id: i.negotiation_id, broker_id: b.broker_id }).onConflict(['negotiation_id', 'broker_id']).ignore();
    await audit(req, 'interest.reassign', 'opportunity_interests', i.id, b, trx);
  });
  res.json({ ok: true, routed_to: name });
}));

router.post('/:id/discard', ah(async (req, res) => {
  const b = parse(z.object({ reason: z.string().min(3).max(240) }), req.body);
  const i = await scoped(req, 'update').where('i.id', String(req.params.id)).select('i.*').first();
  if (!i) throw notFound('Interesse');
  await db('opportunity_interests').where({ id: i.id }).update({ status: 'discarded', updated_at: db.fn.now() });
  await db('interest_events').insert({ interest_id: i.id, type: 'discarded', user_id: req.user!.id, payload: JSON.stringify(b) });
  res.json({ ok: true });
}));

/** Converte interesse (ex.: clique anônimo que virou conversa) em negociação com contato identificado. */
router.post('/:id/convert', ah(async (req, res) => {
  const b = parse(z.object({
    name: z.string().min(2).max(120), email: z.string().email().optional().or(z.literal('')), phone: z.string().max(24).optional().or(z.literal('')),
    partner_company_id: z.string().uuid().nullable().optional(), legal_basis: z.enum(['consentimento', 'legitimo_interesse', 'execucao_contrato']),
  }), req.body);
  const i = await scoped(req, 'update').where('i.id', String(req.params.id)).select('i.*').first();
  if (!i) throw notFound('Interesse');
  if (i.negotiation_id) throw conflict('Interesse já possui negociação');
  const phone = normalizePhone(b.phone);
  const neg = await db.transaction(async (trx) => {
    await trx('opportunity_interests').where({ id: i.id }).update({ name: b.name, email: b.email || null, phone, legal_basis: b.legal_basis, crm_sync_status: 'pending', status: 'qualified', updated_at: trx.fn.now() });
    const [neg] = await trx('negotiations').insert({
      org_id: i.org_id, opportunity_id: i.opportunity_id, interest_id: i.id, partner_company_id: b.partner_company_id ?? null,
      contact_name: b.name, contact_email: b.email || null, contact_phone: phone, owner_id: req.user!.id,
    }).returning('*');
    if (i.broker_id) await trx('negotiation_participants').insert({ negotiation_id: neg.id, broker_id: i.broker_id });
    await trx('opportunity_interests').where({ id: i.id }).update({ negotiation_id: neg.id });
    await enqueue(trx, i.org_id, 'contact.upsert', { interest_id: i.id, name: b.name, email: b.email || null, phone, tags: ['dourado-land'], legal_basis: b.legal_basis }, `contact:${i.id}`);
    await audit(req, 'interest.convert', 'opportunity_interests', i.id, { negotiation_id: neg.id }, trx);
    return neg;
  });
  res.status(201).json(neg);
}));

// ------------------------------------------------------------------ mensagens não vinculadas (vínculo manual)

router.get('/inbound/unlinked', ah(async (req, res) => {
  requireScope(req, 'routing', 'read');
  const rows = await db('whatsapp_inbound').where({ org_id: req.user!.orgId, link_status: 'unlinked' }).orderBy('received_at', 'desc').limit(100)
    .select('id', 'from_masked', 'to_number', 'text', 'received_at');
  res.json({ items: rows });
}));

router.post('/inbound/:id/link', ah(async (req, res) => {
  requireScope(req, 'routing', 'update');
  const b = parse(z.object({ interest_id: z.string().uuid() }), req.body);
  const m = await db('whatsapp_inbound').where({ id: String(req.params.id), org_id: req.user!.orgId }).first();
  const i = await db('opportunity_interests').where({ id: b.interest_id, org_id: req.user!.orgId }).first();
  if (!m || !i) throw notFound();
  await db('whatsapp_inbound').where({ id: m.id }).update({ interest_id: i.id, link_status: 'linked_manual' });
  await db('interest_events').insert({ interest_id: i.id, type: 'message_received', user_id: req.user!.id, payload: JSON.stringify({ manual: true, inbound_id: m.id }) });
  if (['clicked', 'form_submitted'].includes(i.status)) await db('opportunity_interests').where({ id: i.id }).update({ status: 'message_received' });
  await audit(req, 'whatsapp.link_manual', 'whatsapp_inbound', m.id, { interest_id: i.id });
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ webhook WhatsApp Business Platform (Cloud API)

export const webhookRouter = Router();

webhookRouter.get('/whatsapp', (req, res) => {
  const q = req.query as Record<string, string>;
  if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === config.waVerifyToken) return res.status(200).send(q['hub.challenge']);
  res.sendStatus(403);
});

webhookRouter.post('/whatsapp', express.raw({ type: 'application/json', limit: '1mb' }), ah(async (req, res) => {
  const raw = req.body as Buffer;
  const sig = String(req.headers['x-hub-signature-256'] ?? '');
  if (!sig.startsWith('sha256=') || !safeEqual(sig.slice(7), hmac(raw.toString('utf8'), config.waAppSecret))) {
    return res.sendStatus(401);
  }
  let payload: any;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { throw badRequest('JSON inválido'); }
  let processed = 0;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const toNumber = normalizePhone(v.metadata?.display_phone_number);
      for (const msg of v.messages ?? []) {
        processed += await handleInbound(msg, toNumber);
      }
    }
  }
  res.json({ processed });
}));

async function handleInbound(msg: any, toNumber: string | null) {
  const from = normalizePhone(msg.from) ?? String(msg.from ?? '');
  const text: string = msg.text?.body ?? msg.button?.text ?? '';
  const fromHash = sha256(from);
  const token = INTENT_TOKEN_RE.exec(text.toUpperCase())?.[1];
  const interest = token ? await db('opportunity_interests').where({ intent_token: token }).first() : null;
  // Organização: pelo interesse (token) ou pelo número que recebeu
  let orgId = interest?.org_id ?? null;
  if (!orgId && toNumber) {
    const b = await db('land_brokers').whereRaw(`regexp_replace(whatsapp, '\\D', '', 'g') LIKE ?`, [`%${toNumber.slice(-10)}`]).first();
    orgId = b?.org_id ?? (await db('organizations').whereRaw(`regexp_replace(coalesce(central_whatsapp,''), '\\D', '', 'g') LIKE ?`, [`%${toNumber.slice(-10)}`]).first())?.id ?? null;
  }
  const inserted = await db('whatsapp_inbound').insert({
    org_id: orgId, wa_message_id: String(msg.id), from_hash: fromHash, from_masked: maskPhone(from), to_number: toNumber,
    text: text.slice(0, 4000), interest_id: interest?.id ?? null, link_status: interest ? 'linked_token' : 'unlinked',
    received_at: msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date(),
  }).onConflict('wa_message_id').ignore().returning('id');
  if (!inserted.length) return 0; // reentrega do webhook — idempotente
  if (!interest) return 1; // sem token verificável: fica para vínculo manual, nunca associado automaticamente

  const firstFromNumber = !(await db('whatsapp_inbound').where({ interest_id: interest.id, from_hash: fromHash }).whereNot('id', inserted[0].id).first());
  if (firstFromNumber) await db('interest_events').insert({ interest_id: interest.id, type: 'conversation_started', payload: JSON.stringify({ from: maskPhone(from) }) });
  await db('interest_events').insert({ interest_id: interest.id, type: 'message_received', payload: JSON.stringify({ token, from: maskPhone(from) }) });
  await db('opportunity_interests').where({ id: interest.id }).whereIn('status', ['clicked', 'form_submitted', 'conversation_started'])
    .update({ status: 'message_received', updated_at: db.fn.now() });
  // telefone confirmado pelo WhatsApp: se o interesse era anônimo, guarda o número (o contato iniciou a conversa)
  if (!interest.phone) await db('opportunity_interests').where({ id: interest.id }).update({ phone: from });
  if (interest.negotiation_id) {
    await db('activities').insert({ org_id: interest.org_id, negotiation_id: interest.negotiation_id, opportunity_id: interest.opportunity_id, type: 'whatsapp', subject: 'Mensagem recebida no WhatsApp', body: text.slice(0, 2000) });
  }
  return 1;
}
