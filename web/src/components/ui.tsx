import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Modal({ title, onClose, children, drawer }: { title: string; onClose: () => void; children: ReactNode; drawer?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className={`backdrop ${drawer ? 'drawer-backdrop' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={drawer ? 'drawer' : 'modal'} role="dialog" aria-modal="true" aria-label={title}>
        <div className="spread" style={{ marginBottom: '0.75rem', alignItems: 'start' }}>
          <h2 style={{ fontSize: drawer ? 'var(--t2)' : undefined }}>{title}</h2>
          <button className="btn ghost small" onClick={onClose} aria-label="Fechar">Fechar</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const ToastCtx = createContext<(msg: string, bad?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; bad?: boolean } | null>(null);
  const show = useCallback((msg: string, bad?: boolean) => {
    setT({ msg, bad });
    window.clearTimeout((show as any)._t);
    (show as any)._t = window.setTimeout(() => setT(null), 3800);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && <div className={`toast ${t.bad ? 'bad' : ''}`} role="status">{t.msg}</div>}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{children}</div>;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, set] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const run = useCallback(() => {
    set((s) => ({ ...s, loading: true }));
    fn().then((data) => set({ data, error: null, loading: false })).catch((e) => set({ data: null, error: e.message, loading: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run, setData: (d: T) => set((s) => ({ ...s, data: d })) };
}

export function Loading() {
  return <p className="muted" style={{ padding: '2rem 0' }}>Carregando…</p>;
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="notice bad" role="alert">{error}</p>;
}

/** Selo de validação de um parâmetro técnico — deixa claro o que é oficial e o que é declarado. */
export function ValidationBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    oficial: ['ok', 'Documento oficial'],
    verificado: ['ok', 'Verificado'],
    declarado: ['warn', 'Declarado'],
    nao_verificado: ['bad', 'Não verificado'],
  };
  const [cls, label] = map[status] ?? ['', status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

const BASE = import.meta.env.BASE_URL;

/** Assinatura horizontal da Quero Área (arquivos em /brand, gerados dos originais do brand book). `light` = versão negativa, para fundo escuro. */
export function Brand({ light, sub }: { light?: boolean; sub?: string }) {
  return (
    <span style={{ display: 'grid', gap: 2 }}>
      <img src={`${BASE}brand/${light ? 'lockup-light' : 'lockup'}.png`} alt="Quero Área" width={166} height={30} />
      {sub && <span className="sub">{sub}</span>}
    </span>
  );
}

export function BrandSymbol({ size = 28 }: { size?: number }) {
  return <img src={`${BASE}brand/symbol.png`} alt="" width={size} height={size} style={{ display: 'block' }} />;
}
