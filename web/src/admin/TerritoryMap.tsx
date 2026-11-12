import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap } from 'maplibre-gl';
import area from '@turf/area';
import length from '@turf/length';
import { LAND_TYPES, TERRITORY_LAYERS, TERRITORY_LAYER_KEYS, UFS, VIABILITY, formatArea, parseCoordinates, type TerritoryLayer } from '@dl/shared';
import { api, DEMO, downloadFile, qs } from '../lib/api';
import { addSatellite, baseStyle, CITIES, HAS_SATELLITE, setSatelliteVisible } from '../components/MapView';
import { Field, Modal, useToast } from '../components/ui';
import { PageHeader } from './Shell';

type Layer = TerritoryLayer;
const MIN_ZOOM = 12;
const GROUP_LABEL: Record<string, string> = { parcel: 'Imóveis', environment: 'Ambiental (CAR)', restriction: 'Restrições' };
const EMPTY = { type: 'FeatureCollection', features: [] } as any;

/** Prospecção: explorar parcelas oficiais, identificar matrícula/cartório e abrir uma prospecção com o perímetro. */
export default function TerritoryMap() {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const nav = useNavigate();
  const toast = useToast();
  const [status, setStatus] = useState<any>(null);
  const [uf, setUf] = useState('GO');
  const [layers, setLayers] = useState<Partial<Record<Layer, boolean>>>({ sigef: true, snci: true, car: true });
  const [sat, setSat] = useState(HAS_SATELLITE);
  const [tab, setTab] = useState<'explorar' | 'radar'>('explorar');
  const [results, setResults] = useState<any>(null);
  const [measuring, setMeasuring] = useState(false);
  const [mPoints, setMPoints] = useState<number[][]>([]);
  const measuringRef = useRef(measuring); measuringRef.current = measuring;
  const [info, setInfo] = useState<{ zoom: number; counts: Record<string, number>; loading: boolean; error?: string }>({ zoom: 0, counts: {}, loading: false });
  const [pick, setPick] = useState<any>(null);
  const [create, setCreate] = useState<any>(null);
  const [goto, setGoto] = useState('');
  const ufRef = useRef(uf); ufRef.current = uf;
  const layersRef = useRef(layers); layersRef.current = layers;

  useEffect(() => { api('/api/territory/layers').then(setStatus).catch(() => {}); }, []);

  const load = async () => {
    const m = map.current;
    if (!m) return;
    const z = m.getZoom();
    if (z < MIN_ZOOM) { setInfo({ zoom: z, counts: {}, loading: false }); TERRITORY_LAYER_KEYS.forEach((l) => (m.getSource(l) as any)?.setData(EMPTY)); return; }
    const b = m.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(',');
    setInfo((s) => ({ ...s, zoom: z, loading: true, error: undefined }));
    const counts: Record<string, number> = {};
    for (const l of TERRITORY_LAYER_KEYS) {
      if (!layersRef.current[l]) { (m.getSource(l) as any)?.setData(EMPTY); continue; }
      try {
        const r = await api(`/api/territory/features${qs({ layer: l, bbox, uf: ufRef.current })}`);
        (m.getSource(l) as any)?.setData({ type: 'FeatureCollection', features: r.features });
        counts[l] = r.features.length;
      } catch (e: any) { setInfo((s) => ({ ...s, error: e.message })); }
    }
    setInfo({ zoom: z, counts, loading: false });
  };

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({ container: el.current, style: baseStyle(), center: [-49.45, -16.6], zoom: 9, dragRotate: false });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.on('load', async () => {
      for (const [name, lng, lat] of CITIES) {
        const d = document.createElement('div');
        d.style.cssText = 'font: 500 11px var(--font); color:#6e6e6a; pointer-events:none; white-space:nowrap';
        d.textContent = `• ${name}`;
        new maplibregl.Marker({ element: d, anchor: 'left' }).setLngLat([lng, lat]).addTo(m);
      }
      addSatellite(m);
      setSatelliteVisible(m, HAS_SATELLITE);
      // de baixo para cima: restrições e ambientais por baixo, parcelas por cima
      for (const k of [...TERRITORY_LAYER_KEYS].reverse()) {
        const meta = TERRITORY_LAYERS[k];
        m.addSource(k, { type: 'geojson', data: EMPTY });
        m.addLayer({ id: `${k}-fill`, type: 'fill', source: k, paint: { 'fill-color': meta.color, 'fill-opacity': meta.group === 'parcel' ? 0.08 : 0.3 } });
        m.addLayer({ id: `${k}-line`, type: 'line', source: k, paint: { 'line-color': meta.color, 'line-width': meta.group === 'parcel' ? 1.5 : 1, ...(k === 'car' ? { 'line-dasharray': [3, 2] } : {}) } });
      }
      m.addSource('measure', { type: 'geojson', data: EMPTY });
      m.addSource('pick', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addSource('own', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'pick-fill', type: 'fill', source: 'pick', paint: { 'fill-color': '#f8b817', 'fill-opacity': 0.35 } });
      m.addLayer({ id: 'pick-line', type: 'line', source: 'pick', paint: { 'line-color': '#f8b817', 'line-width': 3 } });
      m.addLayer({ id: 'measure-fill', type: 'fill', source: 'measure', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.2 } });
      m.addLayer({ id: 'measure-line', type: 'line', source: 'measure', paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-dasharray': [2, 1] } });
      m.addLayer({ id: 'measure-pt', type: 'circle', source: 'measure', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': '#0a0a0a', 'circle-stroke-width': 1.5 } });
      // prospecções já abertas (evita captação duplicada)
      try {
        const r = await api('/api/prospects?status=open,converted');
        const feats = r.items.filter((p: any) => (p.c_lat ?? p.lat) != null).map((p: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.c_lng ?? p.lng, p.c_lat ?? p.lat] }, properties: { id: p.id, code: p.code, title: p.title } }));
        for (const f of feats) {
          const d = document.createElement('button');
          d.type = 'button';
          d.textContent = f.properties.code.replace('CAP-', '');
          d.title = `${f.properties.code} — ${f.properties.title}`;
          d.style.cssText = 'padding:2px 6px;border-radius:3px;background:#0a0a0a;color:#f8b817;border:2px solid #f8b817;font:700 11px var(--font);cursor:pointer';
          d.onclick = (ev) => { ev.stopPropagation(); nav(`/painel/captacao/${f.properties.id}`); };
          new maplibregl.Marker({ element: d }).setLngLat(f.geometry.coordinates as [number, number]).addTo(m);
        }
      } catch { /* sem permissão */ }
      void load();
    });
    m.on('moveend', () => void load());
    m.on('click', async (e) => {
      if (measuringRef.current) { setMPoints((p) => [...p, [e.lngLat.lng, e.lngLat.lat]]); return; }
      if (m.getZoom() < MIN_ZOOM) { m.easeTo({ center: e.lngLat, zoom: MIN_ZOOM + 0.5 }); return; }
      setPick({ loading: true, lat: e.lngLat.lat, lng: e.lngLat.lng });
      try {
        const r = await api(`/api/territory/lookup${qs({ lat: e.lngLat.lat.toFixed(6), lng: e.lngLat.lng.toFixed(6), uf: ufRef.current })}`);
        setPick(r);
        (m.getSource('pick') as any).setData({ type: 'FeatureCollection', features: r.parcels.filter((p: any) => p.geometry).slice(0, 1) });
      } catch (err: any) { setPick({ error: err.message }); }
    });
    m.on('mousemove', (e) => {
      if (measuringRef.current) { m.getCanvas().style.cursor = 'crosshair'; return; }
      const ids = TERRITORY_LAYER_KEYS.filter((k) => TERRITORY_LAYERS[k].group === 'parcel').map((k) => `${k}-fill`).filter((id) => m.getLayer(id));
      m.getCanvas().style.cursor = ids.length && m.queryRenderedFeatures(e.point, { layers: ids }).length ? 'pointer' : '';
    });
    return () => m.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [layers, uf]);

  useEffect(() => { const m = map.current; if (m?.isStyleLoaded()) setSatelliteVisible(m, sat); }, [sat]);

  // medição: distância da linha e área do polígono, com turf (geodésico)
  useEffect(() => {
    const src = map.current?.getSource('measure') as any;
    if (!src) return;
    const pts = mPoints.map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} }));
    const line = mPoints.length >= 2 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: mPoints }, properties: {} }] : [];
    const poly = mPoints.length >= 3 ? [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...mPoints, mPoints[0]]] }, properties: {} }] : [];
    src.setData({ type: 'FeatureCollection', features: [...poly, ...line, ...pts] });
  }, [mPoints]);
  const mDist = mPoints.length >= 2 ? length({ type: 'Feature', geometry: { type: 'LineString', coordinates: mPoints }, properties: {} } as any, { units: 'meters' }) : 0;
  const mArea = mPoints.length >= 3 ? area({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...mPoints, mPoints[0]]] }, properties: {} } as any) : 0;

  const fitFeature = (f: any) => {
    const m = map.current; if (!m) return;
    (m.getSource('pick') as any)?.setData({ type: 'FeatureCollection', features: [f] });
    if (f.bbox) m.fitBounds([[f.bbox[0], f.bbox[1]], [f.bbox[2], f.bbox[3]]], { padding: 80, maxZoom: 16 });
    else if (f.center) m.flyTo({ center: f.center, zoom: 14 });
  };
  const go = async () => {
    const m = map.current; if (!m || !goto.trim()) return;
    setResults(null);
    const c = parseCoordinates(goto);
    if (c) { m.flyTo({ center: [c.lng, c.lat], zoom: 15 }); return; }
    const city = CITIES.find(([n]) => n.toLowerCase() === goto.trim().toLowerCase());
    if (city) { m.flyTo({ center: [city[1], city[2]], zoom: 12.5 }); return; }
    if (DEMO) { toast('Na demonstração, busque por cidade da lista ou coordenadas: -16.68, -49.25', true); return; }
    try {
      const r = await api(`/api/territory/search${qs({ q: goto.trim(), uf })}`);
      if (r.features.length === 1 && !r.internal.length) { fitFeature(r.features[0]); return; }
      setResults(r);
    } catch (e: any) { toast(e.message, true); }
  };
  const choose = (f: any) => { (map.current?.getSource('pick') as any)?.setData({ type: 'FeatureCollection', features: [f] }); setPick({ ...pick, chosen: f }); };

  const mode = status?.mode;
  const available: any[] = (status?.layers ?? []).filter((l: any) => l.status !== 'pending');
  const pending: any[] = (status?.layers ?? []).filter((l: any) => l.status === 'pending');
  return (
    <>
      <PageHeader title="Prospecção no mapa">
        <Link to="/painel/captacao" className="btn ghost">Funil de captação</Link>
      </PageHeader>
      {mode === 'demo' && <p className="notice" style={{ marginTop: '-0.5rem' }}>Modo demonstração: as parcelas SIGEF e CAR e a consulta registral são <b>fictícias</b>, geradas para testar o fluxo. Em produção, os dados vêm dos serviços oficiais configurados.</p>}
      <div className="territory">
        <div className="territory-map">
          <div ref={el} className="map" />
          <div className="map-legend">
            {available.filter((l) => layers[l.key as Layer]).map((l) => <span key={l.key}><i style={{ border: `2px solid ${TERRITORY_LAYERS[l.key as Layer].color}` }} />{TERRITORY_LAYERS[l.key as Layer].short}</span>)}
            <span><i style={{ background: '#0a0a0a', border: '2px solid #f8b817' }} />Prospecção já aberta</span>
          </div>
          <div className="map-tools">
            {HAS_SATELLITE && <div className="seg" role="group" aria-label="Mapa base">
              <button type="button" aria-pressed={sat} onClick={() => setSat(true)}>Satélite</button>
              <button type="button" aria-pressed={!sat} onClick={() => setSat(false)}>Mapa</button>
            </div>}
            <button type="button" className="btn small" style={{ background: measuring ? 'var(--gold)' : '#fff', color: '#0a0a0a' }} aria-pressed={measuring} onClick={() => { setMeasuring(!measuring); setMPoints([]); }}>{measuring ? 'Encerrar medição' : 'Medir'}</button>
          </div>
          {measuring && <div className="map-measure" role="status">
            {mPoints.length === 0 ? 'Clique no mapa para marcar os pontos' : <>Distância: <b>{mDist >= 1000 ? `${(mDist / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} km` : `${Math.round(mDist).toLocaleString('pt-BR')} m`}</b>{mArea > 0 && <> · Área: <b>{formatArea(mArea)}</b></>}</>}
            {mPoints.length > 0 && <button type="button" className="btn link small" onClick={() => setMPoints([])}>Limpar</button>}
          </div>}
          {info.zoom < MIN_ZOOM && <div className="map-hint">Aproxime o mapa (ou clique) para carregar as parcelas</div>}
        </div>
        <aside className="territory-side">
          {!DEMO && <div className="seg wide" role="tablist" aria-label="Modo">
            <button type="button" role="tab" aria-selected={tab === 'explorar'} aria-pressed={tab === 'explorar'} onClick={() => setTab('explorar')}>Explorar</button>
            <button type="button" role="tab" aria-selected={tab === 'radar'} aria-pressed={tab === 'radar'} onClick={() => setTab('radar')}>Radar de captação</button>
          </div>}
          {tab === 'radar' && <Radar uf={uf} setUf={setUf} onShow={fitFeature} onCreate={(f) => setCreate({
            title: f.properties.nome || `Área em ${f.properties.municipio ?? uf}`, uf: f.properties.uf ?? uf, city: f.properties.municipio ?? '', land_type: 'gleba', intended_uses: [], geojson: f.geometry, area: f.properties.area_ha,
            territory: [{ layer: f.properties.layer, source: f.properties.fonte, consulted_at: new Date().toISOString(), properties: f.properties }], registry: null, lat: f.center?.[1], lng: f.center?.[0],
          })} />}
          {tab === 'explorar' && <>
          <div className="stack-s">
            <div className="row">
              <select className="input" style={{ width: 80 }} value={uf} onChange={(e) => setUf(e.target.value)} aria-label="UF">{UFS.map((u) => <option key={u}>{u}</option>)}</select>
              <form className="row" style={{ flex: 1, flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); void go(); }}>
                <input className="input" placeholder={DEMO ? 'Cidade ou coordenadas' : 'CAR, certificação, matrícula, nome, coordenadas'} value={goto} onChange={(e) => setGoto(e.target.value)} aria-label="Localizar" />
                <button className="btn small">Ir</button>
              </form>
            </div>
            {!DEMO && <span className="small muted">Coordenadas: -16.68, -49.25 · 16°40'48"S 49°15'00"W · 22 683000 8155000</span>}
            {results && <div className="stack-s">
              {results.features.length + results.internal.length === 0 && <p className="small">Nada encontrado nas bases carregadas.</p>}
              {results.internal.map((x: any) => <Link key={x.id} className="parcel-card" to={x.kind === 'prospect' ? `/painel/captacao/${x.id}` : `/painel/areas/${x.id}`}><b>{x.code}</b><span className="small">{x.title}</span><span className="small muted">{x.city ?? '—'}/{x.uf ?? '—'}</span></Link>)}
              {results.features.map((f: any) => <button type="button" key={f.id} className="parcel-card" onClick={() => fitFeature(f)}><b>{TERRITORY_LAYERS[f.properties.layer as Layer]?.short}</b><span className="small">{f.properties.nome ?? '—'}</span><span className="small muted" style={{ wordBreak: 'break-all' }}>{f.properties.codigo}</span><span className="small">{f.properties.municipio ?? ''}{f.properties.area_ha != null ? ` · ${f.properties.area_ha.toLocaleString('pt-BR')} ha` : ''}</span></button>)}
            </div>}
            {['parcel', 'environment', 'restriction'].map((g) => {
              const items = available.filter((l) => (l.group ?? TERRITORY_LAYERS[l.key as Layer]?.group) === g);
              if (!items.length) return null;
              return <div key={g} className="stack-s"><span className="small muted"><b>{GROUP_LABEL[g]}</b></span>
                {items.map((l) => (
                  <label key={l.key} className="check small"><input type="checkbox" checked={!!layers[l.key as Layer]} onChange={(e) => setLayers({ ...layers, [l.key]: e.target.checked })} />
                    <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: TERRITORY_LAYERS[l.key as Layer].color, marginRight: 5 }} />{TERRITORY_LAYERS[l.key as Layer].label}
                      {info.counts[l.key] != null && <span className="muted"> · {info.counts[l.key]} no recorte</span>}
                      {l.status === 'simulated' && <span className="badge warn" style={{ marginLeft: 6 }}>simulado</span>}
                      {l.ufs?.length > 0 && <span className="muted"> · {l.ufs.join(', ')}</span>}
                    </span>
                  </label>
                ))}</div>;
            })}
            {!DEMO && pending.length > 0 && <details className="small"><summary>{pending.length} bases ainda não carregadas</summary>
              <ul style={{ margin: '0.3rem 0 0', paddingLeft: '1.1rem' }}>{pending.map((l) => <li key={l.key}><a href={l.official_url} target="_blank" rel="noopener noreferrer">{TERRITORY_LAYERS[l.key as Layer]?.label ?? l.name}</a></li>)}</ul>
            </details>}
            {info.loading && <span className="small muted">Carregando parcelas…</span>}
            {info.error && <span className="error-text">{info.error}</span>}
          </div>

          {!pick && <p className="muted small">Clique sobre uma parcela para ver código, área, matrícula e cartório, consultar o registro e abrir uma prospecção com o perímetro.</p>}
          {pick?.loading && <p className="muted">Consultando o ponto…</p>}
          {pick?.error && <p className="error-text">{pick.error}</p>}
          {pick && !pick.loading && !pick.error && (
            <div className="stack-s">
              <span className="small muted">Ponto {pick.lat.toFixed(5)}, {pick.lng.toFixed(5)}</span>
              {pick.existing?.length > 0 && (
                <div className="notice">Já existe no sistema: {pick.existing.map((x: any) => <Link key={x.id} to={x.kind === 'prospect' ? `/painel/captacao/${x.id}` : `/painel/areas/${x.id}`} style={{ marginRight: 8 }}>{x.code}</Link>)}</div>
              )}
              {pick.parcels.filter((p: any) => p.properties).length === 0 && <p className="small">Nenhuma parcela das camadas ativas contém este ponto.</p>}
              {pick.parcels.filter((p: any) => p.properties).map((p: any, i: number) => {
                const pr = p.properties;
                const chosen = pick.chosen === p || (!pick.chosen && i === 0);
                return (
                  <button type="button" key={i} className={`parcel-card ${chosen ? 'on' : ''}`} onClick={() => choose(p)}>
                    <span className="row" style={{ justifyContent: 'space-between' }}><b>{TERRITORY_LAYERS[pr.layer as Layer]?.short ?? pr.layer}</b>{pr.ficticio && <span className="badge warn">fictício</span>}</span>
                    {pr.nome && <span>{pr.nome}</span>}
                    <span className="small muted" style={{ wordBreak: 'break-all' }}>{pr.codigo}</span>
                    <span className="small">{pr.area_ha != null ? `${pr.area_ha.toLocaleString('pt-BR')} ha` : ''}{pr.situacao ? ` · ${pr.situacao}` : ''}</span>
                    {pr.matricula && <span className="small">Matrícula {pr.matricula}{pr.cns_serventia ? ` · CNS ${pr.cns_serventia}` : ''}</span>}
                    {pr.municipio && <span className="small muted">{pr.municipio}{pr.uf ? `/${pr.uf}` : ''}</span>}
                    {pr.id != null && <span className="row" style={{ marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
                      <span role="button" tabIndex={0} className="btn ghost small" onClick={() => void downloadFile(`/api/territory/features/${pr.id}/kml`, `${pr.layer}-${pr.id}.kml`).catch((x) => toast(x.message, true))}>KML</span>
                      <span role="button" tabIndex={0} className="btn ghost small" onClick={() => void downloadFile(`/api/territory/features/${pr.id}/dxf`, `${pr.layer}-${pr.id}.dxf`).catch((x) => toast(x.message, true))}>DXF</span>
                      <span role="button" tabIndex={0} className="btn ghost small" onClick={() => void navigator.clipboard?.writeText(pr.codigo).then(() => toast('Código copiado'))}>Copiar código</span>
                    </span>}
                  </button>
                );
              })}
              <div className="panel" style={{ padding: '0.7rem 0.8rem', background: 'var(--paper)' }}>
                <b className="small">Registro de Imóveis (Mapa ONR)</b>
                {pick.registry && !pick.registry.error ? (
                  <div className="small" style={{ marginTop: 4 }}>
                    {pick.registry.cartorio && <div>{pick.registry.cartorio}</div>}
                    {pick.registry.matriculas?.length > 0 && <div>Matrícula(s): {pick.registry.matriculas.join(', ')}</div>}
                    <div className="muted">{pick.registry.source}{pick.registry.consulted_at ? ` · ${new Date(pick.registry.consulted_at).toLocaleDateString('pt-BR')}` : ''}</div>
                  </div>
                ) : <p className="small muted" style={{ margin: '4px 0 0' }}>{pick.registry?.error ?? 'Consulta automática indisponível: sem provedor contratado. Consulte o Mapa do Registro de Imóveis pelo código acima.'}</p>}
                <div className="row" style={{ marginTop: 6 }}>
                  <a className="btn ghost small" href={pick.links.onr} target="_blank" rel="noopener noreferrer">Abrir Mapa ONR</a>
                  <a className="btn ghost small" href={pick.links.earth} target="_blank" rel="noopener noreferrer">Google Earth</a>
                </div>
              </div>
              <button className="btn gold" onClick={() => {
                const parcel = pick.chosen ?? pick.parcels.find((p: any) => p.properties);
                setCreate({
                  title: parcel?.properties?.nome ? `${parcel.properties.nome}` : `Área em ${pick.lat.toFixed(3)}, ${pick.lng.toFixed(3)}`, uf, city: '', land_type: 'gleba', intended_uses: [],
                  geojson: parcel?.geometry ?? null, area: parcel?.properties?.area_ha,
                  territory: pick.parcels.filter((p: any) => p.properties).map((p: any) => ({ layer: p.properties.layer, source: p.properties.fonte, consulted_at: p.consulted_at, properties: p.properties })),
                  registry: pick.registry && !pick.registry.error ? pick.registry : null, lat: pick.lat, lng: pick.lng,
                });
              }}>Criar prospecção {pick.parcels.some((p: any) => p.properties) ? 'com este perímetro' : 'neste ponto'}</button>
            </div>
          )}
          </>}
        </aside>
      </div>
      {create && <CreateProspect init={create} onClose={() => setCreate(null)} onCreated={(id) => nav(`/painel/captacao/${id}`)} />}
    </>
  );
}

