/**
 * Leitura do inventário de áreas organizado em pastas (padrão "GRANDES NEGÓCIOS" da Dourado Imob).
 * Módulo puro: recebe nomes e textos, devolve campos com a evidência de onde cada um saiu.
 * Nada aqui é verificado: tudo o que vem do inventário entra como "declarado", com arquivo de origem.
 */
import type { ApprovalStage, DocCategory, LandType, Modality, Viability } from '@dl/shared';

export type FileEntry = { path: string; size: number; mtime: number; sha256: string };
export type Evidence<T> = { value: T; source: string; snippet?: string };
export type FileKind = 'geo' | 'description' | 'document' | 'image' | 'video' | 'spreadsheet' | 'archive' | 'cad' | 'other';

export const norm = (s: string) => s.normalize('NFC');
const fold = (s: string) => norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const basename = (p: string) => p.split('/').pop() ?? p;

// ------------------------------------------------------------------ cidades e UF

const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

/** Municípios que aparecem no inventário. Grafia oficial + UF. Ampliar conforme o inventário cresce. */
export const KNOWN_CITIES: [string, string][] = [
  ['Adamantina', 'SP'], ['Alexânia', 'GO'], ['Álvares Machado', 'SP'], ['Anápolis', 'GO'], ['Planaltina', 'GO'], ['Águas Lindas de Goiás', 'GO'],
  ['Alvorada do Norte', 'GO'], ['Aparecida de Goiânia', 'GO'], ['Aragarças', 'GO'], ['Araras', 'SP'], ['Assis', 'SP'], ['Belo Horizonte', 'MG'],
  ['Brasília', 'DF'], ['Caldas Novas', 'GO'], ['Campinas', 'SP'], ['Canindé', 'CE'], ['Capivari', 'SP'], ['Goiânia', 'GO'], ['Cascavel', 'PR'],
  ['Elias Fausto', 'SP'], ['Analândia', 'SP'], ['Santa Cruz da Conceição', 'SP'], ['Entre Rios de Minas', 'MG'], ['Formosa', 'GO'], ['Franca', 'SP'],
  ['Goianira', 'GO'], ['Guapó', 'GO'], ['Guarulhos', 'SP'], ['Hortolândia', 'SP'], ['Ibitinga', 'SP'], ['Itanhaém', 'SP'], ['Itapira', 'SP'],
  ['Itu', 'SP'], ['Itumbiara', 'GO'], ['Iturama', 'MG'], ['Jarinu', 'SP'], ['Jundiaí', 'SP'], ['Juquiá', 'SP'], ['Limeira', 'SP'], ['Cajamar', 'SP'],
  ['Mogi Guaçu', 'SP'], ['Mogi Mirim', 'SP'], ['Nerópolis', 'GO'], ['Canoas', 'RS'], ['Osasco', 'SP'], ['Piracicaba', 'SP'], ['Pires do Rio', 'GO'],
  ['Presidente Venceslau', 'SP'], ['Ribeirão Preto', 'SP'], ['Rio Verde', 'GO'], ['Senador Canedo', 'GO'], ['Suzano', 'SP'], ['Três Lagoas', 'MS'],
  ['Vinhedo', 'SP'], ['Bela Vista de Goiás', 'GO'], ['Bragança Paulista', 'SP'], ['Brasilinha', 'GO'], ['Capela de Santana', 'RS'], ['Esteio', 'RS'],
  ['Cotia', 'SP'], ['Cravinhos', 'SP'], ['Edealina', 'GO'], ['Goianésia', 'GO'], ['Goiatuba', 'GO'], ['Iporá', 'GO'], ['Itaí', 'SP'], ['Jales', 'SP'],
  ['Jaraguá', 'GO'], ['Santo Antônio do Descoberto', 'GO'], ['João Pinheiro', 'MG'], ['Luziânia', 'GO'], ['Macaé', 'RJ'], ['Maceió', 'AL'],
  ['Minaçu', 'GO'], ['Cachoeirinha', 'RS'], ['Novo Gama', 'GO'], ['Osório', 'RS'], ['Paraguaçu Paulista', 'SP'], ['Sorocaba', 'SP'],
  ['Quirinópolis', 'GO'], ['Santa Helena de Goiás', 'GO'], ['Sapucaia do Sul', 'RS'], ['Taquaritinga', 'SP'], ['Trindade', 'GO'],
  ['Araçoiaba da Serra', 'SP'], ['Atibaia', 'SP'], ['Extrema', 'MG'], ['Pompéia', 'SP'], ['Porto Feliz', 'SP'], ['Sumaré', 'SP'],
  ['Vespasiano', 'MG'], ['Patrocínio', 'MG'], ['São Francisco do Sul', 'SC'], ['Americana', 'SP'], ['Nova Odessa', 'SP'], ['São Paulo', 'SP'], ['Barueri', 'SP'],
];
/** Apelidos usados nos nomes das pastas → município oficial. */
const CITY_ALIASES: Record<string, string> = {
  BH: 'Belo Horizonte', CACHOERIRINHA: 'Cachoeirinha', 'NOVA CACHOEIRINHA': 'Cachoeirinha', PARAGUACU: 'Paraguaçu Paulista', 'ENTRE RIOS': 'Entre Rios de Minas',
  'SANTA HELENA': 'Santa Helena de Goiás', 'ALVARES MACHADO': 'Álvares Machado', 'ARACOIABA': 'Araçoiaba da Serra',
  SAMAMBAIA: 'Goiânia', CAPUAVA: 'Goiânia', 'APARECIDA': 'Aparecida de Goiânia',
};
const CITY_INDEX = [
  ...KNOWN_CITIES.map(([n, uf]) => ({ key: fold(n), name: n, uf })),
  ...Object.entries(CITY_ALIASES).map(([k, n]) => ({ key: k, name: n, uf: KNOWN_CITIES.find((c) => c[0] === n)![1] })),
].sort((a, b) => b.key.length - a.key.length);

