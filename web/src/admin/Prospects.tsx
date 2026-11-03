import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  CAPTURE_CHECKLIST, CHECKLIST_STATUS, DOC_CATEGORIES, LAND_TYPES, PROSPECT_SOURCES, PROSPECT_STAGES, UFS, VIABILITY, formatArea, formatBRL,
  type DocCategory, type ProspectStage,
} from '@dl/shared';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { Empty, ErrorBox, Field, Loading, Modal, useAsync, useToast } from '../components/ui';
import MapView from '../components/MapView';
import DrawMap from '../components/DrawMap';
import OverlapPanel from '../components/OverlapPanel';
import { EarthTools, Google3DView } from '../components/EarthTools';
import { PageHeader } from './Shell';
import { CreateProspect } from './TerritoryMap';

const STAGES = Object.keys(PROSPECT_STAGES) as ProspectStage[];
const PRIORITY: Record<string, [string, string]> = { alta: ['gold', 'Alta'], media: ['', 'Média'], baixa: ['', 'Baixa'] };

function ScoreBadge({ score }: { score: number }) {
  const cls = score >= 60 ? 'ok' : score >= 35 ? 'warn' : '';
  return <span className={`badge ${cls}`} title="Pré-qualificação (0–100)">{score} pts</span>;
}

