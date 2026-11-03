import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LAND_TYPES, ROLES, UFS, formatArea, type Role } from '@dl/shared';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Empty, Field, Loading, Modal, useAsync, useToast } from '../components/ui';
import { PageHeader } from './Shell';
import { INTEREST_STATUS } from './Interests';

// ------------------------------------------------------------------ atendimento e WhatsApp

export function Routing() {
  const { can } = useSession();
  const toast = useToast();
  const rules = useAsync(() => api('/api/admin/routing-rules'), []);
  const brokers = useAsync(() => api('/api/admin/brokers'), []);
  const [edit, setEdit] = useState<any>(null);
  const [brokerEdit, setBrokerEdit] = useState<any>(null);
  const [central, setCentral] = useState<string | null>(null);
  const target: Record<string, string> = { assigned_broker: 'Intermediador da área', round_robin: 'Rodízio', central: 'Número central' };
  return (
    <>
      <PageHeader title="Atendimento e WhatsApp" />
      <div className="panel" style={{ marginBottom: '1rem' }}>
        <div className="panel-head"><h2>Como um interesse é encaminhado</h2></div>
        <p className="small muted">As regras são avaliadas em ordem de prioridade. Se a regra aponta para o intermediador da área e ele está inativo, sem WhatsApp ou com CRECI irregular, o sistema passa para a próxima regra. Sem regra aplicável, vale o intermediador da área e, por fim, o número central.</p>
        <div className="row">
          <span>Número central:</span>
          <input className="input" style={{ width: 200 }} value={central ?? rules.data?.central_whatsapp ?? ''} onChange={(e) => setCentral(e.target.value)} aria-label="Número central" disabled={!can('routing', 'update')} />
          {can('routing', 'update') && central != null && <button className="btn small" onClick={async () => { await api('/api/admin/central-whatsapp', { method: 'PUT', body: { central_whatsapp: central || null } }); toast('Número central atualizado'); setCentral(null); rules.reload(); }}>Salvar</button>}
        </div>
      </div>
      <div className="panel" style={{ marginBottom: '1rem' }}>
        <div className="panel-head"><h2>Regras de encaminhamento</h2>{can('routing', 'create') && <button className="btn small" onClick={() => setEdit({ priority: 50, target: 'assigned_broker', sla_minutes: 60, criteria: {}, broker_ids: [], active: true })}>Nova regra</button>}</div>
        {rules.loading ? <Loading /> : (
          <table className="data"><thead><tr><th>Prioridade</th><th>Regra</th><th>Quando</th><th>Encaminha para</th><th>Prazo</th><th /></tr></thead>
            <tbody>{rules.data?.items.map((r: any) => (
              <tr key={r.id} style={{ opacity: r.active ? 1 : 0.55 }}>
                <td className="num">{r.priority}</td><td><b>{r.name}</b>{!r.active && <span className="badge" style={{ marginLeft: 6 }}>Inativa</span>}</td>
                <td className="small">{[r.criteria.ufs?.length && `UF: ${r.criteria.ufs.join(', ')}`, r.criteria.cities?.length && `Cidades: ${r.criteria.cities.join(', ')}`, r.criteria.types?.length && `Tipos: ${r.criteria.types.map((t: string) => LAND_TYPES[t as keyof typeof LAND_TYPES]).join(', ')}`].filter(Boolean).join(' · ') || 'Qualquer área'}</td>
                <td>{target[r.target]}{r.target === 'round_robin' && <div className="small muted">{r.broker_ids.map((id: string) => brokers.data?.items.find((b: any) => b.id === id)?.name).filter(Boolean).join(', ')}</div>}</td>
                <td>{r.sla_minutes < 120 ? `${r.sla_minutes} min` : `${Math.round(r.sla_minutes / 60)} h`}</td>
                <td>{can('routing', 'update') && <button className="btn link small" onClick={() => setEdit(r)}>Editar</button>}</td>
              </tr>
            ))}</tbody></table>
        )}
      </div>
      <div className="panel">
        <div className="panel-head"><h2>Intermediadores</h2></div>
        <table className="data"><thead><tr><th>Nome</th><th>CRECI</th><th>Situação</th><th>WhatsApp</th><th className="r">Áreas</th><th className="r">Interesses (30 dias)</th><th /></tr></thead>
          <tbody>{brokers.data?.items.map((b: any) => (
            <tr key={b.id}>
              <td><b>{b.name}</b><div className="small muted">{b.email}</div></td>
              <td>{b.creci ? `${b.creci}-${b.creci_uf}` : '—'}</td>
              <td><span className={`badge ${b.creci_status === 'ativo' ? 'ok' : b.creci_status === 'irregular' ? 'bad' : 'warn'}`}>{({ ativo: 'CRECI ativo', irregular: 'Irregular', nao_verificado: 'Não verificado', nao_aplicavel: 'Não se aplica' } as any)[b.creci_status]}</span>{b.creci_checked_at && <div className="small muted">verificado em {new Date(b.creci_checked_at).toLocaleDateString('pt-BR')}</div>}</td>
              <td className="num">{b.whatsapp ?? <span className="badge bad">Sem número</span>}</td>
              <td className="r">{b.assignments}</td><td className="r">{b.interests_30d}</td>
              <td>{can('routing', 'update') && <button className="btn link small" onClick={() => setBrokerEdit(b)}>Editar</button>}</td>
            </tr>
          ))}</tbody></table>
        <p className="small muted" style={{ marginTop: '0.6rem' }}>A situação do CRECI é registrada manualmente após consulta ao conselho regional. A consulta automática depende de convênio.</p>
      </div>
      {edit && <RuleModal rule={edit} brokers={brokers.data?.items ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); rules.reload(); }} />}
      {brokerEdit && <BrokerModal b={brokerEdit} onClose={() => setBrokerEdit(null)} onSaved={() => { setBrokerEdit(null); brokers.reload(); }} />}
    </>
  );
}

