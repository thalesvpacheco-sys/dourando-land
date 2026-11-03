import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Brand } from '../components/ui';
import { captureAttribution } from '../lib/api';

export const CENTRAL_WA = '5562900000000';

export default function PublicLayout() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => { setOpen(false); window.scrollTo(0, 0); }, [loc.pathname]);
  useEffect(() => { captureAttribution(); }, []);
  return (
    <>
      <a href="#conteudo" className="sr-only">Pular para o conteúdo</a>
      <header className="site-header">
        <div className="inner">
          <Link to="/" className="brand" aria-label="Dourado Real Estate Partners — início"><Brand /></Link>
          <button className="btn ghost small menu-btn" aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen(!open)}>Menu</button>
          <nav id="site-nav" className={`site-nav ${open ? 'open' : ''}`} aria-label="Principal">
            <NavLink to="/areas">Banco de áreas</NavLink>
            <NavLink to="/mapa">Mapa</NavLink>
            <NavLink to="/como-funciona">Como funciona</NavLink>
            <NavLink to="/proprietarios">Para proprietários</NavLink>
            <NavLink to="/construtoras">Para construtoras</NavLink>
            <NavLink to="/sobre">Sobre</NavLink>
            <NavLink to="/painel">Entrar</NavLink>
          </nav>
          <Link to="/contato" className="btn gold small">Falar com a Dourado</Link>
        </div>
      </header>
      <main id="conteudo"><Outlet /></main>
      <footer className="site-footer">
        <div className="inner">
          <div className="stack-s">
            <Link to="/" className="brand" style={{ display: 'flex' }}><Brand light /></Link>
            <p style={{ maxWidth: '40ch', marginTop: '0.75rem' }}>
              Áreas para incorporação, loteamento e desenvolvimento, com informação técnica identificada por fonte e status de validação.
            </p>
            <p className="small muted">Parâmetros não verificados não constituem aprovação oficial. Valores e condições sujeitos a confirmação.</p>
          </div>
          <div>
            <Link to="/areas">Banco de áreas</Link>
            <Link to="/areas?featured=1">Oportunidades em destaque</Link>
            <Link to="/mapa">Mapa de oportunidades</Link>
            <Link to="/como-funciona">Como funciona</Link>
          </div>
          <div>
            <Link to="/proprietarios">Cadastrar uma área</Link>
            <Link to="/construtoras">Construtoras e investidores</Link>
            <Link to="/parceiros">Seja um parceiro</Link>
            <Link to="/contato">Contato e WhatsApp</Link>
            <Link to="/privacidade">Privacidade e dados pessoais</Link>
            <p className="small muted" style={{ marginTop: '1rem' }}>Tecnologia WingsBr</p>
          </div>
        </div>
      </footer>
    </>
  );
}
