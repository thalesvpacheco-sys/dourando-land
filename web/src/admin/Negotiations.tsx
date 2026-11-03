import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { NEGOTIATION_STAGES, formatArea, formatBRL, type NegotiationStage } from '@dl/shared';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { ErrorBox, Field, Loading, Modal, useAsync, useToast } from '../components/ui';
import { PageHeader } from './Shell';

const STAGES = Object.keys(NEGOTIATION_STAGES) as NegotiationStage[];
const ACT: Record<string, string> = { note: 'Nota', call: 'Ligação', meeting: 'Reunião', visit: 'Visita', whatsapp: 'WhatsApp', email: 'E-mail', task: 'Tarefa', stage_change: 'Etapa', system: 'Sistema' };
const PROP_STATUS: Record<string, [string, string]> = {
  draft: ['', 'Rascunho'], submitted: ['warn', 'Recebida'], internal_review: ['warn', 'Em análise interna'], approved_internal: ['ok', 'Aprovada internamente'],
  countered: ['warn', 'Contraproposta'], accepted: ['ok', 'Aceita'], rejected: ['bad', 'Recusada'], expired: ['bad', 'Expirada'],
};
const COMM: Record<string, [string, string]> = { prevista: ['', 'Prevista'], contratada: ['warn', 'Contratada'], exigivel: ['warn', 'Exigível'], paga: ['ok', 'Paga'], cancelada: ['bad', 'Cancelada'] };

export default function Negotiations() {
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const toast = useToast();
  const [status, setStatus] = useState('open');
  const { data, error, loading, reload, setData } = useAsync(() => api(`/api/negotiations?status=${status}`), [status]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const open = params.get('abrir');

  const move = async (id: string, stage: NegotiationStage) => {
    const n = data.items.find((x: any) => x.id === id);
    if (!n || n.stage === stage) return;
    setData({ ...data, items: data.items.map((x: any) => (x.id === id ? { ...x, stage } : x)) });
    try {
      const full = await api(`/api/negotiations/${id}`);
      await api(`/api/negotiations/${id}`, { method: 'PATCH', body: { version: full.version, stage } });
      toast(`Movida para ${NEGOTIATION_STAGES[stage]}`);
    } catch (e: any) { toast(e.message, true); }
    reload();
  };

  return (
    <>
      <PageHeader title="Negociações">
        <select className="input" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="open">Em andamento</option><option value="won">Concluídas</option><option value="lost,suspended">Perdidas ou suspensas</option>
        </select>
        {can('negotiation', 'create') && <button className="btn gold" onClick={() => setCreating(true)}>Nova negociação</button>}
      </PageHeader>
      <p className="muted small" style={{ marginTop: '-0.5rem' }}>Arraste um cartão para mudar a etapa, ou abra o cartão e use o seletor. Etapas anteriores (captação, qualificação, disponível) ficam na situação da área.</p>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : (
        <div className="board">
          {STAGES.map((s) => {
            const items = data.items.filter((n: any) => n.stage === s);
            const total = items.reduce((t: number, n: any) => t + (Number(n.proposed_value) || 0), 0);
            return (
              <section key={s} className={`col ${over === s ? 'over' : ''}`} aria-label={NEGOTIATION_STAGES[s]}
                onDragOver={(e) => { if (can('negotiation', 'update')) { e.preventDefault(); setOver(s); } }} onDragLeave={() => setOver(null)}
                onDrop={(e) => { e.preventDefault(); setOver(null); if (dragging) void move(dragging, s); }}>
                <h3><span>{NEGOTIATION_STAGES[s]}</span><span className="muted">{items.length}</span></h3>
                {total > 0 && <span className="small muted" style={{ padding: '0 0.3rem' }}>{formatBRL(total)}</span>}
                {items.map((n: any) => {
                  const late = n.next_activity_at && new Date(n.next_activity_at) < new Date();
                  return (
                    <button key={n.id} className="deal" draggable={can('negotiation', 'update')} onDragStart={() => setDragging(n.id)} onDragEnd={() => setDragging(null)} onClick={() => setParams({ abrir: n.id })}>
                      <span className="small muted">{n.code} · {n.city}/{n.uf}</span>
                      <b>{n.partner_name ?? n.contact_name}</b>
                      {n.proposed_value && <span>{formatBRL(n.proposed_value)}{n.proposed_model ? ` · ${n.proposed_model}` : ''}</span>}
                      {n.next_activity && <span className={late ? 'late' : 'muted'}>{late ? 'Atrasada: ' : ''}{n.next_activity}{n.next_activity_at ? ` · ${new Date(n.next_activity_at).toLocaleDateString('pt-BR')}` : ''}</span>}
                      {n.brokers && <span className="small muted">{n.brokers}</span>}
                    </button>
                  );
                })}
              </section>
            );
          })}
        </div>
      )}
      {open && <NegotiationDrawer id={open} onClose={() => setParams({})} onChanged={reload} />}
      {creating && <CreateNegotiation onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); reload(); setParams({ abrir: id }); }} />}
    </>
  );
}

