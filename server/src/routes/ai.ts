import { Router } from 'express';
import { z } from 'zod';
import {
  APPROVAL_STAGES, LAND_TYPES, MODALITIES, NEGOTIATION_STAGES, TECHNICAL_KEYS, UFS, VALIDATION_STATUS, VIABILITY,
  formatArea, formatBRL, buildWhatsAppMessage, type LandType, type Modality, type Viability, type ApprovalStage, type TechnicalKey,
} from '@dl/shared';
import { db } from '../db/knex.js';
import { config } from '../config.js';
import { authenticate, requireScope } from '../auth/auth.js';
import { ah, parse } from '../lib/http.js';
import { getScopedOpportunity, loadRelations, publicView } from '../domain/opportunities.js';
import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';
import { HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { computeGaps, heuristicDescription, parseNaturalQuery } from '../domain/ai-heuristics.js';
export { parseNaturalQuery };

/**
 * IA assistiva. Regras:
 *  - usa SOMENTE dados cadastrados; nunca inventa parâmetros, aprovações, rentabilidade ou viabilidade;
 *  - toda saída é gravada em ai_suggestions como "sugestão" com origem (heuristic | anthropic:<modelo>);
 *  - respeita o escopo do usuário (mesmas consultas da API).
 */
export const router = Router();
router.use(authenticate);

async function callClaude(system: string, user: string): Promise<string | null> {
  if (!config.anthropicKey) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.anthropicModel, max_tokens: 900, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    return j.content?.map((c: any) => c.text).join('') ?? null;
  } catch {
    return null;
  }
}

async function save(orgId: string, kind: string, content: unknown, origin: string, userId: string, refs: { opportunity_id?: string; negotiation_id?: string }) {
  const [row] = await db('ai_suggestions').insert({ org_id: orgId, kind, content: JSON.stringify(content), origin, requested_by: userId, ...refs }).returning('id');
  return row.id;
}

// ------------------------------------------------------------------ leitura de matrícula

const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024 } });
const MATRICULA_PROMPT = `Você recebe a certidão de matrícula de um imóvel brasileiro (PDF, às vezes escaneado). Transcreva e resuma SEM inventar nada.
Responda somente com JSON válido, sem texto em volta, neste formato:
{"matricula":"número ou null","cartorio":"nome e comarca ou null","imovel":"descrição curta","area_declarada":"como consta ou null",
"proprietarios_atuais":["nome, sem CPF/CNPJ"],"atos":[{"ato":"R.1 ou AV.2","data":"como consta ou null","tipo":"abertura|registro|averbacao","resumo":"uma frase"}],
"onus_vigentes":["hipoteca, penhora, usufruto etc. ainda não cancelados"],"pontos_de_atencao":["trechos ilegíveis, dúvidas, divergências"],"transcricao":"texto integral transcrito"}
Omita CPF, CNPJ e RG no resumo. Se um trecho estiver ilegível, escreva [ilegível]. Se o documento não for uma matrícula, responda {"erro":"motivo"}.`;

/** Lê a matrícula por IA. O resultado é apoio à diligência: sempre conferir com a certidão original. O PDF não é guardado. */
router.post('/matricula', pdfUpload.single('file'), ah(async (req, res) => {
  requireScope(req, 'ai', 'create');
  requireScope(req, 'document', 'read');
  if (!config.anthropicKey) throw new HttpError(503, 'Leitura de matrícula indisponível: configure ANTHROPIC_API_KEY no servidor.');
  const f = req.file;
  if (!f) throw new HttpError(400, 'Envie o PDF da matrícula.');
  if ((await fileTypeFromBuffer(f.buffer))?.mime !== 'application/pdf') throw new HttpError(400, 'O arquivo precisa ser um PDF.');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.anthropicModel, max_tokens: 8000,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } },
        { type: 'text', text: MATRICULA_PROMPT },
      ] }],
    }),
    signal: AbortSignal.timeout(170000),
  }).catch(() => null);
  if (!r?.ok) throw new HttpError(502, 'O serviço de IA não respondeu. Tente de novo em alguns minutos.');
  const j: any = await r.json();
  const text: string = j.content?.map((c: any) => c.text ?? '').join('') ?? '';
  let parsed: any;
  try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { throw new HttpError(502, 'Não foi possível interpretar a resposta. Tente de novo.'); }
  if (parsed.erro) throw new HttpError(422, String(parsed.erro));
  await audit(req, 'ai.matricula', 'ai_suggestions', null, { matricula: parsed.matricula ?? null, modelo: config.anthropicModel });
  res.json({ ...parsed, origin: `anthropic:${config.anthropicModel}`, aviso: 'Leitura por IA: pode conter erros. Confira sempre com a certidão original.' });
}));

// ------------------------------------------------------------------ descrição comercial

router.post('/opportunities/:id/description', ah(async (req, res) => {
  requireScope(req, 'ai', 'create');
  const o = await getScopedOpportunity(req, String(req.params.id));
  const rel = (await loadRelations([o.id])).get(o.id);
  const base = heuristicDescription(o, rel);
  let text = base, origin = 'heuristic';
  const facts = JSON.stringify(publicView(o, rel), null, 1);
  const ai = await callClaude(
    'Você redige descrições comerciais de áreas para incorporação em português do Brasil, tom B2B sóbrio. Use exclusivamente os fatos fornecidos. Nunca invente parâmetros urbanísticos, aprovações, rentabilidade, VGV ou viabilidade. Quando um fato estiver marcado como não verificado, mantenha a ressalva. Máximo 120 palavras, sem preço se ele não estiver nos fatos.',
    `Fatos da área (JSON):\n${facts}\n\nRascunho determinístico:\n${base}`,
  );
  if (ai) { text = ai.trim(); origin = `anthropic:${config.anthropicModel}`; }
  const id = await save(o.org_id, 'description', { text }, origin, req.user!.id, { opportunity_id: o.id });
  res.json({ id, text, origin, label: 'Sugestão — revise antes de publicar' });
}));

