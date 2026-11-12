/**
 * Dados territoriais para captação e diligência.
 *
 * Fontes:
 *  - SIGEF/INCRA (imóveis rurais certificados) e SICAR/CAR (Cadastro Ambiental Rural): serviços OGC WFS públicos.
 *    URL e nome da camada são configuráveis (TERRITORY_SIGEF_WFS_URL / _LAYER, TERRITORY_CAR_WFS_URL / _LAYER);
 *    o nome da camada aceita {uf} e {uf_lower}.
 *  - Mapa do Registro de Imóveis (ONR): não há API pública documentada. A consulta registral (matrículas, serventia, certificação)
 *    usa um provedor contratado que consulta o Mapa (ONR_PROVIDER_URL + ONR_PROVIDER_TOKEN). Sem contrato, oferecemos o link
 *    para o Mapa ONR e a parcela/CAR identificados para consulta manual.
 *  - Modo demonstração (TERRITORY_MODE=demo, padrão fora de produção): parcelas FICTÍCIAS geradas de forma determinística.
 *
 * Todo retorno identifica fonte e data de consulta; nada é apresentado como dado oficial sem origem.
 */
import {
  DEDUCTING_LAYERS, ENVIRONMENT_LAYERS, PARCEL_LAYERS, RESTRICTION_LAYERS, TERRITORY_LAYERS, TERRITORY_LAYER_KEYS, demoTerritoryFeatures, earthUrl, pointInGeometry,
  type TerritoryLayer, type TerritoryProps,
} from '@dl/shared';
import { db } from '../db/knex.js';

const env = process.env;
export const territoryMode = () => (env.TERRITORY_MODE ?? (env.NODE_ENV === 'production' ? 'live' : 'demo')) as 'demo' | 'live';
type Layer = 'sigef' | 'car';

const SOURCES: Record<Layer, { name: string; url?: string; layer?: string; official: string }> = {
  sigef: { name: 'Imóveis certificados (SIGEF/INCRA)', url: env.TERRITORY_SIGEF_WFS_URL, layer: env.TERRITORY_SIGEF_LAYER, official: 'https://sigef.incra.gov.br/' },
  car: { name: 'Cadastro Ambiental Rural (SICAR)', url: env.TERRITORY_CAR_WFS_URL, layer: env.TERRITORY_CAR_LAYER, official: 'https://consultapublica.car.gov.br/publico/imoveis/index' },
};

/** Bases oficiais já carregadas no PostGIS, por camada. */
export async function loadedDatasets() {
  const rows = await db('territory_datasets').select('*').orderBy(['layer', 'uf']);
  const out: Record<string, { ufs: string[]; features: number; loaded_at: string; sources: string[] }> = {};
  for (const r of rows) {
    const d = (out[r.layer] ??= { ufs: [], features: 0, loaded_at: r.loaded_at, sources: [] });
    d.ufs.push(r.uf); d.features += r.features;
    if (new Date(r.loaded_at) < new Date(d.loaded_at)) d.loaded_at = r.loaded_at;
    if (!d.sources.includes(r.source_name)) d.sources.push(r.source_name);
  }
  return out;
}

export function layerStatus(loaded: Awaited<ReturnType<typeof loadedDatasets>> = {}) {
  const mode = territoryMode();
  return {
    mode,
    layers: TERRITORY_LAYER_KEYS.map((k) => {
      const meta = TERRITORY_LAYERS[k];
      const wfs = SOURCES[k as Layer];
      const data = loaded[k];
      return {
        key: k, name: meta.label, short: meta.short, group: meta.group, color: meta.color, official_url: meta.official, source: meta.source,
        // demonstração só existe para as duas camadas com gerador fictício
        status: mode === 'demo' ? (k === 'sigef' || k === 'car' ? 'simulated' : 'pending') : data || (wfs?.url && wfs?.layer) ? 'implemented' : 'pending',
        ufs: data?.ufs ?? [], features: data?.features ?? 0, loaded_at: data?.loaded_at ?? null, loaded_sources: data?.sources ?? [],
      };
    }),
    registry: {
      key: 'onr', name: 'Mapa do Registro de Imóveis (ONR)', official_url: 'https://mapa.onr.org.br/',
      status: mode === 'demo' ? 'simulated' : env.ONR_PROVIDER_URL && env.ONR_PROVIDER_TOKEN ? 'implemented' : 'pending',
    },
  };
}

