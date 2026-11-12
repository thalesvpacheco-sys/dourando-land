import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, DEMO, getToken, setToken } from './api';

export interface Me {
  user: { id: string; name: string; email: string; role: string; orgId: string; brokerId: string | null; partnerCompanyIds: string[]; mfa?: boolean };
  org: { id: string; name: string };
  permissions: Record<string, { actions: string[]; scope: string }>;
  /** Verificação em duas etapas ligada no servidor (REQUIRE_MFA). Desligada, as telas não mostram nada sobre ela. */
  mfaRequired?: boolean;
}

interface Ctx {
  me: Me | null;
  loading: boolean;
  /** Atualiza a sessão depois do login. Com token: seletor da demonstração. Sem token: cookie já definido pelo servidor. */
  login: (token?: string) => Promise<void>;
  logout: () => void;
  can: (resource: string, action: string) => boolean;
  scope: (resource: string, action: string) => string | null;
}

const SessionCtx = createContext<Ctx>(null as any);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      if (getToken() || DEMO) {
        if (!getToken()) { setMe(null); setLoading(false); return; }
        setMe(await api<Me>('/api/admin/me'));
      } else {
        const s = await api<any>('/api/auth/session');
        setMe(s.authenticated ? s : null);
      }
    } catch { setMe(null); }
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const value: Ctx = {
    me, loading,
    login: async (t) => { if (t) setToken(t); setLoading(true); await load(); },
    logout: () => {
      setToken(null); setMe(null);
      if (!DEMO) void api('/api/auth/logout', { method: 'POST', auth: false }).catch(() => {});
    },
    can: (r, a) => !!me?.permissions[r]?.actions.includes(a),
    scope: (r, a) => (me?.permissions[r]?.actions.includes(a) ? me.permissions[r].scope : null),
  };
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);
