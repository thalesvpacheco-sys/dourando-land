import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ROLES, type Role } from '@dl/shared';
import { api, DEMO } from '../lib/api';
import { useSession } from '../lib/session';
import { Brand, Field } from '../components/ui';

/** Moldura das telas de acesso. */
export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="login">
      <div className="login-art" aria-hidden="true">
        <svg viewBox="0 0 600 800" preserveAspectRatio="xMidYMid slice" style={{ width: '100%', height: '100%' }}>
          {Array.from({ length: 22 }, (_, i) => (
            <path key={i} d={`M -20 ${120 + i * 30} C 160 ${60 + i * 32}, 360 ${200 + i * 26}, 640 ${100 + i * 31}`} fill="none" stroke="#2b4570" strokeWidth="1.2" />
          ))}
          <path d="M 170 300 L 420 250 L 470 470 L 230 540 Z" fill="#ffb80033" stroke="#ffb800" strokeWidth="3" strokeLinejoin="round" />
          {[[170, 300], [420, 250], [470, 470], [230, 540]].map(([x, y]) => <circle key={x} cx={x} cy={y} r="6" fill="#ffffff" />)}
        </svg>
      </div>
      <div className="login-form">
        <div className="brand" style={{ display: 'flex' }}><Brand /></div>
        {children}
      </div>
    </div>
  );
}

