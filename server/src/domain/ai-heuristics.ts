/** Heurísticas determinísticas de IA (sem banco). Usam somente dados cadastrados — nunca inventam. */
import {
  APPROVAL_STAGES, LAND_TYPES, MODALITIES, TECHNICAL_KEYS, UFS, VALIDATION_STATUS, VIABILITY,
  formatArea, formatBRL, type LandType, type Modality, type Viability, type ApprovalStage, type TechnicalKey,
} from '@dl/shared';

const verifiedLabel = (s: string) => (s === 'verificado' || s === 'oficial' ? '' : ` (${VALIDATION_STATUS[s as keyof typeof VALIDATION_STATUS]?.toLowerCase() ?? 'não verificado'})`);

export function heuristicDescription(o: any, rel: any): string {
  const t = rel.tech;
  const terms = rel.terms ?? {};
  const parts: string[] = [];
  const typ = LAND_TYPES[o.type as LandType]?.toLowerCase() ?? 'área';
  parts.push(`${typ.charAt(0).toUpperCase() + typ.slice(1)} com ${formatArea(o.area_m2)} em ${o.city}/${o.uf}${o.region ? `, região ${o.region}` : ''}.`);
  if (o.usable_area_m2) parts.push(`Área aproveitável estimada de ${formatArea(o.usable_area_m2)}.`);
  if (o.frontage_m) parts.push(`Testada de ${o.frontage_m} m${o.depth_m ? ` e profundidade de ${o.depth_m} m` : ''}.`);
  if (o.topography) parts.push(`Topografia ${o.topography.toLowerCase()}.`);
  if (t.zoneamento?.value) parts.push(`Zoneamento ${t.zoneamento.value}${verifiedLabel(t.zoneamento.validation_status)}.`);
  if (t.coef_aproveitamento?.value) parts.push(`Coeficiente de aproveitamento ${t.coef_aproveitamento.value}${verifiedLabel(t.coef_aproveitamento.validation_status)}.`);
  const infra = (['agua', 'energia', 'esgoto'] as const).filter((k) => t[k]?.value === true).map((k) => TECHNICAL_KEYS[k].label.toLowerCase());
  if (infra.length) parts.push(`Infraestrutura disponível: ${infra.join(', ')}.`);
  if (t.acesso_rodovias?.value) parts.push(`Acesso: ${t.acesso_rodovias.value}.`);
  const via = Array.isArray(t.viabilidade?.value) ? t.viabilidade.value.map((v: string) => VIABILITY[v as Viability]?.toLowerCase()).filter(Boolean) : [];
  if (via.length) parts.push(`Perfil indicado para ${via.join(', ')}${verifiedLabel(t.viabilidade.validation_status)}.`);
  if (t.estagio_aprovacao?.value) parts.push(`Estágio de aprovação: ${APPROVAL_STAGES[t.estagio_aprovacao.value as ApprovalStage]?.toLowerCase()}${verifiedLabel(t.estagio_aprovacao.validation_status)}.`);
  if (terms.modalities?.length) parts.push(`Negociação: ${terms.modalities.map((m: string) => MODALITIES[m as Modality]?.toLowerCase()).join(', ')}.`);
  return parts.join(' ');
}