/** Radar: encontra parcelas candidatas por critério ou a partir de um perfil de aquisição. */
function Radar({ uf, setUf, onShow, onCreate }: { uf: string; setUf: (u: string) => void; onShow: (f: any) => void; onCreate: (f: any) => void }) {
  const [f, setF] = useState({ municipio: '', min_ha: '', max_ha: '', layer: 'sigef', exclude_restrictions: true, profile_id: '' });
  const [profiles, setProfiles] = useState<any[]>([]);
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api('/api/profiles').then((r) => setProfiles(r.items ?? [])).catch(() => {}); }, []);
  const run = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      setRes(await api(`/api/territory/radar${qs({ uf: f.profile_id ? undefined : uf, municipio: f.municipio, min_ha: f.min_ha, max_ha: f.max_ha, layer: f.layer, exclude_restrictions: f.exclude_restrictions ? '1' : '0', profile_id: f.profile_id })}`));
    } catch (x: any) { setErr(x.message); }
    setBusy(false);
  };
  return (
    <form className="stack-s" onSubmit={run}>
      <p className="small muted" style={{ margin: 0 }}>Encontre imóveis que atendem a um critério e ainda não estão no sistema. Ser candidato não significa estar à venda.</p>
      {profiles.length > 0 && <Field label="Partir de um perfil de aquisição"><select value={f.profile_id} onChange={(e) => setF({ ...f, profile_id: e.target.value })}><option value="">Nenhum (critérios abaixo)</option>{profiles.map((p) => <option key={p.id} value={p.id}>{p.name}{p.partner_name ? ` — ${p.partner_name}` : ''}</option>)}</select></Field>}
      <div className="grid2">
        <Field label="UF"><select value={uf} onChange={(e) => setUf(e.target.value)} disabled={!!f.profile_id}>{UFS.map((u) => <option key={u}>{u}</option>)}</select></Field>
        <Field label="Base"><select value={f.layer} onChange={(e) => setF({ ...f, layer: e.target.value })}><option value="sigef">SIGEF</option><option value="snci">SNCI</option><option value="car">CAR</option></select></Field>
      </div>
      <Field label="Município"><input value={f.municipio} onChange={(e) => setF({ ...f, municipio: e.target.value })} /></Field>
      <div className="grid2">
        <Field label="De (ha)"><input inputMode="decimal" value={f.min_ha} onChange={(e) => setF({ ...f, min_ha: e.target.value })} /></Field>
        <Field label="Até (ha)"><input inputMode="decimal" value={f.max_ha} onChange={(e) => setF({ ...f, max_ha: e.target.value })} /></Field>
      </div>
      <label className="check small"><input type="checkbox" checked={f.exclude_restrictions} onChange={(e) => setF({ ...f, exclude_restrictions: e.target.checked })} /> Excluir sobreposição com restrições carregadas</label>
      <button className="btn gold" disabled={busy}>{busy ? 'Buscando…' : 'Buscar candidatas'}</button>
      {err && <p className="error-text">{err}</p>}
      {res && !res.loaded && <p className="notice" style={{ margin: 0 }}>A base {f.layer.toUpperCase()} de {res.filter?.uf} ainda não foi carregada. Veja o manual de publicação.</p>}
      {res?.loaded && <>
        <p className="small muted" style={{ margin: 0 }}><b>{res.items.length}{res.items.length === 100 ? '+' : ''}</b> candidatas. Fonte: {res.source}, base de {new Date(res.loaded_at).toLocaleDateString('pt-BR')}. {res.restrictions_checked.length ? `Restrições conferidas: ${res.restrictions_checked.map((k: Layer) => TERRITORY_LAYERS[k].short).join(', ')}.` : 'Nenhuma base de restrição carregada para esta UF.'}</p>
        {res.items.map((c: any) => (
          <div key={c.id} className="parcel-card" style={{ cursor: 'default' }}>
            <span className="row" style={{ justifyContent: 'space-between' }}><b>{c.properties.nome ?? c.properties.codigo}</b>{c.demand_count > 0 && <span className="badge ok">{c.demand_count} comprador(es)</span>}</span>
            <span className="small">{c.properties.municipio ?? '—'} · {c.properties.area_ha?.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ha</span>
            {c.demand?.[0] && <span className="small muted">{c.demand[0].partner}: {c.demand[0].profile}</span>}
            <span className="row" style={{ marginTop: 4 }}>
              <button type="button" className="btn ghost small" onClick={() => onShow(c)}>Ver no mapa</button>
              <button type="button" className="btn gold small" onClick={() => onCreate(c)}>Criar prospecção</button>
            </span>
          </div>
        ))}
      </>}
    </form>
  );
}