export function findCity(text: string): { city: string; uf: string } | null {
  const t = ` ${fold(text).replace(/[^A-Z0-9]+/g, ' ')} `;
  let best: { pos: number; len: number; c: (typeof CITY_INDEX)[number] } | null = null;
  for (const c of CITY_INDEX) {
    const pos = t.indexOf(` ${c.key} `);
    if (pos >= 0 && (!best || pos < best.pos || (pos === best.pos && c.key.length > best.len))) best = { pos, len: c.key.length, c };
  }
  return best ? { city: best.c.name, uf: best.c.uf } : null;
}
export function findUf(text: string): string | null {
  const m = fold(text).match(new RegExp(`(?:^|[^A-Z])(${UFS.join('|')})(?![A-Z])`, 'g'));
  if (!m) return null;
  return m[m.length - 1].replace(/[^A-Z]/g, '');
}

// ------------------------------------------------------------------ números em português

/** "1.234.567,89" → 1234567.89; "20" → 20. */
export function brNumber(s: string): number | null {
  const t = s.trim().replace(/\s/g, '');
  if (!/\d/.test(t)) return null;
  let v: string;
  if (/^\d{1,3}(\.\d{3})+\.\d{2}$/.test(t)) v = t.slice(0, -3).replace(/\./g, '') + '.' + t.slice(-2);
  else if (/,\d{1,2}$/.test(t)) v = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) v = t.replace(/\./g, '');
  else v = t.replace(/\./g, '').replace(',', '.');
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const snippetAt = (text: string, i: number, len: number) => text.slice(Math.max(0, i - 50), Math.min(text.length, i + len + 40)).replace(/\s+/g, ' ').trim();

/** Alqueire varia por região: goiano/mineiro 48.400 m², paulista 24.200 m². */
export const alqueireM2 = (uf: string | null) => (uf && ['SP', 'PR', 'SC', 'RS'].includes(uf) ? 24200 : 48400);

// ------------------------------------------------------------------ nome da pasta

export type FolderInfo = { name: string; city: string | null; uf: string | null; tags: string[]; statedArea: Evidence<number> | null };

