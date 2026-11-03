// Vocabulário e regras puras compartilhadas entre servidor e web.

export const LAND_TYPES = {
  gleba: 'Gleba',
  terreno_urbano: 'Terreno urbano',
  area_rural: 'Área rural',
  area_industrial: 'Área industrial',
  area_comercial: 'Área comercial',
  loteamento: 'Área para loteamento',
  incorporacao_vertical: 'Área para incorporação vertical',
  empreendimento_aprovado: 'Empreendimento aprovado',
} as const;
export type LandType = keyof typeof LAND_TYPES;

export const LAND_STATUS = {
  captacao: 'Captação',
  analise: 'Análise',
  qualificada: 'Qualificada',
  disponivel: 'Disponível',
  em_negociacao: 'Em negociação',
  sob_exclusividade: 'Sob exclusividade',
  suspensa: 'Suspensa',
  concluida: 'Concluída',
} as const;
export type LandStatus = keyof typeof LAND_STATUS;

export const PUBLICATION_STATUS = {
  draft: 'Rascunho',
  pending_review: 'Aguardando aprovação',
  published: 'Publicada',
  rejected: 'Devolvida',
  unpublished: 'Despublicada',
} as const;
export type PublicationStatus = keyof typeof PUBLICATION_STATUS;

export const MODALITIES = {
  venda: 'Venda',
  permuta_fisica: 'Permuta física',
  permuta_financeira: 'Permuta financeira',
  parceria: 'Parceria',
  incorporacao: 'Incorporação',
  bts: 'Built to suit',
} as const;
export type Modality = keyof typeof MODALITIES;

export const VIABILITY = {
  habitacao_popular: 'Habitação popular',
  loteamento: 'Loteamento',
  condominio_horizontal: 'Condomínio horizontal',
  verticalizacao: 'Verticalização',
  logistico: 'Logístico',
  industrial: 'Industrial',
  comercial: 'Comercial',
  uso_misto: 'Uso misto',
} as const;
export type Viability = keyof typeof VIABILITY;

/** Estágio de aprovação — ordem importa para o matching (>=). */
export const APPROVAL_STAGES = {
  sem_estudo: 'Sem estudo',
  estudo_preliminar: 'Estudo preliminar',
  diretrizes_emitidas: 'Diretrizes emitidas',
  em_aprovacao: 'Projeto em aprovação',
  aprovado: 'Projeto aprovado',
  licenciado: 'Aprovado e licenciado',
} as const;
export type ApprovalStage = keyof typeof APPROVAL_STAGES;
export const APPROVAL_ORDER = Object.keys(APPROVAL_STAGES) as ApprovalStage[];

export const NEGOTIATION_STAGES = {
  interesse_recebido: 'Interesse recebido',
  apresentacao: 'Apresentação',
  analise_viabilidade: 'Análise de viabilidade',
  proposta: 'Proposta',
  negociacao: 'Negociação',
  due_diligence: 'Due diligence',
  contrato: 'Contrato',
  conclusao: 'Conclusão',
} as const;
export type NegotiationStage = keyof typeof NEGOTIATION_STAGES;

export const VALIDATION_STATUS = {
  nao_verificado: 'Não verificado',
  declarado: 'Declarado pelo proprietário',
  verificado: 'Verificado pela equipe',
  oficial: 'Documento oficial',
} as const;
export type ValidationStatus = keyof typeof VALIDATION_STATUS;

export const CONFIDENTIALITY = {
  public: 'Público',
  internal: 'Interno',
  confidential: 'Confidencial',
  restricted: 'Restrito à negociação',
} as const;
export type Confidentiality = keyof typeof CONFIDENTIALITY;

export const DOC_CATEGORIES = {
  matricula: 'Matrícula atualizada',
  certidao: 'Certidão',
  iptu_itr: 'IPTU / ITR',
  ccir_car: 'CCIR / CAR',
  planta: 'Planta / levantamento topográfico',
  geo: 'Arquivo geográfico (KML, KMZ, GeoJSON, SHP)',
  estudo_urbanistico: 'Estudo urbanístico',
  estudo_ambiental: 'Estudo ambiental',
  viabilidade: 'Estudo de viabilidade',
  projeto: 'Projeto arquitetônico',
  contrato_intermediacao: 'Contrato de intermediação',
  authorization: 'Autorização de divulgação',
  proposta: 'Proposta',
  minuta: 'Minuta',
  outro: 'Outro',
} as const;
export type DocCategory = keyof typeof DOC_CATEGORIES;

