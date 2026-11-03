import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap, StyleSpecification } from 'maplibre-gl';
import brazil from '@amcharts/amcharts4-geodata/json/brazilLow.json';
// O worker do MapLibre 6 é autocontido; servimos o arquivo como asset para que funcione no bundle de produção.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

maplibregl.setWorkerUrl(workerUrl);
import { formatArea } from '@dl/shared';

/**
 * Base cartográfica própria (contornos de UF + cidades de referência), que funciona sem provedor externo.
 * Com VITE_MAP_STYLE_URL (provedor licenciado: rodovias, POIs, rótulos) ou VITE_SATELLITE_TILES, as camadas aparecem no seletor.
 */
const PROVIDER_STYLE = import.meta.env.VITE_MAP_STYLE_URL as string | undefined;
const SATELLITE = import.meta.env.VITE_SATELLITE_TILES as string | undefined;

export const CITIES: [string, number, number][] = [
  ['Goianira', -49.426, -16.494], ['Senador Canedo', -49.092, -16.708], ['Trindade', -49.492, -16.649], ['Aparecida de Goiânia', -49.244, -16.823], ['Inhumas', -49.496, -16.358], ['Bela Vista de Goiás', -48.951, -16.973],
  ['Goiânia', -49.264, -16.686], ['Brasília', -47.882, -15.794], ['Anápolis', -48.952, -16.328], ['Palmas', -48.333, -10.184],
  ['Uberlândia', -48.277, -18.918], ['Rio Verde', -50.928, -17.792], ['Cuiabá', -56.097, -15.601], ['Campo Grande', -54.62, -20.469],
  ['Belo Horizonte', -43.938, -19.92], ['São Paulo', -46.633, -23.55],
];

export function baseStyle(kind: 'base' | 'satellite' = 'base'): StyleSpecification {
  const sources: StyleSpecification['sources'] = { uf: { type: 'geojson', data: brazil as any } };
  const layers: StyleSpecification['layers'] = [{ id: 'bg', type: 'background', paint: { 'background-color': '#dcdcd6' } }];
  if (kind === 'satellite' && SATELLITE) {
    sources.sat = { type: 'raster', tiles: [SATELLITE], tileSize: 256, attribution: 'Imagem de satélite: provedor licenciado' };
    layers.push({ id: 'sat', type: 'raster', source: 'sat' });
    layers.push({ id: 'uf-line', type: 'line', source: 'uf', paint: { 'line-color': '#ffffff', 'line-width': 1, 'line-opacity': 0.6 } });
  } else {
    layers.push(
      { id: 'uf-fill', type: 'fill', source: 'uf', paint: { 'fill-color': '#f3f3f0' } },
      { id: 'uf-line', type: 'line', source: 'uf', paint: { 'line-color': '#a6a6a0', 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 9, 1.6] } },
    );
  }
  return { version: 8, sources, layers };
}

function circlePolygon([lng, lat]: [number, number], radiusM: number, steps = 48) {
  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    coords.push([lng + ((radiusM / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a)), lat + (radiusM / 110540) * Math.sin(a)]);
  }
  return { type: 'Polygon', coordinates: [coords] };
}

export interface AreaFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { code: string; slug: string; title: string; city: string; uf: string; area_m2: number; precision: string; radius_m: number | null; cover: string | null; polygon: string | null; modalities?: string };
}

function areaShapes(features: AreaFeature[]) {
  return {
    type: 'FeatureCollection',
    features: features.flatMap((f) => {
      const p = f.properties;
      if (p.polygon) return [{ type: 'Feature', geometry: JSON.parse(p.polygon), properties: { code: p.code, kind: 'exact' } }];
      if (p.radius_m) return [{ type: 'Feature', geometry: circlePolygon(f.geometry.coordinates, p.radius_m), properties: { code: p.code, kind: p.precision } }];
      return [];
    }),
  };
}

function popupHtml(p: AreaFeature['properties']) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  return `<div class="map-card">${p.cover ? `<img src="${esc(p.cover)}" alt="" />` : ''}<div>
    <span class="small muted">${esc(p.code)} · ${esc(p.city)}/${esc(p.uf)}</span>
    <b class="wide">${formatArea(p.area_m2)}</b><p style="margin:.2rem 0 .5rem">${esc(p.title)}</p>
    <a href="/areas/${esc(p.slug)}">Ver detalhes da área</a></div></div>`;
}

