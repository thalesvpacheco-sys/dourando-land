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
// Satélite: template XYZ explícito (VITE_SATELLITE_TILES) ou a Mapbox servida pelo próprio servidor (/api/map), que guarda o token
const MAPBOX_PROXY = import.meta.env.VITE_SATELLITE_PROXY === '1';
const SATELLITE = (import.meta.env.VITE_SATELLITE_TILES as string | undefined)
  || (MAPBOX_PROXY ? `${location.origin}/api/map/satellite/{z}/{x}/{y}` : undefined);
const SAT_TILE_SIZE = import.meta.env.VITE_SATELLITE_TILES ? 256 : 512;
const SAT_ATTRIBUTION = (import.meta.env.VITE_SATELLITE_ATTRIBUTION as string | undefined)
  || (MAPBOX_PROXY ? '© <a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener">Mapbox</a> © <a href="https://www.maxar.com/" target="_blank" rel="noopener">Maxar</a>' : 'Imagem de satélite: provedor licenciado');

export const HAS_SATELLITE = !!SATELLITE;
/** Satélite como camada alternável, abaixo das parcelas (mapas que têm dados por cima). */
export function addSatellite(m: MLMap) {
  if (!SATELLITE || m.getSource('sat-toggle')) return;
  m.addSource('sat-toggle', { type: 'raster', tiles: [SATELLITE], tileSize: SAT_TILE_SIZE, maxzoom: 19, attribution: SAT_ATTRIBUTION });
  m.addLayer({ id: 'sat-toggle', type: 'raster', source: 'sat-toggle' }, 'uf-line');
}
export function setSatelliteVisible(m: MLMap, on: boolean) {
  if (m.getLayer('sat-toggle')) m.setLayoutProperty('sat-toggle', 'visibility', on ? 'visible' : 'none');
}

/**
 * Relevo 3D: modelo de elevação aberto (Terrarium/AWS, sem chave e sem custo) sob qualquer base.
 * Liga terreno, sombreamento e inclinação; desligado, volta ao mapa plano visto de cima.
 */
