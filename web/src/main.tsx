import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, MemoryRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import { DEMO, FRAMED } from './lib/api';
import './styles.css';
import { SessionProvider, useSession } from './lib/session';
import { ToastProvider } from './components/ui';
import PublicLayout from './public/Layout';
import Home from './public/Home';
import Bank from './public/Bank';
import MapPage from './public/MapPage';
import Detail from './public/Detail';
import Book from './public/Book';
import { About, Builders, Contact, HowItWorks, Owners, Partners, Privacy } from './public/Pages';
const Shell = lazy(() => import('./admin/Shell'));
const Login = lazy(() => import('./admin/Login'));
const Dashboard = lazy(() => import('./admin/Dashboard'));
const Areas = lazy(() => import('./admin/Areas'));
const AreaEditor = lazy(() => import('./admin/AreaEditor'));
const Interests = lazy(() => import('./admin/Interests'));
const Negotiations = lazy(() => import('./admin/Negotiations'));
const Buyers = lazy(() => import('./admin/Buyers'));
const Prospects = lazy(() => import('./admin/Prospects'));
const ProspectDetail = lazy(() => import('./admin/Prospects').then((m) => ({ default: m.ProspectDetail })));
const TerritoryMap = lazy(() => import('./admin/TerritoryMap'));
const adm = () => import('./admin/Admin');
const Audit = lazy(() => adm().then((m) => ({ default: m.Audit })));
const BrokerHome = lazy(() => adm().then((m) => ({ default: m.BrokerHome })));
const Integrations = lazy(() => adm().then((m) => ({ default: m.Integrations })));
const OwnerHome = lazy(() => adm().then((m) => ({ default: m.OwnerHome })));
const Routing = lazy(() => adm().then((m) => ({ default: m.Routing })));
const Users = lazy(() => adm().then((m) => ({ default: m.Users })));

/** Links HTML puros (ex.: popups do mapa) navegam pelo roteador em vez de recarregar a página. */
function LinkInterceptor() {
  const nav = useNavigate();
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const a = (e.target as HTMLElement).closest('a');
      const href = a?.getAttribute('href');
      if (!a || !href || !href.startsWith('/') || href.startsWith('/api/') || a.target) return;
      e.preventDefault();
      nav(href);
    };
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  }, [nav]);
  return null;
}

const SHOW_DEMO_BAR = DEMO && import.meta.env.VITE_DEMO_BAR !== '0';
const DemoBar = SHOW_DEMO_BAR ? lazy(() => import('./demo/DemoBar')) : () => null;
const Router = ({ children }: { children: ReactNode }) => (FRAMED ? <MemoryRouter>{children}</MemoryRouter> : <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>{children}</BrowserRouter>);

function PanelHome() {
  const { me, can } = useSession();
  if (can('dashboard', 'read')) return <Dashboard />;
  if (me?.user.role === 'broker') return <BrokerHome />;
  if (me?.user.role === 'owner') return <OwnerHome />;
  if (me?.user.role === 'buyer') return <Buyers />;
  if (me?.user.role === 'platform_admin') return <Navigate to="/painel/integracoes" replace />;
  return null;
}

async function boot() {
  if (DEMO) (await import('./demo/mockServer')).installMockServer();
  createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router>
      <SessionProvider>
        <ToastProvider>
          <Suspense fallback={<p className="muted" style={{ padding: '2rem' }}>Carregando…</p>}>
          <Routes>
            <Route element={<PublicLayout />}>
              <Route index element={<Home />} />
              <Route path="areas" element={<Bank />} />
              <Route path="areas/:slug" element={<Detail />} />
              <Route path="mapa" element={<MapPage />} />
              <Route path="como-funciona" element={<HowItWorks />} />
              <Route path="proprietarios" element={<Owners />} />
              <Route path="construtoras" element={<Builders />} />
              <Route path="parceiros" element={<Partners />} />
              <Route path="sobre" element={<About />} />
              <Route path="contato" element={<Contact />} />
              <Route path="privacidade" element={<Privacy />} />
            </Route>
            <Route path="areas/:slug/book" element={<Book />} />
            <Route path="painel/entrar" element={<Login />} />
            <Route path="painel" element={<Shell />}>
              <Route index element={<PanelHome />} />
              <Route path="areas" element={<Areas />} />
              <Route path="areas/:id" element={<AreaEditor />} />
              <Route path="aprovacoes" element={<Areas approvals />} />
              <Route path="interesses" element={<Interests />} />
              <Route path="negociacoes" element={<Negotiations />} />
              <Route path="compradores" element={<Buyers />} />
              <Route path="captacao" element={<Prospects />} />
              <Route path="captacao/mapa" element={<TerritoryMap />} />
              <Route path="captacao/:id" element={<ProspectDetail />} />
              <Route path="atendimento" element={<Routing />} />
              <Route path="usuarios" element={<Users />} />
              <Route path="auditoria" element={<Audit />} />
              <Route path="integracoes" element={<Integrations />} />
            </Route>
            <Route path="*" element={<PublicLayout />}>
              <Route path="*" element={<div className="page"><h1 className="page-title">Página não encontrada</h1><a className="btn" href="/areas">Ver o banco de áreas</a></div>} />
            </Route>
          </Routes>
            <LinkInterceptor />
            {SHOW_DEMO_BAR && <DemoBar />}
          </Suspense>
        </ToastProvider>
      </SessionProvider>
    </Router>
  </StrictMode>,
);
}
void boot();
