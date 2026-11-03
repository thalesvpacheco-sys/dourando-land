import { Router, type Request } from 'express';
import { z } from 'zod';
import { NEGOTIATION_STAGES, type NegotiationStage } from '@dl/shared';
import { db } from '../db/knex.js';
import { authenticate, can, requireScope } from '../auth/auth.js';
import { grant } from '../auth/permissions.js';
import { ah, badRequest, conflict, forbidden, notFound, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { normalizePhone } from '../lib/crypto.js';
import { enqueue } from '../integrations/crm.js';
import { getScopedOpportunity } from '../domain/opportunities.js';

export const router = Router();
router.use(authenticate);

const STAGES = Object.keys(NEGOTIATION_STAGES) as [NegotiationStage, ...NegotiationStage[]];
const NONE = '00000000-0000-0000-0000-000000000000';

function scoped(req: Request, action: 'read' | 'create' | 'update') {
  const scope = requireScope(req, 'negotiation', action);
  const u = req.user!;
  const qb = db('negotiations as n').where('n.org_id', u.dataOrgId);
  if (scope === 'assigned') {
    qb.andWhere((w) =>
      w.whereExists(db('negotiation_participants as np').whereRaw('np.negotiation_id = n.id').andWhere('np.broker_id', u.brokerId ?? NONE))
        .orWhereExists(db('broker_assignments as ba').whereRaw('ba.opportunity_id = n.opportunity_id').andWhere({ 'ba.active': true, 'ba.broker_id': u.brokerId ?? NONE })),
    );
  } else if (scope === 'own') {
    qb.whereIn('n.partner_company_id', u.partnerCompanyIds.length ? u.partnerCompanyIds : [NONE]);
  }
  return qb;
}

async function getNegotiation(req: Request, id: string, action: 'read' | 'create' | 'update' = 'read') {
  const n = await scoped(req, action).where('n.id', id).select('n.*').first();
  if (!n) throw notFound('Negociação');
  return n;
}

router.get('/', ah(async (req, res) => {
  const q = req.query as Record<string, string>;
  const qb = scoped(req, 'read')
    .join('land_opportunities as o', 'o.id', 'n.opportunity_id')
    .leftJoin('partner_companies as p', 'p.id', 'n.partner_company_id')
    .leftJoin('users as ow', 'ow.id', 'n.owner_id');
  if (q.stage) qb.whereIn('n.stage', q.stage.split(','));
  if (q.status) qb.whereIn('n.status', q.status.split(',')); else qb.where('n.status', 'open');
  if (q.opportunity_id) qb.where('n.opportunity_id', q.opportunity_id);
  const showValue = can(req, 'proposal', 'read');
  const rows = await qb.select(
    'n.id', 'n.stage', 'n.status', 'n.contact_name', 'n.next_activity', 'n.next_activity_at', 'n.expected_close', 'n.updated_at', 'n.created_at', 'n.opportunity_id',
    showValue ? 'n.proposed_value' : db.raw('null as proposed_value'), 'n.proposed_model',
    'o.code', 'o.public_title', 'o.internal_name', 'o.city', 'o.uf', 'o.area_m2', 'p.name as partner_name', 'ow.name as owner_name',
    db('proposals').whereRaw('negotiation_id = n.id').count().as('proposal_count'),
    db.raw(`(SELECT string_agg(u.name, ', ') FROM negotiation_participants np JOIN land_brokers b ON b.id = np.broker_id JOIN users u ON u.id = b.user_id WHERE np.negotiation_id = n.id) as brokers`),
  ).orderBy('n.updated_at', 'desc').limit(500);
  res.json({ items: rows, stages: NEGOTIATION_STAGES });
}));

const createSchema = z.object({
  opportunity_id: z.string().uuid(),
  partner_company_id: z.string().uuid().nullable().optional(),
  contact_name: z.string().min(2).max(120),
  contact_email: z.string().email().optional().or(z.literal('')),
  contact_phone: z.string().max(24).optional().or(z.literal('')),
  proposed_model: z.string().max(120).optional(),
  proposed_value: z.number().nonnegative().nullable().optional(),
  stage: z.enum(STAGES).optional(),
});

router.post('/', ah(async (req, res) => {
  requireScope(req, 'negotiation', 'create');
  const b = parse(createSchema, req.body);
  const o = await getScopedOpportunity(req, b.opportunity_id);
  if (b.partner_company_id && !(await db('partner_companies').where({ id: b.partner_company_id, org_id: req.user!.dataOrgId }).first())) throw notFound('Empresa');
  const neg = await db.transaction(async (trx) => {
    const [n] = await trx('negotiations').insert({
      org_id: req.user!.dataOrgId, opportunity_id: o.id, partner_company_id: b.partner_company_id ?? null, contact_name: b.contact_name,
      contact_email: b.contact_email || null, contact_phone: normalizePhone(b.contact_phone), proposed_model: b.proposed_model, proposed_value: b.proposed_value,
      stage: b.stage ?? 'interesse_recebido', owner_id: req.user!.id,
    }).returning('*');
    if (req.user!.brokerId) await trx('negotiation_participants').insert({ negotiation_id: n.id, broker_id: req.user!.brokerId });
    await trx('activities').insert({ org_id: n.org_id, opportunity_id: o.id, negotiation_id: n.id, type: 'system', subject: 'Negociação criada', user_id: req.user!.id });
    await enqueue(trx, n.org_id, 'deal.upsert', { negotiation_id: n.id, opportunity_code: o.code, stage: n.stage, contact: { name: n.contact_name, email: n.contact_email, phone: n.contact_phone } }, `deal:${n.id}:1`);
    await audit(req, 'create', 'negotiations', n.id, { opportunity_id: o.id }, trx);
    return n;
  });
  res.status(201).json(neg);
}));

router.get('/:id', ah(async (req, res) => {
  const n = await getNegotiation(req, String(req.params.id));
  const [opp, partner, participants, activities, proposals, commissions] = await Promise.all([
    db('land_opportunities').where({ id: n.opportunity_id }).select('id', 'code', 'slug', 'public_title', 'internal_name', 'city', 'uf', 'area_m2', 'status').first(),
    n.partner_company_id ? db('partner_companies').where({ id: n.partner_company_id }).first() : null,
    db('negotiation_participants as np').join('land_brokers as b', 'b.id', 'np.broker_id').join('users as u', 'u.id', 'b.user_id').where('np.negotiation_id', n.id).select('b.id', 'u.name', 'np.role', 'b.creci', 'b.creci_status'),
    db('activities as a').leftJoin('users as u', 'u.id', 'a.user_id').where('a.negotiation_id', n.id).select('a.*', 'u.name as user_name').orderBy('a.created_at', 'desc'),
    can(req, 'proposal', 'read') ? db('proposals').where({ negotiation_id: n.id }).orderBy('created_at', 'desc') : [],
    commissionsFor(req, n.id),
  ]);
  const pids = (proposals as any[]).map((p) => p.id);
  const versions = pids.length ? await db('proposal_versions as v').leftJoin('users as u', 'u.id', 'v.created_by').whereIn('v.proposal_id', pids).select('v.*', 'u.name as author').orderBy('v.version', 'desc') : [];
  const approvals = pids.length ? await db('proposal_approvals as a').join('users as u', 'u.id', 'a.approver_id').whereIn('a.proposal_id', pids).select('a.*', 'u.name as approver') : [];
  res.json({
    ...n, opportunity: opp, partner, participants, activities,
    proposals: (proposals as any[]).map((p) => ({ ...p, versions: versions.filter((v: any) => v.proposal_id === p.id), approvals: approvals.filter((a: any) => a.proposal_id === p.id) })),
    commissions,
    permissions: {
      update: can(req, 'negotiation', 'update'), propose: can(req, 'proposal', 'create'), approve: can(req, 'proposal', 'approve'),
      commission: can(req, 'commission', 'update'),
    },
  });
}));

const patchSchema = z.object({
  version: z.number().int(),
  stage: z.enum(STAGES).optional(),
  status: z.enum(['open', 'won', 'lost', 'suspended']).optional(),
  lost_reason: z.string().max(240).nullable().optional(),
  next_activity: z.string().max(200).nullable().optional(),
  next_activity_at: z.string().datetime({ offset: true }).nullable().optional(),
  expected_close: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  proposed_model: z.string().max(120).nullable().optional(),
  proposed_value: z.number().nonnegative().nullable().optional(),
  partner_company_id: z.string().uuid().nullable().optional(),
  owner_id: z.string().uuid().nullable().optional(),
});

router.patch('/:id', ah(async (req, res) => {
  const b = parse(patchSchema, req.body);
  const n = await getNegotiation(req, String(req.params.id), 'update');
  if (n.version !== b.version) throw conflict('Negociação alterada por outra pessoa. Recarregue.', { current_version: n.version });
  if ((b.status === 'lost' || b.status === 'suspended') && !b.lost_reason) throw badRequest('Informe o motivo de perda ou suspensão');
  if (b.status === 'won' && (b.stage ?? n.stage) !== 'conclusao') throw badRequest('Uma negociação só é concluída na etapa Conclusão');
  const { version, ...upd } = b;
  await db.transaction(async (trx) => {
    await trx('negotiations').where({ id: n.id }).update({ ...upd, version: n.version + 1, updated_at: trx.fn.now() });
    if (b.stage && b.stage !== n.stage) {
      await trx('activities').insert({ org_id: n.org_id, opportunity_id: n.opportunity_id, negotiation_id: n.id, type: 'stage_change', subject: `${NEGOTIATION_STAGES[n.stage as NegotiationStage]} → ${NEGOTIATION_STAGES[b.stage]}`, user_id: req.user!.id });
      // área entra "em negociação" quando alguma negociação chega à proposta
      const idx = STAGES.indexOf(b.stage);
      if (idx >= STAGES.indexOf('proposta')) await trx('land_opportunities').where({ id: n.opportunity_id }).whereIn('status', ['disponivel', 'qualificada']).update({ status: 'em_negociacao', updated_at: trx.fn.now() });
    }
    if (b.status && b.status !== n.status) {
      await trx('activities').insert({ org_id: n.org_id, opportunity_id: n.opportunity_id, negotiation_id: n.id, type: 'system', subject: `Status: ${b.status}${b.lost_reason ? ` — ${b.lost_reason}` : ''}`, user_id: req.user!.id });
    }
    await enqueue(trx, n.org_id, 'deal.upsert', { negotiation_id: n.id, crm_deal_id: n.crm_deal_id, stage: b.stage ?? n.stage, status: b.status ?? n.status }, `deal:${n.id}:${n.version + 1}`);
    await audit(req, 'update', 'negotiations', n.id, upd, trx);
  });
  res.json({ version: n.version + 1 });
}));

router.post('/:id/participants', ah(async (req, res) => {
  requireScope(req, 'routing', 'update');
  const b = parse(z.object({ broker_id: z.string().uuid(), role: z.string().max(40).default('intermediador') }), req.body);
  const n = await getNegotiation(req, String(req.params.id), 'update');
  const br = await db('land_brokers').where({ id: b.broker_id, org_id: req.user!.dataOrgId }).first();
  if (!br) throw notFound('Intermediador');
  await db('negotiation_participants').insert({ negotiation_id: n.id, ...b }).onConflict(['negotiation_id', 'broker_id']).merge();
  await audit(req, 'participant.add', 'negotiations', n.id, b);
  res.status(201).json({ ok: true });
}));

// ------------------------------------------------------------------ atividades

router.post('/:id/activities', ah(async (req, res) => {
  const b = parse(z.object({
    type: z.enum(['note', 'call', 'meeting', 'visit', 'whatsapp', 'email', 'task']),
    subject: z.string().min(2).max(200), body: z.string().max(4000).optional(),
    due_at: z.string().datetime({ offset: true }).optional(), done: z.boolean().optional(),
  }), req.body);
  const n = await getNegotiation(req, String(req.params.id), 'update');
  const [a] = await db.transaction(async (trx) => {
    const rows = await trx('activities').insert({
      org_id: n.org_id, opportunity_id: n.opportunity_id, negotiation_id: n.id, type: b.type, subject: b.subject, body: b.body,
      due_at: b.due_at ?? null, done_at: b.done || !b.due_at ? trx.fn.now() : null, user_id: req.user!.id,
    }).returning('*');
    await enqueue(trx, n.org_id, 'activity.log', { activity_id: rows[0].id, negotiation_id: n.id, crm_deal_id: n.crm_deal_id, crm_contact_id: n.crm_contact_id, type: b.type, subject: b.subject }, `activity:${rows[0].id}`);
    // primeira interação humana registra o primeiro atendimento do interesse (SLA)
    if (n.interest_id) {
      await trx('opportunity_interests').where({ id: n.interest_id }).whereNull('first_response_at').update({ first_response_at: trx.fn.now() });
    }
    if (b.due_at) await trx('negotiations').where({ id: n.id }).update({ next_activity: b.subject, next_activity_at: b.due_at });
    return rows;
  });
  res.status(201).json(a);
}));

router.post('/activities/:aid/done', ah(async (req, res) => {
  const a = await db('activities').where({ id: String(req.params.aid), org_id: req.user!.dataOrgId }).first();
  if (!a?.negotiation_id) throw notFound('Atividade');
  await getNegotiation(req, a.negotiation_id, 'update');
  await db('activities').where({ id: a.id }).update({ done_at: db.fn.now() });
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ propostas (versionadas)

const versionSchema = z.object({
  acquisition_value: z.number().nonnegative().nullable().optional(),
  swap_pct: z.number().min(0).max(100).nullable().optional(),
  payment_schedule: z.array(z.object({ label: z.string().max(120), amount: z.number().nonnegative().nullable().optional(), due: z.string().max(40).optional() })).default([]),
  suspensive_conditions: z.string().max(4000).nullable().optional(),
  analysis_days: z.number().int().min(0).max(365).nullable().optional(),
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  attachment_ids: z.array(z.string().uuid()).default([]),
  broker_ids: z.array(z.string().uuid()).default([]),
});

async function getProposal(req: Request, pid: string, action: 'read' | 'create' | 'update' = 'read') {
  const p = await db('proposals').where({ id: pid, org_id: req.user!.dataOrgId }).first();
  if (!p) throw notFound('Proposta');
  await getNegotiation(req, p.negotiation_id, 'read');
  requireScope(req, 'proposal', action);
  return p;
}

router.post('/:id/proposals', ah(async (req, res) => {
  requireScope(req, 'proposal', 'create');
  const b = parse(versionSchema.extend({ side: z.enum(['comprador', 'vendedor']).default('comprador') }), req.body);
  const n = await getNegotiation(req, String(req.params.id), 'read');
  if (req.user!.role === 'buyer' && b.side !== 'comprador') throw forbidden();
  const p = await db.transaction(async (trx) => {
    const [p] = await trx('proposals').insert({ org_id: n.org_id, negotiation_id: n.id, opportunity_id: n.opportunity_id, status: 'submitted', created_by: req.user!.id }).returning('*');
    const { side, ...v } = b;
    await trx('proposal_versions').insert({ proposal_id: p.id, version: 1, side, ...v, payment_schedule: JSON.stringify(v.payment_schedule), created_by: req.user!.id });
    await trx('negotiations').where({ id: n.id }).update({
      proposed_value: b.acquisition_value ?? n.proposed_value, updated_at: trx.fn.now(),
      stage: STAGES.indexOf(n.stage) < STAGES.indexOf('proposta') ? 'proposta' : n.stage,
    });
    await trx('activities').insert({ org_id: n.org_id, opportunity_id: n.opportunity_id, negotiation_id: n.id, type: 'system', subject: 'Proposta registrada (v1)', user_id: req.user!.id });
    await audit(req, 'create', 'proposals', p.id, { negotiation_id: n.id }, trx);
    return p;
  });
  res.status(201).json(p);
}));

export const proposalsRouter = Router();
proposalsRouter.use(authenticate);

proposalsRouter.post('/:pid/versions', ah(async (req, res) => {
  const b = parse(versionSchema.extend({ side: z.enum(['comprador', 'vendedor']) }), req.body);
  const p = await getProposal(req, String(req.params.pid), 'create');
  if (req.user!.role === 'buyer' && b.side !== 'comprador') throw forbidden();
  if (['accepted', 'rejected', 'expired'].includes(p.status)) throw conflict('Proposta encerrada');
  const version = await db.transaction(async (trx) => {
    const locked = await trx('proposals').where({ id: p.id }).forUpdate().first();
    const version = locked.current_version + 1;
    const { side, ...v } = b;
    await trx('proposal_versions').insert({ proposal_id: p.id, version, side, ...v, payment_schedule: JSON.stringify(v.payment_schedule), created_by: req.user!.id });
    await trx('proposals').where({ id: p.id }).update({ current_version: version, status: side === 'vendedor' ? 'countered' : 'submitted', updated_at: trx.fn.now() });
    await trx('activities').insert({ org_id: p.org_id, opportunity_id: p.opportunity_id, negotiation_id: p.negotiation_id, type: 'system', subject: `${side === 'vendedor' ? 'Contraproposta' : 'Nova versão da proposta'} (v${version})`, user_id: req.user!.id });
    await audit(req, 'version', 'proposals', p.id, { version, side }, trx);
    return version;
  });
  res.status(201).json({ version });
}));

proposalsRouter.post('/:pid/internal-review', ah(async (req, res) => {
  const p = await getProposal(req, String(req.params.pid), 'update');
  await db('proposals').where({ id: p.id }).update({ status: 'internal_review', updated_at: db.fn.now() });
  res.json({ status: 'internal_review' });
}));

proposalsRouter.post('/:pid/approval', ah(async (req, res) => {
  requireScope(req, 'proposal', 'approve');
  const b = parse(z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(2000).optional() }), req.body);
  const p = await getProposal(req, String(req.params.pid), 'read');
  await db.transaction(async (trx) => {
    await trx('proposal_approvals').insert({ proposal_id: p.id, version: p.current_version, approver_id: req.user!.id, decision: b.decision, comment: b.comment });
    await trx('proposals').where({ id: p.id }).update({ status: b.decision === 'approved' ? 'approved_internal' : 'internal_review', updated_at: trx.fn.now() });
    await audit(req, `proposal.${b.decision}`, 'proposals', p.id, { version: p.current_version, comment: b.comment }, trx);
  });
  res.json({ ok: true });
}));

proposalsRouter.post('/:pid/status', ah(async (req, res) => {
  requireScope(req, 'proposal', 'update');
  const b = parse(z.object({ status: z.enum(['accepted', 'rejected', 'expired']) }), req.body);
  const p = await getProposal(req, String(req.params.pid), 'update');
  if (b.status === 'accepted' && p.status !== 'approved_internal' && !can(req, 'proposal', 'approve')) throw badRequest('Aceite exige aprovação interna da versão atual');
  await db('proposals').where({ id: p.id }).update({ status: b.status, updated_at: db.fn.now() });
  await db('activities').insert({ org_id: p.org_id, opportunity_id: p.opportunity_id, negotiation_id: p.negotiation_id, type: 'system', subject: `Proposta v${p.current_version}: ${b.status}`, user_id: req.user!.id });
  await audit(req, `proposal.${b.status}`, 'proposals', p.id, { version: p.current_version });
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ comissões (confidencial)

async function commissionsFor(req: Request, negotiationId: string) {
  const scope = req.user ? grant(req.user.role, 'commission', 'read') : null;
  if (!scope) return [];
  const qb = db('commissions as c').leftJoin('land_brokers as b', 'b.id', 'c.broker_id').leftJoin('users as u', 'u.id', 'b.user_id')
    .where('c.negotiation_id', negotiationId).select('c.*', 'u.name as broker_name');
  if (scope === 'own') qb.where('c.broker_id', req.user!.brokerId ?? NONE);
  return qb;
}

router.post('/:id/commissions', ah(async (req, res) => {
  requireScope(req, 'commission', 'create');
  const b = parse(z.object({
    broker_id: z.string().uuid().nullable().optional(), beneficiary_name: z.string().min(2).max(160),
    pct: z.number().min(0).max(100).nullable().optional(), amount: z.number().nonnegative().nullable().optional(),
    trigger_condition: z.string().max(400).optional(),
  }), req.body);
  const n = await getNegotiation(req, String(req.params.id), 'update');
  if (b.broker_id) {
    const br = await db('land_brokers').where({ id: b.broker_id, org_id: req.user!.dataOrgId }).first();
    if (!br) throw notFound('Intermediador');
    if (br.creci_status !== 'ativo' && br.creci_status !== 'nao_aplicavel') throw badRequest('Intermediador sem habilitação profissional validada (CRECI)');
  }
  const [c] = await db('commissions').insert({
    ...b, org_id: n.org_id, negotiation_id: n.id, opportunity_id: n.opportunity_id, status: 'prevista',
    history: JSON.stringify([{ to: 'prevista', at: new Date().toISOString(), by: req.user!.name }]),
  }).returning('*');
  await audit(req, 'create', 'commissions', c.id, b);
  res.status(201).json(c);
}));

/**
 * Máquina de estados da comissão. Nenhuma transição é automática:
 *  prevista → contratada  exige contrato de intermediação anexado
 *  contratada → exigivel  exige negociação em Contrato/Conclusão e descrição do evento que tornou exigível
 *  exigivel → paga        exige data de pagamento
 *  * → cancelada          exige justificativa
 */
proposalsRouter.post('/commissions/:cid/transition', ah(async (req, res) => {
  requireScope(req, 'commission', 'update');
  const b = parse(z.object({ to: z.enum(['contratada', 'exigivel', 'paga', 'cancelada']), contract_document_id: z.string().uuid().optional(), note: z.string().max(400).optional(), paid_at: z.string().optional(), due_at: z.string().optional() }), req.body);
  const c = await db('commissions').where({ id: String(req.params.cid), org_id: req.user!.dataOrgId }).first();
  if (!c) throw notFound('Comissão');
  const n = await db('negotiations').where({ id: c.negotiation_id }).first();
  const allowed: Record<string, string[]> = { prevista: ['contratada', 'cancelada'], contratada: ['exigivel', 'cancelada'], exigivel: ['paga', 'cancelada'], paga: [], cancelada: [] };
  if (!allowed[c.status].includes(b.to)) throw conflict(`Transição ${c.status} → ${b.to} não permitida`);
  const upd: any = { status: b.to, updated_at: db.fn.now() };
  if (b.to === 'contratada') {
    const doc = b.contract_document_id && await db('land_documents').where({ id: b.contract_document_id, opportunity_id: c.opportunity_id, category: 'contrato_intermediacao' }).first();
    if (!doc) throw badRequest('Vincule o contrato de intermediação (documento da área, categoria "Contrato de intermediação")');
    upd.contract_document_id = doc.id;
  }
  if (b.to === 'exigivel') {
    if (!['contrato', 'conclusao'].includes(n.stage)) throw badRequest('A comissão só se torna exigível com a negociação em Contrato ou Conclusão');
    if (!b.note) throw badRequest('Descreva o evento contratual que tornou a comissão exigível');
    upd.due_at = b.due_at ?? null;
  }
  if (b.to === 'paga') {
    if (!b.paid_at) throw badRequest('Informe a data de pagamento');
    upd.paid_at = b.paid_at;
  }
  if (b.to === 'cancelada' && !b.note) throw badRequest('Informe a justificativa');
  upd.history = JSON.stringify([...(c.history ?? []), { from: c.status, to: b.to, at: new Date().toISOString(), by: req.user!.name, note: b.note }]);
  await db('commissions').where({ id: c.id }).update(upd);
  await audit(req, `commission.${b.to}`, 'commissions', c.id, b);
  res.json({ status: b.to });
}));
