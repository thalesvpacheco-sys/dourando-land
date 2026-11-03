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
import { demoTerritoryFeatures, earthUrl, pointInGeometry, type TerritoryProps } from '@dl/shared';
import { db } from '../db/knex.js';

const env = process.env;
export const territoryMode = () => (env.TERRITORY_MODE ?? (env.NODE_ENV === 'production' ? 'live' : 'demo')) as 'demo' | 'live';
type Layer = 'sigef' | 'car';

const SOURCES: Record<Layer, { name: string; url?: string; layer?: string; official: string }> = {
  sigef: { name: 'Imóveis certificados (SIGEF/INCRA)', url: env.TERRITORY_SIGEF_WFS_URL, layer: env.TERRITORY_SIGEF_LAYER, official: 'https://sigef.incra.gov.br/' },
  car: { name: 'Cadastro Ambiental Rural (SICAR)', url: env.TERRITORY_CAR_WFS_URL, layer: env.TERRITORY_CAR_LAYER, official: 'https://consultapublica.car.gov.br/publico/imoveis/index' },
};

export function layerStatus() {
  const mode = territoryMode();
  return {
    mode,
    layers: (Object.keys(SOURCES) as Layer[]).map((k) => ({
      key: k, name: SOURCES[k].name, official_url: SOURCES[k].official,
      status: mode === 'demo' ? 'simulated' : SOURCES[k].url && SOURCES[k].layer ? 'implemented' : 'pending',
    })),
    registry: {
      key: 'onr', name: 'Mapa do Registro de Imóveis (ONR)', official_url: 'https://mapa.onr.org.br/',
      status: mode === 'demo' ? 'simulated' : env.ONR_PROVIDER_URL && env.ONR_PROVIDER_TOKEN ? 'implemented' : 'pending',
    },
  };
}

/** Normaliza atributos de bases diferentes para o mesmo formato (mantém os originais em `raw`). */
function normalize(layer: Layer, p: Record<string, any>): TerritoryProps & { raw: any } {
  const pick = (...keys: string[]) => { for (const k of keys) { const v = p[k] ?? p[k.toUpperCase()]; if (v !== undefined && v !== null && v !== '') return v; } return null; };
  const area = pick('area_ha', 'num_area', 'area', 'area_imovel', 'nu_area');
  return {
    layer,
    codigo: String(pick('parcela_codigo', 'parcela_co', 'codigo_imo', 'cod_imovel', 'codigo', 'id') ?? ''),
    nome: pick('nome_area', 'nome_imovel', 'nome'),
    area_ha: area != null ? Number(area) : null,
    municipio: pick('municipio', 'nom_munici', 'municipio_nome'),
    uf: pick('uf', 'uf_id', 'cod_estado', 'estado'),
    situacao: pick('situacao_i', 'situacao', 'des_condic', 'ind_status', 'status'),
    matricula: pick('registro_m', 'matricula', 'matriculas'),
    cns_serventia: pick('registro_d', 'cns', 'cns_serventia'),
    data_referencia: pick('data_aprov', 'data_submi', 'dat_criaca', 'data_certificado'),
    fonte: `${SOURCES[layer].name} — WFS`,
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

export async function getFeatures(layer: Layer, bbox: [number, number, number, number], uf: string | null) {
  const consulted_at = new Date().toISOString();
  if (territoryMode() === 'demo') {
    const d = demoTerritoryFeatures(layer, bbox);
    return { mode: 'demo', status: 'simulated', too_large: d.tooLarge, consulted_at, features: d.features };
  }
  const [minX, minY, maxX, maxY] = bbox;
  if (maxX - minX > 0.3 || maxY - minY > 0.3) return { mode: 'live', status: 'implemented', too_large: true, consulted_at, features: [] };
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
  for (const layer of ['sigef', 'car'] as Layer[]) {
    try {
      const r = await getFeatures(layer, bbox, uf);
      for (const f of r.features) if (pointInGeometry([lng, lat], f.geometry)) out.parcels.push({ ...f, consulted_at: r.consulted_at });
    } catch (e: any) {
      out.parcels.push({ error: e.message, layer });
    }
  }
  const sigef = out.parcels.find((p: any) => p.properties?.layer === 'sigef')?.properties ?? null;
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
  for (const layer of ['sigef', 'car'] as Layer[]) {
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
