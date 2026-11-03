import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ROLES, type Role } from '@dl/shared';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Brand } from '../components/ui';

/**
 * Em produção o acesso vem do login WingsBr (token HS256). Este seletor só existe em desenvolvimento,
 * para demonstrar cada perfil com os dados fictícios.
 */
export default function Login() {
  const { me, login } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const [users, setUsers] = useState<{ id: string; name: string; email: string; role: Role; org_name: string }[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    document.title = 'Entrar — Dourado Land Intelligence';
    api('/api/dev/users', { auth: false }).then((r) => setUsers(r.items)).catch(() => setUsers([]));
  }, []);
  if (me) return <Navigate to={(loc.state as any)?.from ?? '/painel'} replace />;

  const enter = async (id: string) => {
    try {
      const { token } = await api('/api/dev/login', { body: { user_id: id }, auth: false });
      await login(token);
      nav((loc.state as any)?.from ?? '/painel', { replace: true });
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <div className="login">
      <div className="login-art" aria-hidden="true">
        <svg viewBox="0 0 600 800" preserveAspectRatio="xMidYMid slice" style={{ width: '100%', height: '100%' }}>
          {Array.from({ length: 22 }, (_, i) => (
            <path key={i} d={`M -20 ${120 + i * 30} C 160 ${60 + i * 32}, 360 ${200 + i * 26}, 640 ${100 + i * 31}`} fill="none" stroke="#2e2e2c" strokeWidth="1.2" />
          ))}
          <path d="M 170 300 L 420 250 L 470 470 L 230 540 Z" fill="#f8b81733" stroke="#f8b817" strokeWidth="3" strokeLinejoin="round" />
          {[[170, 300], [420, 250], [470, 470], [230, 540]].map(([x, y]) => <circle key={x} cx={x} cy={y} r="6" fill="#ffffff" />)}
          <text x="320" y="410" fill="#ffffff" fontSize="56" fontFamily="var(--display)" textAnchor="middle">18,6 ha</text>
        </svg>
      </div>
      <div className="login-form">
        <div className="brand" style={{ display: 'flex' }}><Brand /></div>
        <div>
          <h1 className="wide" style={{ fontSize: 'var(--t3)', marginBottom: '0.5rem' }}>Entrar no painel</h1>
          <p className="muted">Ambiente de demonstração com dados fictícios. Escolha um perfil para ver o que cada pessoa acessa. Em produção, o acesso usa a conta WingsBr com verificação em duas etapas para perfis administrativos.</p>
        </div>
        {err && <p className="notice bad">{err}</p>}
        {users && users.length === 0 && <p className="notice">Login de demonstração desativado. Acesse pela sua conta WingsBr.</p>}
        <div className="user-pick">
          {users?.map((u) => (
            <button key={u.id} onClick={() => enter(u.id)}>
              <span><b>{u.name}</b><br /><span className="small muted">{u.org_name}</span></span>
              <span className="badge" style={{ alignSelf: 'center' }}>{ROLES[u.role]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