export function parseFolderName(name: string): FolderInfo {
  const n = norm(name).trim();
  const f = fold(n);
  const hit = findCity(n);
  const uf = findUf(n.replace(/\(.*?\)/g, '')) ?? hit?.uf ?? null;
  const tags = [
    /APROVAD/.test(f) && 'aprovado', /SOMENTE VENDA/.test(f) && 'somente_venda', /MCMV/.test(f) && 'mcmv',
    /LOGISTIC|GALPAO/.test(f) && 'logistica', /VERTICAL/.test(f) && 'vertical', /ENERGIA|HIDRELETRIC/.test(f) && 'energia',
    /RENOVAR/.test(f) && 'aprovacao_a_renovar', /RESORT/.test(f) && 'resort', /LOTEAMENTO|LOTES/.test(f) && 'loteamento',
  ].filter(Boolean) as string[];
  let statedArea: Evidence<number> | null = null;
  const m = f.match(/([\d.,]+)\s*(MIL)?\s*(METROS|M²|M2)/);
  if (m) {
    const v = brNumber(m[1]);
    if (v) statedArea = { value: m[2] ? v * 1000 : v, source: 'nome da pasta', snippet: n };
  }
  return { name: n, city: hit?.city ?? null, uf: hit && uf && hit.uf !== uf ? uf : (uf ?? hit?.uf ?? null), tags, statedArea };
}

// ------------------------------------------------------------------ arquivos

const DOC_RULES: [DocCategory, RegExp][] = [
  ['matricula', /MATRICULA|MATR\.|ONUS REAIS|INTEIRO TEOR/],
  ['certidao', /CERTID|ESCRITURA|NEGATIVA|CND\b/],
  ['iptu_itr', /\bIPTU\b|\bITR\b/],
  ['ccir_car', /\bCCIR\b|\bCAR\b|SICAR|CADASTRO AMBIENTAL|SIGEF|GEORREFERENC/],
  ['estudo_ambiental', /AMBIENTAL|TCRA|CETESB|LICENCA|LICENÇA|SEMAD|OUTORGA/],
  ['projeto', /ALVARA|GRAPROHAB|APROVAD|SION_PREF|PAV TIPO|ELEVACAO|CORTE|ARQUITET|APARTAMENTOS/],
  ['estudo_urbanistico', /URBANISTIC|IMPLANTACAO|MASTER ?PLAN|LOTEAMENTO|QUADRA|MAPA_UNIFICADO|DIRETRIZ|ZONEAMENTO|USO DO SOLO/],
  ['planta', /PLANTA|PLANIALT|TOPOGRAF|LEVANTAMENTO|MEMORIAL DESCRITIVO|DRENAGEM/],
  ['viabilidade', /VIABILIDADE|ORCAMENTO|CURVA ABC|QUANTITATIVO|AVALIACAO|ESTUDO DE MASSA|VGV|FRE-/],
  ['contrato_intermediacao', /INTERMEDIACAO|EXCLUSIVIDADE|AUTORIZACAO DE VENDA/],
  ['authorization', /AUTORIZACAO DE DIVULG/],
  ['proposta', /PROPOSTA|LOI\b|CARTA DE INTENC/],
  ['minuta', /MINUTA|CONTRATO/],
];

export function classifyFile(path: string): { kind: FileKind; category: DocCategory | null } {
  const b = fold(basename(path));
  const ext = b.split('.').pop()!.toLowerCase();
  if (['kml', 'kmz', 'geojson'].includes(ext)) return { kind: 'geo', category: 'geo' };
  if (['jpg', 'jpeg', 'png', 'webp', 'heic', 'tif', 'tiff'].includes(ext)) return { kind: 'image', category: null };
  if (['mp4', 'mov', 'avi'].includes(ext)) return { kind: 'video', category: null };
  if (ext === 'zip') return { kind: 'archive', category: null };
  if (ext === 'dwg' || ext === 'dxf') return { kind: 'cad', category: 'projeto' };
  if (['xlsx', 'xls', 'csv'].includes(ext)) return { kind: 'spreadsheet', category: DOC_RULES.find(([, r]) => r.test(b))?.[0] ?? 'viabilidade' };
  const cat = DOC_RULES.find(([, r]) => r.test(b))?.[0] ?? null;
  if (['docx', 'doc', 'pptx', 'txt'].includes(ext)) return cat && cat !== 'estudo_urbanistico' ? { kind: 'document', category: cat } : { kind: 'description', category: 'outro' };
  if (ext === 'pdf') return { kind: 'document', category: cat ?? 'outro' };
  return { kind: 'other', category: null };
}

// ------------------------------------------------------------------ texto de oferta

