import { useEffect, useMemo, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import Filters, { FILTER_KEYS, useMeta } from './Filters';
import Ficha, { type PublicArea } from './Ficha';
import MapView, { type AreaFeature } from '../components/MapView';
import { Empty } from '../components/ui';

export default function Bank() {
  const [params, setParams] = useSearchParams();
  const loc = useLocation();
  const meta = useMeta();
  const filters = useMemo(() => Object.fromEntries([...params.entries()].filter(([k]) => FILTER_KEYS.includes(k) || k === 'sort' || k === 'page')), [params]);
  const [data, setData] = useState<{ total: number; items: PublicArea[]; page: number; per: number } | null>(null);
  const [features, setFeatures] = useState<AreaFeature[]>([]);
  const [view, setView] = useState<'list' | 'map'>(params.get('view') === 'map' ? 'map' : 'list');
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(params.get('q') ?? '');
  const explain: string[] | undefined = (loc.state as any)?.explain;

  useEffect(() => { document.title = 'Banco de áreas — Dourado Land Intelligence'; }, []);
  useEffect(() => {
    api(`/api/public/opportunities${qs(filters)}`).then(setData).catch(() => setData({ total: 0, items: [], page: 1, per: 24 }));
    api<{ features: AreaFeature[] }>(`/api/public/map${qs(filters)}`).then((r) => setFeatures(r.features)).catch(() => {});
  }, [filters]);

  const update = (v: Record<string, string>) => {
    const next = new URLSearchParams();
    for (const [k, val] of Object.entries(v)) if (val) next.set(k, val);
    if (view === 'map') next.set('view', 'map');
    setParams(next);
  };
  const active = Object.entries(filters).filter(([k, v]) => v && !['sort', 'page'].includes(k)).length;
  const pages = data ? Math.ceil(data.total / data.per) : 0;

  return (
    <div className="page">
      <div className="spread" style={{ marginBottom: '1.5rem', alignItems: 'end' }}>
        <div>
          <h1 className="page-title" style={{ marginBottom: '0.3rem' }}>Banco de áreas</h1>
          <p className="muted" aria-live="polite">{data ? `${data.total} ${data.total === 1 ? 'área encontrada' : 'áreas encontradas'}` : 'Carregando…'}{active ? ` com ${active} ${active === 1 ? 'filtro' : 'filtros'}` : ''}</p>
          {explain && <p className="small">Busca interpretada como: {explain.join('; ')}. Ajuste os filtros se necessário.</p>}
        </div>
        <div className="row">
          <form onSubmit={(e) => { e.preventDefault(); update({ ...filters, q }); }} className="row">
            <input className="input" style={{ width: 240 }} placeholder="Código, cidade ou palavra-chave" aria-label="Buscar" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <select className="input" style={{ width: 'auto' }} aria-label="Ordenar" value={filters.sort ?? ''} onChange={(e) => update({ ...filters, sort: e.target.value })}>
            <option value="">Destaques primeiro</option>
            <option value="recent">Mais recentes</option>
            <option value="area_desc">Maior área</option>
            <option value="area_asc">Menor área</option>
          </select>
          <div className="view-toggle" role="group" aria-label="Visualização">
            <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>Lista</button>
            <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}>Mapa</button>
          </div>
          <button className="btn ghost filter-btn" aria-expanded={open} onClick={() => setOpen(!open)}>Filtros{active ? ` (${active})` : ''}</button>
        </div>
      </div>

      <div className="bank">
        <aside className={`filters ${open ? 'open' : ''}`} aria-label="Filtros">
          <div className="spread"><h3>Filtrar</h3>{active > 0 && <button className="btn link small" onClick={() => { setQ(''); update({}); }}>Limpar filtros</button>}</div>
          <Filters value={filters} onChange={update} meta={meta} />
        </aside>
        <section>
          {view === 'map' ? (
            <div style={{ height: 'calc(100vh - 220px)', minHeight: 480, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--line)', position: 'relative' }}>
              <MapView features={features} />
            </div>
          ) : data && data.items.length === 0 ? (
            <Empty title="Nenhuma área com esses critérios">
              <p>Amplie a faixa de metragem ou remova algum filtro. Se preferir, registre seu perfil e avisamos quando surgir uma área compatível.</p>
              <div className="row" style={{ justifyContent: 'center' }}>
                <button className="btn ghost" onClick={() => update({})}>Limpar filtros</button>
                <a className="btn" href="/construtoras">Cadastrar perfil de aquisição</a>
              </div>
            </Empty>
          ) : (
            <>
              <div className="ficha-list">{data?.items.map((a) => <Ficha key={a.code} a={a} />)}</div>
              {pages > 1 && (
                <nav className="row" style={{ marginTop: '1.5rem', justifyContent: 'center' }} aria-label="Paginação">
                  {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
                    <button key={p} className={`btn small ${p === data!.page ? '' : 'ghost'}`} aria-current={p === data!.page ? 'page' : undefined} onClick={() => update({ ...filters, page: String(p) })}>{p}</button>
                  ))}
                </nav>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