/** Parâmetros técnicos padronizados (seção 4.2). Cada um guarda fonte, data, responsável e validação. */
export const TECHNICAL_KEYS = {
  situacao: { label: 'Situação rural/urbana', kind: 'enum', options: ['urbana', 'rural', 'expansao_urbana'] },
  perimetro_urbano: { label: 'Dentro do perímetro urbano', kind: 'bool' },
  zoneamento: { label: 'Zoneamento', kind: 'text' },
  uso_solo: { label: 'Uso e ocupação do solo', kind: 'text' },
  coef_aproveitamento: { label: 'Coeficiente de aproveitamento', kind: 'number' },
  taxa_ocupacao: { label: 'Taxa de ocupação (%)', kind: 'number' },
  gabarito: { label: 'Gabarito / altura máxima (m)', kind: 'number' },
  recuos: { label: 'Recuos', kind: 'text' },
  app: { label: 'Área de preservação permanente', kind: 'text' },
  restricoes_ambientais: { label: 'Restrições ambientais', kind: 'text' },
  agua: { label: 'Água', kind: 'bool' },
  energia: { label: 'Energia', kind: 'bool' },
  esgoto: { label: 'Esgoto', kind: 'bool' },
  infra_viaria: { label: 'Infraestrutura viária', kind: 'text' },
  acesso_rodovias: { label: 'Acesso por rodovias', kind: 'text' },
  alteracao_uso: { label: 'Necessita aprovação/alteração de uso', kind: 'bool' },
  parcelamento: { label: 'Situação de parcelamento', kind: 'text' },
  estagio_aprovacao: { label: 'Estágio de aprovação', kind: 'enum', options: APPROVAL_ORDER },
  projetos: { label: 'Projetos aprovados ou em aprovação', kind: 'text' },
  viabilidade: { label: 'Viabilidade indicada', kind: 'multi', options: Object.keys(VIABILITY) },
} as const;
export type TechnicalKey = keyof typeof TECHNICAL_KEYS;

export const ROLES = {
  platform_admin: 'Superadministrador WingsBr',
  dourado_admin: 'Administrador Dourado',
  capture_manager: 'Gestor de captação',
  broker: 'Intermediador',
  owner: 'Proprietário',
  buyer: 'Construtora / investidor',
} as const;
export type Role = keyof typeof ROLES;

export const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'] as const;

