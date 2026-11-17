import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LAND_STATUS, MODALITIES, NEGOTIATION_STAGES, formatArea, formatBRL, type LandStatus, type Modality, type NegotiationStage } from '@dl/shared';
import { api } from '../lib/api';
import { useAsync, Loading, ErrorBox } from '../components/ui';
import { ColumnChart, HBars } from '../components/Charts';
import { PageHeader } from './Shell';

const CHANNELS: Record<string, string> = { google_ads: 'Google Ads', meta_ads: 'Meta Ads', organic: 'Orgânico', direct: 'Direto', referral: 'Indicação/sites', email: 'E-mail', social: 'Redes sociais', cpc: 'Mídia paga' };
const compactBRL = (v: number) => (v >= 1e6 ? `R$ ${(v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi` : formatBRL(v));
/** "1 disponível", "2 disponíveis". */
const plural = (n: number, one: string, many: string) => `${Number(n).toLocaleString('pt-BR')} ${Number(n) === 1 ? one : many}`;

export default function Dashboard() {
  const [days, setDays] = useState(90);
  const { data: d, error, loading } = useAsync(() => api(`/api/dashboard?days=${days}`), [days]);
  if (loading && !d) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!d) return null;

  const stageOrder = Object.keys(NEGOTIATION_STAGES) as NegotiationStage[];
  const byStage = stageOrder.map((s) => ({ label: NEGOTIATION_STAGES[s], value: Number(d.negotiations.by_stage.find((x: any) => x.stage === s)?.n ?? 0) }));
  const conv = d.interests.total ? Math.round((d.interests.identified / d.interests.total) * 100) : 0;

  return (
    <>
      <PageHeader title="Visão geral">
        <select className="input" style={{ width: 'auto' }} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Período">
          <option value={30}>Últimos 30 dias</option>
          <option value={90}>Últimos 90 dias</option>
          <option value={180}>Últimos 180 dias</option>
          <option value={365}>Últimos 12 meses</option>
        </select>
      </PageHeader>

      <div className="kpis" style={{ marginBottom: '1rem' }}>
        <div className="kpi"><span>Áreas cadastradas</span><b className="num">{d.areas.total}</b><small>{plural(d.areas.available, 'disponível', 'disponíveis')} · {plural(d.areas.published, 'publicada', 'publicadas')}</small></div>
        <div className="kpi"><span>Área territorial</span><b className="num">{formatArea(d.areas.total_area_m2)}</b><small>{plural(d.areas.new_captures, 'área nova', 'áreas novas')} no período</small></div>
        <div className="kpi"><span>Valor potencial</span><b className="num">{compactBRL(d.potential_value)}</b><small>VGV preliminar {compactBRL(d.potential_vgv)}</small></div>
        <div className="kpi"><span>Interessados</span><b className="num">{d.interests.total}</b><small>{plural(d.interests.identified, 'identificado', 'identificados')} ({conv}%) · {plural(d.interests.confirmed_conversations, 'conversa confirmada', 'conversas confirmadas')}</small></div>
        <div className="kpi"><span>Negociações ativas</span><b className="num">{d.negotiations.active}</b><small>{plural(d.negotiations.proposals, 'proposta', 'propostas')} · {plural(d.negotiations.won, 'concluída', 'concluídas')}</small></div>
        {/* Prospecções do funil (ainda não viraram área). Não confundir com áreas na situação "Captação", no gráfico abaixo. */}
        {d.prospects && <div className="kpi"><span>Prospecções no funil</span><b className="num">{d.prospects.open}</b><small>{formatArea(d.prospects.open_area_m2)} · {plural(d.prospects.converted, 'virou área', 'viraram área')} no período</small></div>}
        {d.commission && <div className="kpi"><span>Comissão prevista</span><b className="num">{compactBRL(d.commission.forecast)}</b><small>Realizada {compactBRL(d.commission.realized)} · exigível {compactBRL(d.commission.receivable)}</small></div>}
      </div>

      {(d.alerts.sla_overdue > 0 || d.alerts.pending_review.length > 0 || d.alerts.expiring_documents.length > 0 || d.alerts.stale.length > 0) && (
        <div className="panel" style={{ marginBottom: '1rem' }}>
          <div className="panel-head"><h2>Precisa de atenção</h2></div>
          <div className="stack-s">
            {d.alerts.sla_overdue > 0 && <p className="notice bad" style={{ margin: 0 }}><Link to="/painel/interesses?overdue=1">{d.alerts.sla_overdue} interessados identificados sem primeiro atendimento dentro do prazo</Link></p>}
            {d.alerts.pending_review.length > 0 && <p className="notice" style={{ margin: 0 }}><Link to="/painel/aprovacoes">{d.alerts.pending_review.length} {d.alerts.pending_review.length === 1 ? 'área aguarda' : 'áreas aguardam'} aprovação de publicação</Link></p>}
            {d.alerts.expiring_documents.map((x: any) => <p key={x.id} className="notice" style={{ margin: 0 }}><Link to={`/painel/areas/${x.opportunity_id}?etapa=5`}>{x.title} da {x.code} vence em {new Date(x.valid_until + 'T12:00').toLocaleDateString('pt-BR')}</Link></p>)}
            {d.alerts.stale.length > 0 && (
              <p className="notice" style={{ margin: 0 }}>
                Sem atualização há mais de 30 dias: {d.alerts.stale.map((s: any, i: number) => <span key={s.id}>{i > 0 && ', '}<Link to={`/painel/areas/${s.id}`}>{s.code}</Link></span>)}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="grid2" style={{ marginBottom: '1rem' }}>
        <div className="panel">
          <div className="panel-head"><h2>Interessados por semana</h2></div>
          <ColumnChart valueLabel="interessados" data={d.interests.weekly.map((w: any) => ({ label: new Date(w.week + 'T12:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }), value: w.interests, detail: `${w.identified} identificados` }))} />
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Negociações abertas por etapa</h2><Link to="/painel/negociacoes" className="small">Abrir funil</Link></div>
          <HBars data={byStage} />
        </div>
      </div>

      <div className="grid3" style={{ marginBottom: '1rem' }}>
        <div className="panel"><div className="panel-head"><h2>Interessados por origem</h2></div><HBars data={d.interests.by_channel.map((c: any) => ({ label: CHANNELS[c.channel] ?? c.channel ?? 'Não identificada', value: Number(c.n) }))} /></div>
        <div className="panel"><div className="panel-head"><h2>Interessados por intermediador</h2></div><HBars data={d.interests.by_broker.map((c: any) => ({ label: c.broker, value: Number(c.n) }))} /></div>
        <div className="panel"><div className="panel-head"><h2>Interessados por cidade</h2></div><HBars data={d.interests.by_city.map((c: any) => ({ label: c.city, value: Number(c.n) }))} /></div>
      </div>

      <div className="grid3">
        <div className="panel"><div className="panel-head"><h2>Áreas por estado</h2></div><HBars data={d.by_uf.map((u: any) => ({ label: u.uf, value: Number(u.n) }))} /></div>
        <div className="panel"><div className="panel-head"><h2>Áreas por modalidade</h2></div><HBars data={d.by_modality.map((m: any) => ({ label: MODALITIES[m.modality as Modality] ?? m.modality, value: Number(m.n) }))} /></div>
        <div className="panel"><div className="panel-head"><h2>Áreas cadastradas por situação</h2></div><HBars data={d.by_status.map((m: any) => ({ label: LAND_STATUS[m.status as LandStatus] ?? m.status, value: Number(m.n) }))} /></div>
      </div>
    </>
  );
}
