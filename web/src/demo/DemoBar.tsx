import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ROLES, type Role } from '@dl/shared';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { useToast } from '../components/ui';
import { lastInterestToken, resetDemo, simulateWhatsApp } from './mockServer';

const STEPS: [string, string][] = [
  ['Visitante', 'Busque por finalidade na home, abra uma área e clique em "Conversar pelo WhatsApp" informando nome e telefone.'],
  ['Webhook', 'Clique em "Simular mensagem no WhatsApp" aqui na barra: o interesse passa de "Clique" para "Mensagem recebida".'],
  ['Intermediador', 'Entre como Juliana Prado: o interessado aparece na carteira dela, com prazo de atendimento.'],
  ['Administração', 'Entre como Marina Albuquerque: aprove a DOU-GO-0007 em Aprovações e veja a área surgir no portal.'],
  ['Negociação', 'Em Negociações, arraste um cartão, registre uma proposta e uma contraproposta.'],
  ['Captação', 'Como Marina ou Carlos, abra Captação › Prospecção no mapa, aproxime até ver as parcelas (SIGEF/CAR fictícias), clique numa delas e crie a prospecção.'],
  ['Funil', 'No funil, arraste a prospecção entre etapas, preencha proprietário e checklist e veja a pré-qualificação subir; depois converta em área.'],
  ['Google Earth', 'Em uma área ou prospecção, use "Abrir no Google Earth" (nova aba) ou copie o KML para importar num projeto do Earth.'],
  ['Permissões', 'Entre como Lucas (comprador) ou Antônio (proprietário) e confira o que cada perfil não vê.'],
];

export default function DemoBar() {
  const { me, login, logout } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const [users, setUsers] = useState<{ id: string; name: string; role: Role }[]>([]);
  const [open, setOpen] = useState(() => window.innerWidth > 760);
  const [guide, setGuide] = useState(false);
  useEffect(() => { if (loc.pathname.startsWith('/painel/captacao/mapa')) setOpen(false); }, [loc.pathname]);
  useEffect(() => { api('/api/dev/users', { auth: false }).then((r) => setUsers(r.items)).catch(() => {}); }, []);

  const switchTo = async (id: string) => {
    if (!id) { logout(); nav('/'); toast('Navegando como visitante'); return; }
    const { token } = await api('/api/dev/login', { body: { user_id: id }, auth: false });
    await login(token);
    nav('/painel');
  };
  const simulate = (withToken: boolean) => {
    const token = withToken ? lastInterestToken() : null;
    const r = simulateWhatsApp(token);
    toast(r.linked ? `Mensagem com ${r.token} recebida pelo webhook simulado` : 'Mensagem sem código recebida — aparece em Interesses para vínculo manual');
    if (loc.pathname.startsWith('/painel')) { nav(loc.pathname + loc.search, { replace: true, state: { t: Date.now() } }); }
  };

  if (!open) {
    return <button className="demo-pill" onClick={() => setOpen(true)} aria-label="Abrir barra de demonstração">Demonstração</button>;
  }
  return (
    <aside className="demo-bar" aria-label="Controles da demonstração">
      <div className="spread" style={{ flexWrap: 'nowrap' }}>
        <b>Demonstração</b>
        <button className="btn link small" style={{ color: '#d6dcd8' }} onClick={() => setOpen(false)}>Recolher</button>
      </div>
      <p>Dados fictícios. O servidor é simulado neste navegador, com as mesmas regras da plataforma.</p>
      <label className="field"><span style={{ color: '#c3cbc8' }}>Entrar como</span>
        <select className="input" value={me?.user.id ?? ''} onChange={(e) => switchTo(e.target.value)}>
          <option value="">Visitante (portal público)</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name} — {ROLES[u.role]}</option>)}
        </select>
      </label>
      <div className="stack-s">
        <button className="btn gold small" onClick={() => simulate(true)}>Simular mensagem no WhatsApp</button>
        <button className="btn ghost small" onClick={() => simulate(false)}>Simular mensagem sem código</button>
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button className="btn link small" style={{ color: '#d6dcd8' }} onClick={() => setGuide(!guide)}>{guide ? 'Ocultar roteiro' : 'Roteiro de teste'}</button>
        <button className="btn link small" style={{ color: '#d6dcd8' }} onClick={() => { resetDemo(); location.reload(); }}>Restaurar dados</button>
      </div>
      {guide && (
        <ol className="demo-steps">
          {STEPS.map(([t, d]) => <li key={t}><b>{t}.</b> {d}</li>)}
        </ol>
      )}
    </aside>
  );
}
