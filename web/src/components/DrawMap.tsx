import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap } from 'maplibre-gl';
import turfArea from '@turf/area';
import turfLength from '@turf/length';
import { formatArea } from '@dl/shared';
import { baseStyle } from './MapView';
import { api } from '../lib/api';

type Ring = [number, number][];

/** Desenho e edição de perímetro: clique para adicionar vértices, arraste para ajustar. Área e perímetro calculados ao vivo (geodésico). */
export default function DrawMap({ importUrl, initial, center, onSave, saving }: { importUrl: string; initial: any | null; center: [number, number] | null; onSave: (geojson: any, source: string) => void; saving: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const [ring, setRing] = useState<Ring>(() => ringFrom(initial));
  const [drawing, setDrawing] = useState(false);
  const [source, setSource] = useState('draw');
  const vertexMarkers = useRef<maplibregl.Marker[]>([]);
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;

  useEffect(() => { setRing(ringFrom(initial)); }, [initial]);

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({ container: el.current, style: baseStyle(), center: center ?? [-49.3, -16.6], zoom: center ? 13 : 5, doubleClickZoom: false, dragRotate: false });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.on('load', () => {
      m.addSource('draft', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#f8b817', 'fill-opacity': 0.28 } });
      m.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': '#0a0a0a', 'line-width': 2.2 } });
      setRing((r) => [...r]);
    });
    m.on('click', (e: any) => {
      if (!drawingRef.current) return;
      setRing((r) => [...r, [e.lngLat.lng, e.lngLat.lat]]);
    });
    m.on('dblclick', () => { if (drawingRef.current) setDrawing(false); });
    return () => m.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // redesenha polígono e vértices
  useEffect(() => {
    const m = map.current;
    if (!m || !m.getSource('draft')) return;
    const closed = ring.length >= 3 ? [...ring, ring[0]] : ring;
    const feat = ring.length >= 3
      ? { type: 'Feature', geometry: { type: 'Polygon', coordinates: [closed] }, properties: {} }
      : { type: 'Feature', geometry: { type: 'LineString', coordinates: ring.length ? ring : [[0, 0], [0, 0]] }, properties: {} };
    (m.getSource('draft') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: ring.length ? [feat] : [] } as any);
    vertexMarkers.current.forEach((v) => v.remove());
    vertexMarkers.current = ring.map((pt, i) => {
      const d = document.createElement('div');
      d.style.cssText = 'width:12px;height:12px;border-radius:50%;background:#f8f9f5;border:2px solid #0a0a0a;cursor:move';
      d.title = 'Arraste para mover. Clique com o botão direito para remover.';
      d.oncontextmenu = (ev) => { ev.preventDefault(); setRing((r) => r.filter((_, k) => k !== i)); };
      const mk = new maplibregl.Marker({ element: d, draggable: true }).setLngLat(pt).addTo(m);
      mk.on('dragend', () => { const p = mk.getLngLat(); setRing((r) => r.map((x, k) => (k === i ? [p.lng, p.lat] : x))); });
      return mk;
    });
  }, [ring]);

  // enquadra geometria inicial
  useEffect(() => {
    const m = map.current;
    if (!m || ring.length < 3) return;
    const b = new maplibregl.LngLatBounds();
    ring.forEach((p) => b.extend(p));
    m.fitBounds(b, { padding: 60, maxZoom: 16, duration: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const poly = ring.length >= 3 ? { type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: [[...ring, ring[0]]] }, properties: {} } : null;
  const area = poly ? turfArea(poly) : 0;
  const perim = poly ? turfLength({ type: 'Feature', geometry: { type: 'LineString', coordinates: [...ring, ring[0]] }, properties: {} }, { units: 'meters' }) : 0;

  const importFile = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const j = await api<{ geojson: any; source: string }>(importUrl, { form: fd });
    const r2 = ringFrom(j.geojson);
    if (r2.length < 3) throw new Error('Nenhum polígono encontrado no arquivo');
    setRing(r2);
    setSource(j.source);
    setDrawing(false);
    const m = map.current!;
    const b = new maplibregl.LngLatBounds();
    r2.forEach((p) => b.extend(p));
    m.fitBounds(b, { padding: 60, maxZoom: 16 });
    return j.geojson;
  };
  const [importErr, setImportErr] = useState('');
  const [imported, setImported] = useState<any>(null);

  return (
    <div className="stack">
      <div className="draw-map">
        <div ref={el} className="map" />
        <div className="draw-tools">
          <button type="button" className={`btn small ${drawing ? 'gold' : ''}`} onClick={() => { if (!drawing) { setRing([]); setSource('draw'); setImported(null); } setDrawing(!drawing); }}>
            {drawing ? 'Concluir desenho' : ring.length ? 'Redesenhar perímetro' : 'Desenhar perímetro'}
          </button>
          {ring.length > 0 && !drawing && <button type="button" className="btn small ghost" style={{ background: '#f8f9f5' }} onClick={() => { setRing([]); setImported(null); }}>Limpar</button>}
        </div>
      </div>
      <div className="spread">
        <div className="row small">
          {drawing && <span className="badge warn">Clique no mapa para marcar os vértices; clique duplo para concluir.</span>}
          {poly && <span><b className="wide">{formatArea(area)}</b> <span className="muted">· perímetro {Math.round(perim).toLocaleString('pt-BR')} m · cálculo geodésico</span></span>}
        </div>
        <div className="row">
          <label className="btn ghost small">
            Importar KML, KMZ, GeoJSON ou SHP (.zip)
            <input type="file" accept=".kml,.kmz,.geojson,.json,.zip" className="sr-only" onChange={async (e) => {
              const f = e.target.files?.[0]; e.target.value = '';
              if (!f) return;
              setImportErr('');
              try { setImported(await importFile(f)); } catch (err: any) { setImportErr(err.message); }
            }} />
          </label>
          <button type="button" className="btn small" disabled={!poly || saving || drawing} onClick={() => onSave(imported && source !== 'draw' ? imported : poly!.geometry, source)}>
            {saving ? 'Salvando…' : 'Salvar perímetro'}
          </button>
        </div>
      </div>
      {importErr && <p className="error-text">{importErr}</p>}
      {imported && source !== 'draw' && <p className="small muted">Arquivo importado. Ao salvar, todos os polígonos do arquivo são unidos e validados no PostGIS. Editar vértices converte em desenho manual.</p>}
    </div>
  );
}

function ringFrom(g: any): Ring {
  if (!g) return [];
  if (g.type === 'FeatureCollection') return ringFrom(g.features.find((f: any) => /Polygon/.test(f.geometry?.type))?.geometry);
  if (Array.isArray(g)) return ringFrom(g[0]);
  if (g.type === 'Feature') return ringFrom(g.geometry);
  if (g.type === 'GeometryCollection') return ringFrom(g.geometries.find((x: any) => /Polygon/.test(x.type)));
  const coords = g.type === 'MultiPolygon' ? g.coordinates[0]?.[0] : g.type === 'Polygon' ? g.coordinates[0] : null;
  if (!coords) return [];
  const r = coords.map((c: number[]) => [c[0], c[1]] as [number, number]);
  if (r.length > 1 && r[0][0] === r.at(-1)![0] && r[0][1] === r.at(-1)![1]) r.pop();
  return r;
}