/** Normaliza atributos de bases diferentes para o mesmo formato (mantém os originais em `raw`). */
export function normalize(layer: string, p: Record<string, any>): TerritoryProps & { raw: any } {
  const pick = (...keys: string[]) => { for (const k of keys) { const v = p[k] ?? p[k.toUpperCase()]; if (v !== undefined && v !== null && v !== '') return v; } return null; };
  const area = pick('area_ha', 'num_area', 'area', 'area_imovel', 'nu_area', 'qtd_area_p', 'area_hecta', 'areaha', 'areahaalb', 'superficie');
  return {
    layer,
    codigo: String(pick('parcela_codigo', 'parcela_co', 'num_certif', 'cod_imovel', 'codigo_imo', 'codigo', 'cod_tema', 'terrai_cod', 'cnuc', 'id') ?? ''),
    nome: pick('nome_area', 'nome_imovel', 'nome_imove', 'nome_proje', 'nome', 'nom_tema', 'nm_uc', 'nomeuc', 'terrai_nom'),
    area_ha: area != null ? Number(area) : null,
    municipio: pick('municipio_', 'municipio', 'nom_munici', 'municipio_nome'),
    uf: pick('uf', 'uf_id', 'cod_estado', 'estado'),
    situacao: pick('situacao_i', 'situacao', 'des_condic', 'condicao', 'fase_ti', 'categoria_', 'ind_status', 'status_imovel', 'status'),
    matricula: pick('registro_m', 'matricula', 'matriculas'),
    cns_serventia: pick('registro_d', 'cns', 'cns_serventia'),
    data_referencia: pick('data_aprov', 'data_submi', 'dat_criaca', 'dat_criacao', 'data_certificado', 'data_referencia'),
    fonte: `${SOURCES[layer as Layer]?.name ?? TERRITORY_LAYERS[layer as TerritoryLayer]?.label ?? layer} — WFS`,
    raw: p,
  };
}

const bboxKey = (layer: string, uf: string | null, b: number[]) => `${layer}:${uf ?? '-'}:${b.map((v) => v.toFixed(3)).join(',')}`;

