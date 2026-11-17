/**
 * Backend SIMULADO no navegador, usado apenas nas demonstrações (build demo e site estático).
 *
 * Reaproveita as mesmas regras do servidor real (matriz de permissões, visões pública/interna, checklist de publicação,
 * matching, mensagem do WhatsApp e heurísticas de IA). Não há banco: o estado vive na memória da página e, quando o
 * navegador permite, é guardado no localStorage deste visitante. PostGIS é aproximado com turf (área geodésica em esfera).
 */
import turfArea from '@turf/area';
import turfLength from '@turf/length';
import { kml as kmlToGeoJSON } from '@tmcw/togeojson';
import JSZip from 'jszip';
import {
  APPROVAL_ORDER, NEGOTIATION_STAGES, buildWhatsAppMessage, scoreMatch, slugify, INTENT_TOKEN_RE,
  type ApprovalStage, type NegotiationStage, type Role, type MatchProfile, type MatchOpportunity,
} from '@dl/shared';
import { grant, DOC_VISIBILITY, MATRIX, PRIVILEGED, type Action, type Resource } from '../../../server/src/auth/permissions';
import { approxPoint, buildSlug, internalView, publicView, publicationChecklist } from '../../../server/src/domain/views';
import { computeGaps, heuristicDescription, parseNaturalQuery } from '../../../server/src/domain/ai-heuristics';
import intersect from '@turf/intersect';
import { featureCollection, polygon as turfPolygon } from '@turf/helpers';
import {
  CAPTURE_CHECKLIST, PROSPECT_SOURCES, PROSPECT_STAGES, demoTerritoryFeatures, earthUrl, pointInGeometry, prospectScore, toKml, formatArea,
} from '@dl/shared';
import seed from './seed.json';
import { FRAMED } from '../lib/api';

// ================================================================ estado

type Row = Record<string, any>;
type DB = Record<string, Row[]>;
const KEY = 'dl.demo.v1';
let S: DB = load();
const objectUrls = new Map<string, string>(); // arquivos enviados nesta sessão (não persistem)

function load(): DB {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* sem armazenamento */ }
  return structuredClone(seed as unknown as DB);
}
let saveTimer: number | undefined;
function save() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* cota ou bloqueio: segue só em memória */ }
  }, 300);
}
export function resetDemo() {
  try { localStorage.removeItem(KEY); localStorage.removeItem('dl.token'); } catch { /* noop */ }
  S = structuredClone(seed as unknown as DB);
}
export function demoState() { return S; }

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const T = (t: string): any[] => (S[t] ??= []);
const one = (t: string, f: (r: Row) => boolean) => T(t).find(f);
const ins = (t: string, r: Row): any => { const row = { id: uuid(), created_at: now(), updated_at: now(), ...r }; T(t).push(row); return row; };
const upd = (r: Row, patch: Row) => Object.assign(r, patch, { updated_at: now() });

class HttpErr extends Error { constructor(public status: number, msg: string, public details?: any) { super(msg); } }
const nf = (w = 'Recurso') => new HttpErr(404, `${w} não encontrado`);
const forb = (m = 'Acesso negado') => new HttpErr(403, m);
const bad = (m: string, d?: any) => new HttpErr(400, m, d);
const conflict = (m: string, d?: any) => new HttpErr(409, m, d);

function normalizePhone(p?: string | null) {
  if (!p) return null;
  let d = p.replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d.length >= 12 ? d : null;
}
const maskPhone = (p: string) => { const d = p.replace(/\D/g, ''); return '*'.repeat(Math.max(0, d.length - 4)) + d.slice(-4); };
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const intentToken = () => 'DL-' + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]).join('');

// ================================================================ autenticação

interface U { id: string; orgId: string; dataOrgId: string; role: Role; name: string; email: string; brokerId: string | null; partnerCompanyIds: string[]; mfa: boolean }
function userFromToken(h: Headers): U | null {
  const a = h.get('authorization');
  if (!a?.startsWith('Bearer demo.')) return null;
  const u = one('users', (x) => x.id === a.slice(12) && x.active);
  if (!u) return null;
  const broker = u.role === 'broker' ? one('land_brokers', (b) => b.user_id === u.id) : null;
  const partners = u.role === 'buyer' ? T('partner_companies').filter((p) => p.partner_org_id === u.org_id) : [];
  return { id: u.id, orgId: u.org_id, dataOrgId: partners[0]?.org_id ?? u.org_id, role: u.role, name: u.name, email: u.email, brokerId: broker?.id ?? null, partnerCompanyIds: partners.map((p) => p.id), mfa: true };
}
function need(u: U | null, r: Resource, a: Action) {
  if (!u) throw new HttpErr(401, 'Autenticação necessária');
  const s = grant(u.role, r, a);
  if (!s) throw forb(`Seu perfil não pode ${a} ${r}`);
  return s;
}
const can = (u: U | null, r: Resource, a: Action) => !!u && !!grant(u.role, r, a);
function audit(u: U | null, action: string, entity: string, entity_id: string | null, diff?: any) {
  T('audit_logs').push({ id: T('audit_logs').length + 1, org_id: u?.dataOrgId ?? null, user_id: u?.id ?? null, action, entity, entity_id, diff: diff ?? null, created_at: now() });
}

// ================================================================ relações e escopo

function rel(id: string) {
  const assignments = T('broker_assignments').filter((a) => a.opportunity_id === id && a.active).map((a) => {
    const b = one('land_brokers', (x) => x.id === a.broker_id)!;
    const u = one('users', (x) => x.id === b.user_id)!;
    return { opportunity_id: id, role: a.role, broker_id: b.id, name: u.name, whatsapp: b.whatsapp, creci: b.creci, creci_uf: b.creci_uf, creci_status: b.creci_status };
  });
  return {
    geometry: one('land_geometries', (g) => g.opportunity_id === id && g.is_current) ?? null,
    tech: Object.fromEntries(T('land_technical_attributes').filter((t) => t.opportunity_id === id).map((t) => [t.key, t])),
    terms: one('land_commercial_terms', (t) => t.opportunity_id === id) ?? null,
    pub: one('publication_permissions', (p) => p.opportunity_id === id) ?? null,
    media: T('land_media').filter((m) => m.opportunity_id === id).sort((a, b) => Number(b.is_cover) - Number(a.is_cover) || a.sort - b.sort),
    owners: T('land_owners').filter((o) => o.opportunity_id === id),
    documents: T('land_documents').filter((d) => d.opportunity_id === id && d.is_current).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    assignments,
  };
}

function oppVisible(u: U, o: Row, action: Action = 'read') {
  const s = grant(u.role, 'opportunity', action);
  if (!s) return false;
  if (s === 'org') return o.org_id === u.orgId;
  if (s === 'assigned') return o.org_id === u.orgId && T('broker_assignments').some((a) => a.opportunity_id === o.id && a.active && a.broker_id === u.brokerId);
  if (s === 'own') return T('land_owners').some((x) => x.opportunity_id === o.id && x.user_id === u.id);
  if (s === 'published') return o.publication_status === 'published';
  return false;
}
function getOpp(u: U | null, idOrCode: string, action: Action = 'read') {
  if (!u) throw new HttpErr(401, 'Autenticação necessária');
  const o = one('land_opportunities', (x) => x.id === idOrCode || x.code === idOrCode.toUpperCase());
  if (!o || !oppVisible(u, o, action)) throw nf('Oportunidade');
  return o;
}

function interestVisible(u: U, i: Row) {
  const s = grant(u.role, 'interest', 'read');
  if (!s || i.org_id !== u.dataOrgId) return false;
  if (s === 'assigned') return i.broker_id === u.brokerId || T('broker_assignments').some((a) => a.opportunity_id === i.opportunity_id && a.active && a.broker_id === u.brokerId);
  return true;
}
function negVisible(u: U, n: Row, action: Action = 'read') {
  const s = grant(u.role, 'negotiation', action);
  if (!s || n.org_id !== u.dataOrgId) return false;
  if (s === 'assigned') return T('negotiation_participants').some((p) => p.negotiation_id === n.id && p.broker_id === u.brokerId)
    || T('broker_assignments').some((a) => a.opportunity_id === n.opportunity_id && a.active && a.broker_id === u.brokerId);
  if (s === 'own') return u.partnerCompanyIds.includes(n.partner_company_id);
  return true;
}
function getNeg(u: U | null, id: string, action: Action = 'read') {
  if (!u) throw new HttpErr(401, 'Autenticação necessária');
  need(u, 'negotiation', action);
  const n = one('negotiations', (x) => x.id === id);
  if (!n || !negVisible(u, n, action)) throw nf('Negociação');
  return n;
}

// ================================================================ matching

function matchOpp(o: Row): MatchOpportunity {
  const r = rel(o.id);
  return { uf: o.uf, city: o.city, area_m2: o.area_m2, asking_price: r.terms?.asking_price ?? null, modalities: r.terms?.modalities ?? [], swap_pct: r.terms?.swap_pct ?? null,
    tech: Object.fromEntries(Object.entries(r.tech).map(([k, v]: any) => [k, { value: v.value, validation_status: v.validation_status }])) };
}
const toProfile = (p: Row): MatchProfile => ({ ufs: p.ufs, cities: p.cities, min_area_m2: p.min_area_m2, max_area_m2: p.max_area_m2, typologies: p.typologies,
  budget_max: p.budget_max, modalities: p.modalities, max_swap_pct: p.max_swap_pct, min_approval_stage: p.min_approval_stage, restrictions: p.restrictions ?? {} });
function upsertMatch(o: Row, p: Row) {
  const r = scoreMatch(toProfile(p), matchOpp(o));
  const ex = one('opportunity_matches', (m) => m.opportunity_id === o.id && m.profile_id === p.id);
  if (r.excluded || r.score < 40) { if (ex && ex.status === 'suggested') S.opportunity_matches = T('opportunity_matches').filter((m) => m !== ex); return; }
  if (ex) upd(ex, { score: r.score, confidence: r.confidence, breakdown: r });
  else ins('opportunity_matches', { org_id: o.org_id, opportunity_id: o.id, profile_id: p.id, score: r.score, confidence: r.confidence, breakdown: r, status: 'suggested' });
}
const recomputeOpp = (o: Row) => T('acquisition_profiles').filter((p) => p.org_id === o.org_id && p.active).forEach((p) => upsertMatch(o, p));
const recomputeProfile = (p: Row) => T('land_opportunities').filter((o) => o.org_id === p.org_id && !['concluida', 'suspensa'].includes(o.status)).forEach((o) => upsertMatch(o, p));

// ================================================================ roteamento e CRM embutido

function routeInterest(o: Row) {
  const org = one('organizations', (x) => x.id === o.org_id)!;
  const central = normalizePhone(org.central_whatsapp);
  const eligible = (b: Row | undefined) => {
    if (!b) return false;
    const u = one('users', (x) => x.id === b.user_id);
    return b.active && u?.active && b.whatsapp && b.creci_status !== 'irregular';
  };
  const bname = (b: Row) => one('users', (x) => x.id === b.user_id)!.name;
  const assigned = () => {
    const a = one('broker_assignments', (x) => x.opportunity_id === o.id && x.active && x.role === 'primary');
    const b = a && one('land_brokers', (x) => x.id === a.broker_id);
    return eligible(b) ? b : null;
  };
  const rules = T('whatsapp_routing_rules').filter((r) => r.org_id === o.org_id && r.active).sort((a, b) => a.priority - b.priority);
  for (const r of rules) {
    const c = r.criteria ?? {};
    if (c.ufs?.length && !c.ufs.includes(o.uf)) continue;
    if (c.cities?.length && !c.cities.map((x: string) => x.toLowerCase()).includes(o.city.toLowerCase())) continue;
    if (c.types?.length && !c.types.includes(o.type)) continue;
    if (r.target === 'assigned_broker') {
      const b = assigned();
      if (b) return { broker_id: b.id, broker_name: bname(b), number: normalizePhone(b.whatsapp), via: `regra: ${r.name}`, rule_id: r.id, sla: r.sla_minutes };
    } else if (r.target === 'round_robin' && r.broker_ids?.length) {
      const pool = T('land_brokers').filter((b) => r.broker_ids.includes(b.id) && eligible(b)).sort((a, b) => (a.last_routed_at ?? '').localeCompare(b.last_routed_at ?? ''));
      if (pool[0]) { pool[0].last_routed_at = now(); return { broker_id: pool[0].id, broker_name: bname(pool[0]), number: normalizePhone(pool[0].whatsapp), via: `regra: ${r.name} (rodízio)`, rule_id: r.id, sla: r.sla_minutes }; }
    } else if (r.target === 'central' && central) {
      return { broker_id: null, broker_name: 'Atendimento Quero Área', number: central, via: `regra: ${r.name}`, rule_id: r.id, sla: r.sla_minutes };
    }
  }
  const b = assigned();
  if (b) return { broker_id: b.id, broker_name: bname(b), number: normalizePhone(b.whatsapp), via: 'intermediador atribuído', rule_id: null, sla: 60 };
  return { broker_id: null, broker_name: central ? 'Atendimento Quero Área' : null, number: central, via: 'fallback: número central', rule_id: null, sla: 60 };
}

function crmUpsertContact(orgId: string, p: Row) {
  const ex = T('crm_contacts').find((c) => c.org_id === orgId && ((p.email && c.email === p.email) || (p.phone && c.phone === p.phone)));
  if (ex) { upd(ex, { name: p.name ?? ex.name, company: p.company ?? ex.company, tags: Array.from(new Set([...(ex.tags ?? []), ...(p.tags ?? [])])) }); return ex.id; }
  const id = `emb_${uuid().slice(0, 12)}`;
  T('crm_contacts').push({ id, org_id: orgId, name: p.name, email: p.email, phone: p.phone, company: p.company, tags: p.tags ?? [], created_at: now(), updated_at: now() });
  return id;
}

// ================================================================ arquivos

