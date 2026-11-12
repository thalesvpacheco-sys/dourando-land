/**
 * Carrega uma base oficial (shapefile) no PostGIS. Lê em fluxo, então aguenta arquivos de vários GB.
 *
 *   npm run territory:import -w server -- --layer sigef --uf GO --file ./sigef_privado_GO.zip
 *   npm run territory:import -w server -- --layer car_app --uf GO --file ./GO_APPS.zip
 *
 * A carga substitui os dados daquela camada/UF numa única transação: se falhar, a base anterior continua valendo.
 * Camadas: veja TERRITORY_LAYERS em shared/src/index.ts.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — shapefile não publica tipos
import * as shapefile from 'shapefile';
import { TERRITORY_LAYER_KEYS, UFS } from '@dl/shared';
import { db, migrationConfig } from '../db/knex.js';
import { normalize } from './territory.js';

export async function importShapefile(opts: { layer: string; uf: string; file: string; encoding?: string; sourceName?: string; ufField?: boolean; append?: boolean }) {
  const { layer, uf } = opts;
  if (!TERRITORY_LAYER_KEYS.includes(layer as any)) throw new Error(`Camada desconhecida: ${layer}. Use: ${TERRITORY_LAYER_KEYS.join(', ')}`);
  if (!UFS.includes(uf as any)) throw new Error(`UF inválida: ${uf}`);

  let shp = opts.file;
  let tmp: string | null = null;
  if (/\.zip$/i.test(shp)) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'territorio-'));
    // extração em fluxo (bases do CAR passam de 1 GB): no Windows, o tar do sistema (bsdtar) lê .zip; no Linux, unzip
    if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', shp, '-C', tmp]);
    else execFileSync('unzip', ['-q', '-o', shp, '-d', tmp]);
    const find = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? find(path.join(d, e.name)) : /\.shp$/i.test(e.name) ? [path.join(d, e.name)] : []));
    const all = find(tmp);
    if (all.length !== 1) throw new Error(`O arquivo .zip precisa ter exatamente um .shp (encontrados: ${all.length})`);
    shp = all[0];
  }
  try {
    let source: { read: () => Promise<{ done: boolean; value: any }> };
    if (/\.(geo)?json$/i.test(shp)) {
      // GeoJSON (ex.: baixado de um serviço ArcGIS/WFS oficial com scripts/baixar-bases.py), em coordenadas geográficas
      const features: any[] = JSON.parse(fs.readFileSync(shp, 'utf8')).features ?? [];
      let i = 0;
      source = { read: async () => (i < features.length ? { done: false, value: features[i++] } : { done: true, value: undefined }) };
    } else {
      const prj = shp.replace(/\.shp$/i, '.prj');
      if (fs.existsSync(prj) && /^\s*PROJCS/i.test(fs.readFileSync(prj, 'utf8'))) throw new Error('O shapefile está em coordenadas projetadas. Reprojete para geográficas (SIRGAS 2000 ou WGS 84).');
      source = await shapefile.open(shp, shp.replace(/\.shp$/i, '.dbf'), { encoding: opts.encoding ?? 'utf-8' });
    }
    let total = 0, skipped = 0;
    await db.transaction(async (trx) => {
      // --append soma ao que já existe (ex.: SIGEF privado + público); sem ele, a carga substitui a camada/UF
      if (!opts.append) await trx('territory_features').where({ layer, uf }).del();
      let batch: any[] = [];
      const flush = async () => {
        if (!batch.length) return;
        await trx.raw(
          `INSERT INTO territory_features (layer, uf, code, name, area_ha, municipio, situacao, matricula, cns_serventia, data_referencia, raw, geom)
           SELECT ?, ?, x->>'code', x->>'name', (x->>'area_ha')::double precision, x->>'municipio', x->>'situacao', x->>'matricula', x->>'cns', x->>'data', x->'raw', g
           FROM (SELECT x, ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(x->>'geom'), 4326)), 3)) AS g FROM jsonb_array_elements(?::jsonb) x) s
           WHERE NOT ST_IsEmpty(g)`,
          // algumas bases (ex.: FUNAI) trazem caracteres nulos nos textos, que o PostgreSQL recusa em jsonb
          [layer, uf, JSON.stringify(batch, (_k, v) => (typeof v === 'string' ? v.replace(/\u0000/g, '') : v))],
        );
        batch = [];
      };
      for (;;) {
        const { done, value } = await source.read();
        if (done) break;
        if (!value.geometry || !/Polygon$/.test(value.geometry.type)) { skipped++; continue; }
        const n = normalize(layer, value.properties ?? {});
        const area = n.area_ha != null && Number.isFinite(Number(n.area_ha)) ? Number(n.area_ha) : null;
        batch.push({ code: n.codigo || null, name: n.nome, area_ha: area, municipio: n.municipio, situacao: n.situacao, matricula: n.matricula != null ? String(n.matricula) : null, cns: n.cns_serventia != null ? String(n.cns_serventia) : null, data: n.data_referencia != null ? String(n.data_referencia) : null, raw: value.properties ?? {}, geom: JSON.stringify(value.geometry) });
        total++;
        if (batch.length >= 500) { await flush(); if (total % 10000 === 0) console.log(`${total} registros…`); }
      }
      await flush();
      if (!total) throw new Error('Nenhum polígono encontrado. Nada foi alterado.');
      // área ausente na base: calcula pela geometria para o radar funcionar
      await trx.raw(`UPDATE territory_features SET area_ha = ST_Area(geom::geography) / 10000 WHERE layer = ? AND uf = ? AND area_ha IS NULL`, [layer, uf]);
      const inserted = (await trx('territory_features').where({ layer, uf }).count({ n: '*' }).first())!.n;
      await trx('territory_datasets').insert({ layer, uf, source_name: opts.sourceName ?? path.basename(opts.file), features: Number(inserted), loaded_at: trx.fn.now() }).onConflict(['layer', 'uf']).merge();
    });
    await db.raw('ANALYZE territory_features');
    return { total, skipped };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('territory-cli.ts')) {
  const args = process.argv.slice(2);
  const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const [layer, uf, file] = [opt('layer'), opt('uf')?.toUpperCase(), opt('file')];
  if (!layer || !uf || !file) { console.error('Uso: --layer <camada> --uf <UF> --file <arquivo .zip, .shp ou .geojson> [--encoding latin1] [--source "Nome da fonte"] [--append]'); process.exit(1); }
  await db.migrate.latest(migrationConfig);
  try {
    const r = await importShapefile({ layer, uf, file, encoding: opt('encoding'), sourceName: opt('source'), append: args.includes('--append') });
    console.log(`Carregados ${r.total} registros de ${layer}/${uf}${r.skipped ? ` (${r.skipped} sem polígono ignorados)` : ''}.`);
  } catch (e: any) { console.error(`Falha: ${e.message}`); process.exitCode = 1; }
  await db.destroy();
}