export function CreateProspect({ init, onClose, onCreated }: { init: any; onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState<any>(init);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const tog = (v: string) => setF({ ...f, intended_uses: f.intended_uses.includes(v) ? f.intended_uses.filter((x: string) => x !== v) : [...f.intended_uses, v] });
  return (
    <Modal title="Nova prospecção" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        try {
          const p = await api('/api/prospects', { body: { title: f.title, source: f.source ?? 'mapa_territorial', land_type: f.land_type, uf: f.uf, city: f.city || null, lat: f.lat ?? null, lng: f.lng ?? null,
            geojson: f.geojson ?? undefined, territory: f.territory ?? [], registry: f.registry ?? null, owner_name: f.owner_name || null, owner_phone: f.owner_phone || null, intended_uses: f.intended_uses, notes: f.notes } });
          onCreated(p.id);
        } catch (er: any) { setErr(er.message); setBusy(false); }
      }}>
        {f.geojson && <p className="notice ok" style={{ margin: 0 }}>Perímetro da parcela selecionada{f.area ? ` (${f.area.toLocaleString('pt-BR')} ha)` : ''} e dados de origem serão gravados com fonte e data.</p>}
        <Field label="Nome da prospecção"><input required minLength={3} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <div className="grid3">
          <Field label="UF"><select value={f.uf} onChange={(e) => setF({ ...f, uf: e.target.value })}>{UFS.map((u) => <option key={u}>{u}</option>)}</select></Field>
          <Field label="Cidade"><input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
          <Field label="Tipo"><select value={f.land_type} onChange={(e) => setF({ ...f, land_type: e.target.value })}>{Object.entries(LAND_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="small" style={{ color: 'var(--ink-2)', marginBottom: 4 }}>Potencial de uso (hipótese da captação)</legend>
          <div className="chips">{Object.entries(VIABILITY).map(([k, l]) => <button type="button" key={k} className="chip" aria-pressed={f.intended_uses.includes(k)} onClick={() => tog(k)}>{l}</button>)}</div></fieldset>
        <div className="grid2">
          <Field label="Proprietário (se souber)"><input value={f.owner_name ?? ''} onChange={(e) => setF({ ...f, owner_name: e.target.value })} /></Field>
          <Field label="Telefone"><input value={f.owner_phone ?? ''} onChange={(e) => setF({ ...f, owner_phone: e.target.value })} /></Field>
        </div>
        <Field label="Observações"><textarea value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} style={{ minHeight: 60 }} /></Field>
        {err && <p className="error-text">{err}</p>}
        <div className="row"><button className="btn gold" disabled={busy}>{busy ? 'Criando…' : 'Criar prospecção'}</button><button type="button" className="btn ghost" onClick={onClose}>Cancelar</button></div>
        <span className="small muted">{f.geojson ? formatArea((f.area ?? 0) * 10000) : 'Sem perímetro: você poderá desenhar depois.'}</span>
      </form>
    </Modal>
  );
}