export function slugify(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

export function formatArea(m2: number | null | undefined): string {
  if (m2 == null) return '—';
  if (m2 >= 10000) return `${(m2 / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ha`;
  return `${Math.round(m2).toLocaleString('pt-BR')} m²`;
}

export function formatBRL(v: number | null | undefined): string {
  if (v == null) return 'Sob consulta';
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

/** Mensagem pré-preenchida do WhatsApp (seção 8). */
export function buildWhatsAppMessage(p: { code: string; title: string; city: string; uf: string; areaM2: number | null; token: string }): string {
  return `Olá! Tenho interesse na oportunidade ${p.code} — ${p.title}, localizada em ${p.city}/${p.uf}, com área de ${formatArea(p.areaM2)}. Gostaria de receber mais informações sobre as condições de negociação. Referência: ${p.token}.`;
}

export const INTENT_TOKEN_RE = /\b(DL-[A-Z0-9]{6})\b/;

// ---------------------------------------------------------------- Matching

export interface MatchProfile {
  ufs: string[];
  cities: string[];
  min_area_m2: number | null;
  max_area_m2: number | null;
  typologies: string[]; // Viability keys
  budget_max: number | null;
  modalities: string[];
  max_swap_pct: number | null;
  min_approval_stage: string | null;
  restrictions: { no_app?: boolean; require_water?: boolean; require_energy?: boolean; require_sewer?: boolean; urban_only?: boolean };
}

export interface MatchOpportunity {
  uf: string;
  city: string;
  area_m2: number | null;
  asking_price: number | null;
  modalities: string[];
  swap_pct: number | null;
  tech: Partial<Record<TechnicalKey, { value: unknown; validation_status: string }>>;
}

export interface MatchCriterion { key: string; label: string; weight: number; earned: number; note: string; unverified?: boolean }
export interface MatchResult { score: number; excluded: boolean; exclusions: string[]; criteria: MatchCriterion[]; confidence: 'alta' | 'media' | 'baixa' }

const verified = (s?: string) => s === 'verificado' || s === 'oficial';

/** Motor determinístico com pontuação explicável (seção 10). Nunca infere dado ausente: ausência = 0 pontos + nota. */
export function scoreMatch(p: MatchProfile, o: MatchOpportunity): MatchResult {
  const criteria: MatchCriterion[] = [];
  const exclusions: string[] = [];
  const t = o.tech;

  // Localização (25)
  {
    const cityHit = !!o.city && p.cities.some((c) => slugify(c) === slugify(o.city));
    const ufHit = p.ufs.includes(o.uf);
    const anyPref = p.cities.length + p.ufs.length > 0;
    let earned = 0, note = '';
    if (!anyPref) { earned = 15; note = 'Perfil sem preferência de localização'; }
    else if (cityHit) { earned = 25; note = `Cidade de interesse: ${o.city}`; }
    else if (ufHit) { earned = 15; note = `Estado de interesse (${o.uf}), cidade não listada`; }
    else note = o.city || o.uf ? `${o.city ?? '—'}/${o.uf ?? '—'} fora das regiões de interesse` : 'Localização não informada';
    criteria.push({ key: 'location', label: 'Localização', weight: 25, earned, note });
  }
  // Metragem (20)
  {
    let earned = 0, note = '';
    if (o.area_m2 == null) note = 'Área não informada';
    else {
      const min = p.min_area_m2 ?? 0, max = p.max_area_m2 ?? Infinity;
      if (o.area_m2 >= min && o.area_m2 <= max) { earned = 20; note = `${formatArea(o.area_m2)} dentro da faixa`; }
      else {
        const gap = o.area_m2 < min ? (min - o.area_m2) / min : (o.area_m2 - max) / max;
        earned = gap <= 0.2 ? 10 : 0;
        note = `${formatArea(o.area_m2)} ${o.area_m2 < min ? 'abaixo' : 'acima'} da faixa (${Math.round(gap * 100)}%)`;
      }
    }
    criteria.push({ key: 'area', label: 'Metragem', weight: 20, earned, note });
  }
  // Tipologia / viabilidade (20)
  {
    const v = t.viabilidade;
    const list = Array.isArray(v?.value) ? (v!.value as string[]) : [];
    const hits = p.typologies.filter((x) => list.includes(x));
    let earned = 0, note = '';
    if (!p.typologies.length) { earned = 10; note = 'Perfil sem tipologia definida'; }
    else if (!list.length) note = 'Viabilidade da área não cadastrada';
    else if (hits.length) { earned = 20; note = `Viabilidade compatível: ${hits.map((h) => VIABILITY[h as Viability] ?? h).join(', ')}`; }
    else note = 'Nenhuma tipologia compatível';
    const unv = !!list.length && !verified(v?.validation_status);
    if (unv && earned) { earned = Math.round(earned * 0.6); note += ' (informação não verificada)'; }
    criteria.push({ key: 'typology', label: 'Tipologia', weight: 20, earned, note, unverified: unv });
  }
  // Orçamento (15)
  {
    let earned = 0, note = '';
    if (p.budget_max == null) { earned = 8; note = 'Perfil sem orçamento definido'; }
    else if (o.asking_price == null) { earned = 5; note = 'Valor sob consulta'; }
    else if (o.asking_price <= p.budget_max) { earned = 15; note = `Valor pedido ${formatBRL(o.asking_price)} dentro do orçamento`; }
    else {
      const over = (o.asking_price - p.budget_max) / p.budget_max;
      earned = over <= 0.15 ? 7 : 0;
      note = `Valor pedido ${Math.round(over * 100)}% acima do orçamento`;
    }
    criteria.push({ key: 'budget', label: 'Orçamento', weight: 15, earned, note });
  }
  // Modalidade (10)
  {
    const hits = p.modalities.filter((m) => o.modalities.includes(m));
    let earned = 0, note = '';
    if (!p.modalities.length) { earned = 5; note = 'Perfil aceita qualquer modalidade'; }
    else if (hits.length) {
      earned = 10; note = `Modalidade: ${hits.map((h) => MODALITIES[h as Modality] ?? h).join(', ')}`;
      const isSwap = hits.some((h) => h.startsWith('permuta'));
      if (isSwap && p.max_swap_pct != null && o.swap_pct != null && o.swap_pct > p.max_swap_pct) {
        earned = 4; note += ` — permuta pedida ${o.swap_pct}% acima do limite de ${p.max_swap_pct}%`;
      }
    } else note = 'Modalidades não coincidem';
    criteria.push({ key: 'modality', label: 'Modalidade', weight: 10, earned, note });
  }
  // Estágio de aprovação (10)
  {
    const st = t.estagio_aprovacao;
    let earned = 0, note = '';
    if (!p.min_approval_stage) { earned = 10; note = 'Sem exigência de estágio'; }
    else if (!st?.value) note = 'Estágio de aprovação não informado';
    else {
      const ok = APPROVAL_ORDER.indexOf(st.value as ApprovalStage) >= APPROVAL_ORDER.indexOf(p.min_approval_stage as ApprovalStage);
      earned = ok ? 10 : 0;
      note = `${APPROVAL_STAGES[st.value as ApprovalStage] ?? st.value} ${ok ? 'atende' : 'não atende'} o mínimo`;
      if (ok && !verified(st.validation_status)) { earned = 5; note += ' (não verificado)'; }
    }
    criteria.push({ key: 'approval', label: 'Estágio de aprovação', weight: 10, earned, note, unverified: !!st?.value && !verified(st.validation_status) });
  }

  // Restrições = exclusões (somente com dado positivo cadastrado)
  const r = p.restrictions ?? {};
  const bool = (k: TechnicalKey) => t[k]?.value;
  if (r.require_water && bool('agua') === false) exclusions.push('Sem disponibilidade de água');
  if (r.require_energy && bool('energia') === false) exclusions.push('Sem disponibilidade de energia');
  if (r.require_sewer && bool('esgoto') === false) exclusions.push('Sem rede de esgoto');
  if (r.urban_only && t.situacao?.value === 'rural') exclusions.push('Área rural; perfil exige urbana');
  if (r.no_app && typeof t.app?.value === 'string' && t.app.value.trim() && !/^(n[aã]o|nenhuma|sem)/i.test(t.app.value.trim()))
    exclusions.push('Possui APP; perfil não aceita');

  const score = criteria.reduce((s, c) => s + c.earned, 0);
  const unverifiedCount = criteria.filter((c) => c.unverified).length;
  const missing = criteria.filter((c) => /não (informad|cadastrad)/.test(c.note)).length;
  const confidence = unverifiedCount + missing === 0 ? 'alta' : unverifiedCount + missing <= 2 ? 'media' : 'baixa';
  return { score: exclusions.length ? 0 : score, excluded: exclusions.length > 0, exclusions, criteria, confidence };
}

// ---------------------------------------------------------------- Google Earth e KML

/** Link para o Google Earth Web centrado no ponto (formato @lat,lng,altitude a,distância d,fov y,heading h,tilt t,roll r). */
export function earthUrl(lat: number, lng: number, distanceM = 2500) {
  return `https://earth.google.com/web/@${lat.toFixed(6)},${lng.toFixed(6)},800a,${Math.round(distanceM)}d,35y,0h,0t,0r`;
}

const xmlEsc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));

