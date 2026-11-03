import type { Knex } from 'knex';
import { normalizePhone } from '../lib/crypto.js';

export interface RouteResult {
  broker_id: string | null;
  broker_name: string | null;
  number: string | null;
  via: string;
  rule_id: string | null;
  sla_minutes: number;
}

function matches(criteria: any, o: any) {
  if (criteria?.ufs?.length && !criteria.ufs.includes(o.uf)) return false;
  if (criteria?.cities?.length && !criteria.cities.map((c: string) => c.toLowerCase()).includes(String(o.city).toLowerCase())) return false;
  if (criteria?.types?.length && !criteria.types.includes(o.type)) return false;
  return true;
}

/**
 * Decide para quem vai o interesse. Ordem:
 *  1. regras ativas por prioridade (critérios por UF/cidade/tipo) → alvo: intermediador atribuído | rodízio | central
 *  2. sem regra aplicável: intermediador principal da área
 *  3. fallback: número central da organização
 * Intermediador inativo, sem WhatsApp ou com CRECI irregular é ignorado.
 */
export async function routeInterest(trx: Knex, o: { id: string; org_id: string; uf: string; city: string; type: string }): Promise<RouteResult> {
  const org = await trx('organizations').where({ id: o.org_id }).first();
  const central = normalizePhone(org?.central_whatsapp);
  const eligible = (q: Knex.QueryBuilder) =>
    q.join('users as u', 'u.id', 'b.user_id').where({ 'b.active': true, 'u.active': true }).whereNotNull('b.whatsapp').whereNot('b.creci_status', 'irregular');

  const assigned = async () =>
    eligible(trx('broker_assignments as ba').join('land_brokers as b', 'b.id', 'ba.broker_id'))
      .where({ 'ba.opportunity_id': o.id, 'ba.active': true, 'ba.role': 'primary' })
      .select('b.id', 'b.whatsapp', 'u.name').first();

  const rules = await trx('whatsapp_routing_rules').where({ org_id: o.org_id, active: true }).orderBy('priority');
  for (const r of rules) {
    if (!matches(r.criteria, o)) continue;
    if (r.target === 'assigned_broker') {
      const b = await assigned();
      if (b) return { broker_id: b.id, broker_name: b.name, number: normalizePhone(b.whatsapp), via: `regra: ${r.name}`, rule_id: r.id, sla_minutes: r.sla_minutes };
    } else if (r.target === 'round_robin' && r.broker_ids?.length) {
      const b = await eligible(trx('land_brokers as b')).whereIn('b.id', r.broker_ids)
        .orderByRaw('b.last_routed_at ASC NULLS FIRST').select('b.id', 'b.whatsapp', 'u.name').forUpdate().first();
      if (b) {
        await trx('land_brokers').where({ id: b.id }).update({ last_routed_at: trx.fn.now() });
        return { broker_id: b.id, broker_name: b.name, number: normalizePhone(b.whatsapp), via: `regra: ${r.name} (rodízio)`, rule_id: r.id, sla_minutes: r.sla_minutes };
      }
    } else if (r.target === 'central' && central) {
      return { broker_id: null, broker_name: 'Atendimento Dourado', number: central, via: `regra: ${r.name}`, rule_id: r.id, sla_minutes: r.sla_minutes };
    }
  }
  const b = await assigned();
  if (b) return { broker_id: b.id, broker_name: b.name, number: normalizePhone(b.whatsapp), via: 'intermediador atribuído', rule_id: null, sla_minutes: 60 };
  return { broker_id: null, broker_name: central ? 'Atendimento Dourado' : null, number: central, via: 'fallback: número central', rule_id: null, sla_minutes: 60 };
}
