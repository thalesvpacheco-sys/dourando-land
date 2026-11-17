import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { ROLES, type Role } from '@dl/shared';
import { useSession } from '../lib/session';
import { api, DEMO, NEW_TAB } from '../lib/api';
import { Brand, Loading } from '../components/ui';

export default function Shell() {
  const { me, loading, logout, can } = useSession();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<{ pending: number; overdue: number }>({ pending: 0, overdue: 0 });
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!me) return;
    if (can('publication', 'approve')) api('/api/opportunities?publication=pending_review').then((r) => setCounts((c) => ({ ...c, pending: r.items.length }))).catch(() => {});
    if (can('interest', 'read')) api('/api/interests?overdue=1').then((r) => setCounts((c) => ({ ...c, overdue: r.items.length }))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, loc.pathname]);

  if (loading) return <div className="page"><Loading /></div>;
  if (!me) return <Navigate to="/painel/entrar" replace state={{ from: loc.pathname }} />;
  const role = me.user.role as Role;
  const title = (document.title = 'Painel — Quero Área');
  void title;

  const item = (to: string, label: string, count?: number) => (
    <NavLink to={to} end={to === '/painel' || to === '/painel/captacao'}>{label}{count ? <span className="count" aria-label={`${count} pendentes`}>{count}</span> : null}</NavLink>
  );

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <Link to="/painel" className="brand" style={{ display: 'flex' }}><Brand light sub="Painel" /></Link>
        <nav aria-label="Painel">
          {can('dashboard', 'read') && item('/painel', 'Visão geral')}
          {role === 'broker' && item('/painel', 'Minha carteira')}
          {role === 'owner' && item('/painel', 'Minhas áreas')}
          {role === 'buyer' && item('/painel', 'Recomendações')}
          {can('opportunity', 'read') && role !== 'owner' && role !== 'buyer' && <>
            <p>Áreas</p>
            {item('/painel/areas', 'Banco de áreas')}
            {can('publication', 'approve') && item('/painel/aprovacoes', 'Aprovações', counts.pending)}
          </>}
          {can('prospect', 'read') && <>
            <p>Captação</p>
            {item('/painel/captacao/mapa', 'Prospecção no mapa')}
            {item('/painel/captacao', role === 'broker' ? 'Minhas indicações' : 'Funil de captação')}
            {!DEMO && can('ai', 'create') && can('document', 'read') && item('/painel/matricula', 'Leitura de matrícula')}
          </>}
          {(can('interest', 'read') || can('negotiation', 'read')) && <p>Comercial</p>}
          {can('interest', 'read') && item('/painel/interesses', 'Interesses', counts.overdue)}
          {can('negotiation', 'read') && item('/painel/negociacoes', 'Negociações')}
          {can('profile', 'read') && item('/painel/compradores', role === 'buyer' ? 'Perfis de aquisição' : 'Compradores e matching')}
          {role === 'buyer' && <Link to="/areas">Vitrine de áreas</Link>}
          {(can('routing', 'read') || can('audit', 'read') || can('integration', 'read') || can('user', 'read')) && <p>Gestão</p>}
          {can('routing', 'read') && item('/painel/atendimento', 'Atendimento e WhatsApp')}
          {can('user', 'read') && item('/painel/usuarios', 'Usuários')}
          {can('audit', 'read') && item('/painel/auditoria', 'Auditoria')}
          {can('integration', 'read') && item('/painel/integracoes', 'Integrações')}
          <p>Portal</p>
          <Link to="/" target={NEW_TAB}>Abrir portal público</Link>
        </nav>
        <div className="me">
          <b>{me.user.name}</b>
          <span>{ROLES[role]}</span>
          <div className="small" style={{ color: '#93a19f' }}>{me.org.name}</div>
          <div className="row" style={{ marginTop: '0.5rem' }}>
            {!DEMO && <Link className="btn link small" style={{ color: '#d6dcd8' }} to="/painel/conta">Minha conta</Link>}
            <button className="btn link small" style={{ color: '#d6dcd8' }} onClick={logout}>Sair</button>
          </div>
          <div className="wb" style={{ marginTop: '0.8rem' }}>Tecnologia WingsBr</div>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <button className="btn ghost small side-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>Menu</button>
          <div id="topbar-slot" style={{ display: 'contents' }} />
        </div>
        <div className="content"><Outlet /></div>
      </div>
    </div>
  );
}

/** Título da página dentro da barra superior. */
export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  useEffect(() => { document.title = `${title} — Painel Quero Área`; }, [title]);
  return (
    <div className="spread" style={{ marginBottom: '1.25rem' }}>
      <h1 style={{ fontFamily: 'var(--display)', fontWeight: 600, fontSize: '1.72rem', lineHeight: 1.08 }}>{title}</h1>
      {children && <div className="row">{children}</div>}
    </div>
  );
}