function tinyPdf(title: string) {
  const text = `(${title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[()\\]/g, '')} - DOCUMENTO FICTICIO DE DEMONSTRACAO)`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length + 40} >>\nstream\nBT /F1 12 Tf 40 760 Td ${text} Tj ET\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return new Blob([pdf], { type: 'application/pdf' });
}
async function imageToDataUrl(f: File): Promise<{ url: string; w: number; h: number }> {
  if (!/^image\/(jpeg|png|webp)$/.test(f.type)) throw bad('Envie imagens JPG, PNG ou WebP');
  const bmp = await createImageBitmap(f).catch(() => { throw bad('Arquivo não é uma imagem válida'); });
  const scale = Math.min(1, 1400 / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return { url: c.toDataURL('image/webp', 0.8), w: c.width, h: c.height }; // recodificar remove EXIF/GPS, como no servidor
}
async function parseGeo(f: File) {
  const ext = f.name.toLowerCase().split('.').pop();
  try {
    if (ext === 'geojson' || ext === 'json') return JSON.parse(await f.text());
    if (ext === 'kml') return kmlToGeoJSON(new DOMParser().parseFromString(await f.text(), 'text/xml'));
    if (ext === 'kmz') {
      const zip = await JSZip.loadAsync(await f.arrayBuffer());
      const e = Object.values(zip.files).find((x) => x.name.toLowerCase().endsWith('.kml'));
      if (!e) throw new Error('KMZ sem arquivo KML');
      return kmlToGeoJSON(new DOMParser().parseFromString(await e.async('string'), 'text/xml'));
    }
    if (ext === 'zip') { const shp = (await import('shpjs')).default as any; return await shp(await f.arrayBuffer()); }
  } catch (e: any) { throw bad(`Não foi possível ler o arquivo geográfico: ${e.message}`); }
  throw bad('Formato não suportado. Use KML, KMZ, GeoJSON ou SHP (.zip)');
}
function polygonsOf(g: any): any[] {
  if (!g) return [];
  if (Array.isArray(g)) return g.flatMap(polygonsOf);
  if (g.type === 'FeatureCollection') return g.features.flatMap(polygonsOf);
  if (g.type === 'Feature') return polygonsOf(g.geometry);
  if (g.type === 'GeometryCollection') return g.geometries.flatMap(polygonsOf);
  return g.type === 'Polygon' || g.type === 'MultiPolygon' ? [g] : [];
}
function saveGeometry(u: U, o: Row, input: any, source: string) {
  const polys = polygonsOf(input);
  if (!polys.length) throw bad('Nenhum polígono encontrado no arquivo/desenho');
  const coords = polys.flatMap((p) => (p.type === 'Polygon' ? [p.coordinates] : p.coordinates));
  const geometry = { type: 'MultiPolygon', coordinates: coords };
  const feat = { type: 'Feature' as const, geometry: geometry as any, properties: {} };
  const area = turfArea(feat);
  if (!area) throw bad('Geometria inválida ou com área zero');
  const perim = coords.reduce((s: number, poly: any) => s + turfLength({ type: 'Feature', geometry: { type: 'LineString', coordinates: poly[0] }, properties: {} }, { units: 'meters' }), 0);
  const ring = coords[0][0];
  const c_lng = ring.reduce((s: number, p: number[]) => s + p[0], 0) / ring.length;
  const c_lat = ring.reduce((s: number, p: number[]) => s + p[1], 0) / ring.length;
  const [p_lng, p_lat] = approxPoint(c_lat, c_lng, o.id);
  const prev = T('land_geometries').filter((g) => g.opportunity_id === o.id);
  prev.forEach((g) => (g.is_current = false));
  const g = ins('land_geometries', { opportunity_id: o.id, geometry, c_lng, c_lat, p_lng, p_lat, area_m2: area, perimeter_m: perim, source, version: prev.length + 1, is_current: true });
  upd(o, { lat: c_lat, lng: c_lng, area_m2: o.area_m2 ?? Math.round(area), version: o.version + 1 });
  audit(u, 'geometry.update', 'land_geometries', g.id, { opportunity_id: o.id, area_m2: area, version: g.version, source });
  return { id: g.id, area_m2: area, perimeter_m: perim, version: g.version, lng: c_lng, lat: c_lat };
}

// ================================================================ roteador

type Ctx = { u: U | null; params: Record<string, string>; q: URLSearchParams; body: any; form: FormData | null; method: string };
type Handler = (c: Ctx) => any | Promise<any>;
const routes: { m: string; re: RegExp; keys: string[]; h: Handler }[] = [];
function on(m: string, path: string, h: Handler) {
  const keys: string[] = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ m, re, keys, h });
}
const csv = (v: string | null) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

// ---------------------------------------------------------------- público

function visibleList(u: U | null) {
  const seesPrivate = u && grant(u.role, 'opportunity', 'read');
  return T('land_opportunities').filter((o) => o.publication_status === 'published' && (seesPrivate || o.visibility === 'public'));
}
function applyFilters(list: Row[], q: URLSearchParams) {
  return list.filter((o) => {
    const r = rel(o.id); const t = r.terms ?? {}; const pp = r.pub ?? {};
    const has = (k: string, v?: string) => q.get(k) && (v === undefined || true);
    if (has('q')) { const s = q.get('q')!.toLowerCase(); if (![o.public_title, o.city, o.code, o.region, o.summary].some((x) => x?.toLowerCase().includes(s))) return false; }
    if (has('uf') && !csv(q.get('uf')).includes(o.uf)) return false;
    if (has('city') && o.city.toLowerCase() !== q.get('city')!.toLowerCase()) return false;
    if (has('region') && !o.region?.toLowerCase().includes(q.get('region')!.toLowerCase())) return false;
    if (has('type') && !csv(q.get('type')).includes(o.type)) return false;
    if (has('status')) { if (!csv(q.get('status')).includes(o.status)) return false; } else if (['concluida', 'suspensa'].includes(o.status)) return false;
    if (has('area_min') && !(o.area_m2 >= +q.get('area_min')!)) return false;
    if (has('area_max') && !(o.area_m2 <= +q.get('area_max')!)) return false;
    if (has('price_min') || has('price_max')) {
      if (!pp.show_price || t.asking_price == null) return false; // não vaza preço oculto por inferência
      if (has('price_min') && t.asking_price < +q.get('price_min')!) return false;
      if (has('price_max') && t.asking_price > +q.get('price_max')!) return false;
    }
    if (has('ppm2_min') || has('ppm2_max')) {
      if (!pp.show_price_per_m2 || !t.asking_price || !o.area_m2) return false;
      const v = t.asking_price / o.area_m2;
      if (has('ppm2_min') && v < +q.get('ppm2_min')!) return false;
      if (has('ppm2_max') && v > +q.get('ppm2_max')!) return false;
    }
    if (has('modality') && !csv(q.get('modality')).some((m) => (t.modalities ?? []).includes(m))) return false;
    if (has('viability')) { const v = r.tech.viabilidade?.value ?? []; if (!csv(q.get('viability')).some((x) => v.includes(x))) return false; }
    if (has('approval')) { const idx = APPROVAL_ORDER.indexOf(q.get('approval') as ApprovalStage); const v = r.tech.estagio_aprovacao?.value; if (idx >= 0 && !(v && APPROVAL_ORDER.slice(idx).includes(v))) return false; }
    for (const k of csv(q.get('infra'))) if (r.tech[k]?.value !== true) return false;
    if (q.get('featured') === '1' && !o.featured) return false;
    return true;
  });
}
on('GET', '/api/public/opportunities', ({ u, q }) => {
  const page = Math.max(1, +(q.get('page') ?? 1)), per = Math.min(48, +(q.get('per') ?? 24));
  let list = applyFilters(visibleList(u), q);
  const sort = q.get('sort');
  list = list.sort((a, b) => sort === 'recent' ? (b.published_at ?? '').localeCompare(a.published_at ?? '')
    : sort === 'area_desc' ? b.area_m2 - a.area_m2 : sort === 'area_asc' ? a.area_m2 - b.area_m2
    : Number(b.featured) - Number(a.featured) || (b.published_at ?? '').localeCompare(a.published_at ?? ''));
  return { total: list.length, page, per, items: list.slice((page - 1) * per, page * per).map((o) => publicView(o, rel(o.id))) };
});
on('GET', '/api/public/map', ({ u, q }) => ({
  type: 'FeatureCollection',
  features: applyFilters(visibleList(u), q).map((o) => publicView(o, rel(o.id))).filter((v) => v.location?.point).map((v: any) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: v.location.point },
    properties: { code: v.code, slug: v.slug, title: v.title, city: v.city, uf: v.uf, area_m2: v.area_m2, type: v.type, precision: v.location.precision, radius_m: v.location.radius_m,
      cover: v.media[0]?.url ?? null, modalities: v.commercial.modalities.join(','), polygon: v.location.polygon ? JSON.stringify(v.location.polygon) : null },
  })),
}));
on('GET', '/api/public/meta', ({ u }) => {
  const l = visibleList(u).filter((o) => !['concluida', 'suspensa'].includes(o.status));
  const count = (key: (o: Row) => string) => Object.values(l.reduce((m: any, o) => { const k = key(o); (m[k] ??= { ...pick(o, k), n: 0 }).n++; return m; }, {}));
  function pick(o: Row, k: string) { return k.includes('|') ? { city: o.city, uf: o.uf } : { uf: o.uf }; }
  return {
    ufs: count((o) => o.uf).sort((a: any, b: any) => a.uf.localeCompare(b.uf)),
    cities: count((o) => `${o.city}|${o.uf}`).sort((a: any, b: any) => a.city.localeCompare(b.city)),
    types: [], totals: { n: l.length, area: l.reduce((s, o) => s + (o.area_m2 ?? 0), 0), cities: new Set(l.map((o) => o.city)).size },
    central_whatsapp: normalizePhone(T('organizations').find((o) => o.kind === 'manager')?.central_whatsapp) || null,
  };
});
function bySlug(u: U | null, slug: string) {
  const m = /^([a-z]{2,6}-[a-z]{2}-\d{4})/i.exec(slug);
  const o = m && visibleList(u).find((x) => x.code === m[1].toUpperCase());
  if (!o) throw nf('Oportunidade');
  return o;
}
on('GET', '/api/public/opportunities/:slug', ({ u, params }) => {
  const o = bySlug(u, params.slug);
  const sim = visibleList(u).filter((x) => x.id !== o.id && !['concluida', 'suspensa'].includes(x.status) && (x.uf === o.uf || x.type === o.type))
    .map((x) => ({ x, r: (x.city === o.city ? 2 : 0) + (x.type === o.type ? 2 : 0) + (x.uf === o.uf ? 1 : 0) })).sort((a, b) => b.r - a.r).slice(0, 4).map(({ x }) => publicView(x, rel(x.id)));
  return { ...publicView(o, rel(o.id)), canonical_slug: o.slug, similar: sim, favorite: !!u && T('favorites').some((f) => f.user_id === u.id && f.opportunity_id === o.id) };
});
on('POST', '/api/public/opportunities/:slug/interest', ({ u, params, body: b }) => {
  const o = bySlug(u, params.slug);
  const name = b.name || u?.name || null;
  const email = (b.email || u?.email || '').toLowerCase() || null;
  const phone = normalizePhone(b.phone);
  const hasPersonal = !!(b.name || b.email || b.phone || b.company);
  if (b.kind === 'form' && (!name || (!email && !phone))) throw bad('Informe nome e e-mail ou telefone');
  if (hasPersonal && !b.consent && !u) throw bad('É necessário aceitar o uso dos dados para contato (LGPD)');
  if (b.phone && !phone) throw bad('Telefone inválido — use DDD + número');
  if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) throw bad('E-mail inválido');
  const identified = !!(name && (email || phone));
  const legal = !identified ? null : u && !hasPersonal ? 'cadastro_plataforma' : 'consentimento';
  const a = b.attribution ?? {};
  const channel = b.channel ?? (a.gclid ? 'google_ads' : a.fbclid ? 'meta_ads' : a.utm_medium ? a.utm_medium : 'direct');
  const route = routeInterest(o);
  const token = intentToken();
  const view = publicView(o, rel(o.id));
  const i = ins('opportunity_interests', {
    org_id: o.org_id, opportunity_id: o.id, intent_token: token, status: b.kind === 'form' ? 'form_submitted' : 'clicked', kind: b.kind, channel, attribution: a,
    name: identified ? name : null, email: identified ? email : null, phone: identified ? phone : null, company: b.company || null, message: b.message || null,
    consent: !!b.consent, legal_basis: legal, user_id: u?.id ?? null, broker_id: route.broker_id, routed_to_number: route.number, routed_via: route.via, rule_id: route.rule_id,
    sla_due_at: new Date(Date.now() + route.sla * 60000).toISOString(), first_response_at: null, crm_contact_id: null, crm_lead_id: null,
    crm_sync_status: identified ? 'pending' : 'not_applicable', negotiation_id: null,
  });
  ins('interest_events', { interest_id: i.id, type: b.kind === 'form' ? 'form' : 'click', payload: { channel } });
  ins('interest_events', { interest_id: i.id, type: 'routed', payload: { via: route.via, broker: route.broker_name } });
  if (identified) {
    const cid = crmUpsertContact(o.org_id, { name, email, phone, company: b.company || null, tags: ['dourado-land', `area:${o.code}`, `canal:${channel}`] });
    upd(i, { crm_contact_id: cid, crm_lead_id: `emb_lead_${uuid().slice(0, 10)}`, crm_sync_status: 'synced' });
    ins('interest_events', { interest_id: i.id, type: 'crm_synced', payload: { mode: 'embedded', contact_id: cid } });
    const owner = route.broker_id ? one('land_brokers', (x) => x.id === route.broker_id)?.user_id : null;
    const n = ins('negotiations', { org_id: o.org_id, opportunity_id: o.id, interest_id: i.id, contact_name: name, contact_email: email, contact_phone: phone, crm_contact_id: cid,
      stage: 'interesse_recebido', status: 'open', owner_id: owner, next_activity: 'Primeiro contato', next_activity_at: i.sla_due_at, version: 1, partner_company_id: null });
    if (route.broker_id) T('negotiation_participants').push({ negotiation_id: n.id, broker_id: route.broker_id, role: 'intermediador' });
    upd(i, { negotiation_id: n.id });
    ins('activities', { org_id: o.org_id, opportunity_id: o.id, negotiation_id: n.id, type: 'system', subject: `Interesse recebido via ${b.kind === 'form' ? 'formulário' : 'WhatsApp'} (${token})`, body: b.message || null });
  }
  const message = buildWhatsAppMessage({ code: o.code, title: view.title, city: o.city, uf: o.uf, areaM2: o.area_m2, token });
  return { __status: 201, token, status: i.status, routed_to: route.broker_name, whatsapp_url: route.number ? `https://wa.me/${route.number}?text=${encodeURIComponent(message)}` : null, message, crm: { status: i.crm_sync_status, contact_id: i.crm_contact_id } };
});
on('POST', '/api/public/contact', ({ body: b }) => {
  if (!b.consent) throw bad('É necessário aceitar o uso dos dados para contato (LGPD)');
  if (!b.name || (!b.email && !b.phone)) throw bad('Informe nome e e-mail ou telefone');
  const org = one('organizations', (x) => x.kind === 'manager')!;
  crmUpsertContact(org.id, { name: b.name, email: b.email?.toLowerCase() || null, phone: normalizePhone(b.phone), company: b.company || null, tags: ['dourado-land', `form:${b.kind}`] });
  if (b.kind === 'proprietario') createProspectRow(org.id, null, { title: `Área oferecida por ${b.name}${b.city ? ` — ${b.city}` : ''}`, source: 'site_proprietario', city: b.city || null, owner_name: b.name, owner_phone: b.phone || null, owner_email: b.email || null, notes: b.message || null, legal_basis: 'consentimento', assigned_to: null });
  return { __status: 201, ok: true };
});
on('GET', '/api/public/documents/:id/url', ({ params }) => {
  const d = one('land_documents', (x) => x.id === params.id && x.confidentiality === 'public' && x.is_current);
  if (!d) throw nf('Documento');
  return fileUrl(d);
});
function fileUrl(d: Row) {
  const url = objectUrls.get(d.id) ?? URL.createObjectURL(tinyPdf(`${d.title} v${d.version}`));
  return { url, expires_at: new Date(Date.now() + 600000).toISOString(), demo_name: d.original_name };
}
on('POST', '/api/public/ai/search', ({ body }) => searchAi(body.text));
function searchAi(text: string) {
  if (!text || text.length < 3) throw bad('Texto muito curto');
  const p = parseNaturalQuery(text);
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const city = T('land_opportunities').filter((o) => o.publication_status === 'published').find((c) => norm(p.rest).includes(norm(c.city)));
  if (city) { p.filters.city = city.city; p.filters.uf = city.uf; p.explain.push(`cidade ${city.city}/${city.uf}`); }
  return { filters: p.filters, explain: p.explain, origin: 'heuristic', label: 'Interpretação automática — ajuste os filtros se necessário' };
}

