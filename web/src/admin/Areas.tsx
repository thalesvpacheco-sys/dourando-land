import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { LAND_STATUS, LAND_TYPES, PUBLICATION_STATUS, UFS, formatArea, formatBRL, type LandStatus, type LandType, type PublicationStatus } from '@dl/shared';
import { api, DEMO, getToken, qs } from '../lib/api';
import { useSession } from '../lib/session';
import { Empty, ErrorBox, Field, Loading, Modal, useAsync, useToast } from '../components/ui';
import { PageHeader } from './Shell';

export const pubBadge: Record<string, string> = { draft: '', pending_review: 'warn', published: 'ok', rejected: 'bad', unpublished: '' };

export default function Areas({ approvals }: { approvals?: boolean }) {
  const [params, setParams] = useSearchParams();
  const { can, me } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const filters = { q: params.get('q') ?? '', status: params.get('status') ?? '', publication: approvals ? 'pending_review' : params.get('publication') ?? '', uf: params.get('uf') ?? '', stale: params.get('stale') ?? '', broker: params.get('broker') ?? '' };
  const { data, error, loading, reload } = useAsync(() => api(`/api/opportunities${qs(filters)}`), [JSON.stringify(filters)]);
  const brokers = useAsync(() => (can('opportunity', 'read') && me?.user.role !== 'broker' ? api('/api/admin/brokers') : Promise.resolve({ items: [] })), []);
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); v ? n.set(k, v) : n.delete(k); setParams(n); };

  const [assignOpen, setAssignOpen] = useState(false);
  const bulk = async (action: 'assign' | 'submit', brokerId?: string) => {
    if (action === 'assign') {
      const b = brokers.data?.items.find((x: any) => x.id === brokerId);
      if (!b) return;
      for (const id of selected) await api(`/api/opportunities/${id}/assignments`, { body: { broker_id: b.id, role: 'primary', reason: 'Atribuição em lote' } }).catch(() => {});
      toast(`${selected.size} áreas atribuídas a ${b.name}`);
      setAssignOpen(false);
    } else {
      let ok = 0, fail = 0;
      for (const id of selected) await api(`/api/opportunities/${id}/submit-review`, { method: 'POST' }).then(() => ok++).catch(() => fail++);
      toast(`${ok} enviadas para aprovação${fail ? `; ${fail} com pendências` : ''}`, fail > 0 && ok === 0);
    }
    setSelected(new Set());
    reload();
  };

  const exportCsv = async () => {
    const t = getToken();
    const r = await fetch('/api/opportunities/export.csv', t ? { headers: { Authorization: `Bearer ${t}` } } : undefined);
    if (!r.ok) { toast('Sem permissão para exportar', true); return; }
    if (DEMO) { try { await navigator.clipboard.writeText(await r.text()); toast('Na demonstração o download é bloqueado: o CSV foi copiado para a área de transferência'); } catch { toast('Exportação registrada na auditoria; download indisponível na demonstração'); } return; }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a'); a.href = url; a.download = 'areas-dourado.csv'; a.click(); URL.revokeObjectURL(url);
    toast('Exportação registrada na auditoria');
  };

  const items = data?.items ?? [];
  const allSel = items.length > 0 && items.every((i: any) => selected.has(i.id));

  return (
    <>
      <PageHeader title={approvals ? 'Aprovações de publicação' : me?.user.role === 'broker' ? 'Áreas atribuídas a mim' : 'Banco de áreas'}>
        {!approvals && can('opportunity', 'export') && <button className="btn ghost" onClick={exportCsv}>Exportar CSV</button>}
        {!approvals && can('opportunity', 'create') && <button className="btn gold" onClick={() => setCreating(true)}>Cadastrar área</button>}
      </PageHeader>

      {approvals && <p className="muted" style={{ marginTop: '-0.5rem' }}>Confira autorização de divulgação, campos visíveis e localização antes de publicar. A aprovação fica registrada na auditoria.</p>}

      {!approvals && (
        <div className="row" style={{ marginBottom: '1rem' }}>
          <input className="input" style={{ width: 260 }} placeholder="Buscar por código, nome ou cidade" defaultValue={filters.q} onKeyDown={(e) => e.key === 'Enter' && set('q', (e.target as HTMLInputElement).value)} aria-label="Buscar" />
          <select className="input" style={{ width: 'auto' }} value={filters.status} onChange={(e) => set('status', e.target.value)} aria-label="Situação">
            <option value="">Todas as situações</option>
            {Object.entries(LAND_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select className="input" style={{ width: 'auto' }} value={filters.publication} onChange={(e) => set('publication', e.target.value)} aria-label="Publicação">
            <option value="">Qualquer publicação</option>
            {Object.entries(PUBLICATION_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select className="input" style={{ width: 'auto' }} value={filters.uf} onChange={(e) => set('uf', e.target.value)} aria-label="UF">
            <option value="">UF</option>
            {UFS.map((u) => <option key={u}>{u}</option>)}
          </select>
          {(brokers.data?.items.length ?? 0) > 0 && (
            <select className="input" style={{ width: 'auto' }} value={filters.broker} onChange={(e) => set('broker', e.target.value)} aria-label="Intermediador">
              <option value="">Todos os intermediadores</option>
              {brokers.data!.items.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
          <label className="check small"><input type="checkbox" checked={!!filters.stale} onChange={(e) => set('stale', e.target.checked ? '1' : '')} /> Sem atualização há 30 dias</label>
        </div>
      )}

      {selected.size > 0 && (
        <div className="notice row" style={{ marginBottom: '0.75rem' }}>
          <b>{selected.size} selecionadas</b>
          {can('routing', 'update') && <button className="btn small ghost" onClick={() => setAssignOpen(true)}>Atribuir intermediador</button>}
          {can('publication', 'create') && <button className="btn small ghost" onClick={() => bulk('submit')}>Enviar para aprovação</button>}
          <button className="btn link small" onClick={() => setSelected(new Set())}>Limpar seleção</button>
        </div>
      )}

      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : items.length === 0 ? (
        <div className="panel"><Empty title={approvals ? 'Nada aguardando aprovação' : 'Nenhuma área encontrada'}>{!approvals && can('opportunity', 'create') && <button className="btn" onClick={() => setCreating(true)}>Cadastrar área</button>}</Empty></div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {!approvals && can('opportunity', 'update') && <th style={{ width: 32 }}><input type="checkbox" aria-label="Selecionar todas" checked={allSel} onChange={() => setSelected(allSel ? new Set() : new Set(items.map((i: any) => i.id)))} /></th>}
                <th>Código</th><th>Área</th><th>Cidade</th><th className="r">Tamanho</th><th className="r">Valor pedido</th><th>Situação</th><th>Publicação</th><th>Intermediador</th><th>Atualizada</th>
              </tr>
            </thead>
            <tbody>
              {items.map((o: any) => (
                <tr key={o.id}>
                  {!approvals && can('opportunity', 'update') && <td><input type="checkbox" aria-label={`Selecionar ${o.code}`} checked={selected.has(o.id)} onChange={() => { const s = new Set(selected); s.has(o.id) ? s.delete(o.id) : s.add(o.id); setSelected(s); }} /></td>}
                  <td className="num"><Link to={`/painel/areas/${o.id}`}>{o.code}</Link></td>
                  <td><Link to={`/painel/areas/${o.id}`} style={{ fontWeight: 400 }}>{o.public_title ?? o.internal_name}</Link><div className="small muted">{LAND_TYPES[o.type as LandType]}</div></td>
                  <td>{o.city}/{o.uf}</td>
                  <td className="r num">{formatArea(o.area_m2)}</td>
                  <td className="r num">{o.asking_price ? formatBRL(o.asking_price) : '—'}</td>
                  <td>{LAND_STATUS[o.status as LandStatus]}</td>
                  <td><span className={`badge ${pubBadge[o.publication_status]}`}>{PUBLICATION_STATUS[o.publication_status as PublicationStatus]}</span>{o.visibility === 'private' && <span className="badge" style={{ marginLeft: 4 }}>Privada</span>}</td>
                  <td>{o.broker_name ?? <span className="muted">Sem responsável</span>}</td>
                  <td className="small muted">{new Date(o.updated_at).toLocaleDateString('pt-BR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {assignOpen && (
        <Modal title={`Atribuir intermediador a ${selected.size} áreas`} onClose={() => setAssignOpen(false)}>
          <div className="stack-s">
            {brokers.data?.items.filter((b: any) => b.active).map((b: any) => <button key={b.id} className="btn ghost" style={{ justifyContent: 'space-between' }} onClick={() => bulk('assign', b.id)}><span>{b.name}</span><span className="small muted">{b.assignments} áreas</span></button>)}
          </div>
        </Modal>
      )}
      {creating && <CreateArea onClose={() => setCreating(false)} onCreated={(id) => nav(`/painel/areas/${id}`)} />}
    </>
  );
}

function CreateArea({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ internal_name: '', type: 'gleba', uf: 'GO', city: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const o = await api('/api/opportunities', { body: f }); onCreated(o.id); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title="Cadastrar área" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted" style={{ margin: 0 }}>O código é gerado automaticamente pela UF. O restante do cadastro segue em etapas, com salvamento automático.</p>
        <Field label="Nome interno" hint="Visível apenas para a equipe"><input required minLength={3} value={f.internal_name} onChange={(e) => setF({ ...f, internal_name: e.target.value })} placeholder="Ex.: Gleba Fazenda Boa Vista — lote 3" /></Field>
        <Field label="Tipo"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{Object.entries(LAND_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <div className="grid2" style={{ gridTemplateColumns: '100px 1fr' }}>
          <Field label="UF"><select value={f.uf} onChange={(e) => setF({ ...f, uf: e.target.value })}>{UFS.map((u) => <option key={u}>{u}</option>)}</select></Field>
          <Field label="Cidade"><input required value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
        </div>
        {err && <p className="error-text">{err}</p>}
        <div className="row"><button className="btn gold" disabled={busy}>{busy ? 'Criando…' : 'Criar e continuar cadastro'}</button><button type="button" className="btn ghost" onClick={onClose}>Cancelar</button></div>
      </form>
    </Modal>
  );
}
