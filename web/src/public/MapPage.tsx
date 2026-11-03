import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatArea } from '@dl/shared';
import { api, qs } from '../lib/api';
import MapView, { type AreaFeature } from '../components/MapView';
import Filters, { FILTER_KEYS, useMeta } from './Filters';

/** Mapa de oportunidades em tela cheia, com filtros e comparação visual entre áreas. */
export default function MapPage() {
  const [params, setParams] = useSearchParams();
  const meta = useMeta();
  const filters = useMemo(() => Object.fromEntries([...params.entries()].filter(([k]) => FILTER_KEYS.includes(k))), [params]);
  const [features, setFeatures] = useState<AreaFeature[]>([]);
  const [bbox, setBbox] = useState<[number, number, number, number] | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => { document.title = 'Mapa de oportunidades — Dourado Land Intelligence'; }, []);
  useEffect(() => { api<{ features: AreaFeature[] }>(`/api/public/map${qs(filters)}`).then((r) => setFeatures(r.features)).catch(() => {}); }, [filters]);

  const inView = bbox ? features.filter(({ geometry: { coordinates: [x, y] } }) => x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3]) : features;
  const update = (v: Record<string, string>) => { const n = new URLSearchParams(); for (const [k, x] of Object.entries(v)) if (x) n.set(k, x); setParams(n); };
  const cmp = features.filter((f) => compare.includes(f.properties.code));

  return (
    <div className="map-fullpage">
      <MapView features={features} onBoundsChange={setBbox} compare={compare} />
      <aside className="map-side" aria-label="Áreas no mapa">
        <div className="spread">
          <b>{inView.length} {inView.length === 1 ? 'área visível' : 'áreas visíveis'}</b>
          <button className="btn ghost small" aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}>{showFilters ? 'Ocultar filtros' : 'Filtros'}</button>
        </div>
        {showFilters && <div className="filters" style={{ position: 'static', display: 'grid', maxHeight: 'none' }}><Filters value={filters} onChange={update} meta={meta} /></div>}
        {cmp.length > 0 && (
          <div className="panel" style={{ padding: '0.75rem' }}>
            <div className="spread"><b className="small">Comparando</b><button className="btn link small" onClick={() => setCompare([])}>Limpar</button></div>
            <table className="data" style={{ fontSize: '0.8rem' }}>
              <tbody>
                <tr><th>Área</th>{cmp.map((c) => <td key={c.properties.code}>{c.properties.code}</td>)}</tr>
                <tr><th>Tamanho</th>{cmp.map((c) => <td key={c.properties.code}>{formatArea(c.properties.area_m2)}</td>)}</tr>
                <tr><th>Cidade</th>{cmp.map((c) => <td key={c.properties.code}>{c.properties.city}/{c.properties.uf}</td>)}</tr>
              </tbody>
            </table>
          </div>
        )}
        <div className="stack-s">
          {inView.slice(0, 40).map((f) => (
            <div key={f.properties.code} className="spread" style={{ borderBottom: '1px solid var(--line-2)', paddingBottom: '0.5rem', alignItems: 'start', flexWrap: 'nowrap' }}>
              <Link to={`/areas/${f.properties.slug}`} style={{ textDecoration: 'none' }}>
                <span className="small muted">{f.properties.code} · {f.properties.city}/{f.properties.uf}</span>
                <div><b className="wide">{formatArea(f.properties.area_m2)}</b></div>
                <div className="small">{f.properties.title}</div>
              </Link>
              <label className="check small" title="Comparar no mapa">
                <input type="checkbox" checked={compare.includes(f.properties.code)} disabled={!compare.includes(f.properties.code) && compare.length >= 3}
                  onChange={() => setCompare((c) => (c.includes(f.properties.code) ? c.filter((x) => x !== f.properties.code) : [...c, f.properties.code]))} />
                Comparar
              </label>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
