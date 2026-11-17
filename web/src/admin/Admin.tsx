import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { LAND_TYPES, ROLES, UFS, formatArea, type Role } from '@dl/shared';
import { api, DEMO } from '../lib/api';
import { MfaSetup, RecoveryCodes } from './Login';
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
              <td><b>{b.name}</b>{b.role && b.role !== 'broker' && <span className="badge" style={{ marginLeft: 6 }}>{ROLES[b.role as Role]}</span>}<div className="small muted">{b.email}</div></td>
              <td>{b.creci ? `${b.creci}-${b.creci_uf}` : '—'}</td>
              <td><span className={`badge ${CRECI_STATUS[b.creci_status]?.[0] ?? 'warn'}`}>{CRECI_STATUS[b.creci_status]?.[1]}</span>{b.creci_checked_at && <div className="small muted">verificado em {new Date(b.creci_checked_at).toLocaleDateString('pt-BR')}</div>}</td>
              <td className="num">{b.whatsapp ?? <span className="badge bad">Sem número</span>}</td>
              <td className="r">{b.assignments}</td><td className="r">{b.interests_30d}</td>
              <td>{can('routing', 'update') && <button className="btn link small" onClick={() => setBrokerEdit(b)}>Editar</button>}</td>
            </tr>
          ))}</tbody></table>
        <p className="small muted" style={{ marginTop: '0.6rem' }}>A situação do CRECI é registrada manualmente após consulta ao conselho regional. A consulta automática depende de convênio. Administradores e gestores aparecem aqui quando marcados como "atua como intermediador" em <Link to="/painel/usuarios">Usuários</Link>.</p>
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
        <CreciFields f={f} setF={setF} validate />
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Recebe novos interesses</label>
        <div className="row"><button className="btn">Salvar</button><button type="button" className="btn ghost" onClick={onClose}>Cancelar</button></div>
      </form>
    </Modal>
  );
}

const CRECI_STATUS: Record<string, [string, string]> = { ativo: ['ok', 'CRECI ativo'], irregular: ['bad', 'Irregular'], nao_verificado: ['warn', 'Não verificado'], nao_aplicavel: ['', 'Não se aplica'] };

/** CRECI, UF, situação e WhatsApp: usados no cadastro do usuário, em Atendimento e em Minha conta. Só o administrador marca a situação. */
function CreciFields({ f, setF, validate }: { f: any; setF: (v: any) => void; validate?: boolean }) {
  return (
    <>
      <div className={validate ? 'grid3' : 'grid2'}>
        <Field label="CRECI"><input value={f.creci ?? ''} onChange={(e) => setF({ ...f, creci: e.target.value })} /></Field>
        <Field label="UF do CRECI"><select value={f.creci_uf ?? ''} onChange={(e) => setF({ ...f, creci_uf: e.target.value })}><option value="" />{UFS.map((u) => <option key={u}>{u}</option>)}</select></Field>
        {validate && <Field label="Situação" hint="Marque após consultar o conselho regional."><select value={f.creci_status ?? 'nao_verificado'} onChange={(e) => setF({ ...f, creci_status: e.target.value })}>{Object.entries(CRECI_STATUS).map(([k, [, l]]) => <option key={k} value={k}>{k === 'ativo' ? 'Ativo' : l}</option>)}</select></Field>}
      </div>
      <Field label="WhatsApp para atendimento (DDD + número)" hint="Para onde vão os interessados das áreas sob sua responsabilidade."><input value={f.whatsapp ?? ''} onChange={(e) => setF({ ...f, whatsapp: e.target.value })} /></Field>
    </>
  );
}
const creciBody = (f: any, validate: boolean) => ({ creci: f.creci || null, creci_uf: f.creci_uf || null, whatsapp: f.whatsapp || null, ...(validate ? { creci_status: f.creci_status } : {}) });

// ------------------------------------------------------------------ usuários, auditoria, integrações

const MFA_ROLES = ['platform_admin', 'dourado_admin', 'capture_manager'];
const STAFF_ROLES = ['dourado_admin', 'capture_manager', 'broker'];
/** Perfis que podem, além do próprio papel, ser responsáveis por áreas. */
const CAN_ACT_AS_BROKER = ['dourado_admin', 'capture_manager'];

function userStatus(u: any): [string, string] {
  if (!u.active) return ['', 'Desativado'];
  if (!u.has_password && !DEMO) return ['warn', 'Convite pendente'];
  if (u.locked_until && new Date(u.locked_until) > new Date()) return ['bad', 'Bloqueado'];
  return ['ok', 'Ativo'];
}