/** Seletor de perfis: só na demonstração e no ambiente de desenvolvimento. O build de produção não contém esta tela em uso. */
function DevPicker({ onPicked }: { onPicked: (token: string) => Promise<void> }) {
  const [users, setUsers] = useState<{ id: string; name: string; email: string; role: Role; org_name: string }[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api('/api/dev/users', { auth: false }).then((r) => setUsers(r.items)).catch(() => setUsers([])); }, []);
  if (!users?.length) return null;
  return (
    <div className="stack-s">
      <p className="muted">{DEMO ? 'Ambiente de demonstração com dados fictícios. Escolha um perfil para ver o que cada pessoa acessa.' : 'Desenvolvimento: entrar como usuário fictício.'}</p>
      {err && <p className="notice bad">{err}</p>}
      <div className="user-pick">
        {users.map((u) => (
          <button key={u.id} onClick={async () => {
            try { const { token } = await api('/api/dev/login', { body: { user_id: u.id }, auth: false }); await onPicked(token); } catch (e: any) { setErr(e.message); }
          }}>
            <span><b>{u.name}</b><br /><span className="small muted">{u.org_name}</span></span>
            <span className="badge" style={{ alignSelf: 'center' }}>{ROLES[u.role]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Mostra o QR Code e confirma o primeiro código. `challenge` vem do login; sem ele, usa a sessão (Minha conta). */
export function MfaSetup({ challenge, onDone }: { challenge?: string; onDone: (codes: string[]) => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/auth/mfa/setup', { body: { challenge }, auth: false }).then(setSetup).catch((e) => setErr(e.message)); }, [challenge]);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await api('/api/auth/mfa/activate', { body: { challenge, code }, auth: false }); onDone(r.recovery_codes); }
    catch (e: any) { setErr(e.message); setCode(''); }
    setBusy(false);
  };
  return (
    <form className="stack" onSubmit={submit}>
      <ol className="small" style={{ margin: 0, paddingLeft: '1.2rem' }}>
        <li>Abra um aplicativo autenticador no celular (Google Authenticator, Microsoft Authenticator ou similar).</li>
        <li>Leia o QR Code ou digite a chave manualmente.</li>
        <li>Informe o código de 6 dígitos que aparecer.</li>
      </ol>
      {setup && <div className="row" style={{ alignItems: 'center' }}>
        <img src={setup.qr} width={180} height={180} alt="QR Code para o aplicativo autenticador" style={{ background: '#fff', borderRadius: 6 }} />
        <code className="small" style={{ wordBreak: 'break-all', maxWidth: 220 }}>{setup.secret}</code>
      </div>}
      <Field label="Código de 6 dígitos"><input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
      {err && <p className="error-text">{err}</p>}
      <button className="btn gold" disabled={busy || !setup}>{busy ? 'Confirmando…' : 'Ativar e continuar'}</button>
    </form>
  );
}

export function RecoveryCodes({ codes, onContinue }: { codes: string[]; onContinue: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="stack">
      <p className="notice">Guarde estes códigos em local seguro. Cada um funciona uma vez se você perder o celular. Eles não serão mostrados de novo.</p>
      <div className="grid2 small" style={{ fontFamily: 'monospace', gap: '0.3rem' }}>{codes.map((c) => <span key={c}>{c}</span>)}</div>
      <label className="check small"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> Guardei os códigos</label>
      <button className="btn gold" disabled={!saved} onClick={onContinue}>Continuar</button>
    </div>
  );
}

export default function Login() {
  const { me, login } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const [step, setStep] = useState<'password' | 'mfa' | 'mfa_setup' | 'recovery' | 'forgot' | 'forgot_sent'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { document.title = 'Entrar — Quero Área'; }, []);
  // a tela de códigos de recuperação precisa aparecer antes de sair daqui, mesmo com a sessão já aberta
  if (me && step !== 'recovery') return <Navigate to={(loc.state as any)?.from ?? '/painel'} replace />;

  const go = () => nav((loc.state as any)?.from ?? '/painel', { replace: true });
  const run = (fn: () => Promise<void>) => async (e?: FormEvent) => {
    e?.preventDefault(); setBusy(true); setErr('');
    try { await fn(); } catch (x: any) { setErr(x.message); }
    setBusy(false);
  };
  const submitPassword = run(async () => {
    const r = await api('/api/auth/login', { body: { email, password }, auth: false });
    setPassword('');
    if (r.step === 'done') { await login(); go(); return; }
    setChallenge(r.challenge); setStep(r.step);
  });
  const submitCode = run(async () => {
    try { await api('/api/auth/mfa/verify', { body: { challenge, code }, auth: false }); }
    catch (x) { setCode(''); throw x; }
    await login(); go();
  });
  const submitForgot = run(async () => {
    await api('/api/auth/password/forgot', { body: { email }, auth: false });
    setStep('forgot_sent');
  });

  if (DEMO) return <AuthFrame><h1 className="wide" style={{ fontSize: 'var(--t3)' }}>Entrar no painel</h1><DevPicker onPicked={async (t) => { await login(t); go(); }} /></AuthFrame>;

  return (
    <AuthFrame>
      {step === 'password' && <>
        <h1 className="wide" style={{ fontSize: 'var(--t3)' }}>Entrar no painel</h1>
        <form className="stack" onSubmit={submitPassword}>
          <Field label="E-mail"><input type="email" required autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Senha"><input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {err && <p className="error-text" role="alert">{err}</p>}
          <button className="btn gold" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
        </form>
        <div className="spread small">
          <button className="btn link small" onClick={() => { setErr(''); setStep('forgot'); }}>Esqueci a senha</button>
          <Link to="/">Voltar ao portal</Link>
        </div>
        <p className="small muted">O acesso é por convite. Se você ainda não tem conta, fale com o administrador da Dourado.</p>
        {import.meta.env.DEV && <DevPicker onPicked={async (t) => { await login(t); go(); }} />}
      </>}
      {step === 'mfa' && <>
        <h1 className="wide" style={{ fontSize: 'var(--t3)' }}>Verificação em duas etapas</h1>
        <form className="stack" onSubmit={submitCode}>
          <Field label="Código do aplicativo autenticador" hint="Perdeu o celular? Use um código de recuperação."><input required autoFocus autoComplete="one-time-code" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          {err && <p className="error-text" role="alert">{err}</p>}
          <button className="btn gold" disabled={busy}>{busy ? 'Conferindo…' : 'Confirmar'}</button>
        </form>
      </>}
      {step === 'mfa_setup' && <>
        <h1 className="wide" style={{ fontSize: 'var(--t3)' }}>Ative a verificação em duas etapas</h1>
        <p className="muted">Perfis administrativos precisam de um segundo fator para proteger os dados da plataforma.</p>
        <MfaSetup challenge={challenge} onDone={(c) => { setCodes(c); setStep('recovery'); void login(); }} />
      </>}
      {step === 'recovery' && <>
        <h1 className="wide" style={{ fontSize: 'var(--t3)' }}>Códigos de recuperação</h1>
        <RecoveryCodes codes={codes} onContinue={go} />
      </>}
      {step === 'forgot' && <>
        <h1 className="wide" style={{ fontSize: 'var(--t3)' }}>Redefinir senha</h1>
        <form className="stack" onSubmit={submitForgot}>
          <Field label="E-mail da sua conta"><input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          {err && <p className="error-text" role="alert">{err}</p>}
          <button className="btn gold" disabled={busy}>Enviar link</button>
        </form>
        <button className="btn link small" onClick={() => setStep('password')}>Voltar</button>
      </>}
      {step === 'forgot_sent' && <>
        <h1 className="wide" style={{ fontSize: 'var(--t3)' }}>Pedido registrado</h1>
        <p className="muted">Se houver uma conta com este e-mail e o envio estiver configurado, o link chega em instantes. Se não chegar, peça ao administrador da Dourado um novo link em Usuários.</p>
        <button className="btn link small" onClick={() => setStep('password')}>Voltar</button>
      </>}
    </AuthFrame>
  );
}

/** Convite e redefinição: o token vem depois do # (não vai para logs de servidor nem para o Referer). */
export function SetPassword() {
  const nav = useNavigate();
  // Lido uma vez: depois de salvar, o hash é apagado da barra e o token não pode "sumir" da tela.
  const [token] = useState(() => location.hash.slice(1));
  const [info, setInfo] = useState<{ kind: string; name: string; email: string } | null>(null);
  const [error, setError] = useState('');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    document.title = 'Definir senha — Quero Área';
    if (!token) { setError('Link incompleto. Abra o link inteiro que você recebeu.'); return; }
    api('/api/auth/link/check', { body: { token }, auth: false }).then(setInfo).catch((e) => setError(e.message));
  }, [token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    if (p1 !== p2) { setErr('As senhas não são iguais.'); return; }
    setBusy(true);
    try { await api('/api/auth/password/set', { body: { token, password: p1 }, auth: false }); history.replaceState(null, '', location.pathname); setDone(true); }
    catch (x: any) { setErr(x.message); }
    setBusy(false);
  };
  return (
    <AuthFrame>
      <h1 className="wide" style={{ fontSize: 'var(--t3)' }}>{done ? 'Senha definida' : info?.kind === 'reset' ? 'Nova senha' : 'Boas-vindas'}</h1>
      {error && <><p className="notice bad">{error}</p><Link to="/painel/entrar">Ir para o login</Link></>}
      {done && <><p className="muted">Pronto. Agora entre com seu e-mail e a nova senha.</p><button className="btn gold" onClick={() => nav('/painel/entrar', { replace: true })}>Ir para o login</button></>}
      {info && !done && <>
        <p className="muted">{info.name}, defina a senha de <b>{info.email}</b>. Use pelo menos 10 caracteres.</p>
        <form className="stack" onSubmit={submit}>
          <input type="email" autoComplete="username" value={info.email} readOnly hidden />
          <Field label="Senha"><input type="password" required minLength={10} autoFocus autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} /></Field>
          <Field label="Repita a senha"><input type="password" required minLength={10} autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} /></Field>
          {err && <p className="error-text" role="alert">{err}</p>}
          <button className="btn gold" disabled={busy}>{busy ? 'Salvando…' : 'Salvar senha'}</button>
        </form>
      </>}
    </AuthFrame>
  );
}
