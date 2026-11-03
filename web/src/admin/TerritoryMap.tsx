import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap } from 'maplibre-gl';
import { LAND_TYPES, UFS, VIABILITY, formatArea, earthUrl } from '@dl/shared';
import { api, qs } from '../lib/api';
import { baseStyle, CITIES } from '../components/MapView';
import { Field, Modal, useToast } from '../components/ui';
import { PageHeader } from './Shell';

type Layer = 'sigef' | 'car';
const LAYER_LABEL: Record<Layer, string> = { sigef: 'Imóveis certificados (SIGEF/INCRA)', car: 'Cadastro Ambiental Rural (CAR)' };
const MIN_ZOOM = 12;

/** Prospecção: explorar parcelas oficiais, identificar matrícula/cartório e abrir uma prospecção com o perímetro. */
export default function TerritoryMap() {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const nav = useNavigate();
  const toast = useToast();
  const [status, setStatus] = useState<any>(null);
  const [uf, setUf] = useState('GO');
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ sigef: true, car: true });
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
    if (z < MIN_ZOOM) { setInfo({ zoom: z, counts: {}, loading: false }); (['sigef', 'car'] as Layer[]).forEach((l) => (m.getSource(l) as any)?.setData({ type: 'FeatureCollection', features: [] })); return; }
    const b = m.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(',');
    setInfo((s) => ({ ...s, zoom: z, loading: true, error: undefined }));
    const counts: Record<string, number> = {};
    for (const l of ['sigef', 'car'] as Layer[]) {
      if (!layersRef.current[l]) { (m.getSource(l) as any)?.setData({ type: 'FeatureCollection', features: [] }); continue; }
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
      m.addSource('sigef', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addSource('car', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addSource('pick', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addSource('own', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'car-fill', type: 'fill', source: 'car', paint: { 'fill-color': '#2f7d4f', 'fill-opacity': 0.06 } });
      m.addLayer({ id: 'car-line', type: 'line', source: 'car', paint: { 'line-color': '#2f7d4f', 'line-width': 1.2, 'line-dasharray': [3, 2] } });
      m.addLayer({ id: 'sigef-fill', type: 'fill', source: 'sigef', paint: { 'fill-color': '#0a0a0a', 'fill-opacity': 0.05 } });
      m.addLayer({ id: 'sigef-line', type: 'line', source: 'sigef', paint: { 'line-color': '#0a0a0a', 'line-width': 1.3 } });
      m.addLayer({ id: 'pick-fill', type: 'fill', source: 'pick', paint: { 'fill-color': '#f8b817', 'fill-opacity': 0.35 } });
      m.addLayer({ id: 'pick-line', type: 'line', source: 'pick', paint: { 'line-color': '#0a0a0a', 'line-width': 3 } });
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
      if (m.getZoom() < MIN_ZOOM) { m.easeTo({ center: e.lngLat, zoom: MIN_ZOOM + 0.5 }); return; }
      setPick({ loading: true, lat: e.lngLat.lat, lng: e.lngLat.lng });
      try {
        const r = await api(`/api/territory/lookup${qs({ lat: e.lngLat.lat.toFixed(6), lng: e.lngLat.lng.toFixed(6), uf: ufRef.current })}`);
        setPick(r);
        (m.getSource('pick') as any).setData({ type: 'FeatureCollection', features: r.parcels.filter((p: any) => p.geometry).slice(0, 1) });
      } catch (err: any) { setPick({ error: err.message }); }
    });
    m.on('mousemove', (e) => { m.getCanvas().style.cursor = m.queryRenderedFeatures(e.point, { layers: ['sigef-fill', 'car-fill'] }).length ? 'pointer' : ''; });
    return () => m.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [layers, uf]);

  const go = () => {
    const m = map.current; if (!m) return;
    const c = goto.match(/(-?\d+[.,]\d+)\s*[,; ]\s*(-?\d+[.,]\d+)/);
    if (c) { m.flyTo({ center: [Number(c[2].replace(',', '.')), Number(c[1].replace(',', '.'))], zoom: 14 }); return; }
    const city = CITIES.find(([n]) => n.toLowerCase().startsWith(goto.trim().toLowerCase()));
    if (city) m.flyTo({ center: [city[1], city[2]], zoom: 12.5 }); else toast('Cidade não encontrada na lista. Use coordenadas: -16.68, -49.25', true);
  };
  const choose = (f: any) => { (map.current?.getSource('pick') as any)?.setData({ type: 'FeatureCollection', features: [f] }); setPick({ ...pick, chosen: f }); };

  const mode = status?.mode;
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
            <span><i style={{ border: '2px solid #0a0a0a' }} />SIGEF/INCRA — imóvel certificado</span>
            <span><i style={{ border: '1.5px dashed #2f7d4f' }} />CAR — imóvel cadastrado</span>
            <span><i style={{ background: '#0a0a0a', border: '2px solid #f8b817' }} />Prospecção já aberta</span>
          </div>
          {info.zoom < MIN_ZOOM && <div className="map-hint">Aproxime o mapa (ou clique) para carregar as parcelas</div>}
        </div>
        <aside className="territory-side">
          <div className="stack-s">
            <div className="row">
              <select className="input" style={{ width: 80 }} value={uf} onChange={(e) => setUf(e.target.value)} aria-label="UF">{UFS.map((u) => <option key={u}>{u}</option>)}</select>
              <form className="row" style={{ flex: 1, flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); go(); }}>
                <input className="input" placeholder="Cidade ou coordenadas" value={goto} onChange={(e) => setGoto(e.target.value)} aria-label="Ir para" />
                <button className="btn small">Ir</button>
              </form>
            </div>
            {(['sigef', 'car'] as Layer[]).map((l) => (
              <label key={l} className="check small"><input type="checkbox" checked={layers[l]} onChange={(e) => setLayers({ ...layers, [l]: e.target.checked })} />
                <span>{LAYER_LABEL[l]}{info.counts[l] != null && <span className="muted"> · {info.counts[l]} no recorte</span>}
                  {status && <span className={`badge ${status.layers.find((x: any) => x.key === l)?.status === 'implemented' ? 'ok' : 'warn'}`} style={{ marginLeft: 6 }}>{({ implemented: 'conectado', simulated: 'simulado', pending: 'pendente' } as any)[status.layers.find((x: any) => x.key === l)?.status]}</span>}</span>
              </label>
            ))}
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
                    <span className="row" style={{ justifyContent: 'space-between' }}><b>{pr.layer === 'sigef' ? 'SIGEF' : 'CAR'}</b>{pr.ficticio && <span className="badge warn">fictício</span>}</span>
                    {pr.nome && <span>{pr.nome}</span>}
                    <span className="small muted" style={{ wordBreak: 'break-all' }}>{pr.codigo}</span>
                    <span className="small">{pr.area_ha != null ? `${pr.area_ha.toLocaleString('pt-BR')} ha` : ''}{pr.situacao ? ` · ${pr.situacao}` : ''}</span>
                    {pr.matricula && <span className="small">Matrícula {pr.matricula}{pr.cns_serventia ? ` · CNS ${pr.cns_serventia}` : ''}</span>}
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
        </aside>
      </div>
      {create && <CreateProspect init={create} onClose={() => setCreate(null)} onCreated={(id) => nav(`/painel/captacao/${id}`)} />}
    </>
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