/** Link único: aparece uma vez para o administrador copiar e enviar. */
function LinkModal({ link, onClose }: { link: { title: string; url: string; expires_at: string; email_sent: boolean }; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal title={link.title} onClose={onClose}>
      <div className="stack">
        <p className={link.email_sent ? 'notice ok' : 'notice'} style={{ margin: 0 }}>{link.email_sent ? 'Enviamos o link por e-mail. Se preferir, copie abaixo.' : 'O envio por e-mail não está configurado. Copie o link e envie à pessoa por um canal seguro.'}</p>
        <input className="input" readOnly value={link.url} aria-label="Link de acesso" onFocus={(e) => e.target.select()} />
        <p className="small muted" style={{ margin: 0 }}>Uso único, válido até {new Date(link.expires_at).toLocaleString('pt-BR')}. Este link não será mostrado de novo.</p>
        <div className="row">
          <button className="btn gold" onClick={() => void navigator.clipboard.writeText(link.url).then(() => toast('Link copiado'))}>Copiar link</button>
          <button className="btn ghost" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </Modal>
  );
}

function InviteModal({ roles, onClose, onDone }: { roles: string[]; onClose: () => void; onDone: (r: any) => void }) {
  const mfaOn = !!useSession().me?.mfaRequired;
  const [f, setF] = useState<any>({ name: '', email: '', phone: '', role: 'broker', partner_company_id: '', opportunity_code: '', acts_as_broker: false, creci: '', creci_uf: '', creci_status: 'nao_verificado', whatsapp: '' });
  const [partners, setPartners] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/partners').then((r) => setPartners(r.items ?? [])).catch(() => {}); }, []);
  const isBroker = f.role === 'broker' || (CAN_ACT_AS_BROKER.includes(f.role) && f.acts_as_broker);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      onDone(await api('/api/admin/users', { body: {
        name: f.name, email: f.email, phone: f.whatsapp || f.phone || null, role: f.role,
        partner_company_id: f.role === 'buyer' ? f.partner_company_id || undefined : undefined, opportunity_code: f.role === 'owner' ? f.opportunity_code : undefined,
        ...(isBroker ? { acts_as_broker: true, ...creciBody(f, true) } : {}),
      } }));
    } catch (x: any) { setErr(x.message); setBusy(false); }
  };
  return (
    <Modal title="Convidar usuário" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Nome"><input required minLength={2} autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="E-mail"><input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Perfil"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roles.map((r) => <option key={r} value={r}>{ROLES[r as Role]}</option>)}</select></Field>
        {CAN_ACT_AS_BROKER.includes(f.role) && <label className="check"><input type="checkbox" checked={f.acts_as_broker} onChange={(e) => setF({ ...f, acts_as_broker: e.target.checked })} /> Também atua como intermediador (pode ser responsável por áreas)</label>}
        {isBroker && <CreciFields f={f} setF={setF} validate />}
        {f.role === 'buyer' && <Field label="Empresa parceira"><select required value={f.partner_company_id} onChange={(e) => setF({ ...f, partner_company_id: e.target.value })}><option value="">Selecione</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
        {f.role === 'owner' && <Field label="Código da área" hint="O proprietário verá só esta área e poderá enviar documentos."><input required placeholder="DOU-GO-0001" value={f.opportunity_code} onChange={(e) => setF({ ...f, opportunity_code: e.target.value })} /></Field>}
        {mfaOn && MFA_ROLES.includes(f.role) && <p className="small muted" style={{ margin: 0 }}>Este perfil precisa ativar a verificação em duas etapas no primeiro acesso.</p>}
        {err && <p className="error-text">{err}</p>}
        <div className="row"><button className="btn gold" disabled={busy}>{busy ? 'Criando…' : 'Criar convite'}</button><button type="button" className="btn ghost" onClick={onClose}>Cancelar</button></div>
      </form>
    </Modal>
  );
}

