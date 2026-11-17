import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  APPROVAL_STAGES, LAND_TYPES, earthUrl, MODALITIES, TECHNICAL_KEYS, VIABILITY, DOC_CATEGORIES, formatArea, formatBRL,
  type ApprovalStage, type LandType, type Modality, type TechnicalKey, type Viability, type DocCategory,
} from '@dl/shared';
import { useSession } from '../lib/session';
import { api, ApiError, DEMO, FRAMED, getAttribution, openFile, track, NEW_TAB } from '../lib/api';
import MapView, { type AreaFeature } from '../components/MapView';
import { Empty, Field, Loading, Modal, ValidationBadge, useToast } from '../components/ui';
import { statusLabel, type PublicArea } from './Ficha';

export function techValue(key: string, v: any): string {
  if (v === true) return 'Sim';
  if (v === false) return 'Não';
  if (key === 'estagio_aprovacao') return APPROVAL_STAGES[v as ApprovalStage] ?? v;
  if (key === 'viabilidade' && Array.isArray(v)) return v.map((x) => VIABILITY[x as Viability] ?? x).join(', ');
  if (key === 'situacao') return ({ urbana: 'Urbana', rural: 'Rural', expansao_urbana: 'Expansão urbana' } as any)[v] ?? v;
  if (key === 'taxa_ocupacao') return `${v}%`;
  if (key === 'gabarito') return `${v} m`;
  return String(v);
}

export function toFeature(a: PublicArea): AreaFeature[] {
  if (!a.location?.point) return [];
  return [{
    type: 'Feature', geometry: { type: 'Point', coordinates: a.location.point },
    properties: { code: a.code, slug: a.slug, title: a.title, city: a.city, uf: a.uf, area_m2: a.area_m2, precision: a.location.precision, radius_m: a.location.radius_m, cover: a.media[0]?.url ?? null, polygon: a.location.polygon ? JSON.stringify(a.location.polygon) : null },
  }];
}

