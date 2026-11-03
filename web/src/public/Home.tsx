import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LAND_TYPES, VIABILITY, MODALITIES, formatArea } from '@dl/shared';
import MapView, { type AreaFeature } from '../components/MapView';
import { api, qs } from '../lib/api';
import Ficha, { type PublicArea } from './Ficha';
import { useMeta } from './Filters';

export default function Home() {
  const nav = useNavigate();
  const meta = useMeta();
  const [features, setFeatures] = useState<AreaFeature[]>([]);
  const [featured, setFeatured] = useState<PublicArea[]>([]);
  const [f, setF] = useState({ uf: '', city: '', area: '', viability: '', modality: '' });
  const [nl, setNl] = useState('');
  const [nlNote, setNlNote] = useState('');

  useEffect(() => {
    document.title = 'Dourado Land Intelligence — áreas para incorporação e loteamento';
    api<{ features: AreaFeature[] }>('/api/public/map').then((r) => setFeatures(r.features)).catch(() => {});
    api<{ items: PublicArea[] }>('/api/public/opportunities?featured=1&per=4').then((r) => setFeatured(r.items)).catch(() => {});
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const [min, max] = f.area ? f.area.split('-') : ['', ''];
    nav(`/areas${qs({ uf: f.uf, city: f.city, area_min: min, area_max: max, viability: f.viability, modality: f.modality })}`);
  };
  const ask = async (e: FormEvent) => {
    e.preventDefault();
    if (nl.trim().length < 3) return;
    try {
      const r = await api<{ filters: Record<string, string>; explain: string[] }>('/api/public/ai/search', { body: { text: nl } });
      if (!Object.keys(r.filters).length) { setNlNote('Não identifiquei critérios. Tente citar cidade, hectares ou finalidade.'); return; }
      nav(`/areas${qs({ ...r.filters, q: '' })}`, { state: { explain: r.explain } });
    } catch { setNlNote('Não foi possível interpretar agora. Use os filtros acima.'); }
  };

  const cities = (meta?.cities ?? []).filter((c) => !f.uf || c.uf === f.uf);

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <h1>Terra certa para o próximo empreendimento</h1>
          <p className="lede">Glebas e terrenos captados pela Dourado, com dados técnicos de origem identificada e um intermediador responsável por cada área.</p>

          <form className="search-panel" onSubmit={submit} aria-label="Buscar áreas">
            <div className="grid2">
              <label className="field"><span>Estado</span>
                <select value={f.uf} onChange={(e) => setF({ ...f, uf: e.target.value, city: '' })}>
                  <option value="">Todos</option>
                  {meta?.ufs.map((u) => <option key={u.uf} value={u.uf}>{u.uf}</option>)}
                </select>
              </label>
              <label className="field"><span>Cidade</span>
                <select value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })}>
                  <option value="">Todas</option>
                  {cities.map((c) => <option key={c.city + c.uf} value={c.city}>{c.city}/{c.uf}</option>)}
                </select>
              </label>
              <label className="field"><span>Metragem</span>
                <select value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })}>
                  <option value="">Qualquer</option>
                  <option value="-50000">Até 5 ha</option>
                  <option value="50000-200000">5 a 20 ha</option>
                  <option value="200000-500000">20 a 50 ha</option>
                  <option value="500000-">Acima de 50 ha</option>
                </select>
              </label>
              <label className="field"><span>Finalidade</span>
                <select value={f.viability} onChange={(e) => setF({ ...f, viability: e.target.value })}>
                  <option value="">Qualquer</option>
                  {Object.entries(VIABILITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
            </div>
            <label className="field"><span>Modalidade de negociação</span>
              <select value={f.modality} onChange={(e) => setF({ ...f, modality: e.target.value })}>
                <option value="">Qualquer</option>
                {Object.entries(MODALITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <button className="btn gold" type="submit">Ver áreas compatíveis</button>
          </form>

          <form className="stack-s" onSubmit={ask}>
            <label className="field"><span>Ou descreva o que procura</span>
              <div className="nl-search">
                <input value={nl} onChange={(e) => { setNl(e.target.value); setNlNote(''); }} placeholder="Ex.: acima de 20 hectares para loteamento com permuta em GO" />
                <button className="btn ghost" type="submit">Buscar</button>
              </div>
            </label>
            {nlNote && <p className="small muted">{nlNote}</p>}
          </form>

          {meta && (
            <div className="hero-stats">
              <div><b className="num">{meta.totals.n}</b><span>áreas na vitrine</span></div>
              <div><b className="num">{formatArea(meta.totals.area)}</b><span>de área total</span></div>
              <div><b className="num">{meta.totals.cities}</b><span>cidades</span></div>
            </div>
          )}
        </div>
        <div className="hero-map">
          <MapView features={features} className="map" />
        </div>
      </section>

      <div className="page">
        <section>
          <div className="section-head">
            <h2>Oportunidades em destaque</h2>
            <Link to="/areas" className="btn ghost">Ver o banco completo</Link>
          </div>
          <div className="ficha-list">{featured.map((a) => <Ficha key={a.code} a={a} />)}</div>
        </section>

        <section className="section">
          <div className="section-head"><h2>Como a negociação acontece</h2><Link to="/como-funciona" className="btn link">Entenda cada etapa</Link></div>
          <ol className="steps-how" style={{ padding: 0, margin: 0 }}>
            <li><h3>Captação e checagem</h3><p>Cada área entra com matrícula, perímetro e parâmetros urbanísticos marcados por fonte e status de validação.</p></li>
            <li><h3>Publicação autorizada</h3><p>Só aparece aqui o que o proprietário autorizou divulgar. Localização exata e valores podem ficar reservados.</p></li>
            <li><h3>Contato direto</h3><p>O botão de WhatsApp leva ao intermediador responsável, já com o código da área na mensagem.</p></li>
            <li><h3>Proposta e diligência</h3><p>Propostas, contrapropostas e documentos ficam registrados até o contrato.</p></li>
          </ol>
        </section>

        <section className="section grid2">
          <div className="panel" style={{ padding: '1.75rem' }}>
            <h2 className="wide" style={{ fontSize: 'var(--t2)', marginBottom: '0.6rem' }}>Tem uma área?</h2>
            <p className="muted">Envie localização e documentos. A equipe de captação avalia o potencial e combina com você o que pode ser divulgado.</p>
            <Link to="/proprietarios" className="btn">Cadastrar uma área</Link>
          </div>
          <div className="panel" style={{ padding: '1.75rem' }}>
            <h2 className="wide" style={{ fontSize: 'var(--t2)', marginBottom: '0.6rem' }}>Procura terreno para incorporar?</h2>
            <p className="muted">Registre seu perfil de aquisição — cidades, metragem, tipologia e modelo de permuta — e receba áreas compatíveis com explicação do encaixe.</p>
            <Link to="/construtoras" className="btn">Cadastrar perfil de aquisição</Link>
          </div>
        </section>

        <section className="section">
          <div className="section-head"><h2>Por tipo de área</h2></div>
          <div className="chips">
            {Object.entries(LAND_TYPES).map(([k, l]) => <Link key={k} className="chip" to={`/areas?type=${k}`} style={{ textDecoration: 'none' }}>{l}</Link>)}
          </div>
        </section>
      </div>
    </>
  );
}
