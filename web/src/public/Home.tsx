import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LAND_TYPES, VIABILITY, MODALITIES, formatArea, formatBRL, type LandType, type Modality } from '@dl/shared';
import MapView, { type AreaFeature } from '../components/MapView';
import { api, qs } from '../lib/api';
import Ficha, { statusLabel, type PublicArea } from './Ficha';
import { useMeta } from './Filters';

const UF_NAME: Record<string, string> = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás',
  MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí',
  RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

/** Destaque principal da vitrine: metragem como elemento principal e a cidade sobre a malha do território. */
function Featured({ a }: { a: PublicArea }) {
  const ha = a.area_m2 >= 10000;
  const st = statusLabel[a.status];
  return (
    <Link to={`/areas/${a.slug}`} className="q-featured">
      <div className="q-featured-body">
        <div className="q-featured-top">
          <div className="q-featured-ha">
            <b className="num">{ha ? (a.area_m2 / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : Math.round(a.area_m2).toLocaleString('pt-BR')}</b>
            <span>{ha ? 'hectares' : 'm²'}</span>
          </div>
          <div>
            <div className="q-code">{a.code}</div>
            <h3>{a.title}</h3>
          </div>
        </div>
        <div className="q-meta">
          <span>{a.city}/{a.uf}</span>
          <span>{LAND_TYPES[a.type as LandType]}</span>
          {a.commercial.modalities.length > 0 && <span>{a.commercial.modalities.map((m) => MODALITIES[m as Modality]).join(', ')}</span>}
        </div>
        <div className="q-tags">
          {st && <span className={`q-tag ${st[0]}`}>● {st[1]}</span>}
          {a.featured && <span className="q-tag hot">Destaque</span>}
          <span className="q-price">{a.commercial.asking_price ? formatBRL(a.commercial.asking_price) : 'Valor sob consulta'}</span>
        </div>
      </div>
      <div className="q-featured-art" aria-hidden="true">
        <div className="q-eyebrow">Vitrine de áreas · Município</div>
        <div><div className="city">{a.city}</div><div className="sub">{UF_NAME[a.uf] ?? a.uf} · Brasil</div></div>
      </div>
    </Link>
  );
}

export default function Home() {
  const nav = useNavigate();
  const meta = useMeta();
  const [features, setFeatures] = useState<AreaFeature[]>([]);
  const [featured, setFeatured] = useState<PublicArea[]>([]);
  const [f, setF] = useState({ uf: '', city: '', area: '', viability: '', modality: '' });
  const [nl, setNl] = useState('');
  const [nlNote, setNlNote] = useState('');

  useEffect(() => {
    document.title = 'Quero Área — encontre a área certa para o seu projeto';
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
  const [first, ...rest] = featured;

  return (
    <>
      <section className="q-hero">
        <div className="q-hero-copy">
          <div className="q-eyebrow q-rise">● Banco de áreas · incorporação · loteamento</div>
          <h1 className="q-rise" style={{ animationDelay: '.08s' }}>A área certa para o seu <span>próximo empreendimento.</span></h1>
          <p className="q-hero-lead q-rise" style={{ animationDelay: '.16s' }}>Glebas e terrenos com dados técnicos de origem identificada e um intermediador responsável por cada área.</p>

          <form className="q-finder q-rise" style={{ animationDelay: '.24s' }} onSubmit={submit} role="search" aria-label="Buscar áreas compatíveis">
            <label className="q-field"><span>Estado</span>
              <select value={f.uf} onChange={(e) => setF({ ...f, uf: e.target.value, city: '' })}>
                <option value="">Todos</option>
                {meta?.ufs.map((u) => <option key={u.uf} value={u.uf}>{u.uf}</option>)}
              </select>
            </label>
            <label className="q-field"><span>Cidade</span>
              <select value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })}>
                <option value="">Todas</option>
                {cities.map((c) => <option key={c.city + c.uf} value={c.city}>{c.city}/{c.uf}</option>)}
              </select>
            </label>
            <label className="q-field"><span>Metragem</span>
              <select value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })}>
                <option value="">Qualquer</option>
                <option value="-50000">Até 5 ha</option>
                <option value="50000-200000">5 a 20 ha</option>
                <option value="200000-500000">20 a 50 ha</option>
                <option value="500000-">Acima de 50 ha</option>
              </select>
            </label>
            <label className="q-field"><span>Finalidade</span>
              <select value={f.viability} onChange={(e) => setF({ ...f, viability: e.target.value })}>
                <option value="">Qualquer</option>
                {Object.entries(VIABILITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="q-field full"><span>Modalidade de negociação</span>
              <select value={f.modality} onChange={(e) => setF({ ...f, modality: e.target.value })}>
                <option value="">Qualquer</option>
                {Object.entries(MODALITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <button className="q-btn q-btn-navy" type="submit">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFB800" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.3 15.3 21 21" /></svg>
              Ver áreas compatíveis
            </button>
          </form>

          <form className="q-ask q-rise" style={{ animationDelay: '.32s' }} onSubmit={ask} role="search">
            <label htmlFor="q-ask">Ou descreva o que procura</label>
            <div className="q-ask-row">
              <input id="q-ask" value={nl} onChange={(e) => { setNl(e.target.value); setNlNote(''); }} placeholder="Ex.: acima de 20 hectares para loteamento em SP" />
              <button className="q-btn q-btn-gold" type="submit">Buscar</button>
            </div>
            {nlNote && <p className="note">{nlNote}</p>}
          </form>

          {meta && (
            <div className="q-stats q-rise" style={{ animationDelay: '.4s' }}>
              <div><b className="num">{meta.totals.n}</b><span>{meta.totals.n === 1 ? 'área na vitrine' : 'áreas na vitrine'}</span></div>
              <div><b className="num">{formatArea(meta.totals.area)}</b><span>de área total</span></div>
              <div><b className="num">{meta.totals.cities}</b><span>{meta.totals.cities === 1 ? 'cidade' : 'cidades'}</span></div>
            </div>
          )}
        </div>
        <div className="q-hero-map">
          <MapView features={features} className="map" />
        </div>
      </section>

      {first && (
        <section className="q-section">
          <div className="q-wrap">
            <div className="q-section-head">
              <div><div className="q-eyebrow">● Vitrine</div><h2>Oportunidades em destaque</h2></div>
              <Link className="q-btn q-btn-ghost" to="/areas">Ver o banco completo</Link>
            </div>
            <Featured a={first} />
            {rest.length > 0 && <div className="ficha-list q-more">{rest.map((a) => <Ficha key={a.code} a={a} />)}</div>}
          </div>
        </section>
      )}

      <section className="q-section q-dark">
        <div className="q-wrap">
          <div className="q-section-head">
            <div><div className="q-eyebrow">● Processo</div><h2>Como a negociação acontece</h2></div>
            <Link to="/como-funciona">Entenda cada etapa →</Link>
          </div>
          <ol className="q-steps">
            <li className="q-step"><span className="n">01</span><h3>Captação e checagem</h3><p>Cada área entra com matrícula, perímetro e parâmetros urbanísticos marcados por fonte e status de validação.</p></li>
            <li className="q-step"><span className="n">02</span><h3>Publicação autorizada</h3><p>Só aparece aqui o que o proprietário autorizou divulgar. Localização exata e valores podem ficar reservados.</p></li>
            <li className="q-step"><span className="n">03</span><h3>Contato direto</h3><p>O botão de WhatsApp leva ao intermediador responsável, já com o código da área na mensagem.</p></li>
            <li className="q-step"><span className="n">04</span><h3>Proposta e diligência</h3><p>Propostas, contrapropostas e documentos ficam registrados até o contrato.</p></li>
          </ol>
        </div>
      </section>

      <section className="q-section">
        <div className="q-wrap q-duo">
          <div className="q-cta owner">
            <div className="q-eyebrow">● Para proprietários</div>
            <h2>Tem uma área?</h2>
            <p>Envie localização e documentos. A equipe de captação avalia o potencial e combina com você o que pode ser divulgado.</p>
            <Link className="q-btn q-btn-navy" to="/proprietarios">Cadastrar uma área</Link>
          </div>
          <div className="q-cta builder">
            <div className="q-eyebrow">● Para construtoras e investidores</div>
            <h2>Procura terreno para incorporar?</h2>
            <p>Registre seu perfil de aquisição — cidades, metragem, tipologia e modelo de permuta — e receba áreas compatíveis com explicação do encaixe.</p>
            <Link className="q-btn q-btn-navy" to="/construtoras">Cadastrar perfil de aquisição</Link>
          </div>
        </div>
      </section>

      <section className="q-section" style={{ paddingTop: 0 }}>
        <div className="q-wrap">
          <div className="q-section-head"><div><div className="q-eyebrow">● Explore</div><h2>Por tipo de área</h2></div></div>
          <div className="q-types">
            {Object.entries(LAND_TYPES).map(([k, l]) => <Link key={k} to={`/areas?type=${k}`}>{l}</Link>)}
          </div>
        </div>
      </section>
    </>
  );
}