/** KML com o perímetro (estilo da marca) para importar em projetos do Google Earth. */
export function toKml(p: { name: string; description?: string; geometry?: any; point?: [number, number] }) {
  const ring = (r: number[][]) => r.map((c) => `${c[0]},${c[1]},0`).join(' ');
  const poly = (coords: number[][][]) =>
    `<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${ring(coords[0])}</coordinates></LinearRing></outerBoundaryIs>${coords
      .slice(1).map((h) => `<innerBoundaryIs><LinearRing><coordinates>${ring(h)}</coordinates></LinearRing></innerBoundaryIs>`).join('')}</Polygon>`;
  let geom = '';
  const g = p.geometry;
  if (g?.type === 'Polygon') geom = poly(g.coordinates);
  else if (g?.type === 'MultiPolygon') geom = `<MultiGeometry>${g.coordinates.map(poly).join('')}</MultiGeometry>`;
  else if (p.point) geom = `<Point><coordinates>${p.point[0]},${p.point[1]},0</coordinates></Point>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xmlEsc(p.name)}</name>
<Style id="dourado"><LineStyle><color>ff17b8f8</color><width>3</width></LineStyle><PolyStyle><color>5517b8f8</color></PolyStyle></Style>
<Placemark><name>${xmlEsc(p.name)}</name><description>${xmlEsc(p.description ?? '')}</description><styleUrl>#dourado</styleUrl>${geom}</Placemark>
</Document></kml>`;
}