// ---------------------------------------------------------------- login de demonstração e sessão

on('GET', '/api/dev/users', () => ({
  items: T('users').filter((x) => x.active).map((x) => ({ id: x.id, name: x.name, email: x.email, role: x.role, org_name: one('organizations', (o) => o.id === x.org_id)!.name }))
    .sort((a, b) => a.role.localeCompare(b.role)),
}));
on('POST', '/api/dev/login', ({ body }) => {
  const x = one('users', (u) => u.id === body.user_id && u.active);
  if (!x) throw nf('Usuário');
  return { token: `demo.${x.id}` };
});
on('GET', '/api/admin/me', ({ u }) => {
  if (!u) throw new HttpErr(401, 'Autenticação necessária');
  const org = one('organizations', (o) => o.id === u.orgId)!;
  return { user: u, org: { id: org.id, name: org.name }, permissions: MATRIX[u.role] };
});

// ---------------------------------------------------------------- áreas

on('GET', '/api/opportunities', ({ u, q }) => {
  need(u, 'opportunity', 'read');
  const showPrice = can(u, 'commercial_terms', 'read');
  let l = T('land_opportunities').filter((o) => oppVisible(u!, o));
  const s = q.get('q')?.toLowerCase();
  if (s) l = l.filter((o) => [o.internal_name, o.public_title, o.code, o.city].some((x) => x?.toLowerCase().includes(s)));
  if (q.get('status')) l = l.filter((o) => csv(q.get('status')).includes(o.status));
  if (q.get('publication')) l = l.filter((o) => csv(q.get('publication')).includes(o.publication_status));
  if (q.get('uf')) l = l.filter((o) => o.uf === q.get('uf'));
  if (q.get('stale')) l = l.filter((o) => Date.now() - +new Date(o.updated_at) > 30 * 86400000);
  const items = l.map((o) => {
    const r = rel(o.id); const pb = r.assignments.find((a) => a.role === 'primary');
    return { id: o.id, code: o.code, slug: o.slug, internal_name: o.internal_name, public_title: o.public_title, type: o.type, city: o.city, uf: o.uf, area_m2: o.area_m2,
      status: o.status, publication_status: o.publication_status, visibility: o.visibility, featured: o.featured, updated_at: o.updated_at, created_at: o.created_at,
      broker_name: pb?.name ?? null, broker_id: pb?.broker_id ?? null, asking_price: showPrice ? r.terms?.asking_price : null, modalities: r.terms?.modalities };
  }).filter((o) => !q.get('broker') || o.broker_id === q.get('broker'));
  items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { items };
});
on('GET', '/api/opportunities/export.csv', ({ u }) => {
  need(u, 'opportunity', 'export');
  const rows = T('land_opportunities').filter((o) => oppVisible(u!, o)).sort((a, b) => a.code.localeCompare(b.code));
  audit(u, 'export', 'land_opportunities', null, { count: rows.length });
  const head = ['code', 'internal_name', 'public_title', 'type', 'city', 'uf', 'area_m2', 'status', 'publication_status', 'asking_price'];
  return { __raw: '﻿' + [head.join(';'), ...rows.map((o) => head.map((h) => `"${String(h === 'asking_price' ? rel(o.id).terms?.asking_price ?? '' : o[h] ?? '').replace(/"/g, '""')}"`).join(';'))].join('\n'), __type: 'text/csv' };
});
on('POST', '/api/opportunities', ({ u, body: b }) => {
  need(u, 'opportunity', 'create');
  if (!b.internal_name || b.internal_name.length < 3 || !b.city || !b.uf || !b.type) throw bad('Dados inválidos');
  const org = one('organizations', (x) => x.id === u!.orgId)!;
  const prefix = org.code_prefix ?? 'DOU';
  const max = T('land_opportunities').filter((o) => o.code.startsWith(`${prefix}-${b.uf}-`)).reduce((m, o) => Math.max(m, +o.code.split('-').pop()), 0);
  const code = `${prefix}-${b.uf}-${String(max + 1).padStart(4, '0')}`;
  const o = ins('land_opportunities', { org_id: u!.orgId, code, slug: buildSlug({ code, ...b }), internal_name: b.internal_name, type: b.type, uf: b.uf, city: b.city,
    status: 'captacao', publication_status: 'draft', visibility: 'public', featured: false, draft_step: 1, version: 1, internal_owner_id: u!.id, created_by: u!.id,
    public_title: null, lat: null, lng: null, area_m2: null });
  ins('land_commercial_terms', { opportunity_id: o.id, modalities: [], commission_split: [], negotiable: true, exclusivity: false });
  ins('publication_permissions', { opportunity_id: o.id, show_price: false, show_price_per_m2: false, show_owner: false, location_precision: 'approximate', show_public_documents: true });
  audit(u, 'create', 'land_opportunities', o.id, b);
  return { __status: 201, ...o };
});
on('GET', '/api/opportunities/:id', ({ u, params }) => {
  need(u, 'opportunity', 'read');
  const o = getOpp(u, params.id);
  const r = rel(o.id);
  return { ...internalView(o, { ...r, geometry: r.geometry && { ...r.geometry } }, u!.role, u!.brokerId), checklist: publicationChecklist(o, r) };
});
on('PATCH', '/api/opportunities/:id', ({ u, params, body: b }) => {
  need(u, 'opportunity', 'update');
  const o = getOpp(u, params.id, 'update');
  if (b.terms && !can(u, 'commercial_terms', 'update')) throw forb('Sem permissão para condições comerciais');
  if (b.terms && ('commission_total_pct' in b.terms || 'commission_split' in b.terms) && !can(u, 'commission', 'update')) throw forb('Sem permissão para comissionamento');
  if (b.fields && ['lat', 'lng', 'address'].some((k) => k in b.fields) && !can(u, 'exact_location', 'update')) throw forb('Sem permissão para localização exata');
  if (b.publication && !can(u, 'publication', 'create')) throw forb('Sem permissão para configurar publicação');
  if (b.fields?.featured !== undefined && !can(u, 'publication', 'approve')) throw forb('Somente administradores definem destaques');
  if (o.version !== b.version) throw conflict('A área foi alterada por outra pessoa. Recarregue para continuar.', { current_version: o.version });
  const patch: Row = { version: o.version + 1 };
  if (b.draft_step) patch.draft_step = Math.max(o.draft_step, b.draft_step);
  if (b.fields) {
    Object.assign(patch, b.fields);
    if (o.publication_status !== 'published' && (b.fields.public_title !== undefined || b.fields.city || b.fields.type)) patch.slug = buildSlug({ ...o, ...b.fields });
  }
  upd(o, patch);
  const r = rel(o.id);
  if (b.terms) upd(r.terms!, b.terms);
  if (b.publication) upd(r.pub!, b.publication);
  for (const [key, item] of Object.entries<any>(b.technical ?? {})) {
    const ex = one('land_technical_attributes', (t) => t.opportunity_id === o.id && t.key === key);
    if (ex) upd(ex, item); else ins('land_technical_attributes', { opportunity_id: o.id, key, ...item });
  }
  audit(u, 'update', 'land_opportunities', o.id, { ...b.fields, ...(b.terms && { terms: Object.keys(b.terms) }), ...(b.technical && { technical: Object.keys(b.technical) }) });
  if (b.technical || b.terms || b.fields?.area_m2 !== undefined) recomputeOpp(o);
  return { version: o.version, saved_at: now() };
});
on('GET', '/api/opportunities/:id/history', ({ u, params }) => {
  need(u, 'opportunity', 'update');
  const o = getOpp(u, params.id);
  return { items: T('audit_logs').filter((a) => a.entity_id === o.id).reverse() };
});
on('POST', '/api/opportunities/:id/geometry/import', async ({ u, params, form }) => {
  need(u, 'opportunity', 'update'); getOpp(u, params.id, 'update');
  const f = form?.get('file') as File | null;
  if (!f) throw bad('Envie um arquivo');
  return { geojson: await parseGeo(f), source: f.name.split('.').pop()?.toLowerCase() };
});
on('PUT', '/api/opportunities/:id/geometry', ({ u, params, body }) => {
  need(u, 'exact_location', 'update');
  return saveGeometry(u!, getOpp(u, params.id, 'update'), body.geojson, body.source === 'zip' ? 'shp' : body.source);
});
on('POST', '/api/opportunities/:id/owners', ({ u, params, body: b }) => {
  need(u, 'owner_data', 'create');
  const o = getOpp(u, params.id, 'update');
  if (!b.name) throw bad('Informe o nome');
  const r = ins('land_owners', { opportunity_id: o.id, kind: b.kind, name: b.name, document: b.document || null, email: b.email || null, phone: b.phone || null, representative: b.representative || null, share_pct: b.share_pct ?? null });
  audit(u, 'create', 'land_owners', r.id, { opportunity_id: o.id, name: b.name });
  return { __status: 201, id: r.id };
});
on('DELETE', '/api/opportunities/:id/owners/:ownerId', ({ u, params }) => {
  need(u, 'owner_data', 'update'); const o = getOpp(u, params.id, 'update');
  S.land_owners = T('land_owners').filter((x) => !(x.id === params.ownerId && x.opportunity_id === o.id));
  return { __status: 204 };
});
on('POST', '/api/opportunities/:id/media', async ({ u, params, form }) => {
  need(u, 'opportunity', 'update'); const o = getOpp(u, params.id, 'update');
  const files = (form?.getAll('files') ?? []) as File[];
  if (!files.length) throw bad('Envie ao menos uma imagem');
  const hasCover = T('land_media').some((m) => m.opportunity_id === o.id && m.is_cover);
  const base = T('land_media').filter((m) => m.opportunity_id === o.id).reduce((s, m) => Math.max(s, m.sort), 0);
  const items = [];
  for (const [i, f] of files.entries()) {
    const img = await imageToDataUrl(f);
    items.push(ins('land_media', { opportunity_id: o.id, storage_key: `__data__${img.url}`, width: img.w, height: img.h, sort: base + i + 1, is_cover: !hasCover && i === 0, caption: null }));
  }
  audit(u, 'upload', 'land_media', null, { opportunity_id: o.id, count: items.length });
  return { __status: 201, items };
});
on('PATCH', '/api/opportunities/:id/media/:mediaId', ({ u, params, body }) => {
  need(u, 'opportunity', 'update'); const o = getOpp(u, params.id, 'update');
  if (body.is_cover) T('land_media').filter((m) => m.opportunity_id === o.id).forEach((m) => (m.is_cover = false));
  const m = one('land_media', (x) => x.id === params.mediaId && x.opportunity_id === o.id);
  if (!m) throw nf('Imagem');
  upd(m, body); return { ok: true };
});
on('DELETE', '/api/opportunities/:id/media/:mediaId', ({ u, params }) => {
  need(u, 'opportunity', 'update'); const o = getOpp(u, params.id, 'update');
  S.land_media = T('land_media').filter((x) => !(x.id === params.mediaId && x.opportunity_id === o.id));
  return { __status: 204 };
});
const BLOCKED = /\.(exe|js|html?|svg|bat|sh|php|msi|dll|jar)$/i;
on('POST', '/api/opportunities/:id/documents', async ({ u, params, form }) => {
  const scope = need(u, 'document', 'create');
  const o = getOpp(u, params.id, scope === 'own' ? 'read' : 'update');
  const f = form?.get('file') as File | null;
  if (!f) throw bad('Envie um arquivo');
  if (BLOCKED.test(f.name)) throw bad('Tipo de arquivo não permitido');
  const head = new Uint8Array(await f.slice(0, 512).arrayBuffer());
  const text = new TextDecoder().decode(head);
  if (/<\s*(script|html|iframe)/i.test(text)) throw bad('Arquivo contém conteúdo ativo não permitido');
  if (f.name.toLowerCase().endsWith('.pdf') && !text.startsWith('%PDF')) throw bad('O conteúdo não corresponde a um PDF');
  if (f.size > 40 * 1024 * 1024) throw new HttpErr(413, 'Arquivo excede o limite permitido');
  let conf = String(form!.get('confidentiality') || 'confidential');
  if (u!.role === 'owner') conf = 'confidential';
  let group = String(form!.get('group_id') || '') || null, version = 1;
  if (group) {
    const prev = T('land_documents').filter((d) => d.group_id === group && d.opportunity_id === o.id);
    if (!prev.length) throw nf('Documento');
    version = Math.max(...prev.map((d) => d.version)) + 1;
    prev.forEach((d) => (d.is_current = false));
  } else group = uuid();
  const d = ins('land_documents', { opportunity_id: o.id, group_id: group, version, is_current: true, category: String(form!.get('category')), title: String(form!.get('title') || f.name),
    confidentiality: conf, storage_key: 'demo', mime: f.type || 'application/octet-stream', original_name: f.name, size: f.size, sha256: '(calculado no servidor)',
    valid_until: String(form!.get('valid_until') || '') || null, uploaded_by: u!.id });
  objectUrls.set(d.id, URL.createObjectURL(f));
  audit(u, 'upload', 'land_documents', d.id, { opportunity_id: o.id, title: d.title, version, confidentiality: conf });
  return { __status: 201, ...d };
});
on('PATCH', '/api/opportunities/:id/documents/:docId', ({ u, params, body }) => {
  need(u, 'document', 'update'); const o = getOpp(u, params.id, 'update');
  const d = one('land_documents', (x) => x.id === params.docId && x.opportunity_id === o.id);
  if (!d) throw nf('Documento');
  upd(d, body); audit(u, 'update', 'land_documents', d.id, body); return { ok: true };
});
on('GET', '/api/opportunities/:id/documents/:groupId/versions', ({ u, params }) => {
  need(u, 'document', 'read'); const o = getOpp(u, params.id);
  return { items: T('land_documents').filter((d) => d.opportunity_id === o.id && d.group_id === params.groupId).sort((a, b) => b.version - a.version) };
});
on('GET', '/api/documents/:docId/url', ({ u, params }) => {
  need(u, 'document', 'read');
  const d = one('land_documents', (x) => x.id === params.docId);
  if (!d) throw nf('Documento');
  getOpp(u, d.opportunity_id);
  if (!DOC_VISIBILITY[u!.role].includes(d.confidentiality)) throw nf('Documento');
  audit(u, 'document.access', 'land_documents', d.id, { opportunity_id: d.opportunity_id });
  return fileUrl(d);
});
on('POST', '/api/opportunities/:id/assignments', ({ u, params, body: b }) => {
  need(u, 'routing', 'update'); const o = getOpp(u, params.id, 'update');
  const br = one('land_brokers', (x) => x.id === b.broker_id && x.org_id === u!.orgId && x.active);
  if (!br) throw nf('Intermediador');
  const role = b.role ?? 'primary';
  T('broker_assignments').filter((a) => a.opportunity_id === o.id && a.active && (a.role === role && role === 'primary' || a.broker_id === b.broker_id))
    .forEach((a) => upd(a, { active: false, ended_at: now(), reason: a.reason ?? b.reason ?? 'Substituição' }));
  ins('broker_assignments', { opportunity_id: o.id, broker_id: b.broker_id, role, active: true, assigned_by: u!.id, reason: b.reason ?? null, ended_at: null });
  audit(u, 'assign', 'broker_assignments', o.id, b);
  return { __status: 201, ok: true };
});
on('GET', '/api/opportunities/:id/assignments/history', ({ u, params }) => {
  need(u, 'opportunity', 'read'); const o = getOpp(u, params.id);
  return { items: T('broker_assignments').filter((a) => a.opportunity_id === o.id).map((a) => {
    const b = one('land_brokers', (x) => x.id === a.broker_id)!;
    return { ...a, broker_name: one('users', (x) => x.id === b.user_id)!.name, assigned_by_name: one('users', (x) => x.id === a.assigned_by)?.name };
  }).sort((a, b) => b.created_at.localeCompare(a.created_at)) };
});
on('POST', '/api/opportunities/:id/submit-review', ({ u, params }) => {
  need(u, 'publication', 'create'); const o = getOpp(u, params.id, 'update');
  const missing = publicationChecklist(o, rel(o.id));
  if (missing.length) throw bad('Há pendências para publicação', { missing });
  upd(o, { publication_status: 'pending_review', version: o.version + 1 });
  upd(rel(o.id).pub!, { submitted_by: u!.id, submitted_at: now(), review_notes: null });
  audit(u, 'publication.submit', 'land_opportunities', o.id);
  return { publication_status: 'pending_review' };
});
on('POST', '/api/opportunities/:id/review', ({ u, params, body: b }) => {
  need(u, 'publication', 'approve'); const o = getOpp(u, params.id, 'update');
  if (o.publication_status !== 'pending_review') throw conflict('A área não está aguardando aprovação');
  if (b.decision === 'approve') { const m = publicationChecklist(o, rel(o.id)); if (m.length) throw bad('Há pendências para publicação', { missing: m }); }
  const status = b.decision === 'approve' ? 'published' : 'rejected';
  upd(o, { publication_status: status, published_at: status === 'published' ? now() : o.published_at, version: o.version + 1,
    status: status === 'published' && ['captacao', 'analise', 'qualificada'].includes(o.status) ? 'disponivel' : o.status });
  upd(rel(o.id).pub!, { reviewed_by: u!.id, reviewed_at: now(), review_notes: b.notes ?? null });
  audit(u, `publication.${b.decision}`, 'land_opportunities', o.id, { notes: b.notes });
  if (status === 'published') recomputeOpp(o);
  return { publication_status: status };
});
on('POST', '/api/opportunities/:id/unpublish', ({ u, params }) => {
  need(u, 'publication', 'approve'); const o = getOpp(u, params.id, 'update');
  upd(o, { publication_status: 'unpublished', version: o.version + 1 }); audit(u, 'publication.unpublish', 'land_opportunities', o.id);
  return { publication_status: 'unpublished' };
});
on('POST', '/api/opportunities/:id/favorite', ({ u, params }) => { const o = getOpp(u, params.id); if (!T('favorites').some((f) => f.user_id === u!.id && f.opportunity_id === o.id)) T('favorites').push({ user_id: u!.id, opportunity_id: o.id }); return { favorite: true }; });
on('DELETE', '/api/opportunities/:id/favorite', ({ u, params }) => { const o = getOpp(u, params.id); S.favorites = T('favorites').filter((f) => !(f.user_id === u!.id && f.opportunity_id === o.id)); return { favorite: false }; });

