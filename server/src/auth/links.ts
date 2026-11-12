import type { Knex } from 'knex';
import { config } from '../config.js';
import { db } from '../db/knex.js';
import { hashLinkToken, newLinkToken } from './credentials.js';

const TTL_HOURS: Record<'invite' | 'reset', number> = { invite: 72, reset: 2 };

/** Cria um link de uso único. Os links anteriores do mesmo tipo deixam de valer. O token não aparece na URL do servidor (vai depois do #). */
export async function createAuthLink(userId: string, kind: 'invite' | 'reset', createdBy: string | null, trx: Knex = db) {
  await trx('auth_tokens').where({ user_id: userId, kind }).whereNull('used_at').update({ used_at: trx.fn.now() });
  const token = newLinkToken();
  const expires = new Date(Date.now() + TTL_HOURS[kind] * 3600_000);
  await trx('auth_tokens').insert({ user_id: userId, kind, token_hash: hashLinkToken(token), expires_at: expires, created_by: createdBy });
  return { url: `${config.publicWebUrl.replace(/\/$/, '')}/painel/definir-senha#${token}`, expires_at: expires.toISOString() };
}

export const inviteText = (name: string, url: string) =>
  `Olá, ${name}.\n\nVocê foi convidado para o painel Dourado Land Intelligence. Defina sua senha neste link (válido por 72 horas):\n\n${url}\n\nSe não esperava este convite, ignore esta mensagem.`;
export const resetText = (name: string, url: string) =>
  `Olá, ${name}.\n\nRecebemos um pedido para redefinir sua senha do painel Dourado Land Intelligence. Use este link (válido por 2 horas):\n\n${url}\n\nSe não foi você, ignore esta mensagem: sua senha continua a mesma.`;