// ---------------------------------------------------------------- Captação de novas áreas

export const PROSPECT_STAGES = {
  identificada: 'Identificada',
  contato: 'Contato com proprietário',
  documentacao: 'Documentação',
  analise: 'Análise técnica',
  proposta_intermediacao: 'Proposta de intermediação',
  contratada: 'Intermediação contratada',
} as const;
export type ProspectStage = keyof typeof PROSPECT_STAGES;

export const PROSPECT_SOURCES = {
  mapa_territorial: 'Prospecção no mapa territorial',
  site_proprietario: 'Proprietário pelo site',
  indicacao_parceiro: 'Indicação de parceiro',
  prospeccao_ativa: 'Prospecção ativa',
  inventario: 'Inventário importado (Drive)',
  outro: 'Outro',
} as const;

/** Documentos que a captação precisa reunir antes de virar área do banco. */
export const CAPTURE_CHECKLIST = ['matricula', 'ccir_car', 'iptu_itr', 'certidao', 'planta', 'authorization', 'contrato_intermediacao'] as const;
export const CHECKLIST_STATUS = { pendente: 'Pendente', solicitado: 'Solicitado', recebido: 'Recebido', nao_aplicavel: 'Não se aplica' } as const;

export interface ProspectScoreInput {
  demand: { profile: string; partner: string; score: number }[];
  checklist: { category: string; status: string }[];
  hasRegistry: boolean;
  hasOwnerContact: boolean;
  hasGeometry: boolean;
}
/** Pré-qualificação explicável (0–100): prioriza captação onde já existe demanda de compradores. */
export function prospectScore(p: ProspectScoreInput) {
  const items: { label: string; earned: number; weight: number; note: string }[] = [];
  const strong = p.demand.filter((d) => d.score >= 60);
  const demand = Math.min(40, strong.length * 15 + (p.demand.length - strong.length) * 5);
  items.push({ label: 'Demanda de compradores', weight: 40, earned: demand,
    note: p.demand.length ? `${p.demand.length} perfil(is) compatível(is)${strong.length ? `, ${strong.length} com alta aderência` : ''}` : 'Nenhum perfil de aquisição compatível' });
  const relevant = p.checklist.filter((c) => c.status !== 'nao_aplicavel');
  const got = relevant.filter((c) => c.status === 'recebido').length;
  items.push({ label: 'Documentação reunida', weight: 25, earned: relevant.length ? Math.round((got / relevant.length) * 25) : 0, note: `${got} de ${relevant.length} documentos recebidos` });
  items.push({ label: 'Identificação registral', weight: 15, earned: p.hasRegistry ? 15 : 0, note: p.hasRegistry ? 'Matrícula, SIGEF ou CAR identificados' : 'Sem matrícula, SIGEF ou CAR' });
  items.push({ label: 'Contato do proprietário', weight: 10, earned: p.hasOwnerContact ? 10 : 0, note: p.hasOwnerContact ? 'Contato registrado' : 'Proprietário ainda não identificado' });
  items.push({ label: 'Perímetro', weight: 10, earned: p.hasGeometry ? 10 : 0, note: p.hasGeometry ? 'Perímetro desenhado ou importado' : 'Sem perímetro' });
  return { score: items.reduce((s, i) => s + i.earned, 0), items };
}

// ---------------------------------------------------------------- Geometria simples (sem dependências)

