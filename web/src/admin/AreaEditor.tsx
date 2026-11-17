import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  APPROVAL_STAGES, CONFIDENTIALITY, DOC_CATEGORIES, LAND_STATUS, LAND_TYPES, MODALITIES, PUBLICATION_STATUS, ROLES, TECHNICAL_KEYS, UFS, VALIDATION_STATUS, VIABILITY,
  formatArea, formatBRL, type Confidentiality, type DocCategory, type PublicationStatus, type Role, type TechnicalKey,
} from '@dl/shared';
import { api, ApiError, NEW_TAB, openFile } from '../lib/api';
import { useSession } from '../lib/session';
import DrawMap from '../components/DrawMap';
import { ErrorBox, Field, Loading, Modal, ValidationBadge, useAsync, useToast } from '../components/ui';
import { pubBadge } from './Areas';
import { techValue } from '../public/Detail';
import OverlapPanel from '../components/OverlapPanel';
import EnvironmentPanel from '../components/EnvironmentPanel';
import { EarthTools, Google3DView } from '../components/EarthTools';

const STEPS = ['Identificação', 'Localização e perímetro', 'Urbanístico e técnico', 'Condições comerciais', 'Proprietários e documentos', 'Imagens', 'Responsável e publicação', 'Compradores compatíveis'];

type Pending = { fields: Record<string, any>; terms: Record<string, any>; publication: Record<string, any>; technical: Record<string, any> };
const emptyPending = (): Pending => ({ fields: {}, terms: {}, publication: {}, technical: {} });
const numOrNull = (v: string) => (v === '' || v == null ? null : Number(String(v).replace(/\./g, '').replace(',', '.')));