function EditUserModal({ u, roles, onClose, onDone, onLink }: { u: any; roles: string[]; onClose: () => void; onDone: () => void; onLink: (l: any) => void }) {
  const { me } = useSession();
  const toast = useToast();
  const actsNow = !!u.broker_id && u.broker_active !== false;
  const [f, setF] = useState<any>({ name: u.name, email: u.email, role: u.role, acts_as_broker: actsNow, creci: u.creci ?? '', creci_uf: u.creci_uf ?? '', creci_status: u.creci_status ?? 'nao_verificado', whatsapp: u.whatsapp ?? u.phone ?? '' });
  const [err, setErr] = useState('');
  const self = u.id === me?.user.id;
  const external = ['owner', 'buyer'].includes(u.role);
  const isBroker = f.role === 'broker' || (CAN_ACT_AS_BROKER.includes(f.role) && f.acts_as_broker);
  const act = async (fn: () => Promise<void>) => { setErr(''); try { await fn(); } catch (x: any) { setErr(x.message); } };
  const save = () => act(async () => {
    const emailChanged = !u.has_password && f.email.trim().toLowerCase() !== u.email.toLowerCase();
    await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: {
      name: f.name, ...(f.role !== u.role ? { role: f.role } : {}), ...(emailChanged ? { email: f.email } : {}),
      // a opção só vale para administrador e gestor; o intermediador sempre pode ser responsável
      ...(CAN_ACT_AS_BROKER.includes(f.role) && (f.acts_as_broker !== actsNow || f.role !== u.role) ? { acts_as_broker: f.acts_as_broker } : {}),
      ...(isBroker ? creciBody(f, f.creci_status !== (u.creci_status ?? 'nao_verificado')) : {}),
    } });
    if (emailChanged) {
      // o convite antigo foi para o endereço errado: gera o novo link já para o e-mail corrigido
      const r = await api(`/api/admin/users/${u.id}/link`, { method: 'POST' });
      onLink({ title: 'E-mail corrigido — novo link de convite', ...r });
      return;
    }
    toast('Usuário atualizado'); onDone();
  });
  return (
    <Modal title={u.name} onClose={onClose}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>{u.email}{u.last_login_at ? ` · último acesso em ${new Date(u.last_login_at).toLocaleString('pt-BR')}` : ' · nunca acessou'}</p>
        <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        {!u.has_password && <Field label="E-mail" hint="Convite pendente: dá para corrigir o e-mail. Ao salvar, o link antigo deixa de valer e um novo é gerado."><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>}
        <Field label="Perfil" hint={self ? 'Você não pode alterar o próprio perfil.' : external ? 'Proprietário e comprador têm vínculo próprio: para trocar, desative e convide de novo.' : 'Alterar o perfil encerra as sessões abertas.'}>
          <select disabled={self || external} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{(external ? [u.role] : roles.filter((r) => STAFF_ROLES.includes(r))).map((r) => <option key={r} value={r}>{ROLES[r as Role]}</option>)}</select>
        </Field>
        {!external && CAN_ACT_AS_BROKER.includes(f.role) && <label className="check"><input type="checkbox" checked={f.acts_as_broker} onChange={(e) => setF({ ...f, acts_as_broker: e.target.checked })} /> Também atua como intermediador (pode ser responsável por áreas)</label>}
        {!external && isBroker && <fieldset className="stack-s" style={{ border: '1px solid var(--line-2)', borderRadius: 6, padding: '0.6rem 0.8rem', margin: 0 }}>
          <legend className="small" style={{ padding: '0 4px' }}>Intermediação</legend>
          <CreciFields f={f} setF={setF} validate />
        </fieldset>}
        {err && <p className="error-text">{err}</p>}
        <div className="row"><button className="btn" onClick={save}>Salvar</button></div>
        <div className="stack-s" style={{ borderTop: '1px solid var(--line-2)', paddingTop: '0.8rem' }}>
          {u.active && <button className="btn ghost small" onClick={() => act(async () => { const r = await api(`/api/admin/users/${u.id}/link`, { method: 'POST' }); onLink({ title: r.kind === 'invite' ? 'Novo link de convite' : 'Link para redefinir a senha', ...r }); })}>{u.has_password ? 'Gerar link para redefinir a senha' : 'Gerar novo link de convite'}</button>}
          {me?.mfaRequired && u.mfa_enabled && !self && <button className="btn ghost small" onClick={() => act(async () => { await api(`/api/admin/users/${u.id}/reset-mfa`, { method: 'POST' }); toast('Verificação em duas etapas zerada. A pessoa configura de novo no próximo acesso.'); onDone(); })}>Zerar duas etapas (celular perdido)</button>}
          {!self && <button className={u.active ? 'btn danger small' : 'btn ghost small'} onClick={() => act(async () => { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }); toast(u.active ? 'Acesso desativado e sessões encerradas' : 'Acesso reativado'); onDone(); })}>{u.active ? 'Desativar acesso' : 'Reativar acesso'}</button>}
        </div>
      </div>
    </Modal>
  );
}