export function computeGaps(o: any, rel: any) {
  const gaps: { field: string; severity: 'alta' | 'media' | 'baixa'; reason: string }[] = [];
  const crit: TechnicalKey[] = ['zoneamento', 'situacao', 'estagio_aprovacao', 'viabilidade', 'agua', 'energia', 'app'];
  for (const k of crit) if (rel.tech[k]?.value == null) gaps.push({ field: TECHNICAL_KEYS[k].label, severity: 'alta', reason: 'Parâmetro usado no matching e na decisão de compra' });
  for (const [k, v] of Object.entries<any>(rel.tech)) {
    if (v.value != null && !v.source) gaps.push({ field: TECHNICAL_KEYS[k as TechnicalKey]?.label ?? k, severity: 'media', reason: 'Sem fonte informada' });
    if (v.value != null && v.validation_status === 'nao_verificado') gaps.push({ field: TECHNICAL_KEYS[k as TechnicalKey]?.label ?? k, severity: 'baixa', reason: 'Não verificado' });
  }
  if (!rel.documents.some((d: any) => d.category === 'matricula')) gaps.push({ field: 'Matrícula atualizada', severity: 'alta', reason: 'Documento base da due diligence' });
  if (!rel.geometry) gaps.push({ field: 'Perímetro', severity: 'media', reason: 'Sem perímetro a área não pode ser medida nem exibida no mapa com precisão' });
  if (!rel.owners.length && o.status !== 'captacao') gaps.push({ field: 'Proprietário', severity: 'alta', reason: 'Nenhum proprietário cadastrado' });
  const expired = rel.documents.filter((d: any) => d.valid_until && new Date(d.valid_until) < new Date());
  for (const d of expired) gaps.push({ field: d.title, severity: 'alta', reason: `Documento vencido em ${d.valid_until}` });
  if (!rel.terms?.asking_price && !rel.terms?.swap_pct) gaps.push({ field: 'Valor ou percentual de permuta', severity: 'media', reason: 'Condição comercial não definida' });
  return gaps;
}

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
export function parseNaturalQuery(text: string) {
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const f: Record<string, string> = {};
  const explain: string[] = [];
  const toNum = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));
  const area = (n: number, unit: string) => (/^(ha|hectare)/.test(unit) ? n * 10000 : /^(alq)/.test(unit) ? n * 48400 : /^(mil)/.test(unit) ? n * 1000 : n);
  const unitRe = String.raw`\s*(ha|hectares?|m2|m²|metros?|mil\s*m2|alqueires?)`;
  let m = new RegExp(`(?:acima de|mais de|minimo de|a partir de|pelo menos)\\s*${NUM}${unitRe}`).exec(t);
  if (m) { f.area_min = String(area(toNum(m[1]), m[2])); explain.push(`área ≥ ${formatArea(Number(f.area_min))}`); }
  m = new RegExp(`(?:ate|abaixo de|menos de|no maximo)\\s*${NUM}${unitRe}`).exec(t);
  if (m) { f.area_max = String(area(toNum(m[1]), m[2])); explain.push(`área ≤ ${formatArea(Number(f.area_max))}`); }
  m = new RegExp(`entre\\s*${NUM}\\s*e\\s*${NUM}${unitRe}`).exec(t);
  if (m) { f.area_min = String(area(toNum(m[1]), m[3])); f.area_max = String(area(toNum(m[2]), m[3])); explain.push(`área entre ${formatArea(+f.area_min)} e ${formatArea(+f.area_max)}`); }
  m = /(?:ate|no maximo|orcamento de)\s*r?\$?\s*(\d+(?:[.,]\d+)?)\s*(mi|milh|mil|k)/.exec(t);
  if (m) { const mult = /^mi/.test(m[2]) ? 1e6 : 1e3; f.price_max = String(toNum(m[1]) * mult); explain.push(`valor ≤ ${formatBRL(+f.price_max)}`); }
  const via = Object.entries({ loteamento: 'loteamento', 'condominio': 'condominio_horizontal', vertical: 'verticalizacao', predio: 'verticalizacao', logistic: 'logistico', galpao: 'logistico', industrial: 'industrial', comercial: 'comercial', 'habitacao popular': 'habitacao_popular', mcmv: 'habitacao_popular', 'minha casa': 'habitacao_popular', misto: 'uso_misto' })
    .filter(([k]) => t.includes(k)).map(([, v]) => v);
  if (via.length) { f.viability = Array.from(new Set(via)).join(','); explain.push(`viabilidade: ${f.viability.split(',').map((v) => VIABILITY[v as Viability]).join(', ')}`); }
  const mods = Object.entries({ permuta: 'permuta_fisica,permuta_financeira', venda: 'venda', parceria: 'parceria', bts: 'bts', 'built to suit': 'bts' }).filter(([k]) => t.includes(k)).map(([, v]) => v);
  if (mods.length) { f.modality = mods.join(','); explain.push(`modalidade: ${mods.join(', ').replace(/_/g, ' ')}`); }
  const ufHit = UFS.find((uf: string) => new RegExp(`\\b${uf.toLowerCase()}\\b`).test(t) && !['de', 'em', 'ao', 'se', 'to', 'pa', 'ma', 'pi'].includes(uf.toLowerCase()));
  if (ufHit) { f.uf = ufHit; explain.push(`UF ${ufHit}`); }
  if (/\b(agua|saneamento)\b/.test(t)) { f.infra = [f.infra, 'agua'].filter(Boolean).join(','); explain.push('com água'); }
  if (/\besgoto\b/.test(t)) { f.infra = [f.infra, 'esgoto'].filter(Boolean).join(','); explain.push('com esgoto'); }
  if (/aprovad/.test(t)) { f.approval = 'aprovado'; explain.push('projeto aprovado'); }
  return { filters: f, explain, rest: t };
}