/** Funil de captação: da identificação da área ao contrato de intermediação. */
export default function Prospects() {
  const { can } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const [status, setStatus] = useState('open');
  const [view, setView] = useState<'board' | 'list'>('board');
  const { data, error, loading, reload, setData } = useAsync(() => api(`/api/prospects?status=${status}`), [status]);
  const [drag, setDrag] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const move = async (id: string, stage: ProspectStage) => {
    const p = data.items.find((x: any) => x.id === id);
    if (!p || p.stage === stage) return;
    setData({ ...data, items: data.items.map((x: any) => (x.id === id ? { ...x, stage } : x)) });
    try {
      const full = await api(`/api/prospects/${id}`);
      await api(`/api/prospects/${id}`, { method: 'PATCH', body: { version: full.version, stage } });
      toast(`Movida para ${PROSPECT_STAGES[stage]}`);
    } catch (e: any) { toast(e.message, true); }
    reload();
  };
  const items = data?.items ?? [];

  return (
    <>
      <PageHeader title="Captação de áreas">
        <select className="input" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Situação">
          <option value="open">Em andamento</option><option value="converted">Convertidas em área</option><option value="discarded">Descartadas</option>
        </select>
        <div className="view-toggle" role="group" aria-label="Visualização">
          <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}>Funil</button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>Lista</button>
        </div>
        <Link className="btn ghost" to="/painel/captacao/mapa">Prospecção no mapa</Link>
        {can('prospect', 'create') && <button className="btn gold" onClick={() => setCreating(true)}>Nova prospecção</button>}
      </PageHeader>
      <p className="muted small" style={{ marginTop: '-0.5rem', maxWidth: '90ch' }}>
        A pontuação prioriza o que já tem comprador: demanda de perfis de aquisição compatíveis (40), documentação (25), identificação registral (15), contato do proprietário (10) e perímetro (10).
      </p>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : items.length === 0 ? (
        <div className="panel"><Empty title="Nenhuma prospecção aqui">Abra a prospecção no mapa para identificar parcelas, ou cadastre uma indicação.</Empty></div>
      ) : view === 'board' && status === 'open' ? (
        <div className="board">
          {STAGES.map((s) => {
            const col = items.filter((p: any) => p.stage === s);
            return (
              <section key={s} className="col" aria-label={PROSPECT_STAGES[s]} onDragOver={(e) => can('prospect', 'update') && e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (drag) void move(drag, s); }}>
                <h3><span>{PROSPECT_STAGES[s]}</span><span className="muted">{col.length}</span></h3>
                {col.map((p: any) => (
                  <button key={p.id} className="deal" draggable={can('prospect', 'update')} onDragStart={() => setDrag(p.id)} onDragEnd={() => setDrag(null)} onClick={() => nav(`/painel/captacao/${p.id}`)}>
                    <span className="row" style={{ justifyContent: 'space-between' }}><span className="small muted">{p.code}</span><ScoreBadge score={p.score} /></span>
                    <b>{p.title}</b>
                    <span className="small">{[p.city && `${p.city}/${p.uf}`, p.area_m2 && formatArea(p.area_m2)].filter(Boolean).join(' · ')}</span>
                    {p.demand_count > 0 && <span className="small" style={{ color: 'var(--gold-ink)', fontWeight: 600 }}>{p.demand_count} comprador(es) com perfil compatível</span>}
                    {p.next_action && <span className={`small ${p.next_action_at && new Date(p.next_action_at) < new Date() ? 'late' : 'muted'}`}>{p.next_action}</span>}
                    {p.priority === 'alta' && <span><span className="badge gold">Prioridade alta</span></span>}
                  </button>
                ))}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Código</th><th>Área</th><th>Local</th><th className="r">Tamanho</th><th>Etapa</th><th>Origem</th><th className="r">Pontos</th><th>Demanda</th><th>Proprietário</th></tr></thead>
            <tbody>{items.map((p: any) => (
              <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/painel/captacao/${p.id}`)}>
                <td className="num"><b>{p.code}</b></td><td>{p.title}</td><td>{p.city ? `${p.city}/${p.uf}` : '—'}</td><td className="r num">{formatArea(p.area_m2)}</td>
                <td>{p.status === 'open' ? PROSPECT_STAGES[p.stage as ProspectStage] : p.status === 'converted' ? <span className="badge ok">Convertida</span> : <span className="badge bad">Descartada</span>}</td>
                <td className="small">{PROSPECT_SOURCES[p.source as keyof typeof PROSPECT_SOURCES]}</td><td className="r"><ScoreBadge score={p.score} /></td>
                <td>{p.demand_count || '—'}</td><td className="small">{p.owner_name ?? <span className="muted">Não identificado</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {creating && <CreateProspect init={{ title: '', uf: 'GO', city: '', land_type: 'gleba', intended_uses: [], source: 'prospeccao_ativa' }} onClose={() => setCreating(false)} onCreated={(id) => nav(`/painel/captacao/${id}`)} />}
    </>
  );
}

// ================================================================ detalhe da prospecção

export function ProspectDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data: p, error, reload, setData } = useAsync(() => api(`/api/prospects/${id}`), [id]);
  const version = useRef(0);
  const pending = useRef<Record<string, any>>({});
  const timer = useRef<number | undefined>(undefined);
  const [save, setSave] = useState('');
  const [act, setAct] = useState({ type: 'call', subject: '', body: '' });
  const [discard, setDiscard] = useState(false);
  const [editGeo, setEditGeo] = useState(false);
  useEffect(() => { if (p) version.current = p.version; }, [p?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = async () => {
    const body = pending.current; pending.current = {};
    if (!Object.keys(body).length) return;
    setSave('Salvando…');
    try {
      const r = await api(`/api/prospects/${id}`, { method: 'PATCH', body: { ...body, version: version.current } });
      version.current = r.version;
      setSave(`Salvo às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
      if (body.checklist || body.intended_uses || body.uf || body.city || body.matricula || body.sigef_code || body.car_code || body.owner_name || body.owner_phone) reload();
    } catch (e: any) { setSave(e instanceof ApiError && e.status === 409 ? 'Alterada por outra pessoa — recarregue' : `Não salvo: ${e.message}`); }
  };
  const upd = (k: string, v: any) => {
    pending.current[k] = v;
    setData({ ...p, [k]: v });
    setSave('Salvando…');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 800);
  };
  useEffect(() => () => { window.clearTimeout(timer.current); void flush(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <ErrorBox error={error} />;
  if (!p) return <Loading />;
  const open = p.status === 'open';
  const ro = !open || !p.permissions.update;
  const I = (k: string, label: string, extra: any = {}) => (
    <Field label={label} hint={extra.hint}><input disabled={ro} value={p[k] ?? ''} onChange={(e) => upd(k, extra.num ? (e.target.value === '' ? null : Number(e.target.value.replace(/\./g, '').replace(',', '.'))) : e.target.value || null)} inputMode={extra.num ? 'decimal' : undefined} /></Field>
  );
  const center: [number, number] | null = p.lng != null ? [p.lng, p.lat] : null;
  const feature = center ? [{ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: center }, properties: { code: p.code, slug: '', title: p.title, city: p.city ?? '', uf: p.uf ?? '', area_m2: p.area_m2 ?? 0, precision: 'exact', radius_m: p.geometry ? null : 300, cover: null, polygon: p.geometry ? JSON.stringify(p.geometry) : null } }] : [];

  return (
    <>
      <div className="spread" style={{ marginBottom: '1rem', alignItems: 'start' }}>
        <div>
          <div className="row small muted"><Link to="/painel/captacao">Captação</Link><span>/</span><span>{p.code}</span><span>{PROSPECT_SOURCES[p.source as keyof typeof PROSPECT_SOURCES]}</span></div>
          <h1 style={{ fontFamily: 'var(--display)', fontWeight: 400, fontSize: '2.3rem', lineHeight: 1, marginTop: 4 }}>{p.title}</h1>
          <div className="row" style={{ marginTop: 6 }}>
            {p.status === 'converted' ? <Link className="badge ok" to={`/painel/areas/${p.opportunity_id}`}>Convertida em área — abrir</Link> : p.status === 'discarded' ? <span className="badge bad">Descartada: {p.discard_reason}</span> : <span className="badge">{PROSPECT_STAGES[p.stage as ProspectStage]}</span>}
            {p.area_m2 && <span className="muted small">{formatArea(p.area_m2)}</span>}
            <span className="savestate">{save}</span>
          </div>
        </div>
        {open && (
          <div className="row">
            {p.permissions.update && <button className="btn danger" onClick={() => setDiscard(true)}>Descartar</button>}
            {p.permissions.convert && <button className="btn gold" onClick={async () => {
              await flush();
              try { const r = await api(`/api/prospects/${id}/convert`, { method: 'POST' }); toast(`Área ${r.code} criada a partir da captação`); nav(`/painel/areas/${r.opportunity_id}`); }
              catch (e: any) { toast(e.details?.missing ? `Complete antes: ${e.details.missing.join(', ')}` : e.message, true); }
            }}>Converter em área do banco</button>}
          </div>
        )}
      </div>

      <div className="prospect-grid">
        <div className="stack">
          <div className="panel stack">
            <div className="grid3">
              <Field label="Etapa"><select disabled={ro} value={p.stage} onChange={(e) => { upd('stage', e.target.value); }}>{STAGES.map((s) => <option key={s} value={s}>{PROSPECT_STAGES[s]}</option>)}</select></Field>
              <Field label="Prioridade"><select disabled={ro} value={p.priority} onChange={(e) => upd('priority', e.target.value)}><option value="alta">Alta</option><option value="media">Média</option><option value="baixa">Baixa</option></select></Field>
              <Field label="Tipo"><select disabled={ro} value={p.land_type ?? ''} onChange={(e) => upd('land_type', e.target.value || null)}><option value="">—</option>{Object.entries(LAND_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            </div>
            <div className="grid3">
              {I('title', 'Nome')}
              <Field label="UF"><select disabled={ro} value={p.uf ?? ''} onChange={(e) => upd('uf', e.target.value || null)}><option value="">—</option>{UFS.map((u) => <option key={u}>{u}</option>)}</select></Field>
              {I('city', 'Cidade')}
            </div>
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="small" style={{ color: 'var(--ink-2)', marginBottom: 4 }}>Potencial de uso (hipótese)</legend>
              <div className="chips">{Object.entries(VIABILITY).map(([k, l]) => { const on = p.intended_uses.includes(k); return <button type="button" disabled={ro} key={k} className="chip" aria-pressed={on} onClick={() => upd('intended_uses', on ? p.intended_uses.filter((x: string) => x !== k) : [...p.intended_uses, k])}>{l}</button>; })}</div></fieldset>
            <div className="grid2">{I('asking_price_hint', 'Valor indicado pelo proprietário (R$)', { num: true, hint: p.asking_price_hint ? formatBRL(p.asking_price_hint) : 'Opcional' })}{I('next_action', 'Próxima ação')}</div>
          </div>

          <div className="panel stack">
            <div className="panel-head" style={{ marginBottom: 0 }}><h2>Localização e perímetro</h2>
              {center && <EarthTools lat={center[1]} lng={center[0]} areaM2={p.area_m2} name={`${p.code} — ${p.title}`} geometry={p.geometry} kmlUrl={`/api/prospects/${id}/kml`} />}</div>
            {editGeo ? (
              <DrawMap importUrl={`/api/prospects/${id}/geometry/import`} initial={p.geometry} center={center} saving={false} onSave={async (geojson, source) => {
                try { await api(`/api/prospects/${id}/geometry`, { method: 'PUT', body: { geojson, source } }); toast('Perímetro salvo'); setEditGeo(false); reload(); } catch (e: any) { toast(e.message, true); }
              }} />
            ) : (
              <div style={{ height: 320, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--line)', position: 'relative' }}>{feature.length ? <MapView features={feature} legend={false} /> : <Empty title="Sem localização">Desenhe o perímetro ou crie a prospecção a partir do mapa territorial.</Empty>}</div>
            )}
            {!ro && <div><button className="btn ghost small" onClick={() => setEditGeo(!editGeo)}>{editGeo ? 'Cancelar edição' : p.geometry ? 'Editar perímetro' : 'Desenhar ou importar perímetro'}</button></div>}
            {center && <Google3DView lat={center[1]} lng={center[0]} areaM2={p.area_m2} geometry={p.geometry} name={p.code} />}
          </div>

          {p.geometry && <OverlapPanel url={`/api/prospects/${id}/overlap`} />}

          <div className="panel">
            <h2 style={{ marginBottom: '0.6rem' }}>Dados territoriais e registrais de origem</h2>
            {p.territory_snapshot.length === 0 ? <p className="muted small">Nenhuma consulta registrada. Use a prospecção no mapa para trazer SIGEF, CAR e Registro de Imóveis.</p> : (
              <table className="data"><thead><tr><th>Base</th><th>Dado</th><th>Fonte e data</th></tr></thead>
                <tbody>{p.territory_snapshot.map((t: any, i: number) => (
                  <tr key={i}>
                    <td><b>{t.layer === 'sigef' ? 'SIGEF/INCRA' : t.layer === 'car' ? 'CAR' : 'Registro (ONR)'}</b>{(t.properties?.ficticio) && <div><span className="badge warn">fictício</span></div>}</td>
                    <td className="small">{t.layer === 'onr' ? <>{t.properties.cartorio}{t.properties.matriculas?.length ? <div>Matrícula(s): {t.properties.matriculas.join(', ')}</div> : null}</> : <>
                      <div style={{ wordBreak: 'break-all' }}>{t.properties.codigo}</div>{t.properties.nome && <div>{t.properties.nome}</div>}
                      <div className="muted">{[t.properties.area_ha != null && `${t.properties.area_ha} ha`, t.properties.situacao, t.properties.matricula && `Matrícula ${t.properties.matricula}`].filter(Boolean).join(' · ')}</div></>}</td>
                    <td className="small muted">{t.source}<br />{new Date(t.consulted_at).toLocaleString('pt-BR')}</td>
                  </tr>
                ))}</tbody></table>
            )}
            <div className="grid3" style={{ marginTop: '0.8rem' }}>
              {I('matricula', 'Matrícula')}{I('cartorio', 'Cartório de Registro de Imóveis')}{I('cns_serventia', 'CNS da serventia')}
              {I('sigef_code', 'Código SIGEF')}{I('car_code', 'Código CAR')}{I('ccir', 'CCIR')}
            </div>
            <div className="row" style={{ marginTop: '0.5rem' }}><a className="btn ghost small" href="https://mapa.onr.org.br/" target="_blank" rel="noopener noreferrer">Abrir Mapa do Registro de Imóveis (ONR)</a></div>
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <div className="spread"><h2>Pré-qualificação</h2><b style={{ fontFamily: 'var(--display)', fontSize: '2.4rem', lineHeight: 1 }}>{p.score}<span className="muted" style={{ fontSize: '1.2rem' }}>/100</span></b></div>
            <table className="data" style={{ marginTop: 6 }}><tbody>{p.score_items.map((s: any) => <tr key={s.label}><td>{s.label}<div className="small muted">{s.note}</div></td><td className="r num">{s.earned}/{s.weight}</td></tr>)}</tbody></table>
          </div>

          <div className="panel">
            <h2 style={{ marginBottom: '0.5rem' }}>Demanda de compradores</h2>
            {p.demand.length === 0 ? <p className="small muted">Nenhum perfil de aquisição compatível com o que se sabe da área. Complete cidade, área e potencial de uso.</p> : p.demand.map((d: any) => (
              <details key={d.profile_id} style={{ borderBottom: '1px solid var(--line-2)', padding: '0.45rem 0' }}>
                <summary className="spread" style={{ cursor: 'pointer' }}><span><b>{d.partner}</b><div className="small muted">{d.profile}</div></span><span className="badge">{d.score}</span></summary>
                <table className="data" style={{ marginTop: 4 }}><tbody>{d.criteria.map((c: any) => <tr key={c.key}><td className="small">{c.label}</td><td className="r small">{c.earned}/{c.weight}</td><td className="small muted">{c.note}</td></tr>)}</tbody></table>
              </details>
            ))}
          </div>

          <div className="panel stack-s">
            <h2>Proprietário (privado)</h2>
            {I('owner_name', 'Nome')}
            <div className="grid2">{I('owner_phone', 'Telefone')}{I('owner_email', 'E-mail')}</div>
            <Field label="Anotações"><textarea disabled={ro} value={p.owner_notes ?? ''} onChange={(e) => upd('owner_notes', e.target.value || null)} style={{ minHeight: 60 }} /></Field>
            <span className="small muted">Base legal: {p.legal_basis ?? 'a definir'}. {p.referred_by ? `Indicação de ${p.referred_by.name}.` : ''}</span>
          </div>

          <div className="panel">
            <h2 style={{ marginBottom: '0.5rem' }}>Documentos da captação</h2>
            {(p.checklist.length ? p.checklist : CAPTURE_CHECKLIST.map((c) => ({ category: c, status: 'pendente' }))).map((c: any, i: number) => (
              <div key={c.category} className="spread" style={{ borderBottom: '1px solid var(--line-2)', padding: '0.4rem 0', flexWrap: 'nowrap' }}>
                <span className="small">{DOC_CATEGORIES[c.category as DocCategory] ?? c.category}</span>
                <select className="input" style={{ width: 150, minHeight: 30, padding: '0.15rem 0.4rem' }} disabled={ro} value={c.status} aria-label={`Situação: ${c.category}`}
                  onChange={(e) => upd('checklist', p.checklist.map((x: any, k: number) => (k === i ? { ...x, status: e.target.value, updated_at: new Date().toISOString() } : x)))}>
                  {Object.entries(CHECKLIST_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            ))}
            <p className="small muted" style={{ margin: '0.5rem 0 0' }}>Os arquivos são anexados na área após a conversão, com versão, validade e confidencialidade.</p>
          </div>

          <div className="panel">
            <h2 style={{ marginBottom: '0.5rem' }}>Histórico</h2>
            {open && p.permissions.update && (
              <form className="stack-s" style={{ marginBottom: '0.8rem' }} onSubmit={async (e) => { e.preventDefault(); try { await api(`/api/prospects/${id}/activities`, { body: act }); setAct({ type: 'call', subject: '', body: '' }); reload(); } catch (er: any) { toast(er.message, true); } }}>
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <select className="input" style={{ width: 'auto' }} value={act.type} onChange={(e) => setAct({ ...act, type: e.target.value })} aria-label="Tipo">{[['call', 'Ligação'], ['visit', 'Visita'], ['meeting', 'Reunião'], ['whatsapp', 'WhatsApp'], ['email', 'E-mail'], ['note', 'Nota']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                  <input className="input" required placeholder="O que aconteceu" value={act.subject} onChange={(e) => setAct({ ...act, subject: e.target.value })} aria-label="Assunto" />
                </div>
                <div><button className="btn small">Registrar</button></div>
              </form>
            )}
            <div className="timeline">{p.activities.map((a: any) => <div key={a.id} className={a.type === 'system' || a.type === 'stage_change' ? 'sys' : ''}><b>{a.subject}</b> <span className="small muted">{new Date(a.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{a.user_name ? ` · ${a.user_name}` : ''}</span>{a.body && <div className="small muted">{a.body}</div>}</div>)}</div>
          </div>
        </div>
      </div>

      {discard && (
        <Modal title="Descartar prospecção" onClose={() => setDiscard(false)}>
          <form className="stack" onSubmit={async (e) => { e.preventDefault(); const reason = (e.currentTarget.elements.namedItem('reason') as HTMLInputElement).value; try { await api(`/api/prospects/${id}/discard`, { body: { reason } }); setDiscard(false); reload(); } catch (er: any) { toast(er.message, true); } }}>
            <Field label="Motivo"><input name="reason" required minLength={3} placeholder="Ex.: proprietário não quer vender; área com restrição ambiental" /></Field>
            <div className="row"><button className="btn danger">Descartar</button><button type="button" className="btn ghost" onClick={() => setDiscard(false)}>Cancelar</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}