export function Users() {
  const { can, me } = useSession();
  const { data, loading, reload } = useAsync(() => api('/api/admin/users'), []);
  const [invite, setInvite] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [link, setLink] = useState<any>(null);
  const manage = !DEMO && can('user', 'create');
  const mfaOn = !!me?.mfaRequired;
  const roles = me?.user.role === 'platform_admin' ? Object.keys(ROLES) : ['dourado_admin', 'capture_manager', 'broker', 'owner', 'buyer'];
  return (
    <>
      <PageHeader title="Usuários">{manage && <button className="btn gold" onClick={() => setInvite(true)}>Convidar usuário</button>}</PageHeader>
      <p className="muted small" style={{ marginTop: '-0.5rem' }}>{DEMO ? 'Usuários fictícios da demonstração.' : 'O acesso é por convite: cada pessoa define a própria senha. Desativar encerra as sessões na hora.'}</p>
      {loading ? <Loading /> : (
        <div className="table-wrap"><table className="data"><thead><tr><th>Nome</th><th>Perfil</th><th>Organização</th>{mfaOn && <th>Duas etapas</th>}<th>Último acesso</th><th>Situação</th>{manage && <th />}</tr></thead>
          <tbody>{data.items.map((u: any) => {
            const [cls, label] = userStatus(u);
            return <tr key={u.id} style={{ opacity: u.active ? 1 : 0.55 }}>
              <td><b>{u.name}</b><div className="small muted">{u.email}</div></td>
              <td>{ROLES[u.role as Role]}{u.role !== 'broker' && u.broker_id && u.broker_active && <div className="small muted">também intermediador</div>}{u.broker_id && u.broker_active && <div className="small muted">{u.creci ? `CRECI ${u.creci}-${u.creci_uf ?? ''}` : 'sem CRECI'} · {CRECI_STATUS[u.creci_status]?.[1]}</div>}</td>
              <td className="small">{u.org_name}</td>
              {mfaOn && <td>{u.mfa_enabled ? <span className="badge ok">Ativa</span> : MFA_ROLES.includes(u.role) ? <span className="badge bad">Obrigatória — pendente</span> : <span className="muted small">Opcional</span>}</td>}
              <td className="small">{u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('pt-BR') : '—'}</td>
              <td><span className={`badge ${cls}`}>{label}</span></td>
              {manage && <td><button className="btn link small" onClick={() => setEdit(u)}>Gerenciar</button></td>}
            </tr>;
          })}</tbody></table></div>
      )}
      {invite && <InviteModal roles={roles} onClose={() => setInvite(false)} onDone={(r) => { setInvite(false); setLink({ title: 'Convite criado', url: r.invite_url, expires_at: r.expires_at, email_sent: r.email_sent }); reload(); }} />}
      {edit && <EditUserModal u={edit} roles={roles} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} onLink={(l) => { setEdit(null); setLink(l); }} />}
      {link && <LinkModal link={link} onClose={() => setLink(null)} />}
    </>
  );
}

/** Dados pessoais e, para quem atende áreas, CRECI e WhatsApp. Trocar o CRECI volta a situação para "não verificado". */
function ProfileForm({ onSaved }: { onSaved: () => void }) {
  const toast = useToast();
  const { data, loading, reload } = useAsync(() => api('/api/admin/me/profile'), []);
  const [f, setF] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setF({ name: data.name, phone: data.phone ?? '', creci: data.broker?.creci ?? '', creci_uf: data.broker?.creci_uf ?? '', whatsapp: data.broker?.whatsapp ?? '' }); }, [data]);
  if (loading || !f) return <div className="panel"><Loading /></div>;
  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      await api('/api/admin/me/profile', { method: 'PATCH', body: { name: f.name, phone: f.phone || null, ...(data.broker ? creciBody(f, false) : {}) } });
      toast('Dados atualizados'); reload(); onSaved();
    } catch (x: any) { setErr(x.message); }
    setBusy(false);
  };
  const st = data.broker && CRECI_STATUS[data.broker.creci_status];
  return (
    <form className="panel stack" onSubmit={save}>
      <h2>Meus dados</h2>
      <p className="small muted" style={{ margin: 0 }}>{data.email} · {ROLES[data.role as Role]}</p>
      <Field label="Nome"><input required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Telefone"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      {data.broker && <>
        <CreciFields f={f} setF={setF} />
        {st && <p className="small" style={{ margin: 0 }}>Situação do CRECI: <span className={`badge ${st[0]}`}>{st[1]}</span>{data.broker.creci_status !== 'ativo' && <span className="muted"> — um administrador valida após consultar o conselho.</span>}</p>}
      </>}
      {err && <p className="error-text">{err}</p>}
      <div><button className="btn" disabled={busy}>Salvar dados</button></div>
    </form>
  );
}

