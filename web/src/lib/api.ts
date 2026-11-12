/** Build de demonstração: backend simulado no navegador. */
export const DEMO = import.meta.env.VITE_DEMO === '1';
/** Site estático publicado (URLs reais, sem frame): mesmo backend simulado, mas roteamento por URL e novas abas liberadas. */
export const STATIC_SITE = DEMO && import.meta.env.VITE_ROUTER === 'browser';
/** Em demonstração dentro de frame (iframe), links não abrem nova aba. */
export const FRAMED = DEMO && !STATIC_SITE;
export const NEW_TAB: '_blank' | undefined = FRAMED ? undefined : '_blank';

// Cliente HTTP do painel e do portal. Em produção a sessão fica em cookie HttpOnly (o script não enxerga o token);
// o token em localStorage existe só na demonstração e no seletor de desenvolvimento.

const TOKEN_KEY = 'dl.token';

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t: string | null) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* armazenamento indisponível */ }
}

/** Baixa um arquivo autenticado e salva com o nome informado. */
export async function downloadFile(url: string, filename: string) {
  const t = getToken();
  const r = await fetch(url, t ? { headers: { Authorization: `Bearer ${t}` } } : undefined);
  if (!r.ok) throw new Error(r.status === 403 ? 'Sem permissão para exportar' : 'Não foi possível gerar o arquivo');
  const href = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = href; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: any) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = opts.auth === false ? null : getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const r = await fetch(path, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && token && !path.startsWith('/api/public')) { setToken(null); }
    throw new ApiError(r.status, data.error ?? `Erro ${r.status}`, data.details);
  }
  return data as T;
}

export const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Atribuição: guarda UTMs e IDs de clique da primeira visita (último toque com parâmetros, 90 dias). */
const ATTR_KEY = 'dl.attr';
const ATTR_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id'];
export function captureAttribution() {
  try {
    const p = new URLSearchParams(location.search);
    const found: Record<string, string> = {};
    for (const k of ATTR_PARAMS) { const v = p.get(k); if (v) found[k] = v.slice(0, 300); }
    if (Object.keys(found).length) {
      localStorage.setItem(ATTR_KEY, JSON.stringify({ ...found, landing_url: location.href.slice(0, 300), referrer: document.referrer.slice(0, 300), at: Date.now() }));
    }
  } catch { /* noop */ }
}
export function getAttribution(): Record<string, string> {
  try {
    const a = JSON.parse(localStorage.getItem(ATTR_KEY) ?? 'null');
    if (a && Date.now() - a.at < 90 * 86400_000) { const { at, ...rest } = a; return rest; }
  } catch { /* noop */ }
  return document.referrer ? { referrer: document.referrer.slice(0, 300) } : {};
}

/** Eventos para GA4/Meta via dataLayer — só são lidos pelas tags se o consentimento estiver dado. */
export function track(event: string, params: Record<string, unknown> = {}) {
  const w = window as any;
  w.dataLayer = w.dataLayer || [];
  w.dataLayer.push({ event, ...params });
}

/** Abre um arquivo servido por URL temporária. Na demonstração, downloads são bloqueados pelo frame. */
export function openFile(url: string, notify: (msg: string, bad?: boolean) => void) {
  if (DEMO) { notify('Na demonstração o download é bloqueado. Em produção, o arquivo abre por link temporário de 10 minutos e o acesso fica na auditoria.'); return; }
  window.open(url, '_blank');
}