// ---------------------------------------------------------------- interesses

on('GET', '/api/interests', ({ u, q }) => {
  need(u, 'interest', 'read');
  let l = T('opportunity_interests').filter((i) => interestVisible(u!, i));
  if (q.get('status')) l = l.filter((i) => csv(q.get('status')).includes(i.status));
  if (q.get('opportunity_id')) l = l.filter((i) => i.opportunity_id === q.get('opportunity_id'));
  const breached = (i: Row) => !i.first_response_at && i.sla_due_at && new Date(i.sla_due_at) < new Date() && i.status !== 'discarded';
  if (q.get('overdue') === '1') l = l.filter((i) => breached(i) && i.name);
  return { items: l.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 300).map((i) => {
    const o = one('land_opportunities', (x) => x.id === i.opportunity_id)!;
    const b = i.broker_id && one('land_brokers', (x) => x.id === i.broker_id);
    return { ...i, code: o.code, public_title: o.public_title, internal_name: o.internal_name, city: o.city, uf: o.uf, broker_name: b ? one('users', (x) => x.id === b.user_id)!.name : null, sla_breached: breached(i) };
  }) };
});
function getInterest(u: U | null, id: string, action: Action) {
  need(u, 'interest', action);
  const i = one('opportunity_interests', (x) => x.id === id);
  if (!i || !interestVisible(u!, i)) throw nf('Interesse');
  return i;
}
on('GET', '/api/interests/inbound/unlinked', ({ u }) => { need(u, 'routing', 'read'); return { items: T('whatsapp_inbound').filter((m) => m.org_id === u!.dataOrgId && m.link_status === 'unlinked') }; });
on('POST', '/api/interests/inbound/:id/link', ({ u, params, body }) => {
  need(u, 'routing', 'update');
  const m = one('whatsapp_inbound', (x) => x.id === params.id); const i = one('opportunity_interests', (x) => x.id === body.interest_id);
  if (!m || !i) throw nf();
  upd(m, { interest_id: i.id, link_status: 'linked_manual' });
  ins('interest_events', { interest_id: i.id, type: 'message_received', user_id: u!.id, payload: { manual: true } });
  if (['clicked', 'form_submitted'].includes(i.status)) upd(i, { status: 'message_received' });
  audit(u, 'whatsapp.link_manual', 'whatsapp_inbound', m.id, { interest_id: i.id });
  return { ok: true };
});
on('GET', '/api/interests/:id', ({ u, params }) => {
  const i = getInterest(u, params.id, 'read');
  return { ...i, events: T('interest_events').filter((e) => e.interest_id === i.id).map((e) => ({ ...e, user_name: one('users', (x) => x.id === e.user_id)?.name })).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    inbound: T('whatsapp_inbound').filter((m) => m.interest_id === i.id) };
});
on('POST', '/api/interests/:id/first-response', ({ u, params }) => {
  const i = getInterest(u, params.id, 'update');
  if (i.first_response_at) throw conflict('Primeiro atendimento já registrado');
  upd(i, { first_response_at: now(), status: i.status === 'clicked' ? 'qualified' : i.status });
  ins('interest_events', { interest_id: i.id, type: 'first_response', user_id: u!.id, payload: {} });
  return { ok: true };
});
on('POST', '/api/interests/:id/reassign', ({ u, params, body: b }) => {
  need(u, 'routing', 'update'); const i = getInterest(u, params.id, 'update');
  if (!b.reason || b.reason.length < 3) throw bad('Informe o motivo');
  const br = b.broker_id ? one('land_brokers', (x) => x.id === b.broker_id) : null;
  const name = br ? one('users', (x) => x.id === br.user_id)!.name : 'Atendimento Quero Área';
  const number = br ? normalizePhone(br.whatsapp) : normalizePhone(one('organizations', (x) => x.id === i.org_id)!.central_whatsapp);
  ins('interest_events', { interest_id: i.id, type: 'reassigned', user_id: u!.id, payload: { from: i.broker_id, to: b.broker_id, to_name: name, reason: b.reason } });
  upd(i, { broker_id: b.broker_id, routed_to_number: number, routed_via: 'transferência manual' });
  if (i.negotiation_id && b.broker_id && !T('negotiation_participants').some((p) => p.negotiation_id === i.negotiation_id && p.broker_id === b.broker_id))
    T('negotiation_participants').push({ negotiation_id: i.negotiation_id, broker_id: b.broker_id, role: 'intermediador' });
  audit(u, 'interest.reassign', 'opportunity_interests', i.id, b);
  return { ok: true, routed_to: name };
});
on('POST', '/api/interests/:id/discard', ({ u, params, body }) => {
  const i = getInterest(u, params.id, 'update');
  upd(i, { status: 'discarded' }); ins('interest_events', { interest_id: i.id, type: 'discarded', user_id: u!.id, payload: body });
  return { ok: true };
});
on('POST', '/api/interests/:id/convert', ({ u, params, body: b }) => {
  const i = getInterest(u, params.id, 'update');
  if (i.negotiation_id) throw conflict('Interesse já possui negociação');
  const phone = normalizePhone(b.phone);
  const cid = crmUpsertContact(i.org_id, { name: b.name, email: b.email || null, phone, tags: ['dourado-land'] });
  const n = ins('negotiations', { org_id: i.org_id, opportunity_id: i.opportunity_id, interest_id: i.id, partner_company_id: b.partner_company_id ?? null, contact_name: b.name,
    contact_email: b.email || null, contact_phone: phone, owner_id: u!.id, stage: 'interesse_recebido', status: 'open', version: 1, crm_contact_id: cid });
  if (i.broker_id) T('negotiation_participants').push({ negotiation_id: n.id, broker_id: i.broker_id, role: 'intermediador' });
  upd(i, { name: b.name, email: b.email || null, phone, legal_basis: b.legal_basis, crm_contact_id: cid, crm_sync_status: 'synced', status: 'qualified', negotiation_id: n.id });
  audit(u, 'interest.convert', 'opportunity_interests', i.id, { negotiation_id: n.id });
  return { __status: 201, ...n };
});

/** Simula o webhook oficial do WhatsApp: a pessoa enviou a mensagem com o código (ou sem ele). */
export function simulateWhatsApp(token: string | null, text?: string) {
  const i = token ? one('opportunity_interests', (x) => x.intent_token === token) : null;
  const from = '5562977776666';
  const msgText = text ?? (i ? `Olá! Tenho interesse... Referência: ${i.intent_token}.` : 'Oi, vi um terreno no site, ainda está disponível?');
  const tok = INTENT_TOKEN_RE.exec(msgText.toUpperCase())?.[1];
  const linked = tok ? one('opportunity_interests', (x) => x.intent_token === tok) : null;
  const org = linked?.org_id ?? one('organizations', (x) => x.kind === 'manager')!.id;
  const m = ins('whatsapp_inbound', { org_id: org, wa_message_id: `wamid.demo.${uuid()}`, from_masked: maskPhone(from), to_number: linked?.routed_to_number ?? null, text: msgText,
    interest_id: linked?.id ?? null, link_status: linked ? 'linked_token' : 'unlinked', received_at: now() });
  if (linked) {
    if (!T('whatsapp_inbound').some((x) => x.interest_id === linked.id && x.id !== m.id)) ins('interest_events', { interest_id: linked.id, type: 'conversation_started', payload: { from: maskPhone(from) } });
    ins('interest_events', { interest_id: linked.id, type: 'message_received', payload: { token: tok, from: maskPhone(from) } });
    if (['clicked', 'form_submitted', 'conversation_started'].includes(linked.status)) upd(linked, { status: 'message_received' });
    if (!linked.phone) upd(linked, { phone: from });
    if (linked.negotiation_id) ins('activities', { org_id: linked.org_id, negotiation_id: linked.negotiation_id, opportunity_id: linked.opportunity_id, type: 'whatsapp', subject: 'Mensagem recebida no WhatsApp', body: msgText });
  }
  save();
  return { linked: !!linked, token: tok ?? null };
}
export function lastInterestToken() {
  return [...T('opportunity_interests')].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.intent_token ?? null;
}