export type Extracted = {
  area: Evidence<number> | null;
  asking_price: Evidence<number> | null;
  vgv: Evidence<number> | null;
  price_per_lot: Evidence<number> | null;
  price_per_m2: Evidence<number> | null;
  down_payment: Evidence<number> | null;
  lots: Evidence<number> | null;
  units: Evidence<number> | null;
  lot_size_m2: Evidence<number> | null;
  matriculas: Evidence<string>[];
  modalities: Evidence<Modality[]> | null;
  approval: Evidence<ApprovalStage> | null;
  viability: Evidence<Viability[]> | null;
  money_unclassified: Evidence<number>[];
  ambiguous_notation?: boolean;
  personal_data: string[];
  title: string | null;
};

const MONEY_RE = /R\$\s*(?:R\$\s*)?([\d.]+(?:,\d{1,2})?)\s*(milh[õo]es|milh[ãa]o|mi\b|mm\b|mil\b|bilh[õo]es|bi\b)?|([\d.,]+)\s*(milh[õo]es|milh[ãa]o|mm\b|bilh[õo]es)(?!\s*de\s*m)/gi;

/** Retorna [valor, ambíguo]. "38.900.000 milhões" já está em reais; "9.800 milhões" quase sempre quer dizer 9,8 milhões. */
function scaleMoneyChecked(n: number, raw: string, unit?: string): [number, boolean] {
  const u = (unit ?? '').toLowerCase();
  if (u.startsWith('milh') || u === 'mi' || u === 'mm') {
    if (n >= 1e5) return [n, true];
    if (/^\d{1,3}\.\d{3}$/.test(raw.trim())) return [(n / 1000) * 1e6, true];
  }
  return [scaleMoney(n, unit), false];
}
function scaleMoney(n: number, unit?: string) {
  const u = (unit ?? '').toLowerCase();
  if (u.startsWith('bilh') || u === 'bi') return n * 1e9;
  if (u.startsWith('milh') || u === 'mi' || u === 'mm') return n * 1e6;
  if (u === 'mil') return n * 1e3;
  return n;
}