export default function Detail() {
  const { slug } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [a, setA] = useState<PublicArea | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [interest, setInterest] = useState<null | 'whatsapp' | 'form'>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [fav, setFav] = useState(false);
  const logged = !!useSession().me;

  useEffect(() => {
    setA(null);
    api<PublicArea>(`/api/public/opportunities/${slug}`)
      .then((r) => {
        if (r.canonical_slug && r.canonical_slug !== slug) nav(`/areas/${r.canonical_slug}`, { replace: true });
        setA(r);
        setFav(!!r.favorite);
        document.title = `${r.title} — ${r.code} — Quero Área`;
        track('view_item', { item_id: r.code, item_category: r.type });
      })
      .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? 'not_found' : e.message));
  }, [slug, nav]);

  useEffect(() => { document.body.classList.add('has-wa'); return () => document.body.classList.remove('has-wa'); }, []);
  const features = useMemo(() => (a ? toFeature(a) : []), [a]);

  if (err === 'not_found') return <div className="page"><Empty title="Área não encontrada"><p>Ela pode ter sido concluída ou retirada da vitrine.</p><Link className="btn" to="/areas">Ver o banco de áreas</Link></Empty></div>;
  if (err) return <div className="page"><p className="notice bad">{err}</p></div>;
  if (!a) return <div className="page"><Loading /></div>;

  const st = statusLabel[a.status];
  // só o que foi preenchido: campo sem valor não vira linha vazia na ficha
  const tech = (Object.entries(a.technical) as [TechnicalKey, { value: any; validation_status: string }][])
    .filter(([, v]) => v && v.value != null && v.value !== '' && !(Array.isArray(v.value) && v.value.length === 0));
  const potential = tech.filter(([k]) => ['viabilidade', 'estagio_aprovacao', 'coef_aproveitamento', 'taxa_ocupacao', 'gabarito', 'zoneamento', 'uso_solo'].includes(k));
  const terrain = tech.filter(([k]) => !potential.some(([p]) => p === k));
  const share = async () => {
    const url = location.href;
    try {
      if (navigator.share) await navigator.share({ title: a.title, text: `${a.code} — ${a.title}`, url });
      else { await navigator.clipboard.writeText(url); toast('Link copiado'); }
      track('share', { item_id: a.code });
    } catch { /* cancelado */ }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(location.href); toast('Link copiado'); } catch { toast('Não foi possível copiar', true); } };
  const toggleFav = async () => {
    if (!logged) {
      try {
        const k = 'dl.favs'; const s = new Set<string>(JSON.parse(localStorage.getItem(k) ?? '[]'));
        s.has(a.code) ? s.delete(a.code) : s.add(a.code); localStorage.setItem(k, JSON.stringify([...s])); setFav(s.has(a.code));
        toast(s.has(a.code) ? 'Salva neste navegador. Entre para salvar na sua conta.' : 'Removida dos favoritos');
      } catch { toast('Entre para salvar favoritas', true); }
      return;
    }
    try {
      await api(`/api/opportunities/${a.code}/favorite`, { method: fav ? 'DELETE' : 'POST' });
      setFav(!fav); toast(fav ? 'Removida dos favoritos' : 'Salva nos favoritos');
    } catch (e: any) { toast(e.message, true); }
  };
  const openDoc = async (id: string) => {
    try { const r = await api<{ url: string }>(`/api/public/documents/${id}/url`); openFile(r.url, toast); } catch (e: any) { toast(e.message, true); }
  };

  return (
    <div className="page" style={{ paddingTop: '1.5rem' }}>
      <nav className="small muted" aria-label="Trilha" style={{ marginBottom: '1rem' }}>
        <Link to="/areas">Banco de áreas</Link> / <Link to={`/areas?uf=${a.uf}`}>{a.uf}</Link> / <Link to={`/areas?uf=${a.uf}&city=${encodeURIComponent(a.city)}`}>{a.city}</Link> / {a.code}
      </nav>

      {a.media.length > 0 && (
        <div className={`gallery ${a.media.length === 1 ? 'single' : ''}`}>
          {a.media.slice(0, 3).map((m, i) => (
            <button key={m.id} onClick={() => setLightbox(i)} aria-label={`Ampliar imagem ${i + 1} de ${a.media.length}`}><img src={m.url} alt={m.caption ?? `Imagem ${i + 1} de ${a.title}`} /></button>
          ))}
        </div>
      )}

      <div className="detail">
        <article>
          <div className="detail-title">
            <div className="row" style={{ marginBottom: '0.6rem' }}>
              <span className="muted">{a.code}</span>
              {st && <span className={`badge dot ${st[0]}`}>{st[1]}</span>}
              {a.commercial.exclusivity && <span className="badge">Exclusividade Quero Área</span>}
            </div>
            <h1>{a.title}</h1>
            <p className="muted" style={{ marginTop: '0.5rem', fontSize: 'var(--t1)' }}>
              {[a.neighborhood, a.city].filter(Boolean).join(', ')}/{a.uf}{a.region ? ` — ${a.region}` : ''}
            </p>
          </div>

          <dl className="facts">
            <div><dt>Área total</dt><dd className="num">{formatArea(a.area_m2)}</dd></div>
            {a.usable_area_m2 && <div><dt>Aproveitável estimada</dt><dd className="num">{formatArea(a.usable_area_m2)}</dd></div>}
            <div><dt>Tipo</dt><dd style={{ fontSize: '1.05rem' }}>{LAND_TYPES[a.type as LandType]}</dd></div>
            <div><dt>Negociação</dt><dd style={{ fontSize: '1.05rem' }}>{a.commercial.modalities.map((m) => MODALITIES[m as Modality]).join(', ')}</dd></div>
          </dl>

          {(a.summary || a.strategic_description) && (
            <div className="prose">
              {a.summary && <p style={{ color: 'var(--ink)', fontSize: '1.15rem' }}>{a.summary}</p>}
              {a.strategic_description?.split('\n').map((p, i) => <p key={i}>{p}</p>)}
            </div>
          )}

          {(terrain.length > 0 || a.frontage_m || a.depth_m || a.topography) && <section className="block">
            <h2>Características do terreno</h2>
            <dl className="spec">
              {a.frontage_m && <><dt>Testada</dt><dd>{a.frontage_m.toLocaleString('pt-BR')} m</dd></>}
              {a.depth_m && <><dt>Profundidade</dt><dd>{a.depth_m.toLocaleString('pt-BR')} m</dd></>}
              {a.topography && <><dt>Topografia</dt><dd>{a.topography}</dd></>}
              {terrain.map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}><dt>{TECHNICAL_KEYS[k]?.label ?? k}</dt><dd><span>{techValue(k, v.value)}</span><ValidationBadge status={v.validation_status} /></dd></div>
              ))}
            </dl>
          </section>}

          {(potential.length > 0 || a.commercial.expected_units || a.commercial.vgv_preliminary) && (
            <section className="block">
              <h2>Potencial de desenvolvimento</h2>
              <dl className="spec">
                {potential.map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}><dt>{TECHNICAL_KEYS[k]?.label ?? k}</dt><dd><span>{techValue(k, v.value)}</span><ValidationBadge status={v.validation_status} /></dd></div>
                ))}
                {a.commercial.expected_units && <><dt>Expectativa de unidades</dt><dd><span>{a.commercial.expected_units.toLocaleString('pt-BR')}</span><span className="badge warn">Estimativa</span></dd></>}
                {a.commercial.vgv_preliminary && <><dt>VGV preliminar</dt><dd><span>{formatBRL(a.commercial.vgv_preliminary)}</span><span className="badge warn">Estimativa</span></dd></>}
              </dl>
              <p className="small muted" style={{ marginTop: '0.6rem' }}>Parâmetros marcados como declarados ou estimados não constituem aprovação oficial e devem ser confirmados na diligência.</p>
            </section>
          )}

          <section className="block">
            <h2>Localização</h2>
            <div className="detail-map"><MapView features={features} legend={false} /></div>
            <p className="small muted" style={{ marginTop: '0.5rem' }}>
              {a.location?.precision === 'exact' && a.location.point && <><a href={earthUrl(a.location.point[1], a.location.point[0], Math.max(800, Math.sqrt(a.area_m2) * 4))} target="_blank" rel="noopener noreferrer">Ver no Google Earth</a>{' · '}</>}
              {a.location?.precision === 'exact' ? 'Perímetro informado pelo levantamento.' : a.location?.precision === 'approximate' ? 'Localização aproximada. O perímetro exato é apresentado no atendimento.' : 'Exibida apenas a região. Detalhes no atendimento.'}
            </p>
          </section>

          <section className="block">
            <h2>Condições comerciais</h2>
            <dl className="spec">
              <dt>Valor pedido</dt><dd>{a.commercial.asking_price ? formatBRL(a.commercial.asking_price) : 'Sob consulta'}</dd>
              {a.commercial.price_per_m2 && <><dt>Valor por m²</dt><dd>{formatBRL(a.commercial.price_per_m2)}</dd></>}
              {a.commercial.swap_pct && <><dt>Permuta pretendida</dt><dd>{a.commercial.swap_pct}%</dd></>}
              <dt>Negociável</dt><dd>{a.commercial.negotiable ? 'Sim' : 'Não'}</dd>
            </dl>
          </section>

          {a.documents.length > 0 && (
            <section className="block">
              <h2>Documentos disponíveis</h2>
              <div className="stack-s">
                {a.documents.map((d) => (
                  <div key={d.id} className="spread" style={{ borderBottom: '1px solid var(--line-2)', paddingBottom: '0.5rem' }}>
                    <span>{d.title} <span className="muted small">— {DOC_CATEGORIES[d.category as DocCategory]}, {Math.ceil(d.size / 1024)} KB</span></span>
                    <button className="btn ghost small" onClick={() => openDoc(d.id)}>Baixar</button>
                  </div>
                ))}
              </div>
              <p className="small muted" style={{ marginTop: '0.5rem' }}>Matrícula, certidões e estudos completos são enviados após o primeiro contato.</p>
            </section>
          )}

          <section className="block" id="interesse">
            <h2>Tenho interesse</h2>
            <InterestForm area={a} />
          </section>

          {a.similar && a.similar.length > 0 && (
            <section className="block">
              <h2>Oportunidades semelhantes</h2>
              <div className="mini-list">
                {a.similar.map((s) => (
                  <Link to={`/areas/${s.slug}`} key={s.code} className="mini">
                    {s.media[0] && <img src={s.media[0].url} alt="" loading="lazy" />}
                    <span className="small muted">{s.code} · {s.city}/{s.uf}</span>
                    <b>{formatArea(s.area_m2)}</b>
                    <span>{s.title}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </article>

        <aside className="aside" aria-label="Atendimento">
          <div>
            <span className="small muted">{a.commercial.asking_price ? 'Valor pedido' : 'Valor'}</span>
            <div className="price num">{a.commercial.asking_price ? formatBRL(a.commercial.asking_price) : 'Sob consulta'}</div>
            {a.commercial.price_per_m2 && <span className="muted small">{formatBRL(a.commercial.price_per_m2)}/m²</span>}
          </div>
          <button className="btn gold" onClick={() => setInterest('whatsapp')}>Conversar pelo WhatsApp</button>
          <button className="btn ghost" onClick={() => document.getElementById('interesse')?.scrollIntoView({ behavior: 'smooth' })}>Pedir informações por e-mail</button>
          {a.broker && <p className="small muted" style={{ margin: 0 }}>Atendimento: {a.broker.name}{a.broker.creci ? `, CRECI ${a.broker.creci}` : ''}, intermediação Quero Área.</p>}
          <div className="row" style={{ borderTop: '1px solid var(--line-2)', paddingTop: '0.8rem' }}>
            <button className="btn ghost small" onClick={share}>Compartilhar</button>
            <button className="btn ghost small" onClick={copy}>Copiar link</button>
            <button className="btn ghost small" aria-pressed={fav} onClick={toggleFav}>{fav ? 'Salva' : 'Salvar'}</button>
          </div>
          <Link to={`/areas/${a.slug}/book`} className="btn link small">Abrir apresentação (book) em PDF</Link>
        </aside>
      </div>

      <div className="wa-fixed">
        <button className="btn gold" onClick={() => setInterest('whatsapp')}>Conversar pelo WhatsApp</button>
      </div>

      {interest === 'whatsapp' && <WhatsAppModal area={a} onClose={() => setInterest(null)} />}

      {lightbox != null && (
        <div className="lightbox" role="dialog" aria-label="Imagens" onClick={() => setLightbox(null)} onKeyDown={(e) => e.key === 'Escape' && setLightbox(null)}>
          <img src={a.media[lightbox].url} alt={a.media[lightbox].caption ?? ''} onClick={(e) => e.stopPropagation()} />
          <div className="row" onClick={(e) => e.stopPropagation()}>
            <button className="btn ghost small" style={{ background: '#fff' }} onClick={() => setLightbox((lightbox - 1 + a.media.length) % a.media.length)}>Anterior</button>
            <span style={{ color: '#fff' }}>{lightbox + 1} de {a.media.length}{a.media[lightbox].caption ? ` — ${a.media[lightbox].caption}` : ''}</span>
            <button className="btn ghost small" style={{ background: '#fff' }} onClick={() => setLightbox((lightbox + 1) % a.media.length)}>Próxima</button>
            <button className="btn small" onClick={() => setLightbox(null)} autoFocus>Fechar</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Fluxo do botão WhatsApp: dados opcionais (com consentimento) → registro de intenção + roteamento + CRM → abre o WhatsApp.
 * O clique não garante o envio: o painel distingue clique, conversa iniciada e mensagem recebida.
 */
function WhatsAppModal({ area, onClose }: { area: PublicArea; onClose: () => void }) {
  const [form, setForm] = useState({ name: '', phone: '', company: '', consent: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ url: string | null; message: string; routed_to: string | null } | null>(null);
  const hasData = !!(form.name || form.phone || form.company);

  const go = async (withData: boolean) => {
    setErr('');
    if (withData && hasData && !form.consent) { setErr('Para enviar seus dados, marque a autorização de contato.'); return; }
    setBusy(true);
    // abre a janela no gesto do usuário (evita bloqueio de pop-up) e redireciona quando o link chega
    const win = FRAMED ? null : window.open('', '_blank');
    try {
      const r = await api<any>(`/api/public/opportunities/${area.slug}/interest`, {
        body: { kind: 'whatsapp', ...(withData && hasData ? { name: form.name, phone: form.phone, company: form.company, consent: form.consent } : {}), attribution: getAttribution() },
      });
      track('generate_lead', { item_id: area.code, method: 'whatsapp' });
      if (r.whatsapp_url) {
        if (win) win.location.href = r.whatsapp_url; else if (!FRAMED) window.location.href = r.whatsapp_url;
      } else win?.close();
      setDone({ url: r.whatsapp_url, message: r.message, routed_to: r.routed_to });
    } catch (e: any) {
      win?.close();
      setErr(e.message);
    }
    setBusy(false);
  };

  return (
    <Modal title="Conversar pelo WhatsApp" onClose={onClose}>
      {done ? (
        <div className="stack">
          <p>{done.url ? `${DEMO ? 'Interesse registrado e encaminhado' : 'Abrimos o WhatsApp'}${done.routed_to ? ` ${DEMO ? 'a' : 'com'} ${done.routed_to}` : ''}. A mensagem já leva o código da área:` : 'Interesse registrado. A equipe Quero Área entrará em contato.'}</p>
          <blockquote className="notice" style={{ margin: 0 }}>{done.message}</blockquote>
          <p className="small muted">{DEMO ? 'Na demonstração, o WhatsApp não é aberto automaticamente. Use "Simular mensagem no WhatsApp" na barra de demonstração para ver a confirmação chegar ao painel.' : 'Se o WhatsApp não abriu, use o botão abaixo. Envie a mensagem para que o atendimento identifique a área.'}</p>
          <div className="row">{done.url && <a className="btn gold" href={done.url} target="_blank" rel="noopener noreferrer">Abrir WhatsApp</a>}<button className="btn ghost" onClick={onClose}>Fechar</button></div>
        </div>
      ) : (
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>{area.code} — {area.title}. Se quiser, deixe seus dados para que o intermediador já saiba quem é você. É opcional.</p>
          <div className="grid2">
            <Field label="Nome"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" /></Field>
            <Field label="Telefone com DDD"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" inputMode="tel" /></Field>
          </div>
          <Field label="Empresa"><input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} autoComplete="organization" /></Field>
          <label className="check"><input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} /><span>Autorizo a Quero Área a usar estes dados para contato sobre esta e outras oportunidades. <Link to="/privacidade" target={NEW_TAB}>Como tratamos seus dados</Link>.</span></label>
          {err && <p className="error-text" role="alert">{err}</p>}
          <div className="row">
            <button className="btn gold" disabled={busy} onClick={() => go(true)}>{busy ? 'Abrindo…' : hasData ? 'Enviar dados e abrir WhatsApp' : 'Abrir WhatsApp'}</button>
            {hasData && <button className="btn link" disabled={busy} onClick={() => go(false)}>Abrir sem enviar dados</button>}
          </div>
        </div>
      )}
    </Modal>
  );
}

function InterestForm({ area }: { area: PublicArea }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', company: '', message: '', consent: false });
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!f.consent) { setErr('Marque a autorização de contato para enviar.'); return; }
    setState('busy');
    try {
      await api(`/api/public/opportunities/${area.slug}/interest`, { body: { kind: 'form', ...f, attribution: getAttribution() } });
      track('generate_lead', { item_id: area.code, method: 'form' });
      setState('done');
    } catch (e: any) { setErr(e.message); setState('idle'); }
  };
  if (state === 'done') return <p className="notice ok">Pedido enviado. O intermediador responsável pela {area.code} vai responder por e-mail ou telefone.</p>;
  return (
    <form className="stack" onSubmit={submit} style={{ maxWidth: 640 }}>
      <div className="grid2">
        <Field label="Nome"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" /></Field>
        <Field label="Empresa"><input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} autoComplete="organization" /></Field>
        <Field label="E-mail"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" /></Field>
        <Field label="Telefone com DDD"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} autoComplete="tel" inputMode="tel" /></Field>
      </div>
      <Field label="O que você precisa saber"><textarea value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} placeholder="Ex.: tipologia pretendida, prazo, interesse em permuta" /></Field>
      <label className="check"><input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} /><span>Autorizo a Quero Área a usar estes dados para contato sobre oportunidades. <Link to="/privacidade" target={NEW_TAB}>Como tratamos seus dados</Link>.</span></label>
      {err && <p className="error-text" role="alert">{err}</p>}
      <div><button className="btn" disabled={state === 'busy'}>{state === 'busy' ? 'Enviando…' : 'Enviar pedido de informações'}</button></div>
    </form>
  );
}