async function fetchWfs(layer: Layer, uf: string | null, bbox: [number, number, number, number]) {
  const src = SOURCES[layer];
  if (!src.url || !src.layer) return { status: 'pending' as const, features: [] };
  if (src.layer.includes('{uf') && !uf) throw Object.assign(new Error('Informe a UF para consultar esta camada'), { status: 400 });
  const key = bboxKey(layer, uf, bbox);
  const cached = await db('territory_cache').where({ key }).andWhere('fetched_at', '>', db.raw(`now() - interval '24 hours'`)).first();
  if (cached) return { status: 'implemented' as const, features: cached.data, cached: true };
  const typeName = src.layer.replace('{uf}', uf ?? '').replace('{uf_lower}', (uf ?? '').toLowerCase());
  const [minX, minY, maxX, maxY] = bbox;
  const u = new URL(src.url);
  Object.entries({
    service: 'WFS', version: '1.1.0', request: 'GetFeature', typeName, outputFormat: 'application/json', srsName: 'EPSG:4326',
    bbox: `${minX},${minY},${maxX},${maxY},EPSG:4326`, maxFeatures: '400',
  }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw Object.assign(new Error(`${src.name} respondeu ${r.status}`), { status: 502 });
  const gj: any = await r.json();
  const features = (gj.features ?? []).map((f: any) => ({ type: 'Feature', id: f.id, geometry: f.geometry, properties: normalize(layer, f.properties ?? {}) }));
  await db('territory_cache').insert({ key, layer, data: JSON.stringify(features) }).onConflict('key').merge({ data: JSON.stringify(features), fetched_at: db.fn.now() });
  return { status: 'implemented' as const, features };
}

// A fonte mostrada é a da carga (ex.: "cópia publicada pelo IBAMA"), não a fonte padrão da camada: quem consulta precisa saber de onde veio.
const toFeature = (r: any, loadedAt?: string, sourceName?: string) => ({
  type: 'Feature', id: Number(r.id), geometry: r.geometry,
  properties: {
    id: Number(r.id), layer: r.layer, codigo: r.code ?? '', nome: r.name, area_ha: r.area_ha, municipio: r.municipio, uf: r.uf, situacao: r.situacao,
    matricula: r.matricula, cns_serventia: r.cns_serventia, data_referencia: r.data_referencia,
    fonte: `${sourceName ?? TERRITORY_LAYERS[r.layer as TerritoryLayer]?.source ?? r.layer}${loadedAt ? ` — carregada na plataforma em ${new Date(loadedAt).toLocaleDateString('pt-BR')}` : ''}`,
  },
});
const FEATURE_COLS = 'id, layer, uf, code, name, area_ha, municipio, situacao, matricula, cns_serventia, data_referencia';

/** Consulta na base local (PostGIS). Retorna null se a camada ainda não foi carregada. */
async function localFeatures(layer: string, bbox: [number, number, number, number]) {
  const ds = await db('territory_datasets').where({ layer }).select('loaded_at', 'source_name').first();
  if (!ds) return null;
  const { rows } = await db.raw(
    `SELECT ${FEATURE_COLS}, ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.00001), 6)::json AS geometry
     FROM territory_features WHERE layer = ? AND geom && ST_MakeEnvelope(?, ?, ?, ?, 4326) LIMIT 1500`,
    [layer, ...bbox],
  );
  return rows.map((r: any) => toFeature(r, ds.loaded_at, ds.source_name));
}

export async function getFeatures(layer: string, bbox: [number, number, number, number], uf: string | null) {
  const consulted_at = new Date().toISOString();
  const [minX, minY, maxX, maxY] = bbox;
  if (territoryMode() === 'demo') {
    if (layer !== 'sigef' && layer !== 'car') return { mode: 'demo', status: 'pending', too_large: false, consulted_at, features: [] as any[] };
    const d = demoTerritoryFeatures(layer, bbox);
    return { mode: 'demo', status: 'simulated', too_large: d.tooLarge, consulted_at, features: d.features };
  }
  if (maxX - minX > 0.3 || maxY - minY > 0.3) return { mode: 'live', status: 'implemented', too_large: true, consulted_at, features: [] as any[] };
  const local = await localFeatures(layer, bbox);
  if (local) return { mode: 'live', status: 'implemented', too_large: false, consulted_at, features: local };
  if (layer !== 'sigef' && layer !== 'car') return { mode: 'live', status: 'pending', too_large: false, consulted_at, features: [] as any[] };
  const r = await fetchWfs(layer, uf, bbox);
  return { mode: 'live', status: r.status, too_large: false, consulted_at, features: r.features };
}

/** Consulta registral no Mapa do Registro de Imóveis (ONR) por meio do provedor contratado. */
async function registryLookup(car: string | null, parcel: TerritoryProps | null) {
  if (territoryMode() === 'demo') {
    if (!parcel) return null;
    return {
      source: 'Demonstração — consulta registral fictícia', consulted_at: new Date().toISOString(), ficticio: true,
      matriculas: parcel.matricula ? [parcel.matricula] : [], cns_serventia: parcel.cns_serventia, cartorio: parcel.cns_serventia ? `Registro de Imóveis fictício (CNS ${parcel.cns_serventia})` : null,
      numero_certificado: parcel.layer === 'sigef' ? parcel.codigo : null, situacao: parcel.situacao,
    };
  }
  if (!env.ONR_PROVIDER_URL || !env.ONR_PROVIDER_TOKEN || !car) return null;
  const body = new URLSearchParams({ token: env.ONR_PROVIDER_TOKEN, car, timeout: '300' });
  const r = await fetch(env.ONR_PROVIDER_URL, { method: 'POST', body, signal: AbortSignal.timeout(60000) });
  if (!r.ok) return { source: 'Mapa do Registro de Imóveis (ONR) via provedor', error: `Provedor respondeu ${r.status}` };
  const j: any = await r.json();
  const d = Array.isArray(j.data) ? j.data[0] : j.data;
  if (!d) return { source: 'Mapa do Registro de Imóveis (ONR) via provedor', consulted_at: new Date().toISOString(), not_found: true };
  return {
    source: 'Mapa do Registro de Imóveis (ONR) via provedor', consulted_at: new Date().toISOString(),
    matriculas: d.matriculas ?? [], cns_serventia: d.cns_serventia ?? null, cartorio: null,
    numero_certificado: d.numero_certificado ?? null, situacao: d.descricao_condicao ?? d.ind_status ?? null,
    area_hectares: d.area_hectares ?? null, municipio: d.municipio ?? null, nome_imovel: d.nome_imovel ?? null,
  };
}

/** Tudo o que se sabe sobre um ponto: parcelas que o contêm em cada camada, consulta registral e links externos. */
export async function lookupPoint(lat: number, lng: number, uf: string | null) {
  const d = 0.004;
  const bbox: [number, number, number, number] = [lng - d, lat - d, lng + d, lat + d];
  const out: any = { lat, lng, parcels: [] as any[], registry: null, links: {} };
  for (const layer of PARCEL_LAYERS) {
    try {
      const r = await getFeatures(layer, bbox, uf);
      for (const f of r.features) if (pointInGeometry([lng, lat], f.geometry)) out.parcels.push({ ...f, consulted_at: r.consulted_at });
    } catch (e: any) {
      out.parcels.push({ error: e.message, layer });
    }
  }
  const sigef = out.parcels.find((p: any) => p.properties?.layer === 'sigef' || p.properties?.layer === 'snci')?.properties ?? null;
  const car = out.parcels.find((p: any) => p.properties?.layer === 'car')?.properties ?? null;
  out.registry = await registryLookup(car?.codigo ?? null, sigef ?? car).catch((e) => ({ error: e.message }));
  out.links = {
    onr: 'https://mapa.onr.org.br/',
    earth: earthUrl(lat, lng),
    sigef: SOURCES.sigef.official,
    car: SOURCES.car.official,
  };
  return out;
}

/** Sobreposição do perímetro de uma área (ou prospecção) com parcelas SIGEF e CAR — cálculo no PostGIS (geography). */
export async function overlapFor(geomSql: { table: string; id: string }, uf: string | null) {
  const g = await db(geomSql.table).where(geomSql.table === 'land_geometries' ? { opportunity_id: geomSql.id, is_current: true } : { id: geomSql.id })
    .select(db.raw('ST_XMin(geom) as x0, ST_YMin(geom) as y0, ST_XMax(geom) as x1, ST_YMax(geom) as y1, ST_Area(geom::geography) as area')).first();
  if (!g || g.x0 == null) return { items: [], message: 'Sem perímetro cadastrado' };
  const pad = 0.002;
  const bbox: [number, number, number, number] = [g.x0 - pad, g.y0 - pad, g.x1 + pad, g.y1 + pad];
  const items: any[] = [];
  let mode = territoryMode();
  for (const layer of PARCEL_LAYERS) {
    const r = await getFeatures(layer, bbox, uf);
    mode = r.mode as any;
    if (!r.features.length) continue;
    const { rows } = await db.raw(
      `WITH a AS (SELECT geom FROM ${geomSql.table} WHERE ${geomSql.table === 'land_geometries' ? 'opportunity_id = ? AND is_current' : 'id = ?'}),
            f AS (SELECT (x->>'i')::int AS i, ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(x->>'g'), 4326)) AS g FROM jsonb_array_elements(?::jsonb) x)
       SELECT f.i, ST_Area(ST_Intersection(a.geom, f.g)::geography) AS inter, ST_Area(f.g::geography) AS parcel_area
       FROM a, f WHERE ST_Intersects(a.geom, f.g)`,
      [geomSql.id, JSON.stringify(r.features.map((f: any, i: number) => ({ i, g: JSON.stringify(f.geometry) })))],
    );
    for (const row of rows) {
      if (row.inter < 1) continue;
      const f = r.features[row.i];
      items.push({ layer, properties: f.properties, geometry: f.geometry, intersection_m2: row.inter, pct_of_area: (row.inter / g.area) * 100, pct_of_parcel: (row.inter / row.parcel_area) * 100, consulted_at: r.consulted_at });
    }
  }
  items.sort((a, b) => b.intersection_m2 - a.intersection_m2);
  return { mode, area_m2: g.area, items };
}


// ------------------------------------------------------------------ análise ambiental e restrições

function geomSubquery(g: { table: string; id: string }) {
  if (g.table === 'land_geometries') return { sql: 'SELECT geom FROM land_geometries WHERE opportunity_id = ? AND is_current', id: g.id };
  return { sql: 'SELECT geom FROM land_prospects WHERE id = ?', id: g.id };
}

/**
 * Cruza o perímetro com as camadas ambientais e de restrição. A área aproveitável estimada desconta a UNIÃO das
 * camadas (APP, Reserva Legal, hidrografia e uso restrito se sobrepõem; somar contaria a mesma área duas vezes).
 * É uma estimativa para triagem: o CAR é declaratório e não substitui levantamento nem análise jurídica.
 */
export async function environmentFor(g: { table: string; id: string }) {
  const a = geomSubquery(g);
  const base = (await db.raw(`SELECT ST_Area(geom::geography) AS area FROM (${a.sql}) x WHERE geom IS NOT NULL`, [a.id])).rows[0];
  if (!base) return { message: 'Sem perímetro cadastrado', layers: [], restrictions: [], missing: [] as string[] };

  const loaded = await loadedDatasets();
  const stat = async (layer: string) => {
    const { rows } = await db.raw(
      `WITH a AS (${a.sql}), f AS (
         SELECT ST_Union(ST_Intersection(ST_MakeValid(t.geom), a.geom)) AS g, count(*)::int AS n, array_agg(DISTINCT t.code) FILTER (WHERE t.code IS NOT NULL) AS codes,
                array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL) AS names
         FROM territory_features t, a WHERE t.layer = ? AND t.geom && a.geom AND ST_Intersects(t.geom, a.geom))
       SELECT COALESCE(ST_Area(g::geography), 0) AS area_m2, n, codes, names FROM f`,
      [a.id, layer],
    );
    return rows[0];
  };
  const layers: any[] = [];
  for (const k of ENVIRONMENT_LAYERS) {
    if (!loaded[k]) continue;
    const r = await stat(k);
    layers.push({ layer: k, label: TERRITORY_LAYERS[k].label, color: TERRITORY_LAYERS[k].color, area_m2: r.area_m2, pct: base.area ? (r.area_m2 / base.area) * 100 : 0, deducts: DEDUCTING_LAYERS.includes(k) });
  }
  const deducting = DEDUCTING_LAYERS.filter((k) => loaded[k]);
  let deducted_m2: number | null = null;
  if (deducting.length) {
    const { rows } = await db.raw(
      `WITH a AS (${a.sql}) SELECT COALESCE(ST_Area(ST_Union(ST_Intersection(ST_MakeValid(t.geom), a.geom))::geography), 0) AS d
       FROM territory_features t, a WHERE t.layer = ANY(?) AND t.geom && a.geom AND ST_Intersects(t.geom, a.geom)`,
      [a.id, deducting],
    );
    deducted_m2 = rows[0].d;
  }
  const restrictions: any[] = [];
  for (const k of RESTRICTION_LAYERS) {
    if (!loaded[k]) continue;
    const r = await stat(k);
    if (r.n > 0) restrictions.push({ layer: k, label: TERRITORY_LAYERS[k].label, color: TERRITORY_LAYERS[k].color, area_m2: r.area_m2, pct: base.area ? (r.area_m2 / base.area) * 100 : 0, count: r.n, codes: (r.codes ?? []).slice(0, 5), names: (r.names ?? []).slice(0, 5) });
  }
  const notLoaded = [...ENVIRONMENT_LAYERS, ...RESTRICTION_LAYERS].filter((k) => !loaded[k]).map((k) => ({ layer: k, label: TERRITORY_LAYERS[k].label, official: TERRITORY_LAYERS[k].official }));
  // Área aproveitável só faz sentido com APP e Reserva Legal carregadas: sem elas o número enganaria.
  const complete = !!loaded.car_app && !!loaded.car_rl;
  return {
    area_m2: base.area, layers, restrictions, not_loaded: notLoaded,
    deducted_m2, usable_m2: complete && deducted_m2 != null ? Math.max(0, base.area - deducted_m2) : null,
    usable_requires: complete ? [] : ['car_app', 'car_rl'].filter((k) => !loaded[k]).map((k) => TERRITORY_LAYERS[k as TerritoryLayer].label),
    loaded_at: Object.values(loaded).map((d) => d.loaded_at).sort()[0] ?? null,
  };
}

// ------------------------------------------------------------------ busca por código e radar de captação

/** Código do CAR, certificação, código do imóvel/CCIR, matrícula ou nome do imóvel. */
export async function searchFeatures(q: string, uf: string | null) {
  const term = q.trim();
  if (term.length < 3) return [];
  const up = term.toLowerCase();
  const nameTerm = term.replace(/[%_\\]/g, '').trim();
  const qb = db('territory_features')
    .select(db.raw(FEATURE_COLS), db.raw('ST_AsGeoJSON(geom, 6)::json AS geometry'), db.raw('ST_XMin(geom) x0, ST_YMin(geom) y0, ST_XMax(geom) x1, ST_YMax(geom) y1'))
    .whereIn('layer', PARCEL_LAYERS)
    .where((w) => w.whereRaw('lower(code) = ?', [up]).orWhere('matricula', term).orWhereRaw("lower(raw->>'codigo_imo') = ?", [up]).orWhereRaw("lower(raw->>'num_certif') = ?", [up]).orWhere((n) => { if (nameTerm.length >= 3) n.whereILike('name', `%${nameTerm}%`); else n.whereRaw('false'); }))
    .limit(30);
  if (uf) qb.where({ uf });
  const rows = await qb;
  return rows.map((r: any) => ({ ...toFeature(r), bbox: [r.x0, r.y0, r.x1, r.y1] }));
}

export interface RadarFilter { uf: string; municipios?: string[]; min_ha?: number; max_ha?: number; layer: string; exclude_restrictions: boolean; orgId: string; limit: number }

/**
 * Radar: parcelas candidatas por critério, sem as que já estão no sistema e, opcionalmente, sem restrição conhecida.
 * Resultado é ponto de partida para captação: nada aqui indica que o imóvel está à venda.
 */
export async function radarSearch(f: RadarFilter) {
  const ds = await db('territory_datasets').where({ layer: f.layer, uf: f.uf }).first();
  if (!ds) return { loaded: false, items: [], source: null };
  const restr = (await db('territory_datasets').whereIn('layer', RESTRICTION_LAYERS).where({ uf: f.uf }).select('layer')).map((r) => r.layer);
  const qb = db('territory_features as t').where({ 't.layer': f.layer, 't.uf': f.uf })
    .select(db.raw(`t.id, t.layer, t.uf, t.code, t.name, t.area_ha, t.municipio, t.situacao, t.matricula, t.cns_serventia, t.data_referencia`),
      db.raw('ST_AsGeoJSON(t.geom, 6)::json AS geometry'), db.raw('ST_X(ST_PointOnSurface(t.geom)) lng, ST_Y(ST_PointOnSurface(t.geom)) lat'))
    .whereRaw(`NOT EXISTS (SELECT 1 FROM land_prospects p WHERE p.org_id = ? AND p.geom IS NOT NULL AND p.geom && t.geom AND ST_Intersects(p.geom, t.geom) AND ST_Area(ST_Intersection(p.geom, t.geom)::geography) > 1000)`, [f.orgId])
    .whereRaw(`NOT EXISTS (SELECT 1 FROM land_geometries g JOIN land_opportunities o ON o.id = g.opportunity_id WHERE o.org_id = ? AND g.is_current AND g.geom && t.geom AND ST_Intersects(g.geom, t.geom) AND ST_Area(ST_Intersection(g.geom, t.geom)::geography) > 1000)`, [f.orgId])
    .orderBy('t.area_ha', 'desc').limit(f.limit);
  if (f.municipios?.length) qb.whereRaw('lower(t.municipio) = ANY(?)', [f.municipios.map((m) => m.toLowerCase())]);
  if (f.min_ha != null) qb.where('t.area_ha', '>=', f.min_ha);
  if (f.max_ha != null) qb.where('t.area_ha', '<=', f.max_ha);
  if (f.exclude_restrictions && restr.length) qb.whereRaw(`NOT EXISTS (SELECT 1 FROM territory_features r WHERE r.layer = ANY(?) AND r.geom && t.geom AND ST_Intersects(r.geom, t.geom))`, [restr]);
  const rows = await qb;
  return {
    loaded: true, source: ds.source_name ?? TERRITORY_LAYERS[f.layer as TerritoryLayer].source, loaded_at: ds.loaded_at, restrictions_checked: restr,
    items: rows.map((r: any) => ({ ...toFeature(r, ds.loaded_at, ds.source_name), center: [r.lng, r.lat] })),
  };
}

// ------------------------------------------------------------------ DXF (CAD) em UTM SIRGAS 2000

/** Polilinhas fechadas em metros, no fuso UTM do centro da geometria. O fuso e o datum vão no nome da camada do desenho. */
export async function toDxf(geojsonSql: { sql: string; bindings: any[] }, layerName: string) {
  const { rows } = await db.raw(
    `WITH src AS (${geojsonSql.sql}), z AS (SELECT geom, floor((ST_X(ST_Centroid(geom)) + 180) / 6)::int + 1 AS zone FROM src),
     u AS (SELECT zone, (ST_Dump(ST_Transform(geom, 31960 + zone))).geom AS g FROM z)
     SELECT zone, ST_AsGeoJSON(g, 3)::json AS g FROM u`,
    geojsonSql.bindings,
  );
  if (!rows.length) return null;
  const zone = rows[0].zone;
  const layer = `${layerName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24)}_SIRGAS2000_UTM${zone}S`;
  const out: (string | number)[] = [0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, 6, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES'];
  for (const r of rows) {
    for (const ring of r.g.coordinates as number[][][]) {
      out.push(0, 'POLYLINE', 8, layer, 66, 1, 70, 1, 10, 0, 20, 0, 30, 0);
      for (const [x, y] of ring.slice(0, -1)) out.push(0, 'VERTEX', 8, layer, 10, x, 20, y, 30, 0);
      out.push(0, 'SEQEND', 8, layer);
    }
  }
  out.push(0, 'ENDSEC', 0, 'EOF');
  let s = '';
  for (let i = 0; i < out.length; i += 2) s += `${String(out[i]).padStart(3)}\n${out[i + 1]}\n`;
  return s;
}

export const featureById = async (id: number) => db('territory_features').where({ id }).select(db.raw(`${FEATURE_COLS}, ST_AsGeoJSON(geom, 7)::json AS geometry`)).first();