function CreateNegotiation({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const areas = useAsync(() => api('/api/opportunities'), []);
  const partners = useAsync(() => api('/api/partners').catch(() => ({ items: [] })), []);
  const [f, setF] = useState<any>({ opportunity_id: '', partner_company_id: '', contact_name: '', contact_email: '', contact_phone: '' });
  const [err, setErr] = useState('');
  return (
    <Modal title="Nova negociação" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); try { const n = await api('/api/negotiations', { body: { ...f, partner_company_id: f.partner_company_id || null } }); onCreated(n.id); } catch (er: any) { setErr(er.message); } }}>
        <Field label="Área"><select required value={f.opportunity_id} onChange={(e) => setF({ ...f, opportunity_id: e.target.value })}><option value="">Escolha…</option>{areas.data?.items.map((o: any) => <option key={o.id} value={o.id}>{o.code} — {o.public_title ?? o.internal_name}</option>)}</select></Field>
        <Field label="Empresa interessada"><select value={f.partner_company_id} onChange={(e) => { const p = partners.data?.items.find((x: any) => x.id === e.target.value); setF({ ...f, partner_company_id: e.target.value, contact_name: p?.contact_name ?? f.contact_name, contact_email: p?.contact_email ?? f.contact_email }); }}><option value="">Não cadastrada</option>{partners.data?.items.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Contato"><input required value={f.contact_name} onChange={(e) => setF({ ...f, contact_name: e.target.value })} /></Field>
        <div className="grid2"><Field label="E-mail"><input type="email" value={f.contact_email} onChange={(e) => setF({ ...f, contact_email: e.target.value })} /></Field><Field label="Telefone"><input value={f.contact_phone} onChange={(e) => setF({ ...f, contact_phone: e.target.value })} /></Field></div>
        {err && <p className="error-text">{err}</p>}
        <div className="row"><button className="btn">Criar negociação</button><button type="button" className="btn ghost" onClick={onClose}>Cancelar</button></div>
      </form>
    </Modal>
  );
}

function NegotiationDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { data: n, reload, error } = useAsync(() => api(`/api/negotiations/${id}`), [id]);
  const [act, setAct] = useState({ type: 'note', subject: '', body: '', due_at: '' });
  const [proposal, setProposal] = useState<{ pid?: string; side: string } | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [comm, setComm] = useState(false);
  const [lost, setLost] = useState<string | null>(null);
  useEffect(() => setSummary(null), [id]);
  const run = async (fn: () => Promise<any>, msg: string) => { try { await fn(); toast(msg); reload(); onChanged(); } catch (e: any) { toast(e.message, true); } };
  const patch = (body: any) => run(() => api(`/api/negotiations/${id}`, { method: 'PATCH', body: { version: n.version, ...body } }), 'Negociação atualizada');

  if (error) return <Modal title="Negociação" onClose={onClose} drawer><ErrorBox error={error} /></Modal>;
  if (!n) return <Modal title="Negociação" onClose={onClose} drawer><Loading /></Modal>;
  const p = n.permissions;
  return (
    <Modal title={n.partner?.name ?? n.contact_name} onClose={onClose} drawer>
      <div className="stack">
        <div className="row">
          <Link to={`/painel/areas/${n.opportunity.id}`} className="badge ink" style={{ textDecoration: 'none' }}>{n.opportunity.code}</Link>
          <span className="muted small">{n.opportunity.public_title ?? n.opportunity.internal_name} · {formatArea(n.opportunity.area_m2)} · {n.opportunity.city}/{n.opportunity.uf}</span>
        </div>
        <div className="grid3">
          <Field label="Etapa"><select value={n.stage} disabled={!p.update} onChange={(e) => patch({ stage: e.target.value })}>{STAGES.map((s) => <option key={s} value={s}>{NEGOTIATION_STAGES[s]}</option>)}</select></Field>
          <Field label="Previsão de fechamento"><input type="date" disabled={!p.update} defaultValue={n.expected_close ?? ''} onBlur={(e) => e.target.value !== (n.expected_close ?? '') && patch({ expected_close: e.target.value || null })} /></Field>
          <Field label="Status"><select value={n.status} disabled={!p.update} onChange={(e) => (e.target.value === 'lost' || e.target.value === 'suspended' ? setLost(e.target.value) : patch({ status: e.target.value }))}>
            <option value="open">Em andamento</option><option value="won">Concluída</option><option value="lost">Perdida</option><option value="suspended">Suspensa</option></select></Field>
        </div>
        {n.lost_reason && <p className="notice bad" style={{ margin: 0 }}>Motivo: {n.lost_reason}</p>}
        <dl className="spec">
          <dt>Contato</dt><dd>{n.contact_name}{n.contact_email ? ` · ${n.contact_email}` : ''}{n.contact_phone ? ` · ${n.contact_phone}` : ''}</dd>
          <dt>Modelo / valor proposto</dt><dd>{n.proposed_model ?? '—'} {n.proposed_value ? `· ${formatBRL(n.proposed_value)}` : ''}</dd>
          <dt>Intermediadores</dt><dd>{n.participants.map((x: any) => x.name).join(', ') || '—'}</dd>
          <dt>Próxima atividade</dt><dd>{n.next_activity ?? '—'}{n.next_activity_at ? ` · ${new Date(n.next_activity_at).toLocaleString('pt-BR')}` : ''}</dd>
          <dt>CRM WingsBr</dt><dd className="small">{n.crm_contact_id ? `contato ${n.crm_contact_id}` : 'contato pendente'}{n.crm_deal_id ? ` · negócio ${n.crm_deal_id}` : ''}</dd>
        </dl>

        <div className="row">
          <button className="btn ghost small" onClick={async () => { const r = await api(`/api/ai/negotiations/${id}/summary`, { method: 'POST' }); setSummary(r.text); }}>Resumir negociação</button>
        </div>
        {summary && <div className="notice"><p className="small" style={{ margin: '0 0 0.3rem' }}><b>Sugestão gerada a partir dos registros</b></p><p style={{ margin: 0, whiteSpace: 'pre-line' }}>{summary}</p></div>}

        <section>
          <div className="panel-head"><h2 style={{ fontSize: '1.05rem' }}>Propostas</h2>{p.propose && <button className="btn small" onClick={() => setProposal({ side: 'comprador' })}>Registrar proposta</button>}</div>
          {n.proposals.length === 0 && <p className="muted small">Nenhuma proposta registrada.</p>}
          {n.proposals.map((pr: any) => {
            const [cls, label] = PROP_STATUS[pr.status] ?? ['', pr.status];
            const cur = pr.versions[0];
            const closed = ['accepted', 'rejected', 'expired'].includes(pr.status);
            return (
              <div key={pr.id} className="panel" style={{ marginBottom: '0.6rem' }}>
                <div className="spread"><span><b>{formatBRL(cur?.acquisition_value)}</b>{cur?.swap_pct ? ` · permuta ${cur.swap_pct}%` : ''} <span className="muted small">v{pr.current_version} · {cur?.side}</span></span><span className={`badge ${cls}`}>{label}</span></div>
                {cur?.suspensive_conditions && <p className="small" style={{ margin: '0.4rem 0 0' }}>Condições: {cur.suspensive_conditions}</p>}
                {cur?.payment_schedule?.length > 0 && <p className="small muted" style={{ margin: '0.2rem 0 0' }}>{cur.payment_schedule.map((s: any) => `${s.label}: ${formatBRL(s.amount)}${s.due ? ` (${s.due})` : ''}`).join(' · ')}</p>}
                {cur?.valid_until && <p className="small muted" style={{ margin: '0.2rem 0 0' }}>Válida até {new Date(cur.valid_until + 'T12:00').toLocaleDateString('pt-BR')}{cur.analysis_days ? ` · ${cur.analysis_days} dias de análise` : ''}</p>}
                <details style={{ marginTop: '0.4rem' }}><summary className="small">Histórico de versões ({pr.versions.length})</summary>
                  <table className="data" style={{ marginTop: '0.4rem' }}><thead><tr><th>Versão</th><th>Lado</th><th className="r">Valor</th><th className="r">Permuta</th><th>Autor</th><th>Data</th></tr></thead>
                    <tbody>{pr.versions.map((v: any) => <tr key={v.id}><td>v{v.version}</td><td>{v.side}</td><td className="r num">{formatBRL(v.acquisition_value)}</td><td className="r">{v.swap_pct ? `${v.swap_pct}%` : '—'}</td><td className="small">{v.author}</td><td className="small">{new Date(v.created_at).toLocaleDateString('pt-BR')}</td></tr>)}</tbody></table>
                  {pr.approvals.map((a: any) => <p key={a.id} className="small muted" style={{ margin: '0.3rem 0 0' }}>v{a.version} {a.decision === 'approved' ? 'aprovada' : 'recusada'} internamente por {a.approver}{a.comment ? `: ${a.comment}` : ''}</p>)}
                </details>
                {!closed && (
                  <div className="row" style={{ marginTop: '0.6rem' }}>
                    {p.propose && <button className="btn ghost small" onClick={() => setProposal({ pid: pr.id, side: 'vendedor' })}>Contraproposta</button>}
                    {p.propose && <button className="btn ghost small" onClick={() => setProposal({ pid: pr.id, side: 'comprador' })}>Nova versão do comprador</button>}
                    {p.update && pr.status !== 'internal_review' && pr.status !== 'approved_internal' && <button className="btn ghost small" onClick={() => run(() => api(`/api/proposals/${pr.id}/internal-review`, { method: 'POST' }), 'Enviada para análise interna')}>Enviar para análise interna</button>}
                    {p.approve && <button className="btn small" onClick={() => run(() => api(`/api/proposals/${pr.id}/approval`, { body: { decision: 'approved' } }), 'Versão aprovada internamente')}>Aprovar v{pr.current_version}</button>}
                    {p.update && <button className="btn gold small" disabled={pr.status !== 'approved_internal' && !p.approve} title={pr.status !== 'approved_internal' ? 'Requer aprovação interna' : undefined} onClick={() => run(() => api(`/api/proposals/${pr.id}/status`, { body: { status: 'accepted' } }), 'Proposta aceita')}>Registrar aceite</button>}
                    {p.update && <button className="btn link small" onClick={() => run(() => api(`/api/proposals/${pr.id}/status`, { body: { status: 'rejected' } }), 'Proposta recusada')}>Recusar</button>}
                  </div>
                )}
              </div>
            );
          })}
        </section>

        {(n.commissions.length > 0 || p.commission) && (
          <section>
            <div className="panel-head"><h2 style={{ fontSize: '1.05rem' }}>Comissões (confidencial)</h2>{p.commission && <button className="btn ghost small" onClick={() => setComm(true)}>Registrar comissão prevista</button>}</div>
            {n.commissions.map((c: any) => <CommissionRow key={c.id} c={c} canEdit={p.commission} oppId={n.opportunity.id} onDone={reload} />)}
            <p className="small muted">A comissão só avança com contrato de intermediação vinculado e evento contratual registrado. Proposta ou cadastro não geram comissão devida.</p>
          </section>
        )}

        <section>
          <h2 style={{ fontSize: '1.05rem', marginBottom: '0.6rem' }}>Atividades</h2>
          {p.update && (
            <form className="stack-s panel" style={{ background: 'var(--paper)', marginBottom: '0.8rem' }} onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/negotiations/${id}/activities`, { body: { ...act, due_at: act.due_at ? new Date(act.due_at).toISOString() : undefined } }), 'Atividade registrada').then(() => setAct({ type: 'note', subject: '', body: '', due_at: '' })); }}>
              <div className="row">
                <select className="input" style={{ width: 'auto' }} value={act.type} onChange={(e) => setAct({ ...act, type: e.target.value })} aria-label="Tipo">{['note', 'call', 'meeting', 'visit', 'whatsapp', 'email', 'task'].map((t) => <option key={t} value={t}>{ACT[t]}</option>)}</select>
                <input className="input" style={{ flex: 1, minWidth: 180 }} required placeholder="Assunto" value={act.subject} onChange={(e) => setAct({ ...act, subject: e.target.value })} aria-label="Assunto" />
                <input className="input" style={{ width: 'auto' }} type="datetime-local" value={act.due_at} onChange={(e) => setAct({ ...act, due_at: e.target.value })} aria-label="Agendar para" title="Preencha para agendar como próxima atividade" />
              </div>
              <textarea className="input" placeholder="Detalhes (opcional)" value={act.body} onChange={(e) => setAct({ ...act, body: e.target.value })} style={{ minHeight: 60 }} aria-label="Detalhes" />
              <div><button className="btn small">{act.due_at ? 'Agendar atividade' : 'Registrar atividade'}</button></div>
            </form>
          )}
          <div className="timeline">
            {n.activities.map((a: any) => (
              <div key={a.id} className={['system', 'stage_change'].includes(a.type) ? 'sys' : ''}>
                <b>{ACT[a.type] ?? a.type}:</b> {a.subject} <span className="muted small">{new Date(a.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}{a.user_name ? ` · ${a.user_name}` : ''}</span>
                {a.body && <div className="small muted">{a.body}</div>}
                {a.due_at && !a.done_at && <div className="row small"><span className="badge warn">Agendada para {new Date(a.due_at).toLocaleString('pt-BR')}</span>{p.update && <button className="btn link small" onClick={() => run(() => api(`/api/negotiations/activities/${a.id}/done`, { method: 'POST' }), 'Atividade concluída')}>Concluir</button>}</div>}
              </div>
            ))}
          </div>
        </section>
      </div>
      {proposal && <ProposalModal negotiationId={id} pid={proposal.pid} side={proposal.side} brokers={n.participants} onClose={() => setProposal(null)} onDone={() => { setProposal(null); reload(); onChanged(); }} />}
      {comm && <CommissionModal negotiationId={id} brokers={n.participants} onClose={() => setComm(false)} onDone={() => { setComm(false); reload(); }} />}
      {lost && (
        <Modal title={lost === 'lost' ? 'Marcar como perdida' : 'Suspender negociação'} onClose={() => setLost(null)}>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); const reason = (e.currentTarget.elements.namedItem('reason') as HTMLInputElement).value; void patch({ status: lost, lost_reason: reason }).then(() => setLost(null)); }}>
            <Field label="Motivo"><input name="reason" required minLength={3} placeholder="Ex.: comprador optou por outra área" /></Field>
            <div className="row"><button className="btn">Confirmar</button><button type="button" className="btn ghost" onClick={() => setLost(null)}>Cancelar</button></div>
          </form>
        </Modal>
      )}
    </Modal>
  );
}

function ProposalModal({ negotiationId, pid, side, brokers, onClose, onDone }: { negotiationId: string; pid?: string; side: string; brokers: any[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<any>({ acquisition_value: '', swap_pct: '', suspensive_conditions: '', analysis_days: '', valid_until: '', notes: '', schedule: [{ label: 'Sinal', amount: '', due: 'Na assinatura' }] });
  const [err, setErr] = useState('');
  const num = (v: string) => (v === '' ? null : Number(String(v).replace(/\./g, '').replace(',', '.')));
  return (
    <Modal title={pid ? (side === 'vendedor' ? 'Contraproposta' : 'Nova versão da proposta') : 'Registrar proposta'} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault(); setErr('');
        const body = {
          side, acquisition_value: num(f.acquisition_value), swap_pct: num(f.swap_pct), suspensive_conditions: f.suspensive_conditions || null,
          analysis_days: f.analysis_days ? Number(f.analysis_days) : null, valid_until: f.valid_until || null, notes: f.notes || null,
          payment_schedule: f.schedule.filter((s: any) => s.label).map((s: any) => ({ label: s.label, amount: num(s.amount), due: s.due })), broker_ids: brokers.map((b) => b.id),
        };
        try { await api(pid ? `/api/proposals/${pid}/versions` : `/api/negotiations/${negotiationId}/proposals`, { body }); onDone(); } catch (er: any) { setErr(er.message); }
      }}>
        <div className="grid2">
          <Field label="Valor de aquisição (R$)"><input inputMode="decimal" value={f.acquisition_value} onChange={(e) => setF({ ...f, acquisition_value: e.target.value })} /></Field>
          <Field label="Percentual de permuta (%)"><input inputMode="decimal" value={f.swap_pct} onChange={(e) => setF({ ...f, swap_pct: e.target.value })} /></Field>
          <Field label="Prazo de análise (dias)"><input inputMode="numeric" value={f.analysis_days} onChange={(e) => setF({ ...f, analysis_days: e.target.value })} /></Field>
          <Field label="Validade da proposta"><input type="date" value={f.valid_until} onChange={(e) => setF({ ...f, valid_until: e.target.value })} /></Field>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack-s">
          <legend className="small" style={{ color: 'var(--ink-2)', marginBottom: 4 }}>Cronograma de pagamentos</legend>
          {f.schedule.map((s: any, i: number) => (
            <div className="row" key={i}>
              <input className="input" style={{ flex: 1 }} placeholder="Parcela" value={s.label} aria-label="Parcela" onChange={(e) => setF({ ...f, schedule: f.schedule.map((x: any, k: number) => (k === i ? { ...x, label: e.target.value } : x)) })} />
              <input className="input" style={{ width: 140 }} placeholder="Valor" inputMode="decimal" value={s.amount} aria-label="Valor" onChange={(e) => setF({ ...f, schedule: f.schedule.map((x: any, k: number) => (k === i ? { ...x, amount: e.target.value } : x)) })} />
              <input className="input" style={{ width: 140 }} placeholder="Quando" value={s.due} aria-label="Quando" onChange={(e) => setF({ ...f, schedule: f.schedule.map((x: any, k: number) => (k === i ? { ...x, due: e.target.value } : x)) })} />
            </div>
          ))}
          <div><button type="button" className="btn ghost small" onClick={() => setF({ ...f, schedule: [...f.schedule, { label: '', amount: '', due: '' }] })}>Adicionar parcela</button></div>
        </fieldset>
        <Field label="Condições suspensivas"><textarea value={f.suspensive_conditions} onChange={(e) => setF({ ...f, suspensive_conditions: e.target.value })} /></Field>
        <Field label="Observações"><textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} style={{ minHeight: 60 }} /></Field>
        {err && <p className="error-text">{err}</p>}
        <div className="row"><button className="btn">Salvar versão</button><button type="button" className="btn ghost" onClick={onClose}>Cancelar</button></div>
      </form>
    </Modal>
  );
}

function CommissionModal({ negotiationId, brokers, onClose, onDone }: { negotiationId: string; brokers: any[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<any>({ broker_id: '', beneficiary_name: '', pct: '', amount: '', trigger_condition: 'Assinatura da escritura' });
  const [err, setErr] = useState('');
  return (
    <Modal title="Registrar comissão prevista" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); try { await api(`/api/negotiations/${negotiationId}/commissions`, { body: { broker_id: f.broker_id || null, beneficiary_name: f.beneficiary_name, pct: f.pct ? Number(f.pct) : null, amount: f.amount ? Number(f.amount) : null, trigger_condition: f.trigger_condition } }); onDone(); } catch (er: any) { setErr(er.message); } }}>
        <Field label="Intermediador"><select value={f.broker_id} onChange={(e) => { const b = brokers.find((x) => x.id === e.target.value); setF({ ...f, broker_id: e.target.value, beneficiary_name: b?.name ?? f.beneficiary_name }); }}><option value="">Outro beneficiário</option>{brokers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="Beneficiário"><input required value={f.beneficiary_name} onChange={(e) => setF({ ...f, beneficiary_name: e.target.value })} /></Field>
        <div className="grid2"><Field label="Percentual (%)"><input inputMode="decimal" value={f.pct} onChange={(e) => setF({ ...f, pct: e.target.value })} /></Field><Field label="Valor estimado (R$)"><input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field></div>
        <Field label="Evento de exigibilidade previsto em contrato"><input value={f.trigger_condition} onChange={(e) => setF({ ...f, trigger_condition: e.target.value })} /></Field>
        {err && <p className="error-text">{err}</p>}
        <div className="row"><button className="btn">Registrar</button><button type="button" className="btn ghost" onClick={onClose}>Cancelar</button></div>
      </form>
    </Modal>
  );
}

function CommissionRow({ c, canEdit, oppId, onDone }: { c: any; canEdit: boolean; oppId: string; onDone: () => void }) {
  const toast = useToast();
  const [t, setT] = useState<string | null>(null);
  const [form, setForm] = useState<any>({});
  const docs = useAsync(() => (t === 'contratada' ? api(`/api/opportunities/${oppId}`).then((o) => o.documents.filter((d: any) => d.category === 'contrato_intermediacao')) : Promise.resolve([])), [t]);
  const [cls, label] = COMM[c.status];
  const next: Record<string, string[]> = { prevista: ['contratada', 'cancelada'], contratada: ['exigivel', 'cancelada'], exigivel: ['paga', 'cancelada'], paga: [], cancelada: [] };
  return (
    <div className="spread" style={{ borderBottom: '1px solid var(--line-2)', padding: '0.5rem 0' }}>
      <div><b>{c.beneficiary_name}</b> <span className="muted small">{c.pct ? `${c.pct}%` : ''}{c.amount ? ` · ${formatBRL(c.amount)}` : ''}{c.trigger_condition ? ` · ${c.trigger_condition}` : ''}</span></div>
      <div className="row"><span className={`badge ${cls}`}>{label}</span>
        {canEdit && next[c.status].map((to) => <button key={to} className="btn link small" onClick={() => { setT(to); setForm({}); }}>{COMM[to][1]}</button>)}
      </div>
      {t && (
        <Modal title={`Comissão: ${COMM[t][1]}`} onClose={() => setT(null)}>
          <form className="stack" onSubmit={async (e) => { e.preventDefault(); try { await api(`/api/proposals/commissions/${c.id}/transition`, { body: { to: t, ...form } }); toast('Comissão atualizada'); setT(null); onDone(); } catch (er: any) { toast(er.message, true); } }}>
            {t === 'contratada' && <Field label="Contrato de intermediação" hint="Documento da área na categoria Contrato de intermediação"><select required value={form.contract_document_id ?? ''} onChange={(e) => setForm({ ...form, contract_document_id: e.target.value })}><option value="">Escolha…</option>{(docs.data ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.title} (v{d.version})</option>)}</select></Field>}
            {t === 'exigivel' && <><Field label="Evento contratual que tornou a comissão exigível"><input required value={form.note ?? ''} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field><Field label="Vencimento"><input type="date" value={form.due_at ?? ''} onChange={(e) => setForm({ ...form, due_at: e.target.value })} /></Field></>}
            {t === 'paga' && <Field label="Data do pagamento"><input type="date" required value={form.paid_at ?? ''} onChange={(e) => setForm({ ...form, paid_at: e.target.value })} /></Field>}
            {t === 'cancelada' && <Field label="Justificativa"><input required value={form.note ?? ''} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>}
            <div className="row"><button className="btn">Confirmar</button><button type="button" className="btn ghost" onClick={() => setT(null)}>Cancelar</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}
