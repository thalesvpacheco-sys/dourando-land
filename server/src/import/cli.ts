/**
 * Importação do inventário de áreas (pastas do Drive).
 *
 *   npm run import:inventory -w server -- --dir "/caminho/GRANDES NEGÓCIOS" --org dourado --user admin@dourado.com.br
 *   npm run import:inventory -w server -- --package ./pacote --org dourado --apply
 *
 * Sem --apply: só gera o relatório (prévia), não grava nada.
 * Com --apply: grava de forma idempotente (pode rodar de novo a qualquer momento para sincronizar).
 */
import fs from 'node:fs/promises';
import { db } from '../db/knex.js';
import { applyPlan, measure } from './apply.js';
import { buildPlan } from './plan.js';
import { FolderSource, PackageSource } from './sources.js';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (k: string) => args.includes(`--${k}`);

const dir = opt('dir'); const pkg = opt('package');
if (!dir && !pkg) { console.error('Informe --dir <pasta> ou --package <pacote>'); process.exit(1); }
const src = dir ? new FolderSource(dir, opt('label') ?? dir) : new PackageSource(pkg!, opt('label') ?? pkg);
const sourceKey = opt('source') ?? 'drive:grandes-negocios';
const out = opt('out') ?? 'import-report.json';

const org = await db('organizations').where({ slug: opt('org') ?? 'dourado' }).first();
if (!org) { console.error('Organização não encontrada'); process.exit(1); }
const user = opt('user') ? await db('users').where({ email: opt('user') }).first() : null;

console.time('plano');
const plan = await buildPlan(src);
await measure(plan, db);
console.timeEnd('plano');

let applied: any = null;
if (flag('apply')) {
  console.time('aplicação');
  applied = await applyPlan(db, plan, src, { orgId: org.id, userId: user?.id ?? null, source: sourceKey, mode: 'apply' });
  console.timeEnd('aplicação');
  console.log('Resultado:', applied.summary);
}

const slim = { ...plan, units: plan.units.map((u) => ({ ...u, description_text: u.description_text.slice(0, 1500), geometry: { ...u.geometry, polygons: u.geometry.polygons.length } })) };
await fs.writeFile(out, JSON.stringify({ plan: slim, applied }, null, 1));
console.log('Prévia:', plan.totals);
console.log(`Relatório: ${out}`);
await db.destroy();
