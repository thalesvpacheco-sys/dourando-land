import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken } from './api';

export interface Me {
  user: { id: string; name: string; email: string; role: string; orgId: string; brokerId: string | null; partnerCompanyIds: string[] };
  org: { id: string; name: string };
  permissions: Record<string, { actions: string[]; scope: string }>;
}

interface Ctx {
  me: Me | null;
  loading: boolean;
  login: (token: string) => Promise<void>;
  logout: () => void;
  can: (resource: string, action: string) => boolean;
  scope: (resource: string, action: string) => string | null;
}

const SessionCtx = createContext<Ctx>(null as any);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!getToken()) { setMe(null); setLoading(false); return; }
    try { setMe(await api<Me>('/api/admin/me')); } catch { setMe(null); }
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const value: Ctx = {
    me, loading,
    login: async (t) => { setToken(t); setLoading(true); await load(); },
    logout: () => { setToken(null); setMe(null); },
    can: (r, a) => !!me?.permissions[r]?.actions.includes(a),
    scope: (r, a) => (me?.permissions[r]?.actions.includes(a) ? me.permissions[r].scope : null),
  };
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);