// ------------------------------------------------------------------ informações faltantes

router.get('/opportunities/:id/gaps', ah(async (req, res) => {
  requireScope(req, 'ai', 'read');
  const o = await getScopedOpportunity(req, String(req.params.id));
  const rel = (await loadRelations([o.id])).get(o.id);
  const gaps = computeGaps(o, rel);
  res.json({ items: gaps, origin: 'heuristic' });
}));

// ------------------------------------------------------------------ mensagem personalizada e resumo de negociação

router.post('/negotiations/:id/summary', ah(async (req, res) => {
  requireScope(req, 'ai', 'create');
  const n = await db('negotiations').where({ id: String(req.params.id), org_id: req.user!.orgId }).first();
  if (!n) return res.status(404).json({ error: 'Negociação não encontrada' });
  await getScopedOpportunity(req, n.opportunity_id);
  const acts = await db('activities').where({ negotiation_id: n.id }).orderBy('created_at');
  const props = await db('proposals as p').join('proposal_versions as v', function () { this.on('v.proposal_id', 'p.id').andOn('v.version', 'p.current_version'); }).where('p.negotiation_id', n.id).select('p.status', 'v.*');
  const lines = [
    `Etapa atual: ${NEGOTIATION_STAGES[n.stage as keyof typeof NEGOTIATION_STAGES]} (${n.status}).`,
    `${acts.length} interações registradas; última em ${acts.at(-1)?.created_at ? new Date(acts.at(-1).created_at).toLocaleDateString('pt-BR') : '—'}.`,
    ...props.map((p: any) => `Proposta v${p.version} (${p.side}, ${p.status}): ${formatBRL(p.acquisition_value)}${p.swap_pct ? `, permuta ${p.swap_pct}%` : ''}${p.valid_until ? `, válida até ${p.valid_until}` : ''}.`),
    n.next_activity ? `Próxima atividade: ${n.next_activity}${n.next_activity_at ? ` em ${new Date(n.next_activity_at).toLocaleDateString('pt-BR')}` : ''}.` : 'Sem próxima atividade definida.',
  ];
  let text = lines.join('\n'), origin = 'heuristic';
  const ai = await callClaude('Resuma negociações imobiliárias em até 6 linhas, em português, usando só os registros fornecidos. Não faça previsões.', `${lines.join('\n')}\n\nAtividades:\n${acts.map((a: any) => `- ${a.type}: ${a.subject} ${a.body ?? ''}`).join('\n')}`);
  if (ai) { text = ai.trim(); origin = `anthropic:${config.anthropicModel}`; }
  const id = await save(n.org_id, 'negotiation_summary', { text }, origin, req.user!.id, { negotiation_id: n.id });
  res.json({ id, text, origin, label: 'Sugestão gerada a partir dos registros' });
}));

router.post('/opportunities/:id/whatsapp-message', ah(async (req, res) => {
  requireScope(req, 'ai', 'create');
  const b = parse(z.object({ recipient_name: z.string().max(80).optional(), partner_company_id: z.string().uuid().optional() }), req.body);
  const o = await getScopedOpportunity(req, String(req.params.id));
  const rel = (await loadRelations([o.id])).get(o.id);
  const v = publicView(o, rel);
  const via = Array.isArray(rel.tech.viabilidade?.value) ? rel.tech.viabilidade.value.map((x: string) => VIABILITY[x as Viability]?.toLowerCase()).join(', ') : null;
  const text = `Olá${b.recipient_name ? `, ${b.recipient_name}` : ''}! Aqui é ${req.user!.name.split(' ')[0]}, da Quero Área. Separei uma oportunidade que pode encaixar no seu perfil: ${o.code} — ${v.title}, ${formatArea(o.area_m2)} em ${o.city}/${o.uf}${via ? `, com indicação para ${via}` : ''}. Posso te enviar o book com os detalhes?`;
  const id = await save(o.org_id, 'whatsapp_message', { text }, 'heuristic', req.user!.id, { opportunity_id: o.id });
  res.json({ id, text, origin: 'heuristic', label: 'Sugestão — revise antes de enviar' });
}));

router.post('/suggestions/:id/:decision', ah(async (req, res) => {
  const decision = String(req.params.decision) === 'accept' ? 'accepted' : 'rejected';
  await db('ai_suggestions').where({ id: String(req.params.id), org_id: req.user!.orgId }).update({ status: decision, validated_by: req.user!.id, updated_at: db.fn.now() });
  res.json({ status: decision });
}));

// ------------------------------------------------------------------ pesquisa conversacional (linguagem natural → filtros)

const searchHandler = ah(async (req, res) => {
  const b = parse(z.object({ text: z.string().min(3).max(400) }), req.body);
  const parsed = parseNaturalQuery(b.text);
  // cidade: procura nomes de cidades existentes na vitrine dentro do texto
  const cities = await db('land_opportunities').where('publication_status', 'published').distinct('city', 'uf');
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const city = cities.find((c) => norm(parsed.rest).includes(norm(c.city)));
  if (city) { parsed.filters.city = city.city; parsed.filters.uf = city.uf; parsed.explain.push(`cidade ${city.city}/${city.uf}`); }
  res.json({ filters: parsed.filters, explain: parsed.explain, origin: 'heuristic', label: 'Interpretação automática — ajuste os filtros se necessário' });
});
router.post('/search', searchHandler);

/** Mesma interpretação para visitantes (sem login e sem persistência). */
export const publicAiRouter = Router();
publicAiRouter.post('/search', searchHandler);
