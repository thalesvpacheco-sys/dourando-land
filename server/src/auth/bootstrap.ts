/**
 * Primeiro acesso em produção: cria a organização Dourado (se não existir), os perfis e o primeiro administrador,
 * e imprime o link de uso único para definir a senha.
 *
 *   npm run bootstrap -w server -- --email voce@empresa.com --name "Seu Nome"
 *
 * Rodar de novo com o mesmo e-mail só gera um novo link. O link sai só no terminal: no banco fica apenas o hash.
 */
import crypto from 'node:crypto';
import { ROLES } from '@dl/shared';
import { db, migrationConfig } from '../db/knex.js';
import { MATRIX } from './permissions.js';
import { createAuthLink } from './links.js';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const email = opt('email')?.trim().toLowerCase();
const name = opt('name')?.trim();
if (!email || !/.+@.+\..+/.test(email) || !name) { console.error('Uso: --email voce@empresa.com --name "Seu Nome"'); process.exit(1); }

await db.migrate.latest(migrationConfig);
await db('roles').insert(Object.entries(ROLES).map(([key, n]) => ({ key, name: n }))).onConflict('key').ignore();
for (const [role, res] of Object.entries(MATRIX)) {
  for (const [resource, g] of Object.entries(res)) {
    await db('permissions').insert({ role_key: role, resource, actions: g!.actions, scope: g!.scope }).onConflict(['role_key', 'resource']).merge();
  }
}
let org = await db('organizations').where({ slug: 'dourado' }).first();
if (!org) [org] = await db('organizations').insert({ name: 'Dourado Real Estate Partners', slug: 'dourado', kind: 'manager', code_prefix: 'DOU' }).returning('*');

let u = await db('users').whereRaw('lower(email) = ?', [email]).first();
if (!u) [u] = await db('users').insert({ org_id: org.id, external_id: `local_${crypto.randomUUID()}`, name, email, role: 'dourado_admin' }).returning('*');
if (u.role !== 'dourado_admin' || u.org_id !== org.id) { console.error('Este e-mail já existe com outro perfil. Ajuste pelo painel.'); process.exit(1); }

const link = await createAuthLink(u.id, u.password_hash ? 'reset' : 'invite', null);
console.log(`\nAdministrador: ${u.name} <${u.email}>\nDefina a senha neste link (uso único, ${u.password_hash ? '2 horas' : '72 horas'}):\n\n${link.url}\n`);
await db.destroy();