// ---------------------------------------------------------------- negociações

const STAGES = Object.keys(NEGOTIATION_STAGES) as NegotiationStage[];
on('GET', '/api/negotiations', ({ u, q }) => {
  need(u, 'negotiation', 'read');
  let l = T('negotiations').filter((n) => negVisible(u!, n));
  if (q.get('stage')) l = l.filter((n) => csv(q.get('stage')).includes(n.stage));
  l = l.filter((n) => (q.get('status') ? csv(q.get('status')) : ['open']).includes(n.status));
  if (q.get('opportunity_id')) l = l.filter((n) => n.opportunity_id === q.get('opportunity_id'));
  const showValue = can(u, 'proposal', 'read');
  return { stages: NEGOTIATION_STAGES, items: l.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((n) => {
    const o = one('land_opportunities', (x) => x.id === n.opportunity_id)!;
    return { ...n, proposed_value: showValue ? n.proposed_value : null, code: o.code, public_title: o.public_title, internal_name: o.internal_name, city: o.city, uf: o.uf, area_m2: o.area_m2,
      partner_name: one('partner_companies', (p) => p.id === n.partner_company_id)?.name ?? null, owner_name: one('users', (x) => x.id === n.owner_id)?.name ?? null,
      proposal_count: T('proposals').filter((p) => p.negotiation_id === n.id).length,
      brokers: T('negotiation_participants').filter((p) => p.negotiation_id === n.id).map((p) => one('users', (x) => x.id === one('land_brokers', (b) => b.id === p.broker_id)?.user_id)?.name).join(', ') || null };
  }) };
});
on('POST', '/api/negotiations', ({ u, body: b }) => {
  need(u, 'negotiation', 'create');
  const o = getOpp(u, b.opportunity_id);
  if (!b.contact_name) throw bad('Informe o contato');
  const n = ins('negotiations', { org_id: u!.dataOrgId, opportunity_id: o.id, partner_company_id: b.partner_company_id ?? null, contact_name: b.contact_name, contact_email: b.contact_email || null,
    contact_phone: normalizePhone(b.contact_phone), stage: b.stage ?? 'interesse_recebido', status: 'open', owner_id: u!.id, version: 1, crm_deal_id: `emb_deal_${uuid().slice(0, 8)}` });
  if (u!.brokerId) T('negotiation_participants').push({ negotiation_id: n.id, broker_id: u!.brokerId, role: 'intermediador' });
  ins('activities', { org_id: n.org_id, opportunity_id: o.id, negotiation_id: n.id, type: 'system', subject: 'Negociação criada', user_id: u!.id });
  audit(u, 'create', 'negotiations', n.id, { opportunity_id: o.id });
  return { __status: 201, ...n };
});
function commissionsFor(u: U, nid: string) {
  const s = grant(u.role, 'commission', 'read');
  if (!s) return [];
  return T('commissions').filter((c) => c.negotiation_id === nid && (s !== 'own' || c.broker_id === u.brokerId)).map((c) => {
    const b = c.broker_id && one('land_brokers', (x) => x.id === c.broker_id);
    return { ...c, broker_name: b ? one('users', (x) => x.id === b.user_id)?.name : null };
  });
}
on('GET', '/api/negotiations/:id', ({ u, params }) => {
  const n = getNeg(u, params.id);
  const o = one('land_opportunities', (x) => x.id === n.opportunity_id)!;
  const props = can(u, 'proposal', 'read') ? T('proposals').filter((p) => p.negotiation_id === n.id).sort((a, b) => b.created_at.localeCompare(a.created_at)) : [];
  return {
    ...n, opportunity: { id: o.id, code: o.code, slug: o.slug, public_title: o.public_title, internal_name: o.internal_name, city: o.city, uf: o.uf, area_m2: o.area_m2, status: o.status },
    partner: one('partner_companies', (p) => p.id === n.partner_company_id) ?? null,
    participants: T('negotiation_participants').filter((p) => p.negotiation_id === n.id).map((p) => { const b = one('land_brokers', (x) => x.id === p.broker_id)!; return { id: b.id, name: one('users', (x) => x.id === b.user_id)!.name, role: p.role, creci: b.creci, creci_status: b.creci_status }; }),
    activities: T('activities').filter((a) => a.negotiation_id === n.id).map((a) => ({ ...a, user_name: one('users', (x) => x.id === a.user_id)?.name })).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    proposals: props.map((p) => ({ ...p,
      versions: T('proposal_versions').filter((v) => v.proposal_id === p.id).map((v) => ({ ...v, author: one('users', (x) => x.id === v.created_by)?.name })).sort((a, b) => b.version - a.version),
      approvals: T('proposal_approvals').filter((a) => a.proposal_id === p.id).map((a) => ({ ...a, approver: one('users', (x) => x.id === a.approver_id)?.name })) })),
    commissions: commissionsFor(u!, n.id),
    permissions: { update: can(u, 'negotiation', 'update'), propose: can(u, 'proposal', 'create'), approve: can(u, 'proposal', 'approve'), commission: can(u, 'commission', 'update') },
  };
});
on('PATCH', '/api/negotiations/:id', ({ u, params, body: b }) => {
  const n = getNeg(u, params.id, 'update');
  if (n.version !== b.version) throw conflict('Negociação alterada por outra pessoa. Recarregue.', { current_version: n.version });
  if ((b.status === 'lost' || b.status === 'suspended') && !b.lost_reason) throw bad('Informe o motivo de perda ou suspensão');
  if (b.status === 'won' && (b.stage ?? n.stage) !== 'conclusao') throw bad('Uma negociação só é concluída na etapa Conclusão');
  const { version, ...patch } = b; void version;
  if (b.stage && b.stage !== n.stage) {
    ins('activities', { org_id: n.org_id, opportunity_id: n.opportunity_id, negotiation_id: n.id, type: 'stage_change', subject: `${NEGOTIATION_STAGES[n.stage as NegotiationStage]} → ${NEGOTIATION_STAGES[b.stage as NegotiationStage]}`, user_id: u!.id });
    if (STAGES.indexOf(b.stage) >= STAGES.indexOf('proposta')) { const o = one('land_opportunities', (x) => x.id === n.opportunity_id)!; if (['disponivel', 'qualificada'].includes(o.status)) upd(o, { status: 'em_negociacao' }); }
  }
  if (b.status && b.status !== n.status) ins('activities', { org_id: n.org_id, opportunity_id: n.opportunity_id, negotiation_id: n.id, type: 'system', subject: `Status: ${b.status}${b.lost_reason ? ` — ${b.lost_reason}` : ''}`, user_id: u!.id });
  upd(n, { ...patch, version: n.version + 1 });
  audit(u, 'update', 'negotiations', n.id, patch);
  return { version: n.version };
});
on('POST', '/api/negotiations/:id/participants', ({ u, params, body }) => {
  need(u, 'routing', 'update'); const n = getNeg(u, params.id, 'update');
  if (!T('negotiation_participants').some((p) => p.negotiation_id === n.id && p.broker_id === body.broker_id)) T('negotiation_participants').push({ negotiation_id: n.id, broker_id: body.broker_id, role: body.role ?? 'intermediador' });
  return { __status: 201, ok: true };
});
on('POST', '/api/negotiations/:id/activities', ({ u, params, body: b }) => {
  const n = getNeg(u, params.id, 'update');
  if (!b.subject || b.subject.length < 2) throw bad('Informe o assunto');
  const a = ins('activities', { org_id: n.org_id, opportunity_id: n.opportunity_id, negotiation_id: n.id, type: b.type, subject: b.subject, body: b.body || null, due_at: b.due_at ?? null,
    done_at: b.done || !b.due_at ? now() : null, user_id: u!.id, crm_activity_id: `emb_act_${uuid().slice(0, 8)}` });
  if (n.interest_id) { const i = one('opportunity_interests', (x) => x.id === n.interest_id); if (i && !i.first_response_at) upd(i, { first_response_at: now() }); }
  if (b.due_at) upd(n, { next_activity: b.subject, next_activity_at: b.due_at });
  return { __status: 201, ...a };
});
on('POST', '/api/negotiations/activities/:aid/done', ({ u, params }) => {
  const a = one('activities', (x) => x.id === params.aid);
  if (!a?.negotiation_id) throw nf('Atividade');
  getNeg(u, a.negotiation_id, 'update'); upd(a, { done_at: now() });
  return { ok: true };
});
on('POST', '/api/negotiations/:id/proposals', ({ u, params, body: b }) => {
  need(u, 'proposal', 'create'); const n = getNeg(u, params.id);
  if (u!.role === 'buyer' && b.side !== 'comprador') throw forb();
  const p = ins('proposals', { org_id: n.org_id, negotiation_id: n.id, opportunity_id: n.opportunity_id, current_version: 1, status: 'submitted', created_by: u!.id });
  const { side = 'comprador', ...v } = b;
  ins('proposal_versions', { proposal_id: p.id, version: 1, side, ...v, created_by: u!.id });
  upd(n, { proposed_value: b.acquisition_value ?? n.proposed_value, stage: STAGES.indexOf(n.stage) < STAGES.indexOf('proposta') ? 'proposta' : n.stage });
  ins('activities', { org_id: n.org_id, opportunity_id: n.opportunity_id, negotiation_id: n.id, type: 'system', subject: 'Proposta registrada (v1)', user_id: u!.id });
  audit(u, 'create', 'proposals', p.id, { negotiation_id: n.id });
  return { __status: 201, ...p };
});
function getProposal(u: U | null, pid: string, action: Action) {
  const p = one('proposals', (x) => x.id === pid);
  if (!p) throw nf('Proposta');
  getNeg(u, p.negotiation_id); need(u, 'proposal', action);
  return p;
}
on('POST', '/api/proposals/:pid/versions', ({ u, params, body: b }) => {
  const p = getProposal(u, params.pid, 'create');
  if (u!.role === 'buyer' && b.side !== 'comprador') throw forb();
  if (['accepted', 'rejected', 'expired'].includes(p.status)) throw conflict('Proposta encerrada');
  const version = p.current_version + 1;
  const { side, ...v } = b;
  ins('proposal_versions', { proposal_id: p.id, version, side, ...v, created_by: u!.id });
  upd(p, { current_version: version, status: side === 'vendedor' ? 'countered' : 'submitted' });
  ins('activities', { org_id: p.org_id, opportunity_id: p.opportunity_id, negotiation_id: p.negotiation_id, type: 'system', subject: `${side === 'vendedor' ? 'Contraproposta' : 'Nova versão da proposta'} (v${version})`, user_id: u!.id });
  audit(u, 'version', 'proposals', p.id, { version, side });
  return { __status: 201, version };
});
on('POST', '/api/proposals/:pid/internal-review', ({ u, params }) => { const p = getProposal(u, params.pid, 'update'); upd(p, { status: 'internal_review' }); return { status: 'internal_review' }; });
on('POST', '/api/proposals/:pid/approval', ({ u, params, body }) => {
  need(u, 'proposal', 'approve'); const p = getProposal(u, params.pid, 'read');
  ins('proposal_approvals', { proposal_id: p.id, version: p.current_version, approver_id: u!.id, decision: body.decision, comment: body.comment ?? null });
  upd(p, { status: body.decision === 'approved' ? 'approved_internal' : 'internal_review' });
  audit(u, `proposal.${body.decision}`, 'proposals', p.id, { version: p.current_version });
  return { ok: true };
});
on('POST', '/api/proposals/:pid/status', ({ u, params, body }) => {
  need(u, 'proposal', 'update'); const p = getProposal(u, params.pid, 'update');
  if (body.status === 'accepted' && p.status !== 'approved_internal' && !can(u, 'proposal', 'approve')) throw bad('Aceite exige aprovação interna da versão atual');
  upd(p, { status: body.status });
  ins('activities', { org_id: p.org_id, opportunity_id: p.opportunity_id, negotiation_id: p.negotiation_id, type: 'system', subject: `Proposta v${p.current_version}: ${body.status}`, user_id: u!.id });
  audit(u, `proposal.${body.status}`, 'proposals', p.id);
  return { ok: true };
});
on('POST', '/api/negotiations/:id/commissions', ({ u, params, body: b }) => {
  need(u, 'commission', 'create'); const n = getNeg(u, params.id, 'update');
  if (b.broker_id) { const br = one('land_brokers', (x) => x.id === b.broker_id); if (!br) throw nf('Intermediador'); if (!['ativo', 'nao_aplicavel'].includes(br.creci_status)) throw bad('Intermediador sem habilitação profissional validada (CRECI)'); }
  const c = ins('commissions', { ...b, org_id: n.org_id, negotiation_id: n.id, opportunity_id: n.opportunity_id, status: 'prevista', history: [{ to: 'prevista', at: now(), by: u!.name }] });
  audit(u, 'create', 'commissions', c.id, b);
  return { __status: 201, ...c };
});
on('POST', '/api/proposals/commissions/:cid/transition', ({ u, params, body: b }) => {
  need(u, 'commission', 'update');
  const c = one('commissions', (x) => x.id === params.cid && x.org_id === u!.dataOrgId);
  if (!c) throw nf('Comissão');
  const n = one('negotiations', (x) => x.id === c.negotiation_id)!;
  const allowed: Record<string, string[]> = { prevista: ['contratada', 'cancelada'], contratada: ['exigivel', 'cancelada'], exigivel: ['paga', 'cancelada'], paga: [], cancelada: [] };
  if (!allowed[c.status].includes(b.to)) throw conflict(`Transição ${c.status} → ${b.to} não permitida`);
  const patch: Row = { status: b.to };
  if (b.to === 'contratada') {
    const doc = b.contract_document_id && one('land_documents', (d) => d.id === b.contract_document_id && d.opportunity_id === c.opportunity_id && d.category === 'contrato_intermediacao');
    if (!doc) throw bad('Vincule o contrato de intermediação (documento da área, categoria "Contrato de intermediação")');
    patch.contract_document_id = doc.id;
  }
  if (b.to === 'exigivel') { if (!['contrato', 'conclusao'].includes(n.stage)) throw bad('A comissão só se torna exigível com a negociação em Contrato ou Conclusão'); if (!b.note) throw bad('Descreva o evento contratual'); patch.due_at = b.due_at ?? null; }
  if (b.to === 'paga') { if (!b.paid_at) throw bad('Informe a data de pagamento'); patch.paid_at = b.paid_at; }
  if (b.to === 'cancelada' && !b.note) throw bad('Informe a justificativa');
  patch.history = [...(c.history ?? []), { from: c.status, to: b.to, at: now(), by: u!.name, note: b.note }];
  upd(c, patch); audit(u, `commission.${b.to}`, 'commissions', c.id, b);
  return { status: b.to };
});