export default function AreaEditor() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const toast = useToast();
  const [o, setO] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<{ state: 'idle' | 'saving' | 'saved' | 'error' | 'conflict'; at?: string; msg?: string }>({ state: 'idle' });
  const pending = useRef<Pending>(emptyPending());
  const timer = useRef<number | undefined>(undefined);
  const version = useRef(0);
  const step = Math.min(STEPS.length, Math.max(1, Number(params.get('etapa') ?? 1)));
  const editable = can('opportunity', 'update');

  const load = useCallback(async () => {
    try {
      const r = await api(`/api/opportunities/${id}`);
      version.current = r.version;
      setO(r);
    } catch (e: any) { setError(e.message); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const flush = useCallback(async () => {
    const p = pending.current;
    const has = Object.values(p).some((x) => Object.keys(x).length);
    if (!has) return;
    pending.current = emptyPending();
    setSave({ state: 'saving' });
    const body: any = { version: version.current, draft_step: step };
    for (const k of ['fields', 'terms', 'publication', 'technical'] as const) if (Object.keys(p[k]).length) body[k] = p[k];
    try {
      const r = await api(`/api/opportunities/${id}`, { method: 'PATCH', body });
      version.current = r.version;
      setSave({ state: 'saved', at: new Date(r.saved_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) });
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409) setSave({ state: 'conflict', msg: e.message });
      else {
        // devolve ao pendente para nova tentativa
        for (const k of ['fields', 'terms', 'publication', 'technical'] as const) pending.current[k] = { ...p[k], ...pending.current[k] };
        setSave({ state: 'error', msg: e.message + (e.details ? ` (${e.details.map?.((d: any) => d.path).join(', ')})` : '') });
      }
    }
  }, [id, step]);

  const update = (section: keyof Pending, key: string, value: any, local?: any) => {
    pending.current[section][key] = value;
    setO((prev: any) => {
      if (section === 'fields') return { ...prev, [key]: local ?? value };
      if (section === 'terms') return { ...prev, terms: { ...prev.terms, [key]: local ?? value } };
      if (section === 'publication') return { ...prev, publication: { ...prev.publication, [key]: local ?? value } };
      return { ...prev, technical: { ...prev.technical, [key]: { ...prev.technical[key], ...value } } };
    });
    setSave({ state: 'saving' });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 900);
  };
  useEffect(() => () => { window.clearTimeout(timer.current); void flush(); }, [flush]);

  const goStep = async (n: number) => { window.clearTimeout(timer.current); await flush(); setParams({ etapa: String(n) }); window.scrollTo(0, 0); };

  if (error) return <ErrorBox error={error} />;
  if (!o) return <Loading />;
  if (!editable) return <ReadOnlyArea o={o} reload={load} />;

  const F = (key: string, label: string, props: any = {}) => (
    <Field label={label} hint={props.hint}>
      <input value={o[key] ?? ''} onChange={(e) => update('fields', key, props.num ? numOrNull(e.target.value) : e.target.value || null, e.target.value)} inputMode={props.num ? 'decimal' : undefined} maxLength={props.max} />
    </Field>
  );
  const T = (key: string, label: string, props: any = {}) => (
    <Field label={label} hint={props.hint}>
      <input value={o.terms?.[key] ?? ''} onChange={(e) => update('terms', key, props.num ? numOrNull(e.target.value) : e.target.value || null, e.target.value)} inputMode={props.num ? 'decimal' : undefined} />
    </Field>
  );

  return (
    <>
      <div className="spread" style={{ marginBottom: '1.25rem', alignItems: 'start' }}>
        <div>
          <div className="row small muted"><Link to="/painel/areas">Banco de áreas</Link><span>/</span><span>{o.code}</span></div>
          <h1 style={{ fontFamily: 'var(--display)', fontWeight: 400, fontSize: '2.3rem', lineHeight: 1, marginTop: 4 }}>{o.public_title || o.internal_name}</h1>
          <div className="row" style={{ marginTop: 6 }}>
            <span className={`badge ${pubBadge[o.publication_status]}`}>{PUBLICATION_STATUS[o.publication_status as PublicationStatus]}</span>
            <span className="badge">{LAND_STATUS[o.status as keyof typeof LAND_STATUS]}</span>
            {o.area_m2 && <span className="muted small">{formatArea(o.area_m2)}</span>}
          </div>
        </div>
        <div className="row">
          <span className="savestate" aria-live="polite">
            {save.state === 'saving' && 'Salvando rascunho…'}
            {save.state === 'saved' && `Rascunho salvo às ${save.at}`}
            {save.state === 'error' && <span className="error-text">Não salvo: {save.msg}</span>}
            {save.state === 'conflict' && <span className="error-text">{save.msg} <button className="btn link small" onClick={() => { pending.current = emptyPending(); setSave({ state: 'idle' }); void load(); }}>Recarregar</button></span>}
          </span>
          {o.publication_status === 'published' && <Link className="btn ghost small" to={`/areas/${o.slug}`} target={NEW_TAB}>Ver no portal</Link>}
        </div>
      </div>

      <div className="editor">
        <nav className="stepper" aria-label="Etapas do cadastro">
          {STEPS.map((s, i) => (
            <button key={s} aria-current={step === i + 1 ? 'step' : undefined} className={i + 1 < Math.max(o.draft_step, step) ? 'done' : ''} onClick={() => goStep(i + 1)}>{s}</button>
          ))}
        </nav>
        <div className="stack">
          {/* Vista 3D logo na abertura da área (antes ficava só na etapa 2) */}
          {step === 1 && o.lat != null && (
            <div className="panel stack">
              <h2>Vista 3D</h2>
              <Google3DView lat={o.lat} lng={o.lng} areaM2={o.geometry?.area_m2 ?? o.area_m2} geometry={o.geometry?.geometry} name={o.code} />
              {!o.geometry && <p className="small muted" style={{ margin: 0 }}>Sem perímetro: a vista mostra o ponto. Desenhe ou importe o perímetro na etapa 2 para vê-lo em 3D.</p>}
            </div>
          )}
          {step === 1 && (
            <div className="panel stack">
              <h2>Identificação</h2>
              <div className="grid2">
                {F('internal_name', 'Nome interno', { hint: 'Visível só para a equipe', max: 160 })}
                {F('public_title', 'Título comercial público', { hint: 'Como aparece no portal', max: 140 })}
                <Field label="Tipo"><select value={o.type ?? ''} onChange={(e) => update('fields', 'type', e.target.value)}>{Object.entries(LAND_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
                <Field label="Situação"><select value={o.status} onChange={(e) => update('fields', 'status', e.target.value)}>{Object.entries(LAND_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              </div>
              <div className="grid4">
                <Field label="UF"><select value={o.uf} onChange={(e) => update('fields', 'uf', e.target.value)}>{UFS.map((u) => <option key={u}>{u}</option>)}</select></Field>
                {F('city', 'Cidade')}
                {F('neighborhood', 'Bairro / setor')}
                {F('region', 'Região')}
              </div>
              {can('exact_location', 'update') && F('address', 'Endereço ou referência de acesso', { hint: 'Exibido no portal somente com localização exata' })}
              <div className="grid4">
                {F('area_m2', 'Área total (m²)', { num: true, hint: o.area_m2 ? `${(o.area_m2 / 10000).toLocaleString('pt-BR')} ha` : 'Preenchida pelo perímetro se vazia' })}
                {F('usable_area_m2', 'Área aproveitável estimada (m²)', { num: true })}
                {F('frontage_m', 'Testada (m)', { num: true })}
                {F('depth_m', 'Profundidade (m)', { num: true })}
              </div>
              {F('topography', 'Topografia')}
              <Field label="Resumo para o portal" hint={`${(o.summary ?? '').length}/400`}><textarea maxLength={400} value={o.summary ?? ''} onChange={(e) => update('fields', 'summary', e.target.value || null)} style={{ minHeight: 70 }} /></Field>
              <Field label="Descrição estratégica"><textarea value={o.strategic_description ?? ''} onChange={(e) => update('fields', 'strategic_description', e.target.value || null)} style={{ minHeight: 140 }} /></Field>
              <AiDescription id={o.id} onUse={(t) => update('fields', 'strategic_description', t)} />
            </div>
          )}

          {step === 2 && (
            <div className="panel stack">
              <h2>Localização e perímetro</h2>
              <p className="muted small" style={{ margin: 0 }}>Desenhe o perímetro ou importe o arquivo do levantamento. A área e o perímetro são recalculados no PostGIS sobre o elipsoide; cada salvamento cria uma nova versão.</p>
              {o.geometry && <p className="small">Perímetro atual: <b>{formatArea(o.geometry.area_m2)}</b>, {Math.round(o.geometry.perimeter_m).toLocaleString('pt-BR')} m de perímetro · versão {o.geometry.version} · origem {o.geometry.source.toUpperCase()}</p>}
              <DrawMap importUrl={`/api/opportunities/${o.id}/geometry/import`} initial={o.geometry?.geometry ?? null} center={o.lng != null ? [o.lng, o.lat] : null} saving={save.state === 'saving'} onSave={async (geojson, source) => {
                try {
                  await flush();
                  const g = await api(`/api/opportunities/${o.id}/geometry`, { method: 'PUT', body: { geojson, source } });
                  toast(`Perímetro salvo: ${formatArea(g.area_m2)}`);
                  await load();
                } catch (e: any) { toast(e.message, true); }
              }} />
              {o.lat != null && <EarthTools lat={o.lat} lng={o.lng} areaM2={o.geometry?.area_m2 ?? o.area_m2} name={`${o.code} — ${o.public_title || o.internal_name}`} geometry={o.geometry?.geometry} kmlUrl={`/api/opportunities/${o.id}/kml`} />}
              <div className="grid2">
                <Field label="Latitude" hint="Preenchida pelo perímetro; ajuste só se não houver perímetro"><input inputMode="decimal" value={o.lat ?? ''} onChange={(e) => update('fields', 'lat', numOrNull(e.target.value), e.target.value)} /></Field>
                <Field label="Longitude"><input inputMode="decimal" value={o.lng ?? ''} onChange={(e) => update('fields', 'lng', numOrNull(e.target.value), e.target.value)} /></Field>
              </div>
            </div>
          )}

          {step === 2 && o.geometry && <OverlapPanel url={`/api/opportunities/${o.id}/overlap`} />}
          {step === 2 && o.geometry && <EnvironmentPanel url={`/api/opportunities/${o.id}/environment`} onApply={async (m2) => { update('fields', 'usable_area_m2', m2, String(m2)); toast(`Área aproveitável atualizada: ${formatArea(m2)}`); }} />}
          {step === 2 && o.lat != null && <Google3DView lat={o.lat} lng={o.lng} areaM2={o.geometry?.area_m2} geometry={o.geometry?.geometry} name={o.code} />}
          {step === 3 && <TechnicalStep o={o} update={update} />}

          {step === 4 && (
            <div className="panel stack">
              <h2>Condições comerciais</h2>
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="small" style={{ marginBottom: 6, color: 'var(--ink-2)' }}>Modalidades</legend>
                <div className="chips">
                  {Object.entries(MODALITIES).map(([k, l]) => {
                    const on = (o.terms?.modalities ?? []).includes(k);
                    return <button type="button" key={k} className="chip" aria-pressed={on} onClick={() => update('terms', 'modalities', on ? o.terms.modalities.filter((x: string) => x !== k) : [...(o.terms?.modalities ?? []), k])}>{l}</button>;
                  })}
                </div>
              </fieldset>
              <div className="grid3">
                {T('asking_price', 'Valor pedido (R$)', { num: true, hint: o.terms?.asking_price ? formatBRL(o.terms.asking_price) : undefined })}
                <Field label="Valor por m²"><input disabled value={o.terms?.asking_price && o.area_m2 ? formatBRL(o.terms.asking_price / o.area_m2) : '—'} /></Field>
                {T('swap_pct', 'Permuta pretendida (%)', { num: true })}
                {T('down_payment', 'Entrada ou aporte (R$)', { num: true })}
                {T('expected_units', 'Expectativa de unidades', { num: true, hint: 'Estimativa — exibida com essa ressalva' })}
                {T('vgv_preliminary', 'VGV preliminar (R$)', { num: true, hint: 'Estimativa' })}
                {T('constructive_potential_m2', 'Potencial construtivo estimado (m²)', { num: true })}
              </div>
              <Field label="Condições de pagamento"><textarea value={o.terms?.payment_terms ?? ''} onChange={(e) => update('terms', 'payment_terms', e.target.value || null)} /></Field>
              <div className="row">
                <label className="check"><input type="checkbox" checked={!!o.terms?.negotiable} onChange={(e) => update('terms', 'negotiable', e.target.checked)} /> Aceita negociação</label>
                <label className="check"><input type="checkbox" checked={!!o.terms?.exclusivity} onChange={(e) => update('terms', 'exclusivity', e.target.checked)} /> Exclusividade Dourado</label>
                {o.terms?.exclusivity && <Field label="Exclusividade até"><input type="date" value={o.terms?.exclusivity_until ?? ''} onChange={(e) => update('terms', 'exclusivity_until', e.target.value || null)} /></Field>}
              </div>
              {can('commission', 'update') && (
                <div className="panel" style={{ background: 'var(--paper)' }}>
                  <h3 style={{ fontSize: '0.95rem', marginBottom: '0.6rem' }}>Comissionamento (confidencial)</h3>
                  <div className="grid3">
                    {T('commission_total_pct', 'Comissão total (%)', { num: true })}
                  </div>
                  <CommissionSplit value={o.terms?.commission_split ?? []} onChange={(v) => update('terms', 'commission_split', v)} />
                  <p className="small muted" style={{ margin: '0.5rem 0 0' }}>A distribuição é uma referência. A comissão só se torna devida conforme o contrato de intermediação e o evento contratual.</p>
                </div>
              )}
              <Field label="Observações comerciais internas"><textarea value={o.terms?.internal_notes ?? ''} onChange={(e) => update('terms', 'internal_notes', e.target.value || null)} /></Field>
            </div>
          )}

          {step === 5 && <OwnersDocs o={o} reload={load} />}
          {step === 6 && <MediaStep o={o} reload={load} />}
          {step === 7 && <PublishStep o={o} reload={load} update={update} flush={flush} />}
          {step === 8 && <MatchesStep o={o} />}

          <div className="spread">
            <button className="btn ghost" disabled={step === 1} onClick={() => goStep(step - 1)}>Etapa anterior</button>
            {step < STEPS.length && <button className="btn" onClick={() => goStep(step + 1)}>Próxima etapa: {STEPS[step]}</button>}
          </div>
        </div>
      </div>
    </>
  );
}

function AiDescription({ id, onUse }: { id: string; onUse: (t: string) => void }) {
  const [s, setS] = useState<{ text: string; origin: string; label: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <button type="button" className="btn ghost small" disabled={busy} onClick={async () => { setBusy(true); try { setS(await api(`/api/ai/opportunities/${id}/description`, { method: 'POST' })); } finally { setBusy(false); } }}>
        {busy ? 'Gerando…' : 'Sugerir descrição a partir dos dados'}
      </button>
      {s && (
        <div className="notice" style={{ marginTop: '0.6rem' }}>
          <p className="small" style={{ margin: '0 0 0.4rem' }}><b>{s.label}</b> · origem: {s.origin === 'heuristic' ? 'regras sobre os dados cadastrados' : s.origin}</p>
          <p style={{ margin: '0 0 0.6rem' }}>{s.text}</p>
          <div className="row">
            <button className="btn small" onClick={() => { onUse(s.text); void api(`/api/ai/suggestions/${s.id}/accept`, { method: 'POST' }); setS(null); }}>Usar na descrição estratégica</button>
            <button className="btn link small" onClick={() => { void api(`/api/ai/suggestions/${s.id}/reject`, { method: 'POST' }); setS(null); }}>Descartar</button>
          </div>
        </div>
      )}
    </div>
  );
}

function CommissionSplit({ value, onChange }: { value: { party: string; pct: number }[]; onChange: (v: any[]) => void }) {
  const total = value.reduce((s, x) => s + (Number(x.pct) || 0), 0);
  return (
    <div className="stack-s" style={{ marginTop: '0.6rem' }}>
      {value.map((x, i) => (
        <div className="row" key={i}>
          <input className="input" style={{ flex: 2 }} aria-label="Participante" value={x.party} onChange={(e) => onChange(value.map((y, k) => (k === i ? { ...y, party: e.target.value } : y)))} />
          <input className="input" style={{ width: 90 }} aria-label="Percentual" inputMode="decimal" value={x.pct} onChange={(e) => onChange(value.map((y, k) => (k === i ? { ...y, pct: Number(e.target.value.replace(',', '.')) || 0 } : y)))} />
          <span className="small">%</span>
          <button className="btn link small" onClick={() => onChange(value.filter((_, k) => k !== i))}>Remover</button>
        </div>
      ))}
      <div className="row"><button className="btn ghost small" onClick={() => onChange([...value, { party: '', pct: 0 }])}>Adicionar participante</button><span className="small muted">Soma: {total}%</span></div>
    </div>
  );
}

function TechnicalStep({ o, update }: { o: any; update: (s: any, k: string, v: any) => void }) {
  const gaps = useAsync(() => api(`/api/ai/opportunities/${o.id}/gaps`), [o.id]);
  const today = new Date().toISOString().slice(0, 10);
  const setItem = (k: string, patch: any) => {
    const cur = o.technical[k] ?? {};
    const merged = { value: cur.value ?? null, source: cur.source ?? null, consulted_at: cur.consulted_at ?? today, responsible: cur.responsible ?? null, validation_status: cur.validation_status ?? 'nao_verificado', ...patch };
    update('technical', k, merged);
  };
  return (
    <div className="panel">
      <h2>Informações urbanísticas e técnicas</h2>
      <p className="muted small">Cada parâmetro guarda fonte, data de consulta, responsável e status. Só "Documento oficial" e "Verificado" contam como confirmados no matching e no portal.</p>
      {gaps.data?.items.length > 0 && (
        <details className="notice" style={{ margin: '0.75rem 0' }}>
          <summary><b>{gaps.data.items.length} pontos de atenção</b> identificados automaticamente</summary>
          <ul className="small" style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>{gaps.data.items.map((g: any, i: number) => <li key={i}><b>{g.field}</b> — {g.reason} <span className={`badge ${g.severity === 'alta' ? 'bad' : 'warn'}`}>{g.severity}</span></li>)}</ul>
        </details>
      )}
      {(Object.entries(TECHNICAL_KEYS) as [TechnicalKey, any][]).map(([k, def]) => {
        const item = o.technical[k] ?? {};
        let input;
        if (def.kind === 'bool') input = <select value={item.value == null ? '' : String(item.value)} onChange={(e) => setItem(k, { value: e.target.value === '' ? null : e.target.value === 'true' })}><option value="">Não informado</option><option value="true">Sim</option><option value="false">Não</option></select>;
        else if (def.kind === 'enum') input = <select value={item.value ?? ''} onChange={(e) => setItem(k, { value: e.target.value || null })}><option value="">Não informado</option>{def.options.map((x: string) => <option key={x} value={x}>{k === 'estagio_aprovacao' ? APPROVAL_STAGES[x as keyof typeof APPROVAL_STAGES] : techValue(k, x)}</option>)}</select>;
        else if (def.kind === 'multi') input = <div className="chips">{Object.entries(VIABILITY).map(([vk, vl]) => { const on = (item.value ?? []).includes(vk); return <button type="button" key={vk} className="chip" aria-pressed={on} onClick={() => setItem(k, { value: on ? item.value.filter((x: string) => x !== vk) : [...(item.value ?? []), vk] })}>{vl}</button>; })}</div>;
        else input = <input inputMode={def.kind === 'number' ? 'decimal' : undefined} value={item.value ?? ''} onChange={(e) => setItem(k, { value: e.target.value === '' ? null : def.kind === 'number' ? Number(e.target.value.replace(',', '.')) : e.target.value })} />;
        return (
          <div key={k} className="tech-row" style={def.kind === 'multi' ? { gridTemplateColumns: '1fr' } : undefined}>
            <label className="field"><span>{def.label}</span>{input}</label>
            {item.value != null && item.value !== '' && (
              <>
                <Field label="Fonte"><input value={item.source ?? ''} placeholder="Ex.: certidão de uso do solo" onChange={(e) => setItem(k, { source: e.target.value || null })} /></Field>
                <div className="grid2" style={{ gap: '0.5rem' }}>
                  <Field label="Consulta"><input type="date" value={item.consulted_at ?? ''} onChange={(e) => setItem(k, { consulted_at: e.target.value || null })} /></Field>
                  <Field label="Responsável"><input value={item.responsible ?? ''} onChange={(e) => setItem(k, { responsible: e.target.value || null })} /></Field>
                </div>
                <Field label="Status"><select value={item.validation_status ?? 'nao_verificado'} onChange={(e) => setItem(k, { validation_status: e.target.value })}>{Object.entries(VALIDATION_STATUS).map(([s, l]) => <option key={s} value={s}>{l}</option>)}</select></Field>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function OwnersDocs({ o, reload }: { o: any; reload: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [owner, setOwner] = useState<any>(null);
  const [doc, setDoc] = useState<{ group_id?: string; title?: string; category?: string } | null>(null);
  const [versions, setVersions] = useState<any[] | null>(null);
  const openDoc = async (docId: string) => { try { const r = await api(`/api/documents/${docId}/url`); openFile(r.url, toast); } catch (e: any) { toast(e.message, true); } };
  return (
    <>
      {can('owner_data', 'read') && (
        <div className="panel">
          <div className="panel-head"><h2>Proprietários e representantes (privado)</h2><button className="btn ghost small" onClick={() => setOwner({ kind: 'pf' })}>Adicionar proprietário</button></div>
          {o.owners.length === 0 ? <p className="muted small">Nenhum proprietário cadastrado.</p> : (
            <table className="data"><thead><tr><th>Nome</th><th>Tipo</th><th>CPF/CNPJ</th><th>Contato</th><th>Participação</th><th /></tr></thead>
              <tbody>{o.owners.map((x: any) => (
                <tr key={x.id}><td>{x.name}{x.representative && <div className="small muted">Rep.: {x.representative}</div>}</td><td>{x.kind === 'pj' ? 'Pessoa jurídica' : 'Pessoa física'}</td><td className="num">{x.document ?? '—'}</td><td className="small">{x.email}<br />{x.phone}</td><td>{x.share_pct ? `${x.share_pct}%` : '—'}</td>
                  <td><button className="btn link small" onClick={async () => { await api(`/api/opportunities/${o.id}/owners/${x.id}`, { method: 'DELETE' }); reload(); }}>Remover</button></td></tr>
              ))}</tbody></table>
          )}
          <p className="small muted" style={{ margin: '0.6rem 0 0' }}>CPF/CNPJ ficam criptografados no banco. Estes dados nunca aparecem no portal nem para intermediadores.</p>
        </div>
      )}
      <div className="panel">
        <div className="panel-head"><h2>Documentos</h2>{can('document', 'create') && <button className="btn ghost small" onClick={() => setDoc({})}>Enviar documento</button>}</div>
        {o.documents.length === 0 ? <p className="muted small">Nenhum documento enviado.</p> : (
          <table className="data"><thead><tr><th>Documento</th><th>Categoria</th><th>Classificação</th><th>Versão</th><th>Validade</th><th /></tr></thead>
            <tbody>{o.documents.map((d: any) => {
              const expired = d.valid_until && new Date(d.valid_until) < new Date();
              const soon = d.valid_until && !expired && new Date(d.valid_until).getTime() - Date.now() < 30 * 86400_000;
              return (
                <tr key={d.id}>
                  <td>{d.title}<div className="small muted">{d.original_name} · {Math.ceil(d.size / 1024)} KB</div></td>
                  <td className="small">{DOC_CATEGORIES[d.category as DocCategory]}</td>
                  <td>{can('document', 'update') ? (
                    <select className="input" style={{ minHeight: 30, padding: '0.2rem 0.4rem' }} value={d.confidentiality} onChange={async (e) => { await api(`/api/opportunities/${o.id}/documents/${d.id}`, { method: 'PATCH', body: { confidentiality: e.target.value } }); toast('Classificação atualizada'); reload(); }}>
                      {Object.entries(CONFIDENTIALITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>) : CONFIDENTIALITY[d.confidentiality as Confidentiality]}</td>
                  <td><button className="btn link small" onClick={async () => setVersions((await api(`/api/opportunities/${o.id}/documents/${d.group_id}/versions`)).items)}>v{d.version}</button></td>
                  <td>{d.valid_until ? <span className={`badge ${expired ? 'bad' : soon ? 'warn' : ''}`}>{expired ? 'Vencido em ' : ''}{new Date(d.valid_until + 'T12:00').toLocaleDateString('pt-BR')}</span> : '—'}</td>
                  <td className="row" style={{ gap: 6 }}><button className="btn ghost small" onClick={() => openDoc(d.id)}>Abrir</button>{can('document', 'create') && <button className="btn link small" onClick={() => setDoc({ group_id: d.group_id, title: d.title, category: d.category })}>Nova versão</button>}</td>
                </tr>
              );
            })}</tbody></table>
        )}
        <p className="small muted" style={{ margin: '0.6rem 0 0' }}>Arquivos abrem por link temporário (10 minutos) e cada acesso fica registrado. Somente documentos "Público" aparecem no portal.</p>
      </div>
      {owner && <OwnerModal oppId={o.id} onClose={() => setOwner(null)} onSaved={() => { setOwner(null); reload(); }} />}
      {doc && <DocModal oppId={o.id} preset={doc} onClose={() => setDoc(null)} onSaved={() => { setDoc(null); reload(); }} />}
      {versions && (
        <Modal title="Versões do documento" onClose={() => setVersions(null)}>
          <table className="data"><thead><tr><th>Versão</th><th>Arquivo</th><th>Enviado em</th><th>SHA-256</th></tr></thead>
            <tbody>{versions.map((v) => <tr key={v.id}><td>v{v.version}{v.is_current && <span className="badge ok" style={{ marginLeft: 6 }}>Atual</span>}</td><td className="small">{v.original_name}<br /><button className="btn link small" onClick={() => openDoc(v.id)}>Abrir</button></td><td className="small">{new Date(v.created_at).toLocaleString('pt-BR')}</td><td className="small muted" style={{ wordBreak: 'break-all' }}>{v.sha256.slice(0, 16)}…</td></tr>)}</tbody></table>
        </Modal>
      )}
    </>
  );
}

function OwnerModal({ oppId, onClose, onSaved }: { oppId: string; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>({ kind: 'pf' });
  const [err, setErr] = useState('');
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Adicionar proprietário" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); try { await api(`/api/opportunities/${oppId}/owners`, { body: { ...f, share_pct: f.share_pct ? Number(f.share_pct) : null } }); onSaved(); } catch (er: any) { setErr(er.message); } }}>
        <div className="grid2">
          <Field label="Tipo"><select value={f.kind} onChange={set('kind')}><option value="pf">Pessoa física</option><option value="pj">Pessoa jurídica</option></select></Field>
          <Field label={f.kind === 'pj' ? 'CNPJ' : 'CPF'}><input onChange={set('document')} /></Field>
        </div>
        <Field label="Nome ou razão social"><input required onChange={set('name')} /></Field>
        <Field label="Representante"><input onChange={set('representative')} /></Field>
        <div className="grid3"><Field label="E-mail"><input type="email" onChange={set('email')} /></Field><Field label="Telefone"><input onChange={set('phone')} /></Field><Field label="Participação (%)"><input inputMode="decimal" onChange={set('share_pct')} /></Field></div>
        {err && <p className="error-text">{err}</p>}
        <div className="row"><button className="btn">Salvar proprietário</button><button type="button" className="btn ghost" onClick={onClose}>Cancelar</button></div>
      </form>
    </Modal>
  );
}

function DocModal({ oppId, preset, onClose, onSaved }: { oppId: string; preset: any; onClose: () => void; onSaved: () => void }) {
  const { me } = useSession();
  const [f, setF] = useState<any>({ category: preset.category ?? 'matricula', title: preset.title ?? '', confidentiality: 'confidential', valid_until: '' });
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={preset.group_id ? `Nova versão: ${preset.title}` : 'Enviar documento'} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault(); if (!file) { setErr('Selecione o arquivo'); return; }
        setBusy(true); setErr('');
        const fd = new FormData();
        Object.entries(f).forEach(([k, v]) => fd.append(k, String(v ?? '')));
        if (preset.group_id) fd.append('group_id', preset.group_id);
        fd.append('file', file);
        try { await api(`/api/opportunities/${oppId}/documents`, { form: fd }); onSaved(); } catch (er: any) { setErr(er.message); setBusy(false); }
      }}>
        {!preset.group_id && <>
          <Field label="Categoria"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value, title: f.title || DOC_CATEGORIES[e.target.value as DocCategory] })}>{Object.entries(DOC_CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Título"><input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        </>}
        <div className="grid2">
          {me?.user.role !== 'owner' && <Field label="Classificação"><select value={f.confidentiality} onChange={(e) => setF({ ...f, confidentiality: e.target.value })}>{Object.entries(CONFIDENTIALITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>}
          <Field label="Validade (se houver)"><input type="date" value={f.valid_until} onChange={(e) => setF({ ...f, valid_until: e.target.value })} /></Field>
        </div>
        <Field label="Arquivo" hint="PDF, imagens, DOCX, XLSX, KML, KMZ, GeoJSON ou SHP (.zip). Até 40 MB."><input type="file" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        {err && <p className="error-text">{err}</p>}
        <div className="row"><button className="btn" disabled={busy}>{busy ? 'Enviando…' : 'Enviar documento'}</button><button type="button" className="btn ghost" onClick={onClose}>Cancelar</button></div>
      </form>
    </Modal>
  );
}

function MediaStep({ o, reload }: { o: any; reload: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    const fd = new FormData();
    [...files].slice(0, 12).forEach((f) => fd.append('files', f));
    try { await api(`/api/opportunities/${o.id}/media`, { form: fd }); toast('Imagens enviadas'); reload(); } catch (e: any) { toast(e.message, true); }
    setBusy(false);
  };
  return (
    <div className="panel stack">
      <h2>Imagens</h2>
      <label className="dropzone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}>
        <input type="file" multiple accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => upload(e.target.files)} />
        {busy ? 'Enviando e otimizando…' : 'Arraste fotos aqui ou clique para escolher (JPG, PNG ou WebP). Metadados de localização são removidos.'}
      </label>
      <div className="media-grid">
        {o.media.map((m: any) => (
          <figure key={m.id}>
            <img src={m.url} alt={m.caption ?? ''} />
            <figcaption>
              <input className="input" style={{ minHeight: 28, padding: '0.15rem 0.35rem', fontSize: '0.8rem' }} defaultValue={m.caption ?? ''} placeholder="Legenda" aria-label="Legenda"
                onBlur={(e) => e.target.value !== (m.caption ?? '') && api(`/api/opportunities/${o.id}/media/${m.id}`, { method: 'PATCH', body: { caption: e.target.value || null } })} />
            </figcaption>
            <figcaption>
              {m.is_cover ? <span className="badge ok">Capa</span> : <button className="btn link small" onClick={async () => { await api(`/api/opportunities/${o.id}/media/${m.id}`, { method: 'PATCH', body: { is_cover: true } }); reload(); }}>Usar como capa</button>}
              <button className="btn link small" onClick={async () => { await api(`/api/opportunities/${o.id}/media/${m.id}`, { method: 'DELETE' }); reload(); }}>Excluir</button>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

function PublishStep({ o, reload, update, flush }: { o: any; reload: () => void; update: (s: any, k: string, v: any) => void; flush: () => Promise<void> }) {
  const { can } = useSession();
  const toast = useToast();
  const brokers = useAsync(() => api('/api/admin/brokers'), []);
  const history = useAsync(() => api(`/api/opportunities/${o.id}/assignments/history`), [o.id]);
  const [notes, setNotes] = useState('');
  const pub = o.publication ?? {};
  const primary = o.assignments.find((a: any) => a.role === 'primary');
  const act = async (fn: () => Promise<any>, msg: string) => { try { await flush(); await fn(); toast(msg); reload(); } catch (e: any) { toast(e.details?.missing ? `Pendências: ${e.details.missing.join(', ')}` : e.message, true); } };

  return (
    <>
      <div className="panel stack">
        <h2>Intermediador responsável</h2>
        <div className="row">
          <select className="input" style={{ maxWidth: 360 }} value={primary?.broker_id ?? ''} disabled={!can('routing', 'update')} aria-label="Intermediador"
            onChange={(e) => {
              // lê o valor já: act() salva a área antes, a tela redesenha e a lista volta ao valor anterior
              const brokerId = e.target.value;
              if (brokerId) void act(() => api(`/api/opportunities/${o.id}/assignments`, { body: { broker_id: brokerId, role: 'primary', reason: primary ? 'Substituição pelo painel' : 'Atribuição inicial' } }), 'Intermediador atualizado').then(history.reload);
            }}>
            <option value="">Sem responsável — interesses vão para a central</option>
            {brokers.data?.items.filter((b: any) => b.active && b.user_active !== false).map((b: any) => <option key={b.id} value={b.id}>{b.name}{b.role && b.role !== 'broker' ? ` — ${ROLES[b.role as Role]}` : ''}{b.creci_status !== 'ativo' ? ' (CRECI não validado)' : ''}</option>)}
          </select>
          {primary && <span className="small muted">{primary.whatsapp ? `WhatsApp ${primary.whatsapp}` : 'Sem WhatsApp cadastrado'}</span>}
        </div>
        {primary && (primary.creci_status !== 'ativo' || !primary.whatsapp) && (
          <p className="notice" style={{ margin: 0 }}>
            {primary.creci_status !== 'ativo' && <>O CRECI de {primary.name} ainda não foi validado. A publicação é permitida, mas a comissão só pode ser lançada com CRECI ativo. </>}
            {!primary.whatsapp && <>Sem WhatsApp, os interessados desta área vão para o número central. </>}
            {can('user', 'update') ? <Link to="/painel/usuarios">Atualizar em Usuários → Gerenciar</Link> : 'Peça a um administrador para atualizar o cadastro.'}
          </p>
        )}
        {can('user', 'update') && <p className="small muted" style={{ margin: 0 }}>Administradores e gestores aparecem nesta lista quando marcados como "também atua como intermediador" em <Link to="/painel/usuarios">Usuários</Link>.</p>}
        {history.data?.items.length > 1 && (
          <details><summary className="small">Histórico de atribuições ({history.data.items.length})</summary>
            <div className="timeline small" style={{ marginTop: '0.5rem' }}>{history.data.items.map((h: any) => <div key={h.id}><b>{h.broker_name}</b> — {new Date(h.created_at).toLocaleDateString('pt-BR')}{h.ended_at ? ` a ${new Date(h.ended_at).toLocaleDateString('pt-BR')}` : ' (atual)'}{h.reason ? ` · ${h.reason}` : ''}{h.assigned_by_name ? ` · por ${h.assigned_by_name}` : ''}</div>)}</div>
          </details>
        )}
      </div>

      <div className="panel stack">
        <h2>O que o portal pode mostrar</h2>
        <div className="grid2">
          <div className="stack-s">
            <label className="check"><input type="checkbox" checked={!!pub.show_price} onChange={(e) => update('publication', 'show_price', e.target.checked)} /> Exibir valor pedido e permuta</label>
            <label className="check"><input type="checkbox" checked={!!pub.show_price_per_m2} onChange={(e) => update('publication', 'show_price_per_m2', e.target.checked)} /> Exibir valor por m²</label>
            <label className="check"><input type="checkbox" checked={!!pub.show_public_documents} onChange={(e) => update('publication', 'show_public_documents', e.target.checked)} /> Exibir documentos classificados como públicos</label>
            <label className="check"><input type="checkbox" checked={o.visibility === 'private'} onChange={(e) => update('fields', 'visibility', e.target.checked ? 'private' : 'public')} /> Vitrine exclusiva (só parceiros logados)</label>
            {can('publication', 'approve') && <label className="check"><input type="checkbox" checked={!!o.featured} onChange={(e) => update('fields', 'featured', e.target.checked)} /> Destaque na página inicial</label>}
          </div>
          <Field label="Precisão da localização no portal">
            <select value={pub.location_precision ?? 'approximate'} onChange={(e) => update('publication', 'location_precision', e.target.value)}>
              <option value="exact">Perímetro exato e endereço</option>
              <option value="approximate">Aproximada (raio de ~1,2 km, ponto deslocado)</option>
              <option value="region">Somente região (raio de ~6 km)</option>
            </select>
          </Field>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Proprietário, comissão, notas internas e documentos confidenciais nunca são exibidos no portal.</p>
        <Field label="Base jurídica para divulgação (quando não houver documento de autorização)"><textarea value={pub.legal_basis ?? ''} onChange={(e) => update('publication', 'legal_basis', e.target.value || null)} placeholder="Ex.: cláusula 4ª do contrato de intermediação nº …" style={{ minHeight: 60 }} /></Field>
      </div>

      <div className="panel stack">
        <div className="panel-head"><h2>Publicação</h2><span className={`badge ${pubBadge[o.publication_status]}`}>{PUBLICATION_STATUS[o.publication_status as PublicationStatus]}</span></div>
        {o.checklist.length > 0 ? (
          <div className="notice"><b>Antes de enviar para aprovação:</b><ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>{o.checklist.map((c: string) => <li key={c}>{c}</li>)}</ul></div>
        ) : <p className="notice ok" style={{ margin: 0 }}>Cadastro completo para publicação.</p>}
        {pub.review_notes && <p className="notice bad" style={{ margin: 0 }}>Observação da revisão: {pub.review_notes}</p>}
        <div className="row">
          {['draft', 'rejected', 'unpublished'].includes(o.publication_status) && can('publication', 'create') && (
            <button className="btn" disabled={o.checklist.length > 0} onClick={() => act(() => api(`/api/opportunities/${o.id}/submit-review`, { method: 'POST' }), 'Enviada para aprovação')}>Enviar para aprovação</button>
          )}
          {o.publication_status === 'pending_review' && can('publication', 'approve') && <>
            <input className="input" style={{ maxWidth: 320 }} placeholder="Observação (obrigatória para devolver)" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Observação da revisão" />
            <button className="btn gold" onClick={() => act(() => api(`/api/opportunities/${o.id}/review`, { body: { decision: 'approve', notes: notes || undefined } }), 'Área publicada')}>Aprovar e publicar</button>
            <button className="btn danger" disabled={!notes} onClick={() => act(() => api(`/api/opportunities/${o.id}/review`, { body: { decision: 'reject', notes } }), 'Devolvida para ajustes')}>Devolver para ajustes</button>
          </>}
          {o.publication_status === 'pending_review' && !can('publication', 'approve') && <span className="muted">Aguardando aprovação de um administrador.</span>}
          {o.publication_status === 'published' && <>
            <Link className="btn ghost" to={`/areas/${o.slug}`} target={NEW_TAB}>Ver no portal</Link>
            <Link className="btn ghost" to={`/areas/${o.slug}/book`} target={NEW_TAB}>Abrir book</Link>
            {can('publication', 'approve') && <button className="btn danger" onClick={() => act(() => api(`/api/opportunities/${o.id}/unpublish`, { method: 'POST' }), 'Área retirada do portal')}>Retirar do portal</button>}
          </>}
        </div>
      </div>
    </>
  );
}

function MatchesStep({ o }: { o: any }) {
  const toast = useToast();
  const m = useAsync(() => api(`/api/matches?opportunity_id=${o.id}`), [o.id]);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="panel stack">
      <h2>Compradores compatíveis</h2>
      <p className="muted small" style={{ margin: 0 }}>Pontuação por regras explícitas sobre os dados cadastrados. Dados ausentes valem zero e informações não verificadas reduzem o peso.</p>
      {m.data?.items.length === 0 && <p className="muted">Nenhum perfil de aquisição com pontuação mínima de 40.</p>}
      {m.data?.items.map((x: any) => (
        <details key={x.id} className="panel" style={{ background: 'var(--paper)' }}>
          <summary className="spread" style={{ cursor: 'pointer' }}>
            <span><b>{x.partner_name}</b> — {x.profile_name}</span>
            <span className="row"><span className={`badge ${x.confidence === 'alta' ? 'ok' : x.confidence === 'media' ? 'warn' : 'bad'}`}>Confiança {x.confidence}</span><b className="wide" style={{ fontSize: '1.3rem' }}>{x.score}</b></span>
          </summary>
          <table className="data" style={{ marginTop: '0.6rem' }}><tbody>
            {x.breakdown.criteria.map((c: any) => <tr key={c.key}><td>{c.label}</td><td className="r num">{c.earned}/{c.weight}</td><td className="small">{c.note}</td></tr>)}
          </tbody></table>
          <div className="row" style={{ marginTop: '0.6rem' }}>
            <button className="btn ghost small" onClick={async () => { const r = await api(`/api/ai/opportunities/${o.id}/whatsapp-message`, { body: { partner_company_id: x.partner_id } }); setMsg(r.text); }}>Sugerir mensagem</button>
            <button className="btn ghost small" onClick={async () => { await api(`/api/matches/${x.id}`, { method: 'PATCH', body: { status: 'sent' } }); toast('Marcada como apresentada'); m.reload(); }} disabled={x.status === 'sent'}>{x.status === 'sent' ? 'Apresentada' : 'Marcar como apresentada'}</button>
            <button className="btn link small" onClick={async () => { await api(`/api/matches/${x.id}`, { method: 'PATCH', body: { status: 'dismissed' } }); m.reload(); }}>Descartar</button>
          </div>
        </details>
      ))}
      {msg && <div className="notice"><p className="small" style={{ margin: '0 0 0.3rem' }}><b>Sugestão — revise antes de enviar</b></p><p style={{ margin: '0 0 0.5rem' }}>{msg}</p><button className="btn small" onClick={() => { navigator.clipboard?.writeText(msg).then(() => toast('Mensagem copiada'), () => toast('Não foi possível copiar', true)); }}>Copiar</button></div>}
    </div>
  );
}

/** Visão de leitura para intermediador e proprietário, conforme permissões. */
function ReadOnlyArea({ o, reload }: { o: any; reload: () => void }) {
  const { can, me } = useSession();
  const toast = useToast();
  const [doc, setDoc] = useState(false);
  const openDoc = async (docId: string) => { try { const r = await api(`/api/documents/${docId}/url`); openFile(r.url, toast); } catch (e: any) { toast(e.message, true); } };
  return (
    <>
      <div className="spread" style={{ marginBottom: '1.25rem' }}>
        <div>
          <span className="small muted">{o.code}</span>
          <h1 style={{ fontSize: 'var(--t2)', fontFamily: 'var(--display)', fontWeight: 400 }}>{o.public_title || o.internal_name}</h1>
          <div className="row" style={{ marginTop: 6 }}><span className={`badge ${pubBadge[o.publication_status]}`}>{PUBLICATION_STATUS[o.publication_status as PublicationStatus]}</span><span className="badge">{LAND_STATUS[o.status as keyof typeof LAND_STATUS]}</span></div>
        </div>
        {o.publication_status === 'published' && <Link className="btn ghost" to={`/areas/${o.slug}`} target={NEW_TAB}>Ver no portal</Link>}
      </div>
      <div className="grid2">
        <div className="panel">
          <h2 style={{ marginBottom: '0.75rem' }}>Dados da área</h2>
          <dl className="spec">
            <dt>Cidade</dt><dd>{o.city}/{o.uf}</dd>
            <dt>Área</dt><dd>{formatArea(o.area_m2)}</dd>
            <dt>Tipo</dt><dd>{LAND_TYPES[o.type as keyof typeof LAND_TYPES]}</dd>
            {o.terms && <><dt>Modalidades</dt><dd>{o.terms.modalities.map((m: string) => MODALITIES[m as keyof typeof MODALITIES]).join(', ')}</dd><dt>Valor pedido</dt><dd>{o.terms.asking_price ? formatBRL(o.terms.asking_price) : '—'}</dd></>}
            {Object.entries(o.technical).map(([k, v]: any) => <div key={k} style={{ display: 'contents' }}><dt>{TECHNICAL_KEYS[k as TechnicalKey]?.label}</dt><dd><span>{techValue(k, v.value)}</span><ValidationBadge status={v.validation_status} /></dd></div>)}
          </dl>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Documentos</h2>{can('document', 'create') && <button className="btn ghost small" onClick={() => setDoc(true)}>Enviar documento</button>}</div>
          {o.documents.length === 0 ? <p className="muted small">Nenhum documento disponível para o seu perfil.</p> : o.documents.map((d: any) => (
            <div key={d.id} className="spread" style={{ borderBottom: '1px solid var(--line-2)', padding: '0.5rem 0' }}><span>{d.title} <span className="small muted">v{d.version}</span></span><button className="btn ghost small" onClick={() => openDoc(d.id)}>Abrir</button></div>
          ))}
          {me?.user.role === 'owner' && <p className="small muted" style={{ marginTop: '0.6rem' }}>Documentos enviados por você ficam confidenciais até a validação da equipe de captação.</p>}
        </div>
      </div>
      {doc && <DocModal oppId={o.id} preset={{}} onClose={() => setDoc(false)} onSaved={() => { setDoc(false); toast('Documento enviado para validação'); reload(); }} />}
    </>
  );
}
