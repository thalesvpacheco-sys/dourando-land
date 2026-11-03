import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { config } from '../config.js';
import { db } from '../db/knex.js';
import { hmac } from '../lib/crypto.js';

/**
 * Adaptador do WingsBr CRM / Leads Hub.
 *
 * - Com WINGSBR_CRM_URL: entrega HTTP assinada (HMAC-SHA256 em X-WingsBr-Signature) com Idempotency-Key.
 * - Sem URL: MODO EMBUTIDO (simulado). Grava um espelho mínimo em crm_contacts apenas para desenvolvimento/demonstração.
 *   Esse modo é sinalizado na API (/api/integrations/status) e na interface — não é um CRM.
 *
 * Toda chamada passa pela tabela crm_outbox (at-least-once + idempotência no receptor), com até 8 tentativas e backoff exponencial.
 */

export type OutboxKind = 'contact.upsert' | 'lead.create' | 'activity.log' | 'deal.upsert';
export const crmMode = () => (config.crmUrl ? 'http' : 'embedded');

export async function enqueue(trx: Knex, orgId: string, kind: OutboxKind, payload: Record<string, unknown>, idempotencyKey?: string) {
  const [row] = await trx('crm_outbox')
    .insert({ org_id: orgId, kind, payload: JSON.stringify(payload), idempotency_key: idempotencyKey ?? `${kind}:${crypto.randomUUID()}` })
    .onConflict('idempotency_key').ignore()
    .returning('id');
  return row?.id as string | undefined;
}

async function deliverHttp(kind: string, payload: any, key: string) {
  const body = JSON.stringify({ kind, payload, source: 'dourado-land' });
  const r = await fetch(`${config.crmUrl!.replace(/\/$/, '')}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, 'x-wingsbr-signature': `sha256=${hmac(body, config.crmSecret)}` },
    body,
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`CRM respondeu ${r.status}`);
  return r.json().catch(() => ({}));
}

async function deliverEmbedded(orgId: string, kind: string, p: any) {
  if (kind === 'contact.upsert') {
    const q = db('crm_contacts').where({ org_id: orgId }).andWhere((w) => {
      if (p.email) w.orWhere('email', p.email);
      if (p.phone) w.orWhere('phone', p.phone);
    });
    const existing = p.email || p.phone ? await q.first() : null;
    if (existing) {
      const tags = Array.from(new Set([...(existing.tags ?? []), ...(p.tags ?? [])]));
      await db('crm_contacts').where({ id: existing.id }).update({
        name: p.name ?? existing.name, company: p.company ?? existing.company, tags: JSON.stringify(tags), updated_at: db.fn.now(),
      });
      return { contact_id: existing.id, deduplicated: true };
    }
    const id = `emb_${crypto.randomUUID().slice(0, 12)}`;
    await db('crm_contacts').insert({ id, org_id: orgId, name: p.name, email: p.email, phone: p.phone, company: p.company, tags: JSON.stringify(p.tags ?? []) });
    return { contact_id: id, deduplicated: false };
  }
  if (kind === 'lead.create') return { lead_id: `emb_lead_${crypto.randomUUID().slice(0, 10)}` };
  if (kind === 'deal.upsert') return { deal_id: p.crm_deal_id ?? `emb_deal_${crypto.randomUUID().slice(0, 10)}` };
  return { activity_id: `emb_act_${crypto.randomUUID().slice(0, 10)}` };
}

/** Efeitos locais após entrega: grava IDs do CRM nas entidades do módulo. */
async function applyResult(kind: string, p: any, result: any) {
  if (p.interest_id && kind === 'contact.upsert' && result.contact_id) {
    await db('opportunity_interests').where({ id: p.interest_id }).update({ crm_contact_id: result.contact_id, crm_sync_status: 'synced', updated_at: db.fn.now() });
    await db('negotiations').where({ interest_id: p.interest_id }).whereNull('crm_contact_id').update({ crm_contact_id: result.contact_id });
    await db('interest_events').insert({ interest_id: p.interest_id, type: 'crm_synced', payload: JSON.stringify({ mode: crmMode(), ...result }) });
  }
  if (p.interest_id && kind === 'lead.create' && result.lead_id) {
    await db('opportunity_interests').where({ id: p.interest_id }).update({ crm_lead_id: result.lead_id });
  }
  if (p.negotiation_id && kind === 'deal.upsert' && result.deal_id) {
    await db('negotiations').where({ id: p.negotiation_id }).update({ crm_deal_id: result.deal_id });
  }
  if (p.activity_id && kind === 'activity.log' && result.activity_id) {
    await db('activities').where({ id: p.activity_id }).update({ crm_activity_id: result.activity_id });
  }
}

export async function processOutbox(limit = 20, onlyIds?: string[]) {
  const rows = await db.transaction(async (trx) => {
    const q = trx('crm_outbox').where('status', 'pending').andWhere('next_attempt_at', '<=', trx.fn.now()).orderBy('created_at').limit(limit).forUpdate().skipLocked();
    if (onlyIds) q.whereIn('id', onlyIds);
    const rows = await q;
    if (rows.length) await trx('crm_outbox').whereIn('id', rows.map((r) => r.id)).update({ next_attempt_at: trx.raw(`now() + interval '2 minutes'`) });
    return rows;
  });
  for (const r of rows) {
    try {
      const result = config.crmUrl ? await deliverHttp(r.kind, r.payload, r.idempotency_key) : await deliverEmbedded(r.org_id, r.kind, r.payload);
      await db('crm_outbox').where({ id: r.id }).update({ status: 'done', attempts: r.attempts + 1, result: JSON.stringify(result), updated_at: db.fn.now() });
      await applyResult(r.kind, r.payload, result);
    } catch (e: any) {
      const attempts = r.attempts + 1;
      const dead = attempts >= 8;
      await db('crm_outbox').where({ id: r.id }).update({
        attempts, status: dead ? 'dead' : 'pending', last_error: String(e.message).slice(0, 500),
        next_attempt_at: db.raw(`now() + (? * interval '1 minute')`, [2 ** attempts]), updated_at: db.fn.now(),
      });
      if (dead && r.payload.interest_id) await db('opportunity_interests').where({ id: r.payload.interest_id }).update({ crm_sync_status: 'failed' });
    }
  }
  return rows.length;
}