export function extractFromText(text: string, source: string, uf: string | null): Extracted {
  const t = norm(text).replace(/ /g, ' ');
  const lower = fold(t);
  const ev = <T,>(value: T, i: number, len: number): Evidence<T> => ({ value, source, snippet: snippetAt(t, i, len) });
  const out: Extracted = { area: null, asking_price: null, vgv: null, price_per_lot: null, price_per_m2: null, down_payment: null, lots: null, units: null,
    lot_size_m2: null, matriculas: [], modalities: null, approval: null, viability: null, money_unclassified: [], personal_data: [], title: null };

  out.title = t.split('\n').map((l) => l.replace(/[^\p{L}\p{N}\s.,–\-/()²|:]/gu, '').trim()).find((l) => l.length >= 12 && !/^https?:/i.test(l)) ?? null;

  // valores (o contexto de cada valor começa depois do valor anterior, para "R$ 500/m² Valor total: R$ 35 mi" não contaminar)
  let lastEnd = 0;
  for (const m of t.matchAll(MONEY_RE)) {
    const from = lastEnd; lastEnd = m.index! + m[0].length;
    const raw = m[1] ?? m[3]; const n0 = raw ? brNumber(raw) : null;
    if (!n0) continue;
    const [n, ambiguous] = scaleMoneyChecked(n0, raw, m[2] ?? m[4]);
    if (n < 1000) continue;
    const i = m.index!; const before = fold(t.slice(Math.max(from, i - 70), i)); const after = fold(t.slice(i + m[0].length, i + m[0].length + 30));
    const e = ev(n, i, m[0].length);
    if (ambiguous) { e.snippet += ' [notação ambígua: conferir]'; out.ambiguous_notation = true; }
    if (/VGV/.test(before.slice(-40))) out.vgv ??= e;
    else if (/VALOR TOTAL|PRECO TOTAL|VALOR DE VENDA|VALOR PEDIDO|VALOR DO TERRENO|VALOR DA AREA|VALOR DO IMOVEL/.test(before.slice(-30)) && !/^\s*(\/|POR)\s*(M2|M²|LOTE)/.test(after)) out.asking_price ??= e;
    else if (/^\s*(\/|POR|O|CADA)?\s*(LOTE)/.test(after) || /POR LOTE|VALOR DO LOTE|LOTE A|LOTES A/.test(before.slice(-30))) out.price_per_lot ??= e;
    else if (/^\s*(\/|POR|O|A|AO)\s*(M2|M²|METRO)/.test(after) || /(POR|O|DO|\/)\s*(M2|M²|METRO( QUADRADO)?)[^$\dA-Z]{0,6}$/.test(before)) out.price_per_m2 ??= e;
    else if (/APORTE|ENTRADA|SINAL|ANTECIPAD/.test(before.slice(-45))) out.down_payment ??= e;
    else if (/UNITARIO|POR UNIDADE|MEDIO POR|TICKET|CADA UNIDADE|POR APARTAMENTO|POR CASA/.test(before.slice(-30))) out.money_unclassified.push(e);
    else if (/VALOR|PRECO|PEDIDA|VENDA|TERRENO|AREA|PEDE|CUSTO|IMOVEL|TOTAL/.test(before.slice(-45))) out.asking_price ??= e;
    else out.money_unclassified.push(e);
  }
  // "VALOR 31 MILHÕES" sem R$
  if (!out.asking_price) {
    const m = t.match(/(valor|pre[çc]o)[^\d\n]{0,20}([\d.,]+)\s*(milh[õo]es|milh[ãa]o|mi\b|mm\b)/i);
    if (m) out.asking_price = ev(scaleMoney(brNumber(m[2])!, m[3]), m.index!, m[0].length);
  }

  // área
  const areas: Evidence<number>[] = [];
  for (const m of t.matchAll(/([\d.]+(?:,\d+)?)\s*(m²|m2|mts²|metros quadrados|metros)(?![\w²])/gi)) {
    const v = brNumber(m[1]); if (!v || v < 1000) continue;
    const before = fold(t.slice(Math.max(0, m.index! - 40), m.index!));
    if (/LOTES? DE|LOTE MINIMO|UNIDADES? DE|APTOS? DE|CASAS? DE|CONSTRUID|PRIVATIV|GALPAO DE|POTENCIAL/.test(before)) continue;
    areas.push(ev(v, m.index!, m[0].length));
  }
  for (const m of t.matchAll(/([\d.,]+)\s*(alqueires?)/gi)) {
    const v = brNumber(m[1]); if (!v) continue;
    const e = ev(v * alqueireM2(uf), m.index!, m[0].length); e.snippet += ` (convertido: 1 alqueire = ${alqueireM2(uf).toLocaleString('pt-BR')} m²)`; areas.push(e);
  }
  for (const m of t.matchAll(/([\d.,]+)\s*(hectares?|ha\b)/gi)) {
    const v = brNumber(m[1]); if (v) areas.push(ev(v * 10000, m.index!, m[0].length));
  }
  if (areas.length) {
    // preferir o número precedido de "área total"/"total"; senão o maior (descrições citam frações menores depois)
    const tot = areas.find((a) => /AREA TOTAL|TOTAL DE|TOTALIZANDO|POSSUI|COM APROX|APROXIMADAMENTE/.test(fold(a.snippet ?? '')));
    out.area = tot ?? areas.reduce((a, b) => (b.value > a.value ? b : a));
  }

  // sanidade: valor total baixo demais para a área é quase sempre preço unitário; valores astronômicos são erro de digitação
  if (out.asking_price && (out.asking_price.value < 5e5 || (out.asking_price.value < 1e6 && (out.area?.value ?? 0) > 10000))) { out.money_unclassified.push(out.asking_price); out.asking_price = null; }
  if (out.asking_price && out.asking_price.value > 5e9) { out.money_unclassified.push(out.asking_price); out.asking_price = null; out.ambiguous_notation = true; }
  if (out.vgv && out.vgv.value > 2e10) { out.money_unclassified.push(out.vgv); out.vgv = null; out.ambiguous_notation = true; }

  // lotes / unidades
  const lots = t.match(/(\d[\d.]*)\s*(lotes|unidades habitacionais)/i);
  if (lots) out.lots = ev(brNumber(lots[1])!, lots.index!, lots[0].length);
  const units = t.match(/(\d[\d.]*)\s*(apartamentos|unidades|casas|aptos)/i);
  if (units && !/lotes/i.test(units[2])) out.units = ev(brNumber(units[1])!, units.index!, units[0].length);
  const ls = t.match(/lotes?\s*(?:de|com|m[ée]dios? de)\s*([\d.,]+)\s*(m²|m2)/i);
  if (ls) out.lot_size_m2 = ev(brNumber(ls[1])!, ls.index!, ls[0].length);

  // matrículas
  for (const m of t.matchAll(/matr[íi]culas?(?:\s*(?:n[º°o.]*|sob))?\s*[:\s]*((?:\d{1,3}(?:\.\d{3})+|\d{3,7})(?:\s*(?:,|e)\s*(?:n[º°o.]*\s*)?(?:\d{1,3}(?:\.\d{3})+|\d{3,7}))*)/gi)) {
    for (const n of m[1].split(/\s*(?:,|e)\s*/)) { const v = n.replace(/[^\d.]/g, ''); if (v) out.matriculas.push(ev(v, m.index!, m[0].length)); }
  }

  // modalidades
  const mods = new Set<Modality>();
  const modEv: string[] = [];
  const addMod = (re: RegExp, mod: Modality[]) => { const m = lower.match(re); if (m) { mod.forEach((x) => mods.add(x)); modEv.push(m[0]); } };
  addMod(/PERMUTA FISICA|PERMUTA EM UNIDADES|PERMUTA EM LOTES/, ['permuta_fisica']);
  addMod(/PERMUTA FINANCEIRA|PERCENTUAL DO VGV|% DO VGV|PARTICIPACAO NO VGV/, ['permuta_financeira']);
  if (!mods.has('permuta_fisica') && !mods.has('permuta_financeira')) addMod(/PERMUTA/, ['permuta_fisica']);
  addMod(/PARCERIA|SOCIEDADE|JOINT|SPE COM/, ['parceria']);
  addMod(/\bBTS\b|BUILT TO SUIT/, ['bts']);
  addMod(/VENDA|COMPRA|A VISTA|VALOR DO TERRENO|VALOR DE VENDA/, ['venda']);
  if (mods.size) out.modalities = { value: [...mods], source, snippet: modEv.join(' · ') };

  // estágio de aprovação (sempre declarado)
  const ap = lower.match(/APROVADO E LICENCIADO|LICENCIADO|ALVARA DE (OBRAS|CONSTRUCAO)|PROJETO (URBANISTICO )?APROVADO|LOTEAMENTO APROVADO|APROVAD[OA]|EM APROVACAO|DIRETRIZES|ESTUDO PRELIMINAR/);
  if (ap) {
    const s = ap[0];
    const stage: ApprovalStage = /LICENCIADO|ALVARA/.test(s) ? 'licenciado' : /EM APROVACAO/.test(s) ? 'em_aprovacao' : /DIRETRIZES/.test(s) ? 'diretrizes_emitidas' : /ESTUDO/.test(s) ? 'estudo_preliminar' : 'aprovado';
    out.approval = { value: stage, source, snippet: snippetAt(t, lower.indexOf(s), s.length) };
  }

  // potencial de uso
  const vi = new Set<Viability>();
  if (/MCMV|MINHA CASA|HABITACAO POPULAR|INTERESSE SOCIAL|FAIXA [123]/.test(lower)) vi.add('habitacao_popular');
  if (/LOTEAMENTO|LOTES/.test(lower)) vi.add('loteamento');
  if (/CONDOMINIO (RESIDENCIAL )?HORIZONTAL|CONDOMINIO FECHADO|CONDOMINIO DE CASAS|CASAS/.test(lower)) vi.add('condominio_horizontal');
  if (/VERTICAL|APARTAMENTOS|TORRES|BLOCOS|PAVIMENTOS/.test(lower)) vi.add('verticalizacao');
  if (/GALPAO|GALPOES|CONDOMINIO LOGISTICO|AREA LOGISTICA|USO LOGISTICO|PARQUE LOGISTICO|CENTRO DE DISTRIBUICAO|EMPREENDIMENTO LOGISTICO|\bBTS\b|BUILT TO SUIT/.test(lower)) vi.add('logistico');
  if (/AREA INDUSTRIAL|USO INDUSTRIAL|DISTRITO INDUSTRIAL|ZONA INDUSTRIAL|ZONEAMENTO INDUSTRIAL|GALPAO INDUSTRIAL|FINS INDUSTRIAIS/.test(lower)) vi.add('industrial');
  if (/CENTRO COMERCIAL|USO COMERCIAL|AREA COMERCIAL|SUPERMERCADO|ATACAD|VAREJO|RESORT|HOTEL|SHOPPING/.test(lower)) vi.add('comercial');
  if (/USO MISTO|MULTIUSO/.test(lower)) vi.add('uso_misto');
  if (vi.size) out.viability = { value: [...vi], source, snippet: 'termos no texto de oferta' };

  // dados pessoais que não podem ir para campos abertos
  if (/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(t)) out.personal_data.push('CPF no texto');
  if (/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/.test(t)) out.personal_data.push('CNPJ no texto');
  if (/\(?\d{2}\)?\s?9\d{4}-?\d{4}/.test(t)) out.personal_data.push('telefone no texto');
  return out;
}