function RuleModal({ rule, brokers, onClose, onSaved }: { rule: any; brokers: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>({ ...rule, ufs: rule.criteria.ufs ?? [], cities: (rule.criteria.cities ?? []).join(', '), types: rule.criteria.types ?? [] });
  const [err, setErr] = useState('');
  const tog = (k: string, v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x: string) => x !== v) : [...f[k], v] });
  return (
    <Modal title={rule.id ? 'Editar regra' : 'Nova regra'} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        const body = { name: f.name, priority: Number(f.priority), target: f.target, broker_ids: f.target === 'round_robin' ? f.broker_ids : [], sla_minutes: Number(f.sla_minutes), active: f.active, criteria: { ufs: f.ufs, cities: f.cities.split(',').map((s: string) => s.trim()).filter(Boolean), types: f.types } };
        try { rule.id ? await api(`/api/admin/routing-rules/${rule.id}`, { method: 'PATCH', body }) : await api('/api/admin/routing-rules', { body }); onSaved(); } catch (er: any) { setErr(er.message); }
      }}>
        <div className="grid2" style={{ gridTemplateColumns: '1fr 120px' }}><Field label="Nome"><input required value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Prioridade" hint="Menor vem primeiro"><input type="number" min={1} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} /></Field></div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="small" style={{ color: 'var(--ink-2)', marginBottom: 4 }}>Aplicar a áreas nas UFs (vazio = todas)</legend><div className="chips">{UFS.map((u) => <button type="button" key={u} className="chip" aria-pressed={f.ufs.includes(u)} onClick={() => tog('ufs', u)}>{u}</button>)}</div></fieldset>
        <Field label="Cidades (opcional, separadas por vírgula)"><input value={f.cities} onChange={(e) => setF({ ...f, cities: e.target.value })} /></Field>
        <Field label="Encaminhar para"><select value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })}><option value="assigned_broker">Intermediador responsável pela área</option><option value="round_robin">Rodízio entre intermediadores</option><option value="central">Número central da Dourado</option></select></Field>
        {f.target === 'round_robin' && <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="small" style={{ color: 'var(--ink-2)', marginBottom: 4 }}>Intermediadores no rodízio</legend><div className="chips">{brokers.map((b) => <button type="button" key={b.id} className="chip" aria-pressed={f.broker_ids.includes(b.id)} onClick={() => tog('broker_ids', b.id)}>{b.name}</button>)}</div></fieldset>}
        <Field label="Prazo para primeiro atendimento (minutos)"><input type="number" min={5} value={f.sla_minutes} onChange={(e) => setF({ ...f, sla_minutes: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Regra ativa</label>
        {err && <p className="error-text">{err}</p>}
        <div className="row"><button className="btn">Salvar regra</button>{rule.id && <button type="button" className="btn danger" onClick={async () => { await api(`/api/admin/routing-rules/${rule.id}`, { method: 'DELETE' }); onSaved(); }}>Excluir</button>}<button type="button" className="btn ghost" onClick={onClose}>Cancelar</button></div>
      </form>
    </Modal>
  );
}

function BrokerModal({ b, onClose, onSaved }: { b: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>({ creci: b.creci ?? '', creci_uf: b.creci_uf ?? '', creci_status: b.creci_status, whatsapp: b.whatsapp ?? '', active: b.active });
  return (
    <Modal title={b.name} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); await api(`/api/admin/brokers/${b.id}`, { method: 'PATCH', body: { ...f, creci_uf: f.creci_uf || null } }); onSaved(); }}>
        <div className="grid3"><Field label="CRECI"><input value={f.creci} onChange={(e) => setF({ ...f, creci: e.target.value })} /></Field><Field label="UF"><select value={f.creci_uf} onChange={(e) => setF({ ...f, creci_uf: e.target.value })}><option value="" />{UFS.map((u) => <option key={u}>{u}</option>)}</select></Field>
          <Field label="Situação"><select value={f.creci_status} onChange={(e) => setF({ ...f, creci_status: e.target.value })}><option value="nao_verificado">Não verificado</option><option value="ativo">Ativo</option><option value="irregular">Irregular</option><option value="nao_aplicavel">Não se aplica</option></select></Field></div>
        <Field label="WhatsApp (DDD + número)"><input value={f.whatsapp} onChange={(e) => setF({ ...f, whatsapp: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Recebe novos interesses</label>
        <div className="row"><button className="btn">Salvar</button><button type="button" className="btn ghost" onClick={onClose}>Cancelar</button></div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ usuários, auditoria, integrações

export function Users() {
  const { data, loading } = useAsync(() => api('/api/admin/users'), []);
  return (
    <>
      <PageHeader title="Usuários" />
      <p className="muted small" style={{ marginTop: '-0.5rem' }}>Contas e senhas são gerenciadas na identidade WingsBr. Aqui aparecem os usuários que já acessaram este módulo e seus perfis.</p>
      {loading ? <Loading /> : (
        <div className="table-wrap"><table className="data"><thead><tr><th>Nome</th><th>Perfil</th><th>Organização</th><th>Verificação em duas etapas</th><th>Situação</th></tr></thead>
          <tbody>{data.items.map((u: any) => <tr key={u.id}><td><b>{u.name}</b><div className="small muted">{u.email}</div></td><td>{ROLES[u.role as Role]}</td><td className="small">{u.org_name}</td><td>{['platform_admin', 'dourado_admin', 'capture_manager'].includes(u.role) ? <span className={`badge ${u.mfa_enabled ? 'ok' : 'bad'}`}>{u.mfa_enabled ? 'Ativa' : 'Obrigatória — pendente'}</span> : <span className="muted small">Opcional</span>}</td><td>{u.active ? 'Ativo' : 'Desativado'}</td></tr>)}</tbody></table></div>
      )}
    </>
  );
}

const ACTION_LABEL: Record<string, string> = {
  create: 'Criou', update: 'Alterou', delete: 'Excluiu', upload: 'Enviou arquivo', export: 'Exportou', assign: 'Atribuiu intermediador', 'geometry.update': 'Atualizou perímetro',
  'publication.submit': 'Enviou para aprovação', 'publication.approve': 'Aprovou publicação', 'publication.reject': 'Devolveu publicação', 'publication.unpublish': 'Retirou do portal',
  'document.access': 'Gerou link de documento', 'document.download': 'Baixou documento', 'interest.reassign': 'Transferiu interesse', 'interest.convert': 'Converteu interesse',
  'privacy.erase': 'Anonimizou titular', version: 'Nova versão de proposta',
};

export function Audit() {
  const [entity, setEntity] = useState('');
  const { data, loading } = useAsync(() => api(`/api/admin/audit${entity ? `?entity=${entity}` : ''}`), [entity]);
  return (
    <>
      <PageHeader title="Auditoria">
        <select className="input" style={{ width: 'auto' }} value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Entidade">
          <option value="">Todas as entidades</option>
          {['land_opportunities', 'land_documents', 'land_geometries', 'land_owners', 'negotiations', 'proposals', 'commissions', 'opportunity_interests', 'whatsapp_routing_rules', 'land_brokers'].map((e) => <option key={e}>{e}</option>)}
        </select>
      </PageHeader>
      {loading ? <Loading /> : data.items.length === 0 ? <Empty title="Sem registros" /> : (
        <div className="table-wrap"><table className="data"><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Entidade</th><th>Detalhe</th></tr></thead>
          <tbody>{data.items.map((a: any) => (
            <tr key={a.id}>
              <td className="small">{new Date(a.created_at).toLocaleString('pt-BR')}</td><td>{a.user_name ?? 'Sistema / portal'}</td><td>{ACTION_LABEL[a.action] ?? a.action}</td>
              <td className="small">{a.entity}{a.entity === 'land_opportunities' && a.entity_id && <> · <Link to={`/painel/areas/${a.entity_id}`}>abrir</Link></>}</td>
              <td className="small muted" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.diff ? JSON.stringify(a.diff) : ''}>{a.diff ? Object.keys(a.diff).slice(0, 6).join(', ') : '—'}</td>
            </tr>
          ))}</tbody></table></div>
      )}
    </>
  );
}

export function Integrations() {
  const { data, loading } = useAsync(() => api('/api/admin/integrations/status'), []);
  const label: Record<string, [string, string]> = { implemented: ['ok', 'Em funcionamento'], simulated: ['warn', 'Simulado'], pending: ['bad', 'Pendente'] };
  return (
    <>
      <PageHeader title="Integrações" />
      <p className="muted small" style={{ marginTop: '-0.5rem' }}>O que está conectado de verdade, o que roda em modo simulado e o que falta configurar para produção.</p>
      {loading ? <Loading /> : (
        <>
          <div className="table-wrap" style={{ marginBottom: '1rem' }}><table className="data"><thead><tr><th>Integração</th><th>Situação</th><th>Detalhe</th></tr></thead>
            <tbody>{data.items.map((i: any) => <tr key={i.key}><td><b>{i.name}</b></td><td><span className={`badge ${label[i.status][0]}`}>{label[i.status][1]}</span></td><td className="small">{i.detail}</td></tr>)}</tbody></table></div>
          <div className="panel"><h2 style={{ marginBottom: '0.5rem' }}>Fila de entrega ao CRM</h2><div className="row">{data.outbox.map((o: any) => <span key={o.status} className={`badge ${o.status === 'done' ? 'ok' : o.status === 'dead' ? 'bad' : 'warn'}`}>{({ done: 'Entregues', pending: 'Na fila', dead: 'Falharam após 8 tentativas' } as any)[o.status]}: {o.n}</span>)}</div></div>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ início por perfil

export function BrokerHome() {
  const { me } = useSession();
  const areas = useAsync(() => api('/api/opportunities'), []);
  const interests = useAsync(() => api('/api/interests'), []);
  const negs = useAsync(() => api('/api/negotiations'), []);
  const pending = (interests.data?.items ?? []).filter((i: any) => !i.first_response_at && i.name && i.status !== 'discarded');
  return (
    <>
      <PageHeader title={`Olá, ${me?.user.name.split(' ')[0]}`} />
      <div className="kpis" style={{ marginBottom: '1rem' }}>
        <div className="kpi"><span>Áreas sob sua responsabilidade</span><b>{areas.data?.items.length ?? '—'}</b></div>
        <div className="kpi"><span>Interessados aguardando primeiro contato</span><b>{pending.length}</b></div>
        <div className="kpi"><span>Negociações em andamento</span><b>{negs.data?.items.length ?? '—'}</b></div>
      </div>
      <div className="grid2">
        <div className="panel"><div className="panel-head"><h2>Aguardando seu contato</h2><Link to="/painel/interesses" className="small">Todos os interesses</Link></div>
          {pending.length === 0 ? <p className="muted">Ninguém esperando. Bom trabalho.</p> : pending.slice(0, 8).map((i: any) => (
            <div key={i.id} className="spread" style={{ borderBottom: '1px solid var(--line-2)', padding: '0.5rem 0' }}><span><b>{i.name}</b> · {i.code}<div className="small muted">{i.phone ?? i.email}</div></span>{i.sla_breached ? <span className="badge bad">Fora do prazo</span> : <span className="badge warn">{INTEREST_STATUS[i.status]?.[1]}</span>}</div>
          ))}
        </div>
        <div className="panel"><div className="panel-head"><h2>Minhas áreas</h2></div>
          {areas.data?.items.map((o: any) => <div key={o.id} className="spread" style={{ borderBottom: '1px solid var(--line-2)', padding: '0.5rem 0' }}><Link to={`/painel/areas/${o.id}`}><b>{o.code}</b> {o.public_title ?? o.internal_name}</Link><span className="small muted">{formatArea(o.area_m2)}</span></div>)}
        </div>
      </div>
    </>
  );
}

export function OwnerHome() {
  const { me } = useSession();
  const areas = useAsync(() => api('/api/opportunities'), []);
  return (
    <>
      <PageHeader title={`Olá, ${me?.user.name.split(' ')[0]}`} />
      <p className="muted" style={{ marginTop: '-0.5rem' }}>Acompanhe suas áreas e envie documentos solicitados pela equipe de captação.</p>
      {areas.loading ? <Loading /> : (
        <div className="ficha-list">
          {areas.data.items.map((o: any) => (
            <Link key={o.id} to={`/painel/areas/${o.id}`} className="ficha" style={{ gridTemplateColumns: '200px 1fr auto' }}>
              <div className="ficha-area"><b>{(o.area_m2 / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}</b><span>hectares</span></div>
              <div><span className="ficha-code">{o.code}</span><h3 className="ficha-title">{o.public_title ?? o.internal_name}</h3><span className="muted">{o.city}/{o.uf}</span></div>
              <span className="btn ghost small">Ver e enviar documentos</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