// ---------------------------------------------------------------- compradores e matching

on('GET', '/api/partners', ({ u }) => {
  const s = need(u, 'partner', 'read');
  return { items: T('partner_companies').filter((p) => p.org_id === u!.dataOrgId && (s !== 'own' || u!.partnerCompanyIds.includes(p.id))).sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({
    ...p, profiles: T('acquisition_profiles').filter((x) => x.partner_company_id === p.id).length, open_negotiations: T('negotiations').filter((n) => n.partner_company_id === p.id && n.status === 'open').length })) };
});
on('POST', '/api/partners', ({ u, body }) => { need(u, 'partner', 'create'); if (!body.name) throw bad('Informe o nome'); const p = ins('partner_companies', { ...body, org_id: u!.dataOrgId }); return { __status: 201, ...p }; });
on('PATCH', '/api/partners/:id', ({ u, params, body }) => { need(u, 'partner', 'update'); const p = one('partner_companies', (x) => x.id === params.id); if (!p) throw nf('Empresa'); upd(p, body); return { ok: true }; });
function profiles(u: U, action: Action) {
  const s = need(u, 'profile', action);
  return T('acquisition_profiles').filter((p) => p.org_id === u.dataOrgId && (s !== 'own' || u.partnerCompanyIds.includes(p.partner_company_id)));
}
on('GET', '/api/profiles', ({ u }) => ({ items: profiles(u!, 'read').map((p) => { const pc = one('partner_companies', (x) => x.id === p.partner_company_id)!; return { ...p, partner_name: pc.name, partner_kind: pc.kind, match_count: T('opportunity_matches').filter((m) => m.profile_id === p.id).length }; }).sort((a, b) => b.updated_at.localeCompare(a.updated_at)) }));
on('POST', '/api/profiles', ({ u, body }) => {
  const s = need(u, 'profile', 'create');
  if (s === 'own' && !u!.partnerCompanyIds.includes(body.partner_company_id)) throw forb();
  if (!one('partner_companies', (x) => x.id === body.partner_company_id)) throw nf('Empresa');
  const p = ins('acquisition_profiles', { ...body, org_id: u!.dataOrgId, active: true });
  recomputeProfile(p); audit(u, 'create', 'acquisition_profiles', p.id, { name: p.name });
  return { __status: 201, ...p };
});
on('PATCH', '/api/profiles/:id', ({ u, params, body }) => { const p = profiles(u!, 'update').find((x) => x.id === params.id); if (!p) throw nf('Perfil'); upd(p, body); recomputeProfile(p); return { ok: true }; });
on('DELETE', '/api/profiles/:id', ({ u, params }) => { const p = profiles(u!, 'delete').find((x) => x.id === params.id); if (!p) throw nf('Perfil'); S.acquisition_profiles = T('acquisition_profiles').filter((x) => x !== p); S.opportunity_matches = T('opportunity_matches').filter((m) => m.profile_id !== p.id); return { __status: 204 }; });
on('GET', '/api/matches', ({ u, q }) => {
  const s = need(u, 'match', 'read');
  let l = T('opportunity_matches').filter((m) => m.org_id === u!.dataOrgId && m.status !== 'dismissed');
  const items = l.map((m) => {
    const o = one('land_opportunities', (x) => x.id === m.opportunity_id)!; const ap = one('acquisition_profiles', (x) => x.id === m.profile_id)!; const p = one('partner_companies', (x) => x.id === ap?.partner_company_id);
    return o && ap && p ? { ...m, code: o.code, slug: o.slug, public_title: o.public_title, internal_name: o.internal_name, city: o.city, uf: o.uf, area_m2: o.area_m2, publication_status: o.publication_status, profile_name: ap.name, partner_name: p.name, partner_id: p.id, _ap: ap, _o: o } : null;
  }).filter(Boolean) as Row[];
  l = items.filter((m) => {
    if (s === 'own' && !(u!.partnerCompanyIds.includes(m._ap.partner_company_id) && m.publication_status === 'published')) return false;
    if (s === 'assigned' && !T('broker_assignments').some((a) => a.opportunity_id === m.opportunity_id && a.active && a.broker_id === u!.brokerId)) return false;
    if (q.get('opportunity_id') && m.opportunity_id !== getOpp(u, q.get('opportunity_id')!).id) return false;
    if (q.get('profile_id') && m.profile_id !== q.get('profile_id')) return false;
    return true;
  });
  return { items: l.sort((a, b) => b.score - a.score).slice(0, 100).map(({ _ap, _o, ...m }) => m) };
});
on('POST', '/api/matches/recompute', ({ u }) => { need(u, 'match', 'create'); const l = T('land_opportunities').filter((o) => o.org_id === u!.dataOrgId); l.forEach(recomputeOpp); return { ok: true, opportunities: l.length }; });
on('PATCH', '/api/matches/:id', ({ u, params, body }) => { need(u, 'match', 'create'); const m = one('opportunity_matches', (x) => x.id === params.id); if (!m) throw nf('Recomendação'); upd(m, { status: body.status }); return { ok: true }; });

// ---------------------------------------------------------------- dashboard

on('GET', '/api/dashboard', ({ u, q }) => {
  need(u, 'dashboard', 'read');
  const org = u!.dataOrgId; const days = Math.min(365, Math.max(7, +(q.get('days') ?? 90)));
  const since = Date.now() - days * 86400000;
  const O = T('land_opportunities').filter((o) => o.org_id === org);
  const I = T('opportunity_interests').filter((i) => i.org_id === org && +new Date(i.created_at) >= since);
  const N = T('negotiations').filter((n) => n.org_id === org);
  const group = (arr: Row[], key: (r: Row) => string, extra?: (r: Row) => number) => {
    const m = new Map<string, { n: number; area: number }>();
    arr.forEach((r) => { const k = key(r); const e = m.get(k) ?? { n: 0, area: 0 }; e.n++; e.area += extra?.(r) ?? 0; m.set(k, e); });
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  };
  const terms = (o: Row) => one('land_commercial_terms', (t) => t.opportunity_id === o.id) ?? {};
  const activeO = O.filter((o) => !['concluida', 'suspensa'].includes(o.status));
  const brokerName = (id: string | null) => { const b = id && one('land_brokers', (x) => x.id === id); return b ? one('users', (x) => x.id === b.user_id)!.name : 'Central'; };
  const weekKey = (d: string) => { const x = new Date(d); const day = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - day); return x.toISOString().slice(0, 10); };
  const weekly = group(I, (i) => weekKey(i.created_at)).map(([week, e]) => ({ week, interests: e.n, identified: I.filter((i) => weekKey(i.created_at) === week && i.name).length })).sort((a, b) => a.week.localeCompare(b.week));
  const C = T('commissions').filter((c) => c.org_id === org);
  const sum = (arr: Row[]) => arr.reduce((s, c) => s + (c.amount ?? 0), 0);
  const in30 = Date.now() + 30 * 86400000;
  const P = T('land_prospects').filter((p) => p.org_id === org);
  const prospects = { open: P.filter((p) => p.status === 'open').length, converted: P.filter((p) => p.status === 'converted' && +new Date(p.updated_at) >= since).length,
    created: P.filter((p) => +new Date(p.created_at) >= since).length, open_area_m2: P.filter((p) => p.status === 'open').reduce((s, p) => s + (p.area_m2 ?? 0), 0) };
  return {
    prospects,
    period_days: days,
    areas: { total: O.length, available: O.filter((o) => o.status === 'disponivel').length, published: O.filter((o) => o.publication_status === 'published').length,
      total_area_m2: O.reduce((s, o) => s + (o.area_m2 ?? 0), 0), new_captures: O.filter((o) => +new Date(o.created_at) >= since).length },
    potential_value: activeO.reduce((s, o) => s + (terms(o).asking_price ?? 0), 0), potential_vgv: activeO.reduce((s, o) => s + (terms(o).vgv_preliminary ?? 0), 0),
    by_uf: group(O, (o) => o.uf, (o) => o.area_m2).map(([uf, e]) => ({ uf, n: e.n, area: e.area })),
    by_modality: group(O.flatMap((o) => (terms(o).modalities ?? []).map((m: string) => ({ m }))), (r) => r.m).map(([modality, e]) => ({ modality, n: e.n })),
    by_status: group(O, (o) => o.status).map(([status, e]) => ({ status, n: e.n })),
    interests: {
      total: I.length, whatsapp_clicks: I.filter((i) => i.kind === 'whatsapp').length, confirmed_conversations: I.filter((i) => ['message_received', 'qualified'].includes(i.status)).length,
      forms: I.filter((i) => i.kind === 'form').length, identified: I.filter((i) => i.name).length,
      by_channel: group(I, (i) => i.channel).map(([channel, e]) => ({ channel, n: e.n })),
      by_broker: group(I, (i) => brokerName(i.broker_id)).map(([broker, e]) => ({ broker, n: e.n })),
      by_city: group(I, (i) => { const o = one('land_opportunities', (x) => x.id === i.opportunity_id)!; return `${o.city}/${o.uf}`; }).slice(0, 8).map(([city, e]) => ({ city, n: e.n })),
      weekly,
    },
    negotiations: { active: N.filter((n) => n.status === 'open').length, by_stage: group(N.filter((n) => n.status === 'open'), (n) => n.stage).map(([stage, e]) => ({ stage, n: e.n })),
      proposals: T('proposals').filter((p) => p.org_id === org && +new Date(p.created_at) >= since).length, won: N.filter((n) => n.status === 'won' && +new Date(n.updated_at) >= since).length },
    commission: u!.role === 'dourado_admin' ? { forecast: sum(C.filter((c) => ['prevista', 'contratada', 'exigivel'].includes(c.status))), realized: sum(C.filter((c) => c.status === 'paga')), receivable: sum(C.filter((c) => c.status === 'exigivel')) } : null,
    alerts: {
      stale: O.filter((o) => Date.now() - +new Date(o.updated_at) > 30 * 86400000 && o.status !== 'concluida').slice(0, 10),
      pending_review: O.filter((o) => o.publication_status === 'pending_review'),
      sla_overdue: T('opportunity_interests').filter((i) => i.org_id === org && !i.first_response_at && i.name && i.status !== 'discarded' && new Date(i.sla_due_at) < new Date()).length,
      expiring_documents: T('land_documents').filter((d) => d.is_current && d.valid_until && +new Date(d.valid_until) >= Date.now() - 86400000 && +new Date(d.valid_until) <= in30 && O.some((o) => o.id === d.opportunity_id))
        .map((d) => ({ id: d.id, title: d.title, valid_until: d.valid_until, code: O.find((o) => o.id === d.opportunity_id)!.code, opportunity_id: d.opportunity_id })),
    },
  };
});

// ---------------------------------------------------------------- administração