function inRing(pt: [number, number], ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function pointInGeometry(pt: [number, number], g: any): boolean {
  if (!g) return false;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.some((p: number[][][]) => inRing(pt, p[0]) && !p.slice(1).some((h) => inRing(pt, h)));
}

// ---------------------------------------------------------------- Dados territoriais FICTÍCIOS (modo demonstração)

/** Propriedades normalizadas de uma parcela, qualquer que seja a fonte (SIGEF/INCRA, SICAR/CAR). */
export interface TerritoryProps {
  layer: 'sigef' | 'car';
  codigo: string;
  nome: string | null;
  area_ha: number | null;
  municipio: string | null;
  uf: string | null;
  situacao: string | null;
  matricula: string | null;
  cns_serventia: string | null;
  data_referencia: string | null;
  fonte: string;
  ficticio?: boolean;
}

function hash32(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const rnd = (seed: string) => (hash32(seed) % 100000) / 100000;

/**
 * Gera parcelas fictícias e estáveis (mesma célula → mesma parcela) para testar a prospecção sem acesso às bases oficiais.
 * Só gera em recortes pequenos (zoom de bairro/fazenda), como os serviços reais costumam exigir.
 */
export function demoTerritoryFeatures(layer: 'sigef' | 'car', bbox: [number, number, number, number]) {
  const [minX, minY, maxX, maxY] = bbox;
  if (maxX - minX > 0.3 || maxY - minY > 0.3) return { tooLarge: true, features: [] as any[] };
  const cell = layer === 'sigef' ? 0.012 : 0.008;
  const features: any[] = [];
  for (let gx = Math.floor(minX / cell); gx * cell < maxX; gx++) {
    for (let gy = Math.floor(minY / cell); gy * cell < maxY; gy++) {
      const key = `${layer}:${gx}:${gy}`;
      if (rnd(key + 'p') > (layer === 'sigef' ? 0.62 : 0.72)) continue;
      const x0 = gx * cell, y0 = gy * cell;
      const m = cell * (layer === 'sigef' ? 0.06 : 0.1);
      const j = (k: string) => (rnd(key + k) - 0.5) * cell * 0.18;
      const ring = [
        [x0 + m + j('a'), y0 + m + j('b')], [x0 + cell - m + j('c'), y0 + m + j('d')], [x0 + cell - m + j('e'), y0 + cell * 0.55 + j('f')],
        [x0 + cell - m + j('g'), y0 + cell - m + j('h')], [x0 + m + j('i'), y0 + cell - m + j('k')],
      ];
      ring.push(ring[0]);
      const lat = y0 + cell / 2;
      const areaHa = Math.round(((cell - 2 * m) * 111.32 * (cell - 2 * m) * 111.32 * Math.cos((lat * Math.PI) / 180)) * 100 * 10) / 10;
      const h = hash32(key).toString(16).padStart(8, '0');
      const props: TerritoryProps = layer === 'sigef'
        ? { layer, codigo: `${h}-${h.slice(0, 4)}-4fic-a${h.slice(1, 4)}-${h}${h.slice(0, 4)}`, nome: `Fazenda Fictícia ${hash32(key) % 900 + 100}`, area_ha: areaHa,
            municipio: null, uf: null, situacao: 'Certificada (fictícia)', matricula: `${(hash32(key + 'm') % 90000) + 10000} (fictícia)`,
            cns_serventia: `0${hash32(key + 'c') % 9}.${String(hash32(key + 'd') % 999).padStart(3, '0')}-${hash32(key) % 9}`, data_referencia: `20${15 + (hash32(key) % 10)}-0${1 + (hash32(key) % 9)}-15`,
            fonte: 'Demonstração — parcela fictícia no formato SIGEF/INCRA', ficticio: true }
        : { layer, codigo: `UF-0000000-${h.toUpperCase()}${h.toUpperCase()}${h.toUpperCase().slice(0, 8)}`, nome: null, area_ha: areaHa,
            municipio: null, uf: null, situacao: rnd(key + 's') > 0.3 ? 'Ativo (fictício)' : 'Pendente (fictício)', matricula: null, cns_serventia: null,
            data_referencia: `20${18 + (hash32(key) % 7)}-1${hash32(key) % 2}-0${1 + (hash32(key) % 8)}`, fonte: 'Demonstração — imóvel fictício no formato SICAR/CAR', ficticio: true };
      features.push({ type: 'Feature', id: key, geometry: { type: 'Polygon', coordinates: [ring] }, properties: props });
    }
  }
  return { tooLarge: false, features };
}
