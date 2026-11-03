import type { Knex } from 'knex';
import { DOMParser } from '@xmldom/xmldom';
import { kml as kmlToGeoJSON } from '@tmcw/togeojson';
import JSZip from 'jszip';
// @ts-expect-error — shpjs não publica tipos
import shp from 'shpjs';
import { db } from '../db/knex.js';
import { badRequest } from '../lib/http.js';

type Geometry = { type: string; coordinates?: any; geometries?: Geometry[] };

/** Extrai somente polígonos de qualquer GeoJSON (Feature, FeatureCollection, Geometry). */
export function polygonsOf(input: any): Geometry[] {
  if (!input) return [];
  if (input.type === 'FeatureCollection') return input.features.flatMap((f: any) => polygonsOf(f));
  if (Array.isArray(input)) return input.flatMap(polygonsOf); // shpjs pode devolver várias camadas
  if (input.type === 'Feature') return polygonsOf(input.geometry);
  if (input.type === 'GeometryCollection') return input.geometries.flatMap(polygonsOf);
  if (input.type === 'Polygon' || input.type === 'MultiPolygon') return [input];
  return [];
}

/** Converte um arquivo enviado em GeoJSON. Formatos: .geojson/.json, .kml, .kmz, .zip (shapefile). */
export async function parseGeoFile(name: string, buf: Buffer): Promise<any> {
  const ext = name.toLowerCase().split('.').pop();
  try {
    if (ext === 'geojson' || ext === 'json') return JSON.parse(buf.toString('utf8'));
    if (ext === 'kml') return kmlToGeoJSON(new DOMParser().parseFromString(buf.toString('utf8'), 'text/xml') as any);
    if (ext === 'kmz') {
      const zip = await JSZip.loadAsync(buf);
      const entry = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith('.kml'));
      if (!entry) throw new Error('KMZ sem arquivo KML');
      const xml = await entry.async('string');
      return kmlToGeoJSON(new DOMParser().parseFromString(xml, 'text/xml') as any);
    }
    if (ext === 'zip' || ext === 'shp') {
      if (ext === 'shp') throw new Error('Envie o shapefile compactado (.zip com .shp, .shx, .dbf e .prj)');
      return await shp(buf);
    }
  } catch (e: any) {
    throw badRequest(`Não foi possível ler o arquivo geográfico: ${e.message}`);
  }
  throw badRequest('Formato não suportado. Use KML, KMZ, GeoJSON ou SHP (.zip)');
}

/**
 * Persiste nova versão da geometria. PostGIS faz: validação (ST_MakeValid), união, área e perímetro geodésicos
 * (geography/WGS84) e ponto público ofuscado de forma determinística (mesma área → mesmo ponto, sem revelar o centróide).
 */
export async function saveGeometry(trx: Knex, opportunityId: string, input: any, source: string, userId: string | null) {
  const polys = polygonsOf(input);
  if (!polys.length) throw badRequest('Nenhum polígono encontrado no arquivo/desenho');
  const geojsons = polys.map((p) => JSON.stringify(p));

  const [{ valid, area_m2 }] = (
    await trx.raw(
      `WITH g AS (
         SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Union(ST_SetSRID(ST_GeomFromGeoJSON(x), 4326))), 3)) AS geom
         FROM unnest(?::text[]) AS x)
       SELECT NOT ST_IsEmpty(geom) AS valid, ST_Area(geom::geography) AS area_m2 FROM g`,
      [geojsons],
    )
  ).rows;
  if (!valid || !area_m2) throw badRequest('Geometria inválida ou com área zero');
  if (area_m2 > 5e9) throw badRequest('Área acima do limite (500.000 ha) — verifique o sistema de coordenadas do arquivo');

  const prev = await trx('land_geometries').where({ opportunity_id: opportunityId }).max({ v: 'version' }).first();
  await trx('land_geometries').where({ opportunity_id: opportunityId, is_current: true }).update({ is_current: false });

  const { rows } = await trx.raw(
    `WITH g AS (
       SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Union(ST_SetSRID(ST_GeomFromGeoJSON(x), 4326))), 3)) AS geom
       FROM unnest(?::text[]) AS x),
     c AS (SELECT geom, ST_PointOnSurface(geom) AS centroid FROM g),
     h AS (SELECT *, ('x' || substr(md5(?::text), 1, 8))::bit(32)::int AS seed FROM c)
     INSERT INTO land_geometries (opportunity_id, geom, centroid, public_point, area_m2, perimeter_m, source, version, is_current, created_by)
     SELECT ?, geom, centroid,
       ST_SetSRID(ST_MakePoint(
         ST_X(ST_SnapToGrid(centroid, 0.01)) + ((seed % 1000) / 1000.0 - 0.5) * 0.008,
         ST_Y(ST_SnapToGrid(centroid, 0.01)) + (((seed / 1000) % 1000) / 1000.0 - 0.5) * 0.008), 4326),
       ST_Area(geom::geography), ST_Perimeter(geom::geography), ?, ?, true, ?
     FROM h
     RETURNING id, area_m2, perimeter_m, version, ST_X(centroid) AS lng, ST_Y(centroid) AS lat`,
    [geojsons, opportunityId, opportunityId, source, (prev?.v ?? 0) + 1, userId],
  );
  const g = rows[0];
  // Área declarada só é preenchida automaticamente se estiver vazia; lat/lng sempre acompanham o perímetro.
  await trx('land_opportunities')
    .where({ id: opportunityId })
    .update({ lat: g.lat, lng: g.lng, area_m2: trx.raw('COALESCE(area_m2, ?)', [Math.round(g.area_m2)]), updated_at: trx.fn.now() });
  return g;
}

export { approxPoint } from '../domain/views.js';

export { db };