interface Props {
  features: AreaFeature[];
  className?: string;
  /** Ajusta o enquadramento às áreas visíveis. */
  fit?: boolean;
  center?: [number, number];
  zoom?: number;
  interactive?: boolean;
  onBoundsChange?: (bbox: [number, number, number, number]) => void;
  legend?: boolean;
  compare?: string[];
}

export default function MapView({ features, className = 'map', fit = true, center, zoom, interactive = true, onBoundsChange, legend = true, compare = [] }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const [layer, setLayer] = useState<'base' | 'provider' | 'satellite'>(PROVIDER_STYLE ? 'provider' : 'base');
  const [ready, setReady] = useState(0);
  const latest = useRef(features);
  latest.current = features;

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: layer === 'provider' && PROVIDER_STYLE ? PROVIDER_STYLE : baseStyle(layer === 'satellite' ? 'satellite' : 'base'),
      center: center ?? [-49.3, -16.6], zoom: zoom ?? 5.2, interactive, attributionControl: { compact: true }, cooperativeGestures: false,
      dragRotate: false, pitchWithRotate: false,
      // mapas estáticos (book/PDF) precisam manter o buffer para impressão
      canvasContextAttributes: interactive ? undefined : { preserveDrawingBuffer: true },
    });
    map.current = m;
    if (interactive) m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.on('load', () => {
      if (layer !== 'provider') {
        for (const [name, lng, lat] of CITIES) {
          const d = document.createElement('div');
          d.style.cssText = 'font: 500 11px var(--font); color:#6e6e6a; pointer-events:none; white-space:nowrap; transform: translateY(-10px)';
          d.innerHTML = `<span style="display:inline-block;width:4px;height:4px;background:#6e6e6a;border-radius:50%;margin-right:4px;vertical-align:middle"></span>${name}`;
          new maplibregl.Marker({ element: d, anchor: 'left' }).setLngLat([lng, lat]).addTo(m);
        }
      }
      m.addSource('areas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, cluster: true, clusterRadius: 46, clusterMaxZoom: 10 });
      m.addSource('shapes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'shape-fill', type: 'fill', source: 'shapes', paint: { 'fill-color': '#f8b817', 'fill-opacity': ['case', ['==', ['get', 'kind'], 'exact'], 0.3, 0.14] } });
      m.addLayer({
        id: 'shape-line', type: 'line', source: 'shapes',
        paint: { 'line-color': ['case', ['==', ['get', 'kind'], 'exact'], '#0a0a0a', '#cc9814'], 'line-width': ['case', ['==', ['get', 'kind'], 'exact'], 2.2, 1.4], 'line-dasharray': ['case', ['==', ['get', 'kind'], 'exact'], ['literal', [1, 0]], ['literal', [2, 2]]] },
      });
      m.addLayer({ id: 'shape-compare', type: 'line', source: 'shapes', filter: ['in', ['get', 'code'], ['literal', []]], paint: { 'line-color': '#0a0a0a', 'line-width': 3.5 } });
      // pontos sem cluster: invisíveis (o marcador é HTML), servem para consulta
      m.addLayer({ id: 'pts', type: 'circle', source: 'areas', filter: ['!', ['has', 'point_count']], paint: { 'circle-radius': 6, 'circle-opacity': 0 } });
      m.addLayer({ id: 'cls', type: 'circle', source: 'areas', filter: ['has', 'point_count'], paint: { 'circle-radius': 12, 'circle-opacity': 0 } });
      m.on('click', 'shape-fill', (e: any) => {
        const code = e.features?.[0]?.properties?.code;
        const f = latest.current.find((x) => x.properties.code === code);
        if (f) new maplibregl.Popup({ offset: 8, maxWidth: '280px' }).setLngLat(e.lngLat).setHTML(popupHtml(f.properties)).addTo(m);
      });
      m.on('mouseenter', 'shape-fill', () => (m.getCanvas().style.cursor = 'pointer'));
      m.on('mouseleave', 'shape-fill', () => (m.getCanvas().style.cursor = ''));
      setReady((n) => n + 1);
    });
    const emit = () => {
      if (!onBoundsChange) return;
      const b = m.getBounds();
      onBoundsChange([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    };
    m.on('moveend', emit);
    m.on('moveend', () => drawMarkers());
    m.on('sourcedata', (e: any) => { if (e.sourceId === 'areas' && e.isSourceLoaded) m.once('idle', drawMarkers); });

    function drawMarkers() {
      const src = m.getSource('areas') as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      markers.current.forEach((mk) => mk.remove());
      markers.current = [];
      const seen = new Set<string>();
      // só o que está renderizado no zoom atual (querySourceFeatures traria tiles de outros níveis em cache)
      if (!m.getLayer('pts')) return;
      for (const f of m.queryRenderedFeatures({ layers: ['pts', 'cls'] })) {
        const p: any = f.properties;
        const key = p.cluster ? `c${p.cluster_id}` : p.code;
        if (seen.has(key)) continue;
        seen.add(key);
        const coords = (f.geometry as any).coordinates as [number, number];
        const d = document.createElement('button');
        d.type = 'button';
        if (p.cluster) {
          const size = 30 + Math.min(26, Math.sqrt(p.point_count) * 8);
          d.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:#0a0a0a;color:#fff;border:3px solid #f8b817;font:700 13px var(--font);cursor:pointer;box-shadow:0 2px 8px #0003`;
          d.textContent = String(p.point_count);
          d.setAttribute('aria-label', `${p.point_count} áreas — aproximar`);
          d.onclick = async () => {
            const z = await src.getClusterExpansionZoom(p.cluster_id);
            m.easeTo({ center: coords, zoom: z + 0.3 });
          };
        } else {
          const ha = p.area_m2 >= 10000 ? `${Math.round(p.area_m2 / 10000)} ha` : `${Math.round(p.area_m2 / 1000)} mil m²`;
          d.style.cssText = 'padding:3px 8px;border-radius:3px;background:#f8b817;color:#0a0a0a;border:2px solid #fff;font:650 12px var(--font);font-variation-settings:"wdth" 112;cursor:pointer;box-shadow:0 2px 6px #0003;white-space:nowrap';
          d.textContent = ha;
          d.setAttribute('aria-label', `${p.title}, ${ha}`);
          d.onclick = (ev) => {
            ev.stopPropagation();
            new maplibregl.Popup({ offset: 14, maxWidth: '280px' }).setLngLat(coords).setHTML(popupHtml(p)).addTo(m);
          };
        }
        markers.current.push(new maplibregl.Marker({ element: d }).setLngLat(coords).addTo(m));
      }
    }
    // o contêiner pode mudar de tamanho depois do carregamento (fontes, layout responsivo): reajusta e reenquadra
    const ro = new ResizeObserver(() => { m.resize(); fitAll(); });
    ro.observe(el.current);
    return () => { ro.disconnect(); m.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer]);

  const fitRef = useRef(fit);
  fitRef.current = fit;
  function fitAll() {
    const m = map.current;
    const fs = latest.current;
    if (!m || !fitRef.current || !fs.length) return;
    const b = new maplibregl.LngLatBounds();
    fs.forEach((f) => b.extend(f.geometry.coordinates));
    const one = fs.length === 1;
    const p = fs[0].properties;
    m.fitBounds(b, { padding: one ? 40 : 70, maxZoom: one ? (p.polygon ? 14.5 : p.radius_m && p.radius_m > 3000 ? 10.5 : 13) : 10, duration: 0 });
  }

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.getSource('areas')) return;
    (m.getSource('areas') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features } as any);
    (m.getSource('shapes') as maplibregl.GeoJSONSource).setData(areaShapes(features) as any);
    m.setFilter('shape-compare', ['in', ['get', 'code'], ['literal', compare]]);
    fitAll();
  }, [features, ready, fit, compare]);

  const options: { key: typeof layer; label: string }[] = [{ key: 'base', label: 'Mapa' }];
  if (PROVIDER_STYLE) options.unshift({ key: 'provider', label: 'Ruas e rodovias' });
  if (SATELLITE) options.push({ key: 'satellite', label: 'Satélite' });

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={el} className={className} role="region" aria-label="Mapa de oportunidades" />
      {options.length > 1 && (
        <div className="map-layers">
          <div className="view-toggle" role="group" aria-label="Camada do mapa">
            {options.map((o) => <button key={o.key} type="button" aria-pressed={layer === o.key} onClick={() => setLayer(o.key)}>{o.label}</button>)}
          </div>
        </div>
      )}
      {legend && (
        <div className="map-legend">
          <span><i style={{ background: '#f8b8174d', border: '2px solid #0a0a0a' }} />Perímetro informado</span>
          <span><i style={{ background: '#f8b81724', border: '1.5px dashed #cc9814' }} />Localização aproximada</span>
        </div>
      )}
    </div>
  );
}