// ------------------------------------------------------------------ tipo da área

export function inferType(tags: string[], ex: Extracted | null, areaM2: number | null): Evidence<LandType> {
  const v = new Set(ex?.viability?.value ?? []);
  const why = (value: LandType, snippet: string): Evidence<LandType> => ({ value, source: 'inferido pelo importador', snippet });
  if (tags.includes('logistica')) return why('area_industrial', 'pasta indica logística/galpão');
  if (tags.includes('energia')) return why('area_rural', 'área para energia');
  if (tags.includes('resort')) return why('area_comercial', 'resort');
  if (tags.includes('vertical')) return why('incorporacao_vertical', 'pasta indica vertical');
  const residential = v.has('loteamento') || v.has('habitacao_popular') || v.has('condominio_horizontal') || v.has('verticalizacao') || !!ex?.lots;
  if (!residential && (v.has('logistico') || v.has('industrial'))) return why('area_industrial', 'texto indica uso logístico/industrial');
  if (v.has('verticalizacao') && !v.has('loteamento') && !ex?.lots) return why('incorporacao_vertical', 'vertical/apartamentos');
  if ((tags.includes('aprovado') || ex?.approval?.value === 'aprovado' || ex?.approval?.value === 'licenciado') && (ex?.lots || v.has('loteamento'))) return why('empreendimento_aprovado', 'loteamento com projeto aprovado (declarado)');
  if (tags.includes('loteamento') || v.has('loteamento') || ex?.lots) return why('loteamento', 'loteamento/lotes');
  if (areaM2 && areaM2 >= 50000) return why('gleba', 'área acima de 5 ha sem uso definido');
  return why('terreno_urbano', 'área até 5 ha sem uso definido');
}