on('GET', '/api/admin/users', ({ u }) => {
  const s = need(u, 'user', 'read');
  return { items: T('users').filter((x) => s === 'all' || x.org_id === u!.orgId).map((x) => { const b = one('land_brokers', (y) => y.user_id === x.id); return { ...x, org_name: one('organizations', (o) => o.id === x.org_id)!.name, broker_id: b?.id, creci: b?.creci, creci_uf: b?.creci_uf, creci_status: b?.creci_status, whatsapp: b?.whatsapp }; }).sort((a, b) => a.name.localeCompare(b.name)) };
});
on('GET', '/api/admin/brokers', ({ u }) => {
  need(u, 'opportunity', 'read');
  return { items: T('land_brokers').filter((b) => b.org_id === u!.dataOrgId).map((b) => { const x = one('users', (y) => y.id === b.user_id)!; return { ...b, name: x.name, email: x.email,
    assignments: T('broker_assignments').filter((a) => a.broker_id === b.id && a.active).length,
    interests_30d: T('opportunity_interests').filter((i) => i.broker_id === b.id && Date.now() - +new Date(i.created_at) < 30 * 86400000).length }; }).sort((a, b) => a.name.localeCompare(b.name)) };
});
on('PATCH', '/api/admin/brokers/:id', ({ u, params, body }) => { need(u, 'routing', 'update'); const b = one('land_brokers', (x) => x.id === params.id); if (!b) throw nf('Intermediador'); upd(b, { ...body, ...(body.creci_status && { creci_checked_at: now() }) }); audit(u, 'update', 'land_brokers', b.id, body); return { ok: true }; });
on('GET', '/api/admin/routing-rules', ({ u }) => { need(u, 'routing', 'read'); return { items: T('whatsapp_routing_rules').filter((r) => r.org_id === u!.dataOrgId).sort((a, b) => a.priority - b.priority), central_whatsapp: one('organizations', (o) => o.id === u!.orgId)?.central_whatsapp }; });
on('POST', '/api/admin/routing-rules', ({ u, body }) => { need(u, 'routing', 'create'); if (body.target === 'round_robin' && !body.broker_ids?.length) throw bad('Selecione os intermediadores do rodízio'); const r = ins('whatsapp_routing_rules', { ...body, org_id: u!.dataOrgId }); audit(u, 'create', 'whatsapp_routing_rules', r.id, body); return { __status: 201, ...r }; });
on('PATCH', '/api/admin/routing-rules/:id', ({ u, params, body }) => { need(u, 'routing', 'update'); const r = one('whatsapp_routing_rules', (x) => x.id === params.id); if (!r) throw nf('Regra'); upd(r, body); audit(u, 'update', 'whatsapp_routing_rules', r.id, body); return { ok: true }; });
on('DELETE', '/api/admin/routing-rules/:id', ({ u, params }) => { need(u, 'routing', 'delete'); S.whatsapp_routing_rules = T('whatsapp_routing_rules').filter((x) => x.id !== params.id); return { __status: 204 }; });
on('PUT', '/api/admin/central-whatsapp', ({ u, body }) => { need(u, 'routing', 'update'); upd(one('organizations', (o) => o.id === u!.orgId)!, body); return { ok: true }; });
on('GET', '/api/admin/audit', ({ u, q }) => {
  const s = need(u, 'audit', 'read');
  return { items: T('audit_logs').filter((a) => (s === 'all' || a.org_id === u!.dataOrgId) && (!q.get('entity') || a.entity === q.get('entity'))).slice(-300).reverse().map((a) => ({ ...a, user_name: one('users', (x) => x.id === a.user_id)?.name })) };
});
on('GET', '/api/admin/integrations/status', ({ u }) => {
  need(u, 'integration', 'read');
  return { outbox: [{ status: 'done', n: T('crm_contacts').length }], items: [
    { key: 'demo', name: 'Esta demonstração', status: 'simulated', detail: 'Backend simulado no navegador com as mesmas regras do servidor. Os dados ficam só neste navegador.' },
    { key: 'identity', name: 'WingsBr Identidade (JWT)', status: 'simulated', detail: 'Seletor de perfis de demonstração' },
    { key: 'crm', name: 'WingsBr CRM / Leads Hub', status: 'simulated', detail: 'Contatos gravados em espelho local (modo embutido)' },
    { key: 'whatsapp_link', name: 'WhatsApp — link contextual', status: 'implemented', detail: 'wa.me com mensagem e token de referência' },
    { key: 'whatsapp_webhook', name: 'WhatsApp Business Platform — webhook', status: 'simulated', detail: 'Use "Simular mensagem no WhatsApp" na barra de demonstração' },
    { key: 'postgis', name: 'PostGIS', status: 'simulated', detail: 'Na demonstração, área calculada com turf (esfera); no servidor, PostGIS (elipsoide)' },
    { key: 'maps', name: 'Provedor cartográfico', status: 'pending', detail: 'Base própria (contornos de UF); provedor licenciado configurável' },
    { key: 'storage', name: 'Storage S3', status: 'pending', detail: 'Arquivos enviados ficam só na memória desta página' },
    { key: 'ai', name: 'IA assistiva', status: 'simulated', detail: 'Heurísticas determinísticas' },
    { key: 'territory_sigef', name: 'Imóveis certificados (SIGEF/INCRA)', status: 'simulated', detail: 'Parcelas fictícias; em produção, serviço WFS oficial configurável' },
    { key: 'territory_car', name: 'Cadastro Ambiental Rural (SICAR)', status: 'simulated', detail: 'Imóveis fictícios; em produção, serviço WFS oficial configurável' },
    { key: 'onr', name: 'Mapa do Registro de Imóveis (ONR)', status: 'simulated', detail: 'Sem API pública do ONR: consulta registral via provedor contratado; link direto ao Mapa disponível' },
    { key: 'earth', name: 'Google Earth', status: 'implemented', detail: 'Abrir no Google Earth e exportar KML (na demonstração o KML é copiado)' },
    { key: 'maps3d', name: 'Vista 3D (Google 3D Maps)', status: 'pending', detail: 'Requer chave da Google Maps Platform' },
    { key: 'ga4', name: 'Google Analytics 4 / Meta CAPI', status: 'pending', detail: '' },
    { key: 'esign', name: 'Assinatura eletrônica', status: 'pending', detail: '' },
  ] };
});
on('POST', '/api/privacy/erase', ({ u, body: b }) => {
  need(u, 'interest', 'delete');
  const phone = normalizePhone(b.phone);
  const hit = (e: any, p: any) => (b.email && e === b.email.toLowerCase()) || (phone && p === phone);
  const I = T('opportunity_interests').filter((i) => hit(i.email, i.phone)); I.forEach((i) => upd(i, { name: 'Titular anonimizado', email: null, phone: null, company: null, message: null, attribution: {} }));
  const N = T('negotiations').filter((n) => hit(n.contact_email, n.contact_phone)); N.forEach((n) => upd(n, { contact_name: 'Titular anonimizado', contact_email: null, contact_phone: null }));
  return { interests: I.length, negotiations: N.length };
});

// ---------------------------------------------------------------- IA

on('POST', '/api/ai/opportunities/:id/description', ({ u, params }) => {
  need(u, 'ai', 'create'); const o = getOpp(u, params.id);
  const text = heuristicDescription(o, rel(o.id));
  const s = ins('ai_suggestions', { org_id: o.org_id, opportunity_id: o.id, kind: 'description', content: { text }, origin: 'heuristic', status: 'suggested', requested_by: u!.id });
  return { id: s.id, text, origin: 'heuristic', label: 'Sugestão — revise antes de publicar' };
});
on('GET', '/api/ai/opportunities/:id/gaps', ({ u, params }) => { need(u, 'ai', 'read'); const o = getOpp(u, params.id); return { items: computeGaps(o, rel(o.id)), origin: 'heuristic' }; });
on('POST', '/api/ai/opportunities/:id/whatsapp-message', ({ u, params, body }) => {
  need(u, 'ai', 'create'); const o = getOpp(u, params.id); const r = rel(o.id); const v = publicView(o, r);
  const via = Array.isArray(r.tech.viabilidade?.value) ? r.tech.viabilidade.value.join(', ').replace(/_/g, ' ') : null;
  const area = o.area_m2 >= 10000 ? `${(o.area_m2 / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ha` : `${Math.round(o.area_m2)} m²`;
  const text = `Olá${body.recipient_name ? `, ${body.recipient_name}` : ''}! Aqui é ${u!.name.split(' ')[0]}, da Quero Área. Separei uma oportunidade que pode encaixar no seu perfil: ${o.code} — ${v.title}, ${area} em ${o.city}/${o.uf}${via ? `, com indicação para ${via}` : ''}. Posso te enviar o book com os detalhes?`;
  return { id: uuid(), text, origin: 'heuristic', label: 'Sugestão — revise antes de enviar' };
});
on('POST', '/api/ai/negotiations/:id/summary', ({ u, params }) => {
  need(u, 'ai', 'create'); const n = getNeg(u, params.id);
  const acts = T('activities').filter((a) => a.negotiation_id === n.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const props = T('proposals').filter((p) => p.negotiation_id === n.id).map((p) => ({ p, v: one('proposal_versions', (v) => v.proposal_id === p.id && v.version === p.current_version)! }));
  const brl = (v: number | null) => (v == null ? 'sob consulta' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }));
  const text = [
    `Etapa atual: ${NEGOTIATION_STAGES[n.stage as NegotiationStage]} (${n.status}).`,
    `${acts.length} interações registradas; última em ${acts.at(-1) ? new Date(acts.at(-1)!.created_at).toLocaleDateString('pt-BR') : '—'}.`,
    ...props.map(({ p, v }) => `Proposta v${v.version} (${v.side}, ${p.status}): ${brl(v.acquisition_value)}${v.swap_pct ? `, permuta ${v.swap_pct}%` : ''}.`),
    n.next_activity ? `Próxima atividade: ${n.next_activity}.` : 'Sem próxima atividade definida.',
  ].join('\n');
  return { id: uuid(), text, origin: 'heuristic', label: 'Sugestão gerada a partir dos registros' };
});
on('POST', '/api/ai/search', ({ body }) => searchAi(body.text));
on('POST', '/api/ai/suggestions/:id/:decision', () => ({ ok: true }));


// ---------------------------------------------------------------- captação e dados territoriais (simulados)

function scopedProspects(u: U | null, action: Action) {
  const s = need(u, 'prospect', action);
  return T('land_prospects').filter((p) => p.org_id === u!.dataOrgId && (s !== 'own' || p.created_by === u!.id || p.referred_by_broker_id === u!.brokerId));
}
function getProspectRow(u: U | null, id: string, action: Action = 'read') {
  const p = scopedProspects(u, action).find((x) => x.id === id);
  if (!p) throw nf('Prospecção');
  return p;
}
function demandFor(orgId: string, p: Row) {
  return T('acquisition_profiles').filter((ap) => ap.org_id === orgId && ap.active).map((ap) => {
    const r = scoreMatch({ ...toProfile(ap), modalities: [], max_swap_pct: null, min_approval_stage: null },
      { uf: p.uf, city: p.city, area_m2: p.area_m2, asking_price: p.asking_price_hint, modalities: [], swap_pct: null, tech: p.intended_uses?.length ? { viabilidade: { value: p.intended_uses, validation_status: 'declarado' } } : {} } as any);
    return { profile_id: ap.id, profile: ap.name, partner: one('partner_companies', (x) => x.id === ap.partner_company_id)?.name, score: r.score, criteria: r.criteria, excluded: r.excluded };
  }).filter((d) => !d.excluded && d.score >= 45).sort((a, b) => b.score - a.score);
}
function withScore(p: Row, demand: any[]) {
  const s = prospectScore({ demand, checklist: p.checklist ?? [], hasRegistry: !!(p.matricula || p.sigef_code || p.car_code), hasOwnerContact: !!(p.owner_name && (p.owner_phone || p.owner_email)), hasGeometry: !!p.geometry });
  return { ...p, score: s.score, score_items: s.items };
}
const ringsOf = (g: any): number[][][][] => (g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : []);
function setProspectGeometry(p: Row, input: any) {
  const polys = polygonsOf(input);
  if (!polys.length) throw bad('Nenhum polígono encontrado');
  const geometry = { type: 'MultiPolygon', coordinates: polys.flatMap((x) => (x.type === 'Polygon' ? [x.coordinates] : x.coordinates)) };
  const ring = geometry.coordinates[0][0];
  upd(p, { geometry, area_m2: turfArea({ type: 'Feature', geometry: geometry as any, properties: {} }), lng: ring.reduce((s: number, c: number[]) => s + c[0], 0) / ring.length, lat: ring.reduce((s: number, c: number[]) => s + c[1], 0) / ring.length });
}
function createProspectRow(orgId: string, userId: string | null, b: Row) {
  const year = new Date().getFullYear();
  const max = T('land_prospects').filter((p) => p.org_id === orgId && p.code.startsWith(`CAP-${year}-`)).reduce((m, p) => Math.max(m, +p.code.split('-').pop()), 0);
  const terr = b.territory ?? [];
  const sigef = terr.find((t: any) => t.layer === 'sigef')?.properties;
  const car = terr.find((t: any) => t.layer === 'car')?.properties;
  const p = ins('land_prospects', {
    org_id: orgId, code: `CAP-${year}-${String(max + 1).padStart(4, '0')}`, title: b.title, source: b.source ?? 'prospeccao_ativa', stage: 'identificada', status: 'open', priority: 'media',
    land_type: b.land_type ?? null, uf: b.uf ?? null, city: b.city ?? null, lat: b.lat ?? null, lng: b.lng ?? null, intended_uses: b.intended_uses ?? [], geometry: null, area_m2: null,
    owner_name: b.owner_name || null, owner_phone: normalizePhone(b.owner_phone) ?? (b.owner_phone || null), owner_email: b.owner_email || null, owner_notes: b.notes ?? null,
    legal_basis: b.legal_basis ?? (b.owner_name ? 'legitimo_interesse' : null), sigef_code: sigef?.codigo ?? null, car_code: car?.codigo ?? null,
    matricula: b.registry?.matriculas?.[0] ?? sigef?.matricula ?? null, cns_serventia: b.registry?.cns_serventia ?? sigef?.cns_serventia ?? null, cartorio: b.registry?.cartorio ?? null, ccir: null,
    territory_snapshot: [...terr, ...(b.registry ? [{ layer: 'onr', source: b.registry.source, consulted_at: b.registry.consulted_at, properties: b.registry }] : [])],
    checklist: CAPTURE_CHECKLIST.map((category) => ({ category, status: 'pendente', note: null, updated_at: null })),
    assigned_to: b.assigned_to ?? userId, referred_by_broker_id: b.referred_by_broker_id ?? null, created_by: userId, version: 1, opportunity_id: null,
    next_action: b.owner_name ? 'Primeiro contato com o proprietário' : 'Identificar proprietário', next_action_at: new Date(Date.now() + 2 * 86400000).toISOString(),
  });
  if (b.geojson) setProspectGeometry(p, b.geojson);
  ins('activities', { org_id: orgId, prospect_id: p.id, type: 'system', subject: `Prospecção criada (${PROSPECT_SOURCES[p.source as keyof typeof PROSPECT_SOURCES]})`, body: b.notes ?? null, user_id: userId });
  return p;
}
function territoryFeatures(layer: 'sigef' | 'car', bbox: [number, number, number, number]) {
  const d = demoTerritoryFeatures(layer, bbox);
  return { mode: 'demo', status: 'simulated', too_large: d.tooLarge, consulted_at: now(), features: d.features };
}
function overlap(geometry: any) {
  if (!geometry) return { items: [], message: 'Sem perímetro cadastrado' };
  const all = ringsOf(geometry).flat(2) as unknown as number[][];
  const xs = all.map((c) => c[0]), ys = all.map((c) => c[1]);
  const bbox: [number, number, number, number] = [Math.min(...xs) - 0.002, Math.min(...ys) - 0.002, Math.max(...xs) + 0.002, Math.max(...ys) + 0.002];
  const area = turfArea({ type: 'Feature', geometry, properties: {} });
  const items: any[] = [];
  for (const layer of ['sigef', 'car'] as const) {
    const r = territoryFeatures(layer, bbox);
    for (const f of r.features) {
      let inter = 0;
      for (const poly of ringsOf(geometry)) {
        try { const x = intersect(featureCollection([turfPolygon(poly), turfPolygon(f.geometry.coordinates)])); if (x) inter += turfArea(x); } catch { /* geometria degenerada */ }
      }
      if (inter < 1) continue;
      const pa = turfArea({ type: 'Feature', geometry: f.geometry, properties: {} });
      items.push({ layer, properties: f.properties, geometry: f.geometry, intersection_m2: inter, pct_of_area: (inter / area) * 100, pct_of_parcel: (inter / pa) * 100, consulted_at: r.consulted_at });
    }
  }
  return { mode: 'demo', area_m2: area, items: items.sort((a, b) => b.intersection_m2 - a.intersection_m2) };
}