export function Account() {
  const { me, login } = useSession();
  const toast = useToast();
  const [cur, setCur] = useState(''); const [p1, setP1] = useState(''); const [p2, setP2] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disablePw, setDisablePw] = useState('');
  const mfaOn = !!me?.user.mfa;
  const change = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    if (p1 !== p2) { setErr('As senhas novas não são iguais.'); return; }
    setBusy(true);
    try { await api('/api/auth/password/change', { body: { current: cur, password: p1 }, auth: false }); setCur(''); setP1(''); setP2(''); toast('Senha alterada. Outras sessões foram encerradas.'); await login(); }
    catch (x: any) { setErr(x.message); }
    setBusy(false);
  };
  return (
    <>
      <PageHeader title="Minha conta" />
      <div className="grid2">
        {!DEMO && <ProfileForm onSaved={() => void login()} />}
        <form className="panel stack" onSubmit={change}>
          <h2>Trocar senha</h2>
          <p className="small muted" style={{ margin: 0 }}>{me?.user.email}</p>
          <Field label="Senha atual"><input type="password" required autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
          <Field label="Nova senha" hint="Pelo menos 10 caracteres."><input type="password" required minLength={10} autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} /></Field>
          <Field label="Repita a nova senha"><input type="password" required minLength={10} autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} /></Field>
          {err && <p className="error-text">{err}</p>}
          <div><button className="btn" disabled={busy}>Alterar senha</button></div>
        </form>
        {me?.mfaRequired && <div className="panel stack">
          <h2>Verificação em duas etapas</h2>
          {codes ? <RecoveryCodes codes={codes} onContinue={() => setCodes(null)} />
            : settingUp ? <MfaSetup onDone={(c) => { setSettingUp(false); setCodes(c); void login(); }} />
            : mfaOn ? <>
              <p className="notice ok" style={{ margin: 0 }}>Ativa nesta conta.</p>
              {MFA_ROLES.includes(me?.user.role ?? '') ? <p className="small muted" style={{ margin: 0 }}>Seu perfil exige duas etapas. Trocou de celular? Peça a outro administrador para zerar em Usuários.</p> : <form className="stack-s" onSubmit={async (e) => { e.preventDefault(); try { await api('/api/auth/mfa/disable', { body: { password: disablePw }, auth: false }); toast('Verificação desativada'); setDisablePw(''); await login(); } catch (x: any) { toast(x.message, true); } }}>
                <Field label="Senha, para desativar"><input type="password" required value={disablePw} onChange={(e) => setDisablePw(e.target.value)} /></Field>
                <div><button className="btn ghost small">Desativar</button></div>
              </form>}
            </> : <>
              <p className="small muted" style={{ margin: 0 }}>Protege sua conta mesmo se a senha vazar. Você vai precisar de um aplicativo autenticador no celular.</p>
              <div><button className="btn" onClick={() => setSettingUp(true)}>Ativar</button></div>
            </>}
        </div>}
      </div>
    </>
  );
}