// maxzoom 14: o modelo (SRTM ~30 m) não ganha detalhe acima disso, e cada nível a mais multiplica os downloads.
// tileSize igual ao do satélite: com tamanhos diferentes o MapLibre deixa faixas sem imagem sobre o relevo em certos zooms.
const DEM = { type: 'raster-dem' as const, tiles: ['https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'], tileSize: SAT_TILE_SIZE, maxzoom: 14, encoding: 'terrarium' as const, attribution: 'Relevo: Mapzen/AWS Terrain Tiles' };
/** Inclinação do 3D: 50° mostra bem o relevo sem puxar o horizonte (inclinação alta carrega muito mais blocos de satélite). */
export const PITCH_3D = 50;
/** Opções do construtor para o mapa já nascer em 3D, sem animação de entrada. */
export const START_3D = { pitch: PITCH_3D, bearing: -15, maxPitch: 70 };
export function set3D(m: MLMap, on: boolean, animate = true) {
  // antes do 'load' o estilo não aceita fontes novas: quem chama reaplica o estado no evento 'load'
  if (!(m as any).style?._loaded) return;
  if (on) {
    // uma fonte só para relevo e sombreamento: metade dos downloads de elevação
    if (!m.getSource('dem')) m.addSource('dem', DEM);
    if (!m.getLayer('hillshade')) m.addLayer({ id: 'hillshade', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#3a3a36' } }, m.getLayer('uf-line') ? 'uf-line' : undefined);
    m.setTerrain({ source: 'dem', exaggeration: 1.4 });
    m.dragRotate.enable(); m.touchZoomRotate.enableRotation(); m.touchPitch.enable();
    m.setMaxPitch(70);
    if (m.getPitch() < 30) m.easeTo({ pitch: PITCH_3D, bearing: m.getBearing() || -15, duration: animate ? 900 : 0 });
  } else {
    m.setTerrain(null);
    if (m.getLayer('hillshade')) m.removeLayer('hillshade');
    m.dragRotate.disable(); m.touchZoomRotate.disableRotation(); m.touchPitch.disable();
    m.easeTo({ pitch: 0, bearing: 0, duration: animate ? 600 : 0 });
  }
}

/**
 * Recorte útil da tela [oeste, sul, leste, norte]. No 3D o topo da tela mostra o horizonte, a quilômetros de distância:
 * consultas por recorte (parcelas, áreas visíveis) usam só até 25% do topo, o que o usuário de fato enxerga.
 */
export function viewBounds(m: MLMap): [number, number, number, number] {
  if (m.getPitch() < 5) { const b = m.getBounds(); return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; }
  const { width: w, height: h } = m.getCanvas().getBoundingClientRect();
  const pts = [[0, h], [w, h], [0, h * 0.25], [w, h * 0.25], [w / 2, h * 0.25]].map(([x, y]) => m.unproject([x, y]));
  const lng = pts.map((p) => p.lng), lat = pts.map((p) => p.lat);
  return [Math.min(...lng), Math.min(...lat), Math.max(...lng), Math.max(...lat)];
}

/** Textos dos controles do mapa em português (o MapLibre vem em inglês). */
export const MAP_LOCALE = {
  'NavigationControl.ZoomIn': 'Aproximar',
  'NavigationControl.ZoomOut': 'Afastar',
  'NavigationControl.ResetBearing': 'Voltar para o norte (arraste para girar)',
  'AttributionControl.ToggleAttribution': 'Créditos do mapa',
  'AttributionControl.MapFeedback': 'Sugerir correção no mapa',
  'FullscreenControl.Enter': 'Tela cheia',
  'FullscreenControl.Exit': 'Sair da tela cheia',
  'GeolocateControl.FindMyLocation': 'Minha localização',
  'ScaleControl.Feet': 'pés', 'ScaleControl.Meters': 'm', 'ScaleControl.Kilometers': 'km', 'ScaleControl.Miles': 'mi', 'ScaleControl.NauticalMiles': 'mn',
  'Map.Title': 'Mapa',
  'Marker.Title': 'Marcador',
  'Popup.Close': 'Fechar',
  'CooperativeGesturesHandler.WindowsHelpText': 'Use Ctrl + rolagem para aproximar o mapa',
  'CooperativeGesturesHandler.MacHelpText': 'Use ⌘ + rolagem para aproximar o mapa',
  'CooperativeGesturesHandler.MobileHelpText': 'Use dois dedos para mover o mapa',
};

/** Botão 3D/2D para os mapas. */
export function Toggle3D({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="view-toggle" role="group" aria-label="Perspectiva do mapa">
      <button type="button" aria-pressed={!on} onClick={() => onChange(false)}>2D</button>
      <button type="button" aria-pressed={on} onClick={() => onChange(true)}>3D</button>
    </div>
  );
}

/** Cidades de referência: [nome, lng, lat, zoom mínimo]. Sem o zoom mínimo, os municípios vizinhos se sobrepõem na visão geral. */
export const CITIES: [string, number, number, number][] = [
  // capitais: sempre visíveis
  ['Goiânia', -49.264, -16.686, 0], ['Brasília', -47.882, -15.794, 0], ['São Paulo', -46.633, -23.55, 0], ['Belo Horizonte', -43.938, -19.92, 0],
  ['Palmas', -48.333, -10.184, 0], ['Cuiabá', -56.097, -15.601, 0], ['Campo Grande', -54.62, -20.469, 0], ['Rio de Janeiro', -43.196, -22.908, 0], ['Curitiba', -49.273, -25.428, 0],
  // polos regionais
  ['Anápolis', -48.952, -16.328, 7], ['Uberlândia', -48.277, -18.918, 6], ['Rio Verde', -50.928, -17.792, 6],
  ['Campinas', -47.063, -22.906, 6], ['Ribeirão Preto', -47.81, -21.178, 6], ['São José do Rio Preto', -49.379, -20.811, 6], ['Sorocaba', -47.458, -23.502, 7],
  ['São José dos Campos', -45.887, -23.179, 7], ['Bauru', -49.061, -22.315, 6], ['Presidente Prudente', -51.389, -22.121, 6],
  // entorno de Goiânia: só de perto
  ['Goianira', -49.426, -16.494, 9], ['Senador Canedo', -49.092, -16.708, 9], ['Trindade', -49.492, -16.649, 9], ['Aparecida de Goiânia', -49.244, -16.823, 9], ['Inhumas', -49.496, -16.358, 9], ['Bela Vista de Goiás', -48.951, -16.973, 9],
];

/** Enquadramento sem áreas: do DF/GO a SP, onde está a carteira. */
export const DEFAULT_VIEW = { center: [-48.6, -19.6] as [number, number], zoom: 4.6 };

/** Rótulos de cidade como marcadores HTML (a base própria não tem fontes de mapa), escondidos abaixo do zoom mínimo de cada um. */
export function addCityLabels(m: MLMap) {
  const labels = CITIES.map(([name, lng, lat, minZoom]) => {
    const d = document.createElement('div');
    d.style.cssText = 'font: 500 11px var(--font); color:#6e6e6a; pointer-events:none; white-space:nowrap; transform: translateY(-10px)';
    d.innerHTML = `<span style="display:inline-block;width:4px;height:4px;background:#6e6e6a;border-radius:50%;margin-right:4px;vertical-align:middle"></span>${name}`;
    new maplibregl.Marker({ element: d, anchor: 'left' }).setLngLat([lng, lat]).addTo(m);
    return { d, minZoom };
  });
  const sync = () => { const z = m.getZoom(); for (const l of labels) l.d.style.visibility = z >= l.minZoom ? 'visible' : 'hidden'; };
  sync();
  m.on('zoomend', sync);
}

export function baseStyle(kind: 'base' | 'satellite' = 'base'): StyleSpecification {
  const sources: StyleSpecification['sources'] = { uf: { type: 'geojson', data: brazil as any } };
  const layers: StyleSpecification['layers'] = [{ id: 'bg', type: 'background', paint: { 'background-color': '#dcdcd6' } }];
  if (kind === 'satellite' && SATELLITE) {
    sources.sat = { type: 'raster', tiles: [SATELLITE], tileSize: SAT_TILE_SIZE, maxzoom: 19, attribution: SAT_ATTRIBUTION };
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
  /** Começa em 3D (padrão nos mapas interativos; mapas estáticos do book ficam planos). */
  initial3d?: boolean;
  /**
   * Mapa embutido no meio da página: a rolagem do mouse rola a página (zoom com Ctrl + rolagem) e, no celular,
   * um dedo rola a página e dois dedos movem o mapa. Só o mapa de tela cheia (/mapa) passa false.
   */
  embedded?: boolean;
}

export default function MapView({ features, className = 'map', fit = true, center, zoom, interactive = true, onBoundsChange, legend = true, compare = [], initial3d = interactive, embedded = true }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  // 3D pede satélite: sobre o fundo liso o relevo quase não aparece
  const [layer, setLayer] = useState<'base' | 'provider' | 'satellite'>(SATELLITE && interactive ? 'satellite' : PROVIDER_STYLE ? 'provider' : 'base');
  const [ready, setReady] = useState(0);
  // depois que a pessoa mexe no mapa, ele não reenquadra sozinho (redimensionar, trocar camada); só quando as áreas mudam
  const userMoved = useRef(false);
  const camera = useRef<{ center: [number, number]; zoom: number; pitch: number; bearing: number } | null>(null);
  const lastFitKey = useRef('');
  const [is3d, setIs3d] = useState(initial3d);
  const is3dRef = useRef(is3d);
  is3dRef.current = is3d;
  const latest = useRef(features);
  latest.current = features;

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: layer === 'provider' && PROVIDER_STYLE ? PROVIDER_STYLE : baseStyle(layer === 'satellite' ? 'satellite' : 'base'),
      center: center ?? DEFAULT_VIEW.center, zoom: zoom ?? DEFAULT_VIEW.zoom, interactive, attributionControl: { compact: true },
      cooperativeGestures: interactive && embedded, locale: MAP_LOCALE,
      dragRotate: false, pitchWithRotate: false,
      ...(is3dRef.current ? START_3D : {}),
      // trocou Mapa/Satélite: continua de onde a pessoa estava
      ...(userMoved.current && camera.current ? camera.current : {}),
      // mapas estáticos (book/PDF) precisam manter o buffer para impressão
      canvasContextAttributes: interactive ? undefined : { preserveDrawingBuffer: true },
    });
    map.current = m;
    if (interactive) m.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'bottom-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.on('load', () => {
      if (layer !== 'provider') addCityLabels(m);
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
      if (is3dRef.current) set3D(m, true, false);
      setReady((n) => n + 1);
    });
    const emit = () => {
      if (!onBoundsChange) return;
      onBoundsChange(viewBounds(m));
    };
    m.on('moveend', emit);
    // redesenha quando o mapa para: no 3D o relevo termina de carregar depois do primeiro desenho e reposiciona os pontos
    let lastKey = '';
    m.on('idle', () => drawMarkers());
    m.on('moveend', () => drawMarkers());

    function drawMarkers() {
      const src = m.getSource('areas') as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      const seen = new Set<string>();
      // só o que está renderizado no zoom atual (querySourceFeatures traria tiles de outros níveis em cache)
      if (!m.getLayer('pts')) return;
      const rendered = m.queryRenderedFeatures({ layers: ['pts', 'cls'] });
      const key = rendered.map((f: any) => (f.properties.cluster ? `c${f.properties.cluster_id}` : f.properties.code)).sort().join('|');
      if (key === lastKey && markers.current.length) return;
      lastKey = key;
      markers.current.forEach((mk) => mk.remove());
      markers.current = [];
      for (const f of rendered) {
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
        d.dataset.code = p.cluster ? '' : p.code;
        markers.current.push(new maplibregl.Marker({ element: d }).setLngLat(coords).addTo(m));
      }
      // No 3D, perto e longe da câmera aparecem níveis de zoom diferentes: um grupo pode vir junto com as áreas que ele já contém.
      // O grupo prevalece e esconde essas áreas, para não mostrar a mesma área duas vezes.
      for (const f of rendered) {
        const p: any = f.properties;
        if (!p.cluster) continue;
        src.getClusterLeaves(p.cluster_id, Infinity, 0).then((leaves) => {
          const codes = new Set(leaves.map((l: any) => l.properties.code));
          for (const mk of markers.current) { const el = mk.getElement(); if (el.dataset.code && codes.has(el.dataset.code)) el.style.display = 'none'; }
        }).catch(() => {});
      }
    }
    // o contêiner pode mudar de tamanho depois do carregamento (fontes, layout responsivo): reajusta e reenquadra
    for (const ev of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart'] as const) m.on(ev, (e: any) => { if (e.originalEvent) userMoved.current = true; });
    m.on('moveend', () => { const c = m.getCenter(); camera.current = { center: [c.lng, c.lat], zoom: m.getZoom(), pitch: m.getPitch(), bearing: m.getBearing() }; });
    // no celular a barra do navegador some/aparece ao rolar e o mapa muda de tamanho: só reenquadra se a pessoa não mexeu
    const ro = new ResizeObserver(() => { m.resize(); if (!userMoved.current) fitAll(); });
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
    // no 3D a borda de baixo fica perto da câmera e corta marcadores: folga maior
    const pad = (one ? 40 : 70) + (m.getPitch() > 10 ? 30 : 0);
    m.fitBounds(b, { padding: pad, maxZoom: one ? (p.polygon ? 14.5 : p.radius_m && p.radius_m > 3000 ? 10.5 : 13) : 10, duration: 0 });
  }

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.getSource('areas')) return;
    (m.getSource('areas') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features } as any);
    (m.getSource('shapes') as maplibregl.GeoJSONSource).setData(areaShapes(features) as any);
    m.setFilter('shape-compare', ['in', ['get', 'code'], ['literal', compare]]);
    const key = features.map((f) => f.properties.code).sort().join('|');
    if (key !== lastFitKey.current) { lastFitKey.current = key; userMoved.current = false; fitAll(); }
    else if (!userMoved.current) fitAll();
  }, [features, ready, fit, compare]);

  useEffect(() => {
    const m = map.current;
    if (m && ready) set3D(m, is3d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [is3d]);

  const options: { key: typeof layer; label: string }[] = [{ key: 'base', label: 'Mapa' }];
  if (PROVIDER_STYLE) options.unshift({ key: 'provider', label: 'Ruas e rodovias' });
  if (SATELLITE) options.push({ key: 'satellite', label: 'Satélite' });

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={el} className={className} role="region" aria-label="Mapa de oportunidades" />
      {interactive && (
        <div className="map-layers">
          {options.length > 1 && (
            <div className="view-toggle" role="group" aria-label="Camada do mapa">
              {options.map((o) => <button key={o.key} type="button" aria-pressed={layer === o.key} onClick={() => setLayer(o.key)}>{o.label}</button>)}
            </div>
          )}
          <Toggle3D on={is3d} onChange={setIs3d} />
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