on('GET', '/api/territory/layers', ({ u }) => {
  need(u, 'territory', 'read');
  return { mode: 'demo', layers: [{ key: 'sigef', name: 'Imóveis certificados (SIGEF/INCRA)', status: 'simulated', official_url: 'https://sigef.incra.gov.br/' }, { key: 'car', name: 'Cadastro Ambiental Rural (SICAR)', status: 'simulated', official_url: 'https://consultapublica.car.gov.br/publico/imoveis/index' }],
    registry: { key: 'onr', name: 'Mapa do Registro de Imóveis (ONR)', status: 'simulated', official_url: 'https://mapa.onr.org.br/' } };
});
on('GET', '/api/territory/features', ({ u, q }) => {
  need(u, 'territory', 'read');
  const b = (q.get('bbox') ?? '').split(',').map(Number);
  if (b.length !== 4 || !b.every(Number.isFinite)) throw bad('bbox inválido');
  return territoryFeatures(q.get('layer') === 'car' ? 'car' : 'sigef', b as any);
});
on('GET', '/api/territory/lookup', ({ u, q }) => {
  need(u, 'territory', 'read');
  const lat = +q.get('lat')!, lng = +q.get('lng')!, d = 0.004;
  const parcels: any[] = [];
  for (const layer of ['sigef', 'car'] as const) {
    const r = territoryFeatures(layer, [lng - d, lat - d, lng + d, lat + d]);
    for (const f of r.features) if (pointInGeometry([lng, lat], f.geometry)) parcels.push({ ...f, consulted_at: r.consulted_at });
  }
  const pr = (parcels.find((p) => p.properties.layer === 'sigef') ?? parcels[0])?.properties;
  const registry = pr ? { source: 'Demonstração — consulta registral fictícia', consulted_at: now(), ficticio: true, matriculas: pr.matricula ? [pr.matricula] : [], cns_serventia: pr.cns_serventia,
    cartorio: pr.cns_serventia ? `Registro de Imóveis fictício (CNS ${pr.cns_serventia})` : null, numero_certificado: pr.layer === 'sigef' ? pr.codigo : null, situacao: pr.situacao } : null;
  const existing = [
    ...T('land_prospects').filter((p) => p.org_id === u!.dataOrgId && p.geometry && pointInGeometry([lng, lat], p.geometry)).map((p) => ({ kind: 'prospect', id: p.id, code: p.code, title: p.title, status: p.status })),
    ...T('land_geometries').filter((g) => g.is_current && pointInGeometry([lng, lat], g.geometry)).map((g) => { const o = one('land_opportunities', (x) => x.id === g.opportunity_id)!; return { kind: 'opportunity', id: o.id, code: o.code, title: o.public_title ?? o.internal_name, status: o.status }; }),
  ];
  return { lat, lng, parcels, registry, links: { onr: 'https://mapa.onr.org.br/', earth: earthUrl(lat, lng), sigef: 'https://sigef.incra.gov.br/', car: 'https://consultapublica.car.gov.br/publico/imoveis/index' }, existing };
});
on('GET', '/api/opportunities/:id/overlap', ({ u, params }) => { need(u, 'territory', 'read'); const o = getOpp(u, params.id); return overlap(rel(o.id).geometry?.geometry); });
on('GET', '/api/opportunities/:id/kml', ({ u, params }) => {
  need(u, 'exact_location', 'read'); const o = getOpp(u, params.id);
  return { __raw: toKml({ name: `${o.code} — ${o.public_title ?? o.internal_name}`, description: `Dourado Real Estate Partners. ${o.city}/${o.uf}, ${formatArea(o.area_m2)}.`, geometry: rel(o.id).geometry?.geometry, point: o.lng != null ? [o.lng, o.lat] : undefined }), __type: 'application/vnd.google-earth.kml+xml' };
});

on('GET', '/api/prospects', ({ u, q }) => {
  let l = scopedProspects(u, 'read');
  l = l.filter((p) => (q.get('status') ? csv(q.get('status')) : ['open']).includes(p.status));
  if (q.get('stage')) l = l.filter((p) => csv(q.get('stage')).includes(p.stage));
  return { stages: PROSPECT_STAGES, sources: PROSPECT_SOURCES, items: l.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((p) => {
    const demand = demandFor(u!.dataOrgId, p);
    return { ...withScore(p, demand), demand_count: demand.length, has_geom: !!p.geometry, c_lat: p.lat, c_lng: p.lng, assigned_name: one('users', (x) => x.id === p.assigned_to)?.name ?? null };
  }) };
});
on('POST', '/api/prospects', ({ u, body: b }) => {
  need(u, 'prospect', 'create');
  if (!b.title || b.title.length < 3) throw bad('Informe o nome da prospecção');
  const extra = u!.role === 'broker' ? { referred_by_broker_id: u!.brokerId, source: 'indicacao_parceiro', assigned_to: null } : {};
  const p = createProspectRow(u!.dataOrgId, u!.id, { ...b, ...extra });
  audit(u, 'create', 'land_prospects', p.id, { title: b.title });
  return { __status: 201, ...p };
});
on('GET', '/api/prospects/:id', ({ u, params }) => {
  const p = getProspectRow(u, params.id);
  const demand = demandFor(u!.dataOrgId, p);
  const broker = p.referred_by_broker_id && one('land_brokers', (b) => b.id === p.referred_by_broker_id);
  return { ...withScore(p, demand), demand,
    activities: T('activities').filter((a) => a.prospect_id === p.id).map((a) => ({ ...a, user_name: one('users', (x) => x.id === a.user_id)?.name })).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    assigned: one('users', (x) => x.id === p.assigned_to) ?? null, referred_by: broker ? { id: broker.id, name: one('users', (x) => x.id === broker.user_id)?.name } : null,
    links: p.lat != null ? { earth: earthUrl(p.lat, p.lng, p.area_m2 ? Math.max(800, Math.sqrt(p.area_m2) * 4) : 2500), onr: 'https://mapa.onr.org.br/' } : null,
    permissions: { update: can(u, 'prospect', 'update'), convert: can(u, 'prospect', 'approve') } };
});
on('PATCH', '/api/prospects/:id', ({ u, params, body: b }) => {
  const p = getProspectRow(u, params.id, 'update');
  if (p.status !== 'open') throw conflict('Prospecção encerrada');
  if (p.version !== b.version) throw conflict('A prospecção foi alterada por outra pessoa. Recarregue.', { current_version: p.version });
  const { version, ...patch } = b; void version;
  if (patch.owner_phone !== undefined) patch.owner_phone = normalizePhone(patch.owner_phone) ?? patch.owner_phone;
  if (b.stage && b.stage !== p.stage) ins('activities', { org_id: p.org_id, prospect_id: p.id, type: 'stage_change', subject: `${PROSPECT_STAGES[p.stage as keyof typeof PROSPECT_STAGES]} → ${PROSPECT_STAGES[b.stage as keyof typeof PROSPECT_STAGES]}`, user_id: u!.id });
  upd(p, { ...patch, version: p.version + 1 });
  return { version: p.version };
});
on('POST', '/api/prospects/:id/geometry/import', async ({ u, params, form }) => {
  getProspectRow(u, params.id, 'update');
  const f = form?.get('file') as File | null;
  if (!f) throw bad('Envie um arquivo');
  return { geojson: await parseGeo(f), source: f.name.split('.').pop()?.toLowerCase() };
});
on('PUT', '/api/prospects/:id/geometry', ({ u, params, body }) => { const p = getProspectRow(u, params.id, 'update'); setProspectGeometry(p, body.geojson); upd(p, { version: p.version + 1 }); return { area_m2: p.area_m2, version: p.version }; });
on('POST', '/api/prospects/:id/activities', ({ u, params, body }) => { const p = getProspectRow(u, params.id, 'update'); const a = ins('activities', { org_id: p.org_id, prospect_id: p.id, ...body, done_at: now(), user_id: u!.id }); upd(p, {}); return { __status: 201, ...a }; });
on('POST', '/api/prospects/:id/discard', ({ u, params, body }) => {
  const p = getProspectRow(u, params.id, 'update');
  upd(p, { status: 'discarded', discard_reason: body.reason, version: p.version + 1 });
  ins('activities', { org_id: p.org_id, prospect_id: p.id, type: 'system', subject: `Prospecção descartada: ${body.reason}`, user_id: u!.id });
  return { ok: true };
});
on('GET', '/api/prospects/:id/overlap', ({ u, params }) => overlap(getProspectRow(u, params.id).geometry));
on('GET', '/api/prospects/:id/kml', ({ u, params }) => {
  const p = getProspectRow(u, params.id);
  return { __raw: toKml({ name: `${p.code} — ${p.title}`, description: `Prospecção Dourado. ${p.city ?? ''}/${p.uf ?? ''}`, geometry: p.geometry, point: p.lng != null ? [p.lng, p.lat] : undefined }), __type: 'application/vnd.google-earth.kml+xml' };
});
on('POST', '/api/prospects/:id/convert', ({ u, params }) => {
  need(u, 'prospect', 'approve'); need(u, 'opportunity', 'create');
  const p = getProspectRow(u, params.id, 'approve');
  if (p.status !== 'open') throw conflict('Prospecção já encerrada');
  const missing = [!p.uf && 'UF', !p.city && 'Cidade', !p.land_type && 'Tipo da área', !p.owner_name && 'Proprietário', !(p.geometry || p.lat != null) && 'Localização ou perímetro'].filter(Boolean);
  if (missing.length) throw bad('Complete a prospecção antes de converter', { missing });
  const org = one('organizations', (x) => x.id === u!.orgId)!;
  const max = T('land_opportunities').filter((o) => o.code.startsWith(`${org.code_prefix}-${p.uf}-`)).reduce((m, o) => Math.max(m, +o.code.split('-').pop()), 0);
  const code = `${org.code_prefix}-${p.uf}-${String(max + 1).padStart(4, '0')}`;
  const o = ins('land_opportunities', { org_id: u!.orgId, code, slug: buildSlug({ code, type: p.land_type, city: p.city }), internal_name: p.title, public_title: null, type: p.land_type, uf: p.uf, city: p.city,
    lat: p.lat, lng: p.lng, area_m2: p.area_m2 ? Math.round(p.area_m2) : null, status: 'captacao', publication_status: 'draft', visibility: 'public', featured: false, draft_step: 1, version: 1, internal_owner_id: u!.id, created_by: u!.id });
  ins('land_commercial_terms', { opportunity_id: o.id, modalities: [], commission_split: [], negotiable: true, exclusivity: false, asking_price: p.asking_price_hint ?? null,
    internal_notes: [`Origem: captação ${p.code}.`, p.matricula && `Matrícula ${p.matricula}.`, p.sigef_code && `SIGEF ${p.sigef_code}.`, p.car_code && `CAR ${p.car_code}.`].filter(Boolean).join(' ') });
  ins('publication_permissions', { opportunity_id: o.id, show_price: false, show_price_per_m2: false, location_precision: 'approximate', show_public_documents: true });
  if (p.geometry) saveGeometry(u!, o, p.geometry, 'draw');
  ins('land_owners', { opportunity_id: o.id, kind: 'pf', name: p.owner_name, email: p.owner_email, phone: p.owner_phone, document: null });
  if (p.intended_uses?.length) ins('land_technical_attributes', { opportunity_id: o.id, key: 'viabilidade', value: p.intended_uses, source: `Captação ${p.code}`, responsible: u!.name, validation_status: 'declarado', consulted_at: now().slice(0, 10) });
  if (p.referred_by_broker_id) ins('broker_assignments', { opportunity_id: o.id, broker_id: p.referred_by_broker_id, role: 'primary', active: true, assigned_by: u!.id, reason: 'Parceiro que indicou a área' });
  upd(p, { status: 'converted', opportunity_id: o.id, stage: 'contratada', version: p.version + 1 });
  ins('activities', { org_id: p.org_id, prospect_id: p.id, opportunity_id: o.id, type: 'system', subject: `Convertida na área ${code}`, user_id: u!.id });
  audit(u, 'prospect.convert', 'land_prospects', p.id, { opportunity_id: o.id, code });
  return { __status: 201, opportunity_id: o.id, code };
});

// ================================================================ instalação do fetch simulado

export function installMockServer() {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const form = init.body instanceof FormData ? init.body : null;
    let body: any = {};
    if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = {}; } }
    const route = routes.find((r) => r.m === method && r.re.test(url.pathname));
    await new Promise((r) => setTimeout(r, 60)); // latência mínima, como numa rede real
    const json = (status: number, data: unknown) => new Response(status === 204 ? null : JSON.stringify(data)
      .replaceAll('"/media/', FRAMED ? '"media/' : '"/media/').replaceAll('"/__data__', '"'), { status, headers: { 'content-type': 'application/json' } });
    if (!route) return json(404, { error: `Rota não disponível na demonstração: ${method} ${url.pathname}` });
    const m = route.re.exec(url.pathname)!;
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      const out = await route.h({ u: userFromToken(headers), params, q: url.searchParams, body, form, method });
      if (method !== 'GET') save();
      if (out?.__raw !== undefined) return new Response(out.__raw, { status: 200, headers: { 'content-type': out.__type } });
      const status = out?.__status ?? 200;
      if (out && typeof out === 'object') delete out.__status;
      return json(status, out);
    } catch (e: any) {
      if (e instanceof HttpErr) return json(e.status, { error: e.message, details: e.details });
      console.error(e);
      return json(500, { error: 'Erro interno na demonstração' });
    }
  };
}

export { PRIVILEGED, slugify };
