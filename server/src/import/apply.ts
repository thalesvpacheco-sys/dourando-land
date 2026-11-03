/**
 * Grava o plano na plataforma de forma idempotente.
 *  - Pasta nova → área do banco (status captação, rascunho, vitrine privada) ou prospecção, conforme o plano.
 *  - Pasta já importada e sem mudança → nada.
 *  - Pasta alterada → atualiza só os campos que a equipe NÃO editou desde a última importação
 *    (compara o valor atual com o retrato `imported`); os demais viram conflito no relatório.
 *  - Arquivos: cada sha256 entra uma vez; mesmo caminho com conteúdo novo vira nova versão do documento.
 *  - Nada é publicado: publicação continua exigindo autorização de divulgação + aprovação de administrador.
 */
import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { buildSlug, nextCode } from '../domain/opportunities.js';
import { saveGeometry } from '../geo/geo.js';
import { createProspect } from '../routes/prospects.js';
import { newKey, processImage, storage } from '../lib/storage.js';
import type { Plan, UnitPlan } from './plan.js';
import type { InventorySource } from './sources.js';

const MIME: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', kml: 'application/vnd.google-earth.kml+xml', kmz: 'application/vnd.google-earth.kmz',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', dwg: 'image/vnd.dwg', xls: 'application/vnd.ms-excel', tif: 'image/tiff',
};
const extOf = (p: string) => p.split('.').pop()!.toLowerCase();
const fileName = (p: string) => p.split('/').pop()!;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const day = (mtime: number) => new Date(mtime * 1000).toISOString().slice(0, 10);

