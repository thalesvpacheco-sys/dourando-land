import { useState } from 'react';
import { Link } from 'react-router-dom';
import { APPROVAL_STAGES, MODALITIES, UFS, VIABILITY, formatArea, formatBRL } from '@dl/shared';
import { api, NEW_TAB } from '../lib/api';
import { useSession } from '../lib/session';
import { Empty, Field, Loading, Modal, useAsync, useToast } from '../components/ui';
import { PageHeader } from './Shell';

const KIND: Record<string, string> = { construtora: 'Construtora', incorporadora: 'Incorporadora', loteadora: 'Loteadora', investidor: 'Investidor' };

export default function Buyers() {
  const { can, me } = useSession();
  const toast = useToast();
  const isBuyer = me?.user.role === 'buyer';
  const partners = useAsync(() => (can('partner', 'read') ? api('/api/partners') : Promise.resolve({ items: [] })), []);
  const profiles = useAsync(() => api('/api/profiles'), []);
  const matches = useAsync(() => api('/api/matches'), []);
  const [editProfile, setEditProfile] = useState<any>(null);
  const [newPartner, setNewPartner] = useState(false);
  const [filter, setFilter] = useState('');

  const ms = (matches.data?.items ?? []).filter((m: any) => !filter || m.profile_id === filter);
  return (
    <>
      <PageHeader title={isBuyer ? 'Perfis de aquisição e recomendações' : 'Compradores e matching'}>
        {can('match', 'create') && <button className="btn ghost" onClick={async () => { await api('/api/matches/recompute', { method: 'POST' }); toast('Recomendações recalculadas'); matches.reload(); profiles.reload(); }}>Recalcular recomendações</button>}
        {can('partner', 'create') && <button className="btn ghost" onClick={() => setNewPartner(true)}>Cadastrar empresa</button>}
        {can('profile', 'create') && <button className="btn gold" onClick={() => setEditProfile({})}>Novo perfil de aquisição</button>}
      </PageHeader>

      {!isBuyer && (
        <div className="panel" style={{ marginBottom: '1rem' }}>
          <h2 style={{ marginBottom: '0.6rem' }}>Empresas</h2>
          {partners.loading ? <Loading /> : (
            <table className="data"><thead><tr><th>Empresa</th><th>Tipo</th><th>Contato</th><th className="r">Perfis</th><th className="r">Negociações abertas</th></tr></thead>
              <tbody>{partners.data?.items.map((p: any) => <tr key={p.id}><td><b>{p.name}</b>{p.partner_org_id && <span className="badge ok" style={{ marginLeft: 6 }}>Acesso ao portal</span>}</td><td>{KIND[p.kind]}</td><td className="small">{p.contact_name}<br />{p.contact_email}</td><td className="r">{p.profiles}</td><td className="r">{p.open_negotiations}</td></tr>)}</tbody></table>
          )}
        </div>
      )}

      <div className="grid2" style={{ alignItems: 'start' }}>
        <div className="panel">
          <h2 style={{ marginBottom: '0.6rem' }}>Perfis de aquisição</h2>
          {profiles.data?.items.length === 0 && <Empty title="Nenhum perfil cadastrado">{can('profile', 'create') && <button className="btn" onClick={() => setEditProfile({})}>Criar perfil</button>}</Empty>}
          <div className="stack-s">
            {profiles.data?.items.map((p: any) => (
              <div key={p.id} style={{ borderBottom: '1px solid var(--line-2)', paddingBottom: '0.7rem' }}>
                <div className="spread"><b>{p.name}</b><span className="row">{!p.active && <span className="badge">Inativo</span>}<button className="btn link small" onClick={() => setFilter(filter === p.id ? '' : p.id)}>{filter === p.id ? 'Ver todas' : `${p.match_count} recomendações`}</button>{can('profile', 'update') && <button className="btn link small" onClick={() => setEditProfile(p)}>Editar</button>}</span></div>
                <div className="small muted">{p.partner_name}</div>
                <div className="small" style={{ marginTop: 4 }}>
                  {[p.cities.length ? p.cities.join(', ') : p.ufs.join(', '), (p.min_area_m2 || p.max_area_m2) && `${p.min_area_m2 ? formatArea(p.min_area_m2) : '0'} a ${p.max_area_m2 ? formatArea(p.max_area_m2) : 'sem limite'}`,
                    p.typologies.map((t: string) => VIABILITY[t as keyof typeof VIABILITY]).join(', '), p.budget_max && `até ${formatBRL(p.budget_max)}`].filter(Boolean).join(' · ')}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h2 style={{ marginBottom: '0.6rem' }}>Áreas recomendadas</h2>
          {matches.loading ? <Loading /> : ms.length === 0 ? <p className="muted">Nenhuma área com pontuação mínima. Ajuste o perfil ou aguarde novas captações.</p> : ms.map((m: any) => (
            <details key={m.id} style={{ borderBottom: '1px solid var(--line-2)', padding: '0.6rem 0' }}>
              <summary className="spread" style={{ cursor: 'pointer' }}>
                <span><b>{m.code}</b> {m.public_title ?? m.internal_name}<div className="small muted">{m.city}/{m.uf} · {formatArea(m.area_m2)} · para {m.profile_name}{!isBuyer ? ` (${m.partner_name})` : ''}</div></span>
                <span className="row"><span className={`badge ${m.confidence === 'alta' ? 'ok' : m.confidence === 'media' ? 'warn' : 'bad'}`}>Confiança {m.confidence}</span><b className="wide" style={{ fontSize: '1.3rem' }}>{m.score}</b></span>
              </summary>
              <table className="data" style={{ marginTop: '0.4rem' }}><tbody>{m.breakdown.criteria.map((c: any) => <tr key={c.key}><td>{c.label}</td><td className="r num">{c.earned}/{c.weight}</td><td className="small">{c.note}</td></tr>)}</tbody></table>
              <div className="row" style={{ marginTop: '0.4rem' }}>
                {m.publication_status === 'published' && <Link className="btn ghost small" to={`/areas/${m.slug}`} target={NEW_TAB}>Ver área</Link>}
                {!isBuyer && <Link className="btn ghost small" to={`/painel/areas/${m.opportunity_id}?etapa=8`}>Abrir no cadastro</Link>}
                {!isBuyer && m.publication_status !== 'published' && <span className="badge">Não publicada</span>}
              </div>
            </details>
          ))}
          <p className="small muted" style={{ marginTop: '0.6rem' }}>Pontuação determinística: localização 25, metragem 20, tipologia 20, orçamento 15, modalidade 10, aprovação 10. Restrições excluem a área. Nada é inferido.</p>
        </div>
      </div>

      {editProfile && <ProfileModal profile={editProfile} partners={isBuyer ? me!.user.partnerCompanyIds.map((id) => ({ id, name: 'Minha empresa' })) : partners.data?.items ?? []} onClose={() => setEditProfile(null)} onSaved={() => { setEditProfile(null); profiles.reload(); matches.reload(); toast('Perfil salvo e recomendações recalculadas'); }} />}
      {newPartner && <PartnerModal onClose={() => setNewPartner(false)} onSaved={() => { setNewPartner(false); partners.reload(); }} />}
    </>
  );
}

function ProfileModal({ profile, partners, onClose, onSaved }: { profile: any; partners: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>({
    partner_company_id: profile.partner_company_id ?? partners[0]?.id ?? '', name: profile.name ?? '', ufs: profile.ufs ?? [], cities: (profile.cities ?? []).join(', '),
    min_ha: profile.min_area_m2 ? profile.min_area_m2 / 10000 : '', max_ha: profile.max_area_m2 ? profile.max_area_m2 / 10000 : '', typologies: profile.typologies ?? [],
    budget_mi: profile.budget_max ? profile.budget_max / 1e6 : '', modalities: profile.modalities ?? [], max_swap_pct: profile.max_swap_pct ?? '', min_approval_stage: profile.min_approval_stage ?? '',
    restrictions: profile.restrictions ?? {}, briefing: profile.briefing ?? '', active: profile.active ?? true,
  });
  const [err, setErr] = useState('');
  const tog = (k: string, v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x: string) => x !== v) : [...f[k], v] });
  const n = (v: any) => (v === '' || v == null ? null : Number(String(v).replace(',', '.')));
  return (
    <Modal title={profile.id ? 'Editar perfil de aquisição' : 'Novo perfil de aquisição'} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault(); setErr('');
        const body: any = {
          name: f.name, ufs: f.ufs, cities: f.cities.split(',').map((s: string) => s.trim()).filter(Boolean), min_area_m2: n(f.min_ha) != null ? n(f.min_ha)! * 10000 : null,
          max_area_m2: n(f.max_ha) != null ? n(f.max_ha)! * 10000 : null, typologies: f.typologies, budget_max: n(f.budget_mi) != null ? n(f.budget_mi)! * 1e6 : null,
          modalities: f.modalities, max_swap_pct: n(f.max_swap_pct), min_approval_stage: f.min_approval_stage || null, restrictions: f.restrictions, briefing: f.briefing || null, active: f.active,
        };
        try {
          if (profile.id) await api(`/api/profiles/${profile.id}`, { method: 'PATCH', body });
          else await api('/api/profiles', { body: { ...body, partner_company_id: f.partner_company_id } });
          onSaved();
        } catch (er: any) { setErr(er.message); }
      }}>
        {!profile.id && partners.length > 1 && <Field label="Empresa"><select value={f.partner_company_id} onChange={(e) => setF({ ...f, partner_company_id: e.target.value })}>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
        <Field label="Nome do perfil"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex.: Verticais na Grande Goiânia" /></Field>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="small" style={{ color: 'var(--ink-2)', marginBottom: 4 }}>Estados de interesse</legend><div className="chips">{UFS.map((u) => <button type="button" key={u} className="chip" aria-pressed={f.ufs.includes(u)} onClick={() => tog('ufs', u)}>{u}</button>)}</div></fieldset>
        <Field label="Cidades de interesse" hint="Separe por vírgula"><input value={f.cities} onChange={(e) => setF({ ...f, cities: e.target.value })} /></Field>
        <div className="grid3"><Field label="Área mínima (ha)"><input inputMode="decimal" value={f.min_ha} onChange={(e) => setF({ ...f, min_ha: e.target.value })} /></Field><Field label="Área máxima (ha)"><input inputMode="decimal" value={f.max_ha} onChange={(e) => setF({ ...f, max_ha: e.target.value })} /></Field><Field label="Orçamento máximo (R$ mi)"><input inputMode="decimal" value={f.budget_mi} onChange={(e) => setF({ ...f, budget_mi: e.target.value })} /></Field></div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="small" style={{ color: 'var(--ink-2)', marginBottom: 4 }}>Tipologia</legend><div className="chips">{Object.entries(VIABILITY).map(([k, l]) => <button type="button" key={k} className="chip" aria-pressed={f.typologies.includes(k)} onClick={() => tog('typologies', k)}>{l}</button>)}</div></fieldset>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="small" style={{ color: 'var(--ink-2)', marginBottom: 4 }}>Modalidades aceitas</legend><div className="chips">{Object.entries(MODALITIES).map(([k, l]) => <button type="button" key={k} className="chip" aria-pressed={f.modalities.includes(k)} onClick={() => tog('modalities', k)}>{l}</button>)}</div></fieldset>
        <div className="grid2"><Field label="Permuta máxima (%)"><input inputMode="decimal" value={f.max_swap_pct} onChange={(e) => setF({ ...f, max_swap_pct: e.target.value })} /></Field>
          <Field label="Estágio mínimo de aprovação"><select value={f.min_approval_stage} onChange={(e) => setF({ ...f, min_approval_stage: e.target.value })}><option value="">Sem exigência</option>{Object.entries(APPROVAL_STAGES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field></div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack-s"><legend className="small" style={{ color: 'var(--ink-2)', marginBottom: 4 }}>Restrições técnicas (excluem a área)</legend>
          {[['require_water', 'Exige água'], ['require_energy', 'Exige energia'], ['require_sewer', 'Exige esgoto'], ['urban_only', 'Somente área urbana'], ['no_app', 'Não aceita APP']].map(([k, l]) => <label key={k} className="check"><input type="checkbox" checked={!!f.restrictions[k]} onChange={(e) => setF({ ...f, restrictions: { ...f.restrictions, [k]: e.target.checked } })} /> {l}</label>)}
        </fieldset>
        <Field label="Briefing" hint="Texto livre para a equipe; não altera a pontuação"><textarea value={f.briefing} onChange={(e) => setF({ ...f, briefing: e.target.value })} /></Field>
        {profile.id && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Perfil ativo</label>}
        {err && <p className="error-text">{err}</p>}
        <div className="row"><button className="btn">Salvar perfil</button><button type="button" className="btn ghost" onClick={onClose}>Cancelar</button></div>
      </form>
    </Modal>
  );
}

function PartnerModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>({ kind: 'construtora' });
  const [err, setErr] = useState('');
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Cadastrar empresa" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); try { await api('/api/partners', { body: f }); onSaved(); } catch (er: any) { setErr(er.message); } }}>
        <Field label="Nome"><input required onChange={set('name')} /></Field>
        <div className="grid2"><Field label="Tipo"><select value={f.kind} onChange={set('kind')}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field><Field label="CNPJ"><input onChange={set('cnpj')} /></Field></div>
        <div className="grid3"><Field label="Contato"><input onChange={set('contact_name')} /></Field><Field label="E-mail"><input type="email" onChange={set('contact_email')} /></Field><Field label="Telefone"><input onChange={set('contact_phone')} /></Field></div>
        {err && <p className="error-text">{err}</p>}
        <div className="row"><button className="btn">Cadastrar</button><button type="button" className="btn ghost" onClick={onClose}>Cancelar</button></div>
      </form>
    </Modal>
  );
}