/** Leitura de matrícula por IA: transcreve e resume cada ato. O PDF não fica guardado. */
export function MatriculaTool() {
  const [file, setFile] = useState<File | null>(null);
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!file) return;
    setBusy(true); setErr(''); setRes(null);
    const form = new FormData(); form.append('file', file);
    try { setRes(await api('/api/ai/matricula', { form })); } catch (x: any) { setErr(x.message); }
    setBusy(false);
  };
  return (
    <>
      <PageHeader title="Leitura de matrícula" />
      <form className="panel stack" onSubmit={submit} style={{ maxWidth: 640 }}>
        <p className="small muted" style={{ margin: 0 }}>Envie o PDF da matrícula (escaneado ou digital). A IA transcreve o texto e resume cada ato. O arquivo é enviado ao provedor de IA para a leitura e não fica guardado na plataforma.</p>
        <Field label="PDF da matrícula (até 32 MB)"><input type="file" accept="application/pdf,.pdf" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        {err && <p className="error-text">{err}</p>}
        <div><button className="btn gold" disabled={busy || !file}>{busy ? 'Lendo a matrícula…' : 'Ler matrícula'}</button></div>
      </form>
      {res && <div className="panel stack" style={{ marginTop: '1rem' }}>
        <p className="notice" style={{ margin: 0 }}>{res.aviso}</p>
        <dl className="small" style={{ margin: 0 }}>
          <div><b>Matrícula:</b> {res.matricula ?? '—'}</div><div><b>Cartório:</b> {res.cartorio ?? '—'}</div><div><b>Imóvel:</b> {res.imovel ?? '—'}</div><div><b>Área declarada:</b> {res.area_declarada ?? '—'}</div>
          <div><b>Proprietários atuais:</b> {res.proprietarios_atuais?.join('; ') || '—'}</div>
        </dl>
        {res.onus_vigentes?.length > 0 ? <div className="notice bad" style={{ margin: 0 }}><b>Ônus vigentes:</b> {res.onus_vigentes.join('; ')}</div> : <p className="small" style={{ margin: 0 }}>Nenhum ônus vigente identificado na leitura.</p>}
        {res.pontos_de_atencao?.length > 0 && <div className="small"><b>Pontos de atenção:</b> {res.pontos_de_atencao.join('; ')}</div>}
        {res.atos?.length > 0 && <div className="table-wrap"><table className="data"><thead><tr><th>Ato</th><th>Data</th><th>Resumo</th></tr></thead><tbody>{res.atos.map((a: any, i: number) => <tr key={i}><td>{a.ato}</td><td className="small">{a.data ?? '—'}</td><td className="small">{a.resumo}</td></tr>)}</tbody></table></div>}
        {res.transcricao && <details><summary>Transcrição integral</summary><pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{res.transcricao}</pre></details>}
      </div>}
    </>
  );
}

const ACTION_LABEL: Record<string, string> = {
  create: 'Criou', update: 'Alterou', delete: 'Excluiu', upload: 'Enviou arquivo', export: 'Exportou', assign: 'Atribuiu intermediador', 'geometry.update': 'Atualizou perímetro',
  'publication.submit': 'Enviou para aprovação', 'publication.approve': 'Aprovou publicação', 'publication.reject': 'Devolveu publicação', 'publication.unpublish': 'Retirou do portal',
  'document.access': 'Gerou link de documento', 'document.download': 'Baixou documento', 'interest.reassign': 'Transferiu interesse', 'interest.convert': 'Converteu interesse',
  'privacy.erase': 'Anonimizou titular', version: 'Nova versão de proposta',
  'auth.login': 'Entrou', 'auth.failed': 'Tentativa de login incorreta', 'auth.locked': 'Conta bloqueada por tentativas', 'auth.invite_accepted': 'Aceitou o convite',
  'auth.password_reset': 'Redefiniu a senha', 'auth.password_changed': 'Trocou a senha', 'auth.mfa_enabled': 'Ativou duas etapas', 'auth.mfa_disabled': 'Desativou duas etapas',
  'auth.recovery_code': 'Usou código de recuperação', 'auth.reset_requested': 'Pediu redefinição de senha', 'user.invite': 'Convidou usuário', 'user.update': 'Alterou usuário', 'user.profile': 'Alterou os próprios dados',
  'user.invite_link': 'Gerou link de convite', 'user.reset_link': 'Gerou link de redefinição', 'user.mfa_reset': 'Zerou duas etapas', 'export.dxf': 'Exportou DXF', 'export.kml': 'Exportou KML', 'ai.matricula': 'Leu matrícula por IA',
};

export function Audit() {
  const [entity, setEntity] = useState('');
  const { data, loading } = useAsync(() => api(`/api/admin/audit${entity ? `?entity=${entity}` : ''}`), [entity]);
  return (
    <>
      <PageHeader title="Auditoria">
        <select className="input" style={{ width: 'auto' }} value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Entidade">
          <option value="">Todas as entidades</option>
          {['users', 'land_opportunities', 'land_documents', 'land_geometries', 'land_owners', 'negotiations', 'proposals', 'commissions', 'opportunity_interests', 'whatsapp_routing_rules', 'land_brokers'].map((e) => <option key={e}>{e}</option>)}
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