function cleanPolygon(p: any) {
  const ring = (r: any[]) => {
    const c = r.map((x: number[]) => [Number(x[0]), Number(x[1])]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (c.length && (c[0][0] !== c[c.length - 1][0] || c[0][1] !== c[c.length - 1][1])) c.push([...c[0]]);
    return c.length >= 4 ? c : null;
  };
  if (p.type === 'Polygon') { const rs = p.coordinates.map(ring).filter(Boolean); return rs.length ? { type: 'Polygon', coordinates: rs } : null; }
  if (p.type === 'MultiPolygon') { const ps = p.coordinates.map((poly: any[]) => poly.map(ring).filter(Boolean)).filter((x: any[]) => x.length); return ps.length ? { type: 'MultiPolygon', coordinates: ps } : null; }
  return null;
}

/** Mede os perímetros no PostGIS (área geodésica e ponto interno) e cruza com a metragem declarada. */
export async function measure(plan: Plan, knex: Knex) {
  for (const u of plan.units) {
    const g = u.geometry;
    // KMZ de urbanismo traz centenas de lotes: descarta anéis degenerados e a cota Z antes de unir
    g.polygons = g.polygons.map(cleanPolygon).filter(Boolean);
    if (g.polygons.length) {
      // união robusta: valida cada polígono, encaixa numa grade de ~1 mm e une; o contorno resultante substitui os lotes
      const sql = (snap: boolean) => `WITH p AS (SELECT ST_MakeValid(ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON(x)), 4326)) AS g FROM unnest(?::text[]) x),
           u AS (SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Union(${snap ? 'ST_SnapToGrid(g, 0.00000001)' : 'g'})), 3)) AS geom FROM p)
           SELECT ST_Area(geom::geography) AS a, ST_X(ST_PointOnSurface(geom)) AS x, ST_Y(ST_PointOnSurface(geom)) AS y, ST_AsGeoJSON(geom, 8) AS gj FROM u`;
      const params = [g.polygons.map((p) => JSON.stringify(p))];
      try {
        let rows: any[];
        try { rows = (await knex.raw(sql(false), params)).rows; } catch { rows = (await knex.raw(sql(true), params)).rows; }
        if (!rows[0]?.gj) throw new Error('perímetro vazio');
        g.area_m2 = Number(rows[0].a); g.centroid = [Number(rows[0].x), Number(rows[0].y)];
        g.polygons = [JSON.parse(rows[0].gj)];
      } catch (e: any) {
        g.polygons = [];
        u.issues.push({ level: 'revisar', code: 'geo_invalido', message: `Perímetro inválido no PostGIS: ${String(e.message).split(' - ').pop()}` });
      }
    } else if (g.points.length) {
      g.centroid = [g.points.reduce((s, p) => s + p[0], 0) / g.points.length, g.points.reduce((s, p) => s + p[1], 0) / g.points.length];
    }
    if (g.centroid && (g.centroid[1] > 6 || g.centroid[1] < -34 || g.centroid[0] < -74 || g.centroid[0] > -34)) {
      u.issues.push({ level: 'bloqueia', code: 'fora_do_brasil', message: 'Coordenadas do KML fora do Brasil (verifique o arquivo)' });
      u.destination = 'prospect';
    }
    const declared = u.area?.value;
    if (g.area_m2 && declared && Math.abs(g.area_m2 - declared) / declared > 0.25) {
      u.issues.push({ level: 'revisar', code: 'area_divergente', message: `Perímetro mede ${Math.round(g.area_m2).toLocaleString('pt-BR')} m²; texto declara ${Math.round(declared).toLocaleString('pt-BR')} m²` });
    }
    if (g.area_m2 && g.area_m2 > 5e9) { u.issues.push({ level: 'bloqueia', code: 'area_absurda', message: 'Perímetro acima de 500.000 ha' }); u.destination = 'prospect'; }
  }
}

/** Valores que a importação controla, já no formato das colunas. */
function fieldsOf(u: UnitPlan) {
  const ex = u.extracted;
  const sheet = u.sheets.find((s) => s.kind === 'captacoes')?.data;
  const sheetPrice = sheet ? Number(sheet['Valor / VGV Estimado']) || null : null;
  return {
    opp: {
      internal_name: u.name, type: u.type.value, uf: u.uf?.value ?? null, city: u.city?.value ?? null,
      lat: u.geometry.centroid?.[1] ?? null, lng: u.geometry.centroid?.[0] ?? null,
      area_m2: u.geometry.area_m2 ? Math.round(u.geometry.area_m2) : (u.area ? Math.round(u.area.value) : (sheet && Number(sheet['Área (m²)'])) || null),
    },
    terms: {
      modalities: ex?.modalities?.value ?? [],
      asking_price: ex?.asking_price?.value ?? null,
      vgv_preliminary: ex?.vgv?.value ?? (sheetPrice && sheetPrice > (ex?.asking_price?.value ?? 0) * 3 ? sheetPrice : null),
      expected_units: ex?.lots?.value ?? ex?.units?.value ?? null,
      down_payment: ex?.down_payment?.value ?? null,
    },
  };
}

function originNotes(u: UnitPlan) {
  const ex = u.extracted;
  const lines = [`Origem: inventário Dourado Imob, pasta "${u.key}".`];
  if (u.group) lines.push(`Pasta agrupadora: ${u.group} (verificar parceiro indicador).`);
  const add = (label: string, e: any) => e && lines.push(`${label}: ${typeof e.value === 'number' ? e.value.toLocaleString('pt-BR') : e.value} — "${e.snippet ?? ''}" (${e.source})`);
  add('Área declarada (m²)', u.area); add('Valor pedido', ex?.asking_price); add('VGV declarado', ex?.vgv); add('Valor por lote', ex?.price_per_lot);
  add('Valor por m²', ex?.price_per_m2); add('Aporte/entrada', ex?.down_payment); add('Lotes', ex?.lots); add('Unidades', ex?.units); add('Lote padrão (m²)', ex?.lot_size_m2);
  if (ex?.matriculas.length) lines.push(`Matrículas citadas: ${[...new Set(ex.matriculas.map((m) => m.value))].join(', ')}`);
  for (const s of u.sheets) lines.push(`Planilha ${fileName(s.file)} / ${s.sheet}, linha ${s.row}: ${Object.entries(s.data).filter(([k, v]) => v != null && String(v).trim() && !k.startsWith('__')).map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, ' ').trim()}`).join(' | ')}`);
  if (u.description_text.trim()) lines.push('', `Texto de origem (${u.description_files.map(fileName).join(', ')}):`, u.description_text.trim().slice(0, 6000));
  return lines.join('\n');
}

export type ApplyResult = { key: string; name: string; action: 'created' | 'updated' | 'unchanged' | 'skipped'; entity_type?: string; entity_id?: string; code?: string;
  conflicts: string[]; files_added: number; files_skipped: { path: string; reason: string }[]; error?: string };

export async function applyPlan(knex: Knex, plan: Plan, src: InventorySource, o: { orgId: string; userId: string | null; source: string; mode: 'preview' | 'apply' }) {
  const [run] = await knex('import_runs').insert({ org_id: o.orgId, source: o.source, origin_label: plan.source, mode: o.mode, created_by: o.userId }).returning('*');
  const results: ApplyResult[] = [];
  const responsible = o.userId ? (await knex('users').where({ id: o.userId }).first())?.name ?? 'Importação' : 'Importação';

  for (const u of plan.units) {
    const r: ApplyResult = { key: u.key, name: u.name, action: 'unchanged', conflicts: [], files_added: 0, files_skipped: [] };
    results.push(r);
    try {
      await knex.transaction(async (trx) => {
        const item = await trx('import_items').where({ org_id: o.orgId, source: o.source, external_key: u.key }).first();
        const sheetHash = sha(JSON.stringify(u.sheets.map((s) => s.data)));
        const f = fieldsOf(u);
        let entityType = item?.entity_type as string | undefined;
        let entityId = item?.entity_id as string | undefined;

        // prospecção já convertida em área: a sincronização passa a seguir a área
        if (item?.entity_type === 'prospect') {
          const p = await trx('land_prospects').where({ id: item.entity_id }).first();
          if (p?.opportunity_id) { entityType = 'opportunity'; entityId = p.opportunity_id; await trx('import_items').where({ id: item.id }).update({ entity_type: 'opportunity', entity_id: p.opportunity_id }); }
        }

        if (!item) {
          r.action = 'created';
          if (u.destination === 'opportunity') {
            const code = await nextCode(trx, o.orgId, f.opp.uf!);
            const [opp] = await trx('land_opportunities').insert({
              org_id: o.orgId, code, slug: buildSlug({ code, type: f.opp.type, city: f.opp.city }), ...f.opp,
              status: 'captacao', publication_status: 'draft', visibility: 'private', internal_owner_id: o.userId, created_by: o.userId, draft_step: 1,
            }).returning('*');
            entityType = 'opportunity'; entityId = opp.id; r.code = code;
            await trx('land_commercial_terms').insert({ opportunity_id: opp.id, ...f.terms, negotiable: true, exclusivity: false, internal_notes: originNotes(u) });
            await trx('publication_permissions').insert({ opportunity_id: opp.id, show_price: false, show_price_per_m2: false, location_precision: 'approximate' });
            if (u.geometry.polygons.length && u.geometry.area_m2) await saveGeometry(trx, opp.id, { type: 'GeometryCollection', geometries: u.geometry.polygons }, extOf(u.geometry.files[0] ?? 'x.kml'), o.userId);
            const tech: [string, any, string | undefined][] = [];
            if (u.extracted?.approval || u.folder.tags.includes('aprovado')) tech.push(['estagio_aprovacao', u.extracted?.approval?.value ?? 'aprovado', u.extracted?.approval ? u.extracted.approval.source : 'nome da pasta']);
            if (u.extracted?.viability?.value.length) tech.push(['viabilidade', u.extracted.viability.value, u.extracted.viability.source]);
            if (u.extracted?.lots) tech.push(['projetos', `${u.extracted.lots.value} lotes${u.extracted.lot_size_m2 ? ` de ${u.extracted.lot_size_m2.value} m²` : ''} (declarado)`, u.extracted.lots.source]);
            const mt = Math.max(...u.files.filter((x) => x.kind === 'description').map((x) => x.mtime), 0) || Math.floor(Date.now() / 1000);
            for (const [key, value, s] of tech) {
              await trx('land_technical_attributes').insert({ opportunity_id: opp.id, key, value: JSON.stringify(value), source: `Inventário Drive — ${s ?? u.key}`, consulted_at: day(mt), responsible, validation_status: 'declarado' });
            }
          } else {
            const p = await createProspect(trx, o.orgId, o.userId, {
              title: u.extracted?.title && u.extracted.title.length < 90 ? `${u.name} — ${u.extracted.title}` : u.name,
              source: 'inventario', uf: f.opp.uf, city: f.opp.city, lat: f.opp.lat, lng: f.opp.lng, land_type: f.opp.type,
              intended_uses: u.extracted?.viability?.value ?? [], notes: originNotes(u),
              geojson: u.geometry.polygons.length && u.geometry.area_m2 ? { type: 'GeometryCollection', geometries: u.geometry.polygons } : null,
            });
            const upd: any = { asking_price_hint: f.terms.asking_price, matricula: u.extracted?.matriculas[0]?.value ?? null };
            if (!u.geometry.area_m2 && f.opp.area_m2) upd.area_m2 = f.opp.area_m2;
            await trx('land_prospects').where({ id: p.id }).update(upd);
            entityType = 'prospect'; entityId = p.id; r.code = p.code;
          }
          for (const s of u.sheets) {
            await trx('activities').insert({ org_id: o.orgId, ...(entityType === 'opportunity' ? { opportunity_id: entityId } : { prospect_id: entityId }), type: 'note',
              subject: `Planilha ${fileName(s.file)} (${s.sheet}, linha ${s.row})`, body: Object.entries(s.data).filter(([k, v]) => v != null && !k.startsWith('__')).map(([k, v]) => `${k}: ${v}`).join('\n'), user_id: o.userId });
          }
          const [it] = await trx('import_items').insert({ org_id: o.orgId, source: o.source, external_key: u.key, entity_type: entityType, entity_id: entityId,
            content_hash: u.content_hash, sheet_hash: sheetHash, imported: JSON.stringify(f), issues: JSON.stringify(u.issues), last_run_id: run.id }).returning('*');
          await attachFiles(trx, it.id, u, src, { orgId: o.orgId, userId: o.userId, entityType: entityType!, entityId: entityId! }, r);
          return;
        }

        r.entity_type = entityType; r.entity_id = entityId;
        if (item.content_hash === u.content_hash && item.sheet_hash === sheetHash) {
          await trx('import_items').where({ id: item.id }).update({ last_run_id: run.id, status: 'active', updated_at: trx.fn.now() });
          return;
        }
        r.action = 'updated';
        const prev = item.imported ?? { opp: {}, terms: {} };
        if (entityType === 'opportunity') {
          const cur = await trx('land_opportunities').where({ id: entityId }).first();
          const terms = await trx('land_commercial_terms').where({ opportunity_id: entityId }).first();
          const oppUpd: any = {}; const termsUpd: any = {};
          const same = (a: any, b: any) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || (a != null && b != null && Number(a) === Number(b));
          for (const [k, v] of Object.entries(f.opp)) {
            if (same(cur[k], v)) continue;
            if (same(cur[k], prev.opp?.[k])) oppUpd[k] = v; else r.conflicts.push(`${k}: plataforma "${cur[k]}" ≠ inventário "${v}" (editado pela equipe, mantido)`);
          }
          for (const [k, v] of Object.entries(f.terms)) {
            if (same(terms?.[k], v)) continue;
            if (same(terms?.[k], prev.terms?.[k])) termsUpd[k] = v; else r.conflicts.push(`${k}: plataforma "${terms?.[k]}" ≠ inventário "${v}" (editado pela equipe, mantido)`);
          }
          if (Object.keys(oppUpd).length) await trx('land_opportunities').where({ id: entityId }).update({ ...oppUpd, version: trx.raw('version + 1'), updated_at: trx.fn.now() });
          if (Object.keys(termsUpd).length) await trx('land_commercial_terms').where({ opportunity_id: entityId }).update({ ...termsUpd, updated_at: trx.fn.now() });
          // perímetro novo no KML: nova versão, se a geometria atual ainda for a da importação
          const geoChanged = u.files.some((x) => x.kind === 'geo') && !(await trx('import_files').where({ item_id: item.id, category: 'geo' }).whereIn('sha256', u.files.filter((x) => x.kind === 'geo').map((x) => x.sha256)).first());
          if (geoChanged && u.geometry.polygons.length && u.geometry.area_m2) {
            const g = await trx('land_geometries').where({ opportunity_id: entityId, is_current: true }).first();
            if (!g || g.source !== 'draw') await saveGeometry(trx, entityId!, { type: 'GeometryCollection', geometries: u.geometry.polygons }, extOf(u.geometry.files[0]), o.userId);
            else r.conflicts.push('perímetro: redesenhado na plataforma, KML novo não aplicado');
          }
          await trx('activities').insert({ org_id: o.orgId, opportunity_id: entityId, type: 'system', subject: 'Inventário atualizado no Drive',
            body: [Object.keys({ ...oppUpd, ...termsUpd }).length ? `Campos atualizados: ${Object.keys({ ...oppUpd, ...termsUpd }).join(', ')}` : 'Sem mudança de campos', ...r.conflicts].join('\n'), user_id: o.userId });
        } else {
          await trx('activities').insert({ org_id: o.orgId, prospect_id: entityId, type: 'system', subject: 'Inventário atualizado no Drive', body: 'Arquivos novos ou alterados na pasta de origem', user_id: o.userId });
        }
        await trx('import_items').where({ id: item.id }).update({ content_hash: u.content_hash, sheet_hash: sheetHash, imported: JSON.stringify(f), issues: JSON.stringify(u.issues), last_run_id: run.id, status: 'active', updated_at: trx.fn.now() });
        await attachFiles(trx, item.id, u, src, { orgId: o.orgId, userId: o.userId, entityType: entityType!, entityId: entityId! }, r);
      });
    } catch (e: any) {
      r.action = 'skipped'; r.error = e.message;
    }
    if (!r.entity_id) {
      const it = await knex('import_items').where({ org_id: o.orgId, source: o.source, external_key: u.key }).first();
      r.entity_type = it?.entity_type; r.entity_id = it?.entity_id;
    }
    if (!r.code && r.entity_id) r.code = (await knex(r.entity_type === 'opportunity' ? 'land_opportunities' : 'land_prospects').where({ id: r.entity_id }).first())?.code;
  }

  // pastas que sumiram da origem: só marcamos, nunca apagamos
  const keys = plan.units.map((u) => u.key);
  const missing = await knex('import_items').where({ org_id: o.orgId, source: o.source }).whereNotIn('external_key', keys).update({ status: 'missing', updated_at: knex.fn.now() }).returning('external_key');
  const summary = {
    created: results.filter((r) => r.action === 'created').length, updated: results.filter((r) => r.action === 'updated').length,
    unchanged: results.filter((r) => r.action === 'unchanged').length, skipped: results.filter((r) => r.action === 'skipped').length,
    files_added: results.reduce((s, r) => s + r.files_added, 0), conflicts: results.reduce((s, r) => s + r.conflicts.length, 0), missing: missing.map((m: any) => m.external_key ?? m),
  };
  await knex('import_runs').where({ id: run.id }).update({ summary: JSON.stringify(summary), finished_at: knex.fn.now() });
  return { run_id: run.id, summary, results };
}

/** Documentos, imagens e arquivos geográficos. Prospecção não tem documentos próprios: ficam "pendentes" e entram na conversão. */
async function attachFiles(trx: Knex, itemId: string, u: UnitPlan, src: InventorySource, ctx: { orgId: string; userId: string | null; entityType: string; entityId: string }, r: ApplyResult) {
  const done = await trx('import_files').where({ item_id: itemId });
  const has = new Set(done.map((d: any) => `${d.path}\0${d.sha256}`));
  for (const f of u.files) {
    if (has.has(`${f.path}\0${f.sha256}`)) continue;
    const base = { item_id: itemId, path: f.path, sha256: f.sha256, size: f.size };
    if (f.kind === 'geo' && !src.complete) {
      // prévia sem os bytes: registra que o perímetro deste arquivo já foi aplicado
      await trx('import_files').insert({ ...base, target: 'geometry', category: 'geo', note: u.geometry.polygons.length ? 'perímetro' : 'ponto/linha' });
      continue;
    }
    if (f.kind === 'video' || f.kind === 'archive' || f.kind === 'other' || f.kind === 'description') {
      if (f.kind !== 'description') { await trx('import_files').insert({ ...base, target: 'skipped', note: f.kind === 'video' ? 'vídeo: enviar para a galeria manualmente' : 'arquivo compactado/outro: revisar' }); r.files_skipped.push({ path: f.path, reason: f.kind }); }
      if (f.kind !== 'description') continue;
    }
    if (!src.complete) { r.files_skipped.push({ path: f.path, reason: 'origem sem o arquivo (prévia)' }); continue; }
    const buf = await src.read(f.path);
    if (!buf) { r.files_skipped.push({ path: f.path, reason: 'não encontrado' }); continue; }
    const ext = extOf(f.path);
    if (f.kind === 'image') {
      if (ctx.entityType !== 'opportunity') { await trx('import_files').insert({ ...base, target: 'skipped', note: 'imagem de prospecção: anexar após conversão' }); continue; }
      try {
        const img = await processImage(buf);
        const key = newKey('media', 'webp');
        await storage.put(key, img.data);
        const sort = Number((await trx('land_media').where({ opportunity_id: ctx.entityId }).count({ c: '*' }).first())?.c ?? 0);
        const [m] = await trx('land_media').insert({ opportunity_id: ctx.entityId, storage_key: key, caption: null, sort, is_cover: sort === 0, width: img.width, height: img.height }).returning('*');
        await trx('import_files').insert({ ...base, target: 'media', target_id: m.id, storage_key: key, mime: 'image/webp' });
        r.files_added++;
      } catch (e: any) { await trx('import_files').insert({ ...base, target: 'skipped', note: `imagem: ${e.message}` }); r.files_skipped.push({ path: f.path, reason: 'imagem inválida' }); }
      continue;
    }
    const key = newKey('docs', ext);
    await storage.put(key, buf);
    const category = f.category ?? 'outro';
    const mime = MIME[ext] ?? 'application/octet-stream';
    if (ctx.entityType !== 'opportunity') {
      await trx('import_files').insert({ ...base, target: 'pending', category, storage_key: key, mime });
      r.files_added++; continue;
    }
    // mesmo caminho com conteúdo novo → nova versão do mesmo documento
    const prevSame = done.find((d: any) => d.path === f.path && d.target === 'document');
    const prevDoc = prevSame ? await trx('land_documents').where({ id: prevSame.target_id }).first() : null;
    if (prevDoc) await trx('land_documents').where({ group_id: prevDoc.group_id }).update({ is_current: false });
    const [doc] = await trx('land_documents').insert({
      opportunity_id: ctx.entityId, group_id: prevDoc?.group_id ?? crypto.randomUUID(), version: (prevDoc?.version ?? 0) + 1, is_current: true,
      category, title: fileName(f.path).replace(/\.[^.]+$/, ''), confidentiality: 'confidential', storage_key: key, mime, original_name: fileName(f.path),
      size: f.size, sha256: f.sha256, uploaded_by: ctx.userId,
    }).returning('*');
    await trx('import_files').insert({ ...base, target: 'document', target_id: doc.id, category, storage_key: key, mime });
    r.files_added++;
  }
}

/** Chamado na conversão de prospecção → área: anexa os documentos que vieram do inventário. */
export async function attachPendingImportFiles(trx: Knex, prospectId: string, opportunityId: string, userId: string | null) {
  const item = await trx('import_items').where({ entity_type: 'prospect', entity_id: prospectId }).first();
  if (!item) return 0;
  const pend = await trx('import_files').where({ item_id: item.id, target: 'pending' });
  for (const p of pend) {
    const [doc] = await trx('land_documents').insert({
      opportunity_id: opportunityId, group_id: crypto.randomUUID(), version: 1, is_current: true, category: p.category ?? 'outro',
      title: fileName(p.path).replace(/\.[^.]+$/, ''), confidentiality: 'confidential', storage_key: p.storage_key, mime: p.mime, original_name: fileName(p.path),
      size: Number(p.size), sha256: p.sha256, uploaded_by: userId,
    }).returning('*');
    await trx('import_files').where({ id: p.id }).update({ target: 'document', target_id: doc.id });
  }
  await trx('import_items').where({ id: item.id }).update({ entity_type: 'opportunity', entity_id: opportunityId, updated_at: trx.fn.now() });
  return pend.length;
}