// ------------------------------------------------------------------ planilhas de controle

export type SheetRow = Record<string, any> & { __sheet: string; __row: number; __file: string };

/** Reconhece as planilhas de controle da Dourado pelo cabeçalho. */
export function sheetKind(headers: string[]): 'captacoes' | 'pipeline' | 'pedidos' | 'acompanhamento' | 'solicitacoes' | 'vendas_residenciais' | null {
  const h = headers.map((x) => fold(String(x ?? '')).trim());
  const has = (s: string) => h.some((x) => x.startsWith(s));
  if (has('CAPTACAO') && has('COMISSAO')) return 'vendas_residenciais';
  if (has('CODIGO DE AR') || (has('CODIGO DA AREA') && has('STATUS ATUAL') && h.some((x) => /RESPONSAVEL COMPRADOR/.test(x)))) {
    return h[0].startsWith('CODIGO DE AR') ? 'pedidos' : 'pipeline';
  }
  if (has('CODIGO DA AREA')) return 'captacoes';
  if (has('LOCALIZACAO') && has('INTERESSADO') && has('FEEDBACK CLIENTE')) return 'acompanhamento';
  if (has('LOCALIZACAO') && has('INTERESSADO')) return 'solicitacoes';
  return null;
}

export const driveFolderId = (s: string) => String(s ?? '').match(/drive\.google\.com\/drive\/(?:u\/\d\/)?folders\/([\w-]{20,})/)?.[1] ?? null;
