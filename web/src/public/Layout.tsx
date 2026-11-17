import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Brand } from '../components/ui';
import { captureAttribution } from '../lib/api';
import './site.css';

export default function PublicLayout() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => { setOpen(false); window.scrollTo(0, 0); }, [loc.pathname]);
  useEffect(() => { captureAttribution(); }, []);
  return (
    <>
      <a href="#conteudo" className="sr-only">Pular para o conteúdo</a>
      <header className="q-header">
        <div className="q-wrap">
          <Link to="/" className="brand" aria-label="Quero Área — início"><Brand light /></Link>
          <button className="q-menu-btn" aria-label={open ? 'Fechar menu' : 'Abrir menu'} aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen(!open)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
          <nav id="site-nav" className={`q-nav ${open ? 'open' : ''}`} aria-label="Principal">
            <NavLink to="/areas">Banco de áreas</NavLink>
            <NavLink to="/mapa">Mapa</NavLink>
            <NavLink to="/como-funciona">Como funciona</NavLink>
            <NavLink to="/proprietarios">Para proprietários</NavLink>
            <NavLink to="/construtoras">Para construtoras</NavLink>
            <NavLink to="/sobre">Sobre</NavLink>
            <NavLink to="/painel">Entrar</NavLink>
            <Link to="/contato" className="q-btn q-btn-gold q-btn-sm">Falar com a Quero Área</Link>
          </nav>
        </div>
      </header>
      <main id="conteudo"><Outlet /></main>
      <footer className="q-footer">
        <div className="q-wrap">
          <div className="q-foot-grid">
            <div>
              <Link to="/" className="brand" style={{ display: 'flex' }} aria-label="Quero Área — início"><Brand light /></Link>
              <p className="q-foot-tag">Banco de áreas para incorporação, loteamento e desenvolvimento imobiliário.</p>
              <p className="q-foot-tag" style={{ fontSize: 12.5 }}>Parâmetros não verificados não constituem aprovação oficial. Valores e condições sujeitos a confirmação.</p>
            </div>
            <nav aria-label="Rodapé">
              <Link to="/areas">Banco de áreas</Link>
              <Link to="/areas?featured=1">Oportunidades em destaque</Link>
              <Link to="/mapa">Mapa de oportunidades</Link>
              <Link to="/como-funciona">Como funciona</Link>
              <Link to="/proprietarios">Cadastrar uma área</Link>
              <Link to="/construtoras">Construtoras e investidores</Link>
              <Link to="/parceiros">Seja um parceiro</Link>
              <Link to="/contato">Contato e WhatsApp</Link>
              <Link to="/privacidade">Privacidade e dados pessoais</Link>
            </nav>
          </div>
          <div className="q-foot-bottom">
            <span>Uma plataforma Dourado Real Estate Partners</span>
            <span className="q-mono">queroarea.com.br</span>
          </div>
        </div>
      </footer>
    </>
  );
}
