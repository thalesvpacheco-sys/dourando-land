import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useSession } from '../lib/session';
import { Empty, ErrorBox, Field, Loading, Modal, useAsync, useToast } from '../components/ui';
import { PageHeader } from './Shell';

export const INTEREST_STATUS: Record<string, [string, string]> = {
  clicked: ['', 'Clique no WhatsApp'],
  form_submitted: ['warn', 'Formulário enviado'],
  conversation_started: ['warn', 'Conversa iniciada'],
  message_received: ['ok', 'Mensagem recebida'],
  qualified: ['ok', 'Qualificado'],
  discarded: ['bad', 'Descartado'],
};
const EVENT_LABEL: Record<string, string> = {
  click: 'Clique no botão WhatsApp', form: 'Formulário enviado', routed: 'Encaminhado', reassigned: 'Transferido', conversation_started: 'Conversa iniciada (webhook)',
  message_received: 'Mensagem recebida com o código', crm_synced: 'Registrado no CRM WingsBr', first_response: 'Primeiro atendimento', discarded: 'Descartado',
};

export default function Interests() {
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const f = { status: params.get('status') ?? '', overdue: params.get('overdue') ?? '' };
  const { data, error, loading, reload } = useAsync(() => api(`/api/interests${qs(f)}`), [f.status, f.overdue]);
  const unlinked = useAsync(() => (can('routing', 'read') ? api('/api/interests/inbound/unlinked') : Promise.resolve({ items: [] })), []);
  const [open, setOpen] = useState<string | null>(null);
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); v ? n.set(k, v) : n.delete(k); setParams(n); };

  return (
    <>
      <PageHeader title="Interesses" />
      <p className="muted" style={{ marginTop: '-0.5rem', maxWidth: '75ch' }}>
        O clique no WhatsApp não garante que a mensagem foi enviada. "Mensagem recebida" só aparece quando o webhook oficial confirma uma mensagem com o código de referência.
      </p>
      <div className="row" style={{ marginBottom: '1rem' }}>
        <select className="input" style={{ width: 'auto' }} value={f.status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
          <option value="">Todos os status</option>
          {Object.entries(INTEREST_STATUS).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <label className="check small"><input type="checkbox" checked={!!f.overdue} onChange={(e) => set('overdue', e.target.checked ? '1' : '')} /> Somente fora do prazo de atendimento</label>
      </div>

      {unlinked.data?.items.length > 0 && (
        <div className="panel" style={{ marginBottom: '1rem' }}>
          <div className="panel-head"><h2>Mensagens de WhatsApp sem código de referência</h2><span className="badge warn">{unlinked.data.items.length}</span></div>
          <p className="small muted">A pessoa apagou ou alterou a mensagem pré-preenchida. Vincule manualmente a um interesse só quando tiver certeza de quem é.</p>
          {unlinked.data.items.map((m: any) => <UnlinkedRow key={m.id} m={m} interests={data?.items ?? []} onDone={() => { unlinked.reload(); reload(); }} />)}
        </div>
      )}

      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : data?.items.length === 0 ? <div className="panel"><Empty title="Nenhum interesse com esses filtros" /></div> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Recebido</th><th>Área</th><th>Contato</th><th>Origem</th><th>Status</th><th>Responsável</th><th>Atendimento</th><th>CRM</th></tr></thead>
            <tbody>
              {data?.items.map((i: any) => {
                const [cls, label] = INTEREST_STATUS[i.status] ?? ['', i.status];
                return (
                  <tr key={i.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(i.id)}>
                    <td className="small">{new Date(i.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}<div className="muted">{i.intent_token}</div></td>
                    <td><b>{i.code}</b><div className="small muted">{i.city}/{i.uf}</div></td>
                    <td>{i.name ?? <span className="muted">Anônimo</span>}{i.company && <div className="small muted">{i.company}</div>}</td>
                    <td className="small">{i.channel}<div className="muted">{i.kind === 'form' ? 'Formulário' : 'WhatsApp'}</div></td>
                    <td><span className={`badge ${cls}`}>{label}</span></td>
                    <td className="small">{i.broker_name ?? 'Central'}<div className="muted">{i.routed_via}</div></td>
                    <td>{i.first_response_at ? <span className="badge ok">Atendido</span> : i.name && i.status !== 'discarded' ? (i.sla_breached ? <span className="badge bad">Fora do prazo</span> : <span className="badge warn">No prazo</span>) : <span className="muted small">—</span>}</td>
                    <td className="small">{i.crm_sync_status === 'synced' ? <span className="badge ok">Sincronizado</span> : i.crm_sync_status === 'pending' ? <span className="badge warn">Na fila</span> : i.crm_sync_status === 'failed' ? <span className="badge bad">Falhou</span> : <span className="muted">Sem dados pessoais</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && <InterestDrawer id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </>
  );
}

function UnlinkedRow({ m, interests, onDone }: { m: any; interests: any[]; onDone: () => void }) {
  const [sel, setSel] = useState('');
  const toast = useToast();
  return (
    <div className="spread" style={{ borderTop: '1px solid var(--line-2)', padding: '0.6rem 0' }}>
      <div><span className="small muted">{m.from_masked} · {new Date(m.received_at).toLocaleString('pt-BR')}</span><div>"{m.text}"</div></div>
      <div className="row">
        <select className="input" style={{ width: 280 }} value={sel} onChange={(e) => setSel(e.target.value)} aria-label="Interesse para vincular">
          <option value="">Escolha o interesse…</option>
          {interests.filter((i) => i.status !== 'discarded').slice(0, 60).map((i) => <option key={i.id} value={i.id}>{i.intent_token} · {i.code} · {i.name ?? 'anônimo'}</option>)}
        </select>
        <button className="btn small" disabled={!sel} onClick={async () => { await api(`/api/interests/inbound/${m.id}/link`, { body: { interest_id: sel } }); toast('Mensagem vinculada'); onDone(); }}>Vincular</button>
      </div>
    </div>
  );
}

function InterestDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const { data: i, reload } = useAsync(() => api(`/api/interests/${id}`), [id]);
  const brokers = useAsync(() => (can('routing', 'update') ? api('/api/admin/brokers') : Promise.resolve({ items: [] })), []);
  const [reassign, setReassign] = useState({ broker_id: '', reason: '' });
  const [convert, setConvert] = useState(false);
  const [discard, setDiscard] = useState(false);
  const act = async (fn: () => Promise<any>, msg: string) => { try { await fn(); toast(msg); reload(); onChanged(); } catch (e: any) { toast(e.message, true); } };
  if (!i) return <Modal title="Interesse" onClose={onClose} drawer><Loading /></Modal>;
  const [cls, label] = INTEREST_STATUS[i.status] ?? ['', i.status];
  return (
    <Modal title={`Interesse ${i.intent_token}`} onClose={onClose} drawer>
      <div className="stack">
        <div className="row"><span className={`badge ${cls}`}>{label}</span><span className="muted small">{i.kind === 'form' ? 'Formulário' : 'Botão WhatsApp'} · origem {i.channel}</span></div>
        <dl className="spec">
          <dt>Contato</dt><dd>{i.name ?? 'Anônimo'}{i.company ? ` — ${i.company}` : ''}</dd>
          {i.email && <><dt>E-mail</dt><dd>{i.email}</dd></>}
          {i.phone && <><dt>Telefone</dt><dd>{i.phone}</dd></>}
          {i.message && <><dt>Mensagem</dt><dd>{i.message}</dd></>}
          <dt>Base legal</dt><dd>{i.legal_basis ?? 'Sem dados pessoais'}</dd>
          <dt>Encaminhado a</dt><dd>{i.routed_to_number ?? '—'} · {i.routed_via}</dd>
          <dt>Prazo de atendimento</dt><dd>{i.sla_due_at ? new Date(i.sla_due_at).toLocaleString('pt-BR') : '—'}{i.first_response_at && ` · atendido em ${new Date(i.first_response_at).toLocaleString('pt-BR')}`}</dd>
          <dt>CRM WingsBr</dt><dd>{i.crm_contact_id ?? '—'}{i.crm_lead_id ? ` · lead ${i.crm_lead_id}` : ''}</dd>
          {Object.keys(i.attribution ?? {}).length > 0 && <><dt>Atribuição</dt><dd className="small">{Object.entries(i.attribution).map(([k, v]) => `${k}=${v}`).join(' · ')}</dd></>}
        </dl>
        <div className="row">
          {!i.first_response_at && can('interest', 'update') && <button className="btn" onClick={() => act(() => api(`/api/interests/${i.id}/first-response`, { method: 'POST' }), 'Primeiro atendimento registrado')}>Registrar primeiro atendimento</button>}
          {i.negotiation_id ? <Link className="btn ghost" to={`/painel/negociacoes?abrir=${i.negotiation_id}`}>Abrir negociação</Link>
            : can('interest', 'update') && <button className="btn ghost" onClick={() => setConvert(true)}>Converter em negociação</button>}
          {i.status !== 'discarded' && can('interest', 'update') && <button className="btn danger" onClick={() => setDiscard(true)}>Descartar</button>}
        </div>

        {can('routing', 'update') && (
          <div className="panel" style={{ background: 'var(--paper)' }}>
            <h3 style={{ fontSize: '0.95rem', marginBottom: '0.5rem' }}>Transferir atendimento</h3>
            <div className="row">
              <select className="input" style={{ width: 220 }} value={reassign.broker_id} onChange={(e) => setReassign({ ...reassign, broker_id: e.target.value })} aria-label="Novo responsável">
                <option value="">Central Dourado</option>
                {brokers.data?.items.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Motivo" value={reassign.reason} onChange={(e) => setReassign({ ...reassign, reason: e.target.value })} aria-label="Motivo" />
              <button className="btn small" disabled={reassign.reason.length < 3} onClick={() => act(() => api(`/api/interests/${i.id}/reassign`, { body: { broker_id: reassign.broker_id || null, reason: reassign.reason } }), 'Atendimento transferido')}>Transferir</button>
            </div>
          </div>
        )}

        <div>
          <h3 style={{ fontSize: '0.95rem', marginBottom: '0.6rem' }}>Linha do tempo</h3>
          <div className="timeline">
            {i.events.map((e: any) => (
              <div key={e.id} className={['click', 'routed', 'crm_synced'].includes(e.type) ? 'sys' : ''}>
                <b>{EVENT_LABEL[e.type] ?? e.type}</b> <span className="muted small">{new Date(e.created_at).toLocaleString('pt-BR')}{e.user_name ? ` · ${e.user_name}` : ''}</span>
                {e.payload?.via && <div className="small muted">{e.payload.via}{e.payload.broker ? ` → ${e.payload.broker}` : ''}</div>}
                {e.payload?.reason && <div className="small muted">Motivo: {e.payload.reason}{e.payload.to_name ? ` → ${e.payload.to_name}` : ''}</div>}
              </div>
            ))}
          </div>
        </div>
        {i.inbound.length > 0 && (
          <div>
            <h3 style={{ fontSize: '0.95rem', marginBottom: '0.6rem' }}>Mensagens recebidas</h3>
            {i.inbound.map((m: any) => <p key={m.id} className="notice" style={{ margin: '0 0 0.4rem' }}><span className="small muted">{m.from_masked} · {new Date(m.received_at).toLocaleString('pt-BR')} · {m.link_status === 'linked_token' ? 'vinculada pelo código' : 'vínculo manual'}</span><br />{m.text}</p>)}
          </div>
        )}
      </div>
      {discard && (
        <Modal title="Descartar interesse" onClose={() => setDiscard(false)}>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); const reason = (e.currentTarget.elements.namedItem('reason') as HTMLInputElement).value; void act(() => api(`/api/interests/${i.id}/discard`, { body: { reason } }), 'Interesse descartado').then(() => setDiscard(false)); }}>
            <Field label="Motivo"><input name="reason" required minLength={3} placeholder="Ex.: contato duplicado, fora do perfil" /></Field>
            <div className="row"><button className="btn danger">Descartar</button><button type="button" className="btn ghost" onClick={() => setDiscard(false)}>Cancelar</button></div>
          </form>
        </Modal>
      )}
      {convert && <ConvertModal i={i} onClose={() => setConvert(false)} onDone={() => { setConvert(false); reload(); onChanged(); }} />}
    </Modal>
  );
}

function ConvertModal({ i, onClose, onDone }: { i: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: i.name ?? '', email: i.email ?? '', phone: i.phone ?? '', legal_basis: 'legitimo_interesse' });
  const [err, setErr] = useState('');
  return (
    <Modal title="Converter em negociação" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); try { await api(`/api/interests/${i.id}/convert`, { body: f }); onDone(); } catch (er: any) { setErr(er.message); } }}>
        <p className="small muted" style={{ margin: 0 }}>Use quando o interessado se identificou na conversa. O contato será criado ou atualizado no CRM WingsBr.</p>
        <Field label="Nome"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div className="grid2"><Field label="E-mail"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field><Field label="Telefone"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field></div>
        <Field label="Base legal para o tratamento"><select value={f.legal_basis} onChange={(e) => setF({ ...f, legal_basis: e.target.value })}><option value="consentimento">Consentimento</option><option value="legitimo_interesse">Legítimo interesse (contato iniciado pelo titular)</option><option value="execucao_contrato">Procedimentos preliminares de contrato</option></select></Field>
        {err && <p className="error-text">{err}</p>}
        <div className="row"><button className="btn">Criar negociação</button><button type="button" className="btn ghost" onClick={onClose}>Cancelar</button></div>
      </form>
    </Modal>
  );
}
